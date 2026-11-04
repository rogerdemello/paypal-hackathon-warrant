import { createHash } from 'node:crypto';
import { canonicalize, hashJson, hashText } from '../src/canonical';
import type { FactsInput, MerchantMode } from '../src/facts';
import { signJws } from '../src/jws';
import { importSigningKey, publicKeyOf, exportVerificationKey, importVerificationKey, type SigningKeyPair } from '../src/keys';
import { appendEntry, GENESIS_HASH, type LedgerEntry } from '../src/ledger';
import { parseMoney } from '../src/money';
import type { CatalogOffer, VerifyContext } from '../src/verify';
import { hashPayerId } from '../src/verify';
import { staticRegistry, type RegistryKey } from '../src/registry';
import { hashCartWarrant, hashMandate, makeBundle, paypalReferences, signCart, signMandate, buildCartPayload, hashCartBody } from '../src/warrant';
import type { CartPayload } from '../src/schema';
import type { FactOverrides } from './factsBuilder';
import { KIDS, LISTING_HASH, MERCHANT_ID, PAYER_ID, PRESENTED_HASH, SKU, T0, factsInput, makeWorld, type World } from './fixtures';

/**
 * Deterministic test vectors for the Warrant format and rules (docs/test-vectors.json).
 *
 * Everything here is reproducible: keys come from fixed seeds, Ed25519 signatures are deterministic, and no clock or
 * randomness is involved. The file lets an independent implementation check its hashing, signing, verification and
 * outcome table against this one. Regenerate with `pnpm --filter @warrant/warrant vectors`.
 *
 * The expected results below are hand-authored from docs/verification-rules.md and docs/dispute-resolution.md, not
 * copied from the implementation; the test compares them with what the code does.
 */

export const VECTORS_VERSION = '0.2';

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface SeededKey extends SigningKeyPair {
  readonly seedHex: string;
}

/** An Ed25519 key derived from a label. TEST KEYS ONLY: anyone can recompute them. */
export function seededKey(label: string): SeededKey {
  const seed = createHash('sha256').update(`warrant-test-vector:${label}`).digest();
  const privateKeyBase64 = Buffer.concat([PKCS8_ED25519_PREFIX, seed]).toString('base64');
  const privateKey = importSigningKey(privateKeyBase64);
  return { privateKey, publicKey: publicKeyOf(privateKey), privateKeyBase64, seedHex: seed.toString('hex') };
}

export function vectorKeys(): { wallet: SeededKey; agent: SeededKey; stranger: SeededKey } {
  return { wallet: seededKey('wallet'), agent: seededKey('agent'), stranger: seededKey('stranger') };
}

// ---------------------------------------------------------------------------------------------
// JSON shapes
// ---------------------------------------------------------------------------------------------

export interface VectorRegistryKey {
  kid: string;
  kind: 'wallet' | 'agent';
  owner: string;
  public_key_spki_b64: string;
  status: 'active' | 'suspended' | 'revoked';
  valid_from: number;
  valid_to: number | null;
  status_changed_at: number | null;
}

export interface VectorContext {
  now: number;
  merchant_id: string;
  registry: VectorRegistryKey[];
  catalog: Record<string, { unit_price_cents: number; currency: string; available: boolean; category: string | null; listing_hash: string | null }>;
  /** What the wallet recorded as shown to the human, keyed by cart warrant jti. */
  wallet_records: Record<string, string>;
  used_nonces: string[];
  /** Cart warrant jtis this merchant has already seen. */
  used_cart_jtis: string[];
  /** Spend already recorded under the mandate; null = unknown; "not_configured" = the verifier is given no spend source. */
  spent_under_mandate: { total_cents: number; item_count: number } | null | 'not_configured';
  velocity: { window_seconds: number; max_per_principal: number; max_per_platform: number; prior_count_principal: number; prior_count_platform: number } | null;
}

export interface VectorExpectation {
  outcome: 'ACCEPT' | 'REVIEW' | 'REJECT';
  /** Rules that must produce a reject finding, sorted. */
  reject: string[];
  /** Rules that must produce a review finding, sorted. */
  review: string[];
}

export interface VerifyVector {
  name: string;
  description: string;
  bundle: { warrant_version: string; mandate: string; cart: string };
  context: VectorContext;
  expected: VectorExpectation;
}

export function registryToJson(keys: readonly RegistryKey[]): VectorRegistryKey[] {
  return keys.map((k) => ({
    kid: k.kid,
    kind: k.kind,
    owner: k.owner,
    public_key_spki_b64: exportVerificationKey(k.publicKey),
    status: k.status,
    valid_from: k.validFrom,
    valid_to: k.validTo,
    status_changed_at: k.statusChangedAt,
  }));
}

/** Rebuild a VerifyContext from nothing but the JSON, which proves the vectors are self-contained. */
export function contextFromJson(c: VectorContext): VerifyContext {
  const registry = staticRegistry(
    c.registry.map(
      (k): RegistryKey => ({
        kid: k.kid,
        kind: k.kind,
        owner: k.owner,
        publicKey: importVerificationKey(k.public_key_spki_b64),
        status: k.status,
        validFrom: k.valid_from,
        validTo: k.valid_to,
        statusChangedAt: k.status_changed_at,
      }),
    ),
  );
  const nonces = new Set(c.used_nonces);
  const jtis = new Set(c.used_cart_jtis);
  const v = c.velocity;
  const spend = c.spent_under_mandate;
  return {
    now: c.now,
    merchantId: c.merchant_id,
    registry,
    nonceSeen: (nonce) => nonces.has(nonce),
    cartSeen: (jti) => jtis.has(jti),
    ...(spend === 'not_configured' ? {} : { spentUnderMandate: () => (spend === null ? null : { totalCents: spend.total_cents, itemCount: spend.item_count }) }),
    catalog: (sku) => {
      const o = c.catalog[sku];
      if (o === undefined) return null;
      const offer: CatalogOffer = { unitPriceCents: o.unit_price_cents, currency: o.currency, available: o.available, category: o.category, listingHash: o.listing_hash };
      return offer;
    },
    walletRecord: ({ cartJti }) => {
      const presented = c.wallet_records[cartJti];
      return presented === undefined ? null : { presentedHash: presented };
    },
    velocity:
      v === null
        ? null
        : {
            windowSeconds: v.window_seconds,
            maxPerPrincipal: v.max_per_principal,
            maxPerPlatform: v.max_per_platform,
            count: () => ({ principal: v.prior_count_principal, platform: v.prior_count_platform }),
          },
  };
}

