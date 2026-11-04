import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { hashText } from '../src/canonical';
import { verifyJws } from '../src/jws';
import { keyStateAt, staticRegistry, type RegistryKey } from '../src/registry';
import { cartSchema, consentPayloadSchema, mandateSchema, parseCartPayload, parseConsentPayload, parseMandatePayload } from '../src/schema';
import { MAX_SKEW_SECONDS, formatInstant, isNumericDate, parseInstantSeconds } from '../src/time';
import {
  HUMAN_NOT_PRESENT_CONSENT,
  WARRANT_VERSION,
  WarrantError,
  agentIssuer,
  buildCartBody,
  buildCartPayload,
  buildHumanPresentConsent,
  buildMandate,
  cartLinesTotalCents,
  decodeBundle,
  decodeCart,
  decodeConsent,
  decodeMandate,
  hashCartBody,
  hashCartWarrant,
  hashMandate,
  makeBundle,
  merchantAudience,
  parseBundle,
  paypalReferences,
  serializeBundle,
  signCart,
  signConsent,
  signMandate,
} from '../src/warrant';
import { KIDS, LISTING_HASH, MERCHANT_ID, PRESENTED_HASH, SKU, T0, defaultLines, makeWorld } from './fixtures';

describe('time helpers', () => {
  it('parses strict UTC instants into seconds', () => {
    expect(parseInstantSeconds('2026-11-04T10:00:00Z')).toBe(Date.UTC(2026, 10, 4, 10) / 1000);
    expect(parseInstantSeconds('2026-11-04T10:00:00.500Z')).toBe(Date.UTC(2026, 10, 4, 10) / 1000 + 0.5);
  });

  it.each([
    '2026-11-04',
    '2026-11-04T10:00:00',
    '2026-11-04T10:00:00+00:00',
    '2026-11-04 10:00:00Z',
    '2026-02-31T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-11-04T24:00:00Z',
    '2026-11-04T10:60:00Z',
    'tomorrow',
    '',
  ])('rejects %j', (text) => {
    expect(parseInstantSeconds(text)).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(parseInstantSeconds(5)).toBeNull();
    expect(parseInstantSeconds(null)).toBeNull();
  });

  it('formats and round-trips', () => {
    expect(formatInstant(T0)).toBe('2026-10-26T07:33:20Z');
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4_000_000_000 }), (seconds) => {
        expect(parseInstantSeconds(formatInstant(seconds))).toBe(seconds);
      }),
    );
  });

  it('validates NumericDate', () => {
    expect(isNumericDate(0)).toBe(true);
    expect(isNumericDate(T0)).toBe(true);
    for (const bad of [-1, 1.5, Number.NaN, '5', null]) expect(isNumericDate(bad)).toBe(false);
    expect(MAX_SKEW_SECONDS).toBe(60);
  });
});

describe('registry', () => {
  const base = (patch: Partial<RegistryKey> = {}): RegistryKey => ({
    kid: 'k1',
    kind: 'agent',
    owner: 'ap_x',
    publicKey: undefined as never,
    status: 'active',
    validFrom: 100,
    validTo: 200,
    statusChangedAt: null,
    ...patch,
  });

  it('reports the state of a key at a moment in time', () => {
    expect(keyStateAt(base(), 150)).toBe('active');
    expect(keyStateAt(base(), 99)).toBe('not_yet_valid');
    expect(keyStateAt(base(), 100)).toBe('active');
    expect(keyStateAt(base(), 200)).toBe('active');
    expect(keyStateAt(base(), 201)).toBe('expired');
    expect(keyStateAt(base({ validTo: null }), 9_999_999)).toBe('active');
    expect(keyStateAt(base(), Number.NaN)).toBe('not_yet_valid');
  });

  it('applies suspension and revocation from the time they happened', () => {
    const revoked = base({ status: 'revoked', statusChangedAt: 150 });
    expect(keyStateAt(revoked, 149)).toBe('active');
    expect(keyStateAt(revoked, 150)).toBe('revoked');
    expect(keyStateAt(base({ status: 'suspended', statusChangedAt: 150 }), 160)).toBe('suspended');
    expect(keyStateAt(base({ status: 'revoked', statusChangedAt: null }), 120)).toBe('revoked');
  });

  it('builds an in-memory lookup', () => {
    const lookup = staticRegistry([base({ kid: 'a' }), base({ kid: 'b' })]);
    expect(lookup('a')?.kid).toBe('a');
    expect(lookup('zzz')).toBeNull();
  });
});

