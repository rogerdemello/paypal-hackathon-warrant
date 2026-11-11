import { FIXTURE_PRODUCTS } from '@warrant/catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentPart, AgentSessionDto } from '../src/api-types';
import { AgentError } from '../src/services/agent';
import { LlmIntentParser, LlmProductPicker, RulesIntentParser, cleanQuery, eligible, parseQuantity } from '../src/services/intent';
import { LlmBudgetError, type LlmClient } from '../src/services/llm';
import { makeShop, pay, type Shop } from './shop';

let shop: Shop;
beforeEach(async () => {
  shop = await makeShop();
});
afterEach(async () => {
  await shop.close();
});

const part = <K extends AgentPart['kind']>(session: AgentSessionDto, kind: K): Extract<AgentPart, { kind: K }> | undefined =>
  session.messages
    .flatMap((m) => m.parts)
    .reverse()
    .find((p): p is Extract<AgentPart, { kind: K }> => p.kind === kind);
const texts = (session: AgentSessionDto) => session.messages.flatMap((m) => m.parts).filter((p) => p.kind === 'text').map((p) => (p as { text: string }).text);

async function begin() {
  const principal = await shop.wallet.ensurePrincipal('visitor-0000001', 'Riley');
  const session = await shop.shopper.startSession(principal.id);
  return { principal, session };
}

