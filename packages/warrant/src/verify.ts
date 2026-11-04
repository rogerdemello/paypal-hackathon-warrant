import { hashText } from './canonical';
import { verifyJws } from './jws';
import { addCents, isCents, mulCents, tryParseMoney, type Cents } from './money';
import { keyStateAt, type KeyKind, type RegistryLookup } from './registry';
import type { BudgetMode, Bundle, CartPayload, ConsentPayload, MandatePayload } from './schema';
import { MAX_CART_LIFETIME_SECONDS, MAX_SKEW_SECONDS, parseInstantSeconds, type NumericDate } from './time';
import {
  agentIssuer,
  cartLinesTotalCents,
  decodeBundle,
  decodeConsent,
  hashCartBody,
  merchantAudience,
  parseBundle,
  type DecodedBundle,
  type DecodedPart,
} from './warrant';

/**
 * Merchant checkout verification, V01-V12 of docs/verification-rules.md.
 *
 * `verifyCheckout` is deterministic and does no I/O. The caller supplies the registry, the merchant's own
 * catalog, the nonce store, the wallet's consent record, velocity counts and the current time. Every rule
 * always runs and reports; precedence is reject > review > accept.
 */

export type Outcome = 'ACCEPT' | 'REVIEW' | 'REJECT';
export type FindingOutcome = 'pass' | 'review' | 'reject';

export type RuleId =
  | 'V01_SIGNATURE'
  | 'V02_KEY_STATUS'
  | 'V03_FRESHNESS'
  | 'V04_AUDIENCE'
  | 'V05_NONCE'
  | 'V06_MANDATE_BINDING'
  | 'V07_CART_HASH'
  | 'V08_REPRICE'
  | 'V09_SCOPE'
  | 'V10_CONSENT'
  | 'V11_PAYER_BINDING'
  | 'V12_VELOCITY';

export interface Finding {
  readonly rule: RuleId;
  readonly outcome: FindingOutcome;
  readonly detail: string;
}

export interface VerifyResult {
  readonly outcome: Outcome;
  readonly findings: readonly Finding[];
  /** Hash of the cart object as presented (recomputed, not the claimed `cart_hash`). Null if the cart is undecodable. */
  readonly cartHash: string | null;
  /** Hash of the mandate payload as presented. Null if the mandate is undecodable. */
  readonly mandateHash: string | null;
}

/** What the merchant's own catalog says about a SKU right now (V08, V09 categories). */
export interface CatalogOffer {
  readonly unitPriceCents: Cents;
  readonly currency: string;
  readonly available: boolean;
  readonly category: string | null;
  /** When the merchant has its own listing hash for the SKU, it must equal the warrant line's `listing_hash`. */
  readonly listingHash?: string | null;
}
export type CatalogLookup = (sku: string) => CatalogOffer | null;

/** What the wallet recorded when it showed this cart to the principal (V10). */
export interface WalletRecord {
  readonly presentedHash: string;
}
/**
 * Looks up the wallet's record by cart warrant `jti` (a cart hash can have several consents) and cart hash.
 * Returns null when the wallet has no record.
 */
export type WalletRecordLookup = (key: { cartJti: string; cartHash: string }) => WalletRecord | null;

/** What has already been spent under a mandate: carts accepted (and not abandoned) before the one being verified. */
export interface Spend {
  readonly totalCents: Cents;
  /** Total units: the sum of line quantities. */
  readonly itemCount: number;
}

/** Counts of earlier warrants since `since`, not including the one being verified (V12). */
export interface VelocityContext {
  readonly windowSeconds: number;
  readonly maxPerPrincipal: number;
  readonly maxPerPlatform: number;
  readonly count: (query: { principalRef: string; platform: string; since: NumericDate }) => { principal: number; platform: number };
}

