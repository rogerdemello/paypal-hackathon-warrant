import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests: the built web app, served by the real server, against the built-in PayPal simulator and the
 * deterministic shopping agent. Nothing here needs a credential, a network connection or a browser download when a
 * browser is already installed:
 *
 *   pnpm e2e                          (builds the web app first; uses Playwright's own Chromium)
 *   E2E_CHANNEL=msedge pnpm e2e       (or "chrome": use the browser already on this machine)
 *
 * The database lives in a fresh temporary folder per run (outside any synced folder), so runs never see each other.
 *
 * To run the same tests against a server that is already running (for example the Docker image with Postgres), set
 * E2E_BASE_URL=http://localhost:8787; no server is started then, and the tests add data to whatever that server holds.
 */

const PORT = Number(process.env['E2E_PORT'] ?? 8788);
const external = process.env['E2E_BASE_URL'];
const ORIGIN = external ?? `http://localhost:${PORT}`;

// Created once in the process that starts the server; test workers inherit it and do not create another.
const dataDir = (process.env['WARRANT_E2E_DATA_DIR'] ??= mkdtempSync(join(tmpdir(), 'warrant-e2e-')));
const channel = process.env['E2E_CHANNEL'];
const browser = channel === undefined ? {} : { channel };

const server = {
  command: 'pnpm --filter @warrant/server start',
  url: `${ORIGIN}/api/config`,
  reuseExistingServer: false,
  timeout: 120_000,
  stdout: 'ignore' as const,
  stderr: 'pipe' as const,
  env: {
    NODE_ENV: 'development',
    PORT: String(PORT),
    HOST: '127.0.0.1',
    PUBLIC_BASE_URL: ORIGIN,
    WEB_ORIGIN: ORIGIN,
    DATA_DIR: dataDir,
    WARRANT_MODE: 'fixtures',
    PAYPAL_ENV: 'simulator',
    PAYPAL_CLIENT_ID: '',
    PAYPAL_CLIENT_SECRET: '',
    ANTHROPIC_API_KEY: '',
    CHANNEL3_API_KEY: '',
    DATABASE_URL: '',
    JUDGE_MODE_ENABLED: 'true',
    CONSOLE_TOKEN: '',
    DISPUTE_AUTOPILOT: 'false',
  },
};

export default defineConfig({
  testDir: './tests',
  // The tests share one server and one database, and each one is a whole story, so they run one at a time.
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] === undefined ? 0 : 1,
  forbidOnly: process.env['CI'] !== undefined,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env['CI'] === undefined ? [['list']] : [['list'], ['html', { open: 'never' }]],
  use: { baseURL: ORIGIN, trace: 'retain-on-failure', screenshot: 'only-on-failure', ...browser },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'], ...browser } }],
  ...(external === undefined ? { webServer: server } : {}),
});
