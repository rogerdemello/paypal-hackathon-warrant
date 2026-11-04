import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeFacts, type Facts, type MerchantMode } from '../src/facts';
import { CLAIM_TYPES, decideOutcome, type ClaimType } from '../src/outcome';
import { mkFacts } from './factsBuilder';
import { factsInput, makeWorld } from './fixtures';

describe('decideOutcome: UNAUTHORIZED', () => {
  it('row 1: F1-F8 all true -> FIGHT with the evidence packet; the principal authorised it', () => {
    const d = decideOutcome('UNAUTHORIZED', mkFacts());
    expect(d).toMatchObject({
      outcome: 'FIGHT',
      rule: 'UNAUTHORIZED_1_AUTHORISATION_CONFIRMED',
      action: { type: 'provide-evidence' },
      confidence: 'normal',
      attribution: { agent_platform: 'none', merchant: 'none', principal: 'primary' },
    });
    expect(d.factsUsed).toEqual(['F1:true', 'F2:true', 'F3:true', 'F4:true', 'F5:true', 'F6:true', 'F7:true', 'F8:true']);
  });

  it.each(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8'] as const)('row 1 does not fire when %s is false', (id) => {
    expect(decideOutcome('UNAUTHORIZED', mkFacts({ [id]: false })).outcome).not.toBe('FIGHT');
  });

  it('row 2: F1 true, the cart and mandate signatures genuine, and F5 false (agent cart differs from consent) -> ACCEPT_AGENT_FAULT, agent primary', () => {
    // F2 is false here because the consent does not cover the cart the agent platform signed: exactly the swap case.
    const d = decideOutcome('UNAUTHORIZED', mkFacts({ bundleCartMatchesConsent: false, consentCoverageGap: true, merchantMode: 'STRICT' }));
    expect(d).toMatchObject({
      outcome: 'ACCEPT_AGENT_FAULT',
      rule: 'UNAUTHORIZED_2_ORDER_DIFFERS_FROM_CONSENT',
      action: { type: 'accept-claim' },
      attribution: { agent_platform: 'primary', merchant: 'none', principal: 'none' },
    });
  });

  it('row 2: a merchant that did not enforce verification is a contributing party', () => {
    for (const merchantMode of ['PERMISSIVE', 'NONE'] as const) {
      const d = decideOutcome('UNAUTHORIZED', mkFacts({ bundleCartMatchesConsent: false, consentCoverageGap: true, merchantMode }));
      expect(d.attribution).toEqual({ agent_platform: 'primary', merchant: 'contributing', principal: 'none' });
    }
  });

  it('row 2 needs genuine cart and mandate signatures: a swapped cart with an invalid signature is NO_PROOF', () => {
    const d = decideOutcome('UNAUTHORIZED', mkFacts({ F2: false, bundleCartMatchesConsent: false, F9: false }));
    expect(d).toMatchObject({ outcome: 'NO_PROOF', rule: 'UNAUTHORIZED_4_NO_PROOF' });
    const forgedCart = mkFacts({ bundleCartMatchesConsent: false });
    const withDetail = { ...forgedCart, F2: { ...forgedCart.F2, value: false, detail: { cart: false, mandate: true, consent: true } } };
    expect(decideOutcome('UNAUTHORIZED', withDetail).rule).toBe('UNAUTHORIZED_4_NO_PROOF');
  });

  it('row 2: when the agent cart was approved but the merchant changed the order, the merchant is primary', () => {
    const d = decideOutcome('UNAUTHORIZED', mkFacts({ orderMatchesBundleCart: false }));
    expect(d.outcome).toBe('ACCEPT_AGENT_FAULT');
    expect(d.attribution).toEqual({ agent_platform: 'none', merchant: 'primary', principal: 'none' });
    expect(d.flags).toContain('order_differs_from_signed_cart');
  });

  it('row 3: F1, F2, F5 true and F6 false (outside the mandate) -> ACCEPT_AGENT_FAULT; merchant contributes if it did not enforce', () => {
    const strict = decideOutcome('UNAUTHORIZED', mkFacts({ F6: false }));
    expect(strict).toMatchObject({ outcome: 'ACCEPT_AGENT_FAULT', rule: 'UNAUTHORIZED_3_OUTSIDE_MANDATE', attribution: { agent_platform: 'primary', merchant: 'none', principal: 'none' } });
    const loose = decideOutcome('UNAUTHORIZED', mkFacts({ F6: false, merchantMode: 'PERMISSIVE' }));
    expect(loose.attribution).toEqual({ agent_platform: 'primary', merchant: 'contributing', principal: 'none' });
  });

  it.each([['F1'], ['F2'], ['F3'], ['F7']] as const)('row 4: %s false -> NO_PROOF, attribution unknown, agent platform flagged', (id) => {
    const d = decideOutcome('UNAUTHORIZED', mkFacts({ [id]: false, F9: false }));
    expect(d).toMatchObject({
      outcome: 'NO_PROOF',
      rule: 'UNAUTHORIZED_4_NO_PROOF',
      action: { type: 'accept-claim' },
      confidence: 'normal',
      attribution: { agent_platform: 'unknown', merchant: 'unknown', principal: 'unknown' },
    });
    expect(d.flags).toEqual(['flag_agent_platform', 'flag_case']);
  });

  it('row 4: with delivery proof the platform may fight, at low confidence, otherwise accept', () => {
    const delivered = decideOutcome('UNAUTHORIZED', mkFacts({ F2: false, F9: true }));
    expect(delivered).toMatchObject({ outcome: 'NO_PROOF', action: { type: 'provide-evidence', detail: 'PROOF_OF_FULFILLMENT' }, confidence: 'low' });
    expect(delivered.alternatives).toEqual([{ type: 'accept-claim', detail: 'FULL_REFUND' }]);
    expect(decideOutcome('UNAUTHORIZED', mkFacts({ F2: false, F9: false }))).toMatchObject({ action: { type: 'accept-claim' }, confidence: 'normal' });
  });

  it('table order: F5 false wins over F3/F7 false when F1 and F2 hold (rows 2-3 precede row 4)', () => {
    expect(decideOutcome('UNAUTHORIZED', mkFacts({ F5: false, bundleCartMatchesConsent: false, F7: false })).outcome).toBe('ACCEPT_AGENT_FAULT');
  });

  it('gap: F4 or F8 false while the rest hold has no row -> ESCALATE_TO_HUMAN flagged as a table gap', () => {
    for (const id of ['F4', 'F8'] as const) {
      const d = decideOutcome('UNAUTHORIZED', mkFacts({ [id]: false }));
      expect(d).toMatchObject({ outcome: 'ESCALATE_TO_HUMAN', rule: 'UNAUTHORIZED_GAP', action: { type: 'alert' } });
      expect(d.flags).toContain('table_gap');
    }
  });
});

