import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { hashText } from '../src/canonical';
import { signJws } from '../src/jws';
import { generateSigningKey } from '../src/keys';
import { staticRegistry, type RegistryKey } from '../src/registry';
import type { CartPayload } from '../src/schema';
import { combine, hashPayerId, verifyCheckout, verifyPayerBinding, type Finding, type Outcome, type Spend } from '../src/verify';
import { agentIssuer, buildCartBody, hashCartBody, hashMandate, makeBundle, serializeBundle, signCart, signConsent, signMandate } from '../src/warrant';
import { AGENT_ID, KIDS, LISTING_HASH, MERCHANT_ID, NOW, PAYER_ID, PLATFORM, PRESENTED_HASH, SKU, T0, WALLET_ISS, findingsFor, makeWorld, outcomesFor } from './fixtures';

const rulesRejecting = (result: { findings: readonly Finding[] }): string[] => [...new Set(result.findings.filter((f) => f.outcome === 'reject').map((f) => f.rule))];

describe('verifyCheckout: baseline', () => {
  it('accepts a well-formed human_present warrant with every rule passing', async () => {
    const w = await makeWorld();
    const result = await verifyCheckout(w.bundle, w.ctx);
    expect(result.findings.filter((f) => f.outcome !== 'pass')).toEqual([]);
    expect(result.outcome).toBe('ACCEPT');
    expect(result.cartHash).toBe(w.cartHash);
    expect(result.mandateHash).toBe(w.mandateHash);
    const rules = new Set<string>(result.findings.map((f) => f.rule));
    for (const rule of ['V01_SIGNATURE', 'V02_KEY_STATUS', 'V03_FRESHNESS', 'V04_AUDIENCE', 'V05_NONCE', 'V06_MANDATE_BINDING', 'V07_CART_HASH', 'V08_REPRICE', 'V09_SCOPE', 'V10_CONSENT', 'V12_VELOCITY']) {
      expect(rules.has(rule)).toBe(true);
    }
  });

  it('accepts a human_not_present warrant when the mandate allows it', async () => {
    const w = await makeWorld({ scopeMode: 'human_not_present' });
    const result = await verifyCheckout(w.bundle, w.ctx);
    expect(result.outcome).toBe('ACCEPT');
  });

  it('accepts the bundle as a JSON string as well as an object', async () => {
    const w = await makeWorld();
    expect((await verifyCheckout(serializeBundle(w.bundle), w.ctx)).outcome).toBe('ACCEPT');
  });

  it('is deterministic', async () => {
    const w = await makeWorld();
    expect(await verifyCheckout(w.bundle, w.ctx)).toEqual(await verifyCheckout(w.bundle, w.ctx));
  });

  it('rejects input that is not a bundle without throwing, reporting a single V01 finding', async () => {
    const w = await makeWorld();
    for (const input of [null, undefined, 5, 'nope', '{', [], {}, { warrant_version: '0.1', mandate: 'a', cart: 'b' }, { warrant_version: '0.2', mandate: 'a' }, { ...w.bundle, extra: 1 }]) {
      const result = await verifyCheckout(input, w.ctx);
      expect(result.outcome).toBe('REJECT');
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toMatchObject({ rule: 'V01_SIGNATURE', outcome: 'reject' });
      expect(result.cartHash).toBeNull();
    }
  });

  it('runs every rule and lists every failure (no short-circuit)', async () => {
    const w = await makeWorld();
    w.usedNonces.add(w.cart.nonce); // V05
    w.catalog.set(SKU, { ...w.catalog.get(SKU)!, unitPriceCents: 9900 }); // V08
    const result = await verifyCheckout(w.bundle, w.ctxWith({ merchantId: 'SOMEONEELSE' })); // V04 (and V09 merchant allow is '*', so fine)
    expect(result.outcome).toBe('REJECT');
    expect(rulesRejecting(result).sort()).toEqual(['V04_AUDIENCE', 'V05_NONCE', 'V08_REPRICE']);
    expect(result.findings.filter((f) => f.outcome === 'pass').length).toBeGreaterThan(5);
  });
});

describe('V01 SIGNATURE', () => {
  it('passes when cart, mandate and consent signatures verify and the consent covers the cart', async () => {
    const w = await makeWorld();
    const result = await verifyCheckout(w.bundle, w.ctx);
    expect(outcomesFor(result, 'V01_SIGNATURE')).toEqual(['pass', 'pass', 'pass']);
  });

  it('fails when the cart is signed by a key other than the registered one (wrong key)', async () => {
    const w = await makeWorld();
    const forged = await signCart(w.cart, w.keys.stranger.privateKey, KIDS.agent);
    const result = await verifyCheckout(makeBundle(w.mandateJws, forged.jws), w.ctx);
    expect(result.outcome).toBe('REJECT');
    expect(findingsFor(result, 'V01_SIGNATURE').some((f) => f.outcome === 'reject' && f.detail.includes('cart signature invalid'))).toBe(true);
  });

  it('fails when the mandate is signed by a key other than the registered wallet key', async () => {
    const w = await makeWorld();
    const forged = await signMandate(w.mandate, w.keys.stranger.privateKey, KIDS.wallet);
    const result = await verifyCheckout(makeBundle(forged.jws, w.cartJws), w.ctx);
    expect(rulesRejecting(result)).toContain('V01_SIGNATURE');
  });

  it('fails when the signing kid is not in the registry', async () => {
    const w = await makeWorld();
    const forged = await signCart(w.cart, w.keys.agent.privateKey, 'ap_unknown#1');
    const result = await verifyCheckout(makeBundle(w.mandateJws, forged.jws), w.ctx);
    expect(findingsFor(result, 'V01_SIGNATURE').some((f) => f.outcome === 'reject' && f.detail.includes('not in the registry'))).toBe(true);
  });

  it('fails when a human_present cart has no consent signature', async () => {
    const w = await makeWorld();
    const { signature: _dropped, ...rest } = w.cart.consent;
    const cart: CartPayload = { ...w.cart, consent: rest };
    const result = await verifyCheckout(await w.resign({ cart }), w.ctx);
    expect(findingsFor(result, 'V01_SIGNATURE').some((f) => f.outcome === 'reject' && f.detail.includes('no signature'))).toBe(true);
  });

  it('fails when the consent signature is valid but covers a different cart', async () => {
    const w = await makeWorld();
    const other = await w.otherCart([{ sku: SKU, title: 'Desk converter 32in', qty: 1, unitPriceCents: 9900, listingHash: LISTING_HASH }], { consent: w.cart.consent });
    const result = await verifyCheckout(makeBundle(w.mandateJws, other.jws), w.ctx);
    expect(findingsFor(result, 'V01_SIGNATURE').some((f) => f.outcome === 'reject' && f.detail.includes('cart_hash'))).toBe(true);
  });

  it('fails when the cart JWS is garbage', async () => {
    const w = await makeWorld();
    const result = await verifyCheckout(makeBundle(w.mandateJws, 'not.a.jws'), w.ctx);
    expect(result.outcome).toBe('REJECT');
    expect(findingsFor(result, 'V01_SIGNATURE').some((f) => f.detail.includes('undecodable'))).toBe(true);
  });

  it('fails when a signed payload has the wrong typ or shape (domain separation)', async () => {
    const w = await makeWorld();
    // A genuine wallet signature over a mandate used in the cart slot, and a genuine agent signature over a cart used as a mandate.
    const swapped = makeBundle(w.cartJws, w.mandateJws);
    const result = await verifyCheckout(swapped, w.ctx);
    expect(result.outcome).toBe('REJECT');
  });
});

