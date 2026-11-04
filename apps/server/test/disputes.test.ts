import { PayPalError, type PayPalSimulator } from '@warrant/paypal';
import { verifyChain } from '@warrant/warrant';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readChain, toLedgerEntry } from '../src/chain';
import { DisputeError } from '../src/services/disputes';
import { BOOK, DESK, checkoutNew, makeShop, pay, type Shop } from './shop';

let shop: Shop;
beforeEach(async () => {
  shop = await makeShop();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await shop.close();
});

const sim = () => shop.paypal.simulator!;

/** A paid, shipped (and optionally delivered) order made through the full warrant flow. */
async function paidOrder(options: { deliver?: boolean; ship?: boolean; unlinked?: boolean } = {}) {
  // By default the buyer's PayPal account is already linked to the wallet, so the warrant binds the payer (fact F7).
  const purchase = await checkoutNew(shop, options.unlinked === true ? {} : { linkedPayerId: 'SIMPAYER0001' });
  const done = await pay(shop, purchase.result.orderId!);
  const order = done.order;
  if (options.ship !== false) {
    await shop.merchant.ship(order.id, { carrier: 'UPS', trackingNumber: '1Z999AA10123456784' });
    if (options.deliver !== false) {
      shop.clock.advanceSeconds(2 * 86_400);
      await shop.merchant.deliver(order.id);
    }
  }
  return { ...purchase, order: (await shop.merchant.order(order.id))! };
}

async function open(captureId: string, reason: string, message: string, extra: { responseDueInSeconds?: number; amountCents?: number } = {}) {
  const dispute = sim().openDispute({ captureId, reason, message, ...extra } satisfies Parameters<PayPalSimulator['openDispute']>[0]);
  await sim().flush();
  return { id: dispute.disputeId };
}

const latest = async (id: string) => (await shop.disputes.detail(id));

