import { describe, expect, it } from 'vitest';
import { hashText } from '../src/canonical';
import { computeFacts } from '../src/facts';
import { staticRegistry } from '../src/registry';
import type { CartPayload } from '../src/schema';
import { buildHumanPresentConsent, makeBundle, signCart, signConsent, signMandate } from '../src/warrant';
import { KIDS, LISTING_HASH, PAYER_ID, PRESENTED_HASH, SKU, T0, factsInput, makeWorld } from './fixtures';

const DAY = 86_400;

describe('computeFacts: a clean warrant', () => {
  it('establishes F1-F10 and F13, with F11 false and F12 in hours', async () => {
    const w = await makeWorld();
    const facts = await computeFacts(factsInput(w));
    for (const id of ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F13'] as const) {
      expect([id, facts[id].value]).toEqual([id, true]);
    }
    expect(facts.F11.value).toBe(false);
    expect(facts.F12.value).toBe(120);
    expect(facts.context).toMatchObject({
      merchantMode: 'STRICT',
      disputeId: 'PP-D-1',
      captureId: 'CAP1',
      orderId: 'ORDER1',
      cartJti: 'crt_01JEXAMPLE',
      mandateJti: 'mnd_01JEXAMPLE',
      mandateHash: w.mandateHash,
      cartHash: w.cartHash,
    });
    expect(facts.F5.detail).toEqual({ orderMatchesBundleCart: true, bundleCartMatchesConsent: true, linesCompared: true });
  });

  it('carries evidence references for every fact', async () => {
    const w = await makeWorld();
    const facts = await computeFacts(factsInput(w));
    for (const id of ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'F13'] as const) {
      expect(facts[id].evidence.length).toBeGreaterThan(0);
      expect(facts[id].id).toBe(id);
    }
    expect(facts.F2.evidence).toContain(`cart:valid:kid=${KIDS.agent}`);
    expect(facts.F5.evidence).toContain(`cart_hash:${w.cartHash}`);
  });

  it('is deterministic', async () => {
    const w = await makeWorld();
    expect(await computeFacts(factsInput(w))).toEqual(await computeFacts(factsInput(w)));
  });

  it('works for a human_not_present warrant the mandate allows', async () => {
    const w = await makeWorld({ scopeMode: 'human_not_present' });
    const facts = await computeFacts(factsInput(w));
    expect([facts.F2.value, facts.F4.value, facts.F5.value]).toEqual([true, true, true]);
  });
});

describe('F1 warrant_present and F2 signatures_valid', () => {
  it('F1 is false and everything warrant-derived is false when no bundle is stored', async () => {
    const w = await makeWorld();
    for (const bundle of [null, undefined]) {
      const facts = await computeFacts(factsInput(w, { bundle }));
      expect(facts.F1.value).toBe(false);
      for (const id of ['F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F10'] as const) expect(facts[id].value).toBe(false);
      expect(facts.F9.value).toBe(true); // delivery does not depend on the warrant
    }
  });

  it('F1 is true but F2 is false when the stored bundle is malformed', async () => {
    const w = await makeWorld();
    const facts = await computeFacts(factsInput(w, { bundle: '{ not json' }));
    expect(facts.F1.value).toBe(true);
    expect(facts.F2.value).toBe(false);
    expect(facts.F2.evidence[0]).toContain('malformed');
  });

  it('F2 is false for a forged cart signature, a forged mandate signature, and an unknown kid', async () => {
    const w = await makeWorld();
    const forgedCart = await signCart(w.cart, w.keys.stranger.privateKey, KIDS.agent);
    expect((await computeFacts(factsInput(w, { bundle: makeBundle(w.mandateJws, forgedCart.jws) }))).F2.detail).toMatchObject({ cart: false, mandate: true });
    const forgedMandate = await signMandate(w.mandate, w.keys.stranger.privateKey, KIDS.wallet);
    expect((await computeFacts(factsInput(w, { bundle: makeBundle(forgedMandate.jws, w.cartJws) }))).F2.detail).toMatchObject({ cart: true, mandate: false });
    expect((await computeFacts(factsInput(w, { registry: () => null }))).F2.value).toBe(false);
  });

  it('F2 is false when the consent signature does not cover the cart', async () => {
    const w = await makeWorld();
    const other = await w.otherCart([{ sku: SKU, title: 'Desk converter 32in', qty: 2, unitPriceCents: 4450, listingHash: LISTING_HASH }], { consent: w.cart.consent });
    const facts = await computeFacts(factsInput(w, { bundle: makeBundle(w.mandateJws, other.jws) }));
    expect(facts.F2.value).toBe(false);
    expect(facts.F2.detail).toMatchObject({ cart: true, mandate: true, consent: false });
  });
});