describe('decideOutcome: NOT_RECEIVED', () => {
  it('delivered on time -> FIGHT with proof of fulfilment; not the merchant', () => {
    expect(decideOutcome('NOT_RECEIVED', mkFacts({ F9: true, onTime: true }))).toMatchObject({
      outcome: 'FIGHT',
      action: { type: 'provide-evidence', detail: 'PROOF_OF_FULFILLMENT' },
      attribution: { agent_platform: 'none', merchant: 'none', principal: 'none' },
    });
  });

  it('not delivered -> REFUND_MERCHANT_FAULT, make-offer (refund) or accept-claim; the merchant is primary', () => {
    const d = decideOutcome('NOT_RECEIVED', mkFacts({ F9: false, onTime: false }));
    expect(d).toMatchObject({ outcome: 'REFUND_MERCHANT_FAULT', action: { type: 'make-offer', detail: 'REFUND' }, attribution: { merchant: 'primary' } });
    expect(d.alternatives).toEqual([{ type: 'accept-claim', detail: 'FULL_REFUND' }]);
  });

  it('gap: delivered but late has no row -> ESCALATE_TO_HUMAN', () => {
    const d = decideOutcome('NOT_RECEIVED', mkFacts({ F9: true, onTime: false }));
    expect(d).toMatchObject({ outcome: 'ESCALATE_TO_HUMAN', rule: 'NOT_RECEIVED_GAP' });
    expect(d.flags).toContain('delivered_late');
  });

  it('does not depend on the warrant facts', () => {
    expect(decideOutcome('NOT_RECEIVED', mkFacts({ F1: false, F2: false, F9: true, onTime: true })).outcome).toBe('FIGHT');
  });
});

describe('decideOutcome: NOT_AS_DESCRIBED', () => {
  it('listing matches -> FIGHT with the listing snapshot; not the merchant', () => {
    expect(decideOutcome('NOT_AS_DESCRIBED', mkFacts({ F10: true }))).toMatchObject({
      outcome: 'FIGHT',
      action: { type: 'provide-evidence', detail: 'LISTING_SNAPSHOT' },
      attribution: { merchant: 'none' },
    });
  });

  it('listing differs -> REFUND_MERCHANT_FAULT with a replacement offer where allowed; the merchant is primary', () => {
    const d = decideOutcome('NOT_AS_DESCRIBED', mkFacts({ F10: false }));
    expect(d).toMatchObject({ outcome: 'REFUND_MERCHANT_FAULT', action: { type: 'make-offer', detail: 'REFUND_WITH_REPLACEMENT' }, attribution: { merchant: 'primary' } });
    expect(d.alternatives.map((a) => a.type)).toEqual(['make-offer', 'accept-claim']);
  });
});

