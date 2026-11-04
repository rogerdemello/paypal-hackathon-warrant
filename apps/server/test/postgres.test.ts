import { createServer } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendToChain, verifyStoredChain } from '../src/chain';
import { ManualClock } from '../src/clock';
import { isUniqueViolation, openDb, type Db } from '../src/db';
import { migrate } from '../src/db/migrations';
import { loadServerKeys } from '../src/keys';
import { RegistryService } from '../src/services/registry';
import { T0_MS, testConfig } from './helpers';

/**
 * The deployed path uses node-postgres against a real Postgres. There is none in CI, so this test puts PGlite behind the
 * Postgres wire protocol and drives the same `openDb({ databaseUrl })` code through a real socket.
 */

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address !== null ? address.port : 0));
    });
  });
}

let backing: PGlite;
let socket: PGLiteSocketServer;
let db: Db;

beforeAll(async () => {
  backing = await PGlite.create();
  const port = await freePort();
  socket = new PGLiteSocketServer({ db: backing, port, host: '127.0.0.1' });
  await socket.start();
  db = await openDb({ databaseUrl: `postgres://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable`, poolSize: 1 });
});

afterAll(async () => {
  await db.close();
  await socket.stop();
  await backing.close();
});

describe('node-postgres path', () => {
  it('reports its dialect and runs the migrations', async () => {
    expect(db.dialect).toBe('postgres');
    expect((await migrate(db)).length).toBeGreaterThan(0);
    expect(await migrate(db)).toEqual([]);
  });

  it('returns bigint columns as numbers and jsonb as objects', async () => {
    const [row] = await db.query<{ n: number; doc: { a: number } }>("SELECT 41::bigint + 1 AS n, '{\"a\":1}'::jsonb AS doc");
    expect(row).toEqual({ n: 42, doc: { a: 1 } });
    expect(typeof row?.n).toBe('number');
  });

  it('commits, rolls back and surfaces unique violations', async () => {
    await db.query('CREATE TABLE pg_t (id integer CONSTRAINT pg_t_id UNIQUE)');
    await db.transaction(async (tx) => {
      await tx.query('INSERT INTO pg_t VALUES (1)');
    });
    await expect(
      db.transaction(async (tx) => {
        await tx.query('INSERT INTO pg_t VALUES (2)');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await db.query<{ id: number }>('SELECT id FROM pg_t')).map((r) => r.id)).toEqual([1]);
    const error = await db.query('INSERT INTO pg_t VALUES (1)').catch((e: unknown) => e);
    expect(isUniqueViolation(error, 'pg_t_id')).toBe(true);
    // PGlite's socket server drops the connection after a failed statement (a real Postgres does not); the pool must
    // still recover and serve the next query on a fresh connection.
    await db.query('SELECT 1').catch(() => undefined);
    expect((await db.query<{ ok: number }>('SELECT 1 AS ok'))[0]?.ok).toBe(1);
  });

  it('runs the hash chain and the registry on Postgres', async () => {
    const clock = new ManualClock(T0_MS);
    const keys = loadServerKeys(testConfig());
    const registry = new RegistryService(db, clock, keys.registry);
    await Promise.all([1, 2, 3, 4].map((i) => db.transaction((tx) => appendToChain(tx, 'ledger_entries', { chainId: 'pg', type: 't', payload: { i } }, T0_MS / 1000))));
    expect(await verifyStoredChain(db, 'ledger_entries', 'pg')).toMatchObject({ ok: true, length: 4 });
    const logged = await registry.logWarrant({ cartJti: 'crt_pg', warrantHash: 'sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', mandateHash: 'sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', platform: 'p' });
    expect(logged).toMatchObject({ included: true, seq: 1 });
    expect(await registry.audit()).toMatchObject({ ok: true });
    expect(await registry.inclusionProof('crt_pg')).not.toBeNull();
  });
});
