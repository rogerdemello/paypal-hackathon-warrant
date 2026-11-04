import type { Fact, Facts } from './facts';

/**
 * The deterministic outcome table, docs/dispute-resolution.md section 4.
 *
 * `decideOutcome(claimType, facts)` is a total, pure function: every claim type and every combination of facts
 * yields exactly one decision, and the same inputs always yield the same decision. The language model only
 * supplies the claim type (from a closed enum) and writes prose afterwards; it never reaches this function's
 * decision. Rows the table does not cover resolve to ESCALATE_TO_HUMAN with a `table_gap` flag, never to a guess.
 *
 * Evaluation order: the "any claim" rows first (already refunded, deadline, amount sanity), then the rows of the
 * claim type from top to bottom, first match wins.
 */

export const CLAIM_TYPES = ['UNAUTHORIZED', 'NOT_RECEIVED', 'NOT_AS_DESCRIBED', 'WRONG_AMOUNT', 'DUPLICATE', 'OTHER'] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

export type DisputeOutcome =
  | 'FIGHT'
  | 'ACCEPT_AGENT_FAULT'
  | 'NO_PROOF'
  | 'REFUND_MERCHANT_FAULT'
  | 'ACCEPT'
  | 'ALREADY_RESOLVED'
  | 'ESCALATE_TO_HUMAN';

/** Categorical, never numeric percentages. */
export type AttributionLabel = 'primary' | 'contributing' | 'none' | 'unknown';

export interface Attribution {
  readonly agent_platform: AttributionLabel;
  readonly merchant: AttributionLabel;
  readonly principal: AttributionLabel;
}

export type ActionType = 'provide-evidence' | 'accept-claim' | 'make-offer' | 'alert' | 'none';

export interface ProposedAction {
  readonly type: ActionType;
  /** Refinement such as PROOF_OF_FULFILLMENT, PARTIAL_REFUND, REFUND_WITH_REPLACEMENT. Must be checked against PayPal's allowed_response_options. */
  readonly detail?: string;
}

export interface OutcomeDecision {
  readonly claim: ClaimType;
  readonly outcome: DisputeOutcome;
  /** Which row of the table matched (stable identifier for tests, memos and the console). */
  readonly rule: string;
  readonly action: ProposedAction;
  /** Other actions that would also be acceptable, in order of preference. */
  readonly alternatives: readonly ProposedAction[];
  readonly confidence: 'normal' | 'low';
  readonly attribution: Attribution;
  /** The facts this decision looked at, as `F1:true`. */
  readonly factsUsed: readonly string[];
  readonly flags: readonly string[];
  readonly caveat: string;
}

const CAVEAT = 'Advisory. PayPal and applicable rules decide liability.';

const UNKNOWN: Attribution = { agent_platform: 'unknown', merchant: 'unknown', principal: 'unknown' };
const NO_FAULT: Attribution = { agent_platform: 'none', merchant: 'none', principal: 'none' };

/** Treat anything but a literal `true` as false, so malformed facts can never help the wrong side. */
const isTrue = (f: Fact<boolean> | undefined): boolean => f?.value === true;

/**
 * True when the cart and mandate signatures are genuine, even if F2 as a whole is false. F2 also covers the consent, and a
 * swapped cart leaves the consent valid but for a different cart, so F2 is false exactly when an agent platform signed
 * something the human did not approve. That is the case row 2 exists for.
 */
const signedObjectsAuthentic = (f: Fact<boolean> | undefined): boolean => f?.value === true || (f?.detail?.['cart'] === true && f.detail['mandate'] === true);

function used(facts: Facts, ids: ReadonlyArray<keyof Omit<Facts, 'context'>>): string[] {
  return ids.map((id) => `${id}:${String(facts[id]?.value)}`);
}

interface Row {
  outcome: DisputeOutcome;
  rule: string;
  action: ProposedAction;
  alternatives?: ProposedAction[];
  confidence?: 'normal' | 'low';
  attribution: Attribution;
  factsUsed: string[];
  flags?: string[];
}

function decision(claim: ClaimType, row: Row): OutcomeDecision {
  return {
    claim,
    outcome: row.outcome,
    rule: row.rule,
    action: row.action,
    alternatives: row.alternatives ?? [],
    confidence: row.confidence ?? 'normal',
    attribution: row.attribution,
    factsUsed: row.factsUsed,
    flags: row.flags ?? [],
    caveat: CAVEAT,
  };
}