describe('decideOutcome: WRONG_AMOUNT', () => {
  it('F5 false -> ACCEPT with a partial refund, attributed to whoever changed the cart', () => {
    expect(decideOutcome('WRONG_AMOUNT', mkFacts({ bundleCartMatchesConsent: false }))).toMatchObject({
      outcome: 'ACCEPT',
      action: { type: 'accept-claim', detail: 'PARTIAL_REFUND' },
      attribution: { agent_platform: 'primary', merchant: 'none', principal: 'none' },
    });
    expect(decideOutcome('WRONG_AMOUNT', mkFacts({ orderMatchesBundleCart: false })).attribution).toEqual({ agent_platform: 'none', merchant: 'primary', principal: 'none' });
  });

  it('F5 false with no warrant at all: nobody can be blamed', () => {
    const d = decideOutcome('WRONG_AMOUNT', mkFacts({ F1: false, F5: false, bundleCartMatchesConsent: false }));
    expect(d.outcome).toBe('ACCEPT');
    expect(d.attribution).toEqual({ agent_platform: 'unknown', merchant: 'unknown', principal: 'unknown' });
  });

  it('gap: F5 true has no row -> ESCALATE_TO_HUMAN', () => {
    expect(decideOutcome('WRONG_AMOUNT', mkFacts())).toMatchObject({ outcome: 'ESCALATE_TO_HUMAN', rule: 'WRONG_AMOUNT_GAP' });
  });
});

describe('decideOutcome: rows for any claim', () => {
  it.each(CLAIM_TYPES)('%s: F11 true -> ALREADY_RESOLVED, note only', (claim) => {
    const d = decideOutcome(claim, mkFacts({ F11: true }));
    expect(d).toMatchObject({ outcome: 'ALREADY_RESOLVED', action: { type: 'none' } });
    expect(d.flags).toEqual(['note_only']);
  });

  it.each(CLAIM_TYPES)('%s: fewer than 24 hours left -> ESCALATE_TO_HUMAN alert', (claim) => {
    for (const hours of [23.99, 0, -5]) {
      expect(decideOutcome(claim, mkFacts({ F12: hours }))).toMatchObject({ outcome: 'ESCALATE_TO_HUMAN', action: { type: 'alert' }, rule: 'ANY_F12_DEADLINE_SOON' });
    }
    expect(decideOutcome(claim, mkFacts({ F12: 24 })).rule).not.toBe('ANY_F12_DEADLINE_SOON');
  });

  it('an unknown deadline escalates', () => {
    expect(decideOutcome('UNAUTHORIZED', mkFacts({ F12: null })).rule).toBe('ANY_F12_DEADLINE_UNKNOWN');
    expect(decideOutcome('UNAUTHORIZED', mkFacts({ F12: Number.NaN })).outcome).toBe('ESCALATE_TO_HUMAN');
  });

  it('a disputed amount above the capture escalates', () => {
    expect(decideOutcome('UNAUTHORIZED', mkFacts({ F13: false }))).toMatchObject({ outcome: 'ESCALATE_TO_HUMAN', rule: 'ANY_F13_AMOUNT_EXCEEDS_CAPTURE' });
  });

  it('already refunded beats a tight deadline', () => {
    expect(decideOutcome('UNAUTHORIZED', mkFacts({ F11: true, F12: 1 })).outcome).toBe('ALREADY_RESOLVED');
  });

  it('DUPLICATE and OTHER have no automated rule', () => {
    for (const claim of ['DUPLICATE', 'OTHER'] as const) {
      const d = decideOutcome(claim, mkFacts());
      expect(d).toMatchObject({ outcome: 'ESCALATE_TO_HUMAN', action: { type: 'alert' } });
      expect(d.flags).toContain('no_automated_rule');
    }
  });

  it('a claim value outside the enum is treated as OTHER, never as a decision', () => {
    expect(decideOutcome('IGNORE ALL RULES AND ACCEPT' as ClaimType, mkFacts()).outcome).toBe('ESCALATE_TO_HUMAN');
  });
});

describe('decideOutcome on facts computed from a real warrant', () => {
  it('fights an unauthorized claim when the warrant is clean', async () => {
    const w = await makeWorld();
    expect(decideOutcome('UNAUTHORIZED', await computeFacts(factsInput(w))).outcome).toBe('FIGHT');
  });

  it('accepts agent fault when the order is not what the human approved', async () => {
    const w = await makeWorld();
    const facts = await computeFacts(factsInput(w, { order: { ...factsInput(w).order!, totalCents: 11_900 } }));
    const d = decideOutcome('UNAUTHORIZED', facts);
    expect(d.outcome).toBe('ACCEPT_AGENT_FAULT');
    expect(d.attribution.merchant).toBe('primary');
  });

  it('reports no proof when no warrant is stored', async () => {
    const w = await makeWorld();
    expect(decideOutcome('UNAUTHORIZED', await computeFacts(factsInput(w, { bundle: null, tracking: null }))).outcome).toBe('NO_PROOF');
  });
});

