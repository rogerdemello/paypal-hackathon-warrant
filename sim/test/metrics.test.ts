import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SCENARIOS, type Scenario, type ScenarioResult } from '@warrant/server';
import { decideOutcome, type Fact, type Facts } from '@warrant/warrant';
import { describe, expect, it } from 'vitest';
import { ablation, buildReport, disputeMetrics, evidenceMetrics, latencyMetrics, perFamily, verifierMetrics, withoutWarrant, type EvalRecord } from '../src/metrics';

const fact = (id: string, value: boolean, detail?: Record<string, boolean>): Fact => (detail === undefined ? { id, name: id, value, evidence: [`e:${id}`] } : { id, name: id, value, evidence: [`e:${id}`], detail });
const facts = (over: Partial<Record<string, boolean>> = {}): Facts => ({
  F1: fact('F1', over['F1'] ?? true),
  F2: fact('F2', over['F2'] ?? true),
  F3: fact('F3', over['F3'] ?? true),
  F4: fact('F4', over['F4'] ?? true),
  F5: fact('F5', over['F5'] ?? true, { bundleCartMatchesConsent: true, orderMatchesBundleCart: true }),
  F6: fact('F6', over['F6'] ?? true),
  F7: fact('F7', over['F7'] ?? true),
  F8: fact('F8', over['F8'] ?? true),
  F9: fact('F9', over['F9'] ?? true, { onTime: true }),
  F10: fact('F10', over['F10'] ?? true),
  F11: fact('F11', false),
  F12: { id: 'F12', name: 'F12', value: 120, evidence: [] },
  F13: fact('F13', true),
  context: { merchantMode: 'STRICT', disputeId: 'PP-D-1', captureId: 'C', orderId: 'O', cartJti: 'crt', mandateJti: 'mdt', mandateHash: null, cartHash: null, transparency: null, listings: [] },
});

const scenario = (id: string, over: Partial<Scenario> = {}): Scenario => ({ id, family: 'remorse', title: id, story: '', setup: {}, expect: { verifier: 'ACCEPT', sold: true }, ...over });
const result = (id: string, over: Partial<ScenarioResult['actual']> = {}, passed = true, latencyMs: number | null = null): ScenarioResult => ({
  id,
  family: 'remorse',
  title: id,
  passed,
  failures: passed ? [] : ['it did not'],
  steps: [],
  actual: { verifier: 'ACCEPT', rejectedRules: [], sold: true, payment: null, orderId: null, cartJti: null, disputeId: null, claim: null, outcome: null, rule: null, action: null, attribution: null, flags: [], confidence: null, state: null, noteSource: null, ...over },
  latencyMs,
  durationMs: 1,
});
const record = (s: Scenario, r: ScenarioResult, f: Facts | null = null, noteSource: string | null = null): EvalRecord => ({ scenario: s, result: r, facts: f, noteSource });

