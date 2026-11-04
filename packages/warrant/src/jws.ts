import { CompactSign, compactVerify } from 'jose';
import { canonicalize, hashBytes, type JsonValue } from './canonical';
import { isEd25519PrivateKey, isEd25519PublicKey, KeyError } from './keys';
import type { KeyObject } from 'node:crypto';

/**
 * Ed25519 JWS (RFC 7515 compact serialization, `alg` EdDSA) over RFC 8785 canonical JSON, as used by
 * every signed Warrant object (docs/warrant-spec.md section 4).
 *
 * Signing canonicalizes the payload first, so the signed bytes are exactly the bytes that are hashed and
 * two systems that build the same document in a different key order produce the same signature.
 *
 * The protected header is exactly `{ "alg": "EdDSA", "kid": "<registered key id>" }`. Domain separation
 * (mandate, cart, consent) lives in the payload `typ` claim and is checked by the schema layer.
 *
 * Decoding and verification never throw for bad input; every failure is a `{ ok: false, error }` value.
 * Strictness: bounded size; exactly three canonical base64url segments (so a signature cannot be
 * re-encoded into a different but equivalent string); header must be exactly alg+kid; the algorithm is
 * pinned (so `none` and HMAC-with-the-public-key tokens fail); payload is UTF-8 JSON that can be
 * canonicalized. The caller still has to validate the payload's meaning (schema, expiry, audience).
 */

export class JwsError extends Error {
  override readonly name = 'JwsError';
}

/** Compact serializations larger than this are rejected before any parsing. */
export const MAX_JWS_LENGTH = 1024 * 1024;

export interface JwsHeader {
  readonly alg: 'EdDSA';
  readonly kid: string;
}

export interface SignedJws {
  readonly jws: string;
  /** `sha256:<base64url>` of the canonical payload. */
  readonly hash: string;
}

export type JwsErrorCode = 'MALFORMED' | 'BAD_KEY' | 'BAD_HEADER' | 'BAD_SIGNATURE' | 'BAD_PAYLOAD';

export interface JwsFailure {
  readonly ok: false;
  readonly error: { readonly code: JwsErrorCode; readonly message: string };
}

export interface DecodedJws {
  readonly ok: true;
  readonly header: JwsHeader;
  /** Parsed payload. Untrusted shape until validated. Not signature-checked when it comes from `decodeJws`. */
  readonly payload: unknown;
  /** `sha256:<base64url>` of the canonical payload. */
  readonly hash: string;
}

export type JwsDecoding = DecodedJws | JwsFailure;
export type JwsVerification = DecodedJws | JwsFailure;

const KID = /^[\x21-\x7e]{1,256}$/;
const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;

function fail(code: JwsErrorCode, message: string): JwsFailure {
  return { ok: false, error: { code, message } };
}

/** Sign a JSON value with an Ed25519 private key under key id `kid`. Throws on unusable input. */
export async function signJws(payload: JsonValue, privateKey: KeyObject, kid: string): Promise<SignedJws> {
  if (typeof kid !== 'string' || !KID.test(kid)) {
    throw new JwsError('kid must be 1-256 printable ASCII characters without spaces');
  }
  if (!isEd25519PrivateKey(privateKey)) {
    throw new KeyError('signing requires an Ed25519 private key');
  }
  const canonical = canonicalize(payload);
  const jws = await new CompactSign(new TextEncoder().encode(canonical)).setProtectedHeader({ alg: 'EdDSA', kid }).sign(privateKey);
  return { jws, hash: hashBytes(canonical) };
}

/**
 * Parse a compact JWS WITHOUT checking its signature. Use it to learn the `kid` (to look up the key) or to
 * read a payload you will verify separately. Never trust a decoded payload until `verifyJws` succeeds.
 */
export function decodeJws(jws: string): JwsDecoding {
  if (typeof jws !== 'string' || jws.length === 0 || jws.length > MAX_JWS_LENGTH) {
    return fail('MALFORMED', 'JWS must be a non-empty compact serialization of reasonable size');
  }
  const segments = jws.split('.');
  if (
    segments.length !== 3 ||
    !segments.every((s) => BASE64URL_SEGMENT.test(s) && Buffer.from(s, 'base64url').toString('base64url') === s)
  ) {
    return fail('MALFORMED', 'JWS must be three canonical base64url segments');
  }
  const [encodedHeader = '', encodedPayload = ''] = segments;
  const decoder = new TextDecoder('utf-8', { fatal: true });

  let header: unknown;
  try {
    header = JSON.parse(decoder.decode(Buffer.from(encodedHeader, 'base64url')));
  } catch {
    return fail('BAD_HEADER', 'JWS header is not UTF-8 JSON');
  }
  if (
    typeof header !== 'object' ||
    header === null ||
    Array.isArray(header) ||
    Object.keys(header).sort().join(',') !== 'alg,kid'
  ) {
    return fail('BAD_HEADER', 'JWS header must be exactly {alg, kid}');
  }
  const { alg, kid } = header as { alg: unknown; kid: unknown };
  if (alg !== 'EdDSA' || typeof kid !== 'string' || !KID.test(kid)) {
    return fail('BAD_HEADER', 'JWS header must be alg=EdDSA with a printable kid');
  }

  let payload: unknown;
  let hash: string;
  try {
    payload = JSON.parse(decoder.decode(Buffer.from(encodedPayload, 'base64url')));
    hash = hashBytes(canonicalize(payload));
  } catch {
    return fail('BAD_PAYLOAD', 'JWS payload is not canonicalizable UTF-8 JSON');
  }
  return { ok: true, header: { alg: 'EdDSA', kid }, payload, hash };
}

/** Decode, then check the EdDSA signature with the supplied Ed25519 public key. */
export async function verifyJws(jws: string, publicKey: KeyObject): Promise<JwsVerification> {
  if (!isEd25519PublicKey(publicKey)) {
    return fail('BAD_KEY', 'verification requires an Ed25519 public key');
  }
  const decoded = decodeJws(jws);
  if (!decoded.ok) {
    return decoded;
  }
  try {
    await compactVerify(jws, publicKey, { algorithms: ['EdDSA'] });
  } catch {
    return fail('BAD_SIGNATURE', 'signature is not valid for this key');
  }
  return decoded;
}
