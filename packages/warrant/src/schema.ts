import { z } from 'zod';
import { HASH_PATTERN } from './canonical';
import { tryParseMoney } from './money';
import { parseInstantSeconds } from './time';

/**
 * Document schemas for the three Warrant payloads and the bundle (docs/warrant-spec.md section 3).
 *
 * All objects are strict: an unknown field is a rejection, so a signed document cannot smuggle in claims a
 * verifier does not know about. Money is a decimal string here (at most two decimals, no sign, no exponent);
 * everything in code converts it to integer cents with `parseMoney` at the boundary.
 *
 * Validating shape is not validating meaning: the verifier (V01-V12) decides whether a well-formed document is
 * trustworthy. Fields that a rule inspects (for example the consent fields) are optional here so that the rule
 * can report a precise finding instead of the whole cart failing to decode.
 */

const hash = z.string().regex(HASH_PATTERN, 'must be sha256: followed by 43 base64url characters');
const amount = z.string().refine((s) => tryParseMoney(s) !== null, 'must be a decimal amount with at most two decimals');
const numericDate = z.number().int().min(0);
const isoInstant = z.string().refine((s) => parseInstantSeconds(s) !== null, 'must be a UTC instant like 2026-11-04T10:00:00Z');
const currency = z.string().regex(/^[A-Z]{3}$/, 'must be an ISO 4217 code in upper case');
const shortText = z.string().min(1).max(256);
const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/, 'must be 1-128 characters of A-Z a-z 0-9 _ . : -');
const mode = z.enum(['human_present', 'human_not_present']);
const budgetMode = z.enum(['cumulative', 'per_cart']);

export const mandateSchema = z.strictObject({
  typ: z.literal('mandate'),
  jti: id,
  iss: shortText,
  iat: numericDate,
  nbf: numericDate,
  exp: numericDate,
  principal: z.strictObject({
    ref: shortText,
    paypal_payer_id_hash: hash.optional(),
  }),
  agent: z.strictObject({
    platform: shortText,
    agent_id: shortText,
    kid: shortText,
  }),
  instruction: z.strictObject({
    text: z.string().min(1).max(4000),
    hash,
  }),
  scope: z.strictObject({
    currency,
    max_total: amount,
    max_per_item: amount,
    max_items: z.number().int().min(1).max(100_000),
    categories_allow: z.array(shortText).max(1000).nullable(),
    merchants_allow: z.array(shortText).max(1000),
    merchants_deny: z.array(shortText).max(1000),
    mode,
    /** `cumulative`: max_total and max_items are totals over the life of the mandate. `per_cart`: they apply to each cart. */
    budget_mode: budgetMode,
  }),
});

export const cartLineSchema = z.strictObject({
  sku: shortText,
  title: z.string().min(1).max(500),
  qty: z.number().int().min(1).max(100_000),
  unit_price: amount,
  listing_hash: hash,
});

/** The object that `cart_hash` commits to. */
export const cartBodySchema = z.strictObject({
  currency,
  items: z.array(cartLineSchema).min(1).max(1000),
  total: amount,
});

export const consentSchema = z.strictObject({
  mode,
  approved_at: isoInstant.optional(),
  method: z.enum(['click', 'passkey']).optional(),
  presented_hash: hash.optional(),
  signature: z.string().min(1).max(8192).optional(),
});

export const cartSchema = z.strictObject({
  typ: z.literal('cart'),
  jti: id,
  iss: shortText,
  aud: shortText,
  iat: numericDate,
  exp: numericDate,
  nonce: z.string().min(1).max(256),
  mandate: z.strictObject({ jti: id, hash }),
  cart: cartBodySchema,
  cart_hash: hash,
  consent: consentSchema,
});

/**
 * What the wallet's consent signature covers (spec section 3.3, Warrant 0.2), with `typ` for domain separation.
 * `cart_jti` and `aud` bind the consent to one cart warrant and one merchant, so it can be spent once.
 */
export const consentPayloadSchema = z.strictObject({
  typ: z.literal('consent'),
  cart_hash: hash,
  cart_jti: id,
  aud: shortText,
  presented_hash: hash,
  approved_at: isoInstant,
  mandate_hash: hash,
});

export const bundleSchema = z.strictObject({
  warrant_version: z.literal('0.2'),
  mandate: z.string().min(1),
  cart: z.string().min(1),
});

export type MandatePayload = z.infer<typeof mandateSchema>;
export type CartLine = z.infer<typeof cartLineSchema>;
export type CartBody = z.infer<typeof cartBodySchema>;
export type Consent = z.infer<typeof consentSchema>;
export type CartPayload = z.infer<typeof cartSchema>;
export type ConsentPayload = z.infer<typeof consentPayloadSchema>;
export type Bundle = z.infer<typeof bundleSchema>;
export type ConsentMode = z.infer<typeof mode>;
export type BudgetMode = z.infer<typeof budgetMode>;

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

export function parseWith<T>(schema: z.ZodType<T>, input: unknown): Parsed<T> {
  const result = schema.safeParse(input);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  const message = result.error.issues
    .slice(0, 4)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
  return { ok: false, message };
}

export const parseMandatePayload = (input: unknown): Parsed<MandatePayload> => parseWith(mandateSchema, input);
export const parseCartPayload = (input: unknown): Parsed<CartPayload> => parseWith(cartSchema, input);
export const parseConsentPayload = (input: unknown): Parsed<ConsentPayload> => parseWith(consentPayloadSchema, input);
