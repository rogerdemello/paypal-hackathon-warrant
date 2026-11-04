import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ManualClock, SCENARIOS, ScenarioRunner, buildApp, createContainer, loadConfig, migrate, openDb, sequentialIds, type Container, type Db } from '@warrant/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WarrantApi, WarrantApiError, createWarrantMcpServer } from '../src';

/**
 * The tools are exercised the way a client uses them: over the MCP protocol (in memory), against the real server routes
 * with a real scenario's records behind them.
 */

const CONSOLE_TOKEN = 'test-console-token';
const T0 = Date.UTC(2026, 5, 1, 12, 0, 0);

let db: Db;
let container: Container;
let app: Awaited<ReturnType<typeof buildApp>>;
let cartJti = '';
let disputeId = '';
/** Purchases whose proof is flawed in different ways, and the disputes about them. */
let forged = { cartJti: '', disputeId: '' };
let unlinked = { cartJti: '', disputeId: '' };

/** `fetch` that goes straight into the server's routes. */
const viaApp: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
  const response = await app.inject({ method: 'GET', url: `${url.pathname}${url.search}`, headers });
  return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
};

async function connect(api: WarrantApi): Promise<Client> {
  const server = createWarrantMcpServer(api);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const json = (result: unknown): Record<string, unknown> => {
  const r = result as { structuredContent?: Record<string, unknown> };
  expect(r.structuredContent).toBeDefined();
  return r.structuredContent ?? {};
};
const messageOf = (result: unknown): string => ((result as { content: Array<{ text: string }> }).content[0]?.text ?? '');

beforeAll(async () => {
  db = await openDb();
  await migrate(db);
  const clock = new ManualClock(T0);
  // Judge mode off, so the console (and with it the dispute facts) needs its token, as on a real deployment.
  container = await createContainer(loadConfig({ NODE_ENV: 'test', JUDGE_MODE_ENABLED: 'false', CONSOLE_TOKEN }), { db, clock, ids: sequentialIds() });
  app = await buildApp(container, { logger: false, webDist: null });
  const scenario = SCENARIOS.find((s) => s.expect.dispute?.outcome === 'FIGHT');
  if (scenario === undefined) throw new Error('the corpus has no contestable dispute');
  const runner = new ScenarioRunner(container, { advanceClock: (s) => clock.advanceSeconds(s) });
  const run = async (id: string) => {
    const scenarioToRun = id === '' ? scenario : SCENARIOS.find((s) => s.id === id);
    if (scenarioToRun === undefined) throw new Error(`no scenario ${id}`);
    const result = await runner.run(scenarioToRun);
    expect(result.passed, id).toBe(true);
    expect(result.actual.cartJti).not.toBeNull();
    expect(result.actual.disputeId).not.toBeNull();
    return { cartJti: result.actual.cartJti ?? '', disputeId: result.actual.disputeId ?? '' };
  };
  ({ cartJti, disputeId } = await run(''));
  // An edited cart sold by a merchant that does not enforce, and a first purchase from an account not yet bound to the wallet.
  forged = await run('forge-07');
  unlinked = await run('remorse-05');
});

afterAll(async () => {
  await app.close();
  await container.close();
});

describe('what the server offers a client', () => {
  it('lists two read-only tools whose only input is an identifier', async () => {
    const client = await connect(new WarrantApi({ baseUrl: 'http://warrant.test', fetch: viaApp }));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['get_dispute_facts', 'verify_warrant']);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
      const properties = Object.keys((tool.inputSchema as { properties: Record<string, unknown> }).properties);
      // No price, payee, URL or document: the caller can only name a record.
      expect(properties).toEqual([tool.name === 'verify_warrant' ? 'cart_jti' : 'dispute_id']);
    }
  });
});

