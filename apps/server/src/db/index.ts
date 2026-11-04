import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

/**
 * One interface over two Postgres engines: embedded PGlite for zero-config development and tests, and a real Postgres
 * (`DATABASE_URL`) for deployment. Both speak the same SQL, so there is a single schema and a single code path.
 *
 * Conventions: timestamps are `bigint` epoch seconds (the same NumericDate the warrants use), money is `bigint` cents,
 * documents are `jsonb`. `bigint` columns come back as JavaScript numbers (values here stay far below 2^53).
 */

export type Row = Record<string, unknown>;
export type Param = string | number | boolean | null | bigint;

export interface Queryable {
  /** Run one statement. `$1`-style placeholders; pass JSON documents as strings and cast with `::jsonb`. */
  query<T = Row>(sql: string, params?: readonly Param[]): Promise<T[]>;
}

export interface Db extends Queryable {
  readonly dialect: 'pglite' | 'postgres';
  /**
   * Run `fn` in one transaction. A thrown error rolls everything back. Inside, take `SELECT ... FOR UPDATE` row locks to
   * serialise work on one mandate or one order; PGlite is single-connection, so it serialises whole transactions.
   */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export class DbError extends Error {
  override readonly name = 'DbError';
}

/** True when `error` is a Postgres unique-constraint violation (optionally on a named constraint). */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { code?: unknown; constraint?: unknown };
  return e.code === '23505' && (constraint === undefined || e.constraint === constraint);
}

/** Exactly one row, or throw. */
export function one<T>(rows: readonly T[], what = 'row'): T {
  const [first] = rows;
  if (first === undefined || rows.length !== 1) throw new DbError(`expected exactly one ${what}, found ${rows.length}`);
  return first;
}

/** At most one row. */
export function maybeOne<T>(rows: readonly T[]): T | null {
  return rows[0] ?? null;
}

/** A JSON document as a bind parameter (`$1::jsonb`). */
export function json(value: unknown): string {
  return JSON.stringify(value);
}

class PgliteDb implements Db {
  readonly dialect = 'pglite' as const;
  constructor(private readonly db: PGlite) {}

  async query<T = Row>(sql: string, params: readonly Param[] = []): Promise<T[]> {
    const result = await this.db.query<T>(sql, [...params]);
    return result.rows;
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => fn({ query: async <R = Row>(sql: string, params: readonly Param[] = []) => (await tx.query<R>(sql, [...params])).rows }));
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

class PostgresDb implements Db {
  readonly dialect = 'postgres' as const;
  constructor(private readonly pool: pg.Pool) {}

  async query<T = Row>(sql: string, params: readonly Param[] = []): Promise<T[]> {
    const result = await this.pool.query(sql, [...params]);
    return result.rows as T[];
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const value = await fn({ query: async <R = Row>(sql: string, params: readonly Param[] = []) => (await client.query(sql, [...params])).rows as R[] });
      await client.query('COMMIT');
      return value;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The original error is the one worth reporting.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export interface OpenOptions {
  /** A Postgres connection string. Takes precedence over `dataDir`. */
  readonly databaseUrl?: string | null;
  /** PGlite storage folder; omit (or pass `null`) for an in-memory database. */
  readonly dataDir?: string | null;
  /** Maximum Postgres connections. Default 10. */
  readonly poolSize?: number;
}

/**
 * Whether to use TLS for a Postgres connection, and how. An explicit `sslmode` in the URL always wins (`disable` turns it
 * off, `verify-ca` and `verify-full` check the certificate, the others encrypt without checking, which is what hosted
 * databases with their own certificate authority need). Without one, a database on this machine or on a private network
 * name (no dots, like the `db` service of docker compose or Render's internal hostname) is reached without TLS and any
 * other host with it, since that is a database across the internet.
 */
export function sslOptionFor(databaseUrl: string): { rejectUnauthorized: boolean } | undefined {
  const mode = /[?&]sslmode=([a-z-]+)/i.exec(databaseUrl)?.[1]?.toLowerCase();
  if (mode === 'disable') return undefined;
  if (mode === 'verify-ca' || mode === 'verify-full') return { rejectUnauthorized: true };
  if (mode !== undefined) return { rejectUnauthorized: false };
  let host = '';
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    // Not a URL pg can use either; let it report the problem.
  }
  const onPrivateNetwork = host === '' || host === 'localhost' || host === '[::1]' || !host.includes('.') || /^(127|10)\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  return onPrivateNetwork ? undefined : { rejectUnauthorized: false };
}

export async function openDb(options: OpenOptions = {}): Promise<Db> {
  if (options.databaseUrl !== undefined && options.databaseUrl !== null) {
    // bigint (OID 20) as a number, so cents and epoch seconds are plain numbers in both engines.
    const types = {
      getTypeParser: (oid: number, format?: 'text' | 'binary'): ((value: string) => unknown) => (oid === 20 ? (text: string): number => Number(text) : (pg.types.getTypeParser(oid, format ?? 'text') as (value: string) => unknown)),
    };
    const ssl = sslOptionFor(options.databaseUrl);
    const pool = new pg.Pool({ connectionString: options.databaseUrl, max: options.poolSize ?? 10, ...(ssl === undefined ? {} : { ssl }), types });
    pool.on('error', () => {
      // An idle client dropped; the pool replaces it on the next query.
    });
    return new PostgresDb(pool);
  }
  if (options.dataDir === undefined || options.dataDir === null) {
    return new PgliteDb(await PGlite.create());
  }
  const dir = resolve(options.dataDir, 'pglite');
  mkdirSync(dir, { recursive: true });
  try {
    return new PgliteDb(await PGlite.create(dir));
  } catch (error) {
    throw new DbError(
      `The embedded database in ${dir} could not be opened (${error instanceof Error ? error.message : 'unknown error'}). ` +
        'If that folder is synced by OneDrive or Dropbox, or another copy of the server is running, set DATA_DIR to a plain local folder, or set DATABASE_URL to use PostgreSQL.',
    );
  }
}

/** Remove every row from every application table, keeping the schema and the migration history. For tests and the evaluation runner. */
export async function truncateAll(db: Db): Promise<void> {
  const tables = (await db.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name <> 'schema_migrations'")).map((r) => r.table_name);
  if (tables.length > 0) await db.query(`TRUNCATE ${tables.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
}
