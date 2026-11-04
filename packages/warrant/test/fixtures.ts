import { hashText } from '../src/canonical';
import type { FactsInput } from '../src/facts';
import { generateSigningKey, type SigningKeyPair } from '../src/keys';
import { staticRegistry, type RegistryKey, type RegistryLookup } from '../src/registry';
import type { Bundle, CartBody, CartPayload, ConsentMode, MandatePayload } from '../src/schema';
import { formatInstant } from '../src/time';
import type { CatalogOffer, Spend, VerifyContext, WalletRecord } from '../src/verify';
import {
  agentIssuer,
  buildCartBody,
  buildCartPayload,
  buildHumanPresentConsent,
  buildMandate,
  hashCartBody,
  hashMandate,
  HUMAN_NOT_PRESENT_CONSENT,
  makeBundle,
  merchantAudience,
  signCart,
  signConsent,
  signMandate,
  type CartLineInput,
  type MandateInput,
} from '../src/warrant';

/** 1793000000: the timestamp used in docs/warrant-spec.md section 10. */
export const T0 = 1_793_000_000;
/** The verifier's clock in tests: 100 seconds after the cart was issued, 800 seconds into the mandate. */
export const NOW = T0 + 700;
export const MERCHANT_ID = 'DEMOMERCHANTID';
export const WALLET_ISS = 'wallet:demo-wallet';
export const PLATFORM = 'ap_demo_shopper';
export const AGENT_ID = 'shopper-1';
export const KIDS = { wallet: 'wallet-2026-10', agent: `${PLATFORM}#2026-10` } as const;
export const SKU = 'c3_abc123';
export const PAYER_ID = 'PAYERID1234567';
export const LISTING_HASH = hashText('listing:c3_abc123:v1');
export const PRESENTED_HASH = hashText('screen:cart:desk-converter');

export const defaultLines: CartLineInput[] = [
  { sku: SKU, title: 'Desk converter 32in', qty: 1, unitPriceCents: 8900, listingHash: LISTING_HASH },
];

export interface WorldOptions {
  /** `scope.mode` of the mandate. Default human_present. */
  readonly scopeMode?: ConsentMode;
  /** The consent mode the cart carries. Default: same as the scope mode. */
  readonly consentMode?: ConsentMode;
  /** Whether the mandate already carries the principal's payer hash. Default true. */
  readonly payerBound?: boolean;
  readonly scope?: Partial<MandateInput['scope']>;
  readonly lines?: CartLineInput[];
  readonly nonce?: string;
  readonly cartJti?: string;
  /** Fixed keys (for test vectors). Default: fresh random keys. */
  readonly keys?: { wallet: SigningKeyPair; agent: SigningKeyPair; stranger: SigningKeyPair };
}

export interface World {
  readonly keys: { wallet: SigningKeyPair; agent: SigningKeyPair; stranger: SigningKeyPair };
  readonly registryKeys: { wallet: RegistryKey; agent: RegistryKey };
  readonly registry: RegistryLookup;
  readonly mandateInput: MandateInput;
  readonly mandate: MandatePayload;
  readonly mandateJws: string;
  readonly mandateHash: string;
  readonly cartBody: CartBody;
  readonly cartHash: string;
  readonly consentJws: string | null;
  readonly cart: CartPayload;
  readonly cartJws: string;
  readonly bundle: Bundle;
  readonly usedNonces: Set<string>;
  /** Cart warrant jtis the merchant has already seen. */
  readonly usedJtis: Set<string>;
  /** The wallet's records, keyed by cart warrant jti. */
  readonly walletRecords: Map<string, WalletRecord>;
  /** The spend already recorded under the mandate; `ctx.spentUnderMandate` returns `spent.current`. */
  readonly spent: { current: Spend | null };
  readonly catalog: Map<string, CatalogOffer>;
  /** A verification context for the default merchant, mutable through the maps above. */
  readonly ctx: VerifyContext;
  /** Build the checks context with overrides. */
  readonly ctxWith: (overrides: Partial<VerifyContext>) => VerifyContext;
  /** Sign arbitrary (possibly adversarial) payloads with this world's wallet and agent keys. */
  readonly resign: (parts: { mandate?: MandatePayload; cart?: CartPayload }) => Promise<Bundle>;
  /** Build and sign a different cart under the same mandate (agent key), optionally with a chosen consent. */
  readonly otherCart: (lines: CartLineInput[], overrides?: Partial<Parameters<typeof buildCartPayload>[0]>) => Promise<{ cart: CartPayload; jws: string; body: CartBody; hash: string }>;
}