describe('V02 KEY_STATUS', () => {
  const withKey = (w: Awaited<ReturnType<typeof makeWorld>>, which: 'wallet' | 'agent', patch: Partial<RegistryKey>) =>
    w.ctxWith({ registry: staticRegistry([which === 'wallet' ? { ...w.registryKeys.wallet, ...patch } : w.registryKeys.wallet, which === 'agent' ? { ...w.registryKeys.agent, ...patch } : w.registryKeys.agent]) });

  it('passes for registered, correctly owned, active keys', async () => {
    const w = await makeWorld();
    expect(outcomesFor(await verifyCheckout(w.bundle, w.ctx), 'V02_KEY_STATUS')).toEqual(['pass']);
  });

  it('fails for a revoked agent key (revoked key)', async () => {
    const w = await makeWorld();
    const result = await verifyCheckout(w.bundle, withKey(w, 'agent', { status: 'revoked', statusChangedAt: T0 + 650 }));
    expect(result.outcome).toBe('REJECT');
    expect(findingsFor(result, 'V02_KEY_STATUS').some((f) => f.detail.includes('revoked'))).toBe(true);
  });

  it('fails for a key that was revoked before the warrant was issued, even if the registry still reports it as revoked now', async () => {
    const w = await makeWorld();
    const result = await verifyCheckout(w.bundle, withKey(w, 'agent', { status: 'revoked', statusChangedAt: T0 + 100 }));
    expect(findingsFor(result, 'V02_KEY_STATUS').filter((f) => f.outcome === 'reject').length).toBeGreaterThanOrEqual(2); // now and at issue
  });

  it('passes for a key that will be revoked later than now', async () => {
    const w = await makeWorld();
    const result = await verifyCheckout(w.bundle, withKey(w, 'agent', { status: 'revoked', statusChangedAt: NOW + 1000 }));
    expect(outcomesFor(result, 'V02_KEY_STATUS')).toEqual(['pass']);
  });

  it('fails for a suspended wallet key, and for suspended keys with no change time', async () => {
    const w = await makeWorld();
    expect(rulesRejecting(await verifyCheckout(w.bundle, withKey(w, 'wallet', { status: 'suspended', statusChangedAt: T0 })))).toContain('V02_KEY_STATUS');
    expect(rulesRejecting(await verifyCheckout(w.bundle, withKey(w, 'wallet', { status: 'suspended', statusChangedAt: null })))).toContain('V02_KEY_STATUS');
  });

  it('fails for a key outside its validity period', async () => {
    const w = await makeWorld();
    expect(rulesRejecting(await verifyCheckout(w.bundle, withKey(w, 'agent', { validTo: T0 + 100 })))).toContain('V02_KEY_STATUS');
    expect(rulesRejecting(await verifyCheckout(w.bundle, withKey(w, 'agent', { validFrom: T0 + 5000 })))).toContain('V02_KEY_STATUS');
  });

  it('fails for a key of the wrong kind or owned by someone else', async () => {
    const w = await makeWorld();
    expect(findingsFor(await verifyCheckout(w.bundle, withKey(w, 'agent', { kind: 'wallet' })), 'V02_KEY_STATUS').some((f) => f.detail.includes('expected agent'))).toBe(true);
    expect(findingsFor(await verifyCheckout(w.bundle, withKey(w, 'agent', { owner: 'ap_other_platform' })), 'V02_KEY_STATUS').some((f) => f.detail.includes('belongs to'))).toBe(true);
    expect(findingsFor(await verifyCheckout(w.bundle, withKey(w, 'wallet', { owner: 'wallet:other' })), 'V02_KEY_STATUS').some((f) => f.outcome === 'reject')).toBe(true);
  });

  it('fails when the registry does not know the kid', async () => {
    const w = await makeWorld();
    const result = await verifyCheckout(w.bundle, w.ctxWith({ registry: () => null }));
    expect(findingsFor(result, 'V02_KEY_STATUS').some((f) => f.detail.includes('not in the registry'))).toBe(true);
  });

  it('requires the consent key to be a wallet key owned by the mandate issuer', async () => {
    const w = await makeWorld();
    const otherWallet = generateSigningKey();
    const otherKey: RegistryKey = { ...w.registryKeys.wallet, kid: 'wallet-other#1', owner: 'wallet:other', publicKey: otherWallet.publicKey };
    const registry = staticRegistry([w.registryKeys.wallet, w.registryKeys.agent, otherKey]);
    const consent = await signConsent(
      { cartHash: w.cartHash, cartJti: w.cart.jti, aud: w.cart.aud, presentedHash: PRESENTED_HASH, approvedAt: w.cart.consent.approved_at ?? '', mandateHash: w.mandateHash },
      otherWallet.privateKey,
      otherKey.kid,
    );
    const cart: CartPayload = { ...w.cart, consent: { ...w.cart.consent, signature: consent.jws } };
    const result = await verifyCheckout(await w.resign({ cart }), w.ctxWith({ registry }));
    expect(outcomesFor(result, 'V01_SIGNATURE')).toEqual(['pass', 'pass', 'pass']); // a valid signature by a registered key...
    expect(findingsFor(result, 'V02_KEY_STATUS').some((f) => f.outcome === 'reject' && f.detail.includes('belongs to wallet:other'))).toBe(true); // ...of the wrong owner
  });
});

