import {
  GENESIS_HASH,
  importVerificationKey,
  signJws,
  staticRegistry,
  verifyChain,
  verifyJws,
  type KeyKind,
  type KeyStatus,
  type NumericDate,
  type RegistryKey,
  type RegistryLookup,
  type TransparencyView,
} from '@warrant/warrant';
import { appendToChain, chainHead, entryAt, readChain, toLedgerEntry, verifyStoredChain, type StoredEntry } from '../chain';
import { nowSeconds, type Clock } from '../clock';
import { isUniqueViolation, maybeOne, type Db, type Queryable } from '../db';
import type { KeyMaterial } from '../keys';

/**
 * The registry (docs/warrant-spec.md section 7): a directory of wallet and agent-platform keys with their status, and an
 * append-only, hash-chained transparency log of issued cart warrant hashes. The log's head is signed from time to time
 * (a checkpoint), so any later rewrite of history contradicts a statement the registry already made.
 */

export const REGISTRY_CHAIN = 'registry';

export interface PlatformRecord {
  readonly id: string;
  readonly name: string;
  readonly status: KeyStatus;
  readonly createdAt: NumericDate;
}

export interface NewKey {
  readonly kid: string;
  readonly kind: KeyKind;
  /** Wallet keys: the wallet id as in a mandate `iss`. Agent keys: the platform id. */
  readonly owner: string;
  readonly platformId?: string;
  readonly publicKeyBase64: string;
  readonly validFrom: NumericDate;
  readonly validTo?: NumericDate | null;
}

interface KeyRow {
  kid: string;
  kind: KeyKind;
  owner: string;
  platform_id: string | null;
  public_key: string;
  status: KeyStatus;
  valid_from: number;
  valid_to: number | null;
  status_changed_at: number | null;
}

const toRegistryKey = (r: KeyRow): RegistryKey => ({
  kid: r.kid,
  kind: r.kind,
  owner: r.owner,
  publicKey: importVerificationKey(r.public_key),
  status: r.status,
  validFrom: r.valid_from,
  validTo: r.valid_to,
  statusChangedAt: r.status_changed_at,
});

export interface Checkpoint {
  readonly seq: number;
  readonly headHash: string;
  readonly issuedAt: NumericDate;
  readonly jws: string;
}

export interface InclusionProof {
  readonly entry: StoredEntry;
  /** Entries after `entry`, up to and including the checkpointed head. Recomputing their hashes reaches `checkpoint.headHash`. */
  readonly chain: readonly StoredEntry[];
  readonly checkpoint: Checkpoint;
}

export type LogProblem = 'CHAIN_BROKEN' | 'CHECKPOINT_MISMATCH' | 'CHECKPOINT_SIGNATURE';

export interface LogAudit {
  readonly ok: boolean;
  readonly length: number;
  readonly headSeq: number | null;
  readonly headHash: string | null;
  readonly problems: readonly { readonly code: LogProblem; readonly message: string; readonly seq?: number }[];
}