describe('verifier metrics', () => {
  const adversarial = (id: string, rules: string[], mode: 'STRICT' | 'PERMISSIVE' = 'STRICT') =>
    scenario(id, { setup: { merchantMode: mode }, expect: { verifier: 'REJECT', rejectedRules: rules, sold: mode !== 'STRICT' } });

  it('counts honest warrants accepted and adversarial ones refused, separately for merchants that do not enforce', () => {
    const records = [
      record(scenario('h1'), result('h1')),
      record(scenario('h2'), result('h2', { verifier: 'REVIEW' })),
      record(adversarial('a1', ['V01_SIGNATURE']), result('a1', { verifier: 'REJECT', rejectedRules: ['V01_SIGNATURE'], sold: false })),
      record(adversarial('a2', ['V05_NONCE']), result('a2', { verifier: 'REJECT', rejectedRules: ['V05_NONCE'], sold: true })),
      record(adversarial('a3', ['V01_SIGNATURE'], 'PERMISSIVE'), result('a3', { verifier: 'REJECT', rejectedRules: ['V01_SIGNATURE'], sold: true })),
    ];
    const m = verifierMetrics(records);
    expect(m.honest_warrants).toEqual({ total: 2, accepted: 1, share: 0.5 });
    expect(m.adversarial_warrants).toMatchObject({ total: 3, flagged_by_the_rules: 3, refused_by_strict_merchants: 1, strict_merchant_cases: 2, sold_by_merchants_that_do_not_enforce: 1, non_enforcing_cases: 1, share_refused_by_strict_merchants: 0.5 });
  });

  it('reports each rule\'s catch rate and rules that fired when nobody expected them', () => {
    const records = [
      record(scenario('a1', { expect: { verifier: 'REJECT', rejectedRules: ['V01_SIGNATURE'], sold: false } }), result('a1', { verifier: 'REJECT', rejectedRules: ['V01_SIGNATURE', 'V09_SCOPE'], sold: false })),
      record(scenario('a2', { expect: { verifier: 'REJECT', rejectedRules: ['V01_SIGNATURE'], sold: false } }), result('a2', { verifier: 'REJECT', rejectedRules: [], sold: false })),
    ];
    expect(verifierMetrics(records).by_rule).toEqual({
      V01_SIGNATURE: { expected: 2, caught: 1, unexpected: 0, share_caught: 0.5 },
      V09_SCOPE: { expected: 0, caught: 0, unexpected: 1, share_caught: 1 },
    });
  });

  it('is not undefined on an empty corpus', () => {
    expect(verifierMetrics([]).honest_warrants.share).toBe(1);
  });
});

describe('dispute metrics', () => {
  const dispute = (id: string, claim: 'UNAUTHORIZED' | 'NOT_RECEIVED', outcome: string, rule: string, action: string) =>
    scenario(id, { expect: { verifier: 'ACCEPT', sold: true, dispute: { claim, outcome: outcome as 'FIGHT', rule, action: action as 'alert' } } });
  const done = (id: string, outcome: string, rule: string, action: string, claim = 'UNAUTHORIZED') => result(id, { claim: claim as 'UNAUTHORIZED', outcome: outcome as 'FIGHT', rule, action: action as 'alert' });

  it('scores outcome, rule and action together, by claim, and counts what went to a person', () => {
    const records = [
      record(dispute('d1', 'UNAUTHORIZED', 'FIGHT', 'R1', 'provide-evidence'), done('d1', 'FIGHT', 'R1', 'provide-evidence')),
      record(dispute('d2', 'UNAUTHORIZED', 'ESCALATE_TO_HUMAN', 'R2', 'alert'), done('d2', 'ESCALATE_TO_HUMAN', 'R2', 'alert')),
      record(dispute('d3', 'NOT_RECEIVED', 'FIGHT', 'R3', 'provide-evidence'), done('d3', 'FIGHT', 'WRONG_RULE', 'provide-evidence', 'NOT_RECEIVED')),
      record(scenario('plain'), result('plain')),
    ];
    const m = disputeMetrics(records);
    expect(m.total).toBe(3);
    expect(m.outcome_accuracy).toBeCloseTo(0.6667, 4);
    expect(m.by_claim).toEqual({ NOT_RECEIVED: { total: 1, correct: 0, accuracy: 0 }, UNAUTHORIZED: { total: 2, correct: 2, accuracy: 1 } });
    expect(m.by_outcome).toEqual({ ESCALATE_TO_HUMAN: 1, FIGHT: 2 });
    expect(m.routed_to_a_person).toEqual({ count: 1, share: 0.3333 });
    expect(m.proposed_action).toEqual({ alert: 1, 'provide-evidence': 2 });
  });
});

describe('evidence note metrics', () => {
  it('separates template notes from model drafts that were accepted or rejected', () => {
    const r = (source: string | null) => record(scenario(`n-${String(source)}`), result('n'), null, source);
    const m = evidenceMetrics([r('template'), r('template'), r('model'), r('template (model output rejected)'), r(null)]);
    expect(m).toMatchObject({ drafts: 4, from_template: 2, model_drafts: 2, model_drafts_accepted_first_try: 1, model_drafts_rejected_for_invented_facts: 1 });
  });
});