export async function makeWorld(options: WorldOptions = {}): Promise<World> {
  const keys = options.keys ?? { wallet: generateSigningKey(), agent: generateSigningKey(), stranger: generateSigningKey() };
  const scopeMode = options.scopeMode ?? 'human_present';
  const consentMode = options.consentMode ?? scopeMode;

  const registryKeys = {
    wallet: {
      kid: KIDS.wallet,
      kind: 'wallet',
      owner: WALLET_ISS,
      publicKey: keys.wallet.publicKey,
      status: 'active',
      validFrom: T0 - 86_400,
      validTo: null,
      statusChangedAt: null,
    } satisfies RegistryKey,
    agent: {
      kid: KIDS.agent,
      kind: 'agent',
      owner: PLATFORM,
      publicKey: keys.agent.publicKey,
      status: 'active',
      validFrom: T0 - 86_400,
      validTo: null,
      statusChangedAt: null,
    } satisfies RegistryKey,
  };
  const registry = staticRegistry([registryKeys.wallet, registryKeys.agent]);

  const payerBound = options.payerBound ?? true;
  const mandateInput: MandateInput = {
    jti: 'mnd_01JEXAMPLE',
    iss: WALLET_ISS,
    iat: T0,
    nbf: T0,
    exp: T0 + 3600,
    principalRef: 'prn_01JEXAMPLE',
    ...(payerBound ? { principalPayerIdHash: hashText(PAYER_ID) } : {}),
    agent: { platform: PLATFORM, agentId: AGENT_ID, kid: KIDS.agent },
    instructionText: 'Find a standing desk converter under $120',
    scope: {
      currency: 'USD',
      maxTotalCents: 12_000,
      maxPerItemCents: 12_000,
      maxItems: 2,
      categoriesAllow: null,
      merchantsAllow: ['*'],
      merchantsDeny: [],
      mode: scopeMode,
      budgetMode: 'cumulative',
      ...options.scope,
    },
  };
  const mandate = buildMandate(mandateInput);
  const mandateSigned = await signMandate(mandate, keys.wallet.privateKey, KIDS.wallet);
  const mandateHash = hashMandate(mandate);

  const lines = options.lines ?? defaultLines;
  const cartBody = buildCartBody('USD', lines);
  const cartHash = hashCartBody(cartBody);

  const cartJti = options.cartJti ?? 'crt_01JEXAMPLE';
  const aud = merchantAudience(MERCHANT_ID);
  const approvedAt = formatInstant(T0 + 650);
  let consentJws: string | null = null;
  let consent;
  if (consentMode === 'human_present') {
    const signed = await signConsent({ cartHash, cartJti, aud, presentedHash: PRESENTED_HASH, approvedAt, mandateHash }, keys.wallet.privateKey, KIDS.wallet);
    consentJws = signed.jws;
    consent = buildHumanPresentConsent({ approvedAt, method: 'click', presentedHash: PRESENTED_HASH, signature: signed.jws });
  } else {
    consent = HUMAN_NOT_PRESENT_CONSENT;
  }

  const cartInput = {
    jti: cartJti,
    iss: agentIssuer(PLATFORM, AGENT_ID),
    aud,
    iat: T0 + 600,
    exp: T0 + 1500,
    nonce: options.nonce ?? 'n_7f3a0001',
    mandate: { jti: mandate.jti, hash: mandateHash },
    cart: cartBody,
    consent,
  };
  const cart = buildCartPayload(cartInput);
  const cartSigned = await signCart(cart, keys.agent.privateKey, KIDS.agent);
  const bundle = makeBundle(mandateSigned.jws, cartSigned.jws);

  const usedNonces = new Set<string>();
  const usedJtis = new Set<string>();
  const walletRecords = new Map<string, WalletRecord>([[cartJti, { presentedHash: PRESENTED_HASH }]]);
  const spent: { current: Spend | null } = { current: { totalCents: 0, itemCount: 0 } };
  const catalog = new Map<string, CatalogOffer>(
    lines.map((line) => [
      line.sku,
      { unitPriceCents: line.unitPriceCents, currency: 'USD', available: true, category: 'office_furniture', listingHash: line.listingHash },
    ]),
  );

  const ctx: VerifyContext = {
    now: NOW,
    merchantId: MERCHANT_ID,
    registry,
    nonceSeen: (nonce) => usedNonces.has(nonce),
    cartSeen: (jti) => usedJtis.has(jti),
    catalog: (sku) => catalog.get(sku) ?? null,
    walletRecord: ({ cartJti: jti }) => walletRecords.get(jti) ?? null,
    velocity: { windowSeconds: 3600, maxPerPrincipal: 3, maxPerPlatform: 100, count: () => ({ principal: 0, platform: 0 }) },
    spentUnderMandate: () => spent.current,
  };

  return {
    keys,
    registryKeys,
    registry,
    mandateInput,
    mandate,
    mandateJws: mandateSigned.jws,
    mandateHash,
    cartBody,
    cartHash,
    consentJws,
    cart,
    cartJws: cartSigned.jws,
    bundle,
    usedNonces,
    usedJtis,
    walletRecords,
    spent,
    catalog,
    ctx,
    ctxWith: (overrides) => ({ ...ctx, ...overrides }),
    resign: async ({ mandate: m, cart: c }) => {
      const mandateJwsOut = m === undefined ? mandateSigned.jws : (await signMandate(m, keys.wallet.privateKey, KIDS.wallet)).jws;
      const cartJwsOut = c === undefined ? cartSigned.jws : (await signCart(c, keys.agent.privateKey, KIDS.agent)).jws;
      return makeBundle(mandateJwsOut, cartJwsOut);
    },
    otherCart: async (otherLines, overrides = {}) => {
      const body = buildCartBody('USD', otherLines);
      const payload = buildCartPayload({ ...cartInput, jti: 'crt_OTHER', nonce: 'n_other0001', cart: body, ...overrides });
      const signed = await signCart(payload, keys.agent.privateKey, KIDS.agent);
      return { cart: payload, jws: signed.jws, body, hash: hashCartBody(body) };
    },
  };
}