export interface VerifyContext {
  /** Current time, NumericDate seconds. The package never reads a clock. */
  readonly now: NumericDate;
  /** This merchant's id: a warrant's `aud` must be `paypal-merchant:<merchantId>`. */
  readonly merchantId: string;
  readonly registry: RegistryLookup;
  /** True if this merchant has already seen the nonce. The caller records nonces atomically after accepting. */
  readonly nonceSeen: (nonce: string) => boolean;
  /**
   * True if this merchant has already seen the cart warrant's `jti`. Record the jti together with the nonce, atomically,
   * after accepting: a consent signs one jti, so refusing a repeated jti makes the consent single-use.
   */
  readonly cartSeen: (jti: string) => boolean;
  readonly catalog: CatalogLookup;
  readonly walletRecord: WalletRecordLookup;
  /** Null disables V12 (reported as a pass that says so). */
  readonly velocity: VelocityContext | null;
  /**
   * Spend already recorded under a mandate (excluding the cart being verified), for `budget_mode: "cumulative"` mandates.
   * Return null when the spend is unknown. When this function is absent or returns null, V09 asks for review.
   * Read it, verify, and record the reservation in one transaction that locks the mandate.
   */
  readonly spentUnderMandate?: (mandateJti: string) => Spend | null;
  /** Clock skew tolerance in seconds. Default and maximum: 60. */
  readonly skewSeconds?: number;
}

export function skewOf(ctx: Pick<VerifyContext, 'skewSeconds'>): number {
  const skew = ctx.skewSeconds ?? MAX_SKEW_SECONDS;
  return Number.isFinite(skew) ? Math.min(Math.max(skew, 0), MAX_SKEW_SECONDS) : MAX_SKEW_SECONDS;
}

const pass = (rule: RuleId, detail: string): Finding => ({ rule, outcome: 'pass', detail });
const reject = (rule: RuleId, detail: string): Finding => ({ rule, outcome: 'reject', detail });
const review = (rule: RuleId, detail: string): Finding => ({ rule, outcome: 'review', detail });

/** pass finding when there are no problems, otherwise one reject finding per problem. */
function fromProblems(rule: RuleId, problems: readonly string[], passDetail: string): Finding[] {
  return problems.length === 0 ? [pass(rule, passDetail)] : problems.map((p) => reject(rule, p));
}

export function combine(findings: readonly Finding[]): Outcome {
  if (findings.some((f) => f.outcome === 'reject')) return 'REJECT';
  if (findings.some((f) => f.outcome === 'review')) return 'REVIEW';
  return 'ACCEPT';
}

// ---------------------------------------------------------------------------------------------
// Shared checks (also used by the facts engine)
// ---------------------------------------------------------------------------------------------

export interface SignatureCheck {
  readonly subject: 'cart' | 'mandate' | 'consent';
  readonly ok: boolean;
  /** For consent: whether a consent signature is present at all. */
  readonly present: boolean;
  readonly detail: string;
  readonly kid: string | null;
}

/** V01 and fact F2: verify the cart, mandate and consent signatures, and what the consent covers. */
export async function checkSignatures(bundle: Bundle, decoded: DecodedBundle, registry: RegistryLookup): Promise<SignatureCheck[]> {
  const checks: SignatureCheck[] = [];

  const one = async (subject: 'cart' | 'mandate', part: DecodedPart<unknown>, jws: string): Promise<void> => {
    if (!part.ok) {
      checks.push({ subject, ok: false, present: true, detail: `${subject} is undecodable: ${part.message}`, kid: null });
      return;
    }
    const key = registry(part.kid);
    if (key === null) {
      checks.push({ subject, ok: false, present: true, detail: `${subject} kid ${part.kid} is not in the registry`, kid: part.kid });
      return;
    }
    const verified = await verifyJws(jws, key.publicKey);
    checks.push(
      verified.ok
        ? { subject, ok: true, present: true, detail: `${subject} signature valid (kid ${part.kid})`, kid: part.kid }
        : { subject, ok: false, present: true, detail: `${subject} signature invalid (kid ${part.kid}): ${verified.error.message}`, kid: part.kid },
    );
  };
  await one('cart', decoded.cart, bundle.cart);
  await one('mandate', decoded.mandate, bundle.mandate);

  // Consent
  if (!decoded.cart.ok) {
    checks.push({ subject: 'consent', ok: false, present: false, detail: 'consent cannot be checked: cart is undecodable', kid: null });
    return checks;
  }
  const consent = decoded.cart.payload.consent;
  if (consent.signature === undefined) {
    checks.push(
      consent.mode === 'human_present'
        ? { subject: 'consent', ok: false, present: false, detail: 'human_present consent has no signature', kid: null }
        : { subject: 'consent', ok: true, present: false, detail: 'no consent signature (human_not_present)', kid: null },
    );
    return checks;
  }
  const part = decodeConsent(consent.signature);
  if (!part.ok) {
    checks.push({ subject: 'consent', ok: false, present: true, detail: `consent is undecodable: ${part.message}`, kid: null });
    return checks;
  }
  const key = registry(part.kid);
  if (key === null) {
    checks.push({ subject: 'consent', ok: false, present: true, detail: `consent kid ${part.kid} is not in the registry`, kid: part.kid });
    return checks;
  }
  const verified = await verifyJws(consent.signature, key.publicKey);
  if (!verified.ok) {
    checks.push({ subject: 'consent', ok: false, present: true, detail: `consent signature invalid (kid ${part.kid}): ${verified.error.message}`, kid: part.kid });
    return checks;
  }
  const mandateHash = decoded.mandate.ok ? decoded.mandate.hash : decoded.cart.payload.mandate.hash;
  const gaps = consentCoverageGaps(part.payload, decoded.cart.payload, mandateHash);
  checks.push(
    gaps.length === 0
      ? { subject: 'consent', ok: true, present: true, detail: `consent signature valid and covers cart_hash, presented_hash, approved_at and mandate.hash (kid ${part.kid})`, kid: part.kid }
      : { subject: 'consent', ok: false, present: true, detail: `consent signature valid but does not cover this cart: ${gaps.join(', ')}`, kid: part.kid },
  );
  return checks;
}

