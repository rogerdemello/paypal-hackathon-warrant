import { createRequire } from 'node:module';
import { PayPalAgentToolkit } from '@paypal/agent-toolkit/ai-sdk';
import { mapDispute, mapOrder, type DisputeSummary, type OrderSummary, type PayPalClient, type PayPalSimulator } from '@warrant/paypal';

/**
 * The dispute agent's PayPal reads, done with the official PayPal Agent Toolkit (`get_dispute`, `get_order`). Only those two
 * actions are enabled. Everything that changes a dispute stays on `packages/paypal`: the Toolkit's `accept_dispute_claim`
 * sends only a note (no `accept_claim_reason`, `accept_claim_type` or refund amount), and it has no tool for `provide-evidence`
 * or `make-offer`.
 *
 * The Toolkit caches its access token for the life of the object and never refreshes it, so after a failure the toolkit is
 * rebuilt and the call falls back to the typed REST client rather than failing the dispute.
 */
export interface DisputeTools {
  readonly source: 'agent-toolkit';
  getDispute(disputeId: string): Promise<DisputeSummary>;
  getOrder(orderId: string): Promise<OrderSummary>;
  /** How many reads the Toolkit answered, and how many fell back to the REST client. */
  stats(): { readonly toolkit: number; readonly fallback: number };
}

interface ToolkitCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

type ToolResult = (name: string, args: Record<string, unknown>) => Promise<unknown>;

function buildToolkit(credentials: ToolkitCredentials): ToolResult {
  const toolkit = new PayPalAgentToolkit({
    ...credentials,
    configuration: { actions: { disputes: { get: true }, orders: { get: true } }, context: { sandbox: true } },
  });
  const tools = toolkit.getTools();
  return async (name, args) => {
    const tool = tools[name];
    if (tool?.execute === undefined) throw new Error(`the PayPal Agent Toolkit does not expose ${name}`);
    // The Toolkit answers with a JSON string, and reports a PayPal error as { ok: false, status, code, message } instead of throwing.
    const answer: unknown = await tool.execute(args, { toolCallId: `warrant:${name}`, messages: [] });
    const parsed: unknown = typeof answer === 'string' ? JSON.parse(answer) : answer;
    if (typeof parsed === 'object' && parsed !== null && 'ok' in parsed && parsed.ok === false) {
      const failure = parsed as { status?: unknown; code?: unknown; message?: unknown };
      throw new Error(`PayPal Agent Toolkit ${name} failed (${String(failure.status)} ${String(failure.code)}): ${String(failure.message)}`);
    }
    return parsed;
  };
}

export function createDisputeTools(options: { credentials: ToolkitCredentials; client: PayPalClient }): DisputeTools {
  let run = buildToolkit(options.credentials);
  let toolkit = 0;
  let fallback = 0;

  async function viaToolkit<T>(name: string, args: Record<string, unknown>, map: (raw: unknown) => T, rest: () => Promise<T>): Promise<T> {
    try {
      const mapped = map(await run(name, args));
      toolkit += 1;
      return mapped;
    } catch {
      run = buildToolkit(options.credentials);
      fallback += 1;
      return rest();
    }
  }

  return {
    source: 'agent-toolkit',
    getDispute: (id) => viaToolkit('get_dispute', { dispute_id: id }, mapDispute, () => options.client.getDispute(id)),
    getOrder: (id) => viaToolkit('get_order', { id }, mapOrder, () => options.client.getOrder(id)),
    stats: () => ({ toolkit, fallback }),
  };
}

/**
 * The simulator is an in-process `fetch`, but the Toolkit speaks HTTP through its own copy of axios. This points that axios
 * at the simulator so the real Toolkit code runs, unchanged, against the simulated PayPal. Not used with the real sandbox.
 */
export function routeToolkitToSimulator(simulator: PayPalSimulator): void {
  const toolkitEntry = createRequire(import.meta.url).resolve('@paypal/agent-toolkit/ai-sdk');
  const axios = createRequire(toolkitEntry)('axios') as { defaults: { adapter?: unknown } };
  axios.defaults.adapter = async (config: AxiosLikeConfig): Promise<unknown> => {
    const base = config.baseURL ?? '';
    const url = new URL(config.url?.startsWith('http') === true ? config.url : base + (config.url ?? ''));
    for (const [key, value] of Object.entries(config.params ?? {})) url.searchParams.set(key, String(value));
    const headers = new Headers();
    for (const [key, value] of Object.entries(config.headers?.toJSON?.() ?? config.headers ?? {})) if (typeof value === 'string') headers.set(key, value);
    const body = config.data === undefined || config.data === null ? undefined : typeof config.data === 'string' ? config.data : JSON.stringify(config.data);
    const response = await simulator.fetch(url.toString(), { method: (config.method ?? 'get').toUpperCase(), headers, ...(body === undefined ? {} : { body }) });
    const text = await response.text();
    let data: unknown = text;
    try {
      data = text === '' ? null : JSON.parse(text);
    } catch {
      // not JSON: keep the text
    }
    const result = { data, status: response.status, statusText: response.statusText, headers: {}, config, request: {} };
    if (response.status >= 400) throw Object.assign(new Error(`Request failed with status code ${response.status}`), { isAxiosError: true, response: result });
    return result;
  };
}

interface AxiosLikeConfig {
  readonly baseURL?: string;
  readonly url?: string;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly data?: unknown;
  readonly headers?: { toJSON?: () => Record<string, unknown> } & Record<string, unknown>;
}