describe('verify_warrant', () => {
  it('reports a contestable purchase as verified, with the signatures, facts and log entry', async () => {
    const client = await connect(new WarrantApi({ baseUrl: 'http://warrant.test', fetch: viaApp }));
    const out = json(await client.callTool({ name: 'verify_warrant', arguments: { cart_jti: cartJti } }));
    expect(out['cart_jti']).toBe(cartJti);
    expect(['verified', 'signed_with_open_questions']).toContain(out['verdict']);
    const signatures = out['signatures'] as Array<{ ok: boolean }>;
    expect(signatures.length).toBeGreaterThanOrEqual(3);
    expect(signatures.every((s) => s.ok)).toBe(true);
    const facts = out['facts'] as Array<{ id: string; established: boolean; name: string }>;
    expect(facts.find((f) => f.id === 'F2')).toMatchObject({ established: true, name: 'Every signature on it verifies' });
    expect(out['transparency_log']).toMatchObject({ included: true });
    expect(out['order']).not.toBeNull();
  });

  it('says a purchase is not verified when a signature does not verify, and names the one that failed', async () => {
    const client = await connect(new WarrantApi({ baseUrl: 'http://warrant.test', fetch: viaApp }));
    const out = json(await client.callTool({ name: 'verify_warrant', arguments: { cart_jti: forged.cartJti } }));
    expect(out['verdict']).toBe('not_verified');
    expect(out['summary']).toMatch(/cannot be relied on/);
    expect((out['signatures'] as Array<{ ok: boolean }>).some((s) => !s.ok)).toBe(true);
  });

  it('says what is not established when the signatures are fine but the paying account was never bound to the wallet', async () => {
    const client = await connect(new WarrantApi({ baseUrl: 'http://warrant.test', fetch: viaApp }));
    const out = json(await client.callTool({ name: 'verify_warrant', arguments: { cart_jti: unlinked.cartJti } }));
    expect(out['verdict']).toBe('signed_with_open_questions');
    expect(out['summary']).toMatch(/F7 \(Paid by the PayPal account bound to the wallet\)/);
  });

  it('does not claim verification when there is no order to compare against', async () => {
    const real = await (await viaApp('http://warrant.test/api/verify/' + cartJti)).json() as Record<string, unknown>;
    const noOrder: typeof fetch = () => Promise.resolve(new Response(JSON.stringify({ ...real, order: null, facts: [] }), { status: 200 }));
    const client = await connect(new WarrantApi({ baseUrl: 'http://warrant.test', fetch: noOrder }));
    const out = json(await client.callTool({ name: 'verify_warrant', arguments: { cart_jti: cartJti } }));
    expect(out['verdict']).toBe('signed_with_open_questions');
    expect(out['summary']).toMatch(/no order was placed/);
  });

  it('says plainly when the server holds no such warrant', async () => {
    const client = await connect(new WarrantApi({ baseUrl: 'http://warrant.test', fetch: viaApp }));
    const out = json(await client.callTool({ name: 'verify_warrant', arguments: { cart_jti: 'crt_does_not_exist' } }));
    expect(out).toMatchObject({ verdict: 'not_found', cart_jti: 'crt_does_not_exist' });
  });

  it('rejects an identifier that is not one, before anything is sent to the server', async () => {
    let calls = 0;
    const counting: typeof fetch = async (...args) => {
      calls += 1;
      return viaApp(...args);
    };
    const client = await connect(new WarrantApi({ baseUrl: 'http://warrant.test', fetch: counting }));
    for (const bad of ['../../etc/passwd', 'a b', 'x?y=1', '', 'x'.repeat(200)]) {
      const outcome = await client.callTool({ name: 'verify_warrant', arguments: { cart_jti: bad } }).catch((e: unknown) => e);
      const rejected = outcome instanceof Error || (outcome as { isError?: boolean }).isError === true;
      expect(rejected, bad).toBe(true);
    }
    expect(calls).toBe(0);
  });

  it('turns a server that cannot be reached into a tool error that names the address', async () => {
    const down: typeof fetch = () => Promise.reject(new Error('connect ECONNREFUSED'));
    const client = await connect(new WarrantApi({ baseUrl: 'http://warrant.test:1/', fetch: down }));
    const result = await client.callTool({ name: 'verify_warrant', arguments: { cart_jti: 'crt_1' } });
    expect(result.isError).toBe(true);
    expect(messageOf(result)).toMatch(/could not reach the Warrant server at http:\/\/warrant\.test:1: connect ECONNREFUSED/);
  });
});

