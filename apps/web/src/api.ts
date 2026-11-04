import type {
  AgentSessionDto,
  AttemptRowDto,
  DisputeDetailDto,
  DisputeRowDto,
  MandateDto,
  MandateTermsDto,
  OrderDetailDto,
  OrderRowDto,
  OverviewDto,
  ProductRowDto,
  ProposalDto,
  PublicConfigDto,
  RegistryAuditDto,
  RegistryKeyDto,
  RegistryLogDto,
  ScenarioListDto,
  ScenarioResultDto,
  VerificationReportDto,
  WalletMeDto,
} from '@warrant/server/api-types';
import { consoleToken, visitorId } from './storage';

/** The typed client for the server API. Money is integer cents everywhere; the server owns every rule. */

export class ApiError extends Error {
  override readonly name = 'ApiError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly problems: readonly string[] = [],
  ) {
    super(message);
  }
}

interface Options {
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

async function request<T>(method: string, path: string, options: Options = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json', 'x-visitor-id': visitorId() };
  const token = consoleToken.get();
  if (token !== null) headers['x-console-token'] = token;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  let response: Response;
  try {
    response = await fetch(path, { method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }), ...(options.signal === undefined ? {} : { signal: options.signal }) });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'NETWORK', 'The server could not be reached. Is it running?');
  }
  const text = await response.text();
  let parsed: unknown = null;
  if (text !== '') {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!response.ok) {
    const error = (parsed as { error?: { code?: string; message?: string; problems?: string[] } } | null)?.error;
    throw new ApiError(response.status, error?.code ?? 'ERROR', error?.message ?? `The server answered ${response.status}.`, error?.problems ?? []);
  }
  return parsed as T;
}

const get = <T>(path: string, options?: Options) => request<T>('GET', path, options);
const post = <T>(path: string, body?: unknown, options?: Options) => request<T>('POST', path, { ...options, ...(body === undefined ? {} : { body }) });

/** `?a=1&b=2` from the defined members of `params`, or an empty string. */
function query(params: Record<string, string | boolean | undefined>): string {
  const parts = Object.entries(params).flatMap(([k, v]) => (v === undefined || v === false ? [] : [`${k}=${v === true ? '1' : encodeURIComponent(v)}`]));
  return parts.length === 0 ? '' : `?${parts.join('&')}`;
}

export type ConsoleSettings = { merchantMode: 'STRICT' | 'PERMISSIVE' | 'NONE'; disputeAutopilot: boolean };