describe('V03 FRESHNESS', () => {
  const at = (w: Awaited<ReturnType<typeof makeWorld>>, now: number, skewSeconds?: number) => w.ctxWith({ now, ...(skewSeconds === undefined ? {} : { skewSeconds }) });

  it('passes inside both windows', async () => {
    const w = await makeWorld();
    expect(outcomesFor(await verifyCheckout(w.bundle, w.ctx), 'V03_FRESHNESS')).toEqual(['pass']);
  });

  it('fails for an expired mandate, with 60 seconds of skew allowed', async () => {
    const w = await makeWorld({});
    // Long-lived cart so only the mandate is the problem: build a mandate that already ended.
    const shortMandate = { ...w.mandate, exp: T0 + 650 };
    const bundle = await w.resign({ mandate: shortMandate });
    const lateButInSkew = await verifyCheckout(bundle, at(w, T0 + 650 + 60));
    expect(findingsFor(lateButInSkew, 'V03_FRESHNESS').some((f) => f.detail.includes('mandate has expired'))).toBe(false);
    const expired = await verifyCheckout(bundle, at(w, T0 + 650 + 61));
    expect(findingsFor(expired, 'V03_FRESHNESS').some((f) => f.outcome === 'reject' && f.detail.includes('mandate has expired'))).toBe(true);
    expect(expired.outcome).toBe('REJECT');
  });

  it('fails for a mandate that is not valid yet', async () => {
    const w = await makeWorld();
    const result = await verifyCheckout(w.bundle, at(w, T0 - 61));
    expect(findingsFor(result, 'V03_FRESHNESS').some((f) => f.detail.includes('mandate is not valid yet'))).toBe(true);
  });

  it('fails for an expired cart and for a cart issued in the future', async () => {
    const w = await makeWorld();
    expect(findingsFor(await verifyCheckout(w.bundle, at(w, T0 + 1500 + 61)), 'V03_FRESHNESS').some((f) => f.detail.includes('cart has expired'))).toBe(true);
    expect(findingsFor(await verifyCheckout(w.bundle, at(w, T0 + 600 - 61)), 'V03_FRESHNESS').some((f) => f.detail.includes('issued in the future'))).toBe(true);
    expect(outcomesFor(await verifyCheckout(w.bundle, at(w, T0 + 600 - 60)), 'V03_FRESHNESS')).toEqual(['pass']);
  });

  it('fails for a cart whose lifetime exceeds 15 minutes, or is not positive', async () => {
    const w = await makeWorld();
    const long = await verifyCheckout(await w.resign({ cart: { ...w.cart, exp: w.cart.iat + 901 } }), w.ctx);
    expect(findingsFor(long, 'V03_FRESHNESS').some((f) => f.detail.includes('exceeds the 900s maximum'))).toBe(true);
    const exact = await verifyCheckout(await w.resign({ cart: { ...w.cart, exp: w.cart.iat + 900 } }), w.ctx);
    expect(outcomesFor(exact, 'V03_FRESHNESS')).toEqual(['pass']);
    const inverted = await verifyCheckout(await w.resign({ cart: { ...w.cart, exp: w.cart.iat } }), w.ctx);
    expect(findingsFor(inverted, 'V03_FRESHNESS').some((f) => f.detail.includes('not after its iat'))).toBe(true);
  });

  it('fails for a mandate whose nbf is after its exp', async () => {
    const w = await makeWorld();
    const result = await verifyCheckout(await w.resign({ mandate: { ...w.mandate, nbf: T0 + 5000 } }), w.ctx);
    expect(findingsFor(result, 'V03_FRESHNESS').some((f) => f.detail.includes('nbf is after its exp'))).toBe(true);
  });

  it('never lets the configured skew exceed 60 seconds and honours a smaller one', async () => {
    const w = await makeWorld();
    const expiredBy90 = T0 + 1500 + 90;
    expect(rulesRejecting(await verifyCheckout(w.bundle, at(w, expiredBy90, 600)))).toContain('V03_FRESHNESS');
    expect(rulesRejecting(await verifyCheckout(w.bundle, at(w, T0 + 1500 + 30, 0)))).toContain('V03_FRESHNESS');
    expect(rulesRejecting(await verifyCheckout(w.bundle, at(w, T0 + 1500 + 30, 60)))).not.toContain('V03_FRESHNESS');
    expect(rulesRejecting(await verifyCheckout(w.bundle, at(w, T0 + 1500 + 61, Number.NaN)))).toContain('V03_FRESHNESS');
  });

  it('fails closed when now is not a number', async () => {
    const w = await makeWorld();
    expect(rulesRejecting(await verifyCheckout(w.bundle, at(w, Number.NaN)))).toContain('V03_FRESHNESS');
  });

  // G5: the cart must have been issued while the mandate was valid. The cart's iat is T0 + 600 in these tests.
  const detailsOf = (result: { findings: readonly Finding[] }): string[] => findingsFor(result, 'V03_FRESHNESS').filter((f) => f.outcome === 'reject').map((f) => f.detail);

  it('fails for a cart issued before the mandate became valid, allowing 60 seconds of skew', async () => {
    const w = await makeWorld();
    const validFrom = (nbf: number) => ({ ...w.mandate, iat: nbf, nbf });
    const atEdge = await verifyCheckout(await w.resign({ mandate: validFrom(T0 + 660) }), w.ctx); // cart iat == nbf - 60
    expect(detailsOf(atEdge).some((d) => d.includes('before the mandate became valid'))).toBe(false);
    const tooEarly = await verifyCheckout(await w.resign({ mandate: validFrom(T0 + 661) }), w.ctx);
    expect(detailsOf(tooEarly).some((d) => d.includes('before the mandate became valid'))).toBe(true);
    expect(tooEarly.outcome).toBe('REJECT');
  });

  it('fails for a cart issued after the mandate expired, allowing 60 seconds of skew', async () => {
    const w = await makeWorld();
    const atEdge = await verifyCheckout(await w.resign({ mandate: { ...w.mandate, exp: T0 + 540 } }), w.ctx); // cart iat == exp + 60
    expect(detailsOf(atEdge).some((d) => d.includes('after the mandate expired'))).toBe(false);
    const tooLate = await verifyCheckout(await w.resign({ mandate: { ...w.mandate, exp: T0 + 539 } }), w.ctx);
    expect(detailsOf(tooLate).some((d) => d.includes('after the mandate expired'))).toBe(true);
  });

  it('fails for a mandate whose iat is after its nbf, and passes when they are equal', async () => {
    const w = await makeWorld();
    expect(outcomesFor(await verifyCheckout(await w.resign({ mandate: { ...w.mandate, iat: w.mandate.nbf } }), w.ctx), 'V03_FRESHNESS')).toEqual(['pass']);
    const backdated = await verifyCheckout(await w.resign({ mandate: { ...w.mandate, iat: w.mandate.nbf + 1 } }), w.ctx);
    expect(detailsOf(backdated).some((d) => d.includes('issued after it became valid'))).toBe(true);
  });
});

describe('V04 AUDIENCE', () => {
  it('passes when aud names this merchant', async () => {
    const w = await makeWorld();
    expect(outcomesFor(await verifyCheckout(w.bundle, w.ctx), 'V04_AUDIENCE')).toEqual(['pass']);
  });

  it('fails for a warrant issued for another merchant', async () => {
    const w = await makeWorld();
    const result = await verifyCheckout(w.bundle, w.ctxWith({ merchantId: 'OTHERMERCHANT' }));
    expect(findingsFor(result, 'V04_AUDIENCE')[0]).toMatchObject({ outcome: 'reject' });
    expect(result.outcome).toBe('REJECT');
  });
});

describe('V05 NONCE', () => {
  it('passes for a fresh nonce', async () => {
    const w = await makeWorld();
    expect(outcomesFor(await verifyCheckout(w.bundle, w.ctx), 'V05_NONCE')).toEqual(['pass', 'pass']);
  });

  it('fails for a replayed nonce', async () => {
    const w = await makeWorld();
    w.usedNonces.add(w.cart.nonce);
    const result = await verifyCheckout(w.bundle, w.ctx);
    expect(findingsFor(result, 'V05_NONCE')[0]).toMatchObject({ outcome: 'reject' });
    expect(result.outcome).toBe('REJECT');
  });

  it('verifying does not consume the nonce or the jti (the caller records them)', async () => {
    const w = await makeWorld();
    await verifyCheckout(w.bundle, w.ctx);
    expect((await verifyCheckout(w.bundle, w.ctx)).outcome).toBe('ACCEPT');
  });

  it('G1: fails for a replayed cart jti even with a fresh nonce, naming the jti', async () => {
    const w = await makeWorld();
    w.usedJtis.add(w.cart.jti);
    const result = await verifyCheckout(w.bundle, w.ctx);
    expect(outcomesFor(result, 'V05_NONCE')).toEqual(['pass', 'reject']);
    expect(findingsFor(result, 'V05_NONCE')[1]?.detail).toContain('jti');
    expect(rulesRejecting(result)).toEqual(['V05_NONCE']);
  });

  it('G1: fails for a replayed nonce under a fresh jti, naming the nonce', async () => {
    const w = await makeWorld();
    w.usedNonces.add(w.cart.nonce);
    const result = await verifyCheckout(w.bundle, w.ctx);
    expect(outcomesFor(result, 'V05_NONCE')).toEqual(['reject', 'pass']);
    expect(findingsFor(result, 'V05_NONCE')[0]?.detail).toContain('nonce');
  });
});