describe('get_dispute_facts', () => {
  it('returns the facts, the decision and the proposed action for a dispute', async () => {
    const client = await connect(new WarrantApi({ baseUrl: 'http://warrant.test', consoleToken: CONSOLE_TOKEN, fetch: viaApp }));
    const out = json(await client.callTool({ name: 'get_dispute_facts', arguments: { dispute_id: disputeId } }));
    expect(out['dispute_id']).toBe(disputeId);
    expect(out['decision']).toMatchObject({ outcome: 'FIGHT', confidence: 'normal' });
    const facts = out['facts'] as Array<{ id: string; value: unknown; evidence: string[] }>;
    expect(facts.map((f) => f.id)).toEqual(expect.arrayContaining(['F1', 'F2', 'F7', 'F9', 'F12']));
    expect(facts.find((f) => f.id === 'F1')?.evidence.length).toBeGreaterThan(0);
    expect(out['proposed_action']).toMatchObject({ type: 'provide-evidence' });
    expect(out['public_proof']).toEqual(expect.stringContaining(cartJti));
  });

  it('reports an unestablished fact and a dispute that was decided against the merchant', async () => {
    const client = await connect(new WarrantApi({ baseUrl: 'http://warrant.test', consoleToken: CONSOLE_TOKEN, fetch: viaApp }));
    const out = json(await client.callTool({ name: 'get_dispute_facts', arguments: { dispute_id: unlinked.disputeId } }));
    expect(out['decision']).toMatchObject({ outcome: 'NO_PROOF' });
    const facts = out['facts'] as Array<{ id: string; value: unknown }>;
    expect(facts.find((f) => f.id === 'F7')?.value).toBe(false);
    expect(out['proposed_action']).not.toBeNull();
  });

  it('copes with a dispute that has not been analysed yet', async () => {
    const real = await (await viaApp('http://warrant.test/api/console/disputes/' + disputeId, { headers: { 'x-console-token': CONSOLE_TOKEN } })).json() as Record<string, unknown>;
    const bare: typeof fetch = () => Promise.resolve(new Response(JSON.stringify({ ...real, analysis: null, actions: [] }), { status: 200 }));
    const client = await connect(new WarrantApi({ baseUrl: 'http://warrant.test', consoleToken: CONSOLE_TOKEN, fetch: bare }));
    const out = json(await client.callTool({ name: 'get_dispute_facts', arguments: { dispute_id: disputeId } }));
    expect(out).toMatchObject({ decision: null, facts: [], proposed_action: null });
  });

  it('needs the console token when the server is not in judge mode, and says so', async () => {
    const client = await connect(new WarrantApi({ baseUrl: 'http://warrant.test', fetch: viaApp }));
    const result = await client.callTool({ name: 'get_dispute_facts', arguments: { dispute_id: disputeId } });
    expect(result.isError).toBe(true);
    expect(messageOf(result)).toMatch(/WARRANT_CONSOLE_TOKEN/);
  });

  it('reports an unknown dispute', async () => {
    const client = await connect(new WarrantApi({ baseUrl: 'http://warrant.test', consoleToken: CONSOLE_TOKEN, fetch: viaApp }));
    const result = await client.callTool({ name: 'get_dispute_facts', arguments: { dispute_id: 'PP-D-999999' } });
    expect(result.isError).toBe(true);
    expect(messageOf(result)).toMatch(/No dispute with id PP-D-999999/);
  });
});

describe('the API client', () => {
  const reply = (status: number, body: string): typeof fetch => () => Promise.resolve(new Response(body, { status }));

  it('reports a server error and a non-JSON answer as errors, not as data', async () => {
    await expect(new WarrantApi({ baseUrl: 'http://x', fetch: reply(500, '{}') }).verification('crt_1')).rejects.toThrow(/answered 500/);
    await expect(new WarrantApi({ baseUrl: 'http://x', fetch: reply(200, '<html>') }).verification('crt_1')).rejects.toThrow(/not JSON/);
    await expect(new WarrantApi({ baseUrl: 'http://x', consoleToken: 't', fetch: reply(500, '{}') }).dispute('d')).rejects.toBeInstanceOf(WarrantApiError);
    await expect(new WarrantApi({ baseUrl: 'http://x', fetch: reply(401, '{}') }).dispute('d')).rejects.toThrow(/console token/);
  });

  it('puts the token in the console header only, and never in a public request', async () => {
    const seen: Array<{ path: string; token: string | null }> = [];
    const spy: typeof fetch = (input, init) => {
      seen.push({ path: new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname, token: new Headers(init?.headers).get('x-console-token') });
      return Promise.resolve(new Response('{"found":false}', { status: 404 }));
    };
    const api = new WarrantApi({ baseUrl: 'http://x/', consoleToken: 'secret', fetch: spy });
    await api.verification('crt_1');
    await api.dispute('PP-D-1');
    expect(seen).toEqual([
      { path: '/api/verify/crt_1', token: null },
      { path: '/api/console/disputes/PP-D-1', token: 'secret' },
    ]);
  });
});
