import { hashPayerId } from '@warrant/warrant';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Container } from '../container';
import { mandateDto, proposalDto } from '../dto';
import { HttpError, compact, parse, visitorIdOf } from '../http';
import { DEFAULT_SIM_PAYER } from '@warrant/paypal';

/** Routes for the person shopping: their wallet and their conversation with the shopping agent. */

const edits = z.object({
  maxTotalCents: z.number().int().positive().max(10_000_000).optional(),
  maxPerItemCents: z.number().int().positive().max(10_000_000).optional(),
  maxItems: z.number().int().min(1).max(100).optional(),
  categoriesAllow: z.array(z.string().min(1).max(64)).max(20).nullable().optional(),
  mode: z.enum(['human_present', 'human_not_present']).optional(),
  budgetMode: z.enum(['cumulative', 'per_cart']).optional(),
  validForSeconds: z.number().int().min(60).max(30 * 24 * 3600).optional(),
});

const message = z.object({ text: z.string().min(1).max(1000) });

export function registerShopperRoutes(app: FastifyInstance, c: Container): void {
  const principalOf = async (request: Parameters<typeof visitorIdOf>[0]) => c.wallet.ensurePrincipal(visitorIdOf(request));

  // ---- wallet -------------------------------------------------------------------------------------------------------

  app.get('/api/wallet/me', async (request) => {
    const principal = await principalOf(request);
    return { id: principal.id, displayName: principal.displayName, payerLinked: principal.payerIdHash !== null, canLinkSandboxBuyer: c.paypal.simulator !== null };
  });

  /**
   * Simulator only: link the simulated PayPal buyer to this wallet up front, as the first approved order otherwise would
   * (trust on first use). With real PayPal there is nothing to click: the first purchase links the account.
   */
  app.post('/api/wallet/link-paypal', async (request) => {
    const principal = await principalOf(request);
    if (c.paypal.simulator === null) throw new HttpError(409, 'with PayPal sandbox the first purchase links your account', 'NOT_AVAILABLE');
    const ok = await c.wallet.bindPayer(principal.id, hashPayerId(DEFAULT_SIM_PAYER.payerId));
    if (!ok) throw new HttpError(409, 'a different PayPal account is already linked to this wallet', 'PAYER_MISMATCH');
    return { payerLinked: true };
  });

  app.get('/api/wallet/mandates', async (request) => {
    const principal = await principalOf(request);
    return { mandates: (await c.wallet.mandatesOf(principal.id)).map(mandateDto) };
  });

  app.post<{ Params: { jti: string } }>('/api/wallet/mandates/:jti/revoke', async (request) => {
    const principal = await principalOf(request);
    return { mandate: mandateDto(await c.wallet.revokeMandate(principal.id, request.params.jti)) };
  });

  app.get<{ Querystring: { status?: string } }>('/api/wallet/proposals', async (request) => {
    const principal = await principalOf(request);
    const status = parse(z.object({ status: z.enum(['pending', 'approved', 'declined', 'expired']).optional() }), request.query).status;
    return { proposals: (await c.wallet.proposalsOf(principal.id, status)).map(proposalDto) };
  });

  app.get<{ Params: { id: string } }>('/api/wallet/proposals/:id', async (request) => {
    const principal = await principalOf(request);
    const proposal = await c.wallet.proposal(request.params.id);
    if (proposal === null) throw new HttpError(404, 'unknown cart', 'NOT_FOUND');
    const mandate = await c.wallet.mandate(proposal.mandateJti);
    if (mandate?.principalId !== principal.id) throw new HttpError(403, 'this cart belongs to someone else', 'FORBIDDEN');
    return { proposal: proposalDto(proposal) };
  });

  /** The approval click: the wallet signs the consent over what it showed. */
  app.post<{ Params: { id: string } }>('/api/wallet/proposals/:id/approve', async (request) => {
    const principal = await principalOf(request);
    const { proposal } = await c.wallet.approve(principal.id, request.params.id);
    return { proposal: proposalDto(proposal) };
  });

  app.post<{ Params: { id: string } }>('/api/wallet/proposals/:id/decline', async (request) => {
    const principal = await principalOf(request);
    return { proposal: proposalDto(await c.wallet.decline(principal.id, request.params.id)) };
  });

  // ---- shopping agent -----------------------------------------------------------------------------------------------

  app.post('/api/agent/sessions', async (request, reply) => {
    const principal = await principalOf(request);
    return reply.status(201).send({ session: await c.shopper.startSession(principal.id) });
  });

  app.get('/api/agent/sessions/latest', async (request) => {
    const principal = await principalOf(request);
    return { session: await c.shopper.latestSession(principal.id) };
  });

  app.get<{ Params: { id: string } }>('/api/agent/sessions/:id', async (request) => {
    const principal = await principalOf(request);
    return { session: await c.shopper.getSession(request.params.id, principal.id) };
  });

  app.post<{ Params: { id: string } }>('/api/agent/sessions/:id/messages', async (request) => {
    const visitor = visitorIdOf(request);
    const principal = await c.wallet.ensurePrincipal(visitor);
    const { text } = parse(message, request.body);
    return { session: await c.shopper.sendMessage(request.params.id, principal.id, text, visitor) };
  });

  app.post<{ Params: { id: string } }>('/api/agent/sessions/:id/authorize', async (request) => {
    const visitor = visitorIdOf(request);
    const principal = await c.wallet.ensurePrincipal(visitor);
    const parsed = parse(z.object({ edits: edits.optional() }), request.body);
    return { session: await c.shopper.authorizeMandate(request.params.id, principal.id, compact(parsed.edits ?? {}), visitor) };
  });

  app.post<{ Params: { id: string } }>('/api/agent/sessions/:id/checkout', async (request) => {
    const principal = await principalOf(request);
    return { session: await c.shopper.checkout(request.params.id, principal.id) };
  });

  app.post<{ Params: { id: string } }>('/api/agent/sessions/:id/complete', async (request) => {
    const principal = await principalOf(request);
    return { session: await c.shopper.completeOrder(request.params.id, principal.id) };
  });

  app.post<{ Params: { id: string } }>('/api/agent/sessions/:id/decline', async (request) => {
    const principal = await principalOf(request);
    return { session: await c.shopper.declineCart(request.params.id, principal.id) };
  });
}