describe('V06 MANDATE_BINDING', () => {
  it('passes when the cart references the presented mandate and its named agent', async () => {
    const w = await makeWorld();
    expect(outcomesFor(await verifyCheckout(w.bundle, w.ctx), 'V06_MANDATE_BINDING')).toEqual(['pass']);
  });

  it('fails when cart.mandate.hash is not the hash of the presented mandate', async () => {
    const w = await makeWorld();
    const cart: CartPayload = { ...w.cart, mandate: { jti: w.cart.mandate.jti, hash: hashText('another mandate') } };
    const result = await verifyCheckout(await w.resign({ cart }), w.ctx);
    expect(findingsFor(result, 'V06_MANDATE_BINDING').some((f) => f.outcome === 'reject' && f.detail.includes('mandate.hash'))).toBe(true);
  });

  it('fails when cart.mandate.jti is a different mandate', async () => {
    const w = await makeWorld();
    const cart: CartPayload = { ...w.cart, mandate: { jti: 'mnd_OTHER', hash: w.cart.mandate.hash } };
    const result = await verifyCheckout(await w.resign({ cart }), w.ctx);
    expect(findingsFor(result, 'V06_MANDATE_BINDING').some((f) => f.outcome === 'reject' && f.detail.includes('jti'))).toBe(true);
  });

  it('fails when the cart iss is not the agent the mandate names', async () => {
    const w = await makeWorld();
    const cart: CartPayload = { ...w.cart, iss: agentIssuer(PLATFORM, 'shopper-2') };
    const result = await verifyCheckout(await w.resign({ cart }), w.ctx);
    expect(findingsFor(result, 'V06_MANDATE_BINDING').some((f) => f.outcome === 'reject' && f.detail.includes('iss'))).toBe(true);
  });

  it('fails when the cart is signed with a different (even registered, active) key than the mandate names', async () => {
    const w = await makeWorld();
    const second = generateSigningKey();
    const secondKey: RegistryKey = { ...w.registryKeys.agent, kid: `${PLATFORM}#2026-11`, publicKey: second.publicKey };
    const registry = staticRegistry([w.registryKeys.wallet, w.registryKeys.agent, secondKey]);
    const signed = await signCart(w.cart, second.privateKey, secondKey.kid);
    const result = await verifyCheckout(makeBundle(w.mandateJws, signed.jws), w.ctxWith({ registry }));
    expect(rulesRejecting(result)).toEqual(['V06_MANDATE_BINDING']);
  });

  // G6: the instruction the human is recorded as giving must match its hash.
  it('fails when instruction.hash is not the hash of instruction.text, even if the cart references the edited mandate', async () => {
    const w = await makeWorld({ scopeMode: 'human_not_present' });
    const mandate = { ...w.mandate, instruction: { ...w.mandate.instruction, text: 'Buy whatever you like' } };
    const cart: CartPayload = { ...w.cart, mandate: { jti: mandate.jti, hash: hashMandate(mandate) } };
    const result = await verifyCheckout(await w.resign({ mandate, cart }), w.ctx);
    expect(rulesRejecting(result)).toEqual(['V06_MANDATE_BINDING']);
    expect(findingsFor(result, 'V06_MANDATE_BINDING')[0]?.detail).toContain('instruction.hash');
  });

  it('passes when instruction.hash matches, including for non-ASCII text', async () => {
    const text = `Find a desk ${String.fromCodePoint(0x20ac)}100 ${String.fromCodePoint(0x1f600)}`;
    const w = await makeWorld();
    const mandate = { ...w.mandate, instruction: { text, hash: hashText(text) } };
    const cart: CartPayload = { ...w.cart, mandate: { jti: mandate.jti, hash: hashMandate(mandate) } };
    const result = await verifyCheckout(await w.resign({ mandate, cart }), w.ctx);
    expect(outcomesFor(result, 'V06_MANDATE_BINDING')).toEqual(['pass']);
  });
});

describe('V07 CART_HASH', () => {
  it('passes when cart_hash matches and lines sum to the total', async () => {
    const w = await makeWorld();
    expect(outcomesFor(await verifyCheckout(w.bundle, w.ctx), 'V07_CART_HASH')).toEqual(['pass']);
  });

  it('fails when cart_hash does not match the canonical cart', async () => {
    const w = await makeWorld();
    const cart: CartPayload = { ...w.cart, cart_hash: hashText('something else') };
    const result = await verifyCheckout(await w.resign({ cart }), w.ctx);
    expect(findingsFor(result, 'V07_CART_HASH').some((f) => f.outcome === 'reject' && f.detail.includes('cart_hash'))).toBe(true);
  });

  it('fails when the line totals do not sum to cart.total, even if the hash was recomputed', async () => {
    const w = await makeWorld();
    const body = { ...w.cartBody, total: '1.00' };
    const cart: CartPayload = { ...w.cart, cart: body, cart_hash: hashCartBody(body) };
    const result = await verifyCheckout(await w.resign({ cart }), w.ctx);
    expect(findingsFor(result, 'V07_CART_HASH').some((f) => f.outcome === 'reject' && f.detail.includes('sum'))).toBe(true);
  });
});

describe('V08 REPRICE', () => {
  it('passes when every line matches the merchant catalog', async () => {
    const w = await makeWorld();
    expect(outcomesFor(await verifyCheckout(w.bundle, w.ctx), 'V08_REPRICE')).toEqual(['pass']);
  });

  it('fails when the merchant price differs in either direction (item repriced)', async () => {
    for (const price of [9900, 100]) {
      const w = await makeWorld();
      w.catalog.set(SKU, { ...w.catalog.get(SKU)!, unitPriceCents: price });
      const result = await verifyCheckout(w.bundle, w.ctx);
      expect(findingsFor(result, 'V08_REPRICE').some((f) => f.outcome === 'reject' && f.detail.includes('unit price'))).toBe(true);
    }
  });

  it('fails when the item is unavailable, unknown, in another currency, or the listing changed', async () => {
    const cases: Array<[string, (w: Awaited<ReturnType<typeof makeWorld>>) => void, string]> = [
      ['unavailable', (w) => w.catalog.set(SKU, { ...w.catalog.get(SKU)!, available: false }), 'not available'],
      ['unknown', (w) => w.catalog.delete(SKU), 'not in this merchant'],
      ['currency', (w) => w.catalog.set(SKU, { ...w.catalog.get(SKU)!, currency: 'EUR' }), 'priced in EUR'],
      ['listing', (w) => w.catalog.set(SKU, { ...w.catalog.get(SKU)!, listingHash: hashText('new listing') }), 'listing_hash'],
    ];
    for (const [, mutate, text] of cases) {
      const w = await makeWorld();
      mutate(w);
      const result = await verifyCheckout(w.bundle, w.ctx);
      expect(findingsFor(result, 'V08_REPRICE').some((f) => f.outcome === 'reject' && f.detail.includes(text))).toBe(true);
    }
  });

  it('does not compare listing hashes when the merchant has none', async () => {
    const w = await makeWorld();
    w.catalog.set(SKU, { ...w.catalog.get(SKU)!, listingHash: null });
    expect(outcomesFor(await verifyCheckout(w.bundle, w.ctx), 'V08_REPRICE')).toEqual(['pass']);
  });
});

