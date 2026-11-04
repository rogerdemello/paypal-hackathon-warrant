import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LlmBudgetError, type LlmClient } from '../src/services/llm';
import { LlmNoteWriter, TemplateNoteWriter, groundingCorpus, ungroundedTokens, type NoteInput } from '../src/services/notes';
import { checkoutNew, makeShop, pay, type Shop } from './shop';

let shop: Shop;
beforeEach(async () => {
  shop = await makeShop();
});
afterEach(async () => {
  await shop.close();
});

/** Real facts, decision and case record from a disputed order, so the notes are tested on what the pipeline produces. */
async function realInput(options: { linked?: boolean; reason?: string; message?: string; ship?: boolean } = {}): Promise<NoteInput> {
  const purchase = await checkoutNew(shop, options.linked === false ? {} : { linkedPayerId: 'SIMPAYER0001' });
  const done = await pay(shop, purchase.result.orderId!);
  if (options.ship !== false) {
    await shop.merchant.ship(done.order.id, { carrier: 'UPS', trackingNumber: '1Z999AA10123456784' });
    shop.clock.advanceSeconds(86_400);
    await shop.merchant.deliver(done.order.id);
  }
  const created = shop.paypal.simulator!.openDispute({ captureId: done.order.captureId!, reason: options.reason ?? 'UNAUTHORISED', message: options.message ?? 'I did not authorize this' });
  await shop.paypal.simulator!.flush();
  const detail = await shop.disputes.detail(created.disputeId);
  const analysis = detail.analysis!;
  const cart = (await import('@warrant/warrant')).decodeBundle((await shop.merchant.bundleOf(done.order.cartJti!)) as never).cart;
  if (!cart.ok) throw new Error('cart');
  return {
    facts: analysis.facts,
    decision: analysis.decision,
    record: {
      disputeId: created.disputeId,
      reason: detail.dispute.reason,
      amountCents: detail.dispute.amountCents,
      currency: detail.dispute.currency,
      orderId: done.order.id,
      captureId: done.order.captureId,
      cartJti: cart.payload.jti,
      cartHash: analysis.facts.context.cartHash,
      consentApprovedAt: cart.payload.consent.approved_at ?? null,
      items: cart.payload.cart.items.map((i) => ({ title: i.title, qty: i.qty })),
      tracking: options.ship === false ? null : { carrier: 'UPS', number: '1Z999AA10123456784', deliveredAt: Math.floor(shop.clock.nowMs() / 1000) },
      refundIds: [],
      verifyUrl: `http://localhost:8787/v/${cart.payload.jti}`,
      merchantName: shop.config.merchantName,
    },
  };
}

const fakeLlm = (reply: string | Error): LlmClient => ({ complete: () => (reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply)) });

describe('template notes', () => {
  it('describe the case in plain words and are grounded in the record by construction', async () => {
    const input = await realInput();
    const notes = await new TemplateNoteWriter().write(input);
    expect(notes.source).toBe('template');
    expect(notes.memo).toContain(input.record.disputeId);
    expect(notes.memo).toContain(input.decision.rule);
    expect(notes.memo).toContain('Advisory');
    expect(notes.evidenceNote).toContain(input.record.cartJti);
    expect(notes.evidenceNote).toContain('1Z999AA10123456784');
    expect(notes.evidenceNote).toContain(input.record.verifyUrl);
    expect(notes.buyerMessage).toContain(input.record.disputeId);
    const corpus = groundingCorpus(input);
    for (const text of [notes.memo, notes.evidenceNote, notes.buyerMessage]) expect(ungroundedTokens(text, corpus)).toEqual([]);
  });

  it('says so plainly when there is no warrant', async () => {
    await shop.store.setMerchantMode('PERMISSIVE');
    const direct = await shop.merchant.directCheckout([{ sku: 'fx_desk_conv_32', qty: 1 }]);
    const done = await pay(shop, direct.orderId!);
    const created = shop.paypal.simulator!.openDispute({ captureId: done.order.captureId!, reason: 'UNAUTHORISED', message: 'not me' });
    await shop.paypal.simulator!.flush();
    const analysis = (await shop.disputes.detail(created.disputeId)).analysis!;
    const input: NoteInput = {
      facts: analysis.facts,
      decision: analysis.decision,
      record: { disputeId: created.disputeId, reason: 'UNAUTHORISED', amountCents: done.order.totalCents, currency: 'USD', orderId: done.order.id, captureId: done.order.captureId, cartJti: null, cartHash: null, consentApprovedAt: null, items: [], tracking: null, refundIds: [], verifyUrl: null, merchantName: 'Store' },
    };
    const notes = await new TemplateNoteWriter().write(input);
    expect(notes.evidenceNote).toContain('No signed warrant is on file');
    expect(notes.buyerMessage).toMatch(/in your favour/);
  });

  it('flags and ranks the facts without inventing any', async () => {
    const input = await realInput({ linked: false });
    const notes = await new TemplateNoteWriter().write(input);
    expect(notes.memo).toMatch(/Payer bound: no/);
    expect(notes.memo).toContain('UNAUTHORIZED_4_NO_PROOF');
    expect(notes.memo).toContain('Flags: flag_agent_platform, flag_case.');
  });
});

