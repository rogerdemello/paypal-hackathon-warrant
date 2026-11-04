import { createHash } from 'node:crypto';

/**
 * JSON Canonicalization Scheme (RFC 8785).
 *
 * - Object keys are sorted by UTF-16 code unit order, which is what Array.prototype.sort does for strings.
 * - Strings are serialized with JSON.stringify, whose escaping is exactly the minimal escaping JCS requires.
 * - Numbers use the ECMAScript Number-to-String algorithm (String(n)), as JCS requires.
 * - No insignificant whitespace.
 *
 * Input is restricted to I-JSON values: null, boolean, finite number, well-formed string, arrays and plain
 * objects. Anything else (NaN, Infinity, undefined elements, Date, Map, bigint, lone surrogates, cycles) throws,
 * because silently dropping or coercing it would let two different inputs hash the same, or one input hash
 * differently after a database round trip.
 *
 * One deliberate leniency: an object property whose value is `undefined` is omitted, exactly as JSON.stringify
 * and a Postgres jsonb round trip would omit it. That keeps a ledger hash stable across storage.
 */

/** A value that survives JSON.stringify / JSON.parse unchanged (I-JSON subset). */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export class CanonicalJsonError extends Error {
  override readonly name = 'CanonicalJsonError';
}

const MAX_DEPTH = 256;

export function canonicalize(value: unknown): string {
  return serialize(value, 0, new Set<object>());
}

function serialize(value: unknown, depth: number, ancestors: Set<object>): string {
  if (depth > MAX_DEPTH) {
    throw new CanonicalJsonError(`value is nested deeper than ${MAX_DEPTH} levels`);
  }
  if (value === null) return 'null';

  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CanonicalJsonError('numbers must be finite');
    }
    return String(value);
  }
  if (typeof value === 'string') return serializeString(value);
  if (typeof value !== 'object') {
    throw new CanonicalJsonError(`${typeof value} is not a JSON value`);
  }

  if (ancestors.has(value)) {
    throw new CanonicalJsonError('cyclic structure');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let i = 0; i < value.length; i++) {
        if (!(i in value)) {
          throw new CanonicalJsonError('sparse arrays are not JSON values');
        }
        items.push(serialize((value as unknown[])[i], depth + 1, ancestors));
      }
      return `[${items.join(',')}]`;
    }

    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new CanonicalJsonError('only plain objects are JSON values');
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new CanonicalJsonError('symbol keys are not JSON');
    }
    const record = value as Record<string, unknown>;
    const members: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const member = record[key];
      if (member === undefined) continue;
      members.push(`${serializeString(key)}:${serialize(member, depth + 1, ancestors)}`);
    }
    return `{${members.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function serializeString(text: string): string {
  if (!text.isWellFormed()) {
    throw new CanonicalJsonError('strings must be well-formed UTF-16 (no lone surrogates)');
  }
  return JSON.stringify(text);
}

/** Lowercase hex SHA-256 of the UTF-8 bytes of `data` (or of the raw bytes). */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Wire format of every hash in a Warrant: `sha256:` followed by the unpadded base64url SHA-256 digest (43 characters). */
export const HASH_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/;

export function isHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_PATTERN.test(value);
}

/** `sha256:<base64url digest>` of the UTF-8 bytes of `data` (or of the raw bytes). */
export function hashBytes(data: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(data).digest('base64url')}`;
}

/** Hash of free text (for example the principal's instruction, or a PayPal payer id). */
export function hashText(text: string): string {
  return hashBytes(text);
}

/** Hash of a JSON value: SHA-256 over its RFC 8785 canonical form. */
export function hashJson(value: unknown): string {
  return hashBytes(canonicalize(value));
}