describe('F3 keys_active_at_issue', () => {
  it('is false when a key was revoked before the warrant was issued', async () => {
    const w = await makeWorld();
    const registry = staticRegistry([w.registryKeys.wallet, { ...w.registryKeys.agent, status: 'revoked', statusChangedAt: T0 + 100 }]);
    expect((await computeFacts(factsInput(w, { registry }))).F3.value).toBe(false);
  });

  it('is true for a key revoked after issue: past evidence stays valid', async () => {
    const w = await makeWorld();
    const registry = staticRegistry([w.registryKeys.wallet, { ...w.registryKeys.agent, status: 'revoked', statusChangedAt: T0 + 2 * DAY }]);
    expect((await computeFacts(factsInput(w, { registry }))).F3.value).toBe(true);
  });

  it('uses the transparency-log time when the signed iat was backdated', async () => {
    const w = await makeWorld();
    // The agent key was revoked at T0+1000, but the (backdated) cart claims iat T0+600. The log says it was really recorded at T0+2000.
    const registry = staticRegistry([w.registryKeys.wallet, { ...w.registryKeys.agent, status: 'revoked', statusChangedAt: T0 + 1000 }]);
    const withLog = await computeFacts(factsInput(w, { registry, transparency: { included: true, seq: 1, entryHash: hashText('e'), loggedAt: T0 + 2000 } }));
    expect(withLog.F3.value).toBe(false);
    const withoutLog = await computeFacts(factsInput(w, { registry, transparency: null }));
    expect(withoutLog.F3.value).toBe(true); // only the self-declared iat is available
  });

  it('is false for an unknown key or an undecodable warrant', async () => {
    const w = await makeWorld();
    expect((await computeFacts(factsInput(w, { registry: () => null }))).F3.value).toBe(false);
    expect((await computeFacts(factsInput(w, { bundle: null }))).F3.value).toBe(false);
  });
});

describe('F4 consent_valid', () => {
  it('is false when the wallet recorded a different screen', async () => {
    const w = await makeWorld();
    const facts = await computeFacts(factsInput(w, { walletRecord: () => ({ presentedHash: hashText('another screen') }) }));
    expect(facts.F4.value).toBe(false);
  });

  it('is false when the wallet has no record', async () => {
    const w = await makeWorld();
    expect((await computeFacts(factsInput(w, { walletRecord: () => null }))).F4.value).toBe(false);
  });

  it('is false when the mandate required a human but the cart claims none', async () => {
    const w = await makeWorld({ scopeMode: 'human_present', consentMode: 'human_not_present' });
    expect((await computeFacts(factsInput(w))).F4.value).toBe(false);
  });

  it('is false when the consent covers a different cart', async () => {
    const w = await makeWorld();
    const other = await w.otherCart([{ sku: SKU, title: 'Desk converter 32in', qty: 2, unitPriceCents: 4450, listingHash: LISTING_HASH }], { consent: w.cart.consent });
    w.walletRecords.set(other.cart.jti, { presentedHash: PRESENTED_HASH });
    expect((await computeFacts(factsInput(w, { bundle: makeBundle(w.mandateJws, other.jws) }))).F4.value).toBe(false);
  });
});

