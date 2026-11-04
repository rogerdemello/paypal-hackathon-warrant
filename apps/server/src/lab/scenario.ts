import type { ActionType, Attribution, ClaimType, DisputeOutcome, MerchantMode, Outcome } from '@warrant/warrant';

/**
 * A scenario is a short, labelled story run through the real system: a mandate, a cart and a warrant (possibly tampered), a
 * checkout at a merchant of a chosen kind, optionally a payment, fulfilment and a dispute with a stated claim. The same
 * scenarios drive the Dispute Lab in the web app and the `pnpm eval` corpus in `sim/`.
 */

export const SCENARIO_FAMILIES = [
  'remorse',
  'cart_swap',
  'scope_stretch',
  'forgery',
  'replay_audience',
  'key_time',
  'payer_mismatch',
  'merchant_fault',
  'injection',
  'permissive',
  'consent_reuse',
  'budget_stretch',
] as const;
export type ScenarioFamily = (typeof SCENARIO_FAMILIES)[number];

export const FAMILY_TITLES: Record<ScenarioFamily, string> = {
  remorse: 'Honest purchase, later "I never ordered"',
  cart_swap: 'Cart swap',
  scope_stretch: 'Scope stretch',
  forgery: 'Forgery',
  replay_audience: 'Replay and audience',
  key_time: 'Key and time',
  payer_mismatch: 'Payer mismatch',
  merchant_fault: 'Merchant fault',
  injection: 'Injection and hallucination',
  permissive: 'Permissive or no-support merchant',
  consent_reuse: 'Consent reuse',
  budget_stretch: 'Budget stretch',
};

/** A line in a scenario cart: a store product by sku. */
export interface LineSpec {
  readonly sku: string;
  readonly qty?: number;
}

export interface MandateOverrides {
  readonly maxTotalCents?: number;
  readonly maxPerItemCents?: number;
  readonly maxItems?: number;
  readonly categoriesAllow?: readonly string[] | null;
  readonly merchantsAllow?: readonly string[];
  readonly merchantsDeny?: readonly string[];
  readonly mode?: 'human_present' | 'human_not_present';
  readonly budgetMode?: 'cumulative' | 'per_cart';
}

/** How the bundle the agent submits is tampered with, or how the world is changed before it is submitted. */
export type HonestBasedAttack =
  | { readonly type: 'edit_total' }
  | { readonly type: 'edit_item_price' }
  | { readonly type: 'wrong_key' }
  | { readonly type: 'unknown_key' }
  | { readonly type: 'swap_cart'; readonly lines: readonly LineSpec[] }
  | { readonly type: 'other_mandate_hash' }
  | { readonly type: 'edit_instruction' }
  | { readonly type: 'replay' }
  | { readonly type: 'nonce_reuse' }
  | { readonly type: 'other_merchant' }
  | { readonly type: 'consent_for_other_merchant' }
  | { readonly type: 'consent_fresh_jti' }
  | { readonly type: 'expired_cart' }
  | { readonly type: 'cart_too_long_lived' }
  | { readonly type: 'cart_from_future'; readonly seconds: number }
  | { readonly type: 'price_changed'; readonly deltaCents: number }
  | { readonly type: 'item_unavailable' }
  | { readonly type: 'listing_changed' };

/** Attacks that build their own mandate and cart, without an honest purchase to start from. */
export type StandaloneAttack =
  | { readonly type: 'garbage' }
  | { readonly type: 'no_consent' }
  | { readonly type: 'consent_unseen_by_wallet' }
  | { readonly type: 'forged_cart'; readonly lines: readonly LineSpec[]; readonly aud?: 'other_merchant' }
  | { readonly type: 'revoked_agent_key' }
  | { readonly type: 'suspended_wallet_key' }
  | { readonly type: 'expired_mandate' };

export type Attack = HonestBasedAttack | StandaloneAttack;

export interface DisputeSpec {
  readonly reason: string;
  readonly message: string;
  /** Hours until PayPal's response deadline. Default 240. */
  readonly dueInHours?: number;
  /** Disputed amount; default the whole payment. */
  readonly amountCents?: number;
}

export interface ScenarioSetup {
  /** The merchant's mode. Default STRICT. */
  readonly merchantMode?: MerchantMode;
  /** Whether the buyer's PayPal account is already linked to the wallet. Default true. */
  readonly linkedPayer?: boolean;
  readonly mandate?: MandateOverrides;
  /** The cart the human approves. Default: one standing desk converter. */
  readonly cart?: readonly LineSpec[];
  readonly attack?: Attack;
  /** Carts bought earlier under the same mandate. */
  readonly priorCarts?: readonly (readonly LineSpec[])[];
  /** Who approves at PayPal. Default the buyer the wallet knows. */
  readonly payer?: 'buyer' | 'other';
  readonly fulfilment?: 'none' | 'shipped' | 'delivered' | 'delivered_late';
  /** The store changes the listing after the human consented but before it ships. */
  readonly listingChangedBeforeShipping?: boolean;
  /** PayPal is charged this much more than the consented cart. */
  readonly chargeExtraCents?: number;
  readonly refundBeforeDispute?: boolean;
  /** The note writer a second analysis uses: a model that invents facts, or one that sticks to the record. */
  readonly notes?: 'hallucinating' | 'grounded';
  readonly dispute?: DisputeSpec;
}

export interface ScenarioExpect {
  /** What the merchant's rules say about the bundle. */
  readonly verifier: Outcome;
  /** Rules that must have rejected it (all of them, no others). Omit to not check. */
  readonly rejectedRules?: readonly string[];
  /** Whether the merchant took the order (STRICT merchants refuse REJECT; PERMISSIVE and NONE take it). */
  readonly sold: boolean;
  /** How the order ends after the buyer approves at PayPal. Default `captured` when sold. */
  readonly payment?: 'captured' | 'rejected';
  readonly dispute?: {
    readonly claim: ClaimType;
    readonly outcome: DisputeOutcome;
    readonly rule: string;
    readonly action: ActionType;
    readonly attribution?: Partial<Attribution>;
    readonly flags?: readonly string[];
    readonly confidence?: 'normal' | 'low';
    /** Where the notes came from after the `notes` writer ran. */
    readonly noteSource?: string;
  };
}

export interface Scenario {
  readonly id: string;
  readonly family: ScenarioFamily;
  readonly title: string;
  readonly story: string;
  readonly setup: ScenarioSetup;
  readonly expect: ScenarioExpect;
}

export interface StepRecord {
  readonly name: string;
  readonly detail: string;
  readonly ok: boolean;
}

export interface ScenarioResult {
  readonly id: string;
  readonly family: ScenarioFamily;
  readonly title: string;
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly steps: readonly StepRecord[];
  readonly actual: {
    readonly verifier: Outcome | null;
    readonly rejectedRules: readonly string[];
    readonly sold: boolean;
    readonly payment: string | null;
    readonly orderId: string | null;
    readonly cartJti: string | null;
    readonly disputeId: string | null;
    readonly claim: ClaimType | null;
    readonly outcome: DisputeOutcome | null;
    readonly rule: string | null;
    readonly action: ActionType | null;
    readonly attribution: Attribution | null;
    readonly flags: readonly string[];
    readonly confidence: 'normal' | 'low' | null;
    readonly state: string | null;
    readonly noteSource: string | null;
  };
  /** Milliseconds from the dispute webhook to a proposed action. */
  readonly latencyMs: number | null;
  readonly durationMs: number;
}