describe('V09 SCOPE', () => {
  it('passes inside the mandate scope', async () => {
    const w = await makeWorld();
    expect(outcomesFor(await verifyCheckout(w.bundle, w.ctx), 'V09_SCOPE')).toEqual(['pass']);
  });

  const failing: Array<[string, Parameters<typeof makeWorld>[0], string]> = [
    ['total above max_total', { scope: { maxTotalCents: 5000 } }, 'max_total'],
    ['unit price above max_per_item', { scope: { maxPerItemCents: 5000 } }, 'max_per_item'],
    ['more items than max_items', { lines: [{ sku: SKU, title: 'Desk converter 32in', qty: 3, unitPriceCents: 100, listingHash: LISTING_HASH }] }, 'max_items'],
    ['a category outside the allow list', { scope: { categoriesAllow: ['books'] } }, 'category office_furniture is not allowed'],
    ['a merchant on the deny list', { scope: { merchantsDeny: [MERCHANT_ID] } }, 'denied by the mandate'],
    ['a merchant missing from the allow list', { scope: { merchantsAllow: ['SOMEONEELSE'] } }, 'allow list'],
    ['an empty merchant allow list', { scope: { merchantsAllow: [] } }, 'allow list'],
    ['a currency other than the mandate currency', { scope: { currency: 'EUR' } }, 'currency'],
  ];
  it.each(failing)('fails for %s', async (_label, options, text) => {
    const w = await makeWorld(options);
    const result = await verifyCheckout(w.bundle, w.ctx);
    expect(findingsFor(result, 'V09_SCOPE').some((f) => f.outcome === 'reject' && f.detail.includes(text))).toBe(true);
    expect(result.outcome).toBe('REJECT');
  });

  it('passes with an allow list that names the merchant by id or by aud, and a matching category', async () => {
    for (const merchantsAllow of [[MERCHANT_ID], [`paypal-merchant:${MERCHANT_ID}`], ['*']]) {
      const w = await makeWorld({ scope: { merchantsAllow, categoriesAllow: ['office_furniture'] } });
      expect(outcomesFor(await verifyCheckout(w.bundle, w.ctx), 'V09_SCOPE')).toEqual(['pass']);
    }
  });

  it('fails closed when the catalog has no category but the mandate restricts categories', async () => {
    const w = await makeWorld({ scope: { categoriesAllow: ['office_furniture'] } });
    w.catalog.set(SKU, { ...w.catalog.get(SKU)!, category: null });
    expect(findingsFor(await verifyCheckout(w.bundle, w.ctx), 'V09_SCOPE')[0]?.detail).toContain('no known category');
  });
});

describe('V09 SCOPE: cumulative budget (G2)', () => {
  // The honest cart is 89.00 and one item. The mandate allows 120.00 and 2 items in total.
  const run = async (spent: Spend | null, options: Parameters<typeof makeWorld>[0] = {}) => {
    const w = await makeWorld(options);
    w.spent.current = spent;
    return verifyCheckout(w.bundle, w.ctx);
  };
  const v09 = (result: { findings: readonly Finding[] }) => findingsFor(result, 'V09_SCOPE');

  it('passes with nothing spent, and the detail says the budget was checked', async () => {
    const result = await run({ totalCents: 0, itemCount: 0 });
    expect(v09(result)).toEqual([{ rule: 'V09_SCOPE', outcome: 'pass', detail: 'cart is within the mandate scope and the remaining budget' }]);
  });

  it('passes exactly at the limit: 31.00 + 89.00 = 120.00 and 1 + 1 = 2 items', async () => {
    expect((await run({ totalCents: 3100, itemCount: 1 })).outcome).toBe('ACCEPT');
  });

  it('rejects one cent over the total budget: 32.00 + 89.00 = 121.00', async () => {
    const result = await run({ totalCents: 3200, itemCount: 1 });
    expect(result.outcome).toBe('REJECT');
    expect(v09(result).some((f) => f.outcome === 'reject' && f.detail.includes('max_total'))).toBe(true);
    expect(rulesRejecting(result)).toEqual(['V09_SCOPE']);
  });

  it('rejects one item over the item budget: 2 + 1 > 2', async () => {
    const result = await run({ totalCents: 0, itemCount: 2 });
    expect(v09(result).some((f) => f.outcome === 'reject' && f.detail.includes('max_items'))).toBe(true);
    expect(rulesRejecting(result)).toEqual(['V09_SCOPE']);
  });

  it('asks for review, never a silent pass, when the spend is unknown', async () => {
    const result = await run(null);
    expect(result.outcome).toBe('REVIEW');
    expect(v09(result)).toEqual([expect.objectContaining({ outcome: 'review', detail: expect.stringContaining('unknown') })]);
  });

  it('asks for review when the verifier is not given a spend source at all', async () => {
    const w = await makeWorld();
    const { spentUnderMandate: _omitted, ...withoutSpend } = w.ctx;
    const result = await verifyCheckout(w.bundle, withoutSpend);
    expect(result.outcome).toBe('REVIEW');
    expect(v09(result)[0]?.detail).toContain('not given the spend');
  });

  it('per_cart mandates ignore the spend and say that the limits apply per cart', async () => {
    const result = await run({ totalCents: 99_999_900, itemCount: 99 }, { scope: { budgetMode: 'per_cart' } });
    expect(result.outcome).toBe('ACCEPT');
    expect(v09(result)[0]?.detail).toBe('cart is within the mandate scope (limits apply per cart)');
  });

  it('per_cart mandates need no spend source at all', async () => {
    const w = await makeWorld({ scope: { budgetMode: 'per_cart' } });
    const { spentUnderMandate: _omitted, ...withoutSpend } = w.ctx;
    expect((await verifyCheckout(w.bundle, withoutSpend)).outcome).toBe('ACCEPT');
  });

  it.each([
    ['negative total', { totalCents: -1, itemCount: 0 }],
    ['fractional total', { totalCents: 1.5, itemCount: 0 }],
    ['NaN total', { totalCents: Number.NaN, itemCount: 0 }],
    ['negative items', { totalCents: 0, itemCount: -1 }],
    ['fractional items', { totalCents: 0, itemCount: 0.5 }],
    ['a string total', { totalCents: '0', itemCount: 0 }],
  ])('rejects a malformed spend (%s): that can only be a bug in the caller', async (_label, spent) => {
    const result = await run(spent as never);
    expect(result.outcome).toBe('REJECT');
    expect(v09(result).some((f) => f.outcome === 'reject' && f.detail.includes('not valid'))).toBe(true);
  });

  it('rejects instead of overflowing when the recorded spend is at the numeric limit', async () => {
    const result = await run({ totalCents: Number.MAX_SAFE_INTEGER, itemCount: 0 });
    expect(v09(result).some((f) => f.outcome === 'reject' && f.detail.includes('overflows'))).toBe(true);
  });

  it('a reject outranks the review: over the per-cart limit and unknown spend gives REJECT with both findings', async () => {
    const result = await run(null, { scope: { maxTotalCents: 5000 } });
    expect(result.outcome).toBe('REJECT');
    const outcomes = v09(result).map((f) => f.outcome);
    expect(outcomes).toContain('review');
    expect(outcomes.filter((o) => o === 'reject').length).toBeGreaterThan(0);
  });

  it('the per-cart limits still apply in cumulative mode', async () => {
    const result = await run({ totalCents: 0, itemCount: 0 }, { scope: { maxPerItemCents: 5000 } });
    expect(v09(result).some((f) => f.outcome === 'reject' && f.detail.includes('max_per_item'))).toBe(true);
  });

  it('asks the spend source about this mandate only', async () => {
    const w = await makeWorld();
    const asked: string[] = [];
    await verifyCheckout(w.bundle, w.ctxWith({ spentUnderMandate: (jti) => (asked.push(jti), { totalCents: 0, itemCount: 0 }) }));
    expect(asked).toEqual([w.mandate.jti]);
  });

  it('property: whatever the sequence of carts, accepted carts never exceed the mandate budget, and every cart that fits is accepted', async () => {
    const w = await makeWorld({ scopeMode: 'human_not_present' }); // no consent signature, so only the budget is in play
    const attempt = fc.record({ qty: fc.integer({ min: 1, max: 2 }), price: fc.integer({ min: 100, max: 12_000 }) });
    await fc.assert(
      fc.asyncProperty(fc.array(attempt, { maxLength: 6 }), async (attempts) => {
        let spent: Spend = { totalCents: 0, itemCount: 0 };
        const nonces = new Set<string>();
        const jtis = new Set<string>();
        const prices = new Map<string, number>();
        for (const [index, a] of attempts.entries()) {
          const sku = `sku_${index}`;
          prices.set(sku, a.price);
          const cart = await w.otherCart([{ sku, title: 'Item', qty: a.qty, unitPriceCents: a.price, listingHash: LISTING_HASH }], { jti: `crt_${index}`, nonce: `n_${index}_000000` });
          const ctx = w.ctxWith({
            nonceSeen: (n) => nonces.has(n),
            cartSeen: (j) => jtis.has(j),
            spentUnderMandate: () => spent,
            catalog: (s) => (prices.has(s) ? { unitPriceCents: prices.get(s) ?? 0, currency: 'USD', available: true, category: 'any', listingHash: LISTING_HASH } : null),
          });
          const result = await verifyCheckout(makeBundle(w.mandateJws, cart.jws), ctx);
          const total = a.price * a.qty;
          const fits = total <= 12_000 && spent.totalCents + total <= 12_000 && spent.itemCount + a.qty <= 2;
          expect(result.outcome).toBe(fits ? 'ACCEPT' : 'REJECT');
          if (result.outcome === 'ACCEPT') {
            spent = { totalCents: spent.totalCents + total, itemCount: spent.itemCount + a.qty };
            nonces.add(cart.cart.nonce);
            jtis.add(cart.cart.jti);
          }
          expect(spent.totalCents).toBeLessThanOrEqual(12_000);
          expect(spent.itemCount).toBeLessThanOrEqual(2);
        }
      }),
      { numRuns: 40 },
    );
  });
});