describe('the ablation', () => {
  it('removes only the warrant facts and keeps what PayPal knows', () => {
    const f = facts();
    const g = withoutWarrant(f);
    for (const id of ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F10'] as const) expect(g[id].value).toBe(false);
    for (const id of ['F9', 'F11', 'F12', 'F13'] as const) expect(g[id]).toEqual(f[id]);
    expect(g.F5.detail).toMatchObject({ bundleCartMatchesConsent: false, orderMatchesBundleCart: false });
  });

  it('shows a contestable dispute turning into an accept, and an agent-fault attribution disappearing', () => {
    const fight = record(scenario('fight'), result('fight', { claim: 'UNAUTHORIZED', outcome: 'FIGHT', attribution: { agent_platform: 'none', merchant: 'none', principal: 'primary' } }), facts());
    const swapFacts = facts({ F2: false });
    const swapDecision = decideOutcome('UNAUTHORIZED', { ...swapFacts, F2: fact('F2', false, { cart: true, mandate: true, consent: false }), F5: fact('F5', false, { bundleCartMatchesConsent: false, orderMatchesBundleCart: true }) });
    expect(swapDecision.outcome).toBe('ACCEPT_AGENT_FAULT');
    const fault = record(scenario('fault'), result('fault', { claim: 'UNAUTHORIZED', outcome: swapDecision.outcome, attribution: swapDecision.attribution }), swapFacts);
    const notAffected = record(scenario('late'), result('late', { claim: 'NOT_RECEIVED', outcome: 'FIGHT', attribution: { agent_platform: 'none', merchant: 'none', principal: 'none' } }), facts());
    const a = ablation([fight, fault, notAffected, record(scenario('no-dispute'), result('x'))]);
    expect(a.disputes).toBe(3);
    expect(a.contestable_cases_lost).toEqual({ of: 2, lost: 1 });
    expect(a.agent_platform_fault_attributions_lost).toEqual({ of: 1, lost: 1 });
    expect(a.moves['FIGHT -> NO_PROOF']).toBe(1);
    expect(a.decisions_unchanged_without_the_warrant + a.decisions_that_change).toBe(3);
    expect(a.detail.find((d) => d.id === 'late')).toMatchObject({ with_warrant: 'FIGHT', without_warrant: 'FIGHT' });
  });
});

describe('latency and the report', () => {
  it('computes median, p95 and max from the samples that exist', () => {
    const rs = [10, 20, 30, 40, 100].map((ms, i) => record(scenario(`l${i}`), result(`l${i}`, {}, true, ms)));
    expect(latencyMetrics([...rs, record(scenario('none'), result('none'))])).toEqual({ samples: 5, median_ms: 30, p95_ms: 100, max_ms: 100 });
    expect(latencyMetrics([])).toEqual({ samples: 0, median_ms: null, p95_ms: null, max_ms: null });
  });

  it('assembles a report that states its limitation and lists failures', () => {
    const report = buildReport([record(scenario('ok'), result('ok')), record(scenario('bad'), result('bad', {}, false))], { generatedAt: '2026-06-01T12:00:00Z', paypal: 'simulator', mode: 'fixtures' });
    expect(report.corpus).toMatchObject({ scenarios: 2, passed: 1, failed: 1 });
    expect(report.failures).toEqual([{ id: 'bad', failures: ['it did not'] }]);
    expect(report.limitation).toMatch(/authored by us/);
    expect(report.limitation).toMatch(/not a measurement of real-world dispute win rates/);
    expect(perFamily([record(scenario('ok'), result('ok'))]).find((f) => f.family === 'remorse')).toMatchObject({ scenarios: 1, passed: 1 });
  });
});

describe('the committed report', () => {
  it('covers exactly the scenarios in the corpus, and they all passed', () => {
    const report = JSON.parse(readFileSync(resolve(__dirname, '..', 'report.json'), 'utf8')) as { corpus: { scenarios: number; failed: number }; scenarios: Array<{ id: string; passed: boolean }> };
    expect(report.scenarios.map((s) => s.id)).toEqual(SCENARIOS.map((s) => s.id));
    expect(report.corpus.scenarios).toBe(SCENARIOS.length);
    expect(report.corpus.failed).toBe(0);
    expect(report.scenarios.every((s) => s.passed)).toBe(true);
    expect(report.corpus.scenarios).toBeGreaterThanOrEqual(60);
  });
});
