import { canonicalize, hashBytes, isHash, type JsonValue } from './canonical';

/**
 * Append-only, SHA-256 hash-chained log. Used as the audit ledger and as the registry transparency log.
 *
 *   entry.hash = SHA-256( prevHash || canonical_json({ chainId, seq, type, payload }) )
 *
 * `prevHash` is a fixed-width string, so plain concatenation is unambiguous. The hash covers the chain id,
 * the sequence number and the type as well as the payload, so none of them can be edited without detection.
 * Hashes use the Warrant wire format: `sha256:` plus unpadded base64url.
 *
 * What a chain proves, and what it does not:
 *  - Any edit, removal, insertion, reordering or duplication of an entry that is not followed by a consistent
 *    rewrite of every later entry is detected, and `verifyChain` reports the first broken `seq`.
 *  - A chain alone cannot show that its TAIL was not cut off, or that the whole chain was not rewritten
 *    consistently from some point. Pin the head hash somewhere the attacker cannot reach (for example the
 *    registry's published head, or the receipt hash stored in a PayPal field) and pass it as `expectedHeadHash`.
 */

/** The `prevHash` of the first entry in every chain: the hash format applied to 32 zero bytes. */
export const GENESIS_HASH = 'sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const MAX_TYPE_LENGTH = 128;
const MAX_CHAIN_ID_LENGTH = 256;

export class LedgerError extends Error {
  override readonly name = 'LedgerError';
}

export interface LedgerEntry {
  readonly chainId: string;
  /** 1-based position in the chain. */
  readonly seq: number;
  readonly type: string;
  readonly payload: JsonValue;
  readonly prevHash: string;
  readonly hash: string;
}

export interface LedgerDraft {
  readonly chainId: string;
  readonly type: string;
  readonly payload: JsonValue;
}

export interface EntryBody {
  readonly chainId: string;
  readonly seq: number;
  readonly type: string;
  readonly payload: JsonValue;
}

export function computeEntryHash(prevHash: string, body: EntryBody): string {
  return hashBytes(prevHash + canonicalize({ chainId: body.chainId, seq: body.seq, type: body.type, payload: body.payload }));
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const member of Object.values(value)) {
      deepFreeze(member);
    }
  }
  return value;
}

function validName(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/**
 * Append an entry after `previous` (or start a chain when `previous` is null). The entry owns a deep, frozen
 * copy of the payload. Throws on a malformed draft, an inconsistent `previous`, or a chain-id mismatch.
 */
export function appendEntry(previous: LedgerEntry | null, draft: LedgerDraft): LedgerEntry {
  if (!validName(draft.chainId, MAX_CHAIN_ID_LENGTH)) {
    throw new LedgerError('chainId must be a non-empty string');
  }
  if (!validName(draft.type, MAX_TYPE_LENGTH)) {
    throw new LedgerError(`type must be a non-empty string of at most ${MAX_TYPE_LENGTH} characters`);
  }
  let canonicalPayload: string;
  try {
    canonicalPayload = canonicalize(draft.payload);
  } catch (error) {
    throw new LedgerError(`payload is not canonical JSON: ${error instanceof Error ? error.message : 'unknown error'}`);
  }

  let seq = 1;
  let prevHash = GENESIS_HASH;
  if (previous !== null) {
    const check = checkEntry(previous);
    if (check !== null) {
      throw new LedgerError(`previous entry is not valid: ${check}`);
    }
    if (previous.chainId !== draft.chainId) {
      throw new LedgerError('previous entry belongs to a different chain');
    }
    if (previous.hash !== computeEntryHash(previous.prevHash, previous)) {
      throw new LedgerError('previous entry hash does not match its contents');
    }
    seq = previous.seq + 1;
    prevHash = previous.hash;
  }

  const payload = JSON.parse(canonicalPayload) as JsonValue;
  const hash = computeEntryHash(prevHash, { chainId: draft.chainId, seq, type: draft.type, payload });
  return deepFreeze({ chainId: draft.chainId, seq, type: draft.type, payload, prevHash, hash });
}

const ENTRY_KEYS = ['chainId', 'hash', 'payload', 'prevHash', 'seq', 'type'];

/** Structural validation of one entry. Returns a problem description, or null when well-formed. */
function checkEntry(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'entry is not an object';
  }
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).sort().join(',') !== ENTRY_KEYS.join(',')) {
    return 'entry must have exactly the fields chainId, seq, type, payload, prevHash, hash';
  }
  if (!validName(entry['chainId'], MAX_CHAIN_ID_LENGTH)) return 'chainId must be a non-empty string';
  if (typeof entry['seq'] !== 'number' || !Number.isSafeInteger(entry['seq']) || entry['seq'] < 1) return 'seq must be a positive integer';
  if (!validName(entry['type'], MAX_TYPE_LENGTH)) return 'type must be a non-empty string';
  if (!isHash(entry['prevHash']) || !isHash(entry['hash'])) return 'prevHash and hash must be sha256: hashes';
  try {
    canonicalize(entry['payload']);
  } catch {
    return 'payload is not canonical JSON';
  }
  return null;
}

