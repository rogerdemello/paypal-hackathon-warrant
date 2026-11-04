import type { NumericDate } from './time';
import type { KeyObject } from 'node:crypto';

/**
 * The registry data the verifier and the facts engine need (docs/warrant-spec.md section 7). This package
 * does no I/O, so the caller supplies a synchronous lookup, typically over a snapshot it fetched from the
 * registry service (`/registry/jwks.json`).
 */

export type KeyKind = 'wallet' | 'agent';
export type KeyStatus = 'active' | 'suspended' | 'revoked';

export interface RegistryKey {
  /** Key id, as it appears in the JWS `kid` header. */
  readonly kid: string;
  readonly kind: KeyKind;
  /**
   * Who may sign with it. `agent` keys: the agent platform id (the `<platform>` in `agent:<platform>/<agent_id>`).
   * `wallet` keys: the wallet identifier exactly as it appears in a mandate's `iss` (for example `wallet:demo-wallet`).
   */
  readonly owner: string;
  readonly publicKey: KeyObject;
  /** Current status. */
  readonly status: KeyStatus;
  readonly validFrom: NumericDate;
  /** Null for no expiry. */
  readonly validTo: NumericDate | null;
  /** When the key left `active`. Null while active; when null on a non-active key, the key counts as never trusted. */
  readonly statusChangedAt: NumericDate | null;
}

export type RegistryLookup = (kid: string) => RegistryKey | null;

export type KeyState = KeyStatus | 'not_yet_valid' | 'expired';

/** The state of a key at instant `at`: what the registry's status history says about that moment. */
export function keyStateAt(key: RegistryKey, at: NumericDate): KeyState {
  if (!(at >= key.validFrom)) return 'not_yet_valid';
  if (key.validTo !== null && at > key.validTo) return 'expired';
  if (key.status !== 'active' && (key.statusChangedAt === null || at >= key.statusChangedAt)) return key.status;
  return 'active';
}

/** An in-memory registry, for tests and for servers that load a snapshot. */
export function staticRegistry(keys: Iterable<RegistryKey>): RegistryLookup {
  const byKid = new Map<string, RegistryKey>();
  for (const key of keys) {
    byKid.set(key.kid, key);
  }
  return (kid) => byKid.get(kid) ?? null;
}
