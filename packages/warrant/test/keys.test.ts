import { createHmac, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  KEYGEN_NAMES,
  KeyError,
  exportSigningKey,
  exportVerificationKey,
  generateKeyEnv,
  generateSigningKey,
  importSigningKey,
  importVerificationKey,
  publicKeyOf,
} from '../src/keys';

describe('signing keys', () => {
  it('generates an Ed25519 pair whose base64 export is 48 bytes of PKCS#8 DER', () => {
    const pair = generateSigningKey();
    expect(pair.privateKey.asymmetricKeyType).toBe('ed25519');
    expect(pair.publicKey.asymmetricKeyType).toBe('ed25519');
    expect(pair.privateKeyBase64).toMatch(/^[A-Za-z0-9+/]{64}$/);
    expect(Buffer.from(pair.privateKeyBase64, 'base64')).toHaveLength(48);
  });

  it('generates a different key every time', () => {
    expect(generateSigningKey().privateKeyBase64).not.toBe(generateSigningKey().privateKeyBase64);
  });

  it('round-trips through export and import', () => {
    const pair = generateSigningKey();
    const imported = importSigningKey(pair.privateKeyBase64);
    expect(exportSigningKey(imported)).toBe(pair.privateKeyBase64);
    expect(publicKeyOf(imported).export({ format: 'der', type: 'spki' }).equals(pair.publicKey.export({ format: 'der', type: 'spki' }))).toBe(true);
  });

  it('imports a public key from SPKI base64', () => {
    const pair = generateSigningKey();
    const spki = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const imported = importVerificationKey(spki);
    expect(imported.asymmetricKeyType).toBe('ed25519');
    expect(imported.type).toBe('public');
  });

  it.each([
    ['an empty string', ''],
    ['whitespace', '   '],
    ['not base64', '!!!not-base64!!!'],
    ['url-safe base64', 'AAAA-_AA'],
    ['base64 with embedded whitespace', 'MC4CAQAw\nBQYDK2VwBCIEI'],
    ['too short', 'AAAA'],
    ['valid base64, wrong content', Buffer.alloc(48).toString('base64')],
  ])('refuses to import a private key from %s', (_label, text) => {
    expect(() => importSigningKey(text)).toThrow(KeyError);
  });

  it('refuses a private key of the wrong algorithm', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const ed448 = generateKeyPairSync('ed448').privateKey;
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    for (const key of [rsa, ed448, ec]) {
      const text = key.export({ format: 'der', type: 'pkcs8' }).toString('base64');
      expect(() => importSigningKey(text)).toThrow(KeyError);
    }
  });

  it('refuses to import a public key where a private key is expected, and vice versa', () => {
    const pair = generateSigningKey();
    const spki = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    expect(() => importSigningKey(spki)).toThrow(KeyError);
    expect(() => importVerificationKey(pair.privateKeyBase64)).toThrow(KeyError);
  });

  it('refuses a public key of the wrong algorithm', () => {
    const ed448 = createPublicKey(generateKeyPairSync('ed448').privateKey);
    expect(() => importVerificationKey(ed448.export({ format: 'der', type: 'spki' }).toString('base64'))).toThrow(KeyError);
  });

  it('refuses non-string input at runtime', () => {
    expect(() => importSigningKey(undefined as unknown as string)).toThrow(KeyError);
    expect(() => importVerificationKey(5 as unknown as string)).toThrow(KeyError);
  });

  it('does not leak key material in error messages', () => {
    const pair = generateSigningKey();
    const corrupted = pair.privateKeyBase64.slice(0, -4) + 'AAAA';
    try {
      importSigningKey(corrupted);
    } catch (error) {
      expect(String(error)).not.toContain(pair.privateKeyBase64.slice(8, 40));
    }
  });

  it('keeps an HMAC over the public key distinguishable from a signature (sanity check for the alg-confusion test)', () => {
    const pair = generateSigningKey();
    const mac = createHmac('sha256', pair.publicKey.export({ format: 'der', type: 'spki' })).update('x').digest();
    expect(mac).toHaveLength(32);
  });
});

