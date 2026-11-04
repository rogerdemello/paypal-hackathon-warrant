import { canonicalize, hashJson, hashText, type JsonValue } from './canonical';
import { decodeJws, signJws, type SignedJws } from './jws';
import { addCents, formatMoney, mulCents, parseMoney, type Cents } from './money';
import {
  bundleSchema,
  cartBodySchema,
  cartSchema,
  consentPayloadSchema,
  mandateSchema,
  parseWith,
  type BudgetMode,
  type Bundle,
  type CartBody,
  type CartPayload,
  type Consent,
  type ConsentMode,
  type ConsentPayload,
  type MandatePayload,
  type Parsed,
} from './schema';
import type { NumericDate } from './time';
import type { KeyObject } from 'node:crypto';

/**
 * Builders and signers for the Warrant objects (docs/warrant-spec.md section 3), plus bundle parsing and
 * unverified decoding. Money enters as integer cents and leaves as a decimal string.
 */

export const WARRANT_VERSION = '0.2';

export class WarrantError extends Error {
  override readonly name = 'WarrantError';
}

/** `agent:<platform>/<agent_id>`, the `iss` of a cart warrant. */
export function agentIssuer(platform: string, agentId: string): string {
  return `agent:${platform}/${agentId}`;
}

/** `paypal-merchant:<merchant id>`, the `aud` of a cart warrant. */
export function merchantAudience(merchantId: string): string {
  return `paypal-merchant:${merchantId}`;
}

function assertParsed<T>(parsed: Parsed<T>, what: string): T {
  if (!parsed.ok) {
    throw new WarrantError(`invalid ${what}: ${parsed.message}`);
  }
  return parsed.value;
}

// ---------------------------------------------------------------------------------------------
// Mandate
// ---------------------------------------------------------------------------------------------

export interface MandateInput {
  readonly jti: string;
  /** Wallet identifier, for example `wallet:demo-wallet`. */
  readonly iss: string;
  readonly iat: NumericDate;
  readonly nbf: NumericDate;
  readonly exp: NumericDate;
  readonly principalRef: string;
  /** `sha256:` hash of the principal's PayPal payer id, once linked. */
  readonly principalPayerIdHash?: string;
  readonly agent: { readonly platform: string; readonly agentId: string; readonly kid: string };
  /** The human's request in their own words. Its hash is computed here. */
  readonly instructionText: string;
  readonly scope: {
    readonly currency: string;
    readonly maxTotalCents: Cents;
    readonly maxPerItemCents: Cents;
    readonly maxItems: number;
    readonly categoriesAllow: readonly string[] | null;
    readonly merchantsAllow: readonly string[];
    readonly merchantsDeny: readonly string[];
    readonly mode: ConsentMode;
    /** `cumulative`: the limits are totals over the mandate's life. `per_cart`: they apply to each cart. */
    readonly budgetMode: BudgetMode;
  };
}

/** Build and validate a mandate payload. Throws WarrantError if the result is not a valid mandate. */
export function buildMandate(input: MandateInput): MandatePayload {
  const payload = {
    typ: 'mandate',
    jti: input.jti,
    iss: input.iss,
    iat: input.iat,
    nbf: input.nbf,
    exp: input.exp,
    principal: {
      ref: input.principalRef,
      ...(input.principalPayerIdHash === undefined ? {} : { paypal_payer_id_hash: input.principalPayerIdHash }),
    },
    agent: { platform: input.agent.platform, agent_id: input.agent.agentId, kid: input.agent.kid },
    instruction: { text: input.instructionText, hash: hashText(input.instructionText) },
    scope: {
      currency: input.scope.currency,
      max_total: formatMoney(input.scope.maxTotalCents),
      max_per_item: formatMoney(input.scope.maxPerItemCents),
      max_items: input.scope.maxItems,
      categories_allow: input.scope.categoriesAllow === null ? null : [...input.scope.categoriesAllow],
      merchants_allow: [...input.scope.merchantsAllow],
      merchants_deny: [...input.scope.merchantsDeny],
      mode: input.scope.mode,
      budget_mode: input.scope.budgetMode,
    },
  };
  return assertParsed(parseWith(mandateSchema, payload), 'mandate');
}

/** `sha256:` hash of the canonical mandate payload: the `mandate.hash` carried by cart warrants and consents. */
export function hashMandate(mandate: MandatePayload): string {
  return hashJson(mandate);
}