describe('F5 order_matches_consent', () => {
  it('is false for a different total, currency or line, and when there is no order', async () => {
    const w = await makeWorld();
    const base = factsInput(w).order!;
    for (const order of [
      { ...base, totalCents: 9900 },
      { ...base, currency: 'EUR' },
      { ...base, lines: [{ sku: SKU, quantity: 2, unitAmountCents: 4450 }] },
      { ...base, lines: [{ sku: 'other', quantity: 1, unitAmountCents: 8900 }] },
      { ...base, lines: [{ sku: null, quantity: 1, unitAmountCents: 8900 }] },
      { ...base, lines: [] },
    ]) {
      const facts = await computeFacts(factsInput(w, { order }));
      expect(facts.F5.value).toBe(false);
      expect(facts.F5.detail).toMatchObject({ orderMatchesBundleCart: false, bundleCartMatchesConsent: true });
    }
    expect((await computeFacts(factsInput(w, { order: null }))).F5.value).toBe(false);
  });

  it('compares only the amount when the order carries no line items, and says so', async () => {
    const w = await makeWorld();
    const facts = await computeFacts(factsInput(w, { order: { ...factsInput(w).order!, lines: null } }));
    expect(facts.F5.value).toBe(true);
    expect(facts.F5.detail).toMatchObject({ linesCompared: false });
  });

  it('is false when the agent shipped a cart the human did not approve, even if the order matches the shipped cart', async () => {
    const w = await makeWorld();
    const pricier = await w.otherCart([{ sku: SKU, title: 'Desk converter 32in', qty: 1, unitPriceCents: 11_900, listingHash: LISTING_HASH }], { consent: w.cart.consent });
    const order = { id: 'ORDER2', currency: 'USD', totalCents: 11_900, payerId: PAYER_ID, lines: [{ sku: SKU, quantity: 1, unitAmountCents: 11_900 }] };
    const facts = await computeFacts(factsInput(w, { bundle: makeBundle(w.mandateJws, pricier.jws), order }));
    expect(facts.F5.value).toBe(false);
    expect(facts.F5.detail).toMatchObject({ orderMatchesBundleCart: true, bundleCartMatchesConsent: false });
  });

  it('human_not_present: the order is compared with the warrant cart only', async () => {
    const w = await makeWorld({ scopeMode: 'human_not_present' });
    expect((await computeFacts(factsInput(w))).F5.value).toBe(true);
    expect((await computeFacts(factsInput(w, { order: { ...factsInput(w).order!, totalCents: 1 } }))).F5.value).toBe(false);
  });

  it('is false when the consent cart_hash is right but cart_hash itself is not the hash of the cart', async () => {
    const w = await makeWorld();
    const edited: CartPayload = { ...w.cart, cart: { ...w.cartBody, total: '1.00' } };
    const bundle = await w.resign({ cart: edited });
    const facts = await computeFacts(factsInput(w, { bundle, order: { ...factsInput(w).order!, totalCents: 100 } }));
    expect(facts.F5.value).toBe(false);
  });
});

describe('F6 within_mandate, F7 payer_bound, F8 nonce_unique', () => {
  it('F6 is false outside the mandate scope', async () => {
    const w = await makeWorld({ scope: { maxTotalCents: 5000 } });
    expect((await computeFacts(factsInput(w))).F6.value).toBe(false);
  });

  it('F6 uses the merchant category function', async () => {
    const w = await makeWorld({ scope: { categoriesAllow: ['books'] } });
    expect((await computeFacts(factsInput(w))).F6.value).toBe(false);
    const ok = await makeWorld({ scope: { categoriesAllow: ['office_furniture'] } });
    expect((await computeFacts(factsInput(ok))).F6.value).toBe(true);
  });

  it('F7 requires the order payer to hash to the mandate principal', async () => {
    const w = await makeWorld();
    const order = factsInput(w).order!;
    expect((await computeFacts(factsInput(w, { order: { ...order, payerId: 'SOMEONEELSE' } }))).F7.value).toBe(false);
    expect((await computeFacts(factsInput(w, { order: { ...order, payerId: null } }))).F7.value).toBe(false);
    expect((await computeFacts(factsInput(w, { order: null }))).F7.value).toBe(false);
    const unbound = await makeWorld({ payerBound: false });
    expect((await computeFacts(factsInput(unbound))).F7.value).toBe(false); // trust-on-first-use alone does not bind
  });

  it('F8 is true only for exactly one use of the nonce', async () => {
    const w = await makeWorld();
    for (const [count, expected] of [[0, false], [1, true], [2, false], [7, false]] as const) {
      expect((await computeFacts(factsInput(w, { nonceUseCount: count }))).F8.value).toBe(expected);
    }
  });
});

