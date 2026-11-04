import { PayPalError } from '@warrant/paypal';
import { decodeBundle, hashPayerId, verifyChain } from '@warrant/warrant';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readChain, toLedgerEntry, verifyStoredChain } from '../src/chain';
import { webhookHeadersFrom } from '../src/services/webhooks';
import { BOOK, DESK, checkoutNew, defaultTerms, lineFor, makeShop, pay, prepareBundle, type Shop } from './shop';

let shop: Shop;
beforeEach(async () => {
  shop = await makeShop();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await shop.close();
});

const rules = (findings: ReadonlyArray<{ rule: string; outcome: string }>, outcome = 'reject') => findings.filter((f) => f.outcome === outcome).map((f) => f.rule);

describe('happy path', () => {
  it('verifies, opens a PayPal order, captures after approval and logs the warrant', async () => {
    const { result, mandate, proposal, principal } = await checkoutNew(shop);
    expect(result).toMatchObject({ status: 'approval_required', outcome: 'ACCEPT' });
    expect(result.findings.every((f) => f.outcome === 'pass')).toBe(true);
    expect(result.approvalUrl).toContain('/sim/paypal/approve');
    const order = (await shop.merchant.order(result.orderId!))!;
    expect(order).toMatchObject({ status: 'created', cartJti: proposal.cartJti, mandateJti: mandate.jti, totalCents: DESK.priceCents, itemCount: 1, verificationOutcome: 'ACCEPT', verifierMode: 'STRICT' });
    expect(order.paypalOrderId).toMatch(/^SIMORDER/);

    // The PayPal order carries the binding references from the warrant.
    const remote = await shop.paypal.client.getOrder(order.paypalOrderId!);
    expect(remote.customId).toBe(`wrt:${proposal.cartJti}`);
    expect(remote.invoiceId).toMatch(/^WRT-/);
    expect(remote.totalCents).toBe(DESK.priceCents);

    // Budget reserved at checkout.
    expect(await shop.merchant.spendUnder(mandate.jti)).toEqual({ totalCents: DESK.priceCents, itemCount: 1 });

    const done = await pay(shop, order.id);
    expect(done.status).toBe('captured');
    expect(done.order).toMatchObject({ status: 'captured' });
    expect(done.order.captureId).toMatch(/^SIMCAP/);
    expect(done.order.payerIdHash).toBe(hashPayerId('SIMPAYER0001'));
    expect(done.order.verification.payer?.outcome).toBe('review');

    // Trust on first use bound the payer to the principal.
    expect((await shop.wallet.principal(principal.id))?.payerIdHash).toBe(hashPayerId('SIMPAYER0001'));

    // The warrant is in the transparency log, with an inclusion proof anyone can check.
    const view = await shop.registry.transparencyView(proposal.cartJti);
    expect(view).toMatchObject({ included: true });
    expect(await shop.registry.audit()).toMatchObject({ ok: true });

    // The audit chain for the order is intact and tells the story.
    const chain = await readChain(shop.db, 'ledger_entries', `order:${order.id}`);
    expect(chain.map((e) => e.type)).toEqual(['order_received', 'paypal_order_created', 'order_captured']);
    expect(verifyChain(chain.map(toLedgerEntry)).ok).toBe(true);
  });

  it('completing twice is harmless', async () => {
    const { result } = await checkoutNew(shop);
    const first = await pay(shop, result.orderId!);
    const again = await shop.merchant.completeOrder(result.orderId!);
    expect(again.status).toBe('captured');
    expect(again.order.captureId).toBe(first.order.captureId);
    expect((await shop.merchant.orders()).length).toBe(1);
  });

  it('reports "awaiting approval" until the buyer has approved', async () => {
    const { result } = await checkoutNew(shop);
    expect((await shop.merchant.completeOrder(result.orderId!)).status).toBe('awaiting_approval');
  });

  it('records the checkout attempt', async () => {
    const { result } = await checkoutNew(shop);
    const [attempt] = await shop.merchant.attempts();
    expect(attempt).toMatchObject({ id: result.attemptId, outcome: 'ACCEPT', orderId: result.orderId });
  });
});

