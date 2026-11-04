import { buildApp } from './app';
import { ConfigError, loadConfig } from './config';
import { createContainer } from './container';
import { loadEnvFile } from './env';

/** Start the server: API, simulator pages and (when built) the web app, on one port. */

const envFile = loadEnvFile();

let config;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`\nCannot start: ${error.message}\n\nSee docs/setup.md and .env.example.`);
    process.exit(1);
  }
  throw error;
}

const container = await createContainer(config);
const app = await buildApp(container);

// A signed statement of the transparency log's head, now and then, so a later rewrite of history contradicts it.
const checkpointTimer = setInterval(() => {
  container.registry.checkpoint().catch((error: unknown) => app.log.error({ err: error }, 'checkpoint failed'));
}, 60_000);
checkpointTimer.unref();

const shutdown = async (signal: string): Promise<void> => {
  app.log.info(`${signal} received, shutting down`);
  clearInterval(checkpointTimer);
  await app.close();
  await container.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.port, host: config.host });

const k = container.keys.sources;
const lines = [
  '',
  `Warrant server listening on ${config.publicBaseUrl}`,
  `  mode            ${config.mode}${config.mode === 'fixtures' ? ' (deterministic products and text; no model calls)' : ' (live products and models)'}`,
  `  PayPal          ${container.paypal.env}${container.paypal.env === 'simulator' ? ' (built-in simulator; approval page at /sim/paypal/approve)' : ' (sandbox)'}`,
  `  database        ${container.db.dialect === 'pglite' ? `embedded PGlite in ${config.dataDir}` : 'PostgreSQL'}`,
  `  web app         ${config.webOrigin}`,
  `  console         ${config.judgeModeEnabled ? 'open (judge mode)' : 'needs the console token'}`,
  envFile === null ? '  config          no .env file; using defaults and the environment' : `  config          ${envFile}`,
];
if (k.wallet !== 'env' || k.agent !== 'env' || k.registry !== 'env') {
  lines.push(`  signing keys    wallet=${k.wallet} agent=${k.agent} registry=${k.registry}  (development keys: set real ones with pnpm keygen before deploying)`);
}
if (config.nodeEnv === 'production' && config.judgeModeEnabled) lines.push('  WARNING         the console and Dispute Lab are open to anyone (JUDGE_MODE_ENABLED is true)');
console.log(`${lines.join('\n')}\n`);
