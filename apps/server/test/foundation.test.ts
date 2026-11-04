import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSigningKey } from '@warrant/warrant';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';
import { ManualClock, nowSeconds, sequentialIds, systemClock, ulidIds } from '../src/clock';
import { DbError, isUniqueViolation, json, maybeOne, one, openDb, sslOptionFor } from '../src/db';
import { MIGRATIONS, migrate } from '../src/db/migrations';
import { keyMaterial, loadServerKeys } from '../src/keys';
import { testConfig } from './helpers';

describe('config', () => {
  it('starts with no variables at all: fixtures mode, simulator PayPal, development defaults', () => {
    const c = loadConfig({});
    expect(c.mode).toBe('fixtures');
    expect(c.paypal.env).toBe('simulator');
    expect(c.paypal.merchantId).toBe('SIMMERCHANT01');
    expect(c.port).toBe(8787);
    expect(c.host).toBe('127.0.0.1');
    expect(c.publicBaseUrl).toBe('http://localhost:8787');
    expect(c.judgeModeEnabled).toBe(true);
    expect(c.disputeAutopilot).toBe(false);
  });

  it('picks sandbox when a PayPal client id is present, and then requires the rest', () => {
    expect(() => loadConfig({ PAYPAL_CLIENT_ID: 'abc' })).toThrow(ConfigError);
    try {
      loadConfig({ PAYPAL_CLIENT_ID: 'abc' });
    } catch (error) {
      const problems = (error as ConfigError).problems.join('\n');
      expect(problems).toContain('PAYPAL_CLIENT_SECRET');
      expect(problems).toContain('PAYPAL_WEBHOOK_ID');
      expect(problems).toContain('PAYPAL_MERCHANT_ID');
    }
    const c = loadConfig({ PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 's', PAYPAL_WEBHOOK_ID: 'w', PAYPAL_MERCHANT_ID: 'M1' });
    expect(c.paypal).toMatchObject({ env: 'sandbox', merchantId: 'M1' });
  });

  it('refuses production PayPal and unknown environments', () => {
    expect(() => loadConfig({ PAYPAL_ENV: 'production' })).toThrow(/sandbox only/);
    expect(() => loadConfig({ PAYPAL_ENV: 'live' })).toThrow(/sandbox only/);
    expect(() => loadConfig({ PAYPAL_ENV: 'staging' })).toThrow(/must be "sandbox" or "simulator"/);
  });

  it('requires API keys for live mode', () => {
    expect(() => loadConfig({ WARRANT_MODE: 'live' })).toThrow(/ANTHROPIC_API_KEY[\s\S]*CHANNEL3_API_KEY/);
    expect(loadConfig({ WARRANT_MODE: 'live', ANTHROPIC_API_KEY: 'a', CHANNEL3_API_KEY: 'c' }).mode).toBe('live');
  });

  it('requires real keys, a database and a public URL in production', () => {
    try {
      loadConfig({ NODE_ENV: 'production' });
      expect.unreachable();
    } catch (error) {
      const text = (error as ConfigError).message;
      for (const name of ['WALLET_SIGNING_KEY', 'AGENT_PLATFORM_SIGNING_KEY', 'REGISTRY_LOG_KEY', 'DATABASE_URL', 'PUBLIC_BASE_URL']) expect(text).toContain(name);
    }
    const key = generateSigningKey().privateKeyBase64;
    const c = loadConfig({
      NODE_ENV: 'production',
      WALLET_SIGNING_KEY: key,
      AGENT_PLATFORM_SIGNING_KEY: key,
      REGISTRY_LOG_KEY: key,
      DATABASE_URL: 'postgres://u:p@db/x',
      PUBLIC_BASE_URL: 'https://warrant.example.com/',
    });
    expect(c.publicBaseUrl).toBe('https://warrant.example.com');
    expect(c.host).toBe('0.0.0.0');
    expect(c.databaseUrl).toBe('postgres://u:p@db/x');
    // One server serves the API and the built web app, so the app is at the public address unless told otherwise.
    expect(c.webOrigin).toBe('https://warrant.example.com');
    expect(loadConfig({}).webOrigin).toBe('http://localhost:5173');
    // Render tells every web service its own public address, which is used when PUBLIC_BASE_URL is not set.
    const onRender = { NODE_ENV: 'production', WALLET_SIGNING_KEY: key, AGENT_PLATFORM_SIGNING_KEY: key, REGISTRY_LOG_KEY: key, DATABASE_URL: 'postgres://u:p@db/x' };
    expect(loadConfig({ ...onRender, RENDER_EXTERNAL_URL: 'https://warrant.onrender.com' }).publicBaseUrl).toBe('https://warrant.onrender.com');
    expect(loadConfig({ ...onRender, RENDER_EXTERNAL_URL: 'https://warrant.onrender.com', PUBLIC_BASE_URL: 'https://demo.example.com' }).publicBaseUrl).toBe('https://demo.example.com');
  });

  it('rejects malformed values and treats blank variables as unset', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(ConfigError);
    expect(() => loadConfig({ PORT: '70000' })).toThrow(ConfigError);
    expect(() => loadConfig({ WARRANT_MODE: 'turbo' })).toThrow(ConfigError);
    const c = loadConfig({ PAYPAL_CLIENT_ID: '  ', ANTHROPIC_API_KEY: '', PORT: '9000', DISPUTE_AUTOPILOT: 'TRUE', JUDGE_MODE_ENABLED: 'false', CONSOLE_TOKEN: ' secret-token ', WEB_ORIGIN: 'http://x.test/' });
    expect(c.paypal.env).toBe('simulator');
    expect(c.anthropic.apiKey).toBeNull();
    expect(c.port).toBe(9000);
    expect(c.disputeAutopilot).toBe(true);
    expect(c.judgeModeEnabled).toBe(false);
    expect(c.consoleToken).toBe('secret-token');
    expect(c.webOrigin).toBe('http://x.test');
  });

  it('a console with judge mode off needs a token', () => {
    expect(() => loadConfig({ JUDGE_MODE_ENABLED: 'false' })).toThrow(/CONSOLE_TOKEN is required/);
    expect(loadConfig({}).consoleToken).toBeNull();
  });

  it('never puts secrets in error messages', () => {
    try {
      loadConfig({ PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'super-secret-value' });
    } catch (error) {
      expect((error as Error).message).not.toContain('super-secret-value');
    }
  });
});