export class RegistryService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly logKey: KeyMaterial,
  ) {}

  // ---- platforms and keys -------------------------------------------------------------------------------------------

  async ensurePlatform(platform: { id: string; name: string }): Promise<PlatformRecord> {
    const at = nowSeconds(this.clock);
    await this.db.query('INSERT INTO platforms (id, name, status, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING', [platform.id, platform.name, 'active', at]);
    return this.platform(platform.id) as Promise<PlatformRecord>;
  }

  async platform(id: string): Promise<PlatformRecord | null> {
    const rows = await this.db.query<{ id: string; name: string; status: KeyStatus; created_at: number }>('SELECT id, name, status, created_at FROM platforms WHERE id = $1', [id]);
    const row = maybeOne(rows);
    return row === null ? null : { id: row.id, name: row.name, status: row.status, createdAt: row.created_at };
  }

  /** Register a key and log the registration. Idempotent: registering the same kid with the same public key is a no-op. */
  async registerKey(key: NewKey): Promise<boolean> {
    const at = nowSeconds(this.clock);
    return this.db.transaction(async (tx) => {
      const existing = maybeOne(await tx.query<{ public_key: string }>('SELECT public_key FROM registry_keys WHERE kid = $1', [key.kid]));
      if (existing !== null) {
        if (existing.public_key !== key.publicKeyBase64) throw new Error(`key ${key.kid} is already registered with a different public key`);
        return false;
      }
      await tx.query(
        'INSERT INTO registry_keys (kid, kind, owner, platform_id, public_key, status, valid_from, valid_to, status_changed_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9)',
        [key.kid, key.kind, key.owner, key.platformId ?? null, key.publicKeyBase64, 'active', key.validFrom, key.validTo ?? null, at],
      );
      await appendToChain(tx, 'transparency_log', { chainId: REGISTRY_CHAIN, type: 'key_registered', payload: { kid: key.kid, kind: key.kind, owner: key.owner, public_key: key.publicKeyBase64, valid_from: key.validFrom, valid_to: key.validTo ?? null, logged_at: at } }, at);
      return true;
    });
  }

  /** Change a key's status from now on. Past signatures stay judged by the status at their signing time (V02). */
  async setKeyStatus(kid: string, status: KeyStatus): Promise<void> {
    const at = nowSeconds(this.clock);
    await this.db.transaction(async (tx) => {
      const rows = await tx.query<{ status: KeyStatus }>('SELECT status FROM registry_keys WHERE kid = $1 FOR UPDATE', [kid]);
      const current = maybeOne(rows);
      if (current === null) throw new Error(`unknown key ${kid}`);
      if (current.status === status) return;
      await tx.query('UPDATE registry_keys SET status = $2, status_changed_at = $3 WHERE kid = $1', [kid, status, status === 'active' ? null : at]);
      await appendToChain(tx, 'transparency_log', { chainId: REGISTRY_CHAIN, type: 'key_status_changed', payload: { kid, from: current.status, to: status, logged_at: at } }, at);
    });
  }

  async keys(q: Queryable = this.db): Promise<RegistryKey[]> {
    const rows = await q.query<KeyRow>('SELECT kid, kind, owner, platform_id, public_key, status, valid_from, valid_to, status_changed_at FROM registry_keys ORDER BY position');
    return rows.map(toRegistryKey);
  }

  /** A snapshot lookup for the verifier. Re-read per verification so a revocation takes effect at once. */
  async lookup(q: Queryable = this.db): Promise<RegistryLookup> {
    return staticRegistry(await this.keys(q));
  }

  /** `GET /registry/jwks.json`: public keys with status and validity. */
  async jwks(): Promise<{ keys: Record<string, unknown>[] }> {
    const keys = await this.keys();
    return {
      keys: keys.map((k) => {
        const jwk = k.publicKey.export({ format: 'jwk' });
        return { kid: k.kid, kty: jwk.kty, crv: jwk.crv, x: jwk.x, alg: 'EdDSA', use: 'sig', kind: k.kind, owner: k.owner, status: k.status, valid_from: k.validFrom, valid_to: k.validTo, status_changed_at: k.statusChangedAt };
      }),
    };
  }

  // ---- transparency log ---------------------------------------------------------------------------------------------

  /**
   * Append a cart warrant hash. Idempotent per `cart_jti`: logging the same cart twice returns the first entry, so a
   * retried request cannot make the log disagree with itself.
   */
  async logWarrant(entry: { cartJti: string; warrantHash: string; mandateHash: string; platform: string }): Promise<TransparencyView & { included: true; seq: number; entryHash: string; loggedAt: NumericDate }> {
    const at = nowSeconds(this.clock);
    const view = (e: StoredEntry) => ({ included: true as const, seq: e.seq, entryHash: e.hash, loggedAt: (e.payload as { logged_at: number }).logged_at });
    try {
      const entryRow = await this.db.transaction(async (tx) => {
        const found = maybeOne(await tx.query<{ seq: number }>("SELECT seq FROM transparency_log WHERE type = 'warrant_logged' AND payload->>'cart_jti' = $1", [entry.cartJti]));
        if (found !== null) return (await entryAt(tx, 'transparency_log', REGISTRY_CHAIN, found.seq)) as StoredEntry;
        return appendToChain(tx, 'transparency_log', { chainId: REGISTRY_CHAIN, type: 'warrant_logged', payload: { cart_jti: entry.cartJti, warrant_hash: entry.warrantHash, mandate_hash: entry.mandateHash, platform: entry.platform, logged_at: at } }, at);
      });
      return view(entryRow);
    } catch (error) {
      // Two requests raced to log the same cart: the loser reads the winner's entry.
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.transparencyView(entry.cartJti);
      if (existing === null || !existing.included || existing.seq === null || existing.entryHash === null || existing.loggedAt === null) throw error;
      return { included: true, seq: existing.seq, entryHash: existing.entryHash, loggedAt: existing.loggedAt };
    }
  }

  /** Whether and when a cart warrant was logged: the dispute facts engine's `transparency` input. */
  async transparencyView(cartJti: string): Promise<TransparencyView> {
    const rows = await this.db.query<{ seq: number; hash: string; payload: { logged_at: number } }>(
      "SELECT seq, hash, payload FROM transparency_log WHERE type = 'warrant_logged' AND payload->>'cart_jti' = $1",
      [cartJti],
    );
    const row = maybeOne(rows);
    return row === null ? { included: false, seq: null, entryHash: null, loggedAt: null } : { included: true, seq: row.seq, entryHash: row.hash, loggedAt: row.payload.logged_at };
  }

  async head(): Promise<StoredEntry | null> {
    return chainHead(this.db, 'transparency_log', REGISTRY_CHAIN);
  }

  async entries(options: { afterSeq?: number; limit?: number } = {}): Promise<StoredEntry[]> {
    return readChain(this.db, 'transparency_log', REGISTRY_CHAIN, { ...options, limit: Math.min(options.limit ?? 100, 500) });
  }

  // ---- checkpoints and proofs ---------------------------------------------------------------------------------------

  /** Sign the current head. Idempotent while the head does not move. Returns null for an empty log. */
  async checkpoint(): Promise<Checkpoint | null> {
    const issuedAt = nowSeconds(this.clock);
    const head = await this.head();
    if (head === null) return null;
    const existing = await this.checkpointAt(head.seq);
    if (existing !== null) return existing;
    const { jws } = await signJws({ typ: 'checkpoint', chain_id: REGISTRY_CHAIN, seq: head.seq, head_hash: head.hash, iat: issuedAt }, this.logKey.privateKey, this.logKey.kid);
    await this.db.query('INSERT INTO transparency_checkpoints (seq, head_hash, issued_at, jws) VALUES ($1, $2, $3, $4) ON CONFLICT (seq) DO NOTHING', [head.seq, head.hash, issuedAt, jws]);
    return (await this.checkpointAt(head.seq));
  }

  async checkpointAt(seq: number): Promise<Checkpoint | null> {
    const rows = await this.db.query<{ seq: number; head_hash: string; issued_at: number; jws: string }>('SELECT seq, head_hash, issued_at, jws FROM transparency_checkpoints WHERE seq = $1', [seq]);
    const r = maybeOne(rows);
    return r === null ? null : { seq: r.seq, headHash: r.head_hash, issuedAt: r.issued_at, jws: r.jws };
  }

  async latestCheckpoint(): Promise<Checkpoint | null> {
    const rows = await this.db.query<{ seq: number; head_hash: string; issued_at: number; jws: string }>('SELECT seq, head_hash, issued_at, jws FROM transparency_checkpoints ORDER BY seq DESC LIMIT 1');
    const r = maybeOne(rows);
    return r === null ? null : { seq: r.seq, headHash: r.head_hash, issuedAt: r.issued_at, jws: r.jws };
  }

  /**
   * An inclusion proof for a logged cart: the entry, the entries after it up to a signed checkpoint, and that checkpoint.
   * Creates a fresh checkpoint when none covers the entry yet.
   */
  async inclusionProof(cartJti: string): Promise<InclusionProof | null> {
    const view = await this.transparencyView(cartJti);
    if (!view.included || view.seq === null) return null;
    const entry = await entryAt(this.db, 'transparency_log', REGISTRY_CHAIN, view.seq);
    if (entry === null) return null;
    let checkpoint = maybeOne(
      (await this.db.query<{ seq: number; head_hash: string; issued_at: number; jws: string }>('SELECT seq, head_hash, issued_at, jws FROM transparency_checkpoints WHERE seq >= $1 ORDER BY seq ASC LIMIT 1', [entry.seq])).map(
        (r): Checkpoint => ({ seq: r.seq, headHash: r.head_hash, issuedAt: r.issued_at, jws: r.jws }),
      ),
    );
    checkpoint ??= await this.checkpoint();
    if (checkpoint === null) return null;
    const chain = await readChain(this.db, 'transparency_log', REGISTRY_CHAIN, { afterSeq: entry.seq, limit: checkpoint.seq - entry.seq });
    return { entry, chain, checkpoint };
  }

  /** The registry's log-signing public key, so anyone can check a checkpoint. */
  logPublicKey(): { kid: string; publicKey: string } {
    return { kid: this.logKey.kid, publicKey: this.logKey.publicKeyBase64 };
  }

  /** Recompute the whole log and compare it with every signed checkpoint. */
  async audit(): Promise<LogAudit> {
    const chain = await verifyStoredChain(this.db, 'transparency_log', REGISTRY_CHAIN);
    const problems: { code: LogProblem; message: string; seq?: number }[] = [];
    if (!chain.ok) problems.push({ code: 'CHAIN_BROKEN', message: chain.message, seq: chain.brokenSeq });
    const checkpoints = await this.db.query<{ seq: number; head_hash: string; jws: string }>('SELECT seq, head_hash, jws FROM transparency_checkpoints ORDER BY seq');
    for (const c of checkpoints) {
      const entry = await entryAt(this.db, 'transparency_log', REGISTRY_CHAIN, c.seq);
      if (entry?.hash !== c.head_hash) problems.push({ code: 'CHECKPOINT_MISMATCH', message: `checkpoint ${c.seq} does not match the log`, seq: c.seq });
      const verified = await verifyJws(c.jws, this.logKey.publicKey);
      if (!verified.ok) problems.push({ code: 'CHECKPOINT_SIGNATURE', message: `checkpoint ${c.seq} signature is invalid`, seq: c.seq });
    }
    return { ok: problems.length === 0, length: chain.ok ? chain.length : 0, headSeq: chain.ok ? chain.headSeq : null, headHash: chain.ok ? chain.headHash : null, problems };
  }
}

