import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ManualClock } from '../src/clock';
import { createContainer } from '../src/container';
import { loadConfig } from '../src/config';
import { SCENARIOS } from '../src/lab/scenarios';
import { ScenarioRunner } from '../src/lab/runner';

/** A server that keeps its database across restarts must also keep what its PayPal simulator knows. */

const dir = mkdtempSync(join(tmpdir(), 'warrant-restart-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function session<T>(use: (run: (id: string) => ReturnType<ScenarioRunner['run']>, container: Awaited<ReturnType<typeof createContainer>>) => Promise<T>): Promise<T> {
  // Not the "test" environment, so the database is a real folder and the simulator state is saved, as for `pnpm dev`.
  const config = loadConfig({ NODE_ENV: 'development', DATA_DIR: dir });
  const clock = new ManualClock(Date.UTC(2026, 5, 1, 12, 0, 0));
  const container = await createContainer(config, { clock });
  try {
    const runner = new ScenarioRunner(container, { advanceClock: (s) => clock.advanceSeconds(s) });
    return await use((id) => {
      const scenario = SCENARIOS.find((s) => s.id === id);
      if (scenario === undefined) throw new Error(`no scenario ${id}`);
      return runner.run(scenario);
    }, container);
  } finally {
    await container.close();
  }
}

describe('restarting a server that keeps its data', () => {
  it('does not reuse PayPal ids, and the simulator still knows the earlier order', async () => {
    const first = await session(async (run) => run('remorse-01'));
    expect(first.passed).toBe(true);

    const second = await session(async (run, container) => {
      // The earlier order's payment is still known to "PayPal": its capture can be disputed after the restart.
      const orders = await container.merchant.orders({ status: 'captured' });
      expect(orders.length).toBeGreaterThan(0);
      const again = await run('remorse-01');
      return { again, state: container.paypal.simulator?.state };
    });
    expect(second.again.passed, second.again.failures.join('; ')).toBe(true);
    expect(second.again.actual.orderId).not.toBe(first.actual.orderId);
    expect(second.state?.orders).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it('also copes with a database whose saved simulator state is missing', async () => {
    await session(async (_run, container) => {
      await container.db.query("DELETE FROM settings WHERE key = 'paypal_simulator'");
    });
    const third = await session(async (run) => run('remorse-01'));
    expect(third.passed, third.failures.join('; ')).toBe(true);
  }, 120_000);
});
