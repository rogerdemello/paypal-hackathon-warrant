import { ConfigError, loadConfig } from './config';
import { openDb } from './db';
import { MIGRATIONS, migrate } from './db/migrations';
import { loadEnvFile } from './env';

/** `pnpm db:migrate`: bring the database up to date without starting the server. */

loadEnvFile();
try {
  const config = loadConfig(process.env);
  const db = await openDb({ databaseUrl: config.databaseUrl, dataDir: config.databaseUrl === null ? config.dataDir : null });
  const applied = await migrate(db);
  console.log(applied.length === 0 ? `Database is up to date (${MIGRATIONS.length} migrations).` : `Applied: ${applied.join(', ')}`);
  await db.close();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`Cannot migrate: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