describe('Postgres TLS', () => {
  it('uses no TLS for a database on this machine or a private network, and TLS for one across the internet', () => {
    for (const host of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.9', '172.20.0.2', 'db', 'dpg-abc123-a']) {
      expect(sslOptionFor(`postgres://u:p@${host}:5432/x`), host).toBeUndefined();
    }
    for (const host of ['dpg-abc123-a.oregon-postgres.render.com', 'db.example.com', '34.1.2.3', '172.32.0.1']) {
      expect(sslOptionFor(`postgres://u:p@${host}/x`), host).toEqual({ rejectUnauthorized: false });
    }
  });

  it('lets an explicit sslmode decide', () => {
    expect(sslOptionFor('postgres://u:p@db.example.com/x?sslmode=disable')).toBeUndefined();
    expect(sslOptionFor('postgres://u:p@db/x?sslmode=require')).toEqual({ rejectUnauthorized: false });
    expect(sslOptionFor('postgres://u:p@db/x?application_name=w&sslmode=verify-full')).toEqual({ rejectUnauthorized: true });
    expect(sslOptionFor('postgres://u:p@db/x?sslmode=VERIFY-CA')).toEqual({ rejectUnauthorized: true });
  });

  it('does not crash on a string that is not a URL', () => {
    expect(sslOptionFor('not a url')).toBeUndefined();
  });
});