describe('F9 delivered, F10 listing_matches, F11 already_refunded', () => {
  it('F9 reports delivery and whether it was on time', async () => {
    const w = await makeWorld();
    const on = await computeFacts(factsInput(w));
    expect(on.F9.value).toBe(true);
    expect(on.F9.detail).toMatchObject({ onTime: true });
    const late = await computeFacts(factsInput(w, { tracking: { delivered: true, deliveredAt: T0 + 5 * DAY, promisedBy: T0 + 3 * DAY, trackingNumber: 'T' } }));
    expect(late.F9.value).toBe(true);
    expect(late.F9.detail).toMatchObject({ onTime: false });
    const undelivered = await computeFacts(factsInput(w, { tracking: { delivered: false, deliveredAt: null, promisedBy: T0 + 3 * DAY, trackingNumber: 'T' } }));
    expect([undelivered.F9.value, undelivered.F9.detail?.['onTime']]).toEqual([false, false]);
    expect((await computeFacts(factsInput(w, { tracking: null }))).F9.value).toBe(false);
  });

  it('F9: with no promised date any delivery counts as on time; delivered with no date cannot prove on time against a promise', async () => {
    const w = await makeWorld();
    const noPromise = await computeFacts(factsInput(w, { tracking: { delivered: true, deliveredAt: T0 + 9 * DAY, promisedBy: null, trackingNumber: null } }));
    expect(noPromise.F9.detail).toMatchObject({ onTime: true });
    const noDate = await computeFacts(factsInput(w, { tracking: { delivered: true, deliveredAt: null, promisedBy: T0 + DAY, trackingNumber: null } }));
    expect(noDate.F9.detail).toMatchObject({ onTime: false });
  });

  it('F10 compares each warrant line with what was fulfilled', async () => {
    const w = await makeWorld();
    expect((await computeFacts(factsInput(w, { fulfilledListings: { [SKU]: hashText('a different listing') } }))).F10.value).toBe(false);
    expect((await computeFacts(factsInput(w, { fulfilledListings: {} }))).F10.value).toBe(false);
    expect((await computeFacts(factsInput(w, { fulfilledListings: null }))).F10.value).toBe(false);
    const facts = await computeFacts(factsInput(w));
    expect(facts.context.listings).toEqual([{ sku: SKU, warrantListingHash: LISTING_HASH, fulfilledListingHash: LISTING_HASH }]);
  });

  it('F11 is true when any refund exists', async () => {
    const w = await makeWorld();
    const facts = await computeFacts(factsInput(w, { refunds: [{ id: 'REF1', amountCents: 8900 }] }));
    expect(facts.F11.value).toBe(true);
    expect(facts.F11.evidence).toEqual(['refund:REF1:8900']);
  });
});

describe('F12 deadline_hours and F13 amount_ok', () => {
  it('F12 is the hours left, possibly negative, or null when unknown', async () => {
    const w = await makeWorld();
    const now = T0 + 3 * DAY;
    expect((await computeFacts(factsInput(w, { dispute: { id: 'D', disputedAmountCents: 1, responseDueBy: now + 36 * 3600 } }))).F12.value).toBe(36);
    expect((await computeFacts(factsInput(w, { dispute: { id: 'D', disputedAmountCents: 1, responseDueBy: now - 7200 } }))).F12.value).toBe(-2);
    expect((await computeFacts(factsInput(w, { dispute: { id: 'D', disputedAmountCents: 1, responseDueBy: null } }))).F12.value).toBeNull();
    expect((await computeFacts(factsInput(w, { now: Number.NaN }))).F12.value).toBeNull();
  });

  it('F13 is false when the dispute exceeds the capture or there is no capture', async () => {
    const w = await makeWorld();
    const due = T0 + 8 * DAY;
    expect((await computeFacts(factsInput(w, { dispute: { id: 'D', disputedAmountCents: 8900, responseDueBy: due } }))).F13.value).toBe(true);
    expect((await computeFacts(factsInput(w, { dispute: { id: 'D', disputedAmountCents: 8901, responseDueBy: due } }))).F13.value).toBe(false);
    expect((await computeFacts(factsInput(w, { dispute: { id: 'D', disputedAmountCents: 100, responseDueBy: due }, capture: null }))).F13.value).toBe(false);
  });
});