function escalate(claim: ClaimType, facts: Facts, rule: string, ids: ReadonlyArray<keyof Omit<Facts, 'context'>>, flags: string[]): OutcomeDecision {
  return decision(claim, { outcome: 'ESCALATE_TO_HUMAN', rule, action: { type: 'alert' }, attribution: UNKNOWN, factsUsed: used(facts, ids), flags });
}

/** Who changed the cart between what the human approved and what was paid for (UNAUTHORIZED rows 2-3, WRONG_AMOUNT). */
function cartChangeAttribution(facts: Facts): Attribution {
  const merchantEnforced = facts.context.merchantMode === 'STRICT';
  const detail = facts.F5.detail;
  const bundleMatchesConsent = detail?.['bundleCartMatchesConsent'] === true;
  const orderMatchesBundle = detail?.['orderMatchesBundleCart'] === true;
  if (!isTrue(facts.F1)) return UNKNOWN;
  if (!bundleMatchesConsent) {
    // The agent platform signed a cart the human did not approve.
    return { agent_platform: 'primary', merchant: merchantEnforced ? 'none' : 'contributing', principal: 'none' };
  }
  if (!orderMatchesBundle) {
    // The agent's cart was what the human approved, but the order that was paid differs from it.
    return { agent_platform: 'none', merchant: 'primary', principal: 'none' };
  }
  return UNKNOWN;
}

