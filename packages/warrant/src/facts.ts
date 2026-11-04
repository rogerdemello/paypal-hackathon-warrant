import { tryParseMoney, type Cents } from './money';
import type { RegistryLookup } from './registry';
import type { CartPayload, MandatePayload } from './schema';
import type { NumericDate } from './time';
import {
  budgetCheck,
  checkSignatures,
  consentCoverageGaps,
  consentProblems,
  hashPayerId,
  keyProblems,
  planKeyUses,
  scopeProblems,
  type Spend,
  type WalletRecordLookup,
} from './verify';
import { decodeBundle, decodeConsent, hashCartBody, parseBundle } from './warrant';

/**
 * The deterministic facts engine, F1-F13 of docs/dispute-resolution.md section 2.
 *
 * Facts are computed from the stored bundle, registry data, PayPal order / capture / dispute / tracking views and
 * the merchant's own records, all supplied by the caller. No I/O, no clock, no model. Each fact carries evidence
 * references (ids, hashes, timestamps) so any statement downstream can be traced back to its source.
 */

export type MerchantMode = 'STRICT' | 'PERMISSIVE' | 'NONE';

export interface OrderLineView {
  /** PayPal item `sku`, when the merchant sent one. */
  readonly sku: string | null;
  readonly quantity: number;
  readonly unitAmountCents: Cents;
}

/** The parts of the PayPal order that facts need, with money already converted to integer cents. */
export interface PayPalOrderView {
  readonly id: string;
  readonly currency: string;
  readonly totalCents: Cents;
  /** `payer.payer_id` returned after the buyer approved the order. */
  readonly payerId: string | null;
  /** `purchase_units[0].items`, or null if the order carried no line items. */
  readonly lines: readonly OrderLineView[] | null;
}

export interface CaptureView {
  readonly id: string;
  readonly amountCents: Cents;
  readonly currency: string;
}

export interface DisputeView {
  readonly id: string;
  readonly disputedAmountCents: Cents;
  /** Seller response deadline, NumericDate seconds. Null when PayPal gave none. */
  readonly responseDueBy: NumericDate | null;
}

export interface TrackingView {
  readonly delivered: boolean;
  readonly deliveredAt: NumericDate | null;
  /** The delivery date the merchant promised, if any. */
  readonly promisedBy: NumericDate | null;
  readonly trackingNumber: string | null;
}

export interface RefundView {
  readonly id: string;
  readonly amountCents: Cents;
}

/** Whether (and when) the cart warrant hash was appended to the registry's transparency log. */
export interface TransparencyView {
  readonly included: boolean;
  readonly seq: number | null;
  readonly entryHash: string | null;
  /** When the log recorded it. The log cannot be backdated, so it bounds the real issue time. */
  readonly loggedAt: NumericDate | null;
}

export interface FactsInput {
  readonly now: NumericDate;
  /** The bundle stored for this capture (object or JSON string), or null/undefined when none is stored. */
  readonly bundle: unknown;
  readonly merchantId: string;
  readonly merchantMode: MerchantMode;
  readonly registry: RegistryLookup;
  /** The merchant's category for a SKU, for the mandate's category rule. */
  readonly categoryOf: (sku: string) => string | null;
  readonly walletRecord: WalletRecordLookup;
  /** How many times the merchant's nonce store saw this cart's nonce. */
  readonly nonceUseCount: number;
  /** How many times the merchant recorded this cart warrant's `jti`. */
  readonly jtiUseCount: number;
  /**
   * The spend under the mandate that was recorded when this cart was accepted (excluding this cart), or null when unknown.
   * Used for `cumulative` mandates; F6 records in its detail whether the cumulative check could be made.
   */
  readonly spentBefore: Spend | null;
  readonly order: PayPalOrderView | null;
  readonly capture: CaptureView | null;
  readonly dispute: DisputeView;
  readonly tracking: TrackingView | null;
  /** SKU -> listing hash of what the merchant actually fulfilled. Null when unknown. */
  readonly fulfilledListings: Readonly<Record<string, string>> | null;
  readonly refunds: readonly RefundView[];
  readonly transparency: TransparencyView | null;
}

export type FactDetail = Readonly<Record<string, string | number | boolean | null>>;

export interface Fact<T = boolean> {
  readonly id: string;
  readonly name: string;
  readonly value: T;
  /** References that justify the value: ids, hashes, timestamps. Never free-form model text. */
  readonly evidence: readonly string[];
  readonly detail?: FactDetail;
}