export const api = {
  config: () => get<PublicConfigDto>('/api/config'),
  health: () => get<{ ok: boolean; mode: string; paypal: string; database: string; models: string }>('/api/health'),

  wallet: {
    me: () => get<WalletMeDto>('/api/wallet/me'),
    linkPaypal: () => post<{ payerLinked: boolean }>('/api/wallet/link-paypal'),
    mandates: () => get<{ mandates: MandateDto[] }>('/api/wallet/mandates'),
    revoke: (jti: string) => post<{ mandate: MandateDto }>(`/api/wallet/mandates/${encodeURIComponent(jti)}/revoke`),
    proposal: (id: string) => get<{ proposal: ProposalDto }>(`/api/wallet/proposals/${encodeURIComponent(id)}`),
    approve: (id: string) => post<{ proposal: ProposalDto }>(`/api/wallet/proposals/${encodeURIComponent(id)}/approve`),
    decline: (id: string) => post<{ proposal: ProposalDto }>(`/api/wallet/proposals/${encodeURIComponent(id)}/decline`),
  },

  agent: {
    latest: () => get<{ session: AgentSessionDto | null }>('/api/agent/sessions/latest'),
    start: () => post<{ session: AgentSessionDto }>('/api/agent/sessions'),
    get: (id: string) => get<{ session: AgentSessionDto }>(`/api/agent/sessions/${encodeURIComponent(id)}`),
    say: (id: string, text: string) => post<{ session: AgentSessionDto }>(`/api/agent/sessions/${encodeURIComponent(id)}/messages`, { text }),
    authorize: (id: string, edits: Partial<MandateTermsDto>) => post<{ session: AgentSessionDto }>(`/api/agent/sessions/${encodeURIComponent(id)}/authorize`, { edits }),
    checkout: (id: string) => post<{ session: AgentSessionDto }>(`/api/agent/sessions/${encodeURIComponent(id)}/checkout`),
    complete: (id: string) => post<{ session: AgentSessionDto }>(`/api/agent/sessions/${encodeURIComponent(id)}/complete`),
    decline: (id: string) => post<{ session: AgentSessionDto }>(`/api/agent/sessions/${encodeURIComponent(id)}/decline`),
  },

  merchant: {
    order: (id: string) => get<{ order: { id: string; status: string; totalCents: number; currency: string; cartJti: string | null; captureId: string | null; note: string | null } }>(`/api/merchant/orders/${encodeURIComponent(id)}`),
    complete: (id: string) => post<{ status: string; message: string; orderId: string; orderStatus: string; cartJti: string | null }>(`/api/merchant/orders/${encodeURIComponent(id)}/complete`),
  },

  verify: (cartJti: string) => get<VerificationReportDto>(`/api/verify/${encodeURIComponent(cartJti)}`),

  registry: {
    jwks: () => get<{ keys: RegistryKeyDto[] }>('/api/registry/jwks.json'),
    log: (after?: number) => get<RegistryLogDto>(`/api/registry/log${after === undefined ? '' : `?after=${after}`}`),
    audit: () => get<RegistryAuditDto>('/api/registry/audit'),
  },

  console: {
    overview: (lab = false) => get<OverviewDto>(`/api/console/overview${query({ lab })}`),
    orders: (status?: string, lab = false) => get<{ orders: OrderRowDto[] }>(`/api/console/orders${query({ status, lab })}`),
    order: (id: string) => get<OrderDetailDto>(`/api/console/orders/${encodeURIComponent(id)}`),
    review: (id: string, decision: 'approve' | 'reject') => post<unknown>(`/api/console/orders/${encodeURIComponent(id)}/review`, { decision }),
    ship: (id: string, carrier: string, trackingNumber: string) => post<{ warning: string | null }>(`/api/console/orders/${encodeURIComponent(id)}/ship`, { carrier, trackingNumber }),
    deliver: (id: string) => post<unknown>(`/api/console/orders/${encodeURIComponent(id)}/deliver`, undefined),
    refund: (id: string, amountCents?: number) => post<unknown>(`/api/console/orders/${encodeURIComponent(id)}/refund`, amountCents === undefined ? {} : { amountCents }),
    attempts: (lab = false) => get<{ attempts: AttemptRowDto[] }>(`/api/console/attempts${query({ lab })}`),
    products: () => get<{ products: ProductRowDto[] }>('/api/console/products'),
    patchProduct: (sku: string, change: { priceCents?: number; available?: boolean; title?: string }) => request<{ product: ProductRowDto }>('PATCH', `/api/console/products/${encodeURIComponent(sku)}`, { body: change }),
    settings: () => get<ConsoleSettings>('/api/console/settings'),
    saveSettings: (change: Partial<ConsoleSettings>) => request<ConsoleSettings>('PUT', '/api/console/settings', { body: change }),
    disputes: (state?: string, lab = false) => get<{ disputes: DisputeRowDto[] }>(`/api/console/disputes${query({ state, lab })}`),
    dispute: (id: string) => get<DisputeDetailDto>(`/api/console/disputes/${encodeURIComponent(id)}`),
    refreshDispute: (id: string) => post<unknown>(`/api/console/disputes/${encodeURIComponent(id)}/refresh`, undefined),
    analyze: (id: string) => post<unknown>(`/api/console/disputes/${encodeURIComponent(id)}/analyze`, undefined),
    approveAction: (id: string) => post<unknown>(`/api/console/actions/${encodeURIComponent(id)}/approve`, undefined),
    rejectAction: (id: string) => post<unknown>(`/api/console/actions/${encodeURIComponent(id)}/reject`, undefined),
    keys: () => get<{ keys: RegistryKeyDto[] }>('/api/console/keys'),
    setKeyStatus: (kid: string, status: 'active' | 'suspended' | 'revoked') => post<{ keys: RegistryKeyDto[] }>(`/api/console/keys/${encodeURIComponent(kid)}/status`, { status }),
    checkpoint: () => post<{ checkpoint: unknown; audit: RegistryAuditDto }>('/api/console/registry/checkpoint', undefined),
    /** The evidence packet as a file. Fetched with the console token, so it works when the console is locked. */
    packet: async (id: string): Promise<{ blob: Blob; name: string }> => {
      const headers: Record<string, string> = { 'x-visitor-id': visitorId() };
      const token = consoleToken.get();
      if (token !== null) headers['x-console-token'] = token;
      const response = await fetch(`/api/console/disputes/${encodeURIComponent(id)}/packet`, { headers });
      if (!response.ok) throw new ApiError(response.status, 'NO_PACKET', 'There is no evidence packet for this dispute.');
      const disposition = response.headers.get('content-disposition') ?? '';
      return { blob: await response.blob(), name: /filename="([^"]+)"/.exec(disposition)?.[1] ?? `warrant-evidence-${id}.pdf` };
    },
  },

  lab: {
    scenarios: () => get<ScenarioListDto>('/api/lab/scenarios'),
    run: (id: string) => post<{ result: ScenarioResultDto }>(`/api/lab/scenarios/${encodeURIComponent(id)}/run`, undefined),
    dispute: (orderId: string, input: { reason: string; message: string; dueInHours?: number; amountCents?: number }) =>
      post<{ disputeId: string; via: string }>(`/api/lab/orders/${encodeURIComponent(orderId)}/dispute`, input),
    adjudicate: (disputeId: string, outcome: 'BUYER_FAVOR' | 'SELLER_FAVOR') => post<unknown>(`/api/lab/disputes/${encodeURIComponent(disputeId)}/adjudicate`, { outcome }),
    buyerAccepts: (disputeId: string) => post<unknown>(`/api/lab/disputes/${encodeURIComponent(disputeId)}/buyer-accepts`, undefined),
  },
};