describe('grounding check', () => {
  it('finds identifiers, amounts and dates that are not in the record', async () => {
    const input = await realInput();
    const corpus = groundingCorpus(input);
    expect(ungroundedTokens(`Order ${input.record.orderId} for $89.00 was captured as ${input.record.captureId}`, corpus)).toEqual([]);
    expect(ungroundedTokens('Tracking 1Z999AA10123456785 was delivered on 2020-01-01', corpus).sort()).toEqual(['1Z999AA10123456785', '2020-01-01'].sort());
    expect(ungroundedTokens('We refunded $12.34 under refund SIMREF0000000099', corpus)).toEqual(expect.arrayContaining(['$12.34', 'SIMREF0000000099']));
    expect(ungroundedTokens('Reference sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA is not ours', corpus)).toHaveLength(1);
    expect(ungroundedTokens('Case PP-D-777777 was opened', corpus)).toEqual(['PP-D-777777']);
    expect(ungroundedTokens('A friendly message with no facts at all, only words.', corpus)).toEqual([]);
  });

  it('accepts amounts and dates in the forms the record implies', async () => {
    const input = await realInput();
    const corpus = groundingCorpus(input);
    expect(ungroundedTokens(`The total was ${(input.record.amountCents / 100).toFixed(2)} USD`, corpus)).toEqual([]);
    const deliveredIso = new Date((input.record.tracking!.deliveredAt as number) * 1000).toISOString().slice(0, 10);
    expect(ungroundedTokens(`Delivered ${deliveredIso}`, corpus)).toEqual([]);
  });
});

describe('model notes', () => {
  it('are used when every identifier, amount and date is already in the record', async () => {
    const input = await realInput();
    const good = JSON.stringify({
      memo: `Dispute ${input.record.disputeId} concerns ${(input.record.amountCents / 100).toFixed(2)} USD. The signed record supports the sale.`,
      evidence_note: `The buyer's wallet signed cart ${input.record.cartJti}. Tracking ${input.record.tracking?.number} shows delivery.`,
      buyer_message: 'Thank you for getting in touch. We have reviewed your purchase record.',
    });
    const notes = await new LlmNoteWriter(fakeLlm(good)).write(input);
    expect(notes.source).toBe('model');
    expect(notes.memo).toContain('Advisory');
    expect(notes.evidenceNote).toContain(input.record.cartJti);
  });

  it('are discarded for the template when the model invents a fact', async () => {
    const input = await realInput();
    const bad = JSON.stringify({
      memo: 'Fine.',
      evidence_note: 'Tracking 1Z000000000000000 shows the parcel was signed for on 2019-03-04, and $500.00 was refunded.',
      buyer_message: 'Hello.',
    });
    const notes = await new LlmNoteWriter(fakeLlm(bad)).write(input);
    expect(notes.source).toBe('template (model output rejected)');
    expect(notes.rejectedBecause?.join(' ')).toMatch(/1Z000000000000000/);
    expect(notes.rejectedBecause?.join(' ')).toMatch(/2019-03-04/);
    expect(notes.rejectedBecause?.join(' ')).toMatch(/\$500\.00/);
    const template = await new TemplateNoteWriter().write(input);
    expect(notes.evidenceNote).toBe(template.evidenceNote);
  });

  it('fall back when the answer is malformed, incomplete, too long or the model is unavailable', async () => {
    const input = await realInput();
    for (const reply of ['sorry, I cannot', '{"memo": "only one"}', JSON.stringify({ memo: 'a', evidence_note: 'b'.repeat(5000), buyer_message: 'c' }), JSON.stringify({ memo: '', evidence_note: 'b', buyer_message: 'c' })]) {
      expect((await new LlmNoteWriter(fakeLlm(reply)).write(input)).source).toBe('template (model output rejected)');
    }
    const budget = await new LlmNoteWriter(fakeLlm(new LlmBudgetError('over budget', 'daily_budget'))).write(input);
    expect(budget).toMatchObject({ source: 'template (model output rejected)', rejectedBecause: ['over budget'] });
    await expect(new LlmNoteWriter(fakeLlm(new TypeError('bug'))).write(input)).rejects.toThrow('bug');
  });
});

describe('autopilot on a case the table is unsure about', () => {
  it('leaves a first-time buyer\'s weak case for a person', async () => {
    await shop.disputes.setAutopilot(true);
    const purchase = await checkoutNew(shop);
    const done = await pay(shop, purchase.result.orderId!);
    await shop.merchant.ship(done.order.id, { carrier: 'UPS', trackingNumber: 'T1' });
    await shop.merchant.deliver(done.order.id);
    const created = shop.paypal.simulator!.openDispute({ captureId: done.order.captureId!, reason: 'UNAUTHORISED', message: 'not me' });
    await shop.paypal.simulator!.flush();
    const detail = await shop.disputes.detail(created.disputeId);
    expect(detail.analysis?.decision).toMatchObject({ rule: 'UNAUTHORIZED_4_NO_PROOF', confidence: 'low' });
    expect(detail.actions[0]).toMatchObject({ actionType: 'provide-evidence', status: 'proposed', approvedBy: null });
    expect(detail.dispute.state).toBe('awaiting_approval');
  });
});
