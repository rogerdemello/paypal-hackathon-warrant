import { decideOutcome, type ClaimType, type Fact, type Facts } from '@warrant/warrant';
import { FAMILY_TITLES, SCENARIO_FAMILIES, type Scenario, type ScenarioResult } from '@warrant/server';

/**
 * Metrics for the scenario corpus (docs/testing.md section 3). Everything here is computed from what the real pipeline did
 * for each scenario; nothing is written by hand. The corpus is authored by us, so these numbers show that the pipeline
 * behaves as designed, not that it wins real disputes.
 */

export interface EvalRecord {
  readonly scenario: Scenario;
  readonly result: ScenarioResult;
  /** The facts F1-F13 of the dispute analysis, when the scenario ended in a dispute. */
  readonly facts: Facts | null;
  /** Where the dispute notes came from (template, model, or a model's text that was rejected). */
  readonly noteSource: string | null;
}

const share = (n: number, of: number): number => (of === 0 ? 1 : Math.round((n / of) * 10_000) / 10_000);

export function perFamily(records: readonly EvalRecord[]) {
  return SCENARIO_FAMILIES.map((family) => {
    const rows = records.filter((r) => r.scenario.family === family);
    return { family, title: FAMILY_TITLES[family], scenarios: rows.length, passed: rows.filter((r) => r.result.passed).length };
  });
}

export function verifierMetrics(records: readonly EvalRecord[]) {
  const honest = records.filter((r) => r.scenario.expect.verifier === 'ACCEPT');
  const adversarial = records.filter((r) => r.scenario.expect.verifier === 'REJECT');
  const strictAdversarial = adversarial.filter((r) => (r.scenario.setup.merchantMode ?? 'STRICT') === 'STRICT');
  const unenforcing = adversarial.filter((r) => (r.scenario.setup.merchantMode ?? 'STRICT') !== 'STRICT');

  const rules = new Map<string, { expected: number; caught: number; unexpected: number }>();
  const entry = (rule: string) => {
    let e = rules.get(rule);
    if (e === undefined) {
      e = { expected: 0, caught: 0, unexpected: 0 };
      rules.set(rule, e);
    }
    return e;
  };
  for (const r of records) {
    const expected = new Set(r.scenario.expect.rejectedRules ?? []);
    const got = new Set(r.result.actual.rejectedRules);
    for (const rule of expected) {
      entry(rule).expected += 1;
      if (got.has(rule)) entry(rule).caught += 1;
    }
    if (r.scenario.expect.rejectedRules !== undefined) for (const rule of got) if (!expected.has(rule)) entry(rule).unexpected += 1;
  }

  return {
    honest_warrants: { total: honest.length, accepted: honest.filter((r) => r.result.actual.verifier === 'ACCEPT').length, share: share(honest.filter((r) => r.result.actual.verifier === 'ACCEPT').length, honest.length) },
    adversarial_warrants: {
      total: adversarial.length,
      flagged_by_the_rules: adversarial.filter((r) => r.result.actual.verifier === 'REJECT').length,
      refused_by_strict_merchants: strictAdversarial.filter((r) => !r.result.actual.sold).length,
      strict_merchant_cases: strictAdversarial.length,
      sold_by_merchants_that_do_not_enforce: unenforcing.filter((r) => r.result.actual.sold).length,
      non_enforcing_cases: unenforcing.length,
      share_refused_by_strict_merchants: share(strictAdversarial.filter((r) => !r.result.actual.sold).length, strictAdversarial.length),
    },
    by_rule: Object.fromEntries([...rules.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([rule, e]) => [rule, { ...e, share_caught: share(e.caught, e.expected) }])),
  };
}