describe('rejections', () => {
  it('rejects a replay of the same bundle and creates no second order', async () => {
    const purchase = await checkoutNew(shop);
    const replay = await shop.merchant.checkout(purchase.bundle);
    expect(replay.status).toBe('rejected');
    expect(rules(replay.findings)).toEqual(['V05_NONCE', 'V05_NONCE']);
    expect((await shop.merchant.orders()).length).toBe(1);
    expect((await shop.merchant.attempts()).map((a) => a.outcome)).toEqual(['REJECT', 'ACCEPT']);
  });

  it('two simultaneous submissions of one bundle: exactly one wins', async () => {
    const { bundle } = await prepareBundle(shop);
    const results = await Promise.all([shop.merchant.checkout(bundle), shop.merchant.checkout(bundle), shop.merchant.checkout(bundle)]);
    expect(results.filter((r) => r.status === 'approval_required')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(2);
    expect((await shop.merchant.orders()).length).toBe(1);
  });

  it('rejects a cart whose price no longer matches the merchant catalog (V08) and releases nothing it never took', async () => {
    const { bundle, mandate } = await prepareBundle(shop);
    await shop.store.setPrice(DESK.id, DESK.priceCents + 500);
    const result = await shop.merchant.checkout(bundle);
    expect(result.status).toBe('rejected');
    expect(rules(result.findings)).toContain('V08_REPRICE');
    expect(await shop.merchant.spendUnder(mandate.jti)).toEqual({ totalCents: 0, itemCount: 0 });
    expect((await shop.merchant.orders()).length).toBe(0);
  });

  it('rejects an unavailable or unknown item', async () => {
    const out = await prepareBundle(shop);
    await shop.store.setAvailability(DESK.id, false);
    expect(rules((await shop.merchant.checkout(out.bundle)).findings)).toContain('V08_REPRICE');
  });

  it('rejects when the merchant has changed the listing since the cart was built', async () => {
    const { bundle } = await prepareBundle(shop);
    await shop.store.setListingText(DESK.id, { title: 'Different product entirely' });
    expect(rules((await shop.merchant.checkout(bundle)).findings)).toContain('V08_REPRICE');
  });

  it('rejects malformed input without throwing', async () => {
    for (const junk of [null, 42, 'not json', {}, { warrant_version: '0.2', mandate: 'a.b.c', cart: 'd.e.f' }]) {
      const result = await shop.merchant.checkout(junk);
      expect(result).toMatchObject({ status: 'rejected', outcome: 'REJECT', orderId: null });
    }
    expect((await shop.merchant.attempts()).length).toBe(5);
  });

  it('rejects a bundle signed by a revoked agent key', async () => {
    const { bundle } = await prepareBundle(shop);
    await shop.registry.setKeyStatus(shop.keys.agent.kid, 'revoked');
    const result = await shop.merchant.checkout(bundle);
    expect(result.status).toBe('rejected');
    expect(rules(result.findings)).toContain('V02_KEY_STATUS');
  });

  it('rejects an expired cart', async () => {
    const { bundle } = await prepareBundle(shop);
    shop.clock.advanceSeconds(16 * 60);
    expect(rules((await shop.merchant.checkout(bundle)).findings)).toContain('V03_FRESHNESS');
  });

  it('rejects a bundle presented to the wrong merchant', async () => {
    const { bundle } = await prepareBundle(shop);
    const other = await makeOtherMerchant();
    expect(rules((await other.checkout(bundle)).findings)).toContain('V04_AUDIENCE');
  });

  async function makeOtherMerchant() {
    const { MerchantService } = await import('../src/services/merchant');
    return new MerchantService({
      db: shop.db,
      clock: shop.clock,
      ids: shop.ids,
      config: { ...shop.config, paypal: { ...shop.config.paypal, merchantId: 'SOMEONEELSE' } },
      registry: shop.registry,
      wallet: shop.wallet,
      store: shop.store,
      paypal: shop.paypal,
    });
  }

  it('rejects a cart the wallet never showed the human (no consent record)', async () => {
    const { bundle, proposal } = await prepareBundle(shop);
    await shop.db.query("UPDATE proposals SET status = 'declined' WHERE id = $1", [proposal.id]);
    expect(rules((await shop.merchant.checkout(bundle)).findings)).toContain('V10_CONSENT');
  });
});

describe('cumulative budget', () => {
  it('lets a mandate spend its budget across carts and stops at the limit', async () => {
    const first = await prepareBundle(shop, { terms: { budgetMode: 'cumulative', maxTotalCents: 15_000, maxItems: 3 }, lines: [lineFor(DESK)] });
    const a = await shop.merchant.checkout(first.bundle);
    expect(a.status).toBe('approval_required');
    const second = await prepareBundle(shop, { principal: first.principal, mandate: first.mandate, lines: [lineFor(BOOK)] });
    const b = await shop.merchant.checkout(second.bundle);
    expect(b.status).toBe('approval_required');
    expect(await shop.merchant.spendUnder(first.mandate.jti)).toEqual({ totalCents: DESK.priceCents + BOOK.priceCents, itemCount: 2 });
    const third = await prepareBundle(shop, { principal: first.principal, mandate: first.mandate, lines: [lineFor(DESK)] });
    const c = await shop.merchant.checkout(third.bundle);
    expect(c.status).toBe('rejected');
    expect(rules(c.findings)).toEqual(['V09_SCOPE']);
    expect(c.findings.find((f) => f.outcome === 'reject')?.detail).toMatch(/above the mandate budget/);
  });

  it('two carts racing for the last of the budget: only one is accepted', async () => {
    const first = await prepareBundle(shop, { terms: { budgetMode: 'cumulative', maxTotalCents: 12_000, maxItems: 5 }, lines: [lineFor(DESK)] });
    const second = await prepareBundle(shop, { principal: first.principal, mandate: first.mandate, lines: [lineFor(DESK)] });
    const results = await Promise.all([shop.merchant.checkout(first.bundle), shop.merchant.checkout(second.bundle)]);
    expect(results.map((r) => r.status).sort()).toEqual(['approval_required', 'rejected']);
    expect((await shop.merchant.spendUnder(first.mandate.jti)).totalCents).toBe(DESK.priceCents);
  });

  it('gives the budget back when an order fails', async () => {
    const first = await prepareBundle(shop, { terms: { budgetMode: 'cumulative', maxTotalCents: 12_000, maxItems: 5 } });
    vi.spyOn(shop.paypal.client, 'createOrder').mockRejectedValueOnce(new PayPalError('boom', 500, 'INTERNAL_SERVER_ERROR', null));
    const failed = await shop.merchant.checkout(first.bundle);
    expect(failed.status).toBe('failed');
    expect(await shop.merchant.spendUnder(first.mandate.jti)).toEqual({ totalCents: 0, itemCount: 0 });
    expect((await shop.merchant.order(failed.orderId!))?.status).toBe('failed');
    const retry = await prepareBundle(shop, { principal: first.principal, mandate: first.mandate });
    expect((await shop.merchant.checkout(retry.bundle)).status).toBe('approval_required');
  });
});

describe('payer binding (V11)', () => {
  it('rejects a payer other than the one bound to the principal and never captures', async () => {
    const first = await checkoutNew(shop);
    await pay(shop, first.result.orderId!);
    // The principal is now bound to SIMPAYER0001; a new mandate carries the hash.
    const second = await checkoutNew(shop, { principal: first.principal, terms: { instructionText: 'Another one' } });
    const stranger = { payerId: 'STRANGER0002', email: 's@example.com', name: 'Stranger' };
    const done = await pay(shop, second.result.orderId!, stranger);
    expect(done.status).toBe('rejected');
    expect(done.message).toMatch(/does not match/);
    const order = (await shop.merchant.order(second.result.orderId!))!;
    expect(order.status).toBe('rejected');
    expect(order.captureId).toBeNull();
    expect(await shop.merchant.spendUnder(second.mandate.jti)).toEqual({ totalCents: 0, itemCount: 0 });
    const remote = await shop.paypal.client.getOrder(order.paypalOrderId!);
    expect(remote.captures).toHaveLength(0);
  });

  it('accepts the same payer again', async () => {
    const first = await checkoutNew(shop);
    await pay(shop, first.result.orderId!);
    const second = await checkoutNew(shop, { principal: first.principal });
    const done = await pay(shop, second.result.orderId!);
    expect(done.status).toBe('captured');
    expect(done.order.verification.payer?.outcome).toBe('pass');
    // The same cart bought twice repeats the cart-hash invoice id; the second order gets a counter so PayPal accepts it.
    const firstOrder = (await shop.merchant.order(first.result.orderId!))!;
    expect(firstOrder.invoiceId).toMatch(/^WRT-[A-Za-z0-9_-]{16}$/);
    expect(done.order.invoiceId).toBe(`${firstOrder.invoiceId}-2`);
  });
});

describe('review', () => {
  it('holds a velocity-limited order for the merchant, who can approve or reject it', async () => {
    shop = await replaceShop({ velocity: { windowSeconds: 3600, maxPerPrincipal: 1, maxPerPlatform: 100 } });
    const a = await checkoutNew(shop);
    expect(a.result.status).toBe('approval_required');
    const b = await checkoutNew(shop, { principal: a.principal, terms: { instructionText: 'second' } });
    expect(b.result).toMatchObject({ status: 'pending_review', outcome: 'REVIEW', approvalUrl: null });
    expect(rules(b.result.findings, 'review')).toContain('V12_VELOCITY');
    expect((await shop.merchant.order(b.result.orderId!))?.paypalOrderId).toBeNull();

    const approved = await shop.merchant.decideReview(b.result.orderId!, 'approve', 'tester');
    expect(approved.status).toBe('created');
    expect(approved.approvalUrl).toContain('/sim/paypal/approve');
    await expect(shop.merchant.decideReview(b.result.orderId!, 'approve')).rejects.toThrow(/not waiting for review/);

    const c = await checkoutNew(shop, { principal: a.principal, terms: { instructionText: 'third' } });
    expect(c.result.status).toBe('pending_review');
    const rejected = await shop.merchant.decideReview(c.result.orderId!, 'reject', 'tester');
    expect(rejected).toMatchObject({ status: 'rejected' });
    expect(await shop.merchant.spendUnder(c.mandate.jti)).toEqual({ totalCents: 0, itemCount: 0 });
  });

  async function replaceShop(options: Parameters<typeof makeShop>[0]): Promise<Shop> {
    await shop.close();
    return makeShop(options);
  }
});

describe('webhooks', () => {
  it('completes an order from the approval event, once', async () => {
    const { result } = await checkoutNew(shop);
    const order = (await shop.merchant.order(result.orderId!))!;
    shop.paypal.simulator!.approveOrder(order.paypalOrderId!);
    await shop.paypal.simulator!.flush();
    expect((await shop.merchant.order(order.id))?.status).toBe('captured');
    const events = await shop.db.query<{ type: string; verified: boolean; processed_at: number | null }>('SELECT type, verified, processed_at FROM webhook_events ORDER BY received_at, paypal_event_id');
    expect(events.some((e) => e.type === 'CHECKOUT.ORDER.APPROVED' && e.verified && e.processed_at !== null)).toBe(true);
  });

  it('ignores a duplicate delivery', async () => {
    const { result } = await checkoutNew(shop);
    const order = (await shop.merchant.order(result.orderId!))!;
    shop.paypal.simulator!.approveOrder(order.paypalOrderId!);
    await shop.paypal.simulator!.flush();
    const first = shop.paypal.simulator!.deliveries[0]!;
    const headers = webhookHeadersFrom((n) => new Map(Object.entries(first.headers).map(([k, v]) => [k.toLowerCase(), v])).get(n))!;
    expect(await shop.merchant.handleWebhook(headers, first.body)).toMatchObject({ status: 'duplicate' });
  });

  it('records a forged delivery as unverified and does nothing', async () => {
    const { result } = await checkoutNew(shop);
    const order = (await shop.merchant.order(result.orderId!))!;
    const body = JSON.stringify({ id: 'WH-FORGED', event_type: 'CHECKOUT.ORDER.APPROVED', resource_type: 'checkout-order', resource: { id: order.paypalOrderId }, create_time: '2026-06-01T12:00:00Z' });
    const outcome = await shop.merchant.handleWebhook({ authAlgo: 'SHA256withRSA', certUrl: 'https://example.invalid/cert.pem', transmissionId: 'x', transmissionSig: 'AAAA', transmissionTime: '2026-06-01T12:00:00Z' }, body);
    expect(outcome.status).toBe('unverified');
    expect((await shop.merchant.order(order.id))?.status).toBe('created');
    expect((await shop.db.query<{ verified: boolean }>("SELECT verified FROM webhook_events WHERE type = 'CHECKOUT.ORDER.APPROVED'"))[0]?.verified).toBe(false);
  });

  it('refuses a body that is not an event', async () => {
    const headers = { authAlgo: 'a', certUrl: 'b', transmissionId: 'c', transmissionSig: 'd', transmissionTime: 'e' };
    expect(await shop.merchant.handleWebhook(headers, 'not json')).toEqual({ status: 'invalid' });
    expect(await shop.merchant.handleWebhook(headers, '{"no":"event type"}')).toEqual({ status: 'invalid' });
  });

  it('passes dispute events to the dispute handler', async () => {
    const seen: string[] = [];
    shop.merchant.onDisputeEvent((event) => {
      seen.push(event.eventType);
      return Promise.resolve();
    });
    const { result } = await checkoutNew(shop);
    const done = await pay(shop, result.orderId!);
    shop.paypal.simulator!.openDispute({ captureId: done.order.captureId!, reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', message: 'Never arrived' });
    await shop.paypal.simulator!.flush();
    expect(seen).toContain('CUSTOMER.DISPUTE.CREATED');
  });

  it('a handler failure is reported so PayPal retries, and the event can be processed again', async () => {
    shop.merchant.onDisputeEvent(() => Promise.reject(new Error('handler down')));
    const { result } = await checkoutNew(shop);
    const done = await pay(shop, result.orderId!);
    shop.paypal.simulator!.openDispute({ captureId: done.order.captureId!, reason: 'OTHER', message: 'x' });
    await shop.paypal.simulator!.flush();
    const rows = await shop.db.query<{ paypal_event_id: string; error: string | null; processed_at: number | null }>("SELECT paypal_event_id, error, processed_at FROM webhook_events WHERE type = 'CUSTOMER.DISPUTE.CREATED'");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ error: 'handler down', processed_at: null });
    expect(rows[0]?.paypal_event_id).toMatch(/^failed:/);
  });
});

describe('fulfilment and refunds', () => {
  it('ships, delivers and refunds a paid order, each step in the audit chain', async () => {
    const { result } = await checkoutNew(shop);
    const done = await pay(shop, result.orderId!);
    const orderId = done.order.id;
    const shipped = await shop.merchant.ship(orderId, { carrier: 'UPS', trackingNumber: '1Z999AA10123456784' });
    expect(shipped.warning).toBeNull();
    expect(shipped.tracking).toMatchObject({ status: 'shipped', carrier: 'UPS' });
    expect(shipped.tracking.promisedBy).toBe(shipped.tracking.shippedAt + 5 * 86_400);
    shop.clock.advanceSeconds(3 * 86_400);
    const delivered = await shop.merchant.deliver(orderId);
    expect(delivered).toMatchObject({ status: 'delivered' });
    expect(delivered.deliveredAt).toBe(delivered.shippedAt + 3 * 86_400);

    const refund = await shop.merchant.refund(orderId, { amountCents: 1_000, note: 'goodwill' });
    expect(refund).toMatchObject({ amountCents: 1_000, orderId });
    expect(await shop.merchant.refunds(orderId)).toHaveLength(1);
    await shop.merchant.refund(orderId, { amountCents: 500 });
    expect((await shop.merchant.refunds(orderId)).map((r) => r.amountCents)).toEqual([1_000, 500]);

    const chain = await readChain(shop.db, 'ledger_entries', `order:${orderId}`);
    expect(chain.map((e) => e.type)).toEqual(['order_received', 'paypal_order_created', 'order_captured', 'order_shipped', 'order_delivered', 'order_refunded', 'order_refunded']);
    expect(await verifyStoredChain(shop.db, 'ledger_entries', `order:${orderId}`)).toMatchObject({ ok: true, length: 7 });
  });

  it('will not ship or refund an unpaid order, or deliver one that has not shipped', async () => {
    const { result } = await checkoutNew(shop);
    await expect(shop.merchant.ship(result.orderId!, { carrier: 'UPS', trackingNumber: '1' })).rejects.toThrow(/only a paid order/);
    await expect(shop.merchant.refund(result.orderId!)).rejects.toThrow(/only a paid order/);
    await expect(shop.merchant.deliver(result.orderId!)).rejects.toThrow(/has not shipped/);
    await expect(shop.merchant.ship('ord_missing', { carrier: 'UPS', trackingNumber: '1' })).rejects.toThrow(/unknown order/);
  });

  it('keeps the shipment when PayPal will not take the tracking number, and says so', async () => {
    const { result } = await checkoutNew(shop);
    const done = await pay(shop, result.orderId!);
    vi.spyOn(shop.paypal.client, 'addTracking').mockRejectedValueOnce(new Error('PayPal is down'));
    const shipped = await shop.merchant.ship(done.order.id, { carrier: 'UPS', trackingNumber: 'T1' });
    expect(shipped.warning).toMatch(/did not accept the tracking number/);
    expect(shipped.tracking.status).toBe('shipped');
  });

  it('rejects empty carrier or tracking', async () => {
    const { result } = await checkoutNew(shop);
    const done = await pay(shop, result.orderId!);
    await expect(shop.merchant.ship(done.order.id, { carrier: ' ', trackingNumber: 'T' })).rejects.toThrow(/required/);
  });
});

describe('orders without a warrant', () => {
  it('a STRICT merchant turns them away', async () => {
    const result = await shop.merchant.directCheckout([{ sku: BOOK.id, qty: 1 }]);
    expect(result).toMatchObject({ status: 'rejected', outcome: 'REJECT' });
    expect(result.message).toMatch(/warrant is required/);
  });

  it('a PERMISSIVE merchant takes them and marks them as having no warrant', async () => {
    await shop.store.setMerchantMode('PERMISSIVE');
    const result = await shop.merchant.directCheckout([{ sku: BOOK.id, qty: 2 }]);
    expect(result.status).toBe('approval_required');
    const done = await pay(shop, result.orderId!);
    expect(done.status).toBe('captured');
    expect(done.order).toMatchObject({ cartJti: null, verificationOutcome: 'NO_WARRANT', verifierMode: 'PERMISSIVE', totalCents: BOOK.priceCents * 2, itemCount: 2 });
    expect((await shop.registry.entries()).some((e) => e.type === 'warrant_logged')).toBe(false);
  });

  it('refuses unavailable items and empty orders', async () => {
    await shop.store.setMerchantMode('NONE');
    await shop.store.setAvailability(BOOK.id, false);
    await expect(shop.merchant.directCheckout([{ sku: BOOK.id, qty: 1 }])).rejects.toThrow(/not available/);
    await expect(shop.merchant.directCheckout([])).rejects.toThrow(/no items/);
    await expect(shop.merchant.directCheckout([{ sku: DESK.id, qty: 0 }])).rejects.toThrow(/positive whole number/);
  });
});

describe('lookups', () => {
  it('finds orders by cart, capture and PayPal id, and filters by status', async () => {
    const { result, proposal } = await checkoutNew(shop);
    const done = await pay(shop, result.orderId!);
    expect((await shop.merchant.orderByCartJti(proposal.cartJti))?.id).toBe(done.order.id);
    expect((await shop.merchant.orderByCaptureId(done.order.captureId!))?.id).toBe(done.order.id);
    expect((await shop.merchant.orderByPayPalOrderId(done.order.paypalOrderId!))?.id).toBe(done.order.id);
    expect(await shop.merchant.orderByCaptureId('nope')).toBeNull();
    expect((await shop.merchant.orders({ status: 'captured' })).length).toBe(1);
    expect((await shop.merchant.orders({ status: 'failed' })).length).toBe(0);
    expect(decodeBundle((await shop.merchant.bundleOf(proposal.cartJti)) as never).cart.ok).toBe(true);
    expect(await shop.merchant.bundleOf('nope')).toBeNull();
    expect(defaultTerms().maxItems).toBe(1);
  });
});

describe('merchants that do not enforce', () => {
  it('a PERMISSIVE merchant runs the rules, records what failed, and sells at the cart\'s price', async () => {
    await shop.store.setMerchantMode('PERMISSIVE');
    const { bundle, proposal } = await prepareBundle(shop);
    await shop.store.setPrice(DESK.id, DESK.priceCents + 500);
    const result = await shop.merchant.checkout(bundle);
    expect(result).toMatchObject({ status: 'approval_required', outcome: 'REJECT' });
    expect(result.message).toMatch(/accepted without enforcement \(PERMISSIVE merchant\)/);
    expect(rules(result.findings)).toContain('V08_REPRICE');
    const order = (await shop.merchant.order(result.orderId!))!;
    expect(order).toMatchObject({ status: 'created', verifierMode: 'PERMISSIVE', verificationOutcome: 'REJECT', totalCents: DESK.priceCents });
    expect(order.note).toMatch(/accepted without enforcement/);
    expect((await shop.paypal.client.getOrder(order.paypalOrderId!)).totalCents).toBe(DESK.priceCents);
    expect((await shop.merchant.orderByCartJti(proposal.cartJti))?.id).toBe(order.id);
  });

  it('a PERMISSIVE merchant treats a resubmitted cart as the same order', async () => {
    await shop.store.setMerchantMode('PERMISSIVE');
    const { bundle } = await prepareBundle(shop);
    const first = await shop.merchant.checkout(bundle);
    const again = await shop.merchant.checkout(bundle);
    expect(again).toMatchObject({ status: 'approval_required', orderId: first.orderId, approvalUrl: first.approvalUrl, message: 'this cart already has an order' });
    expect((await shop.merchant.orders()).length).toBe(1);
  });

  it('a PERMISSIVE merchant keeps a reused nonce and counts it', async () => {
    await shop.store.setMerchantMode('PERMISSIVE');
    const first = await prepareBundle(shop);
    const nonce = (await shop.wallet.proposal(first.proposal.id))!.nonce;
    const second = await shop.wallet.proposeCart({ mandateJti: first.mandate.jti, cartJti: shop.ids.next('crt'), nonce, aud: first.proposal.aud, proposedBy: first.proposal.proposedBy, lines: [lineFor()], currency: 'USD' });
    await shop.wallet.approve(first.principal.id, second.id);
    const reused = await shop.agent.bundleFor(second.id);
    await shop.merchant.checkout(first.bundle);
    const result = await shop.merchant.checkout(reused);
    expect(result.status).toBe('approval_required');
    expect(rules(result.findings)).toContain('V05_NONCE');
    const stored = await shop.db.query<{ nonce: string }>('SELECT nonce FROM warrants ORDER BY received_at, cart_jti');
    expect(stored.map((r) => r.nonce).sort()).toEqual([nonce, `${nonce}#2`].sort());
  });

  it('a PERMISSIVE merchant does not hold orders for review or refuse a different payer', async () => {
    shop = await replaceShopWith({ velocity: { windowSeconds: 3600, maxPerPrincipal: 1, maxPerPlatform: 100 } });
    await shop.store.setMerchantMode('PERMISSIVE');
    const a = await checkoutNew(shop, { linkedPayerId: 'SIMPAYER0001' });
    const b = await checkoutNew(shop, { principal: a.principal, linkedPayerId: 'SIMPAYER0001' });
    expect(rules(b.result.findings, 'review')).toContain('V12_VELOCITY');
    expect(b.result.status).toBe('approval_required');
    const done = await pay(shop, b.result.orderId!, { payerId: 'STRANGER0002', email: 's@example.com', name: 'Stranger' });
    expect(done.status).toBe('captured');
    expect(done.order.verification.payer).toMatchObject({ rule: 'V11_PAYER_BINDING', outcome: 'reject' });
  });

  it('a merchant with no warrant support (NONE) ignores the bundle and sells at the store\'s prices', async () => {
    await shop.store.setMerchantMode('NONE');
    const { bundle } = await prepareBundle(shop);
    await shop.store.setPrice(DESK.id, DESK.priceCents + 500);
    const result = await shop.merchant.checkout(bundle);
    expect(result.status).toBe('approval_required');
    const order = (await shop.merchant.order(result.orderId!))!;
    expect(order).toMatchObject({ cartJti: null, verificationOutcome: 'NO_WARRANT', verifierMode: 'NONE', totalCents: DESK.priceCents + 500 });
    const done = await pay(shop, order.id);
    expect(done.status).toBe('captured');
    expect((await shop.registry.entries()).some((e) => e.type === 'warrant_logged')).toBe(false);
  });

  it('NONE and PERMISSIVE still refuse what they cannot read or cannot sell', async () => {
    await shop.store.setMerchantMode('NONE');
    expect((await shop.merchant.checkout({ junk: true })).message).toMatch(/no readable cart/);
    const { bundle } = await prepareBundle(shop);
    await shop.store.setAvailability(DESK.id, false);
    expect((await shop.merchant.checkout(bundle)).message).toMatch(/not available/);
    await shop.store.setMerchantMode('PERMISSIVE');
    expect((await shop.merchant.checkout({ junk: true })).status).toBe('rejected');
  });

  async function replaceShopWith(options: Parameters<typeof makeShop>[0]): Promise<Shop> {
    await shop.close();
    return makeShop(options);
  }
});