describe('buildMandate and signMandate', () => {
  it('produces the document shape from docs/warrant-spec.md with decimal strings', async () => {
    const w = await makeWorld();
    expect(w.mandate).toEqual({
      typ: 'mandate',
      jti: 'mnd_01JEXAMPLE',
      iss: 'wallet:demo-wallet',
      iat: T0,
      nbf: T0,
      exp: T0 + 3600,
      principal: { ref: 'prn_01JEXAMPLE', paypal_payer_id_hash: hashText('PAYERID1234567') },
      agent: { platform: 'ap_demo_shopper', agent_id: 'shopper-1', kid: KIDS.agent },
      instruction: { text: 'Find a standing desk converter under $120', hash: hashText('Find a standing desk converter under $120') },
      scope: {
        currency: 'USD',
        max_total: '120.00',
        max_per_item: '120.00',
        max_items: 2,
        categories_allow: null,
        merchants_allow: ['*'],
        merchants_deny: [],
        mode: 'human_present',
        budget_mode: 'cumulative',
      },
    });
  });

  it('omits the payer hash until the principal is linked', async () => {
    const w = await makeWorld({ payerBound: false });
    expect('paypal_payer_id_hash' in w.mandate.principal).toBe(false);
  });

  it('signs with the wallet key under the given kid and verifies against the wallet public key', async () => {
    const w = await makeWorld();
    const signed = await signMandate(w.mandate, w.keys.wallet.privateKey, KIDS.wallet);
    expect(signed.hash).toBe(hashMandate(w.mandate));
    const result = await verifyJws(signed.jws, w.keys.wallet.publicKey);
    expect(result).toMatchObject({ ok: true, header: { kid: KIDS.wallet }, payload: w.mandate });
    expect(decodeMandate(signed.jws)).toMatchObject({ ok: true, kid: KIDS.wallet, hash: signed.hash });
  });

  it.each([
    ['a sub-cent amount', (m: any) => (m.scope.max_total = '1.005')],
    ['an unknown field', (m: any) => (m.extra = 1)],
    ['the wrong typ', (m: any) => (m.typ = 'cart')],
    ['a bad payer hash', (m: any) => (m.principal.paypal_payer_id_hash = 'sha256:short')],
    ['a missing agent kid', (m: any) => delete m.agent.kid],
    ['a lowercase currency', (m: any) => (m.scope.currency = 'usd')],
    ['a fractional item limit', (m: any) => (m.scope.max_items = 1.5)],
    ['an unknown mode', (m: any) => (m.scope.mode = 'sometimes')],
    ['an unknown budget_mode', (m: any) => (m.scope.budget_mode = 'monthly')],
    ['a missing budget_mode', (m: any) => delete m.scope.budget_mode],
    ['a float NumericDate', (m: any) => (m.exp = 1.5)],
  ])('refuses to sign a mandate with %s', async (_label, mutate) => {
    const w = await makeWorld();
    const bad = structuredClone(w.mandate) as any;
    mutate(bad);
    await expect(signMandate(bad, w.keys.wallet.privateKey, KIDS.wallet)).rejects.toThrow(WarrantError);
    expect(parseMandatePayload(bad).ok).toBe(false);
  });

  it('buildMandate validates its input', () => {
    expect(() =>
      buildMandate({
        jti: 'mnd_1', iss: 'wallet:x', iat: 1, nbf: 1, exp: 2, principalRef: 'p', agent: { platform: 'a', agentId: 'b', kid: 'k' }, instructionText: '',
        scope: { currency: 'USD', maxTotalCents: 100, maxPerItemCents: 100, maxItems: 1, categoriesAllow: null, merchantsAllow: ['*'], merchantsDeny: [], mode: 'human_present', budgetMode: 'cumulative' },
      }),
    ).toThrow(WarrantError);
  });

  it('rejects every non-object root', () => {
    for (const root of [null, undefined, 'x', 5, [], [{}]]) {
      expect(mandateSchema.safeParse(root).success).toBe(false);
      expect(cartSchema.safeParse(root).success).toBe(false);
      expect(consentPayloadSchema.safeParse(root).success).toBe(false);
    }
  });
});