describe('G1: the consent signs one cart warrant and one merchant', () => {
  it('fails when the consent was signed for the same cart under another merchant (aud)', async () => {
    const w = await makeWorld();
    const cart: CartPayload = { ...w.cart, aud: 'paypal-merchant:OTHERMERCHANT' };
    // The verifier at OTHERMERCHANT accepts the audience (V04 passes); only the consent can say the human never saw that merchant.
    const result = await verifyCheckout(await w.resign({ cart }), w.ctxWith({ merchantId: 'OTHERMERCHANT' }));
    expect(rulesRejecting(result)).toEqual(['V01_SIGNATURE']);
    expect(findingsFor(result, 'V01_SIGNATURE').some((f) => f.outcome === 'reject' && f.detail.includes('aud'))).toBe(true);
  });

  it('fails for a 0.1-style consent that covers neither a jti nor a merchant (undecodable)', async () => {
    const w = await makeWorld();
    const legacy = await signJws(
      { typ: 'consent', cart_hash: w.cartHash, presented_hash: PRESENTED_HASH, approved_at: w.cart.consent.approved_at ?? '', mandate_hash: w.mandateHash },
      w.keys.wallet.privateKey,
      KIDS.wallet,
    );
    const cart: CartPayload = { ...w.cart, consent: { ...w.cart.consent, signature: legacy.jws } };
    const result = await verifyCheckout(await w.resign({ cart }), w.ctx);
    expect(rulesRejecting(result)).toContain('V01_SIGNATURE');
    expect(findingsFor(result, 'V01_SIGNATURE').some((f) => f.detail.includes('consent is undecodable'))).toBe(true);
  });

  it('looks the wallet record up by jti: a record kept for another jti does not count', async () => {
    const w = await makeWorld();
    const record = w.walletRecords.get(w.cart.jti);
    w.walletRecords.clear();
    w.walletRecords.set('crt_SOMEONE_ELSE', record ?? { presentedHash: PRESENTED_HASH });
    const result = await verifyCheckout(w.bundle, w.ctx);
    expect(findingsFor(result, 'V10_CONSENT')[0]?.detail).toContain('no record');
    expect(rulesRejecting(result)).toEqual(['V10_CONSENT']);
  });

  it('passes the jti and the cart hash to the wallet record lookup', async () => {
    const w = await makeWorld();
    const asked: unknown[] = [];
    await verifyCheckout(w.bundle, w.ctxWith({ walletRecord: (key) => (asked.push(key), { presentedHash: PRESENTED_HASH }) }));
    expect(asked).toEqual([{ cartJti: w.cart.jti, cartHash: w.cartHash }]);
  });

  it('human_not_present carts carry no consent, so G1 does not apply to them and they still verify', async () => {
    const w = await makeWorld({ scopeMode: 'human_not_present' });
    expect((await verifyCheckout(w.bundle, w.ctx)).outcome).toBe('ACCEPT');
  });

  it('a consent signature edited in any single character is still rejected', async () => {
    const w = await makeWorld();
    const signature = w.cart.consent.signature ?? '';
    await fc.assert(
      fc.asyncProperty(fc.nat(signature.length - 1), async (position) => {
        const replacement = signature[position] === 'A' ? 'B' : 'A';
        const edited = signature.slice(0, position) + replacement + signature.slice(position + 1);
        const cart: CartPayload = { ...w.cart, consent: { ...w.cart.consent, signature: edited } };
        const result = await verifyCheckout(await w.resign({ cart }), w.ctx);
        expect(result.outcome).toBe('REJECT');
      }),
      { numRuns: 60 },
    );
  });
});

describe('V10 CONSENT', () => {
  it('passes for human_present consent that matches the wallet record', async () => {
    const w = await makeWorld();
    expect(outcomesFor(await verifyCheckout(w.bundle, w.ctx), 'V10_CONSENT')).toEqual(['pass']);
  });

  it('passes for human_not_present when the mandate allows it', async () => {
    const w = await makeWorld({ scopeMode: 'human_not_present' });
    expect(findingsFor(await verifyCheckout(w.bundle, w.ctx), 'V10_CONSENT')[0]).toMatchObject({ outcome: 'pass' });
  });

  it('fails when the wallet recorded a different screen for this cart', async () => {
    const w = await makeWorld();
    w.walletRecords.set(w.cart.jti, { presentedHash: hashText('a different screen') });
    expect(findingsFor(await verifyCheckout(w.bundle, w.ctx), 'V10_CONSENT')[0]).toMatchObject({ outcome: 'reject' });
  });

  it('fails when the wallet has no record of this cart', async () => {
    const w = await makeWorld();
    w.walletRecords.clear();
    expect(findingsFor(await verifyCheckout(w.bundle, w.ctx), 'V10_CONSENT')[0]?.detail).toContain('no record');
  });

  it('fails when the cart claims human_not_present but the mandate requires a human', async () => {
    const w = await makeWorld({ scopeMode: 'human_present', consentMode: 'human_not_present' });
    const result = await verifyCheckout(w.bundle, w.ctx);
    expect(findingsFor(result, 'V10_CONSENT')[0]).toMatchObject({ outcome: 'reject' });
    expect(result.outcome).toBe('REJECT');
  });

  it('fails when human_present consent is missing required fields', async () => {
    const w = await makeWorld();
    const { method: _m, presented_hash: _p, ...rest } = w.cart.consent;
    const result = await verifyCheckout(await w.resign({ cart: { ...w.cart, consent: rest } }), w.ctx);
    expect(findingsFor(result, 'V10_CONSENT').some((f) => f.outcome === 'reject' && f.detail.includes('missing method'))).toBe(true);
  });
});