/** Which of the six covered values differ between the signed consent payload and the cart being presented. */
export function consentCoverageGaps(signed: ConsentPayload, cart: CartPayload, mandateHash: string): string[] {
  const gaps: string[] = [];
  if (signed.cart_hash !== cart.cart_hash) gaps.push('cart_hash');
  if (signed.cart_jti !== cart.jti) gaps.push('cart_jti');
  if (signed.aud !== cart.aud) gaps.push('aud');
  if (signed.presented_hash !== cart.consent.presented_hash) gaps.push('presented_hash');
  if (signed.approved_at !== cart.consent.approved_at) gaps.push('approved_at');
  if (signed.mandate_hash !== mandateHash) gaps.push('mandate.hash');
  return gaps;
}

export interface KeyUse {
  readonly label: 'agent' | 'wallet' | 'consent';
  readonly kid: string;
  readonly kind: KeyKind;
  /** Expected `RegistryKey.owner`. */
  readonly owner: string;
  /** When the signed object was issued (NumericDate seconds). */
  readonly issuedAt: NumericDate;
}

/** The keys a bundle relies on, with who should own them and when they were used. Undecodable parts yield problems. */
export function planKeyUses(decoded: DecodedBundle): { uses: KeyUse[]; problems: string[] } {
  const uses: KeyUse[] = [];
  const problems: string[] = [];

  if (decoded.cart.ok) {
    const cart = decoded.cart.payload;
    const match = /^agent:([^/]+)\/(.+)$/.exec(cart.iss);
    if (match === null) {
      problems.push(`cart iss ${JSON.stringify(cart.iss)} is not agent:<platform>/<agent_id>`);
    } else {
      uses.push({ label: 'agent', kid: decoded.cart.kid, kind: 'agent', owner: match[1] ?? '', issuedAt: cart.iat });
    }
  } else {
    problems.push(`agent key cannot be identified: cart is undecodable (${decoded.cart.message})`);
  }

  if (decoded.mandate.ok) {
    uses.push({ label: 'wallet', kid: decoded.mandate.kid, kind: 'wallet', owner: decoded.mandate.payload.iss, issuedAt: decoded.mandate.payload.iat });
  } else {
    problems.push(`wallet key cannot be identified: mandate is undecodable (${decoded.mandate.message})`);
  }

  if (decoded.cart.ok && decoded.cart.payload.consent.signature !== undefined) {
    const consentPart = decodeConsent(decoded.cart.payload.consent.signature);
    const owner = decoded.mandate.ok ? decoded.mandate.payload.iss : null;
    const approvedAt = parseInstantSeconds(decoded.cart.payload.consent.approved_at);
    if (!consentPart.ok) {
      problems.push(`consent key cannot be identified: consent is undecodable (${consentPart.message})`);
    } else if (owner === null || approvedAt === null) {
      problems.push('consent key cannot be checked: mandate or approved_at is unavailable');
    } else {
      uses.push({ label: 'consent', kid: consentPart.kid, kind: 'wallet', owner, issuedAt: approvedAt });
    }
  }
  return { uses, problems };
}

