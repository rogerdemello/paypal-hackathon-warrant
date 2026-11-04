import type { DisputeDetailDto, VerificationReportDto } from '@warrant/server/api-types';

/**
 * A read-only client for the Warrant server's HTTP API. The address of the server and the console token come from the
 * operator's environment, never from the tools' callers, so a caller cannot point the tools somewhere else.
 */

export class WarrantApiError extends Error {
  override readonly name = 'WarrantApiError';
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

export interface WarrantApiOptions {
  readonly baseUrl: string;
  /** The console token (`x-console-token`), needed for dispute facts when the server's judge mode is off. */
  readonly consoleToken?: string | null;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export class WarrantApi {
  private readonly baseUrl: string;
  private readonly token: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: WarrantApiOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.consoleToken ?? null;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /** The public verification report for a cart warrant. A warrant the server does not hold comes back with `found: false`. */
  async verification(cartJti: string): Promise<VerificationReportDto> {
    const { status, body } = await this.get(`/api/verify/${encodeURIComponent(cartJti)}`, false);
    if (status === 404 || status === 200) return body as VerificationReportDto;
    throw new WarrantApiError(`the server answered ${status}`, status);
  }

  /** A dispute with its facts, decision and proposed action, or null if there is no such dispute. */
  async dispute(disputeId: string): Promise<DisputeDetailDto | null> {
    const { status, body } = await this.get(`/api/console/disputes/${encodeURIComponent(disputeId)}`, true);
    if (status === 404) return null;
    if (status === 401 || status === 403) throw new WarrantApiError('the server wants its console token: set WARRANT_CONSOLE_TOKEN for this MCP server', status);
    if (status !== 200) throw new WarrantApiError(`the server answered ${status}`, status);
    return body as DisputeDetailDto;
  }

  private async get(path: string, console_: boolean): Promise<{ status: number; body: unknown }> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (console_ && this.token !== null) headers['x-console-token'] = this.token;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      throw new WarrantApiError(`could not reach the Warrant server at ${this.baseUrl}: ${error instanceof Error ? error.message : String(error)}`, null);
    }
    const text = await response.text();
    let body: unknown = null;
    if (text !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        throw new WarrantApiError(`the server answered ${response.status} with something that is not JSON`, response.status);
      }
    }
    return { status: response.status, body };
  }
}