describe('clock and ids', () => {
  it('system clock tracks real time and a manual clock moves on demand', () => {
    expect(Math.abs(systemClock.nowMs() - Date.now())).toBeLessThan(1000);
    const c = new ManualClock(5_000);
    expect(nowSeconds(c)).toBe(5);
    c.advanceSeconds(10);
    expect(c.nowMs()).toBe(15_000);
    c.set(0);
    expect(c.nowMs()).toBe(0);
  });

  it('ulid ids are prefixed, sortable by time and unique', () => {
    const clock = new ManualClock(1_700_000_000_000);
    const ids = ulidIds(clock);
    const a = ids.next('crt');
    clock.advanceSeconds(1);
    const b = ids.next('crt');
    expect(a).toMatch(/^crt_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b).toBe(true);
    expect(new Set(Array.from({ length: 200 }, () => ids.next('x'))).size).toBe(200);
    expect(ids.token()).toMatch(/^[0-9a-f]{24}$/);
    expect(ids.token(4)).toMatch(/^[0-9a-f]{8}$/);
  });

  it('sequential ids are deterministic', () => {
    const ids = sequentialIds();
    expect(ids.next('ord')).toBe('ord_00000001');
    expect(ids.next('ord')).toBe('ord_00000002');
    expect(ids.token()).toBe('tok00000003');
  });
});

