import { formatMoney } from '@warrant/warrant';
import { PayPalError, PayPalProtocolError } from './errors';
import { isRec, str } from './json';
import { mapCapture, mapDispute, mapOrder, mapRefund } from './mappers';
import type {
  AcceptClaimInput,
  CaptureSummary,
  CreateOrderInput,
  DisputeListQuery,
  DisputeSummary,
  MakeOfferInput,
  OrderSummary,
  ProvideEvidenceInput,
  RefundInput,
  RefundSummary,
  SandboxCreateDisputeInput,
  TrackingInput,
  WebhookHeaders,
} from './types';

export const SANDBOX_BASE_URL = 'https://api-m.sandbox.paypal.com';
export const LIVE_BASE_URL = 'https://api-m.paypal.com';

export interface PayPalClientConfig {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Inject for tests or to talk to the in-process simulator. Default: global fetch. */
  readonly fetch?: typeof fetch;
  /** Milliseconds since the epoch. Default: Date.now. Used only for token expiry. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Retries after the first attempt, for network errors, 5xx and 429. Default 3. */
  readonly maxRetries?: number;
}

interface RequestOptions {
  readonly body?: unknown;
  readonly form?: FormData;
  /** Sent as `PayPal-Request-Id`. Required for POSTs that must be safe to retry. */
  readonly requestId?: string;
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly headers?: Readonly<Record<string, string>>;
  /** Raw body text sent as-is (webhook verification must not re-serialize the event). */
  readonly rawJson?: string;
}

interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
  readonly debugId: string | null;
}

const money = (currency: string, cents: number) => ({ currency_code: currency, value: formatMoney(cents) });

/**
 * A small PayPal REST client for the endpoints Warrant uses (docs/paypal-integration.md). It never accepts or returns
 * decimal strings: callers pass and receive integer cents. Every POST that matters carries a deterministic
 * `PayPal-Request-Id`; GETs and requests with a request id are retried on network errors, 5xx and 429.
 */
export class PayPalClient {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;

  constructor(private readonly config: PayPalClientConfig) {
    if (config.baseUrl === LIVE_BASE_URL) {
      throw new PayPalProtocolError('refusing to use the live PayPal API: Warrant is sandbox only');
    }
    this.fetchImpl = config.fetch ?? ((input, init) => fetch(input, init));
    this.now = config.now ?? (() => Date.now());
    this.sleep = config.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRetries = config.maxRetries ?? 3;
  }

  // -------------------------------------------------------------------------------------------
  // Orders v2 and Payments v2
  // -------------------------------------------------------------------------------------------