describe('consent built outside the fixtures still flows through', () => {
  it('accepts a passkey-method consent signed by the wallet', async () => {
    const w = await makeWorld();
    const approvedAt = w.cart.consent.approved_at ?? '';
    const signed = await signConsent({ cartHash: w.cartHash, cartJti: w.cart.jti, aud: w.cart.aud, presentedHash: PRESENTED_HASH, approvedAt, mandateHash: w.mandateHash }, w.keys.wallet.privateKey, KIDS.wallet);
    const cart: CartPayload = { ...w.cart, consent: buildHumanPresentConsent({ approvedAt, method: 'passkey', presentedHash: PRESENTED_HASH, signature: signed.jws }) };
    const facts = await computeFacts(factsInput(w, { bundle: await w.resign({ cart }) }));
    expect([facts.F2.value, facts.F4.value, facts.F5.value]).toEqual([true, true, true]);
  });
});

describe('Warrant 0.2 facts: F8 counts the jti too, F6 applies the cumulative budget', () => {
  it('F8 needs the nonce and the cart jti each recorded exactly once', async () => {
    const w = await makeWorld();
    for (const [nonceUseCount, jtiUseCount, expected] of [
      [1, 1, true],
      [1, 0, false],
      [1, 2, false],
      [0, 1, false],
      [2, 1, false],
    ] as const) {
      const facts = await computeFacts(factsInput(w, { nonceUseCount, jtiUseCount }));
      expect([nonceUseCount, jtiUseCount, facts.F8.value]).toEqual([nonceUseCount, jtiUseCount, expected]);
    }
    const facts = await computeFacts(factsInput(w, { jtiUseCount: 2 }));
    expect(facts.F8.evidence).toContain('jti_use_count=2');
    expect(facts.F8.evidence).toContain(`cart_jti:${w.cart.jti}`);
  });

  it('F6 is false when spend plus this cart exceeds a cumulative budget, and records that the check was made', async () => {
    const w = await makeWorld();
    const facts = await computeFacts(factsInput(w, { spentBefore: { totalCents: 3200, itemCount: 1 } }));
    expect(facts.F6.value).toBe(false);
    expect(facts.F6.detail).toEqual({ budgetMode: 'cumulative', cumulativeChecked: true });
    expect(facts.F6.evidence.some((e) => e.startsWith('problem:') && e.includes('max_total'))).toBe(true);
  });

  it('F6 is decided on the per-cart limits when the spend is unknown, and says the cumulative check was not made', async () => {
    const w = await makeWorld();
    const facts = await computeFacts(factsInput(w, { spentBefore: null }));
    expect(facts.F6.value).toBe(true);
    expect(facts.F6.detail).toEqual({ budgetMode: 'cumulative', cumulativeChecked: false });
    expect(facts.F6.evidence.some((e) => e.startsWith('unverified:'))).toBe(true);
  });

  it('F6 ignores the spend for a per_cart mandate', async () => {
    const w = await makeWorld({ scope: { budgetMode: 'per_cart' } });
    const facts = await computeFacts(factsInput(w, { spentBefore: { totalCents: 99_999_900, itemCount: 99 } }));
    expect(facts.F6.value).toBe(true);
    expect(facts.F6.detail).toEqual({ budgetMode: 'per_cart', cumulativeChecked: false });
  });

  it('F4 fails when the consent covers another jti, even if everything else is intact', async () => {
    const w = await makeWorld();
    const other = await w.otherCart([{ sku: SKU, title: 'Desk converter 32in', qty: 1, unitPriceCents: 8900, listingHash: LISTING_HASH }], { consent: w.cart.consent });
    w.walletRecords.set(other.cart.jti, { presentedHash: PRESENTED_HASH });
    const facts = await computeFacts(factsInput(w, { bundle: makeBundle(w.mandateJws, other.jws) }));
    expect(facts.F4.value).toBe(false);
    expect(facts.F2.value).toBe(false);
    expect(facts.F2.detail).toMatchObject({ consent: false });
    expect(facts.F4.evidence.some((e) => e.includes('cart_jti'))).toBe(true);
  });
});