describe('cart building', () => {
  it('computes the total from the lines in integer cents and formats decimal strings', () => {
    const body = buildCartBody('USD', [
      { sku: 'a', title: 'A', qty: 3, unitPriceCents: 333, listingHash: LISTING_HASH },
      { sku: 'b', title: 'B', qty: 1, unitPriceCents: 1, listingHash: LISTING_HASH },
    ]);
    expect(body.total).toBe('10.00');
    expect(body.items.map((i) => i.unit_price)).toEqual(['3.33', '0.01']);
    expect(cartLinesTotalCents(body)).toBe(1000);
  });

  it('refuses an empty cart, a fractional quantity and an overflowing total', () => {
    expect(() => buildCartBody('USD', [])).toThrow(WarrantError);
    expect(() => buildCartBody('USD', [{ sku: 'a', title: 'A', qty: 1.5, unitPriceCents: 100, listingHash: LISTING_HASH }])).toThrow();
    expect(() => buildCartBody('USD', [{ sku: 'a', title: 'A', qty: 2, unitPriceCents: Number.MAX_SAFE_INTEGER, listingHash: LISTING_HASH }])).toThrow();
  });

  it('cart_hash is the hash of the canonical cart object and changes with any line value', () => {
    const body = buildCartBody('USD', defaultLines);
    expect(hashCartBody(body)).toBe(hashCartBody(JSON.parse(JSON.stringify(body))));
    for (const edit of [{ qty: 2 }, { unitPriceCents: 8901 }, { sku: 'other' }, { title: 'Other' }, { listingHash: hashText('x') }]) {
      expect(hashCartBody(buildCartBody('USD', [{ ...defaultLines[0]!, ...edit }]))).not.toBe(hashCartBody(body));
    }
    expect(hashCartBody(buildCartBody('EUR', defaultLines))).not.toBe(hashCartBody(body));
  });

  it('cartLinesTotalCents returns null for lines that cannot be summed', () => {
    const body = buildCartBody('USD', defaultLines);
    expect(cartLinesTotalCents({ ...body, items: [{ ...body.items[0]!, unit_price: 'abc' }] })).toBeNull();
  });

  it('builds a cart warrant with a computed cart_hash and validates it', async () => {
    const w = await makeWorld();
    expect(w.cart.cart_hash).toBe(hashCartBody(w.cartBody));
    expect(w.cart).toMatchObject({ typ: 'cart', iss: agentIssuer('ap_demo_shopper', 'shopper-1'), aud: merchantAudience(MERCHANT_ID) });
    expect(parseCartPayload(w.cart).ok).toBe(true);
    expect(() => buildCartPayload({ ...w.cart, nonce: '', mandate: w.cart.mandate, cart: w.cartBody, consent: w.cart.consent })).toThrow(WarrantError);
  });

  it('signs the cart with the agent key and refuses invalid carts', async () => {
    const w = await makeWorld();
    const signed = await signCart(w.cart, w.keys.agent.privateKey, KIDS.agent);
    expect(signed.hash).toBe(hashCartWarrant(w.cart));
    expect(await verifyJws(signed.jws, w.keys.agent.publicKey)).toMatchObject({ ok: true, header: { kid: KIDS.agent } });
    expect(decodeCart(signed.jws)).toMatchObject({ ok: true, kid: KIDS.agent });
    await expect(signCart({ ...w.cart, aud: '' }, w.keys.agent.privateKey, KIDS.agent)).rejects.toThrow(WarrantError);
  });

  it('the cart payload schema rejects unknown fields on every level', async () => {
    const w = await makeWorld();
    for (const bad of [
      { ...w.cart, extra: 1 },
      { ...w.cart, cart: { ...w.cartBody, extra: 1 } },
      { ...w.cart, consent: { ...w.cart.consent, extra: 1 } },
      { ...w.cart, mandate: { ...w.cart.mandate, extra: 1 } },
      { ...w.cart, cart: { ...w.cartBody, items: [{ ...w.cartBody.items[0]!, extra: 1 }] } },
      { ...w.cart, cart: { ...w.cartBody, items: [] } },
      { ...w.cart, cart: { ...w.cartBody, items: [{ ...w.cartBody.items[0]!, qty: 0 }] } },
    ]) {
      expect(parseCartPayload(bad).ok).toBe(false);
    }
  });
});