export function disputeMetrics(records: readonly EvalRecord[]) {
  const disputes = records.filter((r) => r.scenario.expect.dispute !== undefined);
  const correct = (r: EvalRecord): boolean => {
    const d = r.scenario.expect.dispute;
    return d !== undefined && r.result.actual.outcome === d.outcome && r.result.actual.rule === d.rule && r.result.actual.action === d.action;
  };
  const byClaim = new Map<string, { total: number; correct: number }>();
  const byOutcome = new Map<string, number>();
  for (const r of disputes) {
    const claim = r.scenario.expect.dispute?.claim ?? 'OTHER';
    const e = byClaim.get(claim) ?? { total: 0, correct: 0 };
    e.total += 1;
    if (correct(r)) e.correct += 1;
    byClaim.set(claim, e);
    const outcome = r.result.actual.outcome ?? 'none';
    byOutcome.set(outcome, (byOutcome.get(outcome) ?? 0) + 1);
  }
  const human = disputes.filter((r) => r.result.actual.outcome === 'ESCALATE_TO_HUMAN').length;
  return {
    total: disputes.length,
    outcome_accuracy: share(disputes.filter(correct).length, disputes.length),
    by_claim: Object.fromEntries([...byClaim.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([claim, e]) => [claim, { ...e, accuracy: share(e.correct, e.total) }])),
    by_outcome: Object.fromEntries([...byOutcome.entries()].sort(([a], [b]) => a.localeCompare(b))),
    routed_to_a_person: { count: human, share: share(human, disputes.length) },
    proposed_action: Object.fromEntries(
      [...disputes.reduce((m, r) => m.set(r.result.actual.action ?? 'none', (m.get(r.result.actual.action ?? 'none') ?? 0) + 1), new Map<string, number>()).entries()].sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
}

export function evidenceMetrics(records: readonly EvalRecord[]) {
  const withNotes = records.filter((r) => r.noteSource !== null);
  const count = (source: string) => withNotes.filter((r) => r.noteSource === source).length;
  const modelTried = withNotes.filter((r) => r.noteSource === 'model' || r.noteSource === 'template (model output rejected)');
  return {
    drafts: withNotes.length,
    from_template: count('template'),
    model_drafts: modelTried.length,
    model_drafts_accepted_first_try: count('model'),
    model_drafts_rejected_for_invented_facts: count('template (model output rejected)'),
    note:
      'Template notes are built from the case record, so they cannot contain a fact the record lacks. The model-draft counts come from the scenarios that plant a model ' +
      'that invents facts (inject-06) or sticks to the record (inject-07); run with ANTHROPIC_API_KEY for real-model numbers.',
  };
}

/** Only what PayPal and the merchant's own records say survives: the warrant-derived facts are removed. */
export function withoutWarrant(facts: Facts): Facts {
  const off = (f: Fact): Fact => ({ ...f, value: false, evidence: ['removed for the ablation: no warrant facts'] });
  return {
    ...facts,
    F1: off(facts.F1),
    F2: off(facts.F2),
    F3: off(facts.F3),
    F4: off(facts.F4),
    F5: { ...off(facts.F5), detail: { bundleCartMatchesConsent: false, orderMatchesBundleCart: false, linesCompared: false } },
    F6: off(facts.F6),
    F7: off(facts.F7),
    F8: off(facts.F8),
    F10: off(facts.F10),
  };
}

export function ablation(records: readonly EvalRecord[]) {
  const rows = records.filter((r) => r.facts !== null && r.result.actual.claim !== null);
  const moves = new Map<string, number>();
  let lostFights = 0;
  let lostAgentFault = 0;
  let fights = 0;
  let agentFault = 0;
  let sameDecision = 0;
  const detail = rows.map((r) => {
    const claim = r.result.actual.claim as ClaimType;
    const without = decideOutcome(claim, withoutWarrant(r.facts as Facts));
    const withOutcome = r.result.actual.outcome ?? 'none';
    moves.set(`${withOutcome} -> ${without.outcome}`, (moves.get(`${withOutcome} -> ${without.outcome}`) ?? 0) + 1);
    if (without.outcome === withOutcome) sameDecision += 1;
    if (withOutcome === 'FIGHT') {
      fights += 1;
      if (without.outcome !== 'FIGHT') lostFights += 1;
    }
    if (r.result.actual.attribution?.agent_platform === 'primary') {
      agentFault += 1;
      if (without.attribution.agent_platform !== 'primary') lostAgentFault += 1;
    }
    return { id: r.scenario.id, with_warrant: withOutcome, without_warrant: without.outcome };
  });
  return {
    description:
      'The same disputes decided by the same outcome table, but with every fact derived from the signed warrant removed (F1-F8 and F10), so only what PayPal and the merchant already ' +
      'know (delivery, refunds, deadline, amount) is left. This shows what the proof adds; it is not a measurement of any language model.',
    disputes: rows.length,
    decisions_unchanged_without_the_warrant: sameDecision,
    decisions_that_change: rows.length - sameDecision,
    contestable_cases_lost: { of: fights, lost: lostFights },
    agent_platform_fault_attributions_lost: { of: agentFault, lost: lostAgentFault },
    moves: Object.fromEntries([...moves.entries()].sort(([a], [b]) => a.localeCompare(b))),
    detail,
  };
}

export function latencyMetrics(records: readonly EvalRecord[]) {
  const values = records.flatMap((r) => (r.result.latencyMs === null ? [] : [r.result.latencyMs])).sort((a, b) => a - b);
  if (values.length === 0) return { samples: 0, median_ms: null, p95_ms: null, max_ms: null };
  const at = (p: number) => values[Math.min(values.length - 1, Math.floor(p * values.length))] ?? 0;
  return { samples: values.length, median_ms: at(0.5), p95_ms: at(0.95), max_ms: values[values.length - 1] ?? 0 };
}

export const LIMITATION =
  'The corpus is authored by us, so these results show that the pipeline behaves as designed. They are not a measurement of real-world dispute win rates, and the PayPal simulator is not PayPal.';

export function buildReport(records: readonly EvalRecord[], meta: { generatedAt: string; paypal: string; mode: string }) {
  const failed = records.filter((r) => !r.result.passed);
  return {
    generated_at: meta.generatedAt,
    environment: { paypal: meta.paypal, mode: meta.mode, note: 'Run with fixed time and sequential ids; no model calls.' },
    limitation: LIMITATION,
    corpus: { scenarios: records.length, passed: records.length - failed.length, failed: failed.length, families: perFamily(records) },
    verifier: verifierMetrics(records),
    disputes: disputeMetrics(records),
    evidence_notes: evidenceMetrics(records),
    ablation: ablation(records),
    latency: latencyMetrics(records),
    failures: failed.map((r) => ({ id: r.scenario.id, failures: r.result.failures })),
    scenarios: records.map((r) => ({
      id: r.scenario.id,
      family: r.scenario.family,
      title: r.scenario.title,
      passed: r.result.passed,
      verifier: r.result.actual.verifier,
      rejected_rules: r.result.actual.rejectedRules,
      sold: r.result.actual.sold,
      payment: r.result.actual.payment,
      claim: r.result.actual.claim,
      outcome: r.result.actual.outcome,
      rule: r.result.actual.rule,
      action: r.result.actual.action,
    })),
  };
}