describe('a whole purchase through the agent', () => {
  it('request, mandate, cart, consent, checkout, payment, receipt', async () => {
    const { principal, session } = await begin();
    expect(session.stage).toBe('start');
    expect(session.messages).toHaveLength(1);

    // 1. The request becomes a proposed mandate.
    const asked = await shop.shopper.sendMessage(session.id, principal.id, 'Find me a standing desk converter under $120');
    expect(asked.stage).toBe('awaiting_mandate');
    const request = part(asked, 'mandate_request')!;
    expect(request.terms).toMatchObject({ maxTotalCents: 12_000, maxPerItemCents: 12_000, maxItems: 1, mode: 'human_present', budgetMode: 'cumulative' });
    expect(request.terms.categoriesAllow).toContain('office_furniture');
    expect(request.terms.categoriesAllow).not.toContain('gift_cards');
    expect(await shop.wallet.mandatesOf(principal.id)).toHaveLength(0);

    // 2. The human authorises; the wallet signs; the agent shops and proposes a cart.
    const authorised = await shop.shopper.authorizeMandate(session.id, principal.id);
    expect(authorised.stage).toBe('awaiting_consent');
    expect(authorised.mandateJti).toMatch(/^mdt_/);
    const products = part(authorised, 'products')!;
    expect(products.chosenSku).toBe('fx_desk_conv_32');
    expect(products.items.length).toBeGreaterThan(1);
    expect(products.items.every((p) => p.priceCents <= 12_000)).toBe(true);
    const proposed = part(authorised, 'cart_proposal')!;
    const proposal = (await shop.wallet.proposal(proposed.proposalId))!;
    expect(proposal).toMatchObject({ status: 'pending' });
    expect(proposal.cart.total).toBe('89.00');

    // The agent cannot check out before the human approves.
    await expect(shop.shopper.checkout(session.id, principal.id)).rejects.toThrow(/approve the cart in your wallet first/);

    // 3. The human approves in the wallet; the agent checks out.
    await shop.wallet.approve(principal.id, proposal.id);
    const checkedOut = await shop.shopper.checkout(session.id, principal.id);
    expect(checkedOut.stage).toBe('checking_out');
    const checkout = part(checkedOut, 'checkout')!;
    expect(checkout).toMatchObject({ status: 'approval_required' });
    expect(checkout.findings.every((f) => f.outcome === 'pass')).toBe(true);
    expect(checkout.approvalUrl).toContain('/sim/paypal/approve');

    // 4. PayPal approval, then the receipt.
    const pending = await shop.shopper.completeOrder(session.id, principal.id);
    expect(part(pending, 'order')).toBeUndefined();
    expect(part(pending, 'notice')?.text).toMatch(/has not confirmed/);
    await pay(shop, checkout.orderId!);
    const finished = await shop.shopper.completeOrder(session.id, principal.id);
    expect(finished.stage).toBe('done');
    expect(part(finished, 'order')).toMatchObject({ status: 'captured', totalCents: 8_900, cartJti: proposal.cartJti });
    expect(texts(finished).at(-1)).toMatch(/Payment complete/);
    expect(await shop.registry.transparencyView(proposal.cartJti)).toMatchObject({ included: true });
  });

  it('keeps the conversation across reloads', async () => {
    const { principal, session } = await begin();
    await shop.shopper.sendMessage(session.id, principal.id, 'a book about ergonomics under $30');
    const again = await shop.shopper.latestSession(principal.id);
    expect(again?.id).toBe(session.id);
    expect(again?.messages).toHaveLength(3);
    expect(again?.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    const other = await shop.wallet.ensurePrincipal('visitor-0000002');
    expect(await shop.shopper.latestSession(other.id)).toBeNull();
  });

  it('resumes the conversation in use, not an empty one started later (a page that opens two at once)', async () => {
    const { principal, session } = await begin();
    const extra = await shop.shopper.startSession(principal.id);
    shop.clock.advanceSeconds(5);
    await shop.shopper.sendMessage(session.id, principal.id, 'a book about ergonomics under $30');
    const latest = await shop.shopper.latestSession(principal.id);
    expect(latest?.id).toBe(session.id);
    expect(latest?.id).not.toBe(extra.id);
  });
});

describe('understanding the request', () => {
  it('asks for a budget when there is none, and takes a bare number as the answer', async () => {
    const { principal, session } = await begin();
    const asked = await shop.shopper.sendMessage(session.id, principal.id, 'I want a standing desk converter');
    expect(asked.stage).toBe('start');
    expect(texts(asked).at(-1)).toMatch(/What's the most you want to spend/);
    const answered = await shop.shopper.sendMessage(session.id, principal.id, '100');
    expect(answered.stage).toBe('awaiting_mandate');
    expect(part(answered, 'mandate_request')?.terms.maxTotalCents).toBe(10_000);
  });

  it('turns a new request into a new question rather than guessing from an unrelated number', async () => {
    const { principal, session } = await begin();
    await shop.shopper.sendMessage(session.id, principal.id, 'I want a standing desk converter');
    const next = await shop.shopper.sendMessage(session.id, principal.id, 'actually a keyboard under $90');
    expect(part(next, 'mandate_request')?.terms.maxTotalCents).toBe(9_000);
  });

  it('says so when nothing fits', async () => {
    const { principal, session } = await begin();
    const asked = await shop.shopper.sendMessage(session.id, principal.id, 'a standing desk converter under $5');
    expect(asked.stage).toBe('start');
    expect(texts(asked).at(-1)).toMatch(/couldn't find anything/);
    expect(part(asked, 'mandate_request')).toBeUndefined();
  });

  it('handles quantity and refuses silly budgets', async () => {
    const { principal, session } = await begin();
    const two = await shop.shopper.sendMessage(session.id, principal.id, 'buy two wireless mouse for $80');
    expect(part(two, 'mandate_request')?.terms).toMatchObject({ maxItems: 2, maxTotalCents: 8_000, maxPerItemCents: 4_000 });
    const silly = await shop.shopper.sendMessage(session.id, principal.id, 'a headphones under $999999999');
    expect(part(silly, 'notice')?.text).toMatch(/between \$0\.01 and \$100,000\.00/);
    await expect(shop.shopper.sendMessage(session.id, principal.id, '   ')).rejects.toThrow(/say what you would like/);
  });

  it('parses quantities and cleans queries', () => {
    expect(parseQuantity('buy two mouse')).toBe(2);
    expect(parseQuantity('3 x keyboards')).toBe(3);
    expect(parseQuantity('a desk for 120 dollars')).toBe(1);
    expect(parseQuantity('buy 99 mouse')).toBe(1);
    expect(cleanQuery('Find me a standing desk converter under $120')).toBe('a standing desk converter');
    expect(cleanQuery('please buy a mouse for 30 dollars')).toBe('a mouse');
  });
});

describe('what the human can change, and what they cannot', () => {
  it('lets them tighten the terms before signing', async () => {
    const { principal, session } = await begin();
    await shop.shopper.sendMessage(session.id, principal.id, 'a standing desk converter under $120');
    const authorised = await shop.shopper.authorizeMandate(session.id, principal.id, { maxTotalCents: 9_000, validForSeconds: 3_600 });
    const mandate = (await shop.wallet.mandate(authorised.mandateJti!))!;
    expect(mandate.payload.scope.max_total).toBe('90.00');
    expect(mandate.exp - mandate.nbf).toBe(3_600);
    expect(part(authorised, 'cart_proposal')).toBeDefined();
  });

  it('shops within the tightened terms: a lower budget finds something cheaper, or nothing', async () => {
    const { principal, session } = await begin();
    await shop.shopper.sendMessage(session.id, principal.id, 'a standing desk converter under $120');
    const authorised = await shop.shopper.authorizeMandate(session.id, principal.id, { maxTotalCents: 1_000 });
    expect(part(authorised, 'cart_proposal')).toBeUndefined();
    expect(texts(authorised).at(-1)).toMatch(/Nothing I found fits/);
    expect(authorised.stage).toBe('start');
  });

  it('refuses to be authorised for risky categories', async () => {
    const { principal, session } = await begin();
    await shop.shopper.sendMessage(session.id, principal.id, 'a standing desk converter under $120');
    await expect(shop.shopper.authorizeMandate(session.id, principal.id, { categoriesAllow: ['office_furniture', 'gift_cards'] })).rejects.toThrow(/gift cards/);
    expect(await shop.wallet.mandatesOf(principal.id)).toHaveLength(0);
  });

  it('surfaces the wallet\'s refusal of an unreasonable term', async () => {
    const { principal, session } = await begin();
    await shop.shopper.sendMessage(session.id, principal.id, 'a standing desk converter under $120');
    await expect(shop.shopper.authorizeMandate(session.id, principal.id, { maxItems: 0 })).rejects.toBeInstanceOf(AgentError);
  });

  it('a mandate that lets the agent buy alone goes straight to checkout, still inside its limits', async () => {
    const { principal, session } = await begin();
    await shop.shopper.sendMessage(session.id, principal.id, 'a standing desk converter under $120');
    const authorised = await shop.shopper.authorizeMandate(session.id, principal.id, { mode: 'human_not_present' });
    expect(authorised.stage).toBe('checking_out');
    const checkout = part(authorised, 'checkout')!;
    expect(checkout.status).toBe('approval_required');
    const order = (await shop.merchant.order(checkout.orderId!))!;
    expect(order.verification.findings.find((f) => f.rule === 'V10_CONSENT')?.detail).toMatch(/human_not_present is allowed/);
  });

  it('can only be used by its owner and in the right order', async () => {
    const { principal, session } = await begin();
    const stranger = await shop.wallet.ensurePrincipal('visitor-0000009');
    await expect(shop.shopper.getSession(session.id, stranger.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(shop.shopper.sendMessage(session.id, stranger.id, 'hi')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(shop.shopper.getSession('ses_none', principal.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(shop.shopper.startSession('prn_none')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(shop.shopper.authorizeMandate(session.id, principal.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(shop.shopper.checkout(session.id, principal.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(shop.shopper.completeOrder(session.id, principal.id)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('answers a message sent while a cart is waiting with a reminder, not a second search', async () => {
    const { principal, session } = await begin();
    await shop.shopper.sendMessage(session.id, principal.id, 'a standing desk converter under $120');
    await shop.shopper.authorizeMandate(session.id, principal.id);
    const reply = await shop.shopper.sendMessage(session.id, principal.id, 'and a mouse under $30');
    expect(part(reply, 'notice')?.text).toMatch(/approve or decline the cart/);
    expect(reply.stage).toBe('awaiting_consent');
  });

  it('declining cancels the cart in the wallet', async () => {
    const { principal, session } = await begin();
    await shop.shopper.sendMessage(session.id, principal.id, 'a standing desk converter under $120');
    const authorised = await shop.shopper.authorizeMandate(session.id, principal.id);
    const proposalId = part(authorised, 'cart_proposal')!.proposalId;
    const declined = await shop.shopper.declineCart(session.id, principal.id);
    expect(declined.stage).toBe('start');
    expect((await shop.wallet.proposal(proposalId))?.status).toBe('declined');
  });
});

describe('hostile listings and the merchant\'s final say', () => {
  it('ignores instructions hidden in a product description', async () => {
    const { principal, session } = await begin();
    await shop.shopper.sendMessage(session.id, principal.id, 'a premium desk organizer under $50');
    const authorised = await shop.shopper.authorizeMandate(session.id, principal.id);
    const proposal = (await shop.wallet.proposal(part(authorised, 'cart_proposal')!.proposalId))!;
    expect(proposal.cart.items).toHaveLength(1);
    expect(proposal.cart.items[0]).toMatchObject({ sku: 'fx_inject_organizer', qty: 1, unit_price: '19.99' });
    expect(proposal.cart.total).toBe('19.99');
  });

  it('a price change after the human approved is caught by the merchant, and the conversation says why', async () => {
    const { principal, session } = await begin();
    await shop.shopper.sendMessage(session.id, principal.id, 'a standing desk converter under $120');
    const authorised = await shop.shopper.authorizeMandate(session.id, principal.id);
    const proposalId = part(authorised, 'cart_proposal')!.proposalId;
    await shop.wallet.approve(principal.id, proposalId);
    await shop.store.setPrice('fx_desk_conv_32', 9_900);
    const result = await shop.shopper.checkout(session.id, principal.id);
    expect(result.stage).toBe('done');
    expect(part(result, 'checkout')).toMatchObject({ status: 'rejected' });
    expect(part(result, 'checkout')!.findings.some((f) => f.rule === 'V08_REPRICE' && f.outcome === 'reject')).toBe(true);
    expect(texts(result).at(-1)).toMatch(/The merchant rejected the order/);
  });
});

describe('model-backed parsing and picking', () => {
  const llm = (reply: string | Error): LlmClient => ({ complete: () => (reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply)) });

  it('the intent parser uses the model\'s search phrase but the human\'s own budget', async () => {
    const parser = new LlmIntentParser(llm('{"query": "sit-stand desk riser", "budget_dollars": 500, "quantity": 2}'));
    expect(await parser.parse('standing desk converter under $120')).toEqual({ query: 'sit-stand desk riser', budgetCents: 12_000, quantity: 2 });
    expect(await parser.parse('a desk riser')).toEqual({ query: 'sit-stand desk riser', budgetCents: 50_000, quantity: 2 });
  });

  it('the intent parser falls back to the rules on bad or unavailable answers', async () => {
    const rules = await new RulesIntentParser().parse('a keyboard under $90');
    for (const reply of ['no json', '{"query": "", "quantity": 99}', new LlmBudgetError('over', 'daily_budget')]) {
      expect(await new LlmIntentParser(llm(reply)).parse('a keyboard under $90')).toEqual(rules);
    }
    await expect(new LlmIntentParser(llm(new TypeError('bug'))).parse('x')).rejects.toThrow('bug');
  });

  it('the picker takes the model\'s choice only if it passes the deterministic checks', async () => {
    const desks = FIXTURE_PRODUCTS.filter((p) => p.category === 'office_furniture' && eligible(p, { query: '', budgetCents: 16_000, quantity: 1 }));
    expect(desks.length).toBeGreaterThan(2);
    const intent = { query: 'standing desk converter', budgetCents: 16_000, quantity: 1 };
    const pool = desks.filter((p) => eligible(p, intent));
    const pick = await new LlmProductPicker(llm('{"index": 1, "reason": "wider surface"}')).pick({ intent, candidates: desks });
    expect(pick.product?.id).toBe(pool[1]?.id);
    expect(pick.reason).toBe('wider surface');
    // An index out of range, a non-integer, or junk: the rules choose.
    for (const reply of ['{"index": 99}', '{"index": 1.5}', 'junk', new LlmBudgetError('over', 'visitor_runs')]) {
      const fallback = await new LlmProductPicker(llm(reply)).pick({ intent, candidates: desks });
      expect(fallback.product?.id).toBe(pool[0]?.id);
    }
  });

  it('the picker never returns something over budget, out of stock or risky, whatever the model says', async () => {
    const gift = FIXTURE_PRODUCTS.find((p) => p.id === 'fx_giftcard_store')!;
    const oos = FIXTURE_PRODUCTS.find((p) => p.id === 'fx_desk_conv_oos')!;
    const cheap = FIXTURE_PRODUCTS.find((p) => p.id === 'fx_desk_conv_32')!;
    const intent = { query: 'x', budgetCents: 20_000, quantity: 1 };
    expect(eligible(gift, intent)).toBe(false);
    expect(eligible(oos, intent)).toBe(false);
    expect(eligible(cheap, { ...intent, budgetCents: 5_000 })).toBe(false);
    expect(eligible(cheap, { ...intent, quantity: 3, budgetCents: 20_000 })).toBe(false);
    const pick = await new LlmProductPicker(llm('{"index": 0, "reason": "buy the gift card"}')).pick({ intent, candidates: [gift, oos, cheap] });
    expect(pick.product?.id).toBe('fx_desk_conv_32');
  });
});