/** Problems with one key use at the given instants (known, right kind and owner, active at each instant). */
export function keyProblems(use: KeyUse, registry: RegistryLookup, instants: ReadonlyArray<{ at: NumericDate; label: string }>): string[] {
  const key = registry(use.kid);
  if (key === null) return [`${use.label} key ${use.kid} is not in the registry`];
  const problems: string[] = [];
  if (key.kind !== use.kind) problems.push(`${use.label} key ${use.kid} is a ${key.kind} key, expected ${use.kind}`);
  if (key.owner !== use.owner) problems.push(`${use.label} key ${use.kid} belongs to ${key.owner}, not ${use.owner}`);
  for (const { at, label } of instants) {
    const state = keyStateAt(key, at);
    if (state !== 'active') problems.push(`${use.label} key ${use.kid} was ${state} ${label}`);
  }
  return problems;
}

function merchantMatches(entry: string, merchantId: string): boolean {
  return entry === '*' || entry === merchantId || entry === merchantAudience(merchantId);
}

/** V09 and fact F6: does this cart fit the mandate scope? Returns problems (empty when within scope). */
export function scopeProblems(
  mandate: MandatePayload,
  cart: CartPayload,
  merchantId: string,
  categoryOf: (sku: string) => string | null,
): string[] {
  const problems: string[] = [];
  const scope = mandate.scope;
  if (cart.cart.currency !== scope.currency) {
    problems.push(`cart currency ${cart.cart.currency} differs from mandate currency ${scope.currency}`);
  }

  const maxTotal = tryParseMoney(scope.max_total);
  const maxPerItem = tryParseMoney(scope.max_per_item);
  const claimedTotal = tryParseMoney(cart.cart.total);
  const linesTotal = cartLinesTotalCents(cart.cart);
  if (maxTotal === null || maxPerItem === null) {
    problems.push('mandate scope amounts are not valid');
  } else {
    if (claimedTotal === null || !(claimedTotal <= maxTotal)) problems.push(`cart total ${cart.cart.total} exceeds max_total ${scope.max_total}`);
    if (linesTotal === null || !(linesTotal <= maxTotal)) problems.push(`sum of cart lines exceeds max_total ${scope.max_total}`);
    for (const line of cart.cart.items) {
      const unit = tryParseMoney(line.unit_price);
      if (unit === null || !(unit <= maxPerItem)) problems.push(`item ${line.sku} unit price ${line.unit_price} exceeds max_per_item ${scope.max_per_item}`);
    }
  }

  const itemCount = cart.cart.items.reduce((sum, line) => sum + line.qty, 0);
  if (!(itemCount <= scope.max_items)) problems.push(`cart has ${itemCount} items, more than max_items ${scope.max_items}`);

  if (scope.categories_allow !== null) {
    for (const line of cart.cart.items) {
      const category = categoryOf(line.sku);
      if (category === null) problems.push(`item ${line.sku} has no known category but the mandate restricts categories`);
      else if (!scope.categories_allow.includes(category)) problems.push(`item ${line.sku} category ${category} is not allowed by the mandate`);
    }
  }

  if (scope.merchants_deny.some((entry) => merchantMatches(entry, merchantId))) {
    problems.push(`merchant ${merchantId} is denied by the mandate`);
  }
  if (!scope.merchants_allow.some((entry) => merchantMatches(entry, merchantId))) {
    problems.push(`merchant ${merchantId} is not in the mandate's allow list`);
  }
  return problems;
}

export interface BudgetCheck {
  readonly mode: BudgetMode;
  /** True when a cumulative check was actually made against known spend. */
  readonly checked: boolean;
  /** Reasons the cart does not fit the remaining budget (V09 rejects). */
  readonly rejects: string[];
  /** Reasons the budget could not be checked (V09 asks for review). */
  readonly reviews: string[];
}

function isSpend(value: unknown): value is Spend {
  if (typeof value !== 'object' || value === null) return false;
  const spend = value as { totalCents?: unknown; itemCount?: unknown };
  return (
    isCents(spend.totalCents) &&
    spend.totalCents >= 0 &&
    typeof spend.itemCount === 'number' &&
    Number.isSafeInteger(spend.itemCount) &&
    spend.itemCount >= 0
  );
}

/**
 * G2: for a `cumulative` mandate, the spend already recorded plus this cart must stay within `max_total` and `max_items`.
 * `per_cart` mandates have nothing to check here. Unknown spend (absent, null) is a review, never a pass; malformed spend
 * (negative, fractional) is a reject because it can only come from a bug in the caller.
 */
