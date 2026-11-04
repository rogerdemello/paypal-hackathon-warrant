import { DEFAULT_SIM_PAYER, type SimPayer } from '@warrant/paypal';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Container } from '../container';
import { HttpError, parse } from '../http';
import { webhookHeadersFrom } from '../services/webhooks';

/** Routes anyone can call: the registry, the public verification report, the merchant API and PayPal's webhooks. */

export const OTHER_SIM_PAYER: SimPayer = { payerId: 'SIMPAYER0002', email: 'other-buyer@example.com', name: 'A Different Buyer' };

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (ch) => `&#${ch.codePointAt(0) ?? 63};`);

export function registerPublicRoutes(app: FastifyInstance, c: Container): void {
  app.get('/api/health', () => ({
    ok: true,
    mode: c.config.mode,
    paypal: c.paypal.env,
    database: c.db.dialect,
    models: c.llm === null ? 'fixtures' : 'live',
  }));

  /** What the web app needs to know about this deployment before it renders. */
  app.get('/api/config', () => ({
    mode: c.config.mode,
    paypalEnv: c.paypal.env,
    merchantName: c.config.merchantName,
    merchantId: c.config.paypal.merchantId,
    judgeMode: c.config.judgeModeEnabled,
    consoleTokenRequired: !c.config.judgeModeEnabled,
    publicBaseUrl: c.config.publicBaseUrl,
  }));

  // ---- registry -----------------------------------------------------------------------------------------------------

  app.get('/api/registry/jwks.json', async () => c.registry.jwks());

  app.get('/api/registry/log', async (request) => {
    const q = parse(z.object({ after: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(500).optional() }), request.query);
    return {
      head: await c.registry.head(),
      checkpoint: await c.registry.latestCheckpoint(),
      logKey: c.registry.logPublicKey(),
      entries: await c.registry.entries({ ...(q.after === undefined ? {} : { afterSeq: q.after }), ...(q.limit === undefined ? {} : { limit: q.limit }) }),
    };
  });

  app.get<{ Params: { cartJti: string } }>('/api/registry/log/proof/:cartJti', async (request) => {
    const proof = await c.registry.inclusionProof(request.params.cartJti);
    if (proof === null) throw new HttpError(404, 'that cart warrant is not in the transparency log', 'NOT_FOUND');
    return { proof, logKey: c.registry.logPublicKey() };
  });

  app.get('/api/registry/audit', async () => c.registry.audit());

  app.get<{ Params: { id: string } }>('/api/registry/platforms/:id', async (request) => {
    const platform = await c.registry.platform(request.params.id);
    if (platform === null) throw new HttpError(404, 'unknown platform', 'NOT_FOUND');
    const keys = (await c.registry.jwks()).keys.filter((k) => k['owner'] === platform.id);
    const orders = await c.db.query<{ n: number }>('SELECT count(*)::int AS n FROM warrants WHERE platform = $1', [platform.id]);
    const disputes = await c.db.query<{ decision: { attribution?: { agent_platform?: string } } }>(
      `SELECT f.decision FROM dispute_facts f JOIN disputes d ON d.paypal_dispute_id = f.dispute_id JOIN orders o ON o.id = d.order_id JOIN warrants w ON w.cart_jti = o.cart_jti
       WHERE w.platform = $1 AND f.id = (SELECT id FROM dispute_facts WHERE dispute_id = d.paypal_dispute_id ORDER BY computed_at DESC, id DESC LIMIT 1)`,
      [platform.id],
    );
    return {
      platform,
      keys,
      stats: { orders: orders[0]?.n ?? 0, disputes: disputes.length, agentFaultRulings: disputes.filter((d) => d.decision.attribution?.agent_platform === 'primary').length },
    };
  });

  // ---- public verification ------------------------------------------------------------------------------------------

  app.get<{ Params: { cartJti: string } }>('/api/verify/:cartJti', async (request, reply) => {
    const report = await c.verification.report(request.params.cartJti);
    return report.found ? report : reply.status(404).send(report);
  });

  // ---- merchant -----------------------------------------------------------------------------------------------------

  app.get('/api/merchant/catalog', async () => ({ products: await c.store.all(), mode: await c.store.merchantMode() }));

  /** Any agent platform can submit a warrant bundle here. The verdict and the findings come back either way. */
  app.post('/api/merchant/checkout', async (request, reply) => {
    const body = parse(z.object({ bundle: z.unknown().optional() }), request.body);
    const result = await c.merchant.checkout(body.bundle);
    return reply.status(result.status === 'rejected' ? 422 : 200).send(result);
  });

  app.get<{ Params: { id: string } }>('/api/merchant/orders/:id', async (request) => {
    const order = await c.merchant.order(request.params.id);
    if (order === null) throw new HttpError(404, 'unknown order', 'NOT_FOUND');
    return { order: { id: order.id, status: order.status, totalCents: order.totalCents, currency: order.currency, cartJti: order.cartJti, lines: order.lines, captureId: order.captureId, approvalUrl: order.status === 'created' ? order.approvalUrl : null, note: order.note, createdAt: order.createdAt } };
  });

  /** The buyer is back from PayPal. Idempotent; the approval webhook may have finished the order already. */
  app.post<{ Params: { id: string } }>('/api/merchant/orders/:id/complete', async (request) => {
    const done = await c.merchant.completeOrder(request.params.id);
    return { status: done.status, message: done.message, orderId: done.order.id, orderStatus: done.order.status, cartJti: done.order.cartJti };
  });

  app.post('/api/merchant/webhooks/paypal', async (request, reply) => {
    const headers = webhookHeadersFrom((name) => {
      const value = request.headers[name];
      return Array.isArray(value) ? value[0] : value;
    });
    if (headers === null || request.rawBody === undefined) throw new HttpError(400, 'missing PayPal signature headers or body', 'BAD_WEBHOOK');
    const outcome = await c.merchant.handleWebhook(headers, request.rawBody);
    if (outcome.status === 'unverified') return reply.status(401).send({ status: outcome.status });
    if (outcome.status === 'invalid') return reply.status(400).send({ status: outcome.status });
    return { status: outcome.status };
  });

  // ---- the PayPal simulator's approval page --------------------------------------------------------------------------

  if (c.paypal.simulator !== null) {
    const simulator = c.paypal.simulator;
    const payers: Record<string, SimPayer> = { default: DEFAULT_SIM_PAYER, other: OTHER_SIM_PAYER };

    app.get<{ Querystring: { token?: string } }>('/sim/paypal/approve', async (request, reply) => {
      const token = request.query.token ?? '';
      const order = await c.merchant.orderByPayPalOrderId(token);
      if (order === null) return reply.status(404).type('text/html').send('<!doctype html><title>Unknown order</title><p>Unknown order.');
      const lines = order.lines.map((l) => `<tr><td>${escapeHtml(l.title)}</td><td>${l.qty}</td><td>${(l.unitPriceCents / 100).toFixed(2)}</td></tr>`).join('');
      const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>PayPal sandbox simulator</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#f5f7fa;color:#1c2a39}main{max-width:480px;margin:40px auto;padding:0 16px}
.card{background:#fff;border:1px solid #d5dde6;border-radius:12px;padding:24px}h1{font-size:1.25rem;margin:0 0 4px}.tag{display:inline-block;background:#fff4d6;color:#7a5a00;border-radius:999px;padding:2px 10px;font-size:.8rem;margin-bottom:12px}
table{width:100%;border-collapse:collapse;margin:12px 0}td{padding:6px 0;border-bottom:1px solid #eef2f6}td:nth-child(2),td:nth-child(3){text-align:right}.total{font-weight:600;font-size:1.1rem;display:flex;justify-content:space-between;margin:12px 0 20px}
label{display:block;margin:6px 0}button{font:inherit;border-radius:8px;padding:10px 16px;border:1px solid #003087;cursor:pointer}.pay{background:#003087;color:#fff;width:100%}.cancel{background:#fff;color:#003087;width:100%;margin-top:8px}p.note{color:#586a7c;font-size:.85rem}</style></head>
<body><main><div class="card"><span class="tag">Sandbox simulator - not PayPal</span><h1>Pay ${escapeHtml(c.config.merchantName)}</h1>
<table><tbody>${lines}</tbody></table><div class="total"><span>Total</span><span>${(order.totalCents / 100).toFixed(2)} ${escapeHtml(order.currency)}</span></div>
<form method="post" action="/sim/paypal/approve"><input type="hidden" name="token" value="${escapeHtml(token)}">
<label><input type="radio" name="payer" value="default" checked> Pay as ${escapeHtml(DEFAULT_SIM_PAYER.name)}</label>
<label><input type="radio" name="payer" value="other"> Pay as ${escapeHtml(OTHER_SIM_PAYER.name)} (a different PayPal account, to see the payer check)</label>
<button class="pay" name="action" value="approve">Approve payment</button><button class="cancel" name="action" value="cancel">Cancel</button></form>
<p class="note">This page stands in for PayPal's approval screen when no PayPal sandbox credentials are configured.</p></div></main></body></html>`;
      return reply.type('text/html').send(page);
    });

    app.post('/sim/paypal/approve', async (request, reply) => {
      const form = parse(z.object({ token: z.string().min(1), payer: z.enum(['default', 'other']).default('default'), action: z.enum(['approve', 'cancel']).default('approve') }), request.body);
      const order = await c.merchant.orderByPayPalOrderId(form.token);
      if (order === null) throw new HttpError(404, 'unknown order', 'NOT_FOUND');
      if (form.action === 'approve') {
        simulator.approveOrder(form.token, payers[form.payer] ?? DEFAULT_SIM_PAYER);
        await simulator.flush();
        return reply.redirect(`${c.config.webOrigin}/checkout/return?order=${encodeURIComponent(order.id)}`, 303);
      }
      return reply.redirect(`${c.config.webOrigin}/checkout/cancel?order=${encodeURIComponent(order.id)}`, 303);
    });
  }
}