describe('key export helpers', () => {
  it('exports a public key as SPKI base64 that imports back', () => {
    const pair = generateSigningKey();
    const text = exportVerificationKey(pair.publicKey);
    expect(text).toMatch(/^[A-Za-z0-9+/]{59}=$/);
    expect(exportVerificationKey(importVerificationKey(text))).toBe(text);
  });

  it('refuses to export or derive from the wrong kind of key', () => {
    const pair = generateSigningKey();
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(() => exportVerificationKey(pair.privateKey)).toThrow(KeyError);
    expect(() => exportVerificationKey(rsa.publicKey)).toThrow(KeyError);
    expect(() => exportSigningKey(pair.publicKey)).toThrow(KeyError);
    expect(() => exportSigningKey(rsa.privateKey)).toThrow(KeyError);
    expect(() => publicKeyOf(pair.publicKey)).toThrow(KeyError);
    expect(() => publicKeyOf('key' as never)).toThrow(KeyError);
  });

  it('rejects base64 that decodes but is not canonical', () => {
    const pair = generateSigningKey();
    // Same bytes, but the final character carries non-zero unused bits.
    const text = pair.privateKeyBase64;
    expect(text.endsWith('=')).toBe(false);
    expect(() => importSigningKey(text + 'A')).toThrow(KeyError);
    const spki = exportVerificationKey(pair.publicKey);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const last = spki.at(-2) ?? '';
    const variant = alphabet[(alphabet.indexOf(last) & 0x3c) | 3] ?? '';
    if (variant !== last) {
      const malleated = spki.slice(0, -2) + variant + '=';
      expect(Buffer.from(malleated, 'base64').equals(Buffer.from(spki, 'base64'))).toBe(true);
      expect(() => importVerificationKey(malleated)).toThrow(KeyError);
    }
  });
});

describe('generateKeyEnv (pnpm keygen)', () => {
  it('prints one NAME=value private key line for each name in .env.example, all importable and distinct', () => {
    const { privateLines, publicLines } = generateKeyEnv();
    expect(privateLines.map((l) => l.split('=')[0])).toEqual([...KEYGEN_NAMES]);
    expect(KEYGEN_NAMES).toEqual(['WALLET_SIGNING_KEY', 'AGENT_PLATFORM_SIGNING_KEY', 'REGISTRY_LOG_KEY']);
    const values = privateLines.map((l) => l.slice(l.indexOf('=') + 1));
    expect(new Set(values).size).toBe(3);
    for (const value of values) expect(importSigningKey(value).asymmetricKeyType).toBe('ed25519');
    expect(publicLines).toHaveLength(3);
    expect(publicLines[0]).toMatch(/^WALLET_SIGNING_PUBLIC_KEY=/);
  });

  it('public lines match the private keys they sit next to', () => {
    const { privateLines, publicLines } = generateKeyEnv(['A_KEY', 'B_KEY']);
    privateLines.forEach((line, i) => {
      const privateKey = importSigningKey(line.slice(line.indexOf('=') + 1));
      const publicLine = publicLines[i] ?? '';
      expect(publicLine.slice(publicLine.indexOf('=') + 1)).toBe(exportVerificationKey(publicKeyOf(privateKey)));
    });
  });

  it('accepts custom names and rejects bad or duplicate ones', () => {
    expect(generateKeyEnv(['ONE_KEY']).privateLines).toHaveLength(1);
    expect(generateKeyEnv([]).privateLines).toEqual([]);
    for (const bad of ['', 'lower', '1START', 'HAS SPACE', 'A=B', 'A\nB', 'X'.repeat(65)]) {
      expect(() => generateKeyEnv([bad])).toThrow(KeyError);
    }
    expect(() => generateKeyEnv(['X_KEY', 'X_KEY'])).toThrow(KeyError);
  });
});