describe('consent', () => {
  it('signs exactly the six covered values (plus typ) with the wallet key', async () => {
    const w = await makeWorld();
    const approvedAt = w.cart.consent.approved_at ?? '';
    const signed = await signConsent({ cartHash: w.cartHash, cartJti: w.cart.jti, aud: w.cart.aud, presentedHash: PRESENTED_HASH, approvedAt, mandateHash: w.mandateHash }, w.keys.wallet.privateKey, KIDS.wallet);
    const verified = await verifyJws(signed.jws, w.keys.wallet.publicKey);
    expect(verified).toMatchObject({
      ok: true,
      payload: { typ: 'consent', cart_hash: w.cartHash, cart_jti: w.cart.jti, aud: w.cart.aud, presented_hash: PRESENTED_HASH, approved_at: approvedAt, mandate_hash: w.mandateHash },
    });
    expect(Object.keys((verified as { payload: object }).payload).sort()).toEqual(['approved_at', 'aud', 'cart_hash', 'cart_jti', 'mandate_hash', 'presented_hash', 'typ']);
    expect(decodeConsent(signed.jws)).toMatchObject({ ok: true, kid: KIDS.wallet });
  });

  it('refuses to sign a consent with bad inputs', async () => {
    const w = await makeWorld();
    const ok = { cartHash: w.cartHash, cartJti: w.cart.jti, aud: w.cart.aud, presentedHash: PRESENTED_HASH, approvedAt: '2026-11-04T10:00:00Z', mandateHash: w.mandateHash };
    for (const bad of [{ cartHash: 'x' }, { cartJti: '' }, { cartJti: 'has space' }, { aud: '' }, { presentedHash: 'x' }, { approvedAt: 'yesterday' }, { mandateHash: 'x' }]) {
      await expect(signConsent({ ...ok, ...bad }, w.keys.wallet.privateKey, KIDS.wallet)).rejects.toThrow(WarrantError);
    }
  });

  it('a consent signature is not a valid cart or mandate (domain separation), and vice versa', async () => {
    const w = await makeWorld();
    expect(decodeCart(w.consentJws ?? '').ok).toBe(false);
    expect(decodeMandate(w.consentJws ?? '').ok).toBe(false);
    expect(decodeConsent(w.cartJws).ok).toBe(false);
    expect(decodeConsent(w.mandateJws).ok).toBe(false);
    expect(decodeCart(w.mandateJws).ok).toBe(false);
    expect(decodeMandate(w.cartJws).ok).toBe(false);
    expect(parseConsentPayload({ typ: 'cart' }).ok).toBe(false);
  });

  it('builds the consent object for the cart', () => {
    expect(buildHumanPresentConsent({ approvedAt: '2026-11-04T10:00:00Z', method: 'passkey', presentedHash: PRESENTED_HASH, signature: 'a.b.c' })).toEqual({
      mode: 'human_present',
      approved_at: '2026-11-04T10:00:00Z',
      method: 'passkey',
      presented_hash: PRESENTED_HASH,
      signature: 'a.b.c',
    });
    expect(HUMAN_NOT_PRESENT_CONSENT).toEqual({ mode: 'human_not_present' });
    expect(Object.isFrozen(HUMAN_NOT_PRESENT_CONSENT)).toBe(true);
  });
});

describe('PayPal references (spec section 5)', () => {
  it('derives custom_id and invoice_id from the cart warrant', async () => {
    const w = await makeWorld();
    const refs = paypalReferences(w.cart);
    expect(refs.customId).toBe('wrt:crt_01JEXAMPLE');
    expect(refs.invoiceId).toBe(`WRT-${w.cart.cart_hash.slice(7, 23)}`);
    expect(refs.invoiceId).toHaveLength(4 + 16);
  });
});

describe('bundle', () => {
  it('makes, serializes and parses a bundle', async () => {
    const w = await makeWorld();
    expect(w.bundle).toEqual({ warrant_version: WARRANT_VERSION, mandate: w.mandateJws, cart: w.cartJws });
    expect(parseBundle(w.bundle)).toEqual({ ok: true, value: w.bundle });
    expect(parseBundle(serializeBundle(w.bundle))).toEqual({ ok: true, value: w.bundle });
    expect(parseBundle(JSON.stringify(w.bundle, null, 2))).toEqual({ ok: true, value: w.bundle });
  });

  it('serializes canonically', async () => {
    const w = await makeWorld();
    expect(serializeBundle(w.bundle)).toBe(`{"cart":"${w.cartJws}","mandate":"${w.mandateJws}","warrant_version":"0.2"}`);
  });

  it.each([
    ['null', null],
    ['a number', 5],
    ['an array', []],
    ['an empty object', {}],
    ['a wrong version', { warrant_version: '0.1', mandate: 'a', cart: 'b' }],
    ['a missing cart', { warrant_version: '0.2', mandate: 'a' }],
    ['an extra field', { warrant_version: '0.2', mandate: 'a', cart: 'b', x: 1 }],
    ['non-string parts', { warrant_version: '0.2', mandate: 1, cart: 2 }],
    ['empty parts', { warrant_version: '0.2', mandate: '', cart: 'b' }],
    ['invalid JSON text', '{not json'],
    ['oversized JSON text', 'x'.repeat(3 * 1024 * 1024)],
  ])('rejects %s', (_label, input) => {
    expect(parseBundle(input).ok).toBe(false);
  });

  it('decodes both parts without checking signatures', async () => {
    const w = await makeWorld();
    const decoded = decodeBundle(w.bundle);
    expect(decoded.mandate).toMatchObject({ ok: true, kid: KIDS.wallet });
    expect(decoded.cart).toMatchObject({ ok: true, kid: KIDS.agent });
    if (decoded.cart.ok) expect(decoded.cart.payload.cart.items[0]?.sku).toBe(SKU);
    expect(decodeBundle(makeBundle('bad', 'worse')).mandate.ok).toBe(false);
  });
});
