import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { ManualClock, sequentialIds } from '../src/clock';
import { createContainer, type Container } from '../src/container';
import { prepareBundle } from './shop';
import { resetDb, sharedDb, T0_MS, testConfig } from './helpers';

let c: Container;
let app: FastifyInstance;
const visitor = { 'x-visitor-id': 'visitor-api-0001' };

async function boot(env: Record<string, string> = {}, webDist: string | null = null) {
  const db = await sharedDb();
  await resetDb(db);
  c = await createContainer(testConfig(env), { db, clock: new ManualClock(T0_MS), ids: sequentialIds() });
  app = await buildApp(c, { webDist, logger: false });
}

beforeEach(async () => {
  await boot();
});
afterEach(async () => {
  await app.close();
  await c.close();
});

async function call<T = Record<string, any>>(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, options: { body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await app.inject({ method, url, ...(options.body === undefined ? {} : { payload: options.body as object }), headers: options.headers ?? {} });
  let json: T | null;
  try {
    json = res.json<T>();
  } catch {
    json = null;
  }
  return { status: res.statusCode, json: json as T, text: res.body, headers: res.headers, raw: res.rawPayload };
}

describe('public endpoints', () => {
  it('reports health and the deployment config', async () => {
    expect((await call('GET', '/api/health')).json).toMatchObject({ ok: true, mode: 'fixtures', paypal: 'simulator', database: 'pglite', models: 'fixtures' });
    expect((await call('GET', '/api/config')).json).toMatchObject({ paypalEnv: 'simulator', judgeMode: true, consoleTokenRequired: false, merchantId: 'SIMMERCHANT01' });
  });

  it('serves the registry: keys, log, audit', async () => {
    const jwks = (await call('GET', '/api/registry/jwks.json')).json;
    expect(jwks.keys.map((k: { kind: string }) => k.kind).sort()).toEqual(['agent', 'wallet']);
    expect(JSON.stringify(jwks)).not.toContain('"d"');
    const log = (await call('GET', '/api/registry/log')).json;
    expect(log.entries.map((e: { type: string }) => e.type)).toEqual(['key_registered', 'key_registered']);
    expect(log.logKey.publicKey).toMatch(/^[A-Za-z0-9+/=]{60}$/);
    expect((await call('GET', '/api/registry/log?after=1&limit=5')).json.entries).toHaveLength(1);
    expect((await call('GET', '/api/registry/audit')).json).toMatchObject({ ok: true });
    expect((await call('GET', '/api/registry/log?limit=0')).status).toBe(400);
    expect((await call('GET', '/api/registry/platforms/warrant-agents')).json).toMatchObject({ platform: { id: 'warrant-agents' }, stats: { orders: 0 } });
    expect((await call('GET', '/api/registry/platforms/nope')).status).toBe(404);
    expect((await call('GET', '/api/registry/log/proof/crt_none')).status).toBe(404);
  });

  it('lists the merchant catalog', async () => {
    const { json } = await call('GET', '/api/merchant/catalog');
    expect(json.mode).toBe('STRICT');
    expect(json.products.length).toBeGreaterThan(20);
  });

  it('answers unknown routes with a JSON 404, not a page', async () => {
    const res = await call('GET', '/api/nope');
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: { code: 'NOT_FOUND', message: 'no such route' } });
  });
});