function contextOf(w: World, patch: Partial<VectorContext> = {}): VectorContext {
  const catalog: VectorContext['catalog'] = {};
  for (const [sku, offer] of [...w.catalog.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    catalog[sku] = { unit_price_cents: offer.unitPriceCents, currency: offer.currency, available: offer.available, category: offer.category, listing_hash: offer.listingHash ?? null };
  }
  const wallet_records: Record<string, string> = {};
  for (const [jti, record] of [...w.walletRecords.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    wallet_records[jti] = record.presentedHash;
  }
  const spent = w.spent.current;
  return {
    now: w.ctx.now,
    merchant_id: w.ctx.merchantId,
    registry: registryToJson([w.registryKeys.wallet, w.registryKeys.agent]),
    catalog,
    wallet_records,
    used_nonces: [...w.usedNonces].sort(),
    used_cart_jtis: [...w.usedJtis].sort(),
    spent_under_mandate: spent === null ? null : { total_cents: spent.totalCents, item_count: spent.itemCount },
    velocity: null,
    ...patch,
  };
}

const expectation = (outcome: VectorExpectation['outcome'], reject: string[] = [], review: string[] = []): VectorExpectation => ({ outcome, reject: [...reject].sort(), review: [...review].sort() });

// ---------------------------------------------------------------------------------------------
// Checkout verification vectors
// ---------------------------------------------------------------------------------------------

async function verifyVectors(): Promise<VerifyVector[]> {
  const keys = vectorKeys();
  const w = await makeWorld({ keys });
  const noConsent = await makeWorld({ keys, scopeMode: 'human_not_present' });
  const out: VerifyVector[] = [];
  const add = (name: string, description: string, bundle: VerifyVector['bundle'], context: VectorContext, expected: VectorExpectation): void => {
    out.push({ name, description, bundle, context, expected });
  };
  const base = contextOf(w);
  const agentRegistry = (patch: Partial<VectorRegistryKey>): VectorRegistryKey[] =>
    base.registry.map((k) => (k.kid === KIDS.agent ? { ...k, ...patch } : k));

  add('honest-human-present', 'A well-formed warrant with human_present consent.', w.bundle, base, expectation('ACCEPT'));
  add('honest-human-not-present', 'A well-formed warrant under a mandate that allows human_not_present.', noConsent.bundle, contextOf(noConsent), expectation('ACCEPT'));

  // V01 signature
  add('v01-forged-cart-signature', 'The cart is signed by a key the registry does not hold for that kid.', makeBundle(w.mandateJws, (await signCart(w.cart, keys.stranger.privateKey, KIDS.agent)).jws), base, expectation('REJECT', ['V01_SIGNATURE']));
  add('v01-forged-mandate-signature', 'The mandate is signed by a key other than the registered wallet key.', makeBundle((await signMandate(w.mandate, keys.stranger.privateKey, KIDS.wallet)).jws, w.cartJws), base, expectation('REJECT', ['V01_SIGNATURE']));
  const swapCart = await w.otherCart([{ sku: SKU, title: 'Desk converter 32in', qty: 2, unitPriceCents: 4450, listingHash: LISTING_HASH }], { consent: w.cart.consent });
  const swapContext = contextOf(w, {
    catalog: { ...base.catalog, [SKU]: { ...(base.catalog[SKU] ?? { unit_price_cents: 0, currency: 'USD', available: true, category: null, listing_hash: null }), unit_price_cents: 4450 } },
    wallet_records: { ...base.wallet_records, [swapCart.cart.jti]: PRESENTED_HASH },
  });
  // G1: the consent signs one cart warrant (jti) and one merchant (aud).
  const repeat = await w.otherCart([{ sku: SKU, title: 'Desk converter 32in', qty: 1, unitPriceCents: 8900, listingHash: LISTING_HASH }], { consent: w.cart.consent });
  add(
    'v01-consent-reused-for-identical-cart-new-jti',
    "The agent signs a second cart warrant for exactly the same items under a fresh jti and nonce and reuses the consent. cart_hash is identical, but the consent signs the first warrant's jti, so it does not cover this one.",
    makeBundle(w.mandateJws, repeat.jws),
    contextOf(w, { wallet_records: { ...base.wallet_records, [repeat.cart.jti]: PRESENTED_HASH } }),
    expectation('REJECT', ['V01_SIGNATURE']),
  );
  const otherAudience: CartPayload = { ...w.cart, aud: 'paypal-merchant:OTHERMERCHANT' };
  add(
    'v01-consent-for-other-merchant',
    'The consented cart is re-signed with another merchant as audience and presented to that merchant (so V04 passes). The consent signs the merchant the human saw, so it does not cover this warrant.',
    await w.resign({ cart: otherAudience }),
    { ...base, merchant_id: 'OTHERMERCHANT' },
    expectation('REJECT', ['V01_SIGNATURE']),
  );
  const legacyConsent = await signJws(
    { typ: 'consent', cart_hash: w.cartHash, presented_hash: PRESENTED_HASH, approved_at: w.cart.consent.approved_at ?? '', mandate_hash: w.mandateHash },
    keys.wallet.privateKey,
    KIDS.wallet,
  );
  add(
    'v01-consent-from-0-1-bundle',
    'A 0.1-style consent (no cart_jti, no aud) in a 0.2 bundle: it cannot be decoded, so its key cannot be checked either.',
    await w.resign({ cart: { ...w.cart, consent: { ...w.cart.consent, signature: legacyConsent.jws } } }),
    base,
    expectation('REJECT', ['V01_SIGNATURE', 'V02_KEY_STATUS']),
  );
  add('v01-consent-copied-from-another-cart','The agent builds a different cart and pastes in the wallet consent signed for the approved cart. Even with a matching wallet record and catalog, the consent does not cover the new cart hash.', makeBundle(w.mandateJws, swapCart.jws), swapContext, expectation('REJECT', ['V01_SIGNATURE']));
  const editedPayload = { ...w.mandate, scope: { ...w.mandate.scope, max_total: '99999.00', max_per_item: '99999.00' } };
  const forgedMandate = (await signMandate(editedPayload, keys.stranger.privateKey, KIDS.wallet)).jws;
  const [mHeader, , mSignature] = w.mandateJws.split('.');
  add('v01-edited-mandate-scope', 'The mandate payload is edited to raise the limits but the original wallet signature is kept.', makeBundle(`${mHeader}.${forgedMandate.split('.')[1]}.${mSignature}`, w.cartJws), base, expectation('REJECT', ['V01_SIGNATURE', 'V06_MANDATE_BINDING']));
  add('v01-unknown-kid', 'The cart is signed under a kid that is not in the registry.', makeBundle(w.mandateJws, (await signCart(w.cart, keys.agent.privateKey, 'ap_unknown#1')).jws), base, expectation('REJECT', ['V01_SIGNATURE', 'V02_KEY_STATUS', 'V06_MANDATE_BINDING']));

  // V02 key status
  add('v02-revoked-agent-key', 'The agent platform key was revoked before now and before the cart was issued.', w.bundle, { ...base, registry: agentRegistry({ status: 'revoked', status_changed_at: T0 + 500 }) }, expectation('REJECT', ['V02_KEY_STATUS']));
  add('v02-key-revoked-later-is-fine', 'The agent key will be revoked in the future; the warrant is still valid now.', w.bundle, { ...base, registry: agentRegistry({ status: 'revoked', status_changed_at: T0 + 100_000 }) }, expectation('ACCEPT'));

  // V03 freshness
  add('v03-expired-mandate', 'The mandate (and cart) are long expired.', w.bundle, { ...base, now: T0 + 7200 }, expectation('REJECT', ['V03_FRESHNESS']));
  add('v03-expired-cart', 'The cart warrant expired more than 60 seconds ago; the mandate is still valid.', w.bundle, { ...base, now: T0 + 1500 + 61 }, expectation('REJECT', ['V03_FRESHNESS']));
  add('v03-within-skew', 'The cart expired 60 seconds ago: still inside the allowed clock skew.', w.bundle, { ...base, now: T0 + 1500 + 60 }, expectation('ACCEPT'));
  const longCart: CartPayload = { ...w.cart, exp: w.cart.iat + 901 };
  add('v03-cart-lifetime-too-long', 'The cart warrant claims a 901-second lifetime; the maximum is 900.', await w.resign({ cart: longCart }), base, expectation('REJECT', ['V03_FRESHNESS']));

  // A wallet-signed mandate that is replaced by an edited one, with the cart re-pointed at it (human_not_present, so no consent is involved).
  const reissue = (mandate: typeof noConsent.mandate) =>
    noConsent.resign({ mandate, cart: { ...noConsent.cart, mandate: { jti: mandate.jti, hash: hashMandate(mandate) } } });
  const noConsentContext = contextOf(noConsent);
  add('v03-cart-issued-before-mandate-valid', 'The cart was issued 100 seconds before the mandate became valid (more than the 60 second skew).', await reissue({ ...noConsent.mandate, iat: T0 + 700, nbf: T0 + 700 }), noConsentContext, expectation('REJECT', ['V03_FRESHNESS']));
  add('v03-cart-issued-after-mandate-expired', 'The cart was issued 61 seconds after the mandate expired.', await reissue({ ...noConsent.mandate, exp: T0 + 539 }), noConsentContext, expectation('REJECT', ['V03_FRESHNESS']));
  add('v03-mandate-issued-after-valid-from', 'The mandate claims to have been issued one second after its not-before time.', await reissue({ ...noConsent.mandate, iat: T0 + 1, nbf: T0 }), noConsentContext, expectation('REJECT', ['V03_FRESHNESS']));

  // V04, V05
  add('v04-other-merchant', 'The warrant is addressed to a different merchant.', w.bundle, { ...base, merchant_id: 'OTHERMERCHANT' }, expectation('REJECT', ['V04_AUDIENCE']));
  add('v05-replayed-nonce', 'The merchant has already seen this nonce.', w.bundle, { ...base, used_nonces: [w.cart.nonce] }, expectation('REJECT', ['V05_NONCE']));
  add('v05-replayed-jti-fresh-nonce', 'The merchant has already seen this cart warrant jti, although the nonce is new: a consent signs one jti, so it cannot be spent twice.', w.bundle, { ...base, used_cart_jtis: [w.cart.jti] }, expectation('REJECT', ['V05_NONCE']));

  // V06 mandate binding
  const wrongMandateRef: CartPayload = { ...w.cart, mandate: { jti: w.cart.mandate.jti, hash: hashText('another mandate') } };
  add('v06-mandate-hash-mismatch', 'The cart references a different mandate hash than the mandate presented.', await w.resign({ cart: wrongMandateRef }), base, expectation('REJECT', ['V06_MANDATE_BINDING']));
  add('v06-instruction-hash-mismatch', 'The mandate instruction text was changed but instruction.hash still hashes the original request.', await reissue({ ...noConsent.mandate, instruction: { ...noConsent.mandate.instruction, text: 'Buy whatever you like' } }), noConsentContext, expectation('REJECT', ['V06_MANDATE_BINDING']));

  // V07 cart hash (human_not_present, so no consent signature is involved)
  const cartHashWrong: CartPayload = { ...noConsent.cart, cart_hash: hashText('something else') };
  add('v07-cart-hash-mismatch', 'cart_hash is not the hash of the canonical cart object.', await noConsent.resign({ cart: cartHashWrong }), contextOf(noConsent), expectation('REJECT', ['V07_CART_HASH']));
  const totalWrongBody = { ...noConsent.cartBody, total: '1.00' };
  const totalWrong: CartPayload = { ...noConsent.cart, cart: totalWrongBody, cart_hash: hashCartBody(totalWrongBody) };
  add('v07-total-does-not-sum', 'cart.total does not equal the sum of the lines (the hash was recomputed, so only the sum check catches it, and the catalog total disagrees too).', await noConsent.resign({ cart: totalWrong }), contextOf(noConsent), expectation('REJECT', ['V07_CART_HASH', 'V08_REPRICE']));

  // V08 reprice
  const repriced = contextOf(w, { catalog: { ...base.catalog, [SKU]: { ...(base.catalog[SKU] ?? { unit_price_cents: 0, currency: 'USD', available: true, category: null, listing_hash: null }), unit_price_cents: 12_900 } } });
  add('v08-merchant-repriced', 'The merchant catalog now prices the item higher than the cart.', w.bundle, repriced, expectation('REJECT', ['V08_REPRICE']));
  const unavailable = contextOf(w, { catalog: { ...base.catalog, [SKU]: { ...(base.catalog[SKU] ?? { unit_price_cents: 0, currency: 'USD', available: true, category: null, listing_hash: null }), available: false } } });
  add('v08-unavailable', 'The item is out of stock at the merchant.', w.bundle, unavailable, expectation('REJECT', ['V08_REPRICE']));

  // V09 scope
  const tooBig = await makeWorld({ keys, scope: { maxTotalCents: 5000 } });
  add('v09-total-above-max', 'The cart total exceeds the mandate max_total.', tooBig.bundle, contextOf(tooBig), expectation('REJECT', ['V09_SCOPE']));
  const denied = await makeWorld({ keys, scope: { merchantsDeny: [MERCHANT_ID] } });
  add('v09-merchant-denied', 'The mandate denies this merchant.', denied.bundle, contextOf(denied), expectation('REJECT', ['V09_SCOPE']));
  const category = await makeWorld({ keys, scope: { categoriesAllow: ['books'] } });
  add('v09-category-not-allowed', 'The mandate only allows books; the item is office furniture.', category.bundle, contextOf(category), expectation('REJECT', ['V09_SCOPE']));

  // G2: cumulative budget. The honest cart is 89.00 and one item; the mandate allows 120.00 and 2 items in total.
  const spend = (total_cents: number, item_count: number): VectorContext['spent_under_mandate'] => ({ total_cents, item_count });
  add('v09-cumulative-total-exceeded', '32.00 and one item were already bought under this cumulative mandate; 32.00 + 89.00 = 121.00 is above the 120.00 budget.', w.bundle, { ...base, spent_under_mandate: spend(3200, 1) }, expectation('REJECT', ['V09_SCOPE']));
  add('v09-cumulative-items-exceeded', 'Two items were already bought under this cumulative mandate (max 2); one more is over the item budget.', w.bundle, { ...base, spent_under_mandate: spend(0, 2) }, expectation('REJECT', ['V09_SCOPE']));
  add('v09-cumulative-exactly-at-limit', '31.00 and one item already bought: 31.00 + 89.00 = 120.00 and 1 + 1 = 2 are exactly the budget, which is allowed.', w.bundle, { ...base, spent_under_mandate: spend(3100, 1) }, expectation('ACCEPT'));
  add('v09-cumulative-spend-unknown', 'The spend under a cumulative mandate is unknown: the budget cannot be checked, so the verifier asks for review.', w.bundle, { ...base, spent_under_mandate: null }, expectation('REVIEW', [], ['V09_SCOPE']));
  add('v09-cumulative-not-configured', 'The verifier is given no spend source for a cumulative mandate: review, never a silent pass.', w.bundle, { ...base, spent_under_mandate: 'not_configured' }, expectation('REVIEW', [], ['V09_SCOPE']));
  const perCart = await makeWorld({ keys, scope: { budgetMode: 'per_cart' } });
  add('v09-per-cart-ignores-spend', 'A per_cart mandate applies its limits to each cart separately; a huge recorded spend does not matter.', perCart.bundle, { ...contextOf(perCart), spent_under_mandate: spend(99_999_900, 99) }, expectation('ACCEPT'));

  // V10 consent
  add('v10-wallet-record-mismatch', 'The wallet recorded a different screen for this cart than the consent claims.', w.bundle, { ...base, wallet_records: { [w.cart.jti]: hashText('a different screen') } }, expectation('REJECT', ['V10_CONSENT']));
  add('v10-wallet-record-for-other-jti', 'The wallet only has a record for a different cart warrant jti. The record is looked up by jti, so it does not count.', w.bundle, { ...base, wallet_records: { crt_SOMEONE_ELSE: PRESENTED_HASH } }, expectation('REJECT', ['V10_CONSENT']));
  const needsHuman = await makeWorld({ keys, scopeMode: 'human_present', consentMode: 'human_not_present' });
  add('v10-human-required-but-absent', 'The mandate requires a human_present consent; the cart claims human_not_present.', needsHuman.bundle, contextOf(needsHuman), expectation('REJECT', ['V10_CONSENT']));

  // V12 velocity
  add('v12-principal-over-limit', 'The principal already has 3 warrants in the window (limit 3): review, not reject.', w.bundle, { ...base, velocity: { window_seconds: 3600, max_per_principal: 3, max_per_platform: 100, prior_count_principal: 3, prior_count_platform: 0 } }, expectation('REVIEW', [], ['V12_VELOCITY']));
  add('v12-under-limit', 'Velocity is configured and under both limits.', w.bundle, { ...base, velocity: { window_seconds: 3600, max_per_principal: 3, max_per_platform: 100, prior_count_principal: 2, prior_count_platform: 99 } }, expectation('ACCEPT'));

  return out;
}

// ---------------------------------------------------------------------------------------------
// Payer binding, outcome table, ledger, hashing
// ---------------------------------------------------------------------------------------------

export interface PayerVector {
  name: string;
  bundle: { warrant_version: string; mandate: string; cart: string };
  payer_id: string;
  payer_id_hash: string;
  expected: 'ACCEPT' | 'REVIEW' | 'REJECT';
  first_use: boolean;
}

async function payerVectors(): Promise<PayerVector[]> {
  const keys = vectorKeys();
  const bound = await makeWorld({ keys });
  const unbound = await makeWorld({ keys, payerBound: false });
  const mk = (name: string, w: World, payer: string, expected: PayerVector['expected'], firstUse: boolean): PayerVector => ({
    name,
    bundle: w.bundle,
    payer_id: payer,
    payer_id_hash: hashPayerId(payer),
    expected,
    first_use: firstUse,
  });
  return [
    mk('v11-payer-matches', bound, PAYER_ID, 'ACCEPT', false),
    mk('v11-payer-mismatch', bound, 'SOMEONEELSE99', 'REJECT', false),
    mk('v11-first-use', unbound, PAYER_ID, 'REVIEW', true),
  ];
}

export interface OutcomeVector {
  name: string;
  claim: string;
  facts: FactOverrides;
  expected: { outcome: string; rule: string; action: string; confidence: 'normal' | 'low'; attribution: { agent_platform: string; merchant: string; principal: string } };
}

const attribution = (agent_platform: string, merchant: string, principal: string) => ({ agent_platform, merchant, principal });

function outcomeVectors(): OutcomeVector[] {
  const v = (name: string, claim: string, facts: FactOverrides, outcome: string, rule: string, action: string, attr: OutcomeVector['expected']['attribution'], confidence: 'normal' | 'low' = 'normal'): OutcomeVector => ({
    name,
    claim,
    facts,
    expected: { outcome, rule, action, confidence, attribution: attr },
  });
  const none = attribution('none', 'none', 'none');
  const unknown = attribution('unknown', 'unknown', 'unknown');
  return [
    v('unauthorized-authorisation-confirmed', 'UNAUTHORIZED', {}, 'FIGHT', 'UNAUTHORIZED_1_AUTHORISATION_CONFIRMED', 'provide-evidence', attribution('none', 'none', 'primary')),
    v('unauthorized-agent-cart-differs-strict-merchant', 'UNAUTHORIZED', { bundleCartMatchesConsent: false, consentCoverageGap: true }, 'ACCEPT_AGENT_FAULT', 'UNAUTHORIZED_2_ORDER_DIFFERS_FROM_CONSENT', 'accept-claim', attribution('primary', 'none', 'none')),
    v('unauthorized-agent-cart-differs-permissive-merchant', 'UNAUTHORIZED', { bundleCartMatchesConsent: false, consentCoverageGap: true, merchantMode: 'PERMISSIVE' }, 'ACCEPT_AGENT_FAULT', 'UNAUTHORIZED_2_ORDER_DIFFERS_FROM_CONSENT', 'accept-claim', attribution('primary', 'contributing', 'none')),
    v('unauthorized-agent-cart-differs-signature-invalid', 'UNAUTHORIZED', { F2: false, bundleCartMatchesConsent: false, F9: false }, 'NO_PROOF', 'UNAUTHORIZED_4_NO_PROOF', 'accept-claim', unknown),
    v('unauthorized-merchant-changed-order', 'UNAUTHORIZED', { orderMatchesBundleCart: false }, 'ACCEPT_AGENT_FAULT', 'UNAUTHORIZED_2_ORDER_DIFFERS_FROM_CONSENT', 'accept-claim', attribution('none', 'primary', 'none')),
    v('unauthorized-outside-mandate', 'UNAUTHORIZED', { F6: false }, 'ACCEPT_AGENT_FAULT', 'UNAUTHORIZED_3_OUTSIDE_MANDATE', 'accept-claim', attribution('primary', 'none', 'none')),
    v('unauthorized-bad-signature-no-delivery', 'UNAUTHORIZED', { F2: false, F9: false }, 'NO_PROOF', 'UNAUTHORIZED_4_NO_PROOF', 'accept-claim', unknown),
    v('unauthorized-bad-signature-delivered', 'UNAUTHORIZED', { F2: false, F9: true }, 'NO_PROOF', 'UNAUTHORIZED_4_NO_PROOF', 'provide-evidence', unknown, 'low'),
    v('unauthorized-payer-not-bound', 'UNAUTHORIZED', { F7: false, F9: false }, 'NO_PROOF', 'UNAUTHORIZED_4_NO_PROOF', 'accept-claim', unknown),
    v('unauthorized-no-warrant', 'UNAUTHORIZED', { F1: false, F2: false, F3: false, F4: false, F5: false, F6: false, F7: false, F8: false, bundleCartMatchesConsent: false, F9: false }, 'NO_PROOF', 'UNAUTHORIZED_4_NO_PROOF', 'accept-claim', unknown),
    v('unauthorized-table-gap-consent', 'UNAUTHORIZED', { F4: false }, 'ESCALATE_TO_HUMAN', 'UNAUTHORIZED_GAP', 'alert', unknown),
    v('unauthorized-table-gap-nonce', 'UNAUTHORIZED', { F8: false }, 'ESCALATE_TO_HUMAN', 'UNAUTHORIZED_GAP', 'alert', unknown),
    v('not-received-delivered-on-time', 'NOT_RECEIVED', { F9: true, onTime: true }, 'FIGHT', 'NOT_RECEIVED_1_DELIVERED_ON_TIME', 'provide-evidence', none),
    v('not-received-not-delivered', 'NOT_RECEIVED', { F9: false, onTime: false }, 'REFUND_MERCHANT_FAULT', 'NOT_RECEIVED_2_NOT_DELIVERED', 'make-offer', attribution('none', 'primary', 'none')),
    v('not-received-delivered-late', 'NOT_RECEIVED', { F9: true, onTime: false }, 'ESCALATE_TO_HUMAN', 'NOT_RECEIVED_GAP', 'alert', unknown),
    v('not-as-described-listing-matches', 'NOT_AS_DESCRIBED', { F10: true }, 'FIGHT', 'NOT_AS_DESCRIBED_1_LISTING_MATCHES', 'provide-evidence', none),
    v('not-as-described-listing-differs', 'NOT_AS_DESCRIBED', { F10: false }, 'REFUND_MERCHANT_FAULT', 'NOT_AS_DESCRIBED_2_LISTING_DIFFERS', 'make-offer', attribution('none', 'primary', 'none')),
    v('wrong-amount-agent-changed-cart', 'WRONG_AMOUNT', { bundleCartMatchesConsent: false }, 'ACCEPT', 'WRONG_AMOUNT_1_ORDER_DIFFERS_FROM_CONSENT', 'accept-claim', attribution('primary', 'none', 'none')),
    v('wrong-amount-merchant-changed-order', 'WRONG_AMOUNT', { orderMatchesBundleCart: false }, 'ACCEPT', 'WRONG_AMOUNT_1_ORDER_DIFFERS_FROM_CONSENT', 'accept-claim', attribution('none', 'primary', 'none')),
    v('wrong-amount-order-matches', 'WRONG_AMOUNT', {}, 'ESCALATE_TO_HUMAN', 'WRONG_AMOUNT_GAP', 'alert', unknown),
    v('duplicate-has-no-rule', 'DUPLICATE', {}, 'ESCALATE_TO_HUMAN', 'DUPLICATE_NO_ROW', 'alert', unknown),
    v('other-has-no-rule', 'OTHER', {}, 'ESCALATE_TO_HUMAN', 'OTHER_NO_ROW', 'alert', unknown),
    v('any-already-refunded', 'UNAUTHORIZED', { F11: true }, 'ALREADY_RESOLVED', 'ANY_F11_ALREADY_REFUNDED', 'none', unknown),
    v('any-deadline-under-24h', 'NOT_RECEIVED', { F12: 23 }, 'ESCALATE_TO_HUMAN', 'ANY_F12_DEADLINE_SOON', 'alert', unknown),
    v('any-deadline-exactly-24h', 'NOT_RECEIVED', { F9: true, onTime: true, F12: 24 }, 'FIGHT', 'NOT_RECEIVED_1_DELIVERED_ON_TIME', 'provide-evidence', none),
    v('any-deadline-unknown', 'NOT_RECEIVED', { F12: null }, 'ESCALATE_TO_HUMAN', 'ANY_F12_DEADLINE_UNKNOWN', 'alert', unknown),
    v('any-amount-exceeds-capture', 'UNAUTHORIZED', { F13: false }, 'ESCALATE_TO_HUMAN', 'ANY_F13_AMOUNT_EXCEEDS_CAPTURE', 'alert', unknown),
    v('any-refunded-beats-deadline', 'UNAUTHORIZED', { F11: true, F12: 1 }, 'ALREADY_RESOLVED', 'ANY_F11_ALREADY_REFUNDED', 'none', unknown),
  ];
}

// ---------------------------------------------------------------------------------------------
// Dispute facts vectors
// ---------------------------------------------------------------------------------------------

export interface FactsInputJson {
  now: number;
  merchant_id: string;
  merchant_mode: MerchantMode;
  category_of: Record<string, string>;
  nonce_use_count: number;
  jti_use_count: number;
  spent_before: { total_cents: number; item_count: number } | null;
  order: { id: string; currency: string; total_cents: number; payer_id: string | null; lines: Array<{ sku: string | null; quantity: number; unit_amount_cents: number }> | null } | null;
  capture: { id: string; amount_cents: number; currency: string } | null;
  dispute: { id: string; disputed_amount_cents: number; response_due_by: number | null };
  tracking: { delivered: boolean; delivered_at: number | null; promised_by: number | null; tracking_number: string | null } | null;
  fulfilled_listings: Record<string, string> | null;
  refunds: Array<{ id: string; amount_cents: number }>;
  transparency: { included: boolean; seq: number | null; entry_hash: string | null; logged_at: number | null } | null;
}

export interface FactsVector {
  name: string;
  description: string;
  bundle: { warrant_version: string; mandate: string; cart: string };
  registry: VectorRegistryKey[];
  /** Wallet records keyed by cart warrant jti. */
  wallet_records: Record<string, string>;
  input: FactsInputJson;
  /** Hand-authored values of F1-F13 (F12 is hours). */
  expected: Record<string, boolean | number | null>;
  /** Extra checks on F6 detail, when the vector is about the budget. */
  expected_f6_cumulative_checked?: boolean;
}

function factsInputToJson(input: FactsInput, categories: Record<string, string>): FactsInputJson {
  const spend = input.spentBefore;
  return {
    now: input.now,
    merchant_id: input.merchantId,
    merchant_mode: input.merchantMode,
    category_of: categories,
    nonce_use_count: input.nonceUseCount,
    jti_use_count: input.jtiUseCount,
    spent_before: spend === null ? null : { total_cents: spend.totalCents, item_count: spend.itemCount },
    order:
      input.order === null
        ? null
        : {
            id: input.order.id,
            currency: input.order.currency,
            total_cents: input.order.totalCents,
            payer_id: input.order.payerId,
            lines: input.order.lines === null ? null : input.order.lines.map((l) => ({ sku: l.sku, quantity: l.quantity, unit_amount_cents: l.unitAmountCents })),
          },
    capture: input.capture === null ? null : { id: input.capture.id, amount_cents: input.capture.amountCents, currency: input.capture.currency },
    dispute: { id: input.dispute.id, disputed_amount_cents: input.dispute.disputedAmountCents, response_due_by: input.dispute.responseDueBy },
    tracking:
      input.tracking === null
        ? null
        : { delivered: input.tracking.delivered, delivered_at: input.tracking.deliveredAt, promised_by: input.tracking.promisedBy, tracking_number: input.tracking.trackingNumber },
    fulfilled_listings: input.fulfilledListings === null ? null : { ...input.fulfilledListings },
    refunds: input.refunds.map((r) => ({ id: r.id, amount_cents: r.amountCents })),
    transparency:
      input.transparency === null
        ? null
        : { included: input.transparency.included, seq: input.transparency.seq, entry_hash: input.transparency.entryHash, logged_at: input.transparency.loggedAt },
  };
}

/** Rebuild FactsInput from the JSON alone, to prove the facts vectors are self-contained. */
export function factsInputFromJson(v: FactsVector): FactsInput {
  const j = v.input;
  const context = contextFromJson({
    now: j.now,
    merchant_id: j.merchant_id,
    registry: v.registry,
    catalog: {},
    wallet_records: v.wallet_records,
    used_nonces: [],
    used_cart_jtis: [],
    spent_under_mandate: null,
    velocity: null,
  });
  return {
    now: j.now,
    bundle: v.bundle,
    merchantId: j.merchant_id,
    merchantMode: j.merchant_mode,
    registry: context.registry,
    categoryOf: (sku) => j.category_of[sku] ?? null,
    walletRecord: context.walletRecord,
    nonceUseCount: j.nonce_use_count,
    jtiUseCount: j.jti_use_count,
    spentBefore: j.spent_before === null ? null : { totalCents: j.spent_before.total_cents, itemCount: j.spent_before.item_count },
    order:
      j.order === null
        ? null
        : { id: j.order.id, currency: j.order.currency, totalCents: j.order.total_cents, payerId: j.order.payer_id, lines: j.order.lines === null ? null : j.order.lines.map((l) => ({ sku: l.sku, quantity: l.quantity, unitAmountCents: l.unit_amount_cents })) },
    capture: j.capture === null ? null : { id: j.capture.id, amountCents: j.capture.amount_cents, currency: j.capture.currency },
    dispute: { id: j.dispute.id, disputedAmountCents: j.dispute.disputed_amount_cents, responseDueBy: j.dispute.response_due_by },
    tracking:
      j.tracking === null
        ? null
        : { delivered: j.tracking.delivered, deliveredAt: j.tracking.delivered_at, promisedBy: j.tracking.promised_by, trackingNumber: j.tracking.tracking_number },
    fulfilledListings: j.fulfilled_listings,
    refunds: j.refunds.map((r) => ({ id: r.id, amountCents: r.amount_cents })),
    transparency:
      j.transparency === null
        ? null
        : { included: j.transparency.included, seq: j.transparency.seq, entryHash: j.transparency.entry_hash, loggedAt: j.transparency.logged_at },
  };
}

async function factsVectors(): Promise<FactsVector[]> {
  const keys = vectorKeys();
  const w = await makeWorld({ keys });
  const registry = registryToJson([w.registryKeys.wallet, w.registryKeys.agent]);
  const wallet_records = contextOf(w).wallet_records;
  const categories: Record<string, string> = { [SKU]: 'office_furniture' };
  const clean: Record<string, boolean | number | null> = {
    F1: true, F2: true, F3: true, F4: true, F5: true, F6: true, F7: true, F8: true, F9: true, F10: true, F11: false, F12: 120, F13: true,
  };
  const make = (name: string, description: string, overrides: Partial<FactsInput>, expected: Record<string, boolean | number | null>, f6Checked?: boolean): FactsVector => ({
    name,
    description,
    bundle: w.bundle,
    registry,
    wallet_records,
    input: factsInputToJson(factsInput(w, overrides), categories),
    expected: { ...clean, ...expected },
    ...(f6Checked === undefined ? {} : { expected_f6_cumulative_checked: f6Checked }),
  });
  return [
    make('facts-clean', 'An honest warrant, an order that matches it, delivered on time. F1-F10 and F13 hold, nothing is refunded, 120 hours remain.', {}, {}, true),
    make('facts-jti-used-twice', 'The nonce was used once but the cart warrant jti was recorded twice: the consent was spent twice, so F8 is false.', { jtiUseCount: 2 }, { F8: false }),
    make('facts-nonce-used-twice', 'The jti was used once but the nonce twice.', { nonceUseCount: 2 }, { F8: false }),
    make('facts-cumulative-over-budget', 'When this cart was accepted 32.00 and one item were already spent under the cumulative mandate: 121.00 is above the 120.00 budget, so F6 is false.', { spentBefore: { totalCents: 3200, itemCount: 1 } }, { F6: false }, true),
    make('facts-cumulative-at-limit', 'Exactly at the budget (31.00 + 89.00 = 120.00, 1 + 1 = 2 items): F6 holds.', { spentBefore: { totalCents: 3100, itemCount: 1 } }, {}, true),
    make('facts-cumulative-spend-unknown', 'The spend recorded at acceptance is unknown. F6 is decided on the per-cart limits alone and says the cumulative check was not made; the agent platform is not blamed for what cannot be shown.', { spentBefore: null }, {}, false),
    make('facts-refunded', 'A refund already exists for the capture: F11 is true.', { refunds: [{ id: 'REF1', amountCents: 8900 }] }, { F11: true }),
  ];
}

export interface LedgerVector {
  chain_id: string;
  entries: LedgerEntry[];
  head_hash: string;
  tampered: { description: string; entries: unknown; expected_broken_seq: number; expected_reason: string };
}

function ledgerVector(cartHash: string, cartJti: string): LedgerVector {
  const chainId = 'vector-chain';
  const drafts = [
    { type: 'WARRANT_ISSUED', payload: { cart_hash: cartHash, cart_jti: cartJti } },
    { type: 'DISPUTE_OPENED', payload: { dispute_id: 'PP-D-1', reason: 'UNAUTHORIZED' } },
    { type: 'ACTION_PROPOSED', payload: { outcome: 'FIGHT', rule: 'UNAUTHORIZED_1_AUTHORISATION_CONFIRMED' } },
  ];
  const entries: LedgerEntry[] = [];
  let previous: LedgerEntry | null = null;
  for (const draft of drafts) {
    previous = appendEntry(previous, { chainId, ...draft });
    entries.push(previous);
  }
  const tampered = JSON.parse(JSON.stringify(entries)) as Array<{ payload: { outcome?: string } }>;
  (tampered[2] as { payload: { outcome?: string } }).payload.outcome = 'ACCEPT_AGENT_FAULT';
  return {
    chain_id: chainId,
    entries,
    head_hash: (previous as LedgerEntry).hash,
    tampered: { description: 'The payload of entry 3 is edited; the stored hash no longer matches.', entries: tampered, expected_broken_seq: 3, expected_reason: 'HASH_MISMATCH' },
  };
}

export interface HashVectors {
  genesis_hash: string;
  text: Array<{ input: string; hash: string }>;
  canonical_json: Array<{ input: unknown; canonical: string; hash: string }>;
  money: { valid: Array<{ decimal: string; cents: number }>; invalid: string[] };
}

function hashVectors(): HashVectors {
  const rfcString = String.fromCodePoint(0x20ac, 0x24, 0x0f, 0x0a, 0x41, 0x27, 0x42, 0x22, 0x5c, 0x5c, 0x22, 0x2f);
  const jsonInputs: unknown[] = [
    { b: 2, a: [true, null, 'x'], c: { z: 1, y: 2 } },
    { numbers: [333333333.3333333, 1e30, 4.5, 0.002, 1e-27], string: rfcString, literals: [null, true, false] },
    { amount: '89.99', qty: 3, nested: { list: [3, 2, 1] } },
  ];
  const decimals = ['0', '0.5', '0.05', '1', '89', '89.0', '89.99', '300.00', '1000000.01'];
  return {
    genesis_hash: GENESIS_HASH,
    text: ['', 'abc', 'Find a standing desk converter under $120'].map((input) => ({ input, hash: hashText(input) })),
    canonical_json: jsonInputs.map((input) => ({ input, canonical: canonicalize(input), hash: hashJson(input) })),
    money: {
      valid: decimals.map((decimal) => ({ decimal, cents: parseMoney(decimal) })),
      invalid: ['', '1.', '.5', '-1.00', '+1.00', '1.005', '1,000.00', '1e3', '01.00', ' 1.00', '1.00 '],
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The whole file
// ---------------------------------------------------------------------------------------------

export async function buildVectors(): Promise<Record<string, unknown>> {
  const keys = vectorKeys();
  const w = await makeWorld({ keys });
  const refs = paypalReferences(w.cart);
  const keyJson = (label: string, key: SeededKey, kid: string, owner: string) => ({
    label,
    kid,
    owner,
    test_only_seed_hex: key.seedHex,
    private_key_pkcs8_b64: key.privateKeyBase64,
    public_key_spki_b64: exportVerificationKey(key.publicKey),
  });
  const cartExample = buildCartPayload({
    jti: w.cart.jti,
    iss: w.cart.iss,
    aud: w.cart.aud,
    iat: w.cart.iat,
    exp: w.cart.exp,
    nonce: w.cart.nonce,
    mandate: w.cart.mandate,
    cart: w.cartBody,
    consent: w.cart.consent,
  });

  return {
    vectors_version: VECTORS_VERSION,
    spec: 'docs/warrant-spec.md (v0.2)',
    warning:
      'TEST KEYS ONLY. The private keys below are derived from public labels (seed = SHA-256 of "warrant-test-vector:<label>") and protect nothing. Never use them outside tests.',
    regenerate: 'pnpm --filter @warrant/warrant vectors',
    how_to_use: [
      'hashing: reproduce every hash and canonical form.',
      'keys: Ed25519 private keys are base64 PKCS#8 DER (seed = last 32 bytes); public keys are base64 SPKI DER.',
      'honest: re-sign the payloads with the keys and compare JWS strings (Ed25519 is deterministic).',
      'verify: run your verifier on each bundle with its context; compare the outcome and the rules that reject or ask for review.',
      'payer_binding, facts, outcome_table, ledger: reproduce the expected results. Each facts vector carries its own bundle, registry, wallet records and inputs.',
    ],
    hashing: hashVectors(),
    keys: {
      wallet: keyJson('wallet', keys.wallet, KIDS.wallet, w.registryKeys.wallet.owner),
      agent: keyJson('agent', keys.agent, KIDS.agent, w.registryKeys.agent.owner),
      stranger: keyJson('stranger', keys.stranger, 'not-registered', 'nobody'),
    },
    honest: {
      mandate: { payload: w.mandate, jws: w.mandateJws, hash: w.mandateHash },
      cart_body: w.cartBody,
      cart_hash: w.cartHash,
      consent: { jws: w.consentJws, covers: { cart_hash: w.cartHash, cart_jti: w.cart.jti, aud: w.cart.aud, presented_hash: PRESENTED_HASH, approved_at: w.cart.consent.approved_at, mandate_hash: w.mandateHash } },
      cart: { payload: cartExample, jws: w.cartJws, warrant_hash: hashCartWarrant(w.cart) },
      bundle: w.bundle,
      paypal_references: refs,
      now: w.ctx.now,
    },
    verify: await verifyVectors(),
    payer_binding: await payerVectors(),
    facts: await factsVectors(),
    outcome_table: {
      facts_defaults: {
        F1: true, F2: true, F3: true, F4: true, F5: true, F6: true, F7: true, F8: true, F9: true, onTime: true, F10: true, F11: false, F12: 120, F13: true,
        merchantMode: 'STRICT', bundleCartMatchesConsent: true, orderMatchesBundleCart: true,
      },
      note: 'F5 is true exactly when bundleCartMatchesConsent and orderMatchesBundleCart are both true. Only listed overrides differ from the defaults; an explicit F5 override wins.',
      vectors: outcomeVectors(),
    },
    ledger: ledgerVector(w.cartHash, w.cart.jti),
  };
}

export async function serializeVectors(): Promise<string> {
  return `${JSON.stringify(await buildVectors(), null, 2)}\n`;
}