/** Sign a mandate with the wallet key `kid`. Validates the payload first. */
export async function signMandate(mandate: MandatePayload, walletKey: KeyObject, kid: string): Promise<SignedJws> {
  const valid = assertParsed(parseWith(mandateSchema, mandate), 'mandate');
  return signJws(valid as JsonValue, walletKey, kid);
}

// ---------------------------------------------------------------------------------------------
// Cart and consent
// ---------------------------------------------------------------------------------------------

export interface CartLineInput {
  readonly sku: string;
  readonly title: string;
  readonly qty: number;
  readonly unitPriceCents: Cents;
  /** `sha256:` hash of the listing snapshot the price came from. */
  readonly listingHash: string;
}

/** Build the cart object that `cart_hash` commits to. The total is computed from the lines in integer cents. */
export function buildCartBody(currency: string, lines: readonly CartLineInput[]): CartBody {
  let total: Cents = 0;
  const items = lines.map((line) => {
    total = addCents(total, mulCents(line.unitPriceCents, line.qty));
    return {
      sku: line.sku,
      title: line.title,
      qty: line.qty,
      unit_price: formatMoney(line.unitPriceCents),
      listing_hash: line.listingHash,
    };
  });
  return assertParsed(parseWith(cartBodySchema, { currency, items, total: formatMoney(total) }), 'cart');
}

/** `cart_hash`: SHA-256 over the canonical cart object. */
export function hashCartBody(cart: CartBody): string {
  return hashJson(cart);
}

/** Sum of line totals in integer cents, or null if a line does not parse or overflows. */
export function cartLinesTotalCents(cart: CartBody): Cents | null {
  try {
    let total: Cents = 0;
    for (const line of cart.items) {
      total = addCents(total, mulCents(parseMoney(line.unit_price), line.qty));
    }
    return total;
  } catch {
    return null;
  }
}

export interface ConsentInput {
  readonly cartHash: string;
  /** The `jti` the cart warrant will carry. The consent can be spent once, for this jti. */
  readonly cartJti: string;
  /** The `aud` the cart warrant will carry: the one merchant the human saw on the consent screen. */
  readonly aud: string;
  /** Hash of the exact cart screen the principal saw. */
  readonly presentedHash: string;
  /** ISO 8601 UTC instant. */
  readonly approvedAt: string;
  readonly mandateHash: string;
}

/**
 * The wallet signs the consent: a JWS over `{ cart_hash, cart_jti, aud, presented_hash, approved_at, mandate_hash }`
 * (plus `typ: "consent"`). The agent platform cannot produce it.
 */
export async function signConsent(input: ConsentInput, walletKey: KeyObject, kid: string): Promise<SignedJws> {
  const payload = assertParsed(
    parseWith(consentPayloadSchema, {
      typ: 'consent',
      cart_hash: input.cartHash,
      cart_jti: input.cartJti,
      aud: input.aud,
      presented_hash: input.presentedHash,
      approved_at: input.approvedAt,
      mandate_hash: input.mandateHash,
    }),
    'consent',
  );
  return signJws(payload, walletKey, kid);
}

export interface HumanPresentConsentInput {
  readonly approvedAt: string;
  readonly method: 'click' | 'passkey';
  readonly presentedHash: string;
  /** The consent JWS returned by `signConsent`. */
  readonly signature: string;
}

export function buildHumanPresentConsent(input: HumanPresentConsentInput): Consent {
  return {
    mode: 'human_present',
    approved_at: input.approvedAt,
    method: input.method,
    presented_hash: input.presentedHash,
    signature: input.signature,
  };
}

export const HUMAN_NOT_PRESENT_CONSENT: Consent = Object.freeze({ mode: 'human_not_present' as const });

export interface CartInput {
  readonly jti: string;
  readonly iss: string;
  readonly aud: string;
  readonly iat: NumericDate;
  readonly exp: NumericDate;
  readonly nonce: string;
  readonly mandate: { readonly jti: string; readonly hash: string };
  readonly cart: CartBody;
  readonly consent: Consent;
}

