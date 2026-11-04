import type { Fact, Facts, MerchantMode } from '../src/facts';

/** Hand-built Facts values for testing the outcome table without computing real facts. */
export type FactOverrides = Partial<{
  F1: boolean; F2: boolean; F3: boolean; F4: boolean; F5: boolean; F6: boolean; F7: boolean; F8: boolean;
  F9: boolean; onTime: boolean; F10: boolean; F11: boolean; F12: number | null; F13: boolean;
  merchantMode: MerchantMode; bundleCartMatchesConsent: boolean; orderMatchesBundleCart: boolean;
  /** The consent signature is valid but covers a different cart: F2 is false while the cart and mandate signatures are genuine. */
  consentCoverageGap: boolean;
}>;

const f = (id: string, value: boolean, detail?: Record<string, boolean | string | number | null>): Fact => (detail === undefined ? { id, name: id, value, evidence: [`e:${id}`] } : { id, name: id, value, evidence: [`e:${id}`], detail });

/** A synthetic Facts value where every warrant fact holds, the case is not refunded, and there are 5 days left. */
export function mkFacts(o: FactOverrides = {}): Facts {
  const bundleOk = o.bundleCartMatchesConsent ?? true;
  const orderOk = o.orderMatchesBundleCart ?? true;
  const F5 = o.F5 ?? (bundleOk && orderOk);
  return {
    F1: f('F1', o.F1 ?? true),
    F2: o.consentCoverageGap === true ? f('F2', false, { cart: true, mandate: true, consent: false }) : f('F2', o.F2 ?? true),
    F3: f('F3', o.F3 ?? true),
    F4: f('F4', o.F4 ?? true),
    F5: f('F5', F5, { bundleCartMatchesConsent: bundleOk, orderMatchesBundleCart: orderOk, linesCompared: true }),
    F6: f('F6', o.F6 ?? true),
    F7: f('F7', o.F7 ?? true),
    F8: f('F8', o.F8 ?? true),
    F9: f('F9', o.F9 ?? true, { onTime: o.onTime ?? true }),
    F10: f('F10', o.F10 ?? true),
    F11: f('F11', o.F11 ?? false),
    F12: { id: 'F12', name: 'deadline_hours', value: o.F12 === undefined ? 120 : o.F12, evidence: ['e:F12'] },
    F13: f('F13', o.F13 ?? true),
    context: {
      merchantMode: o.merchantMode ?? 'STRICT',
      disputeId: 'PP-D-1', captureId: 'CAP1', orderId: 'ORDER1', cartJti: 'crt_1', mandateJti: 'mnd_1', mandateHash: null, cartHash: null,
      transparency: null, listings: [],
    },
  };
}