describe('shopping over HTTP', () => {
  it('runs a whole purchase and then publishes a verification report', async () => {
    // Identity and the first message.
    expect((await call('GET', '/api/wallet/me')).status).toBe(401);
    const me = (await call('GET', '/api/wallet/me', { headers: visitor })).json;
    expect(me).toMatchObject({ payerLinked: false, canLinkSandboxBuyer: true });
    expect((await call('POST', '/api/wallet/link-paypal', { headers: visitor })).json).toEqual({ payerLinked: true });

    const started = (await call('POST', '/api/agent/sessions', { headers: visitor })).json.session;
    const sid = started.id as string;
    expect((await call('GET', '/api/agent/sessions/latest', { headers: visitor })).json.session.id).toBe(sid);

    const asked = (await call('POST', `/api/agent/sessions/${sid}/messages`, { headers: visitor, body: { text: 'a standing desk converter under $120' } })).json.session;
    expect(asked.stage).toBe('awaiting_mandate');

    const authorised = (await call('POST', `/api/agent/sessions/${sid}/authorize`, { headers: visitor, body: { edits: { validForSeconds: 7_200 } } })).json.session;
    expect(authorised.stage).toBe('awaiting_consent');
    const proposalId = authorised.messages.flatMap((m: { parts: Array<{ kind: string; proposalId?: string }> }) => m.parts).find((p: { kind: string }) => p.kind === 'cart_proposal').proposalId as string;

    // The wallet's consent screen is what the human approves.
    const shown = (await call('GET', `/api/wallet/proposals/${proposalId}`, { headers: visitor })).json.proposal;
    expect(shown).toMatchObject({ status: 'pending', presented: { screen: 'warrant.consent.v1', total: '89.00' } });
    expect((await call('GET', `/api/wallet/proposals/${proposalId}`, { headers: { 'x-visitor-id': 'visitor-someone-else' } })).status).toBe(403);
    expect((await call('POST', `/api/agent/sessions/${sid}/checkout`, { headers: visitor })).status).toBe(409);
    expect((await call('POST', `/api/wallet/proposals/${proposalId}/approve`, { headers: visitor })).json.proposal.status).toBe('approved');

    const checkedOut = (await call('POST', `/api/agent/sessions/${sid}/checkout`, { headers: visitor })).json.session;
    const checkout = checkedOut.messages.flatMap((m: { parts: Array<Record<string, any>> }) => m.parts).find((p: { kind: string }) => p.kind === 'checkout');
    expect(checkout.status).toBe('approval_required');

    // The simulator's approval page, then back to the app.
    const token = new URL(checkout.approvalUrl).searchParams.get('token')!;
    const page = await call('GET', `/sim/paypal/approve?token=${token}`);
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.text).toContain('Sandbox simulator - not PayPal');
    expect(page.text).toContain('FlexiRise Standing Desk Converter 32in');
    const approve = await app.inject({ method: 'POST', url: '/sim/paypal/approve', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `token=${token}&payer=default&action=approve` });
    expect(approve.statusCode).toBe(303);
    expect(approve.headers.location).toBe(`http://localhost:5173/checkout/return?order=${checkout.orderId as string}`);

    const completed = (await call('POST', `/api/agent/sessions/${sid}/complete`, { headers: visitor })).json.session;
    expect(completed.stage).toBe('done');
    const order = completed.messages.flatMap((m: { parts: Array<Record<string, any>> }) => m.parts).find((p: { kind: string }) => p.kind === 'order');
    expect(order).toMatchObject({ status: 'captured', totalCents: 8_900 });

    const status = (await call('GET', `/api/merchant/orders/${checkout.orderId as string}`)).json.order;
    expect(status).toMatchObject({ status: 'captured', approvalUrl: null });
    expect((await call('POST', `/api/merchant/orders/${checkout.orderId as string}/complete`)).json).toMatchObject({ status: 'captured' });

    // Anyone can verify it.
    const report = await call('GET', `/api/verify/${order.cartJti as string}`);
    expect(report.status).toBe(200);
    expect(report.json).toMatchObject({
      found: true,
      mandate: { instruction: 'a standing desk converter under $120', payerLinked: true },
      cart: { total: '89.00', consent: { mode: 'human_present' } },
      transparency: { included: true, proofValid: true },
    });
    expect(report.json.signers.map((s: { subject: string; ok: boolean; keyStatus: string }) => [s.subject, s.ok, s.keyStatus])).toEqual([['cart', true, 'active'], ['mandate', true, 'active'], ['consent', true, 'active']]);
    expect(report.json.facts.filter((f: { id: string; value: boolean }) => ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8'].includes(f.id)).every((f: { value: boolean }) => f.value)).toBe(true);
    const proof = (await call('GET', `/api/registry/log/proof/${order.cartJti as string}`)).json;
    expect(proof.proof.entry.type).toBe('warrant_logged');
    expect((await call('GET', '/api/verify/crt_unknown')).status).toBe(404);

    // The wallet lists what it signed, and the human can revoke it.
    const mandates = (await call('GET', '/api/wallet/mandates', { headers: visitor })).json.mandates;
    expect(mandates).toHaveLength(1);
    expect(mandates[0]).toMatchObject({ status: 'active', scope: { maxTotal: '120.00', categoriesAllow: expect.arrayContaining(['office_furniture']) as string[] } });
    expect((await call('POST', `/api/wallet/mandates/${mandates[0].jti as string}/revoke`, { headers: visitor })).json.mandate.status).toBe('revoked');
    expect((await call('GET', '/api/wallet/proposals?status=approved', { headers: visitor })).json.proposals).toHaveLength(1);
    expect((await call('GET', '/api/wallet/proposals?status=bogus', { headers: visitor })).status).toBe(400);
  });

  it('turns bad input into clear errors', async () => {
    const started = (await call('POST', '/api/agent/sessions', { headers: visitor })).json.session;
    const bad = await call('POST', `/api/agent/sessions/${started.id as string}/messages`, { headers: visitor, body: { text: '' } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('INVALID_REQUEST');
    const broken = await app.inject({ method: 'POST', url: `/api/agent/sessions/${started.id as string}/messages`, headers: { ...visitor, 'content-type': 'application/json' }, payload: '{nope' });
    expect(broken.statusCode).toBe(400);
    expect(broken.json().error.code).toBe('INVALID_JSON');
    expect((await call('GET', '/api/agent/sessions/ses_none', { headers: visitor })).status).toBe(404);
    const strangers = await call('GET', `/api/agent/sessions/${started.id as string}`, { headers: { 'x-visitor-id': 'visitor-stranger-1' } });
    expect(strangers.status).toBe(403);
    const risky = await call('POST', `/api/agent/sessions/${started.id as string}/authorize`, { headers: visitor, body: { edits: { maxItems: 0 } } });
    expect([400, 409]).toContain(risky.status);
  });
});

describe('the merchant API for any agent platform', () => {
  it('accepts a good bundle, rejects a replay with 422, and shows the findings both times', async () => {
    const purchase = await prepareBundle({ wallet: c.wallet, agent: c.platform, ids: c.ids, keys: c.keys });
    const first = await call('POST', '/api/merchant/checkout', { body: { bundle: purchase.bundle } });
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ status: 'approval_required', outcome: 'ACCEPT' });
    const replay = await call('POST', '/api/merchant/checkout', { body: { bundle: purchase.bundle } });
    expect(replay.status).toBe(422);
    expect(replay.json.findings.filter((f: { outcome: string }) => f.outcome === 'reject').map((f: { rule: string }) => f.rule)).toEqual(['V05_NONCE', 'V05_NONCE']);
    expect((await call('POST', '/api/merchant/checkout', { body: { bundle: { nonsense: true } } })).status).toBe(422);
    expect((await call('POST', '/api/merchant/checkout', { body: {} })).status).toBe(422);
  });

  it('verifies webhook signatures and refuses forgeries', async () => {
    const headers = { 'content-type': 'application/json', 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://example.invalid/c.pem', 'paypal-transmission-id': 't1', 'paypal-transmission-sig': 'AAAA', 'paypal-transmission-time': '2026-06-01T12:00:00Z' };
    const event = JSON.stringify({ id: 'WH-1', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: 'X' } });
    expect((await app.inject({ method: 'POST', url: '/api/merchant/webhooks/paypal', headers, payload: event })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/merchant/webhooks/paypal', headers: { 'content-type': 'application/json' }, payload: event })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/merchant/webhooks/paypal', headers, payload: '{"x":1}' })).statusCode).toBe(400);
  });

  it('accepts a genuine signed delivery from the simulator over HTTP', async () => {
    const purchase = await prepareBundle({ wallet: c.wallet, agent: c.platform, ids: c.ids, keys: c.keys });
    const result = await c.merchant.checkout(purchase.bundle);
    const order = (await c.merchant.order(result.orderId!))!;
    c.paypal.simulator!.setWebhookSink(null);
    c.paypal.simulator!.approveOrder(order.paypalOrderId!);
    const delivery = c.paypal.simulator!.deliveries.at(-1)!;
    const res = await app.inject({ method: 'POST', url: '/api/merchant/webhooks/paypal', headers: { ...delivery.headers, 'content-type': 'application/json' }, payload: delivery.body });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'processed' });
    expect((await c.merchant.order(order.id))?.status).toBe('captured');
    const again = await app.inject({ method: 'POST', url: '/api/merchant/webhooks/paypal', headers: { ...delivery.headers, 'content-type': 'application/json' }, payload: delivery.body });
    expect(again.json()).toEqual({ status: 'duplicate' });
  });
});