export function decideOutcome(claim: ClaimType, facts: Facts): OutcomeDecision {
  const claimType: ClaimType = (CLAIM_TYPES as readonly string[]).includes(claim) ? claim : 'OTHER';
  const hours = facts.F12?.value;

  // --- Rows for any claim type -------------------------------------------------------------
  if (isTrue(facts.F11)) {
    return decision(claimType, { outcome: 'ALREADY_RESOLVED', rule: 'ANY_F11_ALREADY_REFUNDED', action: { type: 'none' }, attribution: UNKNOWN, factsUsed: used(facts, ['F11']), flags: ['note_only'] });
  }
  if (typeof hours !== 'number' || !Number.isFinite(hours)) {
    return escalate(claimType, facts, 'ANY_F12_DEADLINE_UNKNOWN', ['F12'], ['deadline_unknown']);
  }
  if (hours < 24) {
    return escalate(claimType, facts, 'ANY_F12_DEADLINE_SOON', ['F12'], ['deadline_under_24h']);
  }
  if (!isTrue(facts.F13)) {
    return escalate(claimType, facts, 'ANY_F13_AMOUNT_EXCEEDS_CAPTURE', ['F13'], ['disputed_amount_exceeds_capture']);
  }

  // --- Rows per claim type ---------------------------------------------------------------------
  switch (claimType) {
    case 'UNAUTHORIZED': {
      const f1to8 = (['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8'] as const).every((id) => isTrue(facts[id]));
      if (f1to8) {
        // Authorisation confirmed: the principal approved this cart, and it is what was paid.
        return decision(claimType, {
          outcome: 'FIGHT',
          rule: 'UNAUTHORIZED_1_AUTHORISATION_CONFIRMED',
          action: { type: 'provide-evidence' },
          attribution: { agent_platform: 'none', merchant: 'none', principal: 'primary' },
          factsUsed: used(facts, ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8']),
        });
      }
      if (isTrue(facts.F1) && signedObjectsAuthentic(facts.F2) && !isTrue(facts.F5)) {
        const merchantChanged = facts.F5.detail?.['bundleCartMatchesConsent'] === true && facts.F5.detail['orderMatchesBundleCart'] === false;
        return decision(claimType, {
          outcome: 'ACCEPT_AGENT_FAULT',
          rule: 'UNAUTHORIZED_2_ORDER_DIFFERS_FROM_CONSENT',
          action: { type: 'accept-claim', detail: 'FULL_REFUND' },
          attribution: cartChangeAttribution(facts),
          factsUsed: used(facts, ['F1', 'F2', 'F5']),
          flags: merchantChanged ? ['order_differs_from_signed_cart'] : [],
        });
      }
      if (isTrue(facts.F1) && isTrue(facts.F2) && isTrue(facts.F5) && !isTrue(facts.F6)) {
        return decision(claimType, {
          outcome: 'ACCEPT_AGENT_FAULT',
          rule: 'UNAUTHORIZED_3_OUTSIDE_MANDATE',
          action: { type: 'accept-claim', detail: 'FULL_REFUND' },
          attribution: { agent_platform: 'primary', merchant: facts.context.merchantMode === 'STRICT' ? 'none' : 'contributing', principal: 'none' },
          factsUsed: used(facts, ['F1', 'F2', 'F5', 'F6']),
        });
      }
      if (!isTrue(facts.F1) || !isTrue(facts.F2) || !isTrue(facts.F3) || !isTrue(facts.F7)) {
        // No usable proof of authorisation. Fight only when delivery can be shown, and say it is a weak case.
        const delivered = isTrue(facts.F9);
        return decision(claimType, {
          outcome: 'NO_PROOF',
          rule: 'UNAUTHORIZED_4_NO_PROOF',
          action: delivered ? { type: 'provide-evidence', detail: 'PROOF_OF_FULFILLMENT' } : { type: 'accept-claim', detail: 'FULL_REFUND' },
          alternatives: delivered ? [{ type: 'accept-claim', detail: 'FULL_REFUND' }] : [],
          confidence: delivered ? 'low' : 'normal',
          attribution: UNKNOWN,
          factsUsed: used(facts, ['F1', 'F2', 'F3', 'F7', 'F9']),
          flags: ['flag_agent_platform', 'flag_case'],
        });
      }
      // F1, F2, F3, F5, F6, F7 all hold, but F4 (consent) or F8 (nonce) does not: the table has no row for this.
      return escalate(claimType, facts, 'UNAUTHORIZED_GAP', ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8'], ['table_gap', 'consent_or_nonce_failed']);
    }

    case 'NOT_RECEIVED': {
      if (isTrue(facts.F9) && facts.F9.detail?.['onTime'] === true) {
        return decision(claimType, {
          outcome: 'FIGHT',
          rule: 'NOT_RECEIVED_1_DELIVERED_ON_TIME',
          action: { type: 'provide-evidence', detail: 'PROOF_OF_FULFILLMENT' },
          attribution: NO_FAULT,
          factsUsed: used(facts, ['F9']),
        });
      }
      if (!isTrue(facts.F9)) {
        return decision(claimType, {
          outcome: 'REFUND_MERCHANT_FAULT',
          rule: 'NOT_RECEIVED_2_NOT_DELIVERED',
          action: { type: 'make-offer', detail: 'REFUND' },
          alternatives: [{ type: 'accept-claim', detail: 'FULL_REFUND' }],
          attribution: { agent_platform: 'none', merchant: 'primary', principal: 'none' },
          factsUsed: used(facts, ['F9']),
        });
      }
      return escalate(claimType, facts, 'NOT_RECEIVED_GAP', ['F9'], ['table_gap', 'delivered_late']);
    }

    case 'NOT_AS_DESCRIBED': {
      if (isTrue(facts.F10)) {
        return decision(claimType, {
          outcome: 'FIGHT',
          rule: 'NOT_AS_DESCRIBED_1_LISTING_MATCHES',
          action: { type: 'provide-evidence', detail: 'LISTING_SNAPSHOT' },
          attribution: NO_FAULT,
          factsUsed: used(facts, ['F10']),
        });
      }
      return decision(claimType, {
        outcome: 'REFUND_MERCHANT_FAULT',
        rule: 'NOT_AS_DESCRIBED_2_LISTING_DIFFERS',
        action: { type: 'make-offer', detail: 'REFUND_WITH_REPLACEMENT' },
        alternatives: [{ type: 'make-offer', detail: 'REFUND' }, { type: 'accept-claim', detail: 'FULL_REFUND' }],
        attribution: { agent_platform: 'none', merchant: 'primary', principal: 'none' },
        factsUsed: used(facts, ['F10']),
      });
    }

    case 'WRONG_AMOUNT': {
      if (!isTrue(facts.F5)) {
        return decision(claimType, {
          outcome: 'ACCEPT',
          rule: 'WRONG_AMOUNT_1_ORDER_DIFFERS_FROM_CONSENT',
          action: { type: 'accept-claim', detail: 'PARTIAL_REFUND' },
          attribution: cartChangeAttribution(facts),
          factsUsed: used(facts, ['F1', 'F5']),
        });
      }
      return escalate(claimType, facts, 'WRONG_AMOUNT_GAP', ['F5'], ['table_gap', 'order_matches_consent']);
    }

    case 'DUPLICATE':
      return escalate(claimType, facts, 'DUPLICATE_NO_ROW', ['F8'], ['table_gap', 'no_automated_rule']);

    case 'OTHER':
      return escalate(claimType, facts, 'OTHER_NO_ROW', [], ['table_gap', 'no_automated_rule']);
  }
}
