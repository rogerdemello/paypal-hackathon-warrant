import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';

/**
 * Ed25519 key handling for mandate signing.
 *
 * Wire formats (both base64, standard alphabet, with padding):
 *  - private key: PKCS#8 DER, 48 bytes -> 64 characters. This is what `pnpm keygen` prints.
 *  - public key: SPKI DER, 44 bytes -> 60 characters.
 *
 * Error messages never include key material.
 */

export class KeyError extends Error {
  override readonly name = 'KeyError';
}

export interface SigningKeyPair {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  /** PKCS#8 DER, base64. Treat as a secret. */
  readonly privateKeyBase64: string;
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})+$|^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)$/;

function decodeBase64(text: unknown, what: string): Buffer {
  if (typeof text !== 'string' || !BASE64.test(text)) {
    throw new KeyError(`${what} must be standard base64 text`);
  }
  const bytes = Buffer.from(text, 'base64');
  if (bytes.toString('base64') !== text) {
    throw new KeyError(`${what} must be canonical base64 text`);
  }
  return bytes;
}

export function isEd25519PrivateKey(key: unknown): key is KeyObject {
  return isKeyObject(key) && key.type === 'private' && key.asymmetricKeyType === 'ed25519';
}

export function isEd25519PublicKey(key: unknown): key is KeyObject {
  return isKeyObject(key) && key.type === 'public' && key.asymmetricKeyType === 'ed25519';
}

function isKeyObject(key: unknown): key is KeyObject {
  return typeof key === 'object' && key !== null && 'type' in key && 'asymmetricKeyType' in key && 'export' in key;
}

export function generateSigningKey(): SigningKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey, privateKeyBase64: exportSigningKey(privateKey) };
}

export function exportSigningKey(key: KeyObject): string {
  if (!isEd25519PrivateKey(key)) {
    throw new KeyError('not an Ed25519 private key');
  }
  return key.export({ format: 'der', type: 'pkcs8' }).toString('base64');
}

/** Import a private signing key (PKCS#8 DER, base64), as printed by `pnpm keygen`. */
export function importSigningKey(base64: string): KeyObject {
  const der = decodeBase64(base64, 'signing key');
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  } catch {
    throw new KeyError('signing key is not a valid PKCS#8 private key');
  }
  if (!isEd25519PrivateKey(key)) {
    throw new KeyError('signing key must be an Ed25519 private key');
  }
  return key;
}

/** Import a public verification key (SPKI DER, base64). */
export function importVerificationKey(base64: string): KeyObject {
  const der = decodeBase64(base64, 'verification key');
  let key: KeyObject;
  try {
    key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    throw new KeyError('verification key is not a valid SPKI public key');
  }
  if (!isEd25519PublicKey(key)) {
    throw new KeyError('verification key must be an Ed25519 public key');
  }
  return key;
}

/** Derive the public verification key from a private signing key. */
export function publicKeyOf(privateKey: KeyObject): KeyObject {
  if (!isEd25519PrivateKey(privateKey)) {
    throw new KeyError('not an Ed25519 private key');
  }
  return createPublicKey(privateKey);
}

/** SPKI DER, base64: the public half of a signing key, safe to publish in the registry. */
export function exportVerificationKey(publicKey: KeyObject): string {
  if (!isEd25519PublicKey(publicKey)) {
    throw new KeyError('not an Ed25519 public key');
  }
  return publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
}

/** The environment variables `pnpm keygen` fills in (see .env.example). */
export const KEYGEN_NAMES = ['WALLET_SIGNING_KEY', 'AGENT_PLATFORM_SIGNING_KEY', 'REGISTRY_LOG_KEY'] as const;

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

export interface GeneratedKeyEnv {
  /** `NAME=<base64 private key>` lines, ready to paste into `.env`. Secrets. */
  readonly privateLines: readonly string[];
  /** `NAME=<base64 public key>` lines for registries and verifiers. Safe to publish. */
  readonly publicLines: readonly string[];
}

/** Generate one fresh Ed25519 key per environment variable name. */
export function generateKeyEnv(names: readonly string[] = KEYGEN_NAMES): GeneratedKeyEnv {
  if (new Set(names).size !== names.length) {
    throw new KeyError('environment variable names must be unique');
  }
  const privateLines: string[] = [];
  const publicLines: string[] = [];
  for (const name of names) {
    if (!ENV_NAME.test(name)) {
      throw new KeyError(`${JSON.stringify(name)} is not a valid environment variable name`);
    }
    const pair = generateSigningKey();
    privateLines.push(`${name}=${pair.privateKeyBase64}`);
    publicLines.push(`${name.replace(/_KEY$/, '')}_PUBLIC_KEY=${exportVerificationKey(pair.publicKey)}`);
  }
  return { privateLines, publicLines };
}
