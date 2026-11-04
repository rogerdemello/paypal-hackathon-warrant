import { createHmac } from 'node:crypto';
import fc from 'fast-check';
import { CompactSign, base64url } from 'jose';
import { describe, expect, it } from 'vitest';
import { canonicalize, hashJson } from '../src/canonical';
import { JwsError, decodeJws, signJws, verifyJws } from '../src/jws';
import { generateSigningKey } from '../src/keys';

const KID = 'wallet-2026-10';
const enc = new TextEncoder();
const keys = generateSigningKey();
const doc = { b: [1, 2, { z: null, a: 'x' }], a: 'hello', amount: '89.99' };

async function signRaw(payload: string | Uint8Array, header: Record<string, unknown> = { alg: 'EdDSA', kid: KID }) {
  const bytes = typeof payload === 'string' ? enc.encode(payload) : payload;
  return new CompactSign(bytes).setProtectedHeader(header as { alg: string }).sign(keys.privateKey);
}

const b64 = (text: string) => base64url.encode(enc.encode(text));

describe('signJws and verifyJws (Ed25519 JWS over RFC 8785 canonical bytes)', () => {
  it('round-trips and returns the header, payload and hash', async () => {
    const signed = await signJws(doc, keys.privateKey, KID);
    expect(signed.hash).toBe(hashJson(doc));
    expect(signed.jws.split('.')).toHaveLength(3);
    expect(await verifyJws(signed.jws, keys.publicKey)).toEqual({
      ok: true,
      header: { alg: 'EdDSA', kid: KID },
      payload: doc,
      hash: signed.hash,
    });
  });

  it('puts exactly alg and kid in the protected header and signs the canonical bytes', async () => {
    const { jws } = await signJws(doc, keys.privateKey, KID);
    const [header, payload] = jws.split('.');
    expect(JSON.parse(new TextDecoder().decode(base64url.decode(header ?? '')))).toEqual({ alg: 'EdDSA', kid: KID });
    expect(new TextDecoder().decode(base64url.decode(payload ?? ''))).toBe(canonicalize(doc));
  });

  it('is deterministic and ignores property order (Ed25519 signatures are deterministic)', async () => {
    const a = await signJws(doc, keys.privateKey, KID);
    const b = await signJws({ amount: '89.99', a: 'hello', b: [1, 2, { a: 'x', z: null }] }, keys.privateKey, KID);
    expect(a.jws).toBe(b.jws);
  });

  it('signs scalars and arrays too', async () => {
    for (const payload of [null, true, 5, 'text', [], [1, 'a'], {}]) {
      const { jws } = await signJws(payload, keys.privateKey, KID);
      expect(await verifyJws(jws, keys.publicKey)).toMatchObject({ ok: true, payload });
    }
  });

  it('refuses to sign a value that is not canonical JSON', async () => {
    await expect(signJws({ n: Number.NaN }, keys.privateKey, KID)).rejects.toThrow();
    await expect(signJws({ d: new Date(0) } as never, keys.privateKey, KID)).rejects.toThrow();
  });

  it('refuses to sign with a key that is not an Ed25519 private key', async () => {
    await expect(signJws(doc, keys.publicKey, KID)).rejects.toThrow();
    await expect(signJws(doc, 'secret' as never, KID)).rejects.toThrow();
  });

  it.each(['', ' ', 'a b', 'tab\t', 'k'.repeat(257), 5 as never, undefined as never])('refuses an unusable kid: %j', async (kid) => {
    await expect(signJws(doc, keys.privateKey, kid)).rejects.toThrow(JwsError);
  });

  it('rejects a signature made by a different key', async () => {
    const other = generateSigningKey();
    const { jws } = await signJws(doc, other.privateKey, KID);
    expect(await verifyJws(jws, keys.publicKey)).toMatchObject({ ok: false, error: { code: 'BAD_SIGNATURE' } });
  });

  it('rejects an edited payload under the original signature', async () => {
    const { jws } = await signJws(doc, keys.privateKey, KID);
    const [header, , signature] = jws.split('.');
    const edited = b64(canonicalize({ ...doc, amount: '0.01' }));
    expect(await verifyJws(`${header}.${edited}.${signature}`, keys.publicKey)).toMatchObject({ ok: false, error: { code: 'BAD_SIGNATURE' } });
  });

  it('rejects an edited kid (the kid is part of the signed header)', async () => {
    const { jws } = await signJws(doc, keys.privateKey, KID);
    const [, payload, signature] = jws.split('.');
    const header = b64('{"alg":"EdDSA","kid":"wallet-other"}');
    expect(await verifyJws(`${header}.${payload}.${signature}`, keys.publicKey)).toMatchObject({ ok: false, error: { code: 'BAD_SIGNATURE' } });
  });

  it.each([
    ['an extra header parameter', { alg: 'EdDSA', kid: KID, typ: 'JWT' }],
    ['an embedded jwk', { alg: 'EdDSA', kid: KID, jwk: { kty: 'OKP' } }],
    ['no kid', { alg: 'EdDSA' }],
    ['a non-string kid', { alg: 'EdDSA', kid: 7 }],
    ['a kid with a space', { alg: 'EdDSA', kid: 'a b' }],
  ])('rejects a validly signed JWS with %s in the header', async (_label, header) => {
    const jws = await signRaw(canonicalize(doc), header);
    expect(await verifyJws(jws, keys.publicKey)).toMatchObject({ ok: false, error: { code: 'BAD_HEADER' } });
  });

  it('rejects alg=none and a header that is not a JSON object', async () => {
    const payload = b64(canonicalize(doc));
    for (const header of ['{"alg":"none","kid":"k"}', '[]', '"EdDSA"', 'null', 'not json']) {
      for (const jws of [`${b64(header)}.${payload}.`, `${b64(header)}.${payload}.${b64('x')}`]) {
        expect((await verifyJws(jws, keys.publicKey)).ok).toBe(false);
      }
    }
  });

  it('rejects an HS256 token MACed with the public key (algorithm confusion)', async () => {
    const header = b64(JSON.stringify({ alg: 'HS256', kid: KID }));
    const payload = b64(canonicalize(doc));
    for (const secret of [keys.publicKey.export({ format: 'der', type: 'spki' }), keys.publicKey.export({ format: 'pem', type: 'spki' })]) {
      const mac = createHmac('sha256', secret).update(`${header}.${payload}`).digest();
      expect((await verifyJws(`${header}.${payload}.${base64url.encode(mac)}`, keys.publicKey)).ok).toBe(false);
    }
  });

  it('rejects a non-canonical base64url encoding of the same bytes (JWS malleability)', async () => {
    const { jws } = await signJws(doc, keys.privateKey, KID);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = jws.at(-1) ?? '';
    // A 64-byte signature is 86 base64url characters; the last one carries 4 unused bits. Set one of them.
    const variant = alphabet[(alphabet.indexOf(last) & 0x30) | 1] ?? '';
    expect(variant).not.toBe(last);
    const malleated = jws.slice(0, -1) + variant;
    expect(base64url.decode(malleated.split('.')[2] ?? '')).toEqual(base64url.decode(jws.split('.')[2] ?? ''));
    expect(await verifyJws(malleated, keys.publicKey)).toMatchObject({ ok: false, error: { code: 'MALFORMED' } });
  });

  it.each([
    ['an empty string', ''],
    ['a single segment', 'abc'],
    ['two segments', 'abc.def'],
    ['four segments', 'a.b.c.d'],
    ['empty segments', '..'],
    ['whitespace padding', ' a.b.c '],
    ['padding characters', 'YQ==.YQ==.YQ=='],
    ['non-base64url characters', 'a+b.c/d.e f'],
    ['a JSON-serialized JWS', '{"payload":"x","signatures":[]}'],
    ['a huge input', 'a'.repeat(2_000_000)],
  ])('rejects malformed input: %s', async (_label, input) => {
    expect(await verifyJws(input, keys.publicKey)).toMatchObject({ ok: false, error: { code: 'MALFORMED' } });
    expect(decodeJws(input)).toMatchObject({ ok: false, error: { code: 'MALFORMED' } });
  });

  it('rejects non-string input without throwing', async () => {
    const inputs: unknown[] = [undefined, null, 5, {}, ['a.b.c']];
    for (const input of inputs) {
      expect((await verifyJws(input as string, keys.publicKey)).ok).toBe(false);
      expect(decodeJws(input as string).ok).toBe(false);
    }
  });

  it('rejects a verification key that is not an Ed25519 public key', async () => {
    const { jws } = await signJws(doc, keys.privateKey, KID);
    expect(await verifyJws(jws, keys.privateKey)).toMatchObject({ ok: false, error: { code: 'BAD_KEY' } });
    expect(await verifyJws(jws, 'not a key' as never)).toMatchObject({ ok: false, error: { code: 'BAD_KEY' } });
  });

  it('rejects a correctly signed payload that is not UTF-8 JSON', async () => {
    for (const payload of ['not json', new Uint8Array([0xff, 0xfe, 0xfd]), '{"a":1} trailing']) {
      expect(await verifyJws(await signRaw(payload), keys.publicKey)).toMatchObject({ ok: false, error: { code: 'BAD_PAYLOAD' } });
    }
  });

  it('rejects a correctly signed payload that cannot be canonicalized', async () => {
    const loneSurrogate = String.raw`{"k":"\ud800"}`;
    expect(await verifyJws(await signRaw(loneSurrogate), keys.publicKey)).toMatchObject({ ok: false, error: { code: 'BAD_PAYLOAD' } });
  });

  it('accepts a correctly signed payload that is not in canonical form, and hashes the canonical form', async () => {
    const result = await verifyJws(await signRaw(JSON.stringify(doc, null, 2)), keys.publicKey);
    expect(result).toMatchObject({ ok: true, payload: doc, hash: hashJson(doc) });
  });

  it('decodeJws reads the header and payload without checking the signature', async () => {
    const other = generateSigningKey();
    const { jws } = await signJws(doc, other.privateKey, KID);
    expect(decodeJws(jws)).toEqual({ ok: true, header: { alg: 'EdDSA', kid: KID }, payload: doc, hash: hashJson(doc) });
  });

  it('property: every JSON value signs and verifies, keeping its hash', async () => {
    await fc.assert(
      fc.asyncProperty(fc.jsonValue(), async (value) => {
        const signed = await signJws(value as never, keys.privateKey, KID);
        const result = await verifyJws(signed.jws, keys.publicKey);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.hash).toBe(signed.hash);
          expect(canonicalize(result.payload)).toBe(canonicalize(value));
        }
      }),
      { numRuns: 150 },
    );
  });

  it('property: no single-character change to a signed document still verifies', async () => {
    const { jws } = await signJws(doc, keys.privateKey, KID);
    const replacements = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.+/= ';
    await fc.assert(
      fc.asyncProperty(fc.nat(jws.length - 1), fc.nat(replacements.length - 1), async (position, pick) => {
        const replacement = replacements[pick] ?? 'A';
        fc.pre(replacement !== jws[position]);
        const mutated = jws.slice(0, position) + replacement + jws.slice(position + 1);
        expect((await verifyJws(mutated, keys.publicKey)).ok).toBe(false);
      }),
      { numRuns: 600 },
    );
  });

  it('property: no single-byte change to the raw JWS bytes still verifies', async () => {
    const { jws } = await signJws(doc, keys.privateKey, KID);
    const original = Buffer.from(jws, 'utf8');
    await fc.assert(
      fc.asyncProperty(fc.nat(original.length - 1), fc.integer({ min: 1, max: 255 }), async (position, delta) => {
        const bytes = Buffer.from(original);
        bytes[position] = ((bytes[position] ?? 0) + delta) % 256;
        expect((await verifyJws(bytes.toString('utf8'), keys.publicKey)).ok).toBe(false);
      }),
      { numRuns: 600 },
    );
  });
});
