import { createHash, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { exportSigningKey, exportVerificationKey, generateSigningKey, importSigningKey, publicKeyOf } from '@warrant/warrant';
import type { Config } from './config';

/**
 * The three signing identities of the demo deployment (docs/architecture.md section 9: one service plays wallet, registry
 * and merchant in the prototype, with separate keys so each party's signatures can be told apart):
 *
 *   wallet    signs mandates and consents
 *   agent     the agent platform; signs cart warrants
 *   registry  signs transparency-log checkpoints
 */

export interface KeyMaterial {
  /** The JWS `kid`: `<kind>-` plus 16 characters of the SPKI hash, so it changes whenever the key does. */
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly publicKeyBase64: string;
}

export type KeySource = 'env' | 'dev-file' | 'ephemeral';

export interface ServerKeys {
  readonly wallet: KeyMaterial;
  readonly agent: KeyMaterial;
  readonly registry: KeyMaterial;
  readonly sources: Readonly<Record<'wallet' | 'agent' | 'registry', KeySource>>;
}

export function keyMaterial(kind: string, privateKey: KeyObject): KeyMaterial {
  const publicKey = publicKeyOf(privateKey);
  const publicKeyBase64 = exportVerificationKey(publicKey);
  const digest = createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest('base64url').slice(0, 16);
  return { kid: `${kind}-${digest}`, privateKey, publicKey, publicKeyBase64 };
}

type Kind = 'wallet' | 'agent' | 'registry';
const KINDS: readonly Kind[] = ['wallet', 'agent', 'registry'];

export interface LoadKeysOptions {
  /** Persist generated development keys under `<dataDir>/dev-keys.json` so restarts keep the same identities. */
  readonly persist?: boolean;
}

/**
 * Keys from the environment when set, else development keys from `<dataDir>/dev-keys.json`, else fresh ephemeral keys.
 * Development keys are for local use only: they live in a plain file, and production configuration refuses to start without
 * real keys (see config.ts).
 */
export function loadServerKeys(config: Config, options: LoadKeysOptions = {}): ServerKeys {
  const file = resolve(config.dataDir, 'dev-keys.json');
  const stored: Partial<Record<Kind, string>> = options.persist === true && existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Partial<Record<Kind, string>>) : {};
  let dirty = false;
  const material = {} as Record<Kind, KeyMaterial>;
  const sources = {} as Record<Kind, KeySource>;

  for (const kind of KINDS) {
    const fromEnv = config.signingKeys[kind];
    if (fromEnv !== null) {
      material[kind] = keyMaterial(kind, importSigningKey(fromEnv));
      sources[kind] = 'env';
      continue;
    }
    const saved = stored[kind];
    if (saved !== undefined) {
      material[kind] = keyMaterial(kind, importSigningKey(saved));
      sources[kind] = 'dev-file';
      continue;
    }
    const pair = generateSigningKey();
    material[kind] = keyMaterial(kind, pair.privateKey);
    sources[kind] = options.persist === true ? 'dev-file' : 'ephemeral';
    stored[kind] = exportSigningKey(pair.privateKey);
    dirty = true;
  }

  if (dirty && options.persist === true) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  }
  return { ...material, sources };
}
