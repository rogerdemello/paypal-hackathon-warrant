import { nowSeconds, type Clock } from '../clock';
import { AGENT_PLATFORM_ID, AGENT_PLATFORM_NAME, WALLET_ISS } from '../identity';
import type { ServerKeys } from '../keys';
import type { RegistryService } from './registry';

/**
 * Put the demo parties in the registry: the wallet key and the agent platform key. Safe to run on every start: a key that
 * is already registered is left alone. A fresh key (new deployment, rotated key) is registered as a new entry, and the old
 * one stays in the registry and in the transparency log.
 */
export async function registerIdentities(registry: RegistryService, keys: ServerKeys, clock: Clock): Promise<void> {
  // Keys are valid from a minute before registration so a signature made at start-up is never "from before the key existed".
  const validFrom = nowSeconds(clock) - 60;
  await registry.ensurePlatform({ id: AGENT_PLATFORM_ID, name: AGENT_PLATFORM_NAME });
  await registry.registerKey({ kid: keys.wallet.kid, kind: 'wallet', owner: WALLET_ISS, publicKeyBase64: keys.wallet.publicKeyBase64, validFrom });
  await registry.registerKey({ kid: keys.agent.kid, kind: 'agent', owner: AGENT_PLATFORM_ID, platformId: AGENT_PLATFORM_ID, publicKeyBase64: keys.agent.publicKeyBase64, validFrom });
}