describe('V12 VELOCITY', () => {
  const velocity = (principal: number, platform: number) => ({
    windowSeconds: 3600,
    maxPerPrincipal: 3,
    maxPerPlatform: 10,
    count: () => ({ principal, platform }),
  });

  it('passes under the limits, and reports when velocity is not configured', async () => {
    const w = await makeWorld();
    expect(outcomesFor(await verifyCheckout(w.bundle, w.ctxWith({ velocity: velocity(2, 9) })), 'V12_VELOCITY')).toEqual(['pass']);
    expect(findingsFor(await verifyCheckout(w.bundle, w.ctxWith({ velocity: null })), 'V12_VELOCITY')[0]?.detail).toContain('not configured');
  });

  it('asks for review (not reject) when the principal or the platform is over the limit', async () => {
    const w = await makeWorld();
    const principal = await verifyCheckout(w.bundle, w.ctxWith({ velocity: velocity(3, 0) }));
    expect(outcomesFor(principal, 'V12_VELOCITY')).toEqual(['review']);
    expect(principal.outcome).toBe('REVIEW');
    const platform = await verifyCheckout(w.bundle, w.ctxWith({ velocity: velocity(0, 10) }));
    expect(outcomesFor(platform, 'V12_VELOCITY')).toEqual(['review']);
    const both = await verifyCheckout(w.bundle, w.ctxWith({ velocity: velocity(3, 10) }));
    expect(outcomesFor(both, 'V12_VELOCITY')).toEqual(['review', 'review']);
  });

  it('queries the window ending now for this principal and platform', async () => {
    const w = await makeWorld();
    const seen: unknown[] = [];
    await verifyCheckout(w.bundle, w.ctxWith({ velocity: { ...velocity(0, 0), count: (q) => (seen.push(q), { principal: 0, platform: 0 }) } }));
    expect(seen).toEqual([{ principalRef: 'prn_01JEXAMPLE', platform: PLATFORM, since: NOW - 3600 }]);
  });

  it('review never outranks reject', async () => {
    const w = await makeWorld();
    w.usedNonces.add(w.cart.nonce);
    const result = await verifyCheckout(w.bundle, w.ctxWith({ velocity: velocity(9, 99) }));
    expect(result.outcome).toBe('REJECT');
    expect(outcomesFor(result, 'V12_VELOCITY')).toContain('review');
  });
});

describe('V11 PAYER_BINDING (verifyPayerBinding)', () => {
  it('accepts when the payer id hash matches the principal', async () => {
    const w = await makeWorld();
    const result = verifyPayerBinding(w.bundle, PAYER_ID);
    expect(result).toMatchObject({ outcome: 'ACCEPT', firstUse: false, payerIdHash: hashPayerId(PAYER_ID) });
    expect(result.finding).toMatchObject({ rule: 'V11_PAYER_BINDING', outcome: 'pass' });
  });

  it('rejects on a payer mismatch', async () => {
    const w = await makeWorld();
    const result = verifyPayerBinding(w.bundle, 'SOMEONEELSE99');
    expect(result.outcome).toBe('REJECT');
    expect(result.finding.outcome).toBe('reject');
    expect(result.firstUse).toBe(false);
  });

  it('asks for review on first use and returns the hash to record', async () => {
    const w = await makeWorld({ payerBound: false });
    const result = verifyPayerBinding(w.bundle, PAYER_ID);
    expect(result).toMatchObject({ outcome: 'REVIEW', firstUse: true, payerIdHash: hashPayerId(PAYER_ID) });
    expect(result.finding.outcome).toBe('review');
  });

  it('rejects a missing payer id and a malformed or undecodable bundle', async () => {
    const w = await makeWorld();
    expect(verifyPayerBinding(w.bundle, '').outcome).toBe('REJECT');
    expect(verifyPayerBinding(w.bundle, undefined as never).outcome).toBe('REJECT');
    expect(verifyPayerBinding({ nope: true }, PAYER_ID).outcome).toBe('REJECT');
    expect(verifyPayerBinding(makeBundle('x.y.z', w.cartJws), PAYER_ID).outcome).toBe('REJECT');
  });

  it('hashes the payer id in the Warrant hash format', () => {
    expect(hashPayerId(PAYER_ID)).toBe(hashText(PAYER_ID));
  });
});

describe('adversarial scenarios (docs/verification-rules.md)', () => {
  it('wrong key: a cart signed by a key the registry does not hold for that kid', async () => {
    const w = await makeWorld();
    const forged = await signCart(w.cart, generateSigningKey().privateKey, KIDS.agent);
    const result = await verifyCheckout(makeBundle(w.mandateJws, forged.jws), w.ctx);
    expect(result.outcome).toBe('REJECT');
    expect(rulesRejecting(result)).toContain('V01_SIGNATURE');
  });

  it('revoked key: the agent platform key was revoked', async () => {
    const w = await makeWorld();
    const ctx = w.ctxWith({ registry: staticRegistry([w.registryKeys.wallet, { ...w.registryKeys.agent, status: 'revoked', statusChangedAt: T0 + 500 }]) });
    const result = await verifyCheckout(w.bundle, ctx);
    expect(result.outcome).toBe('REJECT');
    expect(rulesRejecting(result)).toContain('V02_KEY_STATUS');
  });

  it('expired mandate', async () => {
    const w = await makeWorld();
    const result = await verifyCheckout(w.bundle, w.ctxWith({ now: T0 + 3600 + 3600 }));
    expect(result.outcome).toBe('REJECT');
    expect(rulesRejecting(result)).toContain('V03_FRESHNESS');
  });

  it('replayed nonce', async () => {
    const w = await makeWorld();
    expect((await verifyCheckout(w.bundle, w.ctx)).outcome).toBe('ACCEPT');
    w.usedNonces.add(w.cart.nonce); // the merchant records it after accepting
    const second = await verifyCheckout(w.bundle, w.ctx);
    expect(second.outcome).toBe('REJECT');
    expect(rulesRejecting(second)).toEqual(['V05_NONCE']);
  });

  it('warrant issued for another merchant', async () => {
    const w = await makeWorld();
    const result = await verifyCheckout(w.bundle, w.ctxWith({ merchantId: 'EVILSHOP' }));
    expect(result.outcome).toBe('REJECT');
    expect(rulesRejecting(result)).toEqual(['V04_AUDIENCE']);
  });

  it('cart edited after consent: the agent swaps in a pricier item and re-signs under the old consent', async () => {
    const w = await makeWorld();
    const edited = await w.otherCart([{ sku: SKU, title: 'Desk converter 32in', qty: 1, unitPriceCents: 11_900, listingHash: LISTING_HASH }], { consent: w.cart.consent });
    w.catalog.set(SKU, { ...w.catalog.get(SKU)!, unitPriceCents: 11_900 }); // the merchant's catalog agrees, so only consent can catch it
    w.walletRecords.set(edited.cart.jti, { presentedHash: PRESENTED_HASH });
    const result = await verifyCheckout(makeBundle(w.mandateJws, edited.jws), w.ctx);
    expect(result.outcome).toBe('REJECT');
    expect(rulesRejecting(result)).toEqual(['V01_SIGNATURE']);
    expect(findingsFor(result, 'V01_SIGNATURE').some((f) => f.detail.includes('cart_hash'))).toBe(true);
  });

  it('edited mandate scope: the payload is changed but the wallet signature is kept', async () => {
    const w = await makeWorld();
    const [header, , signature] = w.mandateJws.split('.');
    const raised = { ...w.mandate, scope: { ...w.mandate.scope, max_total: '99999.00', max_per_item: '99999.00' } };
    const forgedPayload = (await signJws(raised as never, w.keys.stranger.privateKey, KIDS.wallet)).jws.split('.')[1];
    const result = await verifyCheckout(makeBundle(`${header}.${forgedPayload}.${signature}`, w.cartJws), w.ctx);
    expect(result.outcome).toBe('REJECT');
    expect(rulesRejecting(result)).toContain('V01_SIGNATURE');
    expect(rulesRejecting(result)).toContain('V06_MANDATE_BINDING');
  });

  it('edited mandate scope, re-signed by the agent (not the wallet)', async () => {
    const w = await makeWorld();
    const raised = { ...w.mandate, scope: { ...w.mandate.scope, max_total: '99999.00' } };
    const forged = await signMandate(raised, w.keys.agent.privateKey, KIDS.wallet);
    const result = await verifyCheckout(makeBundle(forged.jws, w.cartJws), w.ctx);
    expect(result.outcome).toBe('REJECT');
    expect(rulesRejecting(result)).toContain('V01_SIGNATURE');
  });

  it('item repriced by the merchant after the agent built the cart', async () => {
    const w = await makeWorld();
    w.catalog.set(SKU, { ...w.catalog.get(SKU)!, unitPriceCents: 12_900 });
    const result = await verifyCheckout(w.bundle, w.ctx);
    expect(result.outcome).toBe('REJECT');
    expect(rulesRejecting(result)).toEqual(['V08_REPRICE']);
  });

  it('payer mismatch: someone else approves the PayPal order', async () => {
    const w = await makeWorld();
    expect((await verifyCheckout(w.bundle, w.ctx)).outcome).toBe('ACCEPT');
    expect(verifyPayerBinding(w.bundle, 'ATTACKERPAYER1').outcome).toBe('REJECT');
  });

  it('consent signature copied from another cart', async () => {
    const w = await makeWorld();
    // The principal approved cart A (one item at 89.00). The agent builds a different cart B and pastes that
    // valid, wallet-signed consent into it.
    const cartB = await w.otherCart([{ sku: SKU, title: 'Desk converter 32in', qty: 2, unitPriceCents: 4450, listingHash: LISTING_HASH }], { consent: w.cart.consent });
    w.walletRecords.set(cartB.cart.jti, { presentedHash: PRESENTED_HASH }); // even if the wallet record is forced to match
    w.catalog.set(SKU, { ...w.catalog.get(SKU)!, unitPriceCents: 4450 }); // and the merchant catalog agrees
    const result = await verifyCheckout(makeBundle(w.mandateJws, cartB.jws), w.ctx);
    expect(result.outcome).toBe('REJECT');
    expect(rulesRejecting(result)).toEqual(['V01_SIGNATURE']);
    expect(findingsFor(result, 'V01_SIGNATURE').some((f) => f.outcome === 'reject' && f.detail.includes('cart_hash'))).toBe(true);
  });

  it('G1: an IDENTICAL cart under a fresh jti and nonce cannot reuse the consent (it signs one jti)', async () => {
    // cart_hash covers only {currency, items, total}, so the repeat has the same cart_hash as the approved cart. In 0.1 the
    // old consent still covered it. In 0.2 the consent also signs the cart warrant's jti, so it covers exactly one warrant.
    const w = await makeWorld();
    const repeat = await w.otherCart([{ sku: SKU, title: 'Desk converter 32in', qty: 1, unitPriceCents: 8900, listingHash: LISTING_HASH }], { consent: w.cart.consent });
    w.walletRecords.set(repeat.cart.jti, { presentedHash: PRESENTED_HASH }); // even if the wallet record were forced to match
    const result = await verifyCheckout(makeBundle(w.mandateJws, repeat.jws), w.ctx);
    expect(repeat.hash).toBe(w.cartHash);
    expect(result.outcome).toBe('REJECT');
    expect(rulesRejecting(result)).toEqual(['V01_SIGNATURE']);
    expect(findingsFor(result, 'V01_SIGNATURE').some((f) => f.outcome === 'reject' && f.detail.includes('cart_jti'))).toBe(true);
  });
});

