import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

/** Everything the server reads from the environment, validated once at startup. See .env.example and docs/setup.md. */

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  constructor(readonly problems: readonly string[]) {
    super(`invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
}

export interface Config {
  /** `live` calls Anthropic and Channel3; `fixtures` replays deterministic data. PayPal is independent of this. */
  readonly mode: 'live' | 'fixtures';
  readonly nodeEnv: 'development' | 'production' | 'test';
  readonly port: number;
  readonly host: string;
  readonly publicBaseUrl: string;
  readonly webOrigin: string;
  /** Where PGlite data and development keys live. */
  readonly dataDir: string;
  /** Null: use embedded PGlite in `dataDir`. Set: use this Postgres. */
  readonly databaseUrl: string | null;
  readonly paypal: {
    /** `sandbox` talks to api-m.sandbox.paypal.com. `simulator` is the built-in stand-in; it needs no credentials. */
    readonly env: 'sandbox' | 'simulator';
    readonly clientId: string | null;
    readonly clientSecret: string | null;
    readonly webhookId: string | null;
    readonly merchantId: string;
    readonly authAssertionJwt: string | null;
  };
  readonly anthropic: { readonly apiKey: string | null; readonly model: string; readonly fastModel: string };
  readonly channel3ApiKey: string | null;
  readonly signingKeys: { readonly wallet: string | null; readonly agent: string | null; readonly registry: string | null };
  readonly disputeAutopilot: boolean;
  /** Judge mode: the merchant console and Dispute Lab are open without a login. Turn it off for a real deployment. */
  readonly judgeModeEnabled: boolean;
  /** With judge mode off, console and Lab requests must send this as `x-console-token`. */
  readonly consoleToken: string | null;
  readonly llmDailyBudgetUsd: number;
  readonly llmRunsPerVisitor: number;
  readonly merchantName: string;
}

/**
 * Where the embedded database and development keys live when DATA_DIR is not set: the user's own data folder, not the
 * repository. A repository is often inside a folder that OneDrive or Dropbox syncs, and a synced folder makes the embedded
 * database's lock file fail to be created ("Permission denied"), so the default avoids it.
 */
export function defaultDataDir(env: Readonly<Record<string, string | undefined>>, platform: string = process.platform, home: string = homedir()): string {
  if (platform === 'win32') return join(env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local'), 'warrant');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'warrant');
  return join(env['XDG_DATA_HOME'] ?? join(home, '.local', 'share'), 'warrant');
}

const blank = (v: string | undefined): string | null => (v === undefined || v.trim() === '' ? null : v.trim());
const flag = z
  .string()
  .optional()
  .transform((v) => (v ?? '').trim().toLowerCase() === 'true');

const schema = z.object({
  WARRANT_MODE: z.enum(['live', 'fixtures']).optional(),
  NODE_ENV: z.enum(['development', 'production', 'test']).optional(),
  PORT: z.coerce.number().int().min(1).max(65535).optional(),
  HOST: z.string().optional(),
  PUBLIC_BASE_URL: z.string().optional(),
  /** Set by Render for every web service; used when PUBLIC_BASE_URL is not. */
  RENDER_EXTERNAL_URL: z.string().optional(),
  WEB_ORIGIN: z.string().optional(),
  DATA_DIR: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  PAYPAL_ENV: z.string().optional(),
  PAYPAL_CLIENT_ID: z.string().optional(),
  PAYPAL_CLIENT_SECRET: z.string().optional(),
  PAYPAL_WEBHOOK_ID: z.string().optional(),
  PAYPAL_MERCHANT_ID: z.string().optional(),
  PAYPAL_AUTH_ASSERTION_JWT: z.string().optional(),
  ALLOW_PRODUCTION: flag,
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().optional(),
  ANTHROPIC_FAST_MODEL: z.string().optional(),
  CHANNEL3_API_KEY: z.string().optional(),
  WALLET_SIGNING_KEY: z.string().optional(),
  AGENT_PLATFORM_SIGNING_KEY: z.string().optional(),
  REGISTRY_LOG_KEY: z.string().optional(),
  DISPUTE_AUTOPILOT: flag,
  JUDGE_MODE_ENABLED: z.string().optional(),
  CONSOLE_TOKEN: z.string().optional(),
  LLM_DAILY_BUDGET_USD: z.coerce.number().min(0).optional(),
  LLM_RUNS_PER_VISITOR: z.coerce.number().int().min(0).optional(),
  MERCHANT_NAME: z.string().optional(),
});

/**
 * Validate the environment. With no variables at all the server starts in a zero-config demo: fixtures mode, the PayPal
 * simulator and development keys. Anything that is set must be coherent; every problem is reported at once.
 */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`));
  }
  const e = parsed.data;
  const problems: string[] = [];

  const nodeEnv = e.NODE_ENV ?? 'development';
  const clientId = blank(e.PAYPAL_CLIENT_ID);
  const paypalEnvRaw = (blank(e.PAYPAL_ENV) ?? (clientId === null ? 'simulator' : 'sandbox')).toLowerCase();
  if (paypalEnvRaw !== 'sandbox' && paypalEnvRaw !== 'simulator') {
    problems.push(
      paypalEnvRaw === 'production' || paypalEnvRaw === 'live'
        ? 'PAYPAL_ENV=production is not supported: Warrant is sandbox only (use "sandbox", or "simulator" for the built-in stand-in)'
        : `PAYPAL_ENV must be "sandbox" or "simulator", got "${paypalEnvRaw}"`,
    );
  }
  const paypalEnv = paypalEnvRaw === 'sandbox' ? 'sandbox' : 'simulator';
  const clientSecret = blank(e.PAYPAL_CLIENT_SECRET);
  const webhookId = blank(e.PAYPAL_WEBHOOK_ID);
  const merchantId = blank(e.PAYPAL_MERCHANT_ID);
  if (paypalEnv === 'sandbox') {
    if (clientId === null) problems.push('PAYPAL_CLIENT_ID is required when PAYPAL_ENV=sandbox (or set PAYPAL_ENV=simulator)');
    if (clientSecret === null) problems.push('PAYPAL_CLIENT_SECRET is required when PAYPAL_ENV=sandbox');
    if (webhookId === null) problems.push('PAYPAL_WEBHOOK_ID is required when PAYPAL_ENV=sandbox (see docs/setup.md, webhooks)');
    if (merchantId === null) problems.push('PAYPAL_MERCHANT_ID is required when PAYPAL_ENV=sandbox (it is the warrant audience)');
  }

  const mode = e.WARRANT_MODE ?? 'fixtures';
  const anthropicKey = blank(e.ANTHROPIC_API_KEY);
  const channel3Key = blank(e.CHANNEL3_API_KEY);
  if (mode === 'live') {
    if (anthropicKey === null) problems.push('ANTHROPIC_API_KEY is required when WARRANT_MODE=live (or set WARRANT_MODE=fixtures)');
    if (channel3Key === null) problems.push('CHANNEL3_API_KEY is required when WARRANT_MODE=live (or set WARRANT_MODE=fixtures)');
  }

  const publicUrl = blank(e.PUBLIC_BASE_URL) ?? blank(e.RENDER_EXTERNAL_URL);
  const signingKeys = { wallet: blank(e.WALLET_SIGNING_KEY), agent: blank(e.AGENT_PLATFORM_SIGNING_KEY), registry: blank(e.REGISTRY_LOG_KEY) };
  if (nodeEnv === 'production') {
    for (const [name, value] of [['WALLET_SIGNING_KEY', signingKeys.wallet], ['AGENT_PLATFORM_SIGNING_KEY', signingKeys.agent], ['REGISTRY_LOG_KEY', signingKeys.registry]] as const) {
      if (value === null) problems.push(`${name} is required in production (generate with: pnpm keygen)`);
    }
    if (blank(e.DATABASE_URL) === null) problems.push('DATABASE_URL is required in production');
    if (publicUrl === null) problems.push('PUBLIC_BASE_URL is required in production');
  }

  const judgeModeEnabled = (e.JUDGE_MODE_ENABLED ?? 'true').trim().toLowerCase() !== 'false';
  const consoleToken = blank(e.CONSOLE_TOKEN);
  if (!judgeModeEnabled && consoleToken === null) problems.push('CONSOLE_TOKEN is required when JUDGE_MODE_ENABLED=false (the console would otherwise have no way in)');

  if (problems.length > 0) throw new ConfigError(problems);

  const port = e.PORT ?? 8787;
  const publicBaseUrl = (publicUrl ?? `http://localhost:${port}`).replace(/\/+$/, '');
  return {
    mode,
    nodeEnv,
    port,
    host: blank(e.HOST) ?? (nodeEnv === 'production' ? '0.0.0.0' : '127.0.0.1'),
    publicBaseUrl,
    // In production the server serves the built web app itself, so the app lives at the public address; in development
    // it is Vite's dev server.
    webOrigin: (blank(e.WEB_ORIGIN) ?? (nodeEnv === 'production' ? publicBaseUrl : 'http://localhost:5173')).replace(/\/+$/, ''),
    dataDir: blank(e.DATA_DIR) ?? defaultDataDir(env),
    databaseUrl: blank(e.DATABASE_URL),
    paypal: {
      env: paypalEnv,
      clientId,
      clientSecret,
      webhookId,
      merchantId: merchantId ?? 'SIMMERCHANT01',
      authAssertionJwt: blank(e.PAYPAL_AUTH_ASSERTION_JWT),
    },
    anthropic: {
      apiKey: anthropicKey,
      model: blank(e.ANTHROPIC_MODEL) ?? 'claude-sonnet-5-5',
      fastModel: blank(e.ANTHROPIC_FAST_MODEL) ?? 'claude-haiku-5-5',
    },
    channel3ApiKey: channel3Key,
    signingKeys,
    disputeAutopilot: e.DISPUTE_AUTOPILOT,
    judgeModeEnabled,
    consoleToken,
    llmDailyBudgetUsd: e.LLM_DAILY_BUDGET_USD ?? 20,
    llmRunsPerVisitor: e.LLM_RUNS_PER_VISITOR ?? 15,
    merchantName: blank(e.MERCHANT_NAME) ?? 'Warrant Demo Store (sandbox)',
  };
}