describe('a dispute the warrant can answer', () => {
  it('is picked up from the webhook, analysed, and answered with evidence after approval', async () => {
    const { order, proposal } = await paidOrder();
    const dispute = await open(order.captureId!, 'UNAUTHORISED', 'I did not authorize this charge');
    const detail = await latest(dispute.id);

    expect(detail.dispute).toMatchObject({ orderId: order.id, captureId: order.captureId, reason: 'UNAUTHORISED', claimType: 'UNAUTHORIZED', claimConflict: false, state: 'awaiting_approval' });
    expect(detail.analysis?.decision).toMatchObject({ outcome: 'FIGHT', rule: 'UNAUTHORIZED_1_AUTHORISATION_CONFIRMED', claim: 'UNAUTHORIZED' });
    const f = detail.analysis!.facts;
    expect([f.F1, f.F2, f.F3, f.F4, f.F5, f.F6, f.F7, f.F8].map((x) => x.value)).toEqual([true, true, true, true, true, true, true, true]);
    expect(f.context).toMatchObject({ cartJti: proposal.cartJti, orderId: expect.stringMatching(/^SIMORDER/) as string });
    expect(f.F12.value).toBeGreaterThan(24);

    const [action] = detail.actions;
    expect(action).toMatchObject({ actionType: 'provide-evidence', status: 'proposed', outcome: 'FIGHT', noteSource: 'template', approvedBy: null });
    expect(action?.params).toEqual({ evidence_type: 'PROOF_OF_FULFILLMENT' });
    expect(action?.evidenceNote).toContain(proposal.cartJti);
    expect(action?.memo).toContain('Advisory');
    expect(detail.packet).toMatchObject({ contentType: 'application/pdf' });
    expect(detail.packet!.sizeBytes).toBeGreaterThan(1000);
    const file = await shop.disputes.packetFile(dispute.id);
    expect(Buffer.from(file!.bytes).subarray(0, 5).toString()).toBe('%PDF-');
    expect(Buffer.from(file!.bytes).toString('latin1')).toContain(dispute.id);

    const done = await shop.disputes.approve(action!.id, 'console:riley');
    expect(done).toMatchObject({ status: 'executed', approvedBy: 'console:riley', error: null });
    const after = await latest(dispute.id);
    expect(after.dispute.state).toBe('responded');
    const remote = await shop.paypal.client.getDispute(dispute.id);
    expect(remote.status).toBe('UNDER_REVIEW');
    expect(remote.evidences.map((e) => e.evidenceType)).toContain('PROOF_OF_FULFILLMENT');

    // The audit chain for the dispute tells the whole story and verifies.
    const chain = await readChain(shop.db, 'ledger_entries', `dispute:${dispute.id}`);
    expect(chain.map((e) => e.type)).toEqual(['dispute_received', 'analysis', 'action_executed']);
    expect(verifyChain(chain.map(toLedgerEntry)).ok).toBe(true);
  });

  it('closes when PayPal resolves the dispute', async () => {
    const { order } = await paidOrder();
    const dispute = await open(order.captureId!, 'UNAUTHORISED', 'not me');
    const [action] = (await latest(dispute.id)).actions;
    await shop.disputes.approve(action!.id, 'console:riley');
    await shop.paypal.client.sandboxAdjudicate(dispute.id, 'SELLER_FAVOR', 'adj-1');
    await sim().flush();
    const detail = await latest(dispute.id);
    expect(detail.dispute).toMatchObject({ state: 'closed', status: 'RESOLVED' });
    expect(detail.dispute.outcomeCode).toBe('RESOLVED_SELLER_FAVOUR');
    expect((await readChain(shop.db, 'ledger_entries', `dispute:${dispute.id}`)).at(-1)?.type).toBe('dispute_closed');
  });

  it('a decided action cannot be decided again', async () => {
    const { order } = await paidOrder();
    const dispute = await open(order.captureId!, 'UNAUTHORISED', 'not me');
    const [action] = (await latest(dispute.id)).actions;
    await shop.disputes.approve(action!.id, 'a');
    await expect(shop.disputes.approve(action!.id, 'b')).rejects.toThrow(/is executed \(decided by a\)/);
    await expect(shop.disputes.reject(action!.id, 'b')).rejects.toThrow(/not waiting for a decision/);
    await expect(shop.disputes.approve('act_missing', 'a')).rejects.toBeInstanceOf(DisputeError);
  });

  it('two people approving at once: one action, one PayPal call', async () => {
    const { order } = await paidOrder();
    const dispute = await open(order.captureId!, 'UNAUTHORISED', 'not me');
    const [action] = (await latest(dispute.id)).actions;
    const spy = vi.spyOn(shop.paypal.client, 'provideEvidence');
    const results = await Promise.allSettled([shop.disputes.approve(action!.id, 'a'), shop.disputes.approve(action!.id, 'b')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('rejecting an action sends the dispute to a person without calling PayPal', async () => {
    const { order } = await paidOrder();
    const dispute = await open(order.captureId!, 'UNAUTHORISED', 'not me');
    const [action] = (await latest(dispute.id)).actions;
    const spy = vi.spyOn(shop.paypal.client, 'provideEvidence');
    expect(await shop.disputes.reject(action!.id, 'console:riley')).toMatchObject({ status: 'rejected', approvedBy: 'console:riley' });
    expect(spy).not.toHaveBeenCalled();
    expect((await latest(dispute.id)).dispute.state).toBe('escalated');
  });
});

describe('not received', () => {
  it('fights when the order was delivered on time', async () => {
    const { order } = await paidOrder({ deliver: true });
    const dispute = await open(order.captureId!, 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'It never arrived');
    const detail = await latest(dispute.id);
    expect(detail.analysis?.decision).toMatchObject({ outcome: 'FIGHT', rule: 'NOT_RECEIVED_1_DELIVERED_ON_TIME' });
    expect(detail.analysis?.facts.F9.value).toBe(true);
    expect(detail.actions[0]?.actionType).toBe('provide-evidence');
    expect(detail.actions[0]?.evidenceNote).toContain('1Z999AA10123456784');
  });

  it('offers a refund when the order never shipped', async () => {
    const { order } = await paidOrder({ ship: false });
    const dispute = await open(order.captureId!, 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'It never arrived');
    const detail = await latest(dispute.id);
    expect(detail.analysis?.decision).toMatchObject({ rule: 'NOT_RECEIVED_2_NOT_DELIVERED' });
    expect(detail.analysis?.decision.outcome).toBe('REFUND_MERCHANT_FAULT');
    expect(detail.actions[0]).toMatchObject({ actionType: 'make-offer', params: { offer_type: 'REFUND', offer_amount_cents: DESK.priceCents } });
    expect(detail.packet).toBeNull();
    const executed = await shop.disputes.approve(detail.actions[0]!.id, 'console:riley');
    expect(executed.status).toBe('executed');
    expect((await shop.paypal.client.getDispute(dispute.id)).status).toBe('WAITING_FOR_BUYER_RESPONSE');
  });
});

describe('claims the table cannot settle on its own', () => {
  it('sends a reason code that contradicts the buyer\'s message to a person', async () => {
    const { order } = await paidOrder();
    const dispute = await open(order.captureId!, 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'I did not authorize this purchase at all');
    const detail = await latest(dispute.id);
    expect(detail.dispute).toMatchObject({ claimType: 'NOT_RECEIVED', claimConflict: true, state: 'escalated' });
    expect(detail.analysis?.decision).toMatchObject({ outcome: 'ESCALATE_TO_HUMAN', rule: 'CLAIM_CONFLICT', confidence: 'low', claimConflict: true });
    expect(detail.analysis?.decision.alternatives[0]).toMatchObject({ type: 'provide-evidence' });
    expect(detail.actions[0]?.actionType).toBe('alert');
  });

  it('escalates when the response deadline is less than a day away', async () => {
    const { order } = await paidOrder();
    const dispute = await open(order.captureId!, 'UNAUTHORISED', 'not me', { responseDueInSeconds: 3 * 3600 });
    const detail = await latest(dispute.id);
    expect(detail.analysis?.decision).toMatchObject({ outcome: 'ESCALATE_TO_HUMAN', rule: 'ANY_F12_DEADLINE_SOON' });
    expect(detail.dispute.state).toBe('escalated');
  });

  it('an alert is recorded as handled when a person acknowledges it', async () => {
    const { order } = await paidOrder();
    const dispute = await open(order.captureId!, 'UNAUTHORISED', 'not me', { responseDueInSeconds: 3 * 3600 });
    const [action] = (await latest(dispute.id)).actions;
    const spy = vi.spyOn(shop.paypal.client, 'provideEvidence');
    expect((await shop.disputes.approve(action!.id, 'console:riley')).status).toBe('executed');
    expect(spy).not.toHaveBeenCalled();
  });

  it('accepts when there is no warrant to rely on', async () => {
    await shop.store.setMerchantMode('PERMISSIVE');
    const direct = await shop.merchant.directCheckout([{ sku: BOOK.id, qty: 1 }]);
    const done = await pay(shop, direct.orderId!);
    const dispute = await open(done.order.captureId!, 'UNAUTHORISED', 'I did not make this purchase');
    const detail = await latest(dispute.id);
    expect(detail.analysis?.facts.F1.value).toBe(false);
    expect(detail.analysis?.decision.outcome).toBe('NO_PROOF');
    expect(detail.actions[0]?.actionType).toBe('accept-claim');
    expect(detail.analysis?.decision.attribution.agent_platform).not.toBe('primary');
  });

  it('treats a refund already made as the end of it', async () => {
    const { order } = await paidOrder();
    await shop.merchant.refund(order.id, { note: 'goodwill' });
    const dispute = await open(order.captureId!, 'UNAUTHORISED', 'not me');
    const detail = await latest(dispute.id);
    expect(detail.analysis?.decision).toMatchObject({ outcome: 'ALREADY_RESOLVED', rule: 'ANY_F11_ALREADY_REFUNDED' });
    expect(detail.actions[0]?.actionType).toBe('none');
  });

  it('copes with a dispute about a payment it has no record of', async () => {
    const created = await shop.paypal.client.createOrder(
      { referenceId: 'ext_1', customId: 'external', invoiceId: 'EXT-1', description: 'x', currency: 'USD', lines: [{ sku: 'x', name: 'x', quantity: 1, unitCents: 1_000 }], totalCents: 1_000, brandName: 'x', returnUrl: 'http://x', cancelUrl: 'http://x' },
      'ext-create',
    );
    sim().approveOrder(created.id);
    const captured = await shop.paypal.client.captureOrder(created.id, 'ext-capture');
    const dispute = await open(captured.captures[0]!.id, 'UNAUTHORISED', 'not me');
    const detail = await latest(dispute.id);
    expect(detail.order).toBeNull();
    expect(detail.analysis?.decision.outcome).toBe('NO_PROOF');
  });
});

describe('what the order looks like against the consent', () => {
  it('proposes a partial refund when the amount paid exceeds what the buyer consented to', async () => {
    const { order } = await paidOrder();
    // Make the PayPal payment larger than the consented cart: the merchant "charged more than agreed".
    const inflated = await shop.paypal.client.createOrder(
      { referenceId: 'inflated', customId: `wrt:${order.cartJti}`, invoiceId: 'INFL-1', description: 'x', currency: 'USD', lines: [{ sku: DESK.id, name: DESK.title, quantity: 1, unitCents: order.totalCents + 1_500 }], totalCents: order.totalCents + 1_500, brandName: 'x', returnUrl: 'http://x', cancelUrl: 'http://x' },
      'inflated-create',
    );
    sim().approveOrder(inflated.id);
    const captured = await shop.paypal.client.captureOrder(inflated.id, 'inflated-capture');
    await shop.db.query('UPDATE orders SET paypal_order_id = $2, capture_id = $3 WHERE id = $1', [order.id, inflated.id, captured.captures[0]!.id]);
    const dispute = await open(captured.captures[0]!.id, 'INCORRECT_AMOUNT', 'I was charged more than I agreed', { amountCents: 1_500 });
    const detail = await latest(dispute.id);
    expect(detail.analysis?.facts.F5.value).toBe(false);
    expect(detail.analysis?.decision).toMatchObject({ outcome: 'ACCEPT', rule: 'WRONG_AMOUNT_1_ORDER_DIFFERS_FROM_CONSENT' });
    expect(detail.analysis?.decision.attribution.merchant).toBe('primary');
    expect(detail.actions[0]).toMatchObject({ actionType: 'accept-claim', params: { accept_claim_type: 'PARTIAL_REFUND', refund_amount_cents: 1_500 } });
    await shop.disputes.approve(detail.actions[0]!.id, 'console:riley');
    expect((await shop.paypal.client.getCapture(captured.captures[0]!.id)).status).toMatch(/REFUND/);
  });

  it('offers a replacement when the listing changed after the buyer consented', async () => {
    const { order } = await paidOrder({ ship: false });
    await shop.store.setListingText(DESK.id, { title: 'A different product entirely' });
    await shop.merchant.ship(order.id, { carrier: 'UPS', trackingNumber: 'T-REPLACED' });
    shop.clock.advanceSeconds(86_400);
    await shop.merchant.deliver(order.id);
    const dispute = await open(order.captureId!, 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', 'This is not what I ordered');
    const detail = await latest(dispute.id);
    expect(detail.analysis?.facts.F10.value).toBe(false);
    expect(detail.analysis?.decision).toMatchObject({ rule: 'NOT_AS_DESCRIBED_2_LISTING_DIFFERS' });
    expect(detail.actions[0]).toMatchObject({ actionType: 'make-offer', params: { offer_type: 'REFUND_WITH_REPLACEMENT' } });
    expect((await shop.disputes.approve(detail.actions[0]!.id, 'console:riley')).status).toBe('executed');
    expect((await shop.paypal.client.getDispute(dispute.id)).status).toBe('WAITING_FOR_BUYER_RESPONSE');
  });

  it('fights a not-as-described claim when the listing is unchanged', async () => {
    const { order } = await paidOrder();
    const dispute = await open(order.captureId!, 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', 'Looks different from the photos');
    const detail = await latest(dispute.id);
    expect(detail.analysis?.decision).toMatchObject({ rule: 'NOT_AS_DESCRIBED_1_LISTING_MATCHES' });
    expect(detail.actions[0]?.actionType).toBe('provide-evidence');
  });
});

describe('autopilot', () => {
  it('is off by default and can be switched on and off', async () => {
    expect(await shop.disputes.autopilot()).toBe(false);
    await shop.disputes.setAutopilot(true);
    expect(await shop.disputes.autopilot()).toBe(true);
    await shop.disputes.setAutopilot(false);
    expect(await shop.disputes.autopilot()).toBe(false);
  });

  it('answers clear-cut disputes on its own and records that it did', async () => {
    await shop.disputes.setAutopilot(true);
    const { order } = await paidOrder();
    const dispute = await open(order.captureId!, 'UNAUTHORISED', 'not me');
    const detail = await latest(dispute.id);
    expect(detail.actions[0]).toMatchObject({ status: 'executed', approvedBy: 'autopilot' });
    expect(detail.dispute.state).toBe('responded');
  });

  it('never acts on a dispute it had to escalate', async () => {
    await shop.disputes.setAutopilot(true);
    const { order } = await paidOrder();
    const dispute = await open(order.captureId!, 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'I did not authorize this', {});
    const detail = await latest(dispute.id);
    expect(detail.actions[0]).toMatchObject({ actionType: 'alert', status: 'proposed', approvedBy: null });
    expect(detail.dispute.state).toBe('escalated');
  });
});

describe('when PayPal will not do it', () => {
  it('records a refused action as failed and hands the dispute to a person', async () => {
    const { order } = await paidOrder();
    const dispute = await open(order.captureId!, 'UNAUTHORISED', 'not me');
    const [action] = (await latest(dispute.id)).actions;
    vi.spyOn(shop.paypal.client, 'provideEvidence').mockRejectedValueOnce(new PayPalError('boom', 422, 'UNPROCESSABLE_ENTITY', 'dbg'));
    const failed = await shop.disputes.approve(action!.id, 'console:riley');
    expect(failed).toMatchObject({ status: 'failed' });
    expect(failed.error).toMatch(/PayPal refused the provide-evidence: boom/);
    expect((await latest(dispute.id)).dispute.state).toBe('escalated');
  });

  it('fails an approval if the dispute moved on in the meantime', async () => {
    const { order } = await paidOrder();
    const dispute = await open(order.captureId!, 'UNAUTHORISED', 'not me');
    const [action] = (await latest(dispute.id)).actions;
    // Resolve it on PayPal's side without us hearing about it.
    sim().setWebhookSink(null);
    await shop.paypal.client.provideEvidence(dispute.id, { evidences: [{ evidenceType: 'OTHER', notes: 'x' }] }, 'pre-empt');
    await shop.paypal.client.sandboxAdjudicate(dispute.id, 'SELLER_FAVOR', 'y');
    const failed = await shop.disputes.approve(action!.id, 'console:riley');
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/now RESOLVED/);
    expect((await latest(dispute.id)).dispute.state).toBe('closed');
  });

  it('a later analysis supersedes the earlier proposal', async () => {
    const { order } = await paidOrder();
    const dispute = await open(order.captureId!, 'UNAUTHORISED', 'not me');
    const first = (await latest(dispute.id)).actions[0]!;
    const second = await shop.disputes.analyze(dispute.id);
    const actions = (await latest(dispute.id)).actions;
    expect(actions.find((a) => a.id === first.id)?.status).toBe('superseded');
    expect(actions.find((a) => a.id === second.action.id)?.status).toBe('proposed');
    await expect(shop.disputes.approve(first.id, 'x')).rejects.toThrow(/is superseded/);
  });
});

describe('reads', () => {
  it('lists disputes newest first, filtered by state', async () => {
    const a = await paidOrder();
    const first = await open(a.order.captureId!, 'UNAUTHORISED', 'not me');
    shop.clock.advanceSeconds(10);
    const b = await paidOrder({ ship: false });
    const second = await open(b.order.captureId!, 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'never came');
    expect((await shop.disputes.disputes()).map((d) => d.id)).toEqual([second.id, first.id]);
    expect((await shop.disputes.disputes({ state: 'awaiting_approval' })).length).toBe(2);
    expect((await shop.disputes.disputes({ state: 'closed' })).length).toBe(0);
    expect(await shop.disputes.dispute('nope')).toBeNull();
    await expect(shop.disputes.detail('nope')).rejects.toThrow(/unknown dispute/);
    expect(await shop.disputes.packetFile('nope')).toBeNull();
  });

  it('ingesting the same dispute twice does not duplicate anything', async () => {
    const { order } = await paidOrder();
    const dispute = await open(order.captureId!, 'UNAUTHORISED', 'not me');
    await shop.disputes.ingest(dispute.id);
    await shop.disputes.ingest(dispute.id);
    const detail = await latest(dispute.id);
    expect(detail.actions).toHaveLength(1);
    expect((await readChain(shop.db, 'ledger_entries', `dispute:${dispute.id}`)).filter((e) => e.type === 'dispute_received')).toHaveLength(1);
  });

  it('reports a dispute PayPal does not know', async () => {
    await expect(shop.disputes.ingest('PP-D-999999')).rejects.toBeInstanceOf(DisputeError);
  });

  it('ignores a dispute event with no dispute id', async () => {
    await shop.disputes.handleEvent({ id: 'WH-1', eventType: 'CUSTOMER.DISPUTE.CREATED', resourceType: 'dispute', createdAt: null, summary: null, resource: {} });
    expect(await shop.disputes.disputes()).toEqual([]);
  });
});