describe('properties', () => {
  it('combine implements the precedence reject > review > accept', () => {
    const outcome = fc.constantFrom<'pass' | 'review' | 'reject'>('pass', 'review', 'reject');
    fc.assert(
      fc.property(fc.array(outcome, { maxLength: 30 }), (outcomes) => {
        const findings: Finding[] = outcomes.map((o) => ({ rule: 'V01_SIGNATURE', outcome: o, detail: '' }));
        const expected: Outcome = outcomes.includes('reject') ? 'REJECT' : outcomes.includes('review') ? 'REVIEW' : 'ACCEPT';
        expect(combine(findings)).toBe(expected);
        // Adding a reject can only make things worse; adding a pass never changes the outcome.
        expect(combine([...findings, { rule: 'V05_NONCE', outcome: 'reject', detail: '' }])).toBe('REJECT');
        expect(combine([...findings, { rule: 'V05_NONCE', outcome: 'pass', detail: '' }])).toBe(expected);
      }),
      { numRuns: 200 },
    );
  });

  it('any single-character change to either JWS in the bundle is never accepted', async () => {
    const w = await makeWorld();
    const replacements = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.';
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('mandate', 'cart'), fc.nat(), fc.nat(replacements.length - 1), async (part, where, pick) => {
        const jws = part === 'mandate' ? w.mandateJws : w.cartJws;
        const position = where % jws.length;
        const replacement = replacements[pick] ?? 'A';
        fc.pre(replacement !== jws[position]);
        const mutated = jws.slice(0, position) + replacement + jws.slice(position + 1);
        const bundle = part === 'mandate' ? makeBundle(mutated, w.cartJws) : makeBundle(w.mandateJws, mutated);
        expect((await verifyCheckout(bundle, w.ctx)).outcome).toBe('REJECT');
      }),
      { numRuns: 300 },
    );
  });

  it('any single-byte change to the serialized bundle is never accepted', async () => {
    const w = await makeWorld();
    const original = Buffer.from(serializeBundle(w.bundle), 'utf8');
    await fc.assert(
      fc.asyncProperty(fc.nat(original.length - 1), fc.integer({ min: 1, max: 255 }), async (position, delta) => {
        const bytes = Buffer.from(original);
        bytes[position] = ((bytes[position] ?? 0) + delta) % 256;
        const text = new TextDecoder('utf-8').decode(bytes);
        expect((await verifyCheckout(text, w.ctx)).outcome).toBe('REJECT');
      }),
      { numRuns: 300 },
    );
  });

  it('never throws and never accepts arbitrary input', async () => {
    const w = await makeWorld();
    await fc.assert(
      fc.asyncProperty(fc.anything(), async (input) => {
        const result = await verifyCheckout(input, w.ctx);
        expect(result.outcome).toBe('REJECT');
      }),
      { numRuns: 200 },
    );
  });

  it('a verifier outcome never depends on the order of registry keys or on repeated verification', async () => {
    const w = await makeWorld();
    const reversed = staticRegistry([w.registryKeys.agent, w.registryKeys.wallet]);
    expect(await verifyCheckout(w.bundle, w.ctxWith({ registry: reversed }))).toEqual(await verifyCheckout(w.bundle, w.ctx));
  });
});

describe('cart built by the helper matches the spec example shape', () => {
  it('has the documented claims', async () => {
    const w = await makeWorld();
    expect(w.cart).toMatchObject({
      typ: 'cart',
      iss: `agent:${PLATFORM}/${AGENT_ID}`,
      aud: `paypal-merchant:${MERCHANT_ID}`,
      cart: { currency: 'USD', total: '89.00', items: [{ sku: SKU, qty: 1, unit_price: '89.00' }] },
      consent: { mode: 'human_present', method: 'click' },
    });
    expect(w.mandate).toMatchObject({ typ: 'mandate', iss: WALLET_ISS, scope: { mode: 'human_present', max_items: 2 } });
    expect(buildCartBody('USD', [{ sku: 'a', title: 't', qty: 3, unitPriceCents: 333, listingHash: LISTING_HASH }]).total).toBe('9.99');
  });
});
