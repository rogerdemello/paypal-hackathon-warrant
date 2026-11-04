import { appendEntry, verifyChain, type ChainVerification, type JsonValue, type LedgerEntry } from '@warrant/warrant';
import { json, type Db, type Queryable } from './db';

/**
 * Persistence for hash chains (`@warrant/warrant` ledger). The library computes and checks the hashes; this module stores
 * the entries and serialises appends per chain. Two tables share one shape: `ledger_entries` (the audit ledger, one chain
 * per order, mandate or dispute) and `transparency_log` (the registry's log, one chain).
 */

export type ChainTable = 'ledger_entries' | 'transparency_log';

export interface StoredEntry extends LedgerEntry {
  /** Epoch seconds the row was written. For the transparency log the same instant is also inside the hashed payload. */
  readonly createdAt: number;
}

interface EntryRow {
  chain_id: string;
  seq: number;
  type: string;
  payload: JsonValue;
  prev_hash: string;
  hash: string;
  created_at: number;
}

/** The bare ledger entry (what the hash covers), without the storage timestamp. */
export const toLedgerEntry = (e: StoredEntry): LedgerEntry => ({ chainId: e.chainId, seq: e.seq, type: e.type, payload: e.payload, prevHash: e.prevHash, hash: e.hash });

const toEntry = (r: EntryRow): StoredEntry => ({ chainId: r.chain_id, seq: r.seq, type: r.type, payload: r.payload, prevHash: r.prev_hash, hash: r.hash, createdAt: r.created_at });

const COLUMNS = 'chain_id, seq, type, payload, prev_hash, hash, created_at';

/** Newest entry of a chain, or null for an empty chain. */
export async function chainHead(q: Queryable, table: ChainTable, chainId: string): Promise<StoredEntry | null> {
  const rows = await q.query<EntryRow>(`SELECT ${COLUMNS} FROM ${table} WHERE chain_id = $1 ORDER BY seq DESC LIMIT 1`, [chainId]);
  const row = rows[0];
  return row === undefined ? null : toEntry(row);
}

/**
 * Append one entry. Must run inside a transaction: it takes a transaction-scoped advisory lock on the chain, so two
 * concurrent appends line up instead of both extending the same head.
 */
export async function appendToChain(tx: Queryable, table: ChainTable, draft: { chainId: string; type: string; payload: JsonValue }, at: number): Promise<StoredEntry> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${table}:${draft.chainId}`]);
  const head = await chainHead(tx, table, draft.chainId);
  const entry = appendEntry(head === null ? null : toLedgerEntry(head), draft);
  await tx.query(`INSERT INTO ${table} (${COLUMNS}) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`, [
    entry.chainId,
    entry.seq,
    entry.type,
    json(entry.payload),
    entry.prevHash,
    entry.hash,
    at,
  ]);
  return { ...entry, createdAt: at };
}

export async function readChain(q: Queryable, table: ChainTable, chainId: string, options: { afterSeq?: number; limit?: number } = {}): Promise<StoredEntry[]> {
  const rows = await q.query<EntryRow>(`SELECT ${COLUMNS} FROM ${table} WHERE chain_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3`, [
    chainId,
    options.afterSeq ?? 0,
    options.limit ?? 1_000_000,
  ]);
  return rows.map(toEntry);
}

export async function entryAt(q: Queryable, table: ChainTable, chainId: string, seq: number): Promise<StoredEntry | null> {
  const rows = await q.query<EntryRow>(`SELECT ${COLUMNS} FROM ${table} WHERE chain_id = $1 AND seq = $2`, [chainId, seq]);
  const row = rows[0];
  return row === undefined ? null : toEntry(row);
}

/** Recompute a stored chain from the database, page by page. `expectedHeadHash` pins a trusted head. */
export async function verifyStoredChain(db: Db, table: ChainTable, chainId: string, expectedHeadHash?: string): Promise<ChainVerification> {
  const PAGE = 500;
  let after: { seq: number; hash: string } | undefined;
  let length = 0;
  let head: { seq: number; hash: string } | null = null;
  for (;;) {
    const page = await readChain(db, table, chainId, { afterSeq: after?.seq ?? 0, limit: PAGE });
    if (page.length === 0) break;
    const result = verifyChain(page.map(toLedgerEntry), { chainId, ...(after === undefined ? {} : { after }) });
    if (!result.ok) return result;
    length += page.length;
    const last = page[page.length - 1];
    if (last === undefined) break;
    head = { seq: last.seq, hash: last.hash };
    after = head;
    if (page.length < PAGE) break;
  }
  if (expectedHeadHash !== undefined && expectedHeadHash !== (head?.hash ?? null)) {
    return { ok: false, brokenSeq: head?.seq ?? 1, reason: 'HEAD_MISMATCH', message: 'chain head does not match the trusted head hash (truncated or rewritten)' };
  }
  return { ok: true, length, headSeq: head?.seq ?? null, headHash: head?.hash ?? null };
}