export function budgetCheck(mandate: MandatePayload, cart: CartPayload, spend: Spend | null | undefined): BudgetCheck {
  const scope = mandate.scope;
  const mode = scope.budget_mode;
  if (mode === 'per_cart') return { mode, checked: false, rejects: [], reviews: [] };
  if (spend === undefined) {
    return { mode, checked: false, rejects: [], reviews: ['cumulative budget cannot be checked: this verifier is not given the spend under the mandate'] };
  }
  if (spend === null) {
    return { mode, checked: false, rejects: [], reviews: ['cumulative budget cannot be checked: the spend under the mandate is unknown'] };
  }
  if (!isSpend(spend)) {
    return { mode, checked: false, rejects: ['the spend reported under the mandate is not valid'], reviews: [] };
  }
  const maxTotal = tryParseMoney(scope.max_total);
  const claimed = tryParseMoney(cart.cart.total);
  const lines = cartLinesTotalCents(cart.cart);
  if (maxTotal === null || claimed === null || lines === null) {
    return { mode, checked: false, rejects: ['cumulative budget cannot be computed from the mandate and cart amounts'], reviews: [] };
  }
  const cartTotal = Math.max(claimed, lines);
  let total: Cents;
  try {
    total = addCents(spend.totalCents, cartTotal);
  } catch {
    return { mode, checked: false, rejects: ['cumulative spend overflows'], reviews: [] };
  }
  const rejects: string[] = [];
  if (!(total <= maxTotal)) {
    rejects.push(`spend ${spend.totalCents} plus this cart ${cartTotal} is ${total} cents, above the mandate budget max_total ${scope.max_total}`);
  }
  const cartItems = cart.cart.items.reduce((sum, line) => sum + line.qty, 0);
  if (!(spend.itemCount + cartItems <= scope.max_items)) {
    rejects.push(`${spend.itemCount} items already bought plus ${cartItems} in this cart is more than the mandate budget max_items ${scope.max_items}`);
  }
  return { mode, checked: true, rejects, reviews: [] };
}

