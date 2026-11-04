import { agentIssuer, merchantAudience } from '@warrant/warrant';

/**
 * Names of the parties the demo deployment plays. In production these are three companies; here they are one service
 * with separate keys, so every signature says which party made it.
 */

export const WALLET_ID = 'warrant-wallet';
/** `iss` of every mandate the wallet signs, and the `owner` of the wallet's registry key. */
export const WALLET_ISS = `wallet:${WALLET_ID}`;

export const AGENT_PLATFORM_ID = 'warrant-agents';
export const AGENT_PLATFORM_NAME = 'Warrant Demo Agents';
export const AGENT_ID = 'shopper-1';
/** `iss` of every cart warrant the agent platform signs. */
export const AGENT_ISS = agentIssuer(AGENT_PLATFORM_ID, AGENT_ID);

export { agentIssuer, merchantAudience };
