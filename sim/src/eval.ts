import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ManualClock, SCENARIOS, ScenarioRunner, createContainer, loadConfig, migrate, openDb, sequentialIds, truncateAll } from '@warrant/server';
import type { Facts } from '@warrant/warrant';
import { buildReport, type EvalRecord } from './metrics';

/**
 * `pnpm eval`: replay the labelled scenario corpus through the real pipeline (wallet, verifier, PayPal simulator, dispute
 * agent) and write `sim/report.json`. Exits 1 if any scenario does not do what its label says.
 *
 *   pnpm eval                       every scenario
 *   pnpm eval --only remorse-01,forge-02
 *   pnpm eval --family forgery
 */

const T0_MS = Date.UTC(2026, 5, 1, 12, 0, 0);
const here = dirname(fileURLToPath(import.meta.url));

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const only = arg('only')?.split(',');
const family = arg('family');
const selected = SCENARIOS.filter((s) => (only === undefined || only.includes(s.id)) && (family === undefined || s.family === family));
if (selected.length === 0) {
  process.stderr.write('No scenario matches.\n');
  process.exit(2);
}

const db = await openDb();
await migrate(db);
const records: EvalRecord[] = [];
const started = Date.now();

for (const scenario of selected) {
  await truncateAll(db);
  const clock = new ManualClock(T0_MS);
  const container = await createContainer(loadConfig({ NODE_ENV: 'test' }), { db, clock, ids: sequentialIds() });
  const runner = new ScenarioRunner(container, { advanceClock: (seconds) => clock.advanceSeconds(seconds) });
  const result = await runner.run(scenario);

  let facts: Facts | null = null;
  let noteSource: string | null = null;
  if (result.actual.disputeId !== null) {
    const detail = await container.disputes.detail(result.actual.disputeId);
    facts = detail.analysis?.facts ?? null;
    noteSource = [...detail.actions].reverse().find((a) => a.status !== 'superseded')?.noteSource ?? null;
  }
  records.push({ scenario, result, facts, noteSource });
  process.stdout.write(`${result.passed ? 'ok  ' : 'FAIL'} ${scenario.id.padEnd(12)} ${scenario.title}\n`);
  for (const failure of result.failures) process.stdout.write(`       ${failure}\n`);
}

const report = buildReport(records, { generatedAt: new Date().toISOString(), paypal: 'simulator', mode: 'fixtures' });
if (only === undefined && family === undefined) {
  const file = resolve(here, '..', 'report.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`\nWrote ${file}\n`);
}

const v = report.verifier;
const d = report.disputes;
const a = report.ablation;
process.stdout.write(
  [
    '',
    `${report.corpus.passed} of ${report.corpus.scenarios} scenarios did what their label says (${((Date.now() - started) / 1000).toFixed(1)} s).`,
    `Verifier: ${v.honest_warrants.accepted}/${v.honest_warrants.total} honest warrants accepted; ${v.adversarial_warrants.refused_by_strict_merchants}/${v.adversarial_warrants.strict_merchant_cases} adversarial warrants refused by strict merchants.`,
    `Disputes: outcome accuracy ${(d.outcome_accuracy * 100).toFixed(1)}% over ${d.total} disputes; ${d.routed_to_a_person.count} (${(d.routed_to_a_person.share * 100).toFixed(0)}%) routed to a person.`,
    `Ablation (warrant facts removed): ${a.decisions_that_change} of ${a.disputes} decisions change; ${a.contestable_cases_lost.lost} of ${a.contestable_cases_lost.of} contestable cases are lost; ${a.agent_platform_fault_attributions_lost.lost} of ${a.agent_platform_fault_attributions_lost.of} agent-platform-fault attributions are lost.`,
    `Latency (webhook to proposed action): median ${report.latency.median_ms} ms, p95 ${report.latency.p95_ms} ms over ${report.latency.samples} disputes.`,
    report.limitation,
    '',
  ].join('\n'),
);

await db.close();
process.exitCode = report.corpus.failed === 0 ? 0 : 1;