/** V10 and part of fact F4. Returns problems (empty when the consent requirements are met). */
export function consentProblems(mandate: MandatePayload, cart: CartPayload, record: WalletRecord | null): string[] {
  const problems: string[] = [];
  const consent = cart.consent;
  if (consent.mode === 'human_not_present') {
    if (mandate.scope.mode !== 'human_not_present') {
      problems.push('mandate requires a human_present consent for every cart, but the cart carries none');
    }
    return problems;
  }
  for (const field of ['approved_at', 'method', 'presented_hash', 'signature'] as const) {
    if (consent[field] === undefined) problems.push(`human_present consent is missing ${field}`);
  }
  if (record === null) {
    problems.push('the wallet has no record of showing this cart to the principal');
  } else if (consent.presented_hash !== undefined && record.presentedHash !== consent.presented_hash) {
    problems.push('consent presented_hash differs from what the wallet recorded for this cart');
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// verifyCheckout
// ---------------------------------------------------------------------------------------------

type Rule = () => Finding[] | Promise<Finding[]>;

async function runRule(rule: RuleId, body: Rule): Promise<Finding[]> {
  try {
    return await body();
  } catch (error) {
    return [reject(rule, `rule failed to evaluate: ${error instanceof Error ? error.message : 'unknown error'}`)];
  }
}

export async function verifyCheckout(bundleInput: unknown, ctx: VerifyContext): Promise<VerifyResult> {
  const parsed = parseBundle(bundleInput);
  if (!parsed.ok) {
    return {
      outcome: 'REJECT',
      findings: [reject('V01_SIGNATURE', `malformed bundle: ${parsed.message}`)],
      cartHash: null,
      mandateHash: null,
    };
  }
  const bundle = parsed.value;
  const decoded = decodeBundle(bundle);
  const { mandate, cart } = decoded;
  const cartHash = cart.ok ? hashCartBody(cart.payload.cart) : null;
  const mandateHash = mandate.ok ? mandate.hash : null;
  const skew = skewOf(ctx);
  const needs = (...parts: Array<[string, DecodedPart<unknown>]>): string | null => {
    for (const [name, part] of parts) {
      if (!part.ok) return `cannot check: ${name} is undecodable (${part.message})`;
    }
    return null;
  };

  const findings: Finding[] = [];

  findings.push(
    ...(await runRule('V01_SIGNATURE', async () =>
      (await checkSignatures(bundle, decoded, ctx.registry)).map((c) => (c.ok ? pass('V01_SIGNATURE', c.detail) : reject('V01_SIGNATURE', c.detail))),
    )),
  );

  findings.push(
    ...(await runRule('V02_KEY_STATUS', () => {
      const { uses, problems } = planKeyUses(decoded);
      const all = [...problems];
      for (const use of uses) {
        all.push(
          ...keyProblems(use, ctx.registry, [
            { at: ctx.now, label: 'now' },
            { at: use.issuedAt, label: 'when the signed object was issued' },
          ]),
        );
      }
      return fromProblems('V02_KEY_STATUS', all, `all ${uses.length} signing keys are registered, correctly owned and active now and at issue`);
    })),
  );

  findings.push(
    ...(await runRule('V03_FRESHNESS', () => {
      const missing = needs(['mandate', mandate], ['cart', cart]);
      if (missing !== null || !mandate.ok || !cart.ok) return [reject('V03_FRESHNESS', missing ?? 'cannot check freshness')];
      const m = mandate.payload;
      const c = cart.payload;
      const problems: string[] = [];
      if (!(m.nbf <= m.exp)) problems.push('mandate nbf is after its exp');
      if (!(m.iat <= m.nbf)) problems.push(`mandate was issued after it became valid (iat ${m.iat}, nbf ${m.nbf})`);
      if (!(c.iat >= m.nbf - skew)) problems.push(`cart was issued before the mandate became valid (cart iat ${c.iat}, mandate nbf ${m.nbf}, skew ${skew}s)`);
      if (!(c.iat <= m.exp + skew)) problems.push(`cart was issued after the mandate expired (cart iat ${c.iat}, mandate exp ${m.exp}, skew ${skew}s)`);
      if (!(ctx.now >= m.nbf - skew)) problems.push(`mandate is not valid yet (nbf ${m.nbf}, now ${ctx.now}, skew ${skew}s)`);
      if (!(ctx.now <= m.exp + skew)) problems.push(`mandate has expired (exp ${m.exp}, now ${ctx.now}, skew ${skew}s)`);
      if (!(c.exp > c.iat)) problems.push('cart exp is not after its iat');
      if (!(c.exp - c.iat <= MAX_CART_LIFETIME_SECONDS)) problems.push(`cart lifetime ${c.exp - c.iat}s exceeds the ${MAX_CART_LIFETIME_SECONDS}s maximum`);
      if (!(ctx.now >= c.iat - skew)) problems.push(`cart was issued in the future (iat ${c.iat}, now ${ctx.now}, skew ${skew}s)`);
      if (!(ctx.now <= c.exp + skew)) problems.push(`cart has expired (exp ${c.exp}, now ${ctx.now}, skew ${skew}s)`);
      return fromProblems('V03_FRESHNESS', problems, 'mandate and cart are within their validity windows');
    })),
  );

  findings.push(
    ...(await runRule('V04_AUDIENCE', () => {
      if (!cart.ok) return [reject('V04_AUDIENCE', `cannot check: cart is undecodable (${cart.message})`)];
      const expected = merchantAudience(ctx.merchantId);
      return cart.payload.aud === expected
        ? [pass('V04_AUDIENCE', `aud names this merchant (${expected})`)]
        : [reject('V04_AUDIENCE', `aud ${JSON.stringify(cart.payload.aud)} does not name this merchant (${expected})`)];
    })),
  );

  findings.push(
    ...(await runRule('V05_NONCE', () => {
      if (!cart.ok) return [reject('V05_NONCE', `cannot check: cart is undecodable (${cart.message})`)];
      return [
        ctx.nonceSeen(cart.payload.nonce)
          ? reject('V05_NONCE', 'nonce has already been seen by this merchant (replay)')
          : pass('V05_NONCE', 'nonce has not been seen before'),
        ctx.cartSeen(cart.payload.jti)
          ? reject('V05_NONCE', 'cart warrant jti has already been seen by this merchant (replay of a consented cart)')
          : pass('V05_NONCE', 'cart warrant jti has not been seen before'),
      ];
    })),
  );

  findings.push(
    ...(await runRule('V06_MANDATE_BINDING', () => {
      const missing = needs(['mandate', mandate], ['cart', cart]);
      if (missing !== null || !mandate.ok || !cart.ok) return [reject('V06_MANDATE_BINDING', missing ?? 'cannot check binding')];
      const problems: string[] = [];
      if (cart.payload.mandate.hash !== mandate.hash) problems.push('cart.mandate.hash is not the hash of the presented mandate payload');
      if (cart.payload.mandate.jti !== mandate.payload.jti) problems.push('cart.mandate.jti is not the presented mandate jti');
      const expectedIss = agentIssuer(mandate.payload.agent.platform, mandate.payload.agent.agent_id);
      if (cart.payload.iss !== expectedIss) problems.push(`cart iss ${JSON.stringify(cart.payload.iss)} is not the agent the mandate names (${expectedIss})`);
      if (cart.kid !== mandate.payload.agent.kid) problems.push(`cart signed with kid ${cart.kid}, but the mandate names agent kid ${mandate.payload.agent.kid}`);
      if (hashText(mandate.payload.instruction.text) !== mandate.payload.instruction.hash) {
        problems.push('mandate instruction.hash is not the hash of instruction.text');
      }
      return fromProblems('V06_MANDATE_BINDING', problems, 'cart is bound to the presented mandate, its named agent and its instruction');
    })),
  );

  findings.push(
    ...(await runRule('V07_CART_HASH', () => {
      if (!cart.ok) return [reject('V07_CART_HASH', `cannot check: cart is undecodable (${cart.message})`)];
      const problems: string[] = [];
      if (cartHash !== cart.payload.cart_hash) problems.push('cart_hash is not the hash of the canonical cart object');
      const total = tryParseMoney(cart.payload.cart.total);
      const lines = cartLinesTotalCents(cart.payload.cart);
      if (lines === null) problems.push('cart lines could not be summed');
      else if (total !== lines) problems.push(`line totals sum to ${lines} cents but cart.total is ${cart.payload.cart.total}`);
      return fromProblems('V07_CART_HASH', problems, 'cart_hash matches the canonical cart and the lines sum to cart.total');
    })),
  );

  findings.push(
    ...(await runRule('V08_REPRICE', () => {
      if (!cart.ok) return [reject('V08_REPRICE', `cannot check: cart is undecodable (${cart.message})`)];
      const problems: string[] = [];
      let recomputed: Cents = 0;
      for (const line of cart.payload.cart.items) {
        const offer = ctx.catalog(line.sku);
        if (offer === null) {
          problems.push(`sku ${line.sku} is not in this merchant's catalog`);
          continue;
        }
        if (offer.currency !== cart.payload.cart.currency) problems.push(`sku ${line.sku} is priced in ${offer.currency}, the cart says ${cart.payload.cart.currency}`);
        if (!offer.available) problems.push(`sku ${line.sku} is not available`);
        const unit = tryParseMoney(line.unit_price);
        if (unit !== offer.unitPriceCents) problems.push(`sku ${line.sku} unit price is ${line.unit_price} in the cart but ${offer.unitPriceCents} cents in the catalog`);
        if (offer.listingHash !== undefined && offer.listingHash !== null && offer.listingHash !== line.listing_hash) {
          problems.push(`sku ${line.sku} listing_hash differs from the merchant's current listing`);
        }
        recomputed = addCents(recomputed, mulCents(offer.unitPriceCents, line.qty));
      }
      if (problems.length === 0 && tryParseMoney(cart.payload.cart.total) !== recomputed) {
        problems.push(`catalog total is ${recomputed} cents but cart.total is ${cart.payload.cart.total}`);
      }
      return fromProblems('V08_REPRICE', problems, 'every line matches the merchant catalog (price, availability, currency)');
    })),
  );

  findings.push(
    ...(await runRule('V09_SCOPE', () => {
      const missing = needs(['mandate', mandate], ['cart', cart]);
      if (missing !== null || !mandate.ok || !cart.ok) return [reject('V09_SCOPE', missing ?? 'cannot check scope')];
      const perCart = scopeProblems(mandate.payload, cart.payload, ctx.merchantId, (sku) => ctx.catalog(sku)?.category ?? null);
      const budget = budgetCheck(mandate.payload, cart.payload, ctx.spentUnderMandate?.(mandate.payload.jti));
      const rejects = [...perCart, ...budget.rejects];
      if (rejects.length > 0 || budget.reviews.length > 0) {
        return [...rejects.map((p) => reject('V09_SCOPE', p)), ...budget.reviews.map((p) => review('V09_SCOPE', p))];
      }
      return [
        pass('V09_SCOPE', budget.mode === 'cumulative' ? 'cart is within the mandate scope and the remaining budget' : 'cart is within the mandate scope (limits apply per cart)'),
      ];
    })),
  );

  findings.push(
    ...(await runRule('V10_CONSENT', () => {
      const missing = needs(['mandate', mandate], ['cart', cart]);
      if (missing !== null || !mandate.ok || !cart.ok || cartHash === null) return [reject('V10_CONSENT', missing ?? 'cannot check consent')];
      return fromProblems(
        'V10_CONSENT',
        consentProblems(mandate.payload, cart.payload, ctx.walletRecord({ cartJti: cart.payload.jti, cartHash })),
        cart.payload.consent.mode === 'human_present' ? 'human_present consent matches the wallet record' : 'human_not_present is allowed by the mandate',
      );
    })),
  );

  findings.push(
    ...(await runRule('V12_VELOCITY', () => {
      if (ctx.velocity === null) return [pass('V12_VELOCITY', 'velocity limits are not configured')];
      const missing = needs(['mandate', mandate], ['cart', cart]);
      if (missing !== null || !mandate.ok) return [review('V12_VELOCITY', missing ?? 'cannot check velocity')];
      const v = ctx.velocity;
      const counts = v.count({ principalRef: mandate.payload.principal.ref, platform: mandate.payload.agent.platform, since: ctx.now - v.windowSeconds });
      const problems: Finding[] = [];
      if (!(counts.principal < v.maxPerPrincipal)) problems.push(review('V12_VELOCITY', `principal already has ${counts.principal} warrants in the last ${v.windowSeconds}s (limit ${v.maxPerPrincipal})`));
      if (!(counts.platform < v.maxPerPlatform)) problems.push(review('V12_VELOCITY', `agent platform already has ${counts.platform} warrants in the last ${v.windowSeconds}s (limit ${v.maxPerPlatform})`));
      return problems.length === 0 ? [pass('V12_VELOCITY', 'warrant volume is within limits')] : problems;
    })),
  );

  return { outcome: combine(findings), findings, cartHash, mandateHash };
}

// ---------------------------------------------------------------------------------------------
// V11: payer binding, evaluated after the buyer approves the PayPal order
// ---------------------------------------------------------------------------------------------

export interface PayerBindingResult {
  readonly outcome: Outcome;
  readonly finding: Finding;
  /** `sha256:` hash of the PayPal payer id. Record it as the principal's hash on first use. */
  readonly payerIdHash: string;
  readonly firstUse: boolean;
}

/** Hash of a PayPal `payer.payer_id`, as stored in `principal.paypal_payer_id_hash`. */
export function hashPayerId(payerId: string): string {
  return hashText(payerId);
}

/**
 * V11. Compare the hash of the approved order's `payer.payer_id` with the mandate's principal hash.
 * Mismatch: reject. No hash in the mandate yet: review, and the caller records `payerIdHash` (trust on first use).
 * This reads the mandate WITHOUT checking its signature; run `verifyCheckout` first and only call this for a
 * bundle it did not reject.
 */
export function verifyPayerBinding(bundleInput: unknown, payerId: string): PayerBindingResult {
  const payerIdHash = hashPayerId(typeof payerId === 'string' ? payerId : '');
  const failure = (detail: string): PayerBindingResult => ({ outcome: 'REJECT', finding: reject('V11_PAYER_BINDING', detail), payerIdHash, firstUse: false });

  if (typeof payerId !== 'string' || payerId.length === 0) return failure('payer id is missing');
  const parsed = parseBundle(bundleInput);
  if (!parsed.ok) return failure(`malformed bundle: ${parsed.message}`);
  const mandate = decodeBundle(parsed.value).mandate;
  if (!mandate.ok) return failure(`mandate is undecodable: ${mandate.message}`);

  const bound = mandate.payload.principal.paypal_payer_id_hash;
  if (bound === undefined) {
    return {
      outcome: 'REVIEW',
      finding: review('V11_PAYER_BINDING', 'first use: the mandate has no payer hash yet; record this payer hash against the principal'),
      payerIdHash,
      firstUse: true,
    };
  }
  return bound === payerIdHash
    ? { outcome: 'ACCEPT', finding: pass('V11_PAYER_BINDING', 'payer id hash matches the principal'), payerIdHash, firstUse: false }
    : failure('payer id hash does not match the principal bound in the mandate');
}