/** Findings for one rule, as `[outcome, detail]` pairs, for readable assertions. */
export function findingsFor(result: { findings: ReadonlyArray<{ rule: string; outcome: string; detail: string }> }, rule: string) {
  return result.findings.filter((f) => f.rule === rule);
}

export function outcomesFor(result: { findings: ReadonlyArray<{ rule: string; outcome: string }> }, rule: string): string[] {
  return result.findings.filter((f) => f.rule === rule).map((f) => f.outcome);
}

const DAY = 86_400;

/** A dispute raised three days after the cart, with everything in order. */
export function factsInput(w: World, overrides: Partial<FactsInput> = {}): FactsInput {
  const now = T0 + 3 * DAY;
  return {
    now,
    bundle: w.bundle,
    merchantId: MERCHANT_ID,
    merchantMode: 'STRICT',
    registry: w.registry,
    categoryOf: (sku) => w.catalog.get(sku)?.category ?? null,
    walletRecord: w.ctx.walletRecord,
    nonceUseCount: 1,
    jtiUseCount: 1,
    spentBefore: { totalCents: 0, itemCount: 0 },
    order: { id: 'ORDER1', currency: 'USD', totalCents: 8900, payerId: PAYER_ID, lines: [{ sku: SKU, quantity: 1, unitAmountCents: 8900 }] },
    capture: { id: 'CAP1', amountCents: 8900, currency: 'USD' },
    dispute: { id: 'PP-D-1', disputedAmountCents: 8900, responseDueBy: now + 5 * DAY },
    tracking: { delivered: true, deliveredAt: T0 + DAY, promisedBy: T0 + 3 * DAY, trackingNumber: 'TRK1' },
    fulfilledListings: { [SKU]: LISTING_HASH },
    refunds: [],
    transparency: { included: true, seq: 7, entryHash: hashText('log entry 7'), loggedAt: T0 + 601 },
    ...overrides,
  };
}