export interface ListingComparison {
  readonly sku: string;
  readonly warrantListingHash: string;
  readonly fulfilledListingHash: string | null;
}

export interface FactsContext {
  readonly merchantMode: MerchantMode;
  readonly disputeId: string;
  readonly captureId: string | null;
  readonly orderId: string | null;
  readonly cartJti: string | null;
  readonly mandateJti: string | null;
  readonly mandateHash: string | null;
  /** Hash of the cart object as presented in the warrant (recomputed). */
  readonly cartHash: string | null;
  readonly transparency: TransparencyView | null;
  readonly listings: readonly ListingComparison[];
}

export interface Facts {
  readonly F1: Fact;
  readonly F2: Fact;
  readonly F3: Fact;
  readonly F4: Fact;
  readonly F5: Fact;
  readonly F6: Fact;
  readonly F7: Fact;
  readonly F8: Fact;
  readonly F9: Fact;
  readonly F10: Fact;
  readonly F11: Fact;
  /** Hours left to respond, or null when PayPal gave no deadline. */
  readonly F12: Fact<number | null>;
  readonly F13: Fact;
  readonly context: FactsContext;
}

const fact = (id: string, name: string, value: boolean, evidence: readonly string[], detail?: FactDetail): Fact =>
  detail === undefined ? { id, name, value, evidence } : { id, name, value, evidence, detail };

function sortedLineKeys(lines: ReadonlyArray<{ sku: string | null; qty: number; cents: Cents }>): string[] {
  return lines.map((l) => `${l.sku ?? ''}|${l.qty}|${l.cents}`).sort();
}