/** Build and validate a cart warrant payload. `cart_hash` is computed from `cart`. */
export function buildCartPayload(input: CartInput): CartPayload {
  return assertParsed(
    parseWith(cartSchema, {
      typ: 'cart',
      jti: input.jti,
      iss: input.iss,
      aud: input.aud,
      iat: input.iat,
      exp: input.exp,
      nonce: input.nonce,
      mandate: { jti: input.mandate.jti, hash: input.mandate.hash },
      cart: input.cart,
      cart_hash: hashCartBody(input.cart),
      consent: input.consent,
    }),
    'cart warrant',
  );
}

/** `sha256:` hash of the whole canonical cart warrant payload: what the transparency log records. */
export function hashCartWarrant(cart: CartPayload): string {
  return hashJson(cart);
}

/** Sign a cart warrant with the agent platform key `kid`. Validates the payload first. */
export async function signCart(cart: CartPayload, agentKey: KeyObject, kid: string): Promise<SignedJws> {
  const valid = assertParsed(parseWith(cartSchema, cart), 'cart warrant');
  return signJws(valid as JsonValue, agentKey, kid);
}

// ---------------------------------------------------------------------------------------------
// Binding to PayPal (spec section 5)
// ---------------------------------------------------------------------------------------------

export interface PayPalReferences {
  /** Order `purchase_units[0].custom_id`. */
  readonly customId: string;
  /** Order `purchase_units[0].invoice_id`. */
  readonly invoiceId: string;
}

/** `wrt:<jti>` and `WRT-<first 16 characters of the cart hash digest>`. */
export function paypalReferences(cart: Pick<CartPayload, 'jti' | 'cart_hash'>): PayPalReferences {
  return {
    customId: `wrt:${cart.jti}`,
    invoiceId: `WRT-${cart.cart_hash.slice('sha256:'.length, 'sha256:'.length + 16)}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Bundle
// ---------------------------------------------------------------------------------------------

export function makeBundle(mandateJws: string, cartJws: string): Bundle {
  return { warrant_version: WARRANT_VERSION, mandate: mandateJws, cart: cartJws };
}

const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;

/** Parse a bundle from an object or a JSON string. Only the shape is checked; signatures are not. */
export function parseBundle(input: unknown): Parsed<Bundle> {
  let value = input;
  if (typeof input === 'string') {
    if (input.length > MAX_BUNDLE_BYTES) {
      return { ok: false, message: 'bundle is too large' };
    }
    try {
      value = JSON.parse(input);
    } catch {
      return { ok: false, message: 'bundle is not valid JSON' };
    }
  }
  return parseWith(bundleSchema, value);
}

/** Canonical JSON text of a bundle, for storage and transport. */
export function serializeBundle(bundle: Bundle): string {
  return canonicalize(bundle);
}

// ---------------------------------------------------------------------------------------------
// Unverified decoding
// ---------------------------------------------------------------------------------------------

export type DecodedPart<T> =
  | { readonly ok: true; readonly kid: string; readonly payload: T; readonly hash: string; readonly jws: string }
  | { readonly ok: false; readonly message: string };

function decodePart<T>(jws: string, parse: (payload: unknown) => Parsed<T>): DecodedPart<T> {
  const decoded = decodeJws(jws);
  if (!decoded.ok) {
    return { ok: false, message: decoded.error.message };
  }
  const parsed = parse(decoded.payload);
  if (!parsed.ok) {
    return { ok: false, message: parsed.message };
  }
  return { ok: true, kid: decoded.header.kid, payload: parsed.value, hash: decoded.hash, jws };
}

/** Decode a mandate JWS and validate its payload shape. DOES NOT check the signature. */
export function decodeMandate(jws: string): DecodedPart<MandatePayload> {
  return decodePart(jws, (p) => parseWith(mandateSchema, p));
}

/** Decode a cart warrant JWS and validate its payload shape. DOES NOT check the signature. */
export function decodeCart(jws: string): DecodedPart<CartPayload> {
  return decodePart(jws, (p) => parseWith(cartSchema, p));
}

/** Decode a consent JWS and validate its payload shape. DOES NOT check the signature. */
export function decodeConsent(jws: string): DecodedPart<ConsentPayload> {
  return decodePart(jws, (p) => parseWith(consentPayloadSchema, p));
}

export interface DecodedBundle {
  readonly mandate: DecodedPart<MandatePayload>;
  readonly cart: DecodedPart<CartPayload>;
}

export function decodeBundle(bundle: Bundle): DecodedBundle {
  return { mandate: decodeMandate(bundle.mandate), cart: decodeCart(bundle.cart) };
}