  async createOrder(input: CreateOrderInput, requestId: string): Promise<OrderSummary> {
    const itemTotal = money(input.currency, input.lines.reduce((sum, l) => sum + l.unitCents * l.quantity, 0));
    const body = {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: input.referenceId,
          custom_id: input.customId,
          invoice_id: input.invoiceId,
          description: input.description,
          amount: { ...money(input.currency, input.totalCents), breakdown: { item_total: itemTotal } },
          items: input.lines.map((l) => ({
            name: l.name.slice(0, 127),
            sku: l.sku.slice(0, 127),
            quantity: String(l.quantity),
            unit_amount: money(input.currency, l.unitCents),
            category: 'PHYSICAL_GOODS',
          })),
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: input.brandName,
            shipping_preference: 'NO_SHIPPING',
            user_action: 'PAY_NOW',
            return_url: input.returnUrl,
            cancel_url: input.cancelUrl,
          },
        },
      },
    };
    const res = await this.request('POST', '/v2/checkout/orders', { body, requestId, headers: { Prefer: 'return=representation' } });
    return mapOrder(res.body);
  }

  async getOrder(orderId: string): Promise<OrderSummary> {
    const res = await this.request('GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`, {});
    return mapOrder(res.body);
  }

  async captureOrder(orderId: string, requestId: string): Promise<OrderSummary> {
    const res = await this.request('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
      body: {},
      requestId,
      headers: { Prefer: 'return=representation' },
    });
    return mapOrder(res.body);
  }

  async addTracking(orderId: string, input: TrackingInput, requestId: string): Promise<void> {
    await this.request('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/track`, {
      body: {
        capture_id: input.captureId,
        tracking_number: input.trackingNumber,
        carrier: input.carrier,
        notify_payer: input.notifyPayer ?? false,
      },
      requestId,
    });
  }

  async refundCapture(input: RefundInput, requestId: string): Promise<RefundSummary> {
    const body: Record<string, unknown> = {};
    if (input.amountCents !== undefined) body['amount'] = money(input.currency, input.amountCents);
    if (input.note !== undefined) body['note_to_payer'] = input.note.slice(0, 255);
    if (input.invoiceId !== undefined) body['invoice_id'] = input.invoiceId;
    const res = await this.request('POST', `/v2/payments/captures/${encodeURIComponent(input.captureId)}/refund`, { body, requestId });
    return mapRefund(res.body);
  }

  async getCapture(captureId: string): Promise<CaptureSummary> {
    const res = await this.request('GET', `/v2/payments/captures/${encodeURIComponent(captureId)}`, {});
    return mapCapture(res.body);
  }

  // -------------------------------------------------------------------------------------------
  // Disputes v1
  // -------------------------------------------------------------------------------------------

  async listDisputes(query: DisputeListQuery = {}): Promise<DisputeSummary[]> {
    const q: Record<string, string | undefined> = { disputed_transaction_id: undefined, dispute_state: query.status };
    if (query.pageSize !== undefined) q['page_size'] = String(query.pageSize);
    const res = await this.request('GET', '/v1/customer/disputes', { query: q });
    const items = isRec(res.body) && Array.isArray(res.body['items']) ? (res.body['items'] as unknown[]) : [];
    // The list gives summaries; fetch each for the full record (amount, transactions, options).
    const ids = items.filter(isRec).map((i) => str(i['dispute_id'])).filter((v): v is string => v !== null);
    return Promise.all(ids.map((id) => this.getDispute(id)));
  }

  async getDispute(disputeId: string): Promise<DisputeSummary> {
    const res = await this.request('GET', `/v1/customer/disputes/${encodeURIComponent(disputeId)}`, {});
    return mapDispute(res.body);
  }

  /** Accept liability: the dispute closes in the buyer's favour and PayPal refunds from the merchant's account. */
  async acceptClaim(disputeId: string, input: AcceptClaimInput, requestId: string): Promise<void> {
    const body: Record<string, unknown> = { note: input.note.slice(0, 2000), accept_claim_reason: input.reason ?? 'REASON_NOT_SET' };
    if (input.invoiceId !== undefined) body['invoice_id'] = input.invoiceId;
    if (input.acceptClaimType !== undefined) body['accept_claim_type'] = input.acceptClaimType;
    if (input.refundAmount !== undefined) body['refund_amount'] = money(input.refundAmount.currency, input.refundAmount.cents);
    await this.request('POST', `/v1/customer/disputes/${encodeURIComponent(disputeId)}/accept-claim`, { body, requestId });
  }

  async makeOffer(disputeId: string, input: MakeOfferInput, requestId: string): Promise<void> {
    const body: Record<string, unknown> = { note: input.note.slice(0, 2000), offer_type: input.offerType };
    if (input.offerAmount !== undefined) body['offer_amount'] = money(input.offerAmount.currency, input.offerAmount.cents);
    if (input.invoiceId !== undefined) body['invoice_id'] = input.invoiceId;
    await this.request('POST', `/v1/customer/disputes/${encodeURIComponent(disputeId)}/make-offer`, { body, requestId });
  }

  /** multipart/form-data: an `input` JSON part plus document parts, as in docs/paypal-integration.md section 4. */
  async provideEvidence(disputeId: string, input: ProvideEvidenceInput, requestId: string): Promise<void> {
    const evidences = input.evidences.map((e) => {
      const out: Record<string, unknown> = { evidence_type: e.evidenceType };
      if (e.notes !== undefined) out['notes'] = e.notes.slice(0, 2000);
      const info: Record<string, unknown> = {};
      if (e.trackingInfo !== undefined) info['tracking_info'] = e.trackingInfo.map((t) => ({ carrier_name: t.carrierName, tracking_number: t.trackingNumber }));
      if (e.refundIds !== undefined) info['refund_ids'] = e.refundIds;
      if (Object.keys(info).length > 0) out['evidence_info'] = info;
      return out;
    });
    const form = new FormData();
    form.append('input', new Blob([JSON.stringify({ evidences })], { type: 'application/json' }), 'input.json');
    for (const file of input.files ?? []) {
      form.append(file.name, new Blob([Buffer.from(file.data)], { type: file.contentType }), file.name);
    }
    await this.request('POST', `/v1/customer/disputes/${encodeURIComponent(disputeId)}/provide-evidence`, { form, requestId });
  }

  // -------------------------------------------------------------------------------------------
  // Sandbox-only helpers (docs/paypal-integration.md section 4)
  // -------------------------------------------------------------------------------------------

  async sandboxCreateDispute(input: SandboxCreateDisputeInput, requestId: string): Promise<DisputeSummary> {
    const res = await this.request('POST', '/v1/customer/disputes', {
      requestId,
      body: {
        disputed_transactions: [{ seller_transaction_id: input.sellerTransactionId }],
        reason: input.reason,
        dispute_amount: money(input.currency, input.amountCents),
        messages: [{ posted_by: 'BUYER', content: input.message.slice(0, 2000) }],
      },
    });
    const id = isRec(res.body) ? (str(res.body['dispute_id']) ?? str(res.body['id']) ?? idFromSelfLink(res.body['links'])) : null;
    if (id === null) throw new PayPalProtocolError('create dispute response has no dispute id');
    return this.getDispute(id);
  }

  async sandboxAdjudicate(disputeId: string, outcome: 'BUYER_FAVOR' | 'SELLER_FAVOR', requestId: string): Promise<void> {
    await this.request('POST', `/v1/customer/disputes/${encodeURIComponent(disputeId)}/adjudicate`, { body: { adjudication_outcome: outcome }, requestId });
  }

  async sandboxRequireEvidence(disputeId: string, action: 'BUYER_EVIDENCE' | 'SELLER_EVIDENCE', requestId: string): Promise<void> {
    await this.request('POST', `/v1/customer/disputes/${encodeURIComponent(disputeId)}/require-evidence`, { body: { action }, requestId });
  }

  // -------------------------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------------------------

  /**
   * Ask PayPal whether a webhook delivery is genuine. `rawBody` must be the exact bytes received: it is embedded
   * unparsed so the signature check sees what PayPal signed. Returns true only for `SUCCESS`.
   */
  async verifyWebhookSignature(headers: WebhookHeaders, rawBody: string, webhookId: string): Promise<boolean> {
    const rawJson =
      `{"auth_algo":${JSON.stringify(headers.authAlgo)},"cert_url":${JSON.stringify(headers.certUrl)},` +
      `"transmission_id":${JSON.stringify(headers.transmissionId)},"transmission_sig":${JSON.stringify(headers.transmissionSig)},` +
      `"transmission_time":${JSON.stringify(headers.transmissionTime)},"webhook_id":${JSON.stringify(webhookId)},"webhook_event":${rawBody}}`;
    const res = await this.request('POST', '/v1/notifications/verify-webhook-signature', { rawJson });
    return isRec(res.body) && res.body['verification_status'] === 'SUCCESS';
  }

  // -------------------------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------------------------

  private async accessToken(force = false): Promise<string> {
    if (!force && this.token !== null && this.token.expiresAt > this.now()) return this.token.value;
    const credentials = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');
    const res = await this.fetchImpl(`${this.config.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    const parsed = await parseBody(res);
    if (!res.ok || !isRec(parsed) || typeof parsed['access_token'] !== 'string') {
      throw toError(res.status, parsed, res.headers.get('paypal-debug-id'));
    }
    const expiresIn = typeof parsed['expires_in'] === 'number' ? parsed['expires_in'] : 300;
    this.token = { value: parsed['access_token'], expiresAt: this.now() + Math.max(expiresIn - 60, 30) * 1000 };
    return this.token.value;
  }

  private async request(method: 'GET' | 'POST', path: string, options: RequestOptions): Promise<ApiResponse> {
    const retryable = method === 'GET' || options.requestId !== undefined || options.rawJson !== undefined;
    let attempt = 0;
    let refreshedToken = false;
    for (;;) {
      attempt += 1;
      let response: Response | null = null;
      let failure: unknown = null;
      try {
        const token = await this.accessToken();
        const url = new URL(`${this.config.baseUrl}${path}`);
        for (const [key, value] of Object.entries(options.query ?? {})) {
          if (value !== undefined) url.searchParams.set(key, value);
        }
        const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json', ...options.headers };
        if (options.requestId !== undefined) headers['PayPal-Request-Id'] = options.requestId;
        let body: string | FormData | undefined;
        if (options.form !== undefined) {
          body = options.form;
        } else if (options.rawJson !== undefined) {
          body = options.rawJson;
          headers['Content-Type'] = 'application/json';
        } else if (options.body !== undefined) {
          body = JSON.stringify(options.body);
          headers['Content-Type'] = 'application/json';
        }
        response = await this.fetchImpl(url.toString(), { method, headers, ...(body === undefined ? {} : { body }) });
      } catch (error) {
        failure = error;
      }

      if (response !== null) {
        const parsed = await parseBody(response);
        const debugId = response.headers.get('paypal-debug-id') ?? (isRec(parsed) ? str(parsed['debug_id']) : null);
        if (response.ok) return { status: response.status, body: parsed, debugId };
        if (response.status === 401 && !refreshedToken) {
          refreshedToken = true;
          await this.accessToken(true);
          continue;
        }
        const transient = response.status >= 500 || response.status === 429;
        if (!(transient && retryable && attempt <= this.maxRetries)) {
          throw toError(response.status, parsed, debugId);
        }
      } else if (!(retryable && attempt <= this.maxRetries)) {
        throw failure instanceof Error ? failure : new Error('PayPal request failed');
      }
      await this.sleep(Math.min(2 ** attempt * 100, 3000) + Math.floor(Math.random() * 100));
    }
  }
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function toError(status: number, body: unknown, debugId: string | null): PayPalError {
  const b = isRec(body) ? body : {};
  const name = str(b['name']) ?? str(b['error']) ?? null;
  const message = str(b['message']) ?? str(b['error_description']) ?? `PayPal returned HTTP ${status}`;
  const details = Array.isArray(b['details']) ? (b['details'] as unknown[]) : [];
  return new PayPalError(message, status, name, debugId, details);
}

/** The create-dispute response carries only links; the id is the last path segment of the `self` link. */
function idFromSelfLink(links: unknown): string | null {
  if (!Array.isArray(links)) return null;
  const self = (links as unknown[]).find((l) => isRec(l) && l['rel'] === 'self');
  const href = isRec(self) ? str(self['href']) : null;
  return href === null ? null : (href.split('/').filter((s) => s.length > 0).pop() ?? null);
}