export type ChainFailureReason =
  | 'NOT_AN_ARRAY'
  | 'MALFORMED_ENTRY'
  | 'CHAIN_ID_MISMATCH'
  | 'SEQ_MISMATCH'
  | 'PREV_HASH_MISMATCH'
  | 'HASH_MISMATCH'
  | 'HEAD_MISMATCH';

export type ChainVerification =
  | { readonly ok: true; readonly length: number; readonly headSeq: number | null; readonly headHash: string | null }
  | {
      readonly ok: false;
      /** The first `seq` at which the chain stops being consistent. */
      readonly brokenSeq: number;
      readonly reason: ChainFailureReason;
      readonly message: string;
    };

export interface VerifyChainOptions {
  /** Require every entry to belong to this chain. Default: the chain id of the first entry. */
  readonly chainId?: string;
  /** Verify a later segment of a chain: the entry that precedes `entries[0]`. */
  readonly after?: { readonly seq: number; readonly hash: string };
  /** A trusted head hash for the last entry (detects truncation and wholesale rewrites). */
  readonly expectedHeadHash?: string;
}

/** Recompute the whole chain. Accepts untrusted input (for example rows read back from a database). */
export function verifyChain(entries: unknown, options: VerifyChainOptions = {}): ChainVerification {
  if (!Array.isArray(entries)) {
    return { ok: false, brokenSeq: 1, reason: 'NOT_AN_ARRAY', message: 'ledger must be an array of entries' };
  }
  let expectedSeq = options.after === undefined ? 1 : options.after.seq + 1;
  let expectedPrev = options.after === undefined ? GENESIS_HASH : options.after.hash;
  let chainId = options.chainId;
  let headSeq: number | null = options.after?.seq ?? null;
  let headHash: string | null = options.after?.hash ?? null;

  for (const candidate of entries as unknown[]) {
    const problem = checkEntry(candidate);
    if (problem !== null) {
      return { ok: false, brokenSeq: expectedSeq, reason: 'MALFORMED_ENTRY', message: problem };
    }
    const entry = candidate as LedgerEntry;
    chainId ??= entry.chainId;
    if (entry.chainId !== chainId) {
      return { ok: false, brokenSeq: expectedSeq, reason: 'CHAIN_ID_MISMATCH', message: `entry belongs to chain ${entry.chainId}, expected ${chainId}` };
    }
    if (entry.seq !== expectedSeq) {
      return { ok: false, brokenSeq: expectedSeq, reason: 'SEQ_MISMATCH', message: `expected seq ${expectedSeq}, found ${entry.seq}` };
    }
    if (entry.prevHash !== expectedPrev) {
      return { ok: false, brokenSeq: expectedSeq, reason: 'PREV_HASH_MISMATCH', message: `entry ${entry.seq} does not link to the previous entry` };
    }
    if (entry.hash !== computeEntryHash(entry.prevHash, entry)) {
      return { ok: false, brokenSeq: expectedSeq, reason: 'HASH_MISMATCH', message: `entry ${entry.seq} hash does not match its contents` };
    }
    headSeq = entry.seq;
    headHash = entry.hash;
    expectedSeq += 1;
    expectedPrev = entry.hash;
  }

  if (options.expectedHeadHash !== undefined && options.expectedHeadHash !== headHash) {
    return {
      ok: false,
      brokenSeq: headSeq ?? expectedSeq,
      reason: 'HEAD_MISMATCH',
      message: 'chain head does not match the trusted head hash (truncated or rewritten)',
    };
  }
  return { ok: true, length: entries.length, headSeq, headHash };
}
