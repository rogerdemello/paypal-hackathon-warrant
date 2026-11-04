import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Container } from '../container';
import { HttpError, parse } from '../http';
import { ScenarioRunner, needsSimulator } from '../lab/runner';
import { FAMILY_TITLES, SCENARIO_FAMILIES, type Scenario } from '../lab/scenario';
import { SCENARIOS, scenarioById } from '../lab/scenarios';
import { consoleGuard } from './console';

/** The Dispute Lab: run labelled scenarios through the real system, or raise a dispute on any paid order. */

const scenarioDto = (s: Scenario, simulatorAvailable: boolean) => ({
  id: s.id,
  family: s.family,
  familyTitle: FAMILY_TITLES[s.family],
  title: s.title,
  story: s.story,
  merchantMode: s.setup.merchantMode ?? 'STRICT',
  attack: s.setup.attack?.type ?? null,
  dispute: s.setup.dispute === undefined ? null : { reason: s.setup.dispute.reason, message: s.setup.dispute.message },
  expect: s.expect,
  runnable: !needsSimulator(s) || simulatorAvailable,
});

export function registerLabRoutes(root: FastifyInstance, c: Container): void {
  const runner = new ScenarioRunner(c);

  root.register((app, _options, done) => {
    app.addHook('onRequest', consoleGuard(c));

    app.get('/api/lab/scenarios', () => ({
      families: SCENARIO_FAMILIES.map((id) => ({ id, title: FAMILY_TITLES[id], count: SCENARIOS.filter((s) => s.family === id).length })),
      simulator: c.paypal.simulator !== null,
      scenarios: SCENARIOS.map((s) => scenarioDto(s, c.paypal.simulator !== null)),
    }));

    app.post<{ Params: { id: string } }>('/api/lab/scenarios/:id/run', async (request) => {
      const scenario = scenarioById(request.params.id);
      if (scenario === undefined) throw new HttpError(404, 'unknown scenario', 'NOT_FOUND');
      return { result: await runner.run(scenario) };
    });

    /** Raise a dispute on a paid order, as the buyer would from PayPal's Resolution Center. */
    app.post<{ Params: { id: string } }>('/api/lab/orders/:id/dispute', async (request) => {
      const input = parse(
        z.object({
          reason: z.enum(['MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', 'UNAUTHORISED', 'INCORRECT_AMOUNT', 'DUPLICATE_TRANSACTION', 'OTHER']),
          message: z.string().min(1).max(1500),
          dueInHours: z.number().min(0.5).max(720).optional(),
          amountCents: z.number().int().positive().optional(),
        }),
        request.body,
      );
      const order = await c.merchant.order(request.params.id);
      if (order === null) throw new HttpError(404, 'unknown order', 'NOT_FOUND');
      if (order.status !== 'captured' || order.captureId === null) throw new HttpError(409, 'only a paid order can be disputed', 'CONFLICT');
      const amountCents = input.amountCents ?? order.totalCents;
      if (c.paypal.simulator !== null) {
        const opened = c.paypal.simulator.openDispute({
          captureId: order.captureId,
          reason: input.reason,
          message: input.message,
          amountCents,
          ...(input.dueInHours === undefined ? {} : { responseDueInSeconds: Math.round(input.dueInHours * 3600) }),
        });
        await c.paypal.simulator.flush();
        return { disputeId: opened.disputeId, via: 'simulator' };
      }
      const created = await c.paypal.client.sandboxCreateDispute({ sellerTransactionId: order.captureId, reason: input.reason, currency: order.currency, amountCents, message: input.message }, `${order.id}:lab-dispute:${c.ids.token(4)}`);
      await c.disputes.ingest(created.id);
      return { disputeId: created.id, via: 'sandbox' };
    });

    /** Play PayPal's dispute desk: decide a dispute that is under review. */
    app.post<{ Params: { id: string } }>('/api/lab/disputes/:id/adjudicate', async (request) => {
      const { outcome } = parse(z.object({ outcome: z.enum(['BUYER_FAVOR', 'SELLER_FAVOR']) }), request.body);
      await c.paypal.client.sandboxAdjudicate(request.params.id, outcome, `${request.params.id}:adjudicate:${c.ids.token(4)}`);
      await c.paypal.simulator?.flush();
      return { detail: await c.disputes.ingest(request.params.id) };
    });

    /** Play the buyer: accept the merchant's offer (simulator only). */
    app.post<{ Params: { id: string } }>('/api/lab/disputes/:id/buyer-accepts', async (request) => {
      if (c.paypal.simulator === null) throw new HttpError(409, 'only the simulator can play the buyer', 'NOT_AVAILABLE');
      c.paypal.simulator.buyerAcceptsOffer(request.params.id);
      await c.paypal.simulator.flush();
      return { detail: await c.disputes.ingest(request.params.id) };
    });

    done();
  });
}

