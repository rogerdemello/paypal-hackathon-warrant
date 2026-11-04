import type { MandateRecord, Proposal } from './services/wallet';
import type { ProposalDto } from './api-types';
import type { MandateDto } from './api-types-console';

/** Wire shapes for wallet records. */

export const mandateDto = (m: MandateRecord): MandateDto => ({
  jti: m.jti,
  hash: m.hash,
  status: m.status,
  instruction: m.instructionText,
  validFrom: m.nbf,
  validUntil: m.exp,
  createdAt: m.createdAt,
  revokedAt: m.revokedAt,
  scope: {
    currency: m.payload.scope.currency,
    maxTotal: m.payload.scope.max_total,
    maxPerItem: m.payload.scope.max_per_item,
    maxItems: m.payload.scope.max_items,
    categoriesAllow: m.payload.scope.categories_allow,
    mode: m.payload.scope.mode,
    budgetMode: m.payload.scope.budget_mode,
  },
  agent: `${m.payload.agent.platform}/${m.payload.agent.agent_id}`,
  jws: m.jws,
});

export const proposalDto = (p: Proposal): ProposalDto => ({
  id: p.id,
  mandateJti: p.mandateJti,
  cartJti: p.cartJti,
  status: p.status,
  presented: p.presented,
  presentedHash: p.presentedHash,
  cartHash: p.cartHash,
  expiresAt: p.expiresAt,
  createdAt: p.createdAt,
});