export async function computeFacts(input: FactsInput): Promise<Facts> {
  const stored = input.bundle !== null && input.bundle !== undefined;
  const parsed = stored ? parseBundle(input.bundle) : null;
  const bundle = parsed !== null && parsed.ok ? parsed.value : null;
  const decoded = bundle === null ? null : decodeBundle(bundle);
  const mandate = decoded !== null && decoded.mandate.ok ? decoded.mandate : null;
  const cart = decoded !== null && decoded.cart.ok ? decoded.cart : null;
  const mandatePayload: MandatePayload | null = mandate === null ? null : mandate.payload;
  const cartPayload: CartPayload | null = cart === null ? null : cart.payload;
  const cartHash = cartPayload === null ? null : hashCartBody(cartPayload.cart);
  const mandateHash = mandate === null ? null : mandate.hash;
  const whyNot = !stored ? 'no warrant bundle is stored for this capture' : bundle === null ? 'the stored bundle is malformed' : 'the warrant is undecodable';

  // F1
  const F1 = fact('F1', 'warrant_present', stored, [stored ? `bundle:stored${cartPayload === null ? '' : `:cart_jti=${cartPayload.jti}`}` : 'bundle:none']);

  // F2 signatures, F4 consent
  let F2 = fact('F2', 'signatures_valid', false, [whyNot]);
  let signatureChecks: Awaited<ReturnType<typeof checkSignatures>> = [];
  if (bundle !== null && decoded !== null) {
    signatureChecks = await checkSignatures(bundle, decoded, input.registry);
    const evidence = signatureChecks.map((c) => `${c.subject}:${c.ok ? 'valid' : 'invalid'}${c.kid === null ? '' : `:kid=${c.kid}`}`);
    const by = (subject: string): boolean => signatureChecks.find((c) => c.subject === subject)?.ok === true;
    F2 = fact('F2', 'signatures_valid', signatureChecks.length > 0 && signatureChecks.every((c) => c.ok), evidence, {
      cart: by('cart'),
      mandate: by('mandate'),
      consent: by('consent'),
    });
  }

  // F3 keys active at issue (and when logged)
  let F3 = fact('F3', 'keys_active_at_issue', false, [whyNot]);
  if (decoded !== null) {
    const { uses, problems } = planKeyUses(decoded);
    const all = [...problems];
    const evidence: string[] = [];
    for (const use of uses) {
      const instants = [{ at: use.issuedAt, label: 'at issue' }];
      if (input.transparency?.included === true && input.transparency.loggedAt !== null) {
        instants.push({ at: input.transparency.loggedAt, label: 'when logged' });
      }
      all.push(...keyProblems(use, input.registry, instants));
      evidence.push(`${use.label}_key:kid=${use.kid}:issued_at=${use.issuedAt}`);
    }
    if (input.transparency?.included === true && input.transparency.loggedAt !== null) {
      evidence.push(`transparency_log:logged_at=${input.transparency.loggedAt}`);
    }
    F3 = fact('F3', 'keys_active_at_issue', uses.length > 0 && all.length === 0, [...evidence, ...all.map((p) => `problem:${p}`)]);
  }

  // F4 consent_valid
  let F4 = fact('F4', 'consent_valid', false, [whyNot]);
  let coverageGaps: string[] | null = null;
  if (mandatePayload !== null && cartPayload !== null && cartHash !== null && mandateHash !== null) {
    const consent = cartPayload.consent;
    const problems = consentProblems(mandatePayload, cartPayload, input.walletRecord({ cartJti: cartPayload.jti, cartHash }));
    const sig = signatureChecks.find((c) => c.subject === 'consent');
    if (consent.signature !== undefined) {
      const signed = decodeConsent(consent.signature);
      coverageGaps = signed.ok ? consentCoverageGaps(signed.payload, cartPayload, mandateHash) : ['consent_undecodable'];
    }
    const sigOk = sig?.ok === true;
    F4 = fact(
      'F4',
      'consent_valid',
      problems.length === 0 && sigOk && (coverageGaps === null || coverageGaps.length === 0) && cartHash === cartPayload.cart_hash,
      [
        `consent:mode=${consent.mode}`,
        ...(consent.approved_at === undefined ? [] : [`consent:approved_at=${consent.approved_at}`]),
        ...(consent.presented_hash === undefined ? [] : [`consent:presented_hash=${consent.presented_hash}`]),
        `cart_hash:${cartHash}`,
        ...problems.map((p) => `problem:${p}`),
        ...(coverageGaps === null ? [] : coverageGaps.map((g) => `problem:consent does not cover ${g}`)),
      ],
    );
  }

  // F5 order_matches_consent
  let F5 = fact('F5', 'order_matches_consent', false, [input.order === null ? 'no PayPal order available' : whyNot]);
  if (cartPayload !== null && cartHash !== null && mandateHash !== null && input.order !== null) {
    const consent = cartPayload.consent;
    let bundleCartMatchesConsent: boolean;
    if (consent.mode === 'human_present' && consent.signature !== undefined) {
      const signed = decodeConsent(consent.signature);
      bundleCartMatchesConsent = signed.ok && consentCoverageGaps(signed.payload, cartPayload, mandateHash).length === 0 && cartHash === cartPayload.cart_hash;
    } else {
      bundleCartMatchesConsent = consent.mode === 'human_not_present' && cartHash === cartPayload.cart_hash;
    }
    const order = input.order;
    const cartTotal = tryParseMoney(cartPayload.cart.total);
    let linesMatch = true;
    if (order.lines !== null) {
      const cartLines = cartPayload.cart.items.map((i) => ({ sku: i.sku, qty: i.qty, cents: tryParseMoney(i.unit_price) ?? -1 }));
      const orderLines = order.lines.map((l) => ({ sku: l.sku, qty: l.quantity, cents: l.unitAmountCents }));
      linesMatch = sortedLineKeys(cartLines).join('\n') === sortedLineKeys(orderLines).join('\n');
    }
    const orderMatchesBundleCart = order.currency === cartPayload.cart.currency && cartTotal !== null && order.totalCents === cartTotal && linesMatch;
    F5 = fact(
      'F5',
      'order_matches_consent',
      bundleCartMatchesConsent && orderMatchesBundleCart,
      [`order:${order.id}`, `order_total_cents=${order.totalCents}`, `cart_hash:${cartHash}`, `cart_total=${cartPayload.cart.total}`],
      { orderMatchesBundleCart, bundleCartMatchesConsent, linesCompared: order.lines !== null },
    );
  }

  // F6 within_mandate
  let F6 = fact('F6', 'within_mandate', false, [whyNot]);
  if (mandatePayload !== null && cartPayload !== null) {
    // A cumulative mandate also needs the spend recorded when the cart was accepted. If it is unknown the fact is decided
    // on the per-cart limits alone and says so, rather than blaming the agent platform for something that cannot be shown.
    const budget = budgetCheck(mandatePayload, cartPayload, input.spentBefore);
    const problems = [...scopeProblems(mandatePayload, cartPayload, input.merchantId, input.categoryOf), ...budget.rejects];
    F6 = fact(
      'F6',
      'within_mandate',
      problems.length === 0,
      [
        `mandate:${mandatePayload.jti}`,
        `cart:${cartPayload.jti}`,
        `budget_mode=${budget.mode}`,
        ...problems.map((p) => `problem:${p}`),
        ...budget.reviews.map((r) => `unverified:${r}`),
      ],
      { budgetMode: budget.mode, cumulativeChecked: budget.checked },
    );
  }

  // F7 payer_bound
  let F7 = fact('F7', 'payer_bound', false, [input.order === null ? 'no PayPal order available' : whyNot]);
  if (mandatePayload !== null && input.order !== null) {
    const bound = mandatePayload.principal.paypal_payer_id_hash;
    const payerHash = input.order.payerId === null ? null : hashPayerId(input.order.payerId);
    F7 = fact('F7', 'payer_bound', bound !== undefined && payerHash !== null && bound === payerHash, [
      bound === undefined ? 'mandate:no payer hash (not linked)' : `mandate:payer_hash=${bound}`,
      payerHash === null ? 'order:no payer id' : `order:payer_hash=${payerHash}`,
    ]);
  }

  // F8 nonce_unique: the nonce and the cart jti were each recorded exactly once
  const F8 = fact('F8', 'nonce_unique', cartPayload !== null && input.nonceUseCount === 1 && input.jtiUseCount === 1, [
    cartPayload === null ? whyNot : `nonce:${cartPayload.nonce}`,
    `nonce_use_count=${input.nonceUseCount}`,
    ...(cartPayload === null ? [] : [`cart_jti:${cartPayload.jti}`]),
    `jti_use_count=${input.jtiUseCount}`,
  ]);

  // F9 delivered (and on time)
  const t = input.tracking;
  const delivered = t !== null && t.delivered === true;
  const onTime = delivered && t !== null && (t.promisedBy === null || (t.deliveredAt !== null && t.deliveredAt <= t.promisedBy));
  const F9 = fact(
    'F9',
    'delivered',
    delivered,
    t === null ? ['tracking:none'] : [`tracking:${t.trackingNumber ?? 'no-number'}`, `delivered_at=${t.deliveredAt ?? 'unknown'}`, `promised_by=${t.promisedBy ?? 'none'}`],
    { onTime, deliveredAt: t?.deliveredAt ?? null, promisedBy: t?.promisedBy ?? null },
  );

  // F10 listing_matches
  const listings: ListingComparison[] =
    cartPayload === null
      ? []
      : cartPayload.cart.items.map((line) => ({
          sku: line.sku,
          warrantListingHash: line.listing_hash,
          fulfilledListingHash: input.fulfilledListings === null ? null : (input.fulfilledListings[line.sku] ?? null),
        }));
  const F10 = fact(
    'F10',
    'listing_matches',
    listings.length > 0 && listings.every((l) => l.fulfilledListingHash !== null && l.fulfilledListingHash === l.warrantListingHash),
    listings.length === 0 ? [whyNot] : listings.map((l) => `listing:${l.sku}:warrant=${l.warrantListingHash}:fulfilled=${l.fulfilledListingHash ?? 'unknown'}`),
  );

  // F11 already_refunded
  const F11 = fact('F11', 'already_refunded', input.refunds.length > 0, input.refunds.length === 0 ? ['refunds:none'] : input.refunds.map((r) => `refund:${r.id}:${r.amountCents}`));

  // F12 deadline_hours
  const hours = input.dispute.responseDueBy === null ? null : (input.dispute.responseDueBy - input.now) / 3600;
  const F12: Fact<number | null> = {
    id: 'F12',
    name: 'deadline_hours',
    value: hours !== null && Number.isFinite(hours) ? hours : null,
    evidence: [`dispute:${input.dispute.id}`, `response_due_by=${input.dispute.responseDueBy ?? 'unknown'}`, `now=${input.now}`],
  };

  // F13 amount_ok
  const F13 = fact(
    'F13',
    'amount_ok',
    input.capture !== null && Number.isSafeInteger(input.dispute.disputedAmountCents) && input.dispute.disputedAmountCents <= input.capture.amountCents,
    [`dispute:${input.dispute.id}:disputed_cents=${input.dispute.disputedAmountCents}`, input.capture === null ? 'capture:none' : `capture:${input.capture.id}:cents=${input.capture.amountCents}`],
  );

  return {
    F1,
    F2,
    F3,
    F4,
    F5,
    F6,
    F7,
    F8,
    F9,
    F10,
    F11,
    F12,
    F13,
    context: {
      merchantMode: input.merchantMode,
      disputeId: input.dispute.id,
      captureId: input.capture?.id ?? null,
      orderId: input.order?.id ?? null,
      cartJti: cartPayload?.jti ?? null,
      mandateJti: mandatePayload?.jti ?? null,
      mandateHash,
      cartHash,
      transparency: input.transparency,
      listings,
    },
  };
}