describe('the merchant console', () => {
  it('shows an overview, orders and rejected checkouts', async () => {
    const good = await prepareBundle({ wallet: c.wallet, agent: c.platform, ids: c.ids, keys: c.keys });
    await c.merchant.checkout(good.bundle);
    await c.merchant.checkout(good.bundle);
    const overview = (await call('GET', '/api/console/overview')).json;
    expect(overview).toMatchObject({ merchantMode: 'STRICT', autopilot: false, orders: { total: 1, byStatus: { created: 1 } }, attempts: { total: 2, accepted: 1, rejected: 1 } });
    expect(overview.keys).toHaveLength(2);
    const orders = (await call('GET', '/api/console/orders')).json.orders;
    expect(orders[0]).toMatchObject({ status: 'created', items: '1 x FlexiRise Standing Desk Converter 32in', verification: 'ACCEPT', rejectedRules: [] });
    expect((await call('GET', '/api/console/orders?status=captured')).json.orders).toEqual([]);
    const attempts = (await call('GET', '/api/console/attempts')).json.attempts;
    expect(attempts[0]).toMatchObject({ outcome: 'REJECT', failedRules: ['V05_NONCE'] });
    expect(attempts[0].reasons[0]).toMatch(/already been seen/);
    const detail = (await call('GET', `/api/console/orders/${orders[0].id as string}`)).json;
    expect(detail.ledger.verification).toMatchObject({ ok: true });
    expect((await call('GET', '/api/console/orders/ord_none')).status).toBe(404);
  });

  it('runs fulfilment, refunds and review decisions', async () => {
    const purchase = await prepareBundle({ wallet: c.wallet, agent: c.platform, ids: c.ids, keys: c.keys });
    const result = await c.merchant.checkout(purchase.bundle);
    const order = (await c.merchant.order(result.orderId!))!;
    c.paypal.simulator!.approveOrder(order.paypalOrderId!);
    await c.paypal.simulator!.flush();
    const id = order.id;
    expect((await call('POST', `/api/console/orders/${id}/ship`, { body: { carrier: 'UPS' } })).status).toBe(400);
    const shipped = (await call('POST', `/api/console/orders/${id}/ship`, { body: { carrier: 'UPS', trackingNumber: '1Z999' } })).json;
    expect(shipped.tracking).toMatchObject({ status: 'shipped' });
    expect((await call('POST', `/api/console/orders/${id}/deliver`)).json.tracking.status).toBe('delivered');
    expect((await call('POST', `/api/console/orders/${id}/refund`, { body: { amountCents: 500 } })).json.refund.amountCents).toBe(500);
    expect((await call('POST', `/api/console/orders/${id}/review`, { body: { decision: 'approve' } })).status).toBe(409);
    expect((await call('POST', `/api/console/orders/${id}/review`, { body: { decision: 'maybe' } })).status).toBe(400);
    const ledger = (await call('GET', `/api/console/ledger/order:${id}`)).json;
    expect(ledger.entries.map((e: { type: string }) => e.type)).toEqual(['order_received', 'paypal_order_created', 'order_captured', 'order_shipped', 'order_delivered', 'order_refunded']);
    expect(ledger.verification.ok).toBe(true);
    expect((await call('GET', '/api/console/ledger/registry')).status).toBe(400);
  });

  it('edits the catalog and the settings, and the verifier notices', async () => {
    const purchase = await prepareBundle({ wallet: c.wallet, agent: c.platform, ids: c.ids, keys: c.keys });
    const patched = await call('PATCH', '/api/console/products/fx_desk_conv_32', { body: { priceCents: 9_500 } });
    expect(patched.json.product.priceCents).toBe(9_500);
    expect((await call('PATCH', '/api/console/products/nope', { body: { priceCents: 100 } })).status).toBe(400);
    expect((await call('PATCH', '/api/console/products/fx_desk_conv_32', { body: { priceCents: -1 } })).status).toBe(400);
    const rejected = await call('POST', '/api/merchant/checkout', { body: { bundle: purchase.bundle } });
    expect(rejected.status).toBe(422);
    expect(rejected.json.findings.some((f: { rule: string; outcome: string }) => f.rule === 'V08_REPRICE' && f.outcome === 'reject')).toBe(true);
    expect((await call('PUT', '/api/console/settings', { body: { merchantMode: 'PERMISSIVE', disputeAutopilot: true } })).json).toEqual({ merchantMode: 'PERMISSIVE', disputeAutopilot: true });
    expect((await call('GET', '/api/console/settings')).json).toEqual({ merchantMode: 'PERMISSIVE', disputeAutopilot: true });
    expect((await call('PUT', '/api/console/settings', { body: { merchantMode: 'LAX' } })).status).toBe(400);
  });

  it('revokes a key and the registry, the verifier and the log all agree', async () => {
    const purchase = await prepareBundle({ wallet: c.wallet, agent: c.platform, ids: c.ids, keys: c.keys });
    const revoked = await call('POST', `/api/console/keys/${c.keys.agent.kid}/status`, { body: { status: 'revoked' } });
    expect(revoked.json.keys.find((k: { kid: string }) => k.kid === c.keys.agent.kid).status).toBe('revoked');
    expect((await call('POST', '/api/merchant/checkout', { body: { bundle: purchase.bundle } })).status).toBe(422);
    expect((await call('POST', '/api/console/keys/nope/status', { body: { status: 'revoked' } })).status).toBe(404);
    const log = (await call('GET', '/api/registry/log')).json;
    expect(log.entries.at(-1)).toMatchObject({ type: 'key_status_changed', payload: { to: 'revoked' } });
    const checkpoint = (await call('POST', '/api/console/registry/checkpoint')).json;
    expect(checkpoint.audit.ok).toBe(true);
    expect(checkpoint.checkpoint.seq).toBe(3);
  });

  it('works a dispute from the webhook to the PayPal call', async () => {
    await call('POST', '/api/wallet/link-paypal', { headers: visitor });
    const principal = await c.wallet.ensurePrincipal(visitor['x-visitor-id']);
    const purchase = await prepareBundle({ wallet: c.wallet, agent: c.platform, ids: c.ids, keys: c.keys }, { principal });
    const result = await c.merchant.checkout(purchase.bundle);
    const order = (await c.merchant.order(result.orderId!))!;
    c.paypal.simulator!.approveOrder(order.paypalOrderId!);
    await c.paypal.simulator!.flush();
    await c.merchant.ship(order.id, { carrier: 'UPS', trackingNumber: '1Z999' });
    await c.merchant.deliver(order.id);
    const done = (await c.merchant.order(order.id))!;
    const opened = c.paypal.simulator!.openDispute({ captureId: done.captureId!, reason: 'UNAUTHORISED', message: 'not me' });
    await c.paypal.simulator!.flush();

    const list = (await call('GET', '/api/console/disputes?state=awaiting_approval')).json.disputes;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: opened.disputeId, outcome: 'FIGHT', action: 'provide-evidence', actionStatus: 'proposed', claim: 'UNAUTHORIZED' });
    expect(list[0].hoursLeft).toBeGreaterThan(24);

    const detail = (await call('GET', `/api/console/disputes/${opened.disputeId}`)).json;
    expect(detail.analysis.decision.rule).toBe('UNAUTHORIZED_1_AUTHORISATION_CONFIRMED');
    expect(detail.verifyUrl).toContain('/v/');
    expect(detail.ledger.verification.ok).toBe(true);

    const pdf = await call('GET', `/api/console/disputes/${opened.disputeId}/packet`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toContain('warrant-evidence-');
    expect(pdf.text.startsWith('%PDF-')).toBe(true);

    const approved = (await call('POST', `/api/console/actions/${list[0].actionId as string}/approve`)).json.action;
    expect(approved).toMatchObject({ status: 'executed', approvedBy: 'console' });
    expect((await call('POST', `/api/console/actions/${list[0].actionId as string}/approve`)).status).toBe(409);
    expect((await call('POST', `/api/console/disputes/${opened.disputeId}/refresh`)).json.detail.dispute.state).toBe('responded');
    expect((await call('GET', '/api/console/disputes/PP-D-000000')).status).toBe(404);
    expect((await call('GET', '/api/console/disputes/PP-D-000000/packet')).status).toBe(404);

    const reanalysed = (await call('POST', `/api/console/disputes/${opened.disputeId}/analyze`)).json;
    expect(reanalysed.action.status).toBe('proposed');
    expect((await call('POST', `/api/console/actions/${reanalysed.action.id as string}/reject`)).json.action.status).toBe('rejected');

    // The public verification page links the dispute.
    const report = (await call('GET', `/api/verify/${purchase.proposal.cartJti}`)).json;
    expect(report.dispute).toMatchObject({ id: opened.disputeId });
  });
});