describe('database', () => {
  const opened: { close(): Promise<void> }[] = [];
  afterEach(async () => {
    for (const d of opened.splice(0)) await d.close();
  });

  it('opens an in-memory database and runs queries with parameters and jsonb', async () => {
    const db = await openDb();
    opened.push(db);
    expect(db.dialect).toBe('pglite');
    await db.query('CREATE TABLE t (id integer PRIMARY KEY, doc jsonb, n bigint)');
    await db.query('INSERT INTO t VALUES ($1, $2::jsonb, $3)', [1, json({ a: [1, 2] }), 42]);
    const rows = await db.query<{ id: number; doc: { a: number[] }; n: number }>('SELECT * FROM t');
    expect(rows).toEqual([{ id: 1, doc: { a: [1, 2] }, n: 42 }]);
    expect(typeof rows[0]?.n).toBe('number');
  });

  it('commits a transaction and rolls it back on error', async () => {
    const db = await openDb();
    opened.push(db);
    await db.query('CREATE TABLE t (id integer PRIMARY KEY)');
    await db.transaction(async (tx) => {
      await tx.query('INSERT INTO t VALUES (1)');
    });
    await expect(
      db.transaction(async (tx) => {
        await tx.query('INSERT INTO t VALUES (2)');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await db.query<{ id: number }>('SELECT id FROM t')).map((r) => r.id)).toEqual([1]);
  });

  it('recognises unique violations', async () => {
    const db = await openDb();
    opened.push(db);
    await db.query('CREATE TABLE t (id integer CONSTRAINT t_id UNIQUE)');
    await db.query('INSERT INTO t VALUES (1)');
    const error = await db.query('INSERT INTO t VALUES (1)').catch((e: unknown) => e);
    expect(isUniqueViolation(error)).toBe(true);
    expect(isUniqueViolation(error, 't_id')).toBe(true);
    expect(isUniqueViolation(error, 'other')).toBe(false);
    expect(isUniqueViolation(new Error('x'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });

  it('one() and maybeOne() are strict', () => {
    expect(one([1])).toBe(1);
    expect(() => one([])).toThrow(DbError);
    expect(() => one([1, 2], 'user')).toThrow(/exactly one user, found 2/);
    expect(maybeOne([])).toBeNull();
    expect(maybeOne([7, 8])).toBe(7);
  });

  it('persists to a folder across reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warrant-db-'));
    try {
      const first = await openDb({ dataDir: dir });
      await first.query('CREATE TABLE t (id integer)');
      await first.query('INSERT INTO t VALUES (7)');
      await first.close();
      const second = await openDb({ dataDir: dir });
      opened.push(second);
      expect((await second.query<{ id: number }>('SELECT id FROM t'))[0]?.id).toBe(7);
    } finally {
      for (const d of opened.splice(0)) await d.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('migrations apply once, in order, and are idempotent', async () => {
    const db = await openDb();
    opened.push(db);
    const first = await migrate(db);
    expect(first).toEqual(MIGRATIONS.map((m) => m.id));
    expect(await migrate(db)).toEqual([]);
    const tables = (await db.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")).map((r) => r.table_name);
    for (const t of ['platforms', 'registry_keys', 'transparency_log', 'transparency_checkpoints', 'ledger_entries', 'schema_migrations']) expect(tables).toContain(t);
  });

  it('a failing migration leaves nothing half applied', async () => {
    const db = await openDb();
    opened.push(db);
    await expect(
      migrate(db, [
        { id: 'a', sql: 'CREATE TABLE ok_table (id integer);' },
        { id: 'b', sql: 'CREATE TABLE ok_table (id integer);' },
      ]),
    ).rejects.toThrow();
    const tables = (await db.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")).map((r) => r.table_name);
    expect(tables).not.toContain('ok_table');
    expect((await db.query('SELECT id FROM schema_migrations')).length).toBe(0);
  });
});

describe('server keys', () => {
  it('derives a stable kid from the public key', () => {
    const pair = generateSigningKey();
    const a = keyMaterial('wallet', pair.privateKey);
    const b = keyMaterial('wallet', pair.privateKey);
    expect(a.kid).toBe(b.kid);
    expect(a.kid).toMatch(/^wallet-[A-Za-z0-9_-]{16}$/);
    expect(keyMaterial('wallet', generateSigningKey().privateKey).kid).not.toBe(a.kid);
  });

  it('uses keys from the environment', () => {
    const wallet = generateSigningKey();
    const config = testConfig({ WALLET_SIGNING_KEY: wallet.privateKeyBase64 });
    const keys = loadServerKeys(config);
    expect(keys.sources).toEqual({ wallet: 'env', agent: 'ephemeral', registry: 'ephemeral' });
    expect(keys.wallet.kid).toBe(keyMaterial('wallet', wallet.privateKey).kid);
  });

  it('persists development keys so restarts keep the same identities', () => {
    const dir = mkdtempSync(join(tmpdir(), 'warrant-keys-'));
    try {
      const config = testConfig({ DATA_DIR: dir });
      const first = loadServerKeys(config, { persist: true });
      expect(first.sources.wallet).toBe('dev-file');
      const second = loadServerKeys(config, { persist: true });
      expect(second.wallet.kid).toBe(first.wallet.kid);
      expect(second.agent.kid).toBe(first.agent.kid);
      expect(second.registry.kid).toBe(first.registry.kid);
      expect(Object.keys(JSON.parse(readFileSync(join(dir, 'dev-keys.json'), 'utf8')) as object).sort()).toEqual(['agent', 'registry', 'wallet']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('without persistence, keys are fresh each time and nothing is written', () => {
    const config = testConfig();
    const a = loadServerKeys(config);
    const b = loadServerKeys(config);
    expect(a.wallet.kid).not.toBe(b.wallet.kid);
  });

  it('rejects a malformed key from the environment without echoing it', () => {
    const config = testConfig({ WALLET_SIGNING_KEY: 'not-a-key' });
    expect(() => loadServerKeys(config)).toThrow(/signing key/);
    try {
      loadServerKeys(config);
    } catch (error) {
      expect((error as Error).message).not.toContain('not-a-key');
    }
  });
});

describe('default data directory', () => {
  it('is the user own data folder on each platform, never the working directory', async () => {
    const path = await import('node:path');
    const join = (...parts: string[]): string => path.join(...parts);
    const { defaultDataDir } = await import('../src/config');
    expect(defaultDataDir({ LOCALAPPDATA: 'D:/local' }, 'win32', 'C:/Users/a')).toBe(join('D:/local', 'warrant'));
    expect(defaultDataDir({}, 'win32', 'C:/Users/a')).toBe(join('C:/Users/a', 'AppData', 'Local', 'warrant'));
    expect(defaultDataDir({}, 'darwin', '/Users/a')).toBe(join('/Users/a', 'Library', 'Application Support', 'warrant'));
    expect(defaultDataDir({}, 'linux', '/home/a')).toBe(join('/home/a', '.local', 'share', 'warrant'));
    expect(defaultDataDir({ XDG_DATA_HOME: '/data' }, 'linux', '/home/a')).toBe(join('/data', 'warrant'));
    expect(loadConfig({}).dataDir.endsWith('warrant')).toBe(true);
    expect(loadConfig({ DATA_DIR: '/somewhere/else' }).dataDir).toBe('/somewhere/else');
  });
});
