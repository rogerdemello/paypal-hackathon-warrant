import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock, sequentialIds } from '../src/clock';
import { createContainer, type Container } from '../src/container';
import { ScenarioRunner } from '../src/lab/runner';
import { SCENARIOS, SCENARIO_COUNT, scenarioById } from '../src/lab/scenarios';
import { FAMILY_TITLES, SCENARIO_FAMILIES } from '../src/lab/scenario';
import { resetDb, sharedDb, T0_MS, testConfig } from './helpers';

let c: Container | null = null;
afterEach(async () => {
  await c?.close();
  c = null;
});

async function run(id: string) {
  const db = await sharedDb();
  await resetDb(db);
  const clock = new ManualClock(T0_MS);
  c = await createContainer(testConfig(), { db, clock, ids: sequentialIds() });
  const scenario = scenarioById(id);
  if (scenario === undefined) throw new Error(`no scenario ${id}`);
  return new ScenarioRunner(c, { advanceClock: (s) => clock.advanceSeconds(s) }).run(scenario);
}

describe('the scenario corpus', () => {
  it('has at least 60 scenarios, every family covered to its minimum, and unique ids', () => {
    expect(SCENARIO_COUNT).toBeGreaterThanOrEqual(60);
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
    const minimum: Record<string, number> = { remorse: 8, cart_swap: 8, scope_stretch: 8, forgery: 8, replay_audience: 6, key_time: 6, payer_mismatch: 4, merchant_fault: 10, injection: 8, permissive: 6, consent_reuse: 6, budget_stretch: 6 };
    for (const family of SCENARIO_FAMILIES) {
      expect(SCENARIOS.filter((s) => s.family === family).length, family).toBeGreaterThanOrEqual(minimum[family] ?? 0);
      expect(FAMILY_TITLES[family].length).toBeGreaterThan(5);
    }
  });

  // One test per scenario, so a failure names the scenario and says what differed.
  for (const scenario of SCENARIOS) {
    it(`${scenario.id}: ${scenario.title}`, async () => {
      const result = await run(scenario.id);
      expect(result.failures, `${scenario.id}\n${JSON.stringify(result.actual, null, 1)}\n${result.steps.map((s) => `${s.name}: ${s.detail}`).join('\n')}`).toEqual([]);
      expect(result.passed).toBe(true);
    });
  }
});

describe('the runner', () => {
  it('leaves the merchant in the mode it found, whatever the scenario did', async () => {
    const result = await run('perm-02');
    expect(result.passed).toBe(true);
    expect(await c!.store.merchantMode()).toBe('STRICT');
  });

  it('reports a scenario that needs the simulator when there is none, instead of failing opaquely', async () => {
    const db = await sharedDb();
    await resetDb(db);
    c = await createContainer(testConfig(), { db, clock: new ManualClock(T0_MS), ids: sequentialIds() });
    const runner = new ScenarioRunner({ ...c, paypal: { ...c.paypal, simulator: null } });
    const result = await runner.run(scenarioById('remorse-01')!);
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toMatch(/needs the PayPal simulator/);
  });

  it('runs requests one at a time', async () => {
    const db = await sharedDb();
    await resetDb(db);
    c = await createContainer(testConfig(), { db, clock: new ManualClock(T0_MS), ids: sequentialIds() });
    const runner = new ScenarioRunner(c);
    const results = await Promise.all(['payer-03', 'payer-04', 'key-06'].map((id) => runner.run(scenarioById(id)!)));
    expect(results.map((r) => r.passed)).toEqual([true, true, true]);
  });

  it('reports an expectation that does not hold, with what happened instead', async () => {
    const db = await sharedDb();
    await resetDb(db);
    c = await createContainer(testConfig(), { db, clock: new ManualClock(T0_MS), ids: sequentialIds() });
    const wrong = { ...scenarioById('forge-01')!, expect: { verifier: 'ACCEPT' as const, sold: true } };
    const result = await new ScenarioRunner(c).run(wrong);
    expect(result.passed).toBe(false);
    expect(result.failures.join(' ')).toMatch(/verifier outcome: expected "ACCEPT", got "REJECT"/);
    expect(result.actual.rejectedRules).toContain('V01_SIGNATURE');
  });
});
