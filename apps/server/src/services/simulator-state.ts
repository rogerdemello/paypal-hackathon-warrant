import type { PayPalSimulator, SimulatorSnapshot } from '@warrant/paypal';
import { json, maybeOne, type Db } from '../db';

/**
 * Keeps the PayPal simulator's memory in the server's own database, so a restart does not make "PayPal" forget orders it took
 * payment for. Without this, a restarted server would hand out order ids it had already used (the database refuses the
 * duplicate and checkout fails) and the Lab could not raise a dispute on yesterday's order.
 */

const KEY = 'paypal_simulator';

export interface SimulatorState {
  /** Write any pending change now. Call before closing the database. */
  flush(): Promise<void>;
}

export async function attachSimulatorState(db: Db, simulator: PayPalSimulator, options: { delayMs?: number } = {}): Promise<SimulatorState> {
  const delay = options.delayMs ?? 250;
  const row = maybeOne(await db.query<{ value: SimulatorSnapshot }>('SELECT value FROM settings WHERE key = $1', [KEY]));
  let restored = false;
  if (row !== null) {
    try {
      simulator.restore(row.value);
      restored = true;
    } catch {
      // A snapshot this version cannot read is ignored, like none at all.
    }
  }
  if (!restored) {
    // A database from before this was saved (or whose snapshot was lost): start the id counter past every id it could
    // have used. Each order, refund, dispute and webhook event the simulator issued left a row, so their number is enough.
    const rows = await db.query<{ n: number }>('SELECT (SELECT count(*) FROM orders) + (SELECT count(*) FROM refunds) + (SELECT count(*) FROM disputes) + (SELECT count(*) FROM webhook_events) AS n');
    simulator.restore({ version: 1, counter: (rows[0]?.n ?? 0) + 1, orders: [], captures: [], disputes: [] });
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<void> = Promise.resolve();
  const write = (): Promise<void> => {
    writing = writing
      .then(() => db.query("INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [KEY, json(simulator.snapshot())]))
      .then(() => undefined)
      .catch(() => undefined);
    return writing;
  };
  simulator.setChangeListener(() => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void write();
    }, delay);
    timer.unref();
  });

  return {
    flush: async () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
        await write();
      } else {
        await writing;
      }
    },
  };
}