/**
 * Check an inclusion proof offline with the registry's published log key: the chain from the entry reaches the signed
 * checkpoint head. Nothing here reads the database, so a dispute reviewer can run it on a downloaded evidence packet.
 */
export async function verifyInclusionProof(
  proof: InclusionProof,
  logPublicKeyBase64: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const verified = await verifyJws(proof.checkpoint.jws, importVerificationKey(logPublicKeyBase64));
  if (!verified.ok) return { ok: false, reason: 'checkpoint signature is invalid' };
  const claims = verified.payload as { seq?: unknown; head_hash?: unknown };
  if (claims.seq !== proof.checkpoint.seq || claims.head_hash !== proof.checkpoint.headHash) return { ok: false, reason: 'checkpoint does not match its signed statement' };
  const segment = [proof.entry, ...proof.chain].map(toLedgerEntry);
  const result = verifyChain(segment, {
    chainId: REGISTRY_CHAIN,
    ...(proof.entry.seq === 1 ? {} : { after: { seq: proof.entry.seq - 1, hash: proof.entry.prevHash } }),
    expectedHeadHash: proof.checkpoint.headHash,
  });
  if (!result.ok) return { ok: false, reason: result.message };
  if (proof.entry.seq === 1 && proof.entry.prevHash !== GENESIS_HASH) return { ok: false, reason: 'first entry does not start from the genesis hash' };
  return { ok: true };
}