describe('access control', () => {
  it('with judge mode off, the console and Lab need the token', async () => {
    await app.close();
    await c.close();
    await boot({ JUDGE_MODE_ENABLED: 'false', CONSOLE_TOKEN: 'let-me-in-please' });
    expect((await call('GET', '/api/console/overview')).status).toBe(401);
    expect((await call('GET', '/api/console/overview', { headers: { 'x-console-token': 'wrong-token-value' } })).status).toBe(401);
    expect((await call('GET', '/api/console/overview', { headers: { 'x-console-token': 'let-me-in-please' } })).status).toBe(200);
    expect((await call('GET', '/api/config')).json).toMatchObject({ judgeMode: false, consoleTokenRequired: true });
    // Shopper and public routes are unaffected.
    expect((await call('GET', '/api/health')).status).toBe(200);
  });
});

describe('serving the web app', () => {
  it('serves the built app and falls back to it for client-side routes, but never for the API', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warrant-web-'));
    try {
      writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Warrant</title><div id="root"></div>');
      writeFileSync(join(dir, 'app.js'), 'console.log(1)');
      await app.close();
      await c.close();
      await boot({}, dir);
      expect((await call('GET', '/')).text).toContain('<div id="root">');
      expect((await call('GET', '/v/crt_whatever')).text).toContain('<div id="root">');
      expect((await call('GET', '/app.js')).text).toBe('console.log(1)');
      expect((await call('GET', '/api/missing')).status).toBe(404);
      expect((await call('GET', '/api/missing')).json.error.code).toBe('NOT_FOUND');
      expect((await call('GET', '/api/health')).json.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the dispute lab', () => {
  it('lists the scenario corpus by family and runs one', async () => {
    const list = (await call('GET', '/api/lab/scenarios')).json;
    expect(list.families).toHaveLength(12);
    expect(list.scenarios.length).toBeGreaterThanOrEqual(60);
    expect(list.simulator).toBe(true);
    expect(list.scenarios.every((s: { runnable: boolean }) => s.runnable)).toBe(true);
    const run = await call('POST', '/api/lab/scenarios/remorse-01/run');
    expect(run.status).toBe(200);
    expect(run.json.result).toMatchObject({ id: 'remorse-01', passed: true, failures: [], actual: { outcome: 'FIGHT', rule: 'UNAUTHORIZED_1_AUTHORISATION_CONFIRMED' } });
    expect(run.json.result.steps.length).toBeGreaterThan(4);
    expect((await call('POST', '/api/lab/scenarios/nope/run')).status).toBe(404);
  });

  it('raises a dispute on a paid order and plays PayPal and the buyer', async () => {
    const purchase = await prepareBundle({ wallet: c.wallet, agent: c.platform, ids: c.ids, keys: c.keys });
    const result = await c.merchant.checkout(purchase.bundle);
    const order = (await c.merchant.order(result.orderId!))!;
    expect((await call('POST', `/api/lab/orders/${order.id}/dispute`, { body: { reason: 'OTHER', message: 'x' } })).status).toBe(409);
    c.paypal.simulator!.approveOrder(order.paypalOrderId!);
    await c.paypal.simulator!.flush();

    expect((await call('POST', `/api/lab/orders/${order.id}/dispute`, { body: { reason: 'BOGUS', message: 'x' } })).status).toBe(400);
    expect((await call('POST', '/api/lab/orders/ord_none/dispute', { body: { reason: 'OTHER', message: 'x' } })).status).toBe(404);
    const opened = (await call('POST', `/api/lab/orders/${order.id}/dispute`, { body: { reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', message: 'Never arrived', dueInHours: 100 } })).json;
    expect(opened).toMatchObject({ via: 'simulator' });
    const detail = (await call('GET', `/api/console/disputes/${opened.disputeId as string}`)).json;
    expect(detail.analysis.decision.rule).toBe('NOT_RECEIVED_2_NOT_DELIVERED');

    // The merchant offers a refund; the buyer accepts; the dispute closes.
    await call('POST', `/api/console/actions/${detail.actions[0].id as string}/approve`);
    const accepted = (await call('POST', `/api/lab/disputes/${opened.disputeId as string}/buyer-accepts`)).json.detail;
    expect(accepted.dispute).toMatchObject({ status: 'RESOLVED', state: 'closed' });
  });

  it('adjudicates a dispute that is under review', async () => {
    const purchase = await prepareBundle({ wallet: c.wallet, agent: c.platform, ids: c.ids, keys: c.keys }, { linkedPayerId: 'SIMPAYER0001' });
    const result = await c.merchant.checkout(purchase.bundle);
    const order = (await c.merchant.order(result.orderId!))!;
    c.paypal.simulator!.approveOrder(order.paypalOrderId!);
    await c.paypal.simulator!.flush();
    const opened = (await call('POST', `/api/lab/orders/${order.id}/dispute`, { body: { reason: 'UNAUTHORISED', message: 'not me' } })).json;
    const detail = (await call('GET', `/api/console/disputes/${opened.disputeId as string}`)).json;
    await call('POST', `/api/console/actions/${detail.actions[0].id as string}/approve`);
    const decided = (await call('POST', `/api/lab/disputes/${opened.disputeId as string}/adjudicate`, { body: { outcome: 'SELLER_FAVOR' } })).json.detail;
    expect(decided.dispute).toMatchObject({ status: 'RESOLVED', state: 'closed', outcomeCode: 'RESOLVED_SELLER_FAVOUR' });
    expect((await call('POST', `/api/lab/disputes/${opened.disputeId as string}/adjudicate`, { body: { outcome: 'MAYBE' } })).status).toBe(400);
  });
});

describe('Lab runs stay out of the console unless asked for', () => {
  it('hides orders, checkouts and disputes made by scenarios, and shows them with lab=1', async () => {
    expect((await call('POST', '/api/lab/scenarios/remorse-01/run')).json.result.passed).toBe(true);
    expect((await call('POST', '/api/lab/scenarios/forge-01/run')).json.result.passed).toBe(true);
    for (const path of ['orders', 'attempts', 'disputes']) {
      const hidden = (await call('GET', `/api/console/${path}`)).json[path];
      expect(hidden, path).toEqual([]);
      const shown = (await call('GET', `/api/console/${path}?lab=1`)).json[path];
      expect(shown.length, path).toBeGreaterThan(0);
      expect(shown.every((r: { lab: boolean }) => r.lab), path).toBe(true);
    }
    const quiet = (await call('GET', '/api/console/overview')).json;
    expect(quiet).toMatchObject({ orders: { total: 0 }, attempts: { total: 0 }, disputes: { total: 0 } });
    const loud = (await call('GET', '/api/console/overview?lab=1')).json;
    expect(loud.orders.total).toBeGreaterThan(0);
    expect(loud.disputes.total).toBe(1);
  });

  it('a shopper\'s own order is never hidden', async () => {
    const purchase = await prepareBundle({ wallet: c.wallet, agent: c.platform, ids: c.ids, keys: c.keys });
    await c.merchant.checkout(purchase.bundle);
    await call('POST', '/api/lab/scenarios/remorse-01/run');
    const rows = (await call('GET', '/api/console/orders')).json.orders;
    expect(rows).toHaveLength(1);
    expect(rows[0].lab).toBe(false);
    expect((await call('GET', '/api/console/orders?lab=1')).json.orders.length).toBeGreaterThan(1);
  });
});