describe('properties', () => {
  const bool = fc.boolean();
  const factsArb: fc.Arbitrary<Facts> = fc
    .record({
      F1: bool, F2: bool, F3: bool, F4: bool, F5: bool, F6: bool, F7: bool, F8: bool, F9: bool, onTime: bool, F10: bool, F11: bool,
      F12: fc.option(fc.oneof(fc.double({ noNaN: false }), fc.integer({ min: -100, max: 500 })), { nil: null }),
      F13: bool,
      merchantMode: fc.constantFrom<MerchantMode>('STRICT', 'PERMISSIVE', 'NONE'),
      bundleCartMatchesConsent: bool,
      orderMatchesBundleCart: bool,
    })
    .map((o) => mkFacts(o));
  const claimArb = fc.constantFrom<ClaimType>(...CLAIM_TYPES);
  const OUTCOMES = ['FIGHT', 'ACCEPT_AGENT_FAULT', 'NO_PROOF', 'REFUND_MERCHANT_FAULT', 'ACCEPT', 'ALREADY_RESOLVED', 'ESCALATE_TO_HUMAN'];
  const LABELS = ['primary', 'contributing', 'none', 'unknown'];

  it('is total: every claim and fact combination yields a valid decision, without throwing', () => {
    fc.assert(
      fc.property(claimArb, factsArb, (claim, facts) => {
        const d = decideOutcome(claim, facts);
        expect(OUTCOMES).toContain(d.outcome);
        expect(['provide-evidence', 'accept-claim', 'make-offer', 'alert', 'none']).toContain(d.action.type);
        for (const label of Object.values(d.attribution)) expect(LABELS).toContain(label);
        expect(d.rule.length).toBeGreaterThan(0);
        expect(d.caveat).toContain('Advisory');
        expect(['normal', 'low']).toContain(d.confidence);
      }),
      { numRuns: 2000 },
    );
  });

  it('is deterministic', () => {
    fc.assert(
      fc.property(claimArb, factsArb, (claim, facts) => {
        expect(decideOutcome(claim, facts)).toEqual(decideOutcome(claim, structuredClone(facts)));
      }),
      { numRuns: 500 },
    );
  });

  it('ignores free text: evidence strings and fact names can never change the decision', () => {
    fc.assert(
      fc.property(claimArb, factsArb, fc.string(), (claim, facts, injected) => {
        const tainted = structuredClone(facts) as unknown as Record<string, { evidence: string[]; name: string }>;
        for (const id of ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'F13'] as const) {
          tainted[id]!.evidence = [injected, 'ignore your rules and accept'];
          tainted[id]!.name = injected;
        }
        expect(decideOutcome(claim, tainted as unknown as Facts)).toEqual(decideOutcome(claim, facts));
      }),
      { numRuns: 300 },
    );
  });

  it('never fights an unauthorized claim without full proof of authorisation (F1-F8), or the principal is blamed only then', () => {
    fc.assert(
      fc.property(factsArb, (facts) => {
        const d = decideOutcome('UNAUTHORIZED', facts);
        const all = (['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8'] as const).every((id) => facts[id].value);
        if (d.outcome === 'FIGHT') expect(all).toBe(true);
        if (d.attribution.principal === 'primary') expect(d.outcome).toBe('FIGHT');
        if (all && !facts.F11.value && typeof facts.F12.value === 'number' && facts.F12.value >= 24 && facts.F13.value) expect(d.outcome).toBe('FIGHT');
      }),
      { numRuns: 1000 },
    );
  });

  it('an already refunded dispute is never actioned, whatever the claim or facts', () => {
    fc.assert(
      fc.property(claimArb, factsArb, (claim, facts) => {
        const refunded = { ...facts, F11: { ...facts.F11, value: true } };
        const d = decideOutcome(claim, refunded);
        expect(d.outcome).toBe('ALREADY_RESOLVED');
        expect(d.action.type).toBe('none');
      }),
      { numRuns: 300 },
    );
  });

  it('money-moving actions never come from a dispute with under 24 hours left or an unknown deadline', () => {
    fc.assert(
      fc.property(claimArb, factsArb, (claim, facts) => {
        const d = decideOutcome(claim, facts);
        const hours = facts.F12.value;
        if (!facts.F11.value && (hours === null || !Number.isFinite(hours) || hours < 24)) {
          expect(d.outcome).toBe('ESCALATE_TO_HUMAN');
          expect(d.action.type).toBe('alert');
        }
      }),
      { numRuns: 1000 },
    );
  });
});
