import { afterAll } from 'vitest';
import { loadConfig, type Config } from '../src/config';
import { ManualClock, sequentialIds, type Ids } from '../src/clock';
import { openDb, type Db } from '../src/db';
import { migrate } from '../src/db/migrations';
import { loadServerKeys, type ServerKeys } from '../src/keys';
import { RegistryService } from '../src/services/registry';

/** 2026-06-01T12:00:00Z: a fixed "now" for every server test. */
export const T0_MS = Date.UTC(2026, 5, 1, 12, 0, 0);

export interface TestWorld {
  readonly db: Db;
  readonly clock: ManualClock;
  readonly ids: Ids;
  readonly config: Config;
  readonly keys: ServerKeys;
  readonly registry: RegistryService;
  close(): Promise<void>;
}

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({ NODE_ENV: 'test', ...env });
}

// Starting and migrating an embedded Postgres takes seconds, so each test file does it once and every test starts from
// emptied tables instead.
let shared: Promise<Db> | null = null;

export async function sharedDb(): Promise<Db> {
  shared ??= (async () => {
    const db = await openDb();
    await migrate(db);
    return db;
  })();
  return shared;
}

afterAll(async () => {
  if (shared !== null) {
    const db = await shared;
    shared = null;
    await db.close();
  }
});

/** Remove every row from every application table (the schema and migration history stay). */
export async function resetDb(db: Db): Promise<void> {
  const tables = (await db.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name <> 'schema_migrations'")).map((r) => r.table_name);
  if (tables.length > 0) await db.query(`TRUNCATE ${tables.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
}

/** A migrated, emptied database with a manual clock, sequential ids and ephemeral keys. */
export async function makeServerWorld(env: Record<string, string> = {}): Promise<TestWorld> {
  const db = await sharedDb();
  await resetDb(db);
  const clock = new ManualClock(T0_MS);
  const config = testConfig(env);
  const keys = loadServerKeys(config);
  const registry = new RegistryService(db, clock, keys.registry);
  return { db, clock, ids: sequentialIds(), config, keys, registry, close: () => Promise.resolve() };
}
