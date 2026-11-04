import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { formatMoney, tryParseMoney, type Cents } from '@warrant/warrant';
import { isRec, str } from './json';

/**
 * An in-process stand-in for the PayPal sandbox endpoints Warrant uses. It exists so the whole product, the tests and CI
 * run end to end with no credentials. It speaks the same HTTP API as PayPal (same paths, bodies, error shapes, a signed
 * webhook feed and a verify-webhook-signature endpoint), so `PayPalClient` runs unchanged against it: pass
 * `simulator.fetch` as the client's `fetch`.
 *
 * It is NOT PayPal. It implements the documented happy paths and the failures Warrant needs to exercise (not approved,
 * already captured, duplicate invoice, declined instrument, refund over the captured amount, actions not allowed in a
 * dispute state). Anything else is out of scope and should be confirmed against the real sandbox (the [spike] items in
 * docs/paypal-integration.md).
 */

export interface SimulatorOptions {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly webhookId?: string;
  readonly webhookSecret?: string;
  /** The page where the buyer approves an order. `?token=<order id>` is appended to the `payer-action` link. */
  readonly approvalUrl: string;
  /** Milliseconds since the epoch. Default Date.now. */
  readonly now?: () => number;
  readonly merchant?: { readonly merchantId: string; readonly email: string; readonly name: string };
  readonly disputeResponseDays?: number;
}

export interface WebhookDelivery {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}
export type WebhookSink = (delivery: WebhookDelivery) => Promise<void>;

export interface SimPayer {
  readonly payerId: string;
  readonly email: string;
  readonly name: string;
}

export const DEFAULT_SIM_PAYER: SimPayer = { payerId: 'SIMPAYER0001', email: 'sandbox-buyer@example.com', name: 'Sandbox Buyer' };

interface SimLine {
  readonly sku: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitCents: Cents;
}

interface OrderRecord {
  readonly id: string;
  status: 'PAYER_ACTION_REQUIRED' | 'APPROVED' | 'COMPLETED';
  readonly referenceId: string | null;
  readonly customId: string | null;
  readonly invoiceId: string | null;
  readonly description: string | null;
  readonly currency: string;
  readonly totalCents: Cents;
  readonly lines: readonly SimLine[] | null;
  payer: SimPayer | null;
  captureIds: string[];
  tracking: Array<{ captureId: string; trackingNumber: string; carrier: string }>;
  readonly createdAt: number;
}

interface CaptureRecord {
  readonly id: string;
  readonly orderId: string;
  status: 'COMPLETED' | 'PARTIALLY_REFUNDED' | 'REFUNDED';
  readonly currency: string;
  readonly amountCents: Cents;
  refundedCents: Cents;
  readonly invoiceId: string | null;
  readonly customId: string | null;
  readonly createdAt: number;
}

/**
 * What the simulator knows, as plain data: orders, captures, disputes and the id counter. A server that keeps its own data
 * across restarts saves this too, so a restart does not make PayPal "forget" an order it already took payment for, and the
 * ids it hands out next do not repeat ones already in the server's database.
 */
export interface SimulatorSnapshot {
  readonly version: 1;
  readonly counter: number;
  readonly orders: readonly OrderRecord[];
  readonly captures: readonly CaptureRecord[];
  readonly disputes: readonly DisputeRecord[];
}

export type SimDisputeStatus = 'WAITING_FOR_SELLER_RESPONSE' | 'WAITING_FOR_BUYER_RESPONSE' | 'UNDER_REVIEW' | 'RESOLVED';

interface DisputeRecord {
  readonly id: string;
  readonly captureId: string;
  readonly reason: string;
  status: SimDisputeStatus;
  stage: 'INQUIRY' | 'CHARGEBACK';
  readonly currency: string;
  readonly amountCents: Cents;
  readonly createdAt: number;
  updatedAt: number;
  dueAt: number;
  messages: Array<{ posted_by: string; content: string; time_posted: string }>;
  evidences: Array<{ evidence_type: string; source: string; notes?: string; evidence_info?: unknown }>;
  offer: { offer_type: string; seller_offered_amount: { currency_code: string; value: string }; note: string } | null;
  outcome: { outcome_code: string; amount_refunded?: { currency_code: string; value: string } } | null;
}

export interface OpenDisputeInput {
  readonly captureId: string;
  readonly reason: string;
  readonly message: string;
  readonly amountCents?: Cents;
  /** Seconds from now until the seller must respond. Default: `disputeResponseDays` days. */
  readonly responseDueInSeconds?: number;
}

class SimError extends Error {
  constructor(
    readonly status: number,
    readonly errorName: string,
    message: string,
    readonly issue: string | null = null,
  ) {
    super(message);
  }
}

interface Ctx {
  readonly req: Request;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly requestId: string | null;
  readonly mock: string | null;
  json(): Promise<Record<string, unknown>>;
}
interface Result {
  readonly status: number;
  readonly body: unknown;
}
interface Route {
  readonly method: string;
  readonly pattern: RegExp;
  readonly names: readonly string[];
  readonly handler: (ctx: Ctx) => Promise<Result> | Result;
}

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const amount = (currency: string, cents: Cents) => ({ currency_code: currency, value: formatMoney(cents) });

function parseAmount(value: unknown, what: string): { currency: string; cents: Cents } {
  if (!isRec(value)) throw new SimError(400, 'INVALID_REQUEST', `${what} is required`, 'MISSING_REQUIRED_PARAMETER');
  const currency = str(value['currency_code']);
  const cents = tryParseMoney(str(value['value']) ?? '');
  if (currency === null || cents === null) throw new SimError(422, 'UNPROCESSABLE_ENTITY', `${what} is not a valid amount`, 'INVALID_PARAMETER_VALUE');
  return { currency, cents };
}

const ISSUE_ACTION_NOT_ALLOWED = 'DISPUTE_ACTION_NOT_ALLOWED';

export class PayPalSimulator {
  /** Use as `PayPalClient`'s `fetch`. The host in the URL is ignored. */
  readonly fetch: typeof fetch;
  /** Every webhook delivery, in order, whether or not a sink is attached. */
  readonly deliveries: WebhookDelivery[] = [];

  private readonly opts: Required<Omit<SimulatorOptions, 'merchant'>> & { merchant: NonNullable<SimulatorOptions['merchant']> };
  private readonly orders = new Map<string, OrderRecord>();
  private readonly captures = new Map<string, CaptureRecord>();
  private readonly disputes = new Map<string, DisputeRecord>();
  private readonly tokens = new Set<string>();
  private readonly idempotent = new Map<string, Result>();
  private readonly routes: Route[] = [];
  private readonly pending = new Set<Promise<void>>();
  private sink: WebhookSink | null = null;
  private counter = 0;
  private onChange: (() => void) | null = null;

  constructor(options: SimulatorOptions) {
    this.opts = {
      clientId: options.clientId ?? 'sim-client-id',
      clientSecret: options.clientSecret ?? 'sim-client-secret',
      webhookId: options.webhookId ?? 'SIM-WEBHOOK-ID',
      webhookSecret: options.webhookSecret ?? 'sim-webhook-secret',
      approvalUrl: options.approvalUrl,
      now: options.now ?? (() => Date.now()),
      merchant: options.merchant ?? { merchantId: 'SIMMERCHANT01', email: 'sandbox-merchant@example.com', name: 'Warrant Demo Store (sandbox)' },
      disputeResponseDays: options.disputeResponseDays ?? 10,
    };
    this.fetch = (input, init) => this.handle(new Request(input, init));
    this.registerRoutes();
  }

  get webhookId(): string {
    return this.opts.webhookId;
  }
  get credentials(): { clientId: string; clientSecret: string } {
    return { clientId: this.opts.clientId, clientSecret: this.opts.clientSecret };
  }

  /** Attach the function that receives webhook deliveries (the Warrant server POSTs them to its own webhook route). */
  setWebhookSink(sink: WebhookSink | null): void {
    this.sink = sink;
  }

  /** Called after anything changes (a request that is not a read, or the buyer or the dispute desk acting). */
  setChangeListener(listener: (() => void) | null): void {
    this.onChange = listener;
  }

  /** A copy of everything the simulator holds, safe to store as JSON. */
  snapshot(): SimulatorSnapshot {
    const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
    return {
      version: 1,
      counter: this.counter,
      orders: copy([...this.orders.values()]),
      captures: copy([...this.captures.values()]),
      disputes: copy([...this.disputes.values()]),
    };
  }

  /** Replace what the simulator holds with a snapshot taken earlier. Throws on anything that is not one. */
  restore(snapshot: SimulatorSnapshot): void {
    const valid = (rows: unknown): rows is Array<{ id: string }> => Array.isArray(rows) && rows.every((r) => isRec(r) && typeof r['id'] === 'string');
    if (!isRec(snapshot) || snapshot.version !== 1 || typeof snapshot.counter !== 'number' || !valid(snapshot.orders) || !valid(snapshot.captures) || !valid(snapshot.disputes)) {
      throw new Error('not a PayPal simulator snapshot');
    }
    const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
    this.orders.clear();
    this.captures.clear();
    this.disputes.clear();
    for (const o of copy(snapshot.orders)) this.orders.set(o.id, o);
    for (const c of copy(snapshot.captures)) this.captures.set(c.id, c);
    for (const d of copy(snapshot.disputes)) this.disputes.set(d.id, d);
    this.counter = snapshot.counter;
  }

  private touch(): void {
    this.onChange?.();
  }

  /** Resolve once every webhook delivery started so far has been handled. */
  async flush(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  // -------------------------------------------------------------------------------------------
  // Driver API: what a buyer does outside the REST API
  // -------------------------------------------------------------------------------------------

  /** The buyer approves the order in PayPal. Emits CHECKOUT.ORDER.APPROVED. */
  approveOrder(orderId: string, payer: SimPayer = DEFAULT_SIM_PAYER): void {
    const order = this.requireOrder(orderId);
    if (order.status === 'COMPLETED') throw new SimError(422, 'UNPROCESSABLE_ENTITY', 'order already captured', 'ORDER_ALREADY_CAPTURED');
    order.payer = payer;
    order.status = 'APPROVED';
    this.touch();
    this.emit('CHECKOUT.ORDER.APPROVED', 'checkout-order', this.renderOrder(order), `Checkout order ${order.id} approved`);
  }

  /** The buyer opens a dispute in the Resolution Center. Emits CUSTOMER.DISPUTE.CREATED. */
  openDispute(input: OpenDisputeInput): { disputeId: string } {
    const capture = this.captures.get(input.captureId);
    if (capture === undefined) throw new SimError(404, 'RESOURCE_NOT_FOUND', `capture ${input.captureId} not found`, 'INVALID_RESOURCE_ID');
    const now = this.opts.now();
    const unauthorised = input.reason === 'UNAUTHORISED';
    const dispute: DisputeRecord = {
      id: `PP-D-${String(++this.counter).padStart(6, '0')}`,
      captureId: capture.id,
      reason: input.reason,
      status: 'WAITING_FOR_SELLER_RESPONSE',
      stage: unauthorised ? 'CHARGEBACK' : 'INQUIRY',
      currency: capture.currency,
      amountCents: input.amountCents ?? capture.amountCents,
      createdAt: now,
      updatedAt: now,
      dueAt: now + (input.responseDueInSeconds ?? this.opts.disputeResponseDays * 86_400) * 1000,
      messages: [{ posted_by: 'BUYER', content: input.message.slice(0, 2000), time_posted: iso(now) }],
      evidences: [],
      offer: null,
      outcome: null,
    };
    this.disputes.set(dispute.id, dispute);
    this.touch();
    this.emit('CUSTOMER.DISPUTE.CREATED', 'dispute', this.renderDispute(dispute), `A new dispute opened with ${this.opts.merchant.name}`);
    return { disputeId: dispute.id };
  }

  /** The buyer accepts the seller's offer: PayPal refunds and the dispute resolves. */
  buyerAcceptsOffer(disputeId: string): void {
    const dispute = this.requireDispute(disputeId);
    if (dispute.offer === null || dispute.status !== 'WAITING_FOR_BUYER_RESPONSE') {
      throw new SimError(422, 'UNPROCESSABLE_ENTITY', 'there is no open offer to accept', ISSUE_ACTION_NOT_ALLOWED);
    }
    const offered = tryParseMoney(dispute.offer.seller_offered_amount.value) ?? dispute.amountCents;
    this.refundCapture(this.requireCapture(dispute.captureId), offered, `dispute ${dispute.id}`);
    this.resolve(dispute, 'ACCEPTED', offered);
    this.touch();
  }

  /** Make a capture exist without going through the order flow (not used by Warrant itself; useful in tests). */
  get state(): { orders: number; captures: number; disputes: number } {
    return { orders: this.orders.size, captures: this.captures.size, disputes: this.disputes.size };
  }

  // -------------------------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------------------------

  async handle(req: Request): Promise<Response> {
    try {
      return await this.dispatch(req);
    } finally {
      if (req.method !== 'GET') this.touch();
    }
  }

  private async dispatch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (req.method === 'POST' && path === '/v1/oauth2/token') return this.issueToken(req);
      const auth = req.headers.get('authorization') ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!this.tokens.has(token)) throw new SimError(401, 'AUTHENTICATION_FAILURE', 'Authentication failed due to invalid authentication credentials or a missing Authorization header.');

      for (const route of this.routes) {
        if (route.method !== req.method) continue;
        const match = route.pattern.exec(path);
        if (match === null) continue;
        const params: Record<string, string> = {};
        route.names.forEach((name, i) => {
          params[name] = decodeURIComponent(match[i + 1] ?? '');
        });
        const requestId = req.headers.get('paypal-request-id');
        const cacheKey = req.method === 'POST' && requestId !== null ? `${path}|${requestId}` : null;
        if (cacheKey !== null) {
          const cached = this.idempotent.get(cacheKey);
          if (cached !== undefined) return toResponse(cached);
        }
        const ctx: Ctx = {
          req,
          params,
          query: url.searchParams,
          requestId,
          mock: req.headers.get('paypal-mock-response'),
          json: async () => {
            try {
              const parsed: unknown = await req.json();
              if (!isRec(parsed)) throw new Error('not an object');
              return parsed;
            } catch {
              throw new SimError(400, 'INVALID_REQUEST', 'Request is not well-formed, syntactically incorrect, or violates schema.', 'MALFORMED_REQUEST_JSON');
            }
          },
        };
        const result = await route.handler(ctx);
        if (cacheKey !== null && result.status < 400) this.idempotent.set(cacheKey, result);
        return toResponse(result);
      }
      throw new SimError(404, 'RESOURCE_NOT_FOUND', `The specified resource does not exist: ${req.method} ${path}`, 'INVALID_RESOURCE_ID');
    } catch (error) {
      if (error instanceof SimError) return toResponse(errorResult(error));
      throw error;
    }
  }

  private issueToken(req: Request): Response {
    const auth = req.headers.get('authorization') ?? '';
    const expected = `Basic ${Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString('base64')}`;
    if (auth !== expected) {
      return toResponse({ status: 401, body: { error: 'invalid_client', error_description: 'Client Authentication failed' } });
    }
    const token = `SIM-TOKEN-${this.tokens.size + 1}`;
    this.tokens.add(token);
    return toResponse({ status: 200, body: { scope: 'https://uri.paypal.com/services/payments/payment', access_token: token, token_type: 'Bearer', app_id: 'SIM-APP', expires_in: 32_400, nonce: 'sim' } });
  }

  private registerRoutes(): void {
    const add = (method: string, path: string, handler: Route['handler']): void => {
      const names: string[] = [];
      const source = path.replace(/:([a-z]+)/g, (_m, name: string) => {
        names.push(name);
        return '([^/]+)';
      });
      this.routes.push({ method, pattern: new RegExp(`^${source}$`), names, handler });
    };

    // Orders v2
    add('POST', '/v2/checkout/orders', (c) => this.createOrder(c));
    add('GET', '/v2/checkout/orders/:id', (c) => ({ status: 200, body: this.renderOrder(this.requireOrder(c.params['id'] ?? '')) }));
    add('POST', '/v2/checkout/orders/:id/capture', (c) => this.captureOrder(c));
    add('POST', '/v2/checkout/orders/:id/track', (c) => this.addTracking(c));
    add('GET', '/v2/payments/captures/:id', (c) => ({ status: 200, body: this.renderCapture(this.requireCapture(c.params['id'] ?? '')) }));
    add('POST', '/v2/payments/captures/:id/refund', (c) => this.refund(c));

    // Disputes v1
    add('GET', '/v1/customer/disputes', (c) => this.listDisputes(c));
    add('POST', '/v1/customer/disputes', (c) => this.sandboxCreateDispute(c));
    add('GET', '/v1/customer/disputes/:id', (c) => ({ status: 200, body: this.renderDispute(this.requireDispute(c.params['id'] ?? '')) }));
    add('POST', '/v1/customer/disputes/:id/accept-claim', (c) => this.acceptClaim(c));
    add('POST', '/v1/customer/disputes/:id/make-offer', (c) => this.makeOffer(c));
    add('POST', '/v1/customer/disputes/:id/provide-evidence', (c) => this.provideEvidence(c));
    add('POST', '/v1/customer/disputes/:id/adjudicate', (c) => this.adjudicate(c));
    add('POST', '/v1/customer/disputes/:id/require-evidence', (c) => this.requireEvidence(c));

    // Webhooks
    add('POST', '/v1/notifications/verify-webhook-signature', (c) => this.verifyWebhook(c));
  }

  // -------------------------------------------------------------------------------------------
  // Orders and payments
  // -------------------------------------------------------------------------------------------

  private async createOrder(c: Ctx): Promise<Result> {
    const body = await c.json();
    if (body['intent'] !== 'CAPTURE') throw new SimError(422, 'UNPROCESSABLE_ENTITY', 'The simulator supports intent CAPTURE only.', 'INTENT_NOT_SUPPORTED');
    const units = body['purchase_units'];
    const unit = Array.isArray(units) && isRec(units[0]) ? units[0] : null;
    if (unit === null) throw new SimError(400, 'INVALID_REQUEST', 'purchase_units is required', 'MISSING_REQUIRED_PARAMETER');
    const total = parseAmount(unit['amount'], 'purchase_units[0].amount');
    const customId = str(unit['custom_id']);
    const invoiceId = str(unit['invoice_id']);
    if (customId !== null && customId.length > 255) throw new SimError(422, 'UNPROCESSABLE_ENTITY', 'custom_id is too long', 'FIELD_VALUE_TOO_LONG');
    if (invoiceId !== null && invoiceId.length > 127) throw new SimError(422, 'UNPROCESSABLE_ENTITY', 'invoice_id is too long', 'FIELD_VALUE_TOO_LONG');

    let lines: SimLine[] | null = null;
    if (Array.isArray(unit['items'])) {
      lines = unit['items'].filter(isRec).map((item) => {
        const unitPrice = parseAmount(item['unit_amount'], 'item.unit_amount');
        const quantity = Number(str(item['quantity']));
        if (!Number.isSafeInteger(quantity) || quantity < 1) throw new SimError(422, 'UNPROCESSABLE_ENTITY', 'item quantity must be a positive integer', 'INVALID_PARAMETER_VALUE');
        return { sku: str(item['sku']) ?? '', name: str(item['name']) ?? '', quantity, unitCents: unitPrice.cents };
      });
      const sum = lines.reduce((s, l) => s + l.unitCents * l.quantity, 0);
      const breakdown = isRec(unit['amount']) && isRec(unit['amount']['breakdown']) ? unit['amount']['breakdown'] : null;
      const itemTotal = breakdown === null ? null : parseAmount(breakdown['item_total'], 'amount.breakdown.item_total');
      if (itemTotal === null || itemTotal.cents !== sum || total.cents !== sum) {
        throw new SimError(422, 'UNPROCESSABLE_ENTITY', 'Item total mismatch.', 'ITEM_TOTAL_MISMATCH');
      }
    }

    const id = `SIMORDER${String(++this.counter).padStart(8, '0')}`;
    const order: OrderRecord = {
      id,
      status: 'PAYER_ACTION_REQUIRED',
      referenceId: str(unit['reference_id']),
      customId,
      invoiceId,
      description: str(unit['description']),
      currency: total.currency,
      totalCents: total.cents,
      lines,
      payer: null,
      captureIds: [],
      tracking: [],
      createdAt: this.opts.now(),
    };
    this.orders.set(id, order);
    return { status: 201, body: this.renderOrder(order) };
  }

  private captureOrder(c: Ctx): Result {
    const order = this.requireOrder(c.params['id'] ?? '');
    if (order.status === 'COMPLETED') throw new SimError(422, 'UNPROCESSABLE_ENTITY', 'Order already captured.', 'ORDER_ALREADY_CAPTURED');
    if (order.status !== 'APPROVED' || order.payer === null) {
      throw new SimError(422, 'UNPROCESSABLE_ENTITY', 'Order has not been approved by the payer.', 'ORDER_NOT_APPROVED');
    }
    if (c.mock !== null && c.mock.includes('INSTRUMENT_DECLINED')) {
      throw new SimError(422, 'UNPROCESSABLE_ENTITY', 'The instrument presented was either declined by the processor or bank, or it can\'t be used for this payment.', 'INSTRUMENT_DECLINED');
    }
    if (order.invoiceId !== null) {
      for (const other of this.captures.values()) {
        if (other.invoiceId === order.invoiceId) throw new SimError(422, 'UNPROCESSABLE_ENTITY', 'Duplicate invoice Id detected.', 'DUPLICATE_INVOICE_ID');
      }
    }
    const capture: CaptureRecord = {
      id: `SIMCAP${String(++this.counter).padStart(10, '0')}`,
      orderId: order.id,
      status: 'COMPLETED',
      currency: order.currency,
      amountCents: order.totalCents,
      refundedCents: 0,
      invoiceId: order.invoiceId,
      customId: order.customId,
      createdAt: this.opts.now(),
    };
    this.captures.set(capture.id, capture);
    order.captureIds.push(capture.id);
    order.status = 'COMPLETED';
    this.emit('PAYMENT.CAPTURE.COMPLETED', 'capture', this.renderCapture(capture), `Payment completed for ${formatMoney(capture.amountCents)} ${capture.currency}`);
    return { status: 201, body: this.renderOrder(order) };
  }

  private async addTracking(c: Ctx): Promise<Result> {
    const order = this.requireOrder(c.params['id'] ?? '');
    const body = await c.json();
    const captureId = str(body['capture_id']);
    if (captureId === null || !order.captureIds.includes(captureId)) {
      throw new SimError(422, 'UNPROCESSABLE_ENTITY', 'capture_id does not belong to this order', 'INVALID_PARAMETER_VALUE');
    }
    order.tracking.push({ captureId, trackingNumber: str(body['tracking_number']) ?? '', carrier: str(body['carrier']) ?? 'OTHER' });
    return { status: 200, body: this.renderOrder(order) };
  }

  private async refund(c: Ctx): Promise<Result> {
    const capture = this.requireCapture(c.params['id'] ?? '');
    const body = c.req.headers.get('content-length') === '0' ? {} : await c.json();
    const requested = body['amount'] === undefined ? capture.amountCents - capture.refundedCents : parseAmount(body['amount'], 'amount').cents;
    const refund = this.refundCapture(capture, requested, str(body['note_to_payer']) ?? 'refund');
    return { status: 201, body: { id: refund.id, status: 'COMPLETED', amount: amount(capture.currency, refund.cents), create_time: iso(this.opts.now()) } };
  }

  private refundCapture(capture: CaptureRecord, cents: Cents, _note: string): { id: string; cents: Cents } {
    if (cents <= 0 || capture.refundedCents + cents > capture.amountCents) {
      throw new SimError(422, 'UNPROCESSABLE_ENTITY', 'The refund amount must be less than or equal to the capture amount that has not yet been refunded.', 'REFUND_AMOUNT_EXCEEDED');
    }
    capture.refundedCents += cents;
    capture.status = capture.refundedCents === capture.amountCents ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    const refund = { id: `SIMREF${String(++this.counter).padStart(10, '0')}`, cents };
    this.emit(
      'PAYMENT.CAPTURE.REFUNDED',
      'refund',
      { id: refund.id, status: 'COMPLETED', amount: amount(capture.currency, cents), invoice_id: capture.invoiceId, custom_id: capture.customId, create_time: iso(this.opts.now()) },
      `A ${formatMoney(cents)} ${capture.currency} payment was refunded`,
    );
    return refund;
  }

  // -------------------------------------------------------------------------------------------
  // Disputes
  // -------------------------------------------------------------------------------------------

  private listDisputes(c: Ctx): Result {
    const state = c.query.get('dispute_state');
    const items = [...this.disputes.values()]
      .filter((d) => state === null || d.status === state)
      .map((d) => ({ dispute_id: d.id, reason: d.reason, status: d.status, dispute_life_cycle_stage: d.stage, create_time: iso(d.createdAt), update_time: iso(d.updatedAt) }));
    return { status: 200, body: { items, links: [] } };
  }

  private async sandboxCreateDispute(c: Ctx): Promise<Result> {
    const body = await c.json();
    const tx = Array.isArray(body['disputed_transactions']) && isRec(body['disputed_transactions'][0]) ? body['disputed_transactions'][0] : null;
    const captureId = tx === null ? null : str(tx['seller_transaction_id']);
    const reason = str(body['reason']);
    if (captureId === null || reason === null) throw new SimError(400, 'INVALID_REQUEST', 'disputed_transactions and reason are required', 'MISSING_REQUIRED_PARAMETER');
    const firstMessage = Array.isArray(body['messages']) && isRec(body['messages'][0]) ? str(body['messages'][0]['content']) : null;
    const dispute = this.openDispute({
      captureId,
      reason,
      message: firstMessage ?? 'The buyer opened a dispute.',
      ...(isRec(body['dispute_amount']) ? { amountCents: parseAmount(body['dispute_amount'], 'dispute_amount').cents } : {}),
    });
    return { status: 201, body: { links: [{ href: `https://api-m.sandbox.paypal.com/v1/customer/disputes/${dispute.disputeId}`, rel: 'self', method: 'GET' }] } };
  }

  private allowedOptions(d: DisputeRecord): { accept: string[]; offers: string[] } {
    if (d.status !== 'WAITING_FOR_SELLER_RESPONSE') return { accept: [], offers: [] };
    if (d.stage === 'CHARGEBACK') return { accept: ['REFUND'], offers: [] };
    const offers = d.reason === 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED' ? ['REFUND', 'REFUND_WITH_RETURN', 'REFUND_WITH_REPLACEMENT', 'REPLACEMENT_WITHOUT_REFUND'] : ['REFUND'];
    return { accept: ['REFUND', 'PARTIAL_REFUND'], offers };
  }

  private async acceptClaim(c: Ctx): Promise<Result> {
    const dispute = this.requireDispute(c.params['id'] ?? '');
    const body = await this.optionalJson(c);
    const allowed = this.allowedOptions(dispute);
    if (allowed.accept.length === 0) throw new SimError(422, 'UNPROCESSABLE_ENTITY', 'The dispute is not in a state where the claim can be accepted.', ISSUE_ACTION_NOT_ALLOWED);
    const type = str(body['accept_claim_type']) ?? 'REFUND';
    if (!allowed.accept.includes(type)) throw new SimError(422, 'UNPROCESSABLE_ENTITY', `accept_claim_type ${type} is not allowed for this dispute.`, 'INVALID_ACCEPT_CLAIM_TYPE');
    const capture = this.requireCapture(dispute.captureId);
    let refundCents = capture.amountCents - capture.refundedCents;
    if (type === 'PARTIAL_REFUND') {
      if (body['refund_amount'] === undefined) throw new SimError(422, 'UNPROCESSABLE_ENTITY', 'refund_amount is required for a partial refund.', 'MISSING_REQUIRED_PARAMETER');
      refundCents = parseAmount(body['refund_amount'], 'refund_amount').cents;
    }
    this.refundCapture(capture, refundCents, `dispute ${dispute.id}`);
    this.resolve(dispute, 'RESOLVED_BUYER_FAVOUR', refundCents);
    return { status: 200, body: { links: [] } };
  }

  private async makeOffer(c: Ctx): Promise<Result> {
    const dispute = this.requireDispute(c.params['id'] ?? '');
    const body = await c.json();
    const allowed = this.allowedOptions(dispute);
    if (allowed.offers.length === 0) throw new SimError(422, 'UNPROCESSABLE_ENTITY', 'An offer cannot be made in this dispute state or stage.', ISSUE_ACTION_NOT_ALLOWED);
    const type = str(body['offer_type']);
    if (type === null || !allowed.offers.includes(type)) throw new SimError(422, 'UNPROCESSABLE_ENTITY', `offer_type ${String(type)} is not allowed for this dispute.`, 'INVALID_OFFER_TYPE');
    const offered = body['offer_amount'] === undefined ? { currency: dispute.currency, cents: dispute.amountCents } : parseAmount(body['offer_amount'], 'offer_amount');
    dispute.offer = { offer_type: type, seller_offered_amount: amount(offered.currency, offered.cents), note: str(body['note']) ?? '' };
    dispute.status = 'WAITING_FOR_BUYER_RESPONSE';
    dispute.updatedAt = this.opts.now();
    this.emit('CUSTOMER.DISPUTE.UPDATED', 'dispute', this.renderDispute(dispute), `Dispute ${dispute.id} updated: seller made an offer`);
    return { status: 200, body: { links: [] } };
  }

  private async provideEvidence(c: Ctx): Promise<Result> {
    const dispute = this.requireDispute(c.params['id'] ?? '');
    if (dispute.status !== 'WAITING_FOR_SELLER_RESPONSE') {
      throw new SimError(422, 'UNPROCESSABLE_ENTITY', 'Evidence can be provided only while the dispute waits for the seller.', ISSUE_ACTION_NOT_ALLOWED);
    }
    const contentType = c.req.headers.get('content-type') ?? '';
    let input: Record<string, unknown>;
    if (contentType.includes('multipart/')) {
      const form = await c.req.formData();
      const part = form.get('input');
      if (part === null) throw new SimError(400, 'INVALID_REQUEST', 'The multipart request needs an `input` part.', 'MISSING_REQUIRED_PARAMETER');
      const text = typeof part === 'string' ? part : await part.text();
      try {
        const parsed: unknown = JSON.parse(text);
        if (!isRec(parsed)) throw new Error('not an object');
        input = parsed;
      } catch {
        throw new SimError(400, 'INVALID_REQUEST', 'The `input` part is not valid JSON.', 'MALFORMED_REQUEST_JSON');
      }
    } else {
      input = await c.json();
    }
    const evidences = Array.isArray(input['evidences']) ? input['evidences'].filter(isRec) : [];
    if (evidences.length === 0) throw new SimError(422, 'UNPROCESSABLE_ENTITY', 'At least one evidence entry is required.', 'MISSING_REQUIRED_PARAMETER');
    for (const e of evidences) {
      const entry: DisputeRecord['evidences'][number] = { evidence_type: str(e['evidence_type']) ?? 'OTHER', source: 'SUBMITTED_BY_SELLER' };
      const notes = str(e['notes']);
      if (notes !== null) {
        if (notes.length > 2000) throw new SimError(422, 'UNPROCESSABLE_ENTITY', 'notes is longer than 2000 characters.', 'FIELD_VALUE_TOO_LONG');
        entry.notes = notes;
      }
      if (e['evidence_info'] !== undefined) entry.evidence_info = e['evidence_info'];
      dispute.evidences.push(entry);
    }
    dispute.status = 'UNDER_REVIEW';
    dispute.updatedAt = this.opts.now();
    this.emit('CUSTOMER.DISPUTE.UPDATED', 'dispute', this.renderDispute(dispute), `Dispute ${dispute.id} updated: seller provided evidence`);
    return { status: 200, body: { links: [] } };
  }

  private async adjudicate(c: Ctx): Promise<Result> {
    const dispute = this.requireDispute(c.params['id'] ?? '');
    const body = await c.json();
    if (dispute.status !== 'UNDER_REVIEW') throw new SimError(422, 'UNPROCESSABLE_ENTITY', 'Only a dispute under review can be adjudicated.', ISSUE_ACTION_NOT_ALLOWED);
    const outcome = str(body['adjudication_outcome']);
    if (outcome === 'BUYER_FAVOR') {
      const capture = this.requireCapture(dispute.captureId);
      const refundable = capture.amountCents - capture.refundedCents;
      const cents = Math.min(dispute.amountCents, refundable);
      if (cents > 0) this.refundCapture(capture, cents, `dispute ${dispute.id}`);
      this.resolve(dispute, 'RESOLVED_BUYER_FAVOUR', cents);
    } else if (outcome === 'SELLER_FAVOR') {
      this.resolve(dispute, 'RESOLVED_SELLER_FAVOUR', 0);
    } else {
      throw new SimError(400, 'INVALID_REQUEST', 'adjudication_outcome must be BUYER_FAVOR or SELLER_FAVOR', 'INVALID_PARAMETER_VALUE');
    }
    return { status: 200, body: { links: [] } };
  }

  private async requireEvidence(c: Ctx): Promise<Result> {
    const dispute = this.requireDispute(c.params['id'] ?? '');
    const body = await c.json();
    if (dispute.status !== 'UNDER_REVIEW') throw new SimError(422, 'UNPROCESSABLE_ENTITY', 'The dispute must be under review.', ISSUE_ACTION_NOT_ALLOWED);
    dispute.status = body['action'] === 'BUYER_EVIDENCE' ? 'WAITING_FOR_BUYER_RESPONSE' : 'WAITING_FOR_SELLER_RESPONSE';
    dispute.updatedAt = this.opts.now();
    this.emit('CUSTOMER.DISPUTE.UPDATED', 'dispute', this.renderDispute(dispute), `Dispute ${dispute.id} updated`);
    return { status: 200, body: { links: [] } };
  }

  private async optionalJson(c: Ctx): Promise<Record<string, unknown>> {
    const type = c.req.headers.get('content-type') ?? '';
    if (type.includes('multipart/')) {
      const form = await c.req.formData();
      const part = form.get('input');
      if (part === null) return {};
      const text = typeof part === 'string' ? part : await part.text();
      try {
        const parsed: unknown = JSON.parse(text);
        return isRec(parsed) ? parsed : {};
      } catch {
        return {};
      }
    }
    const text = await c.req.text();
    if (text.trim().length === 0) return {};
    try {
      const parsed: unknown = JSON.parse(text);
      return isRec(parsed) ? parsed : {};
    } catch {
      throw new SimError(400, 'INVALID_REQUEST', 'Request is not well-formed.', 'MALFORMED_REQUEST_JSON');
    }
  }

  private resolve(dispute: DisputeRecord, code: string, refundedCents: Cents): void {
    dispute.status = 'RESOLVED';
    dispute.updatedAt = this.opts.now();
    dispute.outcome = { outcome_code: code, ...(refundedCents > 0 ? { amount_refunded: amount(dispute.currency, refundedCents) } : {}) };
    this.emit('CUSTOMER.DISPUTE.RESOLVED', 'dispute', this.renderDispute(dispute), `Dispute ${dispute.id} resolved`);
  }

  // -------------------------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------------------------

  private signature(transmissionId: string, transmissionTime: string, webhookId: string, body: string): string {
    const digest = createHash('sha256').update(body).digest('hex');
    return createHmac('sha256', this.opts.webhookSecret).update(`${transmissionId}|${transmissionTime}|${webhookId}|${digest}`).digest('base64');
  }

  private emit(eventType: string, resourceType: string, resource: unknown, summary: string): void {
    const now = this.opts.now();
    const id = `WH-SIM-${String(++this.counter).padStart(8, '0')}`;
    const body = JSON.stringify({ id, event_version: '1.0', create_time: iso(now), resource_type: resourceType, event_type: eventType, summary, resource });
    const transmissionTime = iso(now);
    const delivery: WebhookDelivery = {
      headers: {
        'content-type': 'application/json',
        'paypal-transmission-id': id,
        'paypal-transmission-time': transmissionTime,
        'paypal-transmission-sig': this.signature(id, transmissionTime, this.opts.webhookId, body),
        'paypal-cert-url': 'https://api-m.sandbox.paypal.com/v1/notifications/certs/SIMULATOR',
        'paypal-auth-algo': 'SIM-HMAC-SHA256',
      },
      body,
    };
    this.deliveries.push(delivery);
    const sink = this.sink;
    if (sink === null) return;
    const task: Promise<void> = Promise.resolve()
      .then(() => sink(delivery))
      .catch(() => undefined)
      .finally(() => {
        this.pending.delete(task);
      });
    this.pending.add(task);
  }

  private async verifyWebhook(c: Ctx): Promise<Result> {
    const body = await c.json();
    const event = body['webhook_event'];
    const transmissionId = str(body['transmission_id']);
    const transmissionTime = str(body['transmission_time']);
    const signature = str(body['transmission_sig']);
    const webhookId = str(body['webhook_id']);
    if (event === undefined || transmissionId === null || transmissionTime === null || signature === null || webhookId === null) {
      return { status: 200, body: { verification_status: 'FAILURE' } };
    }
    const expected = Buffer.from(this.signature(transmissionId, transmissionTime, this.opts.webhookId, JSON.stringify(event)));
    const given = Buffer.from(signature);
    const ok = webhookId === this.opts.webhookId && expected.length === given.length && timingSafeEqual(expected, given);
    return { status: 200, body: { verification_status: ok ? 'SUCCESS' : 'FAILURE' } };
  }

  // -------------------------------------------------------------------------------------------
  // Rendering and lookups
  // -------------------------------------------------------------------------------------------

  private requireOrder(id: string): OrderRecord {
    const order = this.orders.get(id);
    if (order === undefined) throw new SimError(404, 'RESOURCE_NOT_FOUND', 'The specified resource does not exist.', 'INVALID_RESOURCE_ID');
    return order;
  }
  private requireCapture(id: string): CaptureRecord {
    const capture = this.captures.get(id);
    if (capture === undefined) throw new SimError(404, 'RESOURCE_NOT_FOUND', 'The specified resource does not exist.', 'INVALID_RESOURCE_ID');
    return capture;
  }
  private requireDispute(id: string): DisputeRecord {
    const dispute = this.disputes.get(id);
    if (dispute === undefined) throw new SimError(404, 'RESOURCE_NOT_FOUND', 'The specified resource does not exist.', 'INVALID_RESOURCE_ID');
    return dispute;
  }

  private renderCapture(capture: CaptureRecord): unknown {
    return {
      id: capture.id,
      status: capture.status,
      amount: amount(capture.currency, capture.amountCents),
      invoice_id: capture.invoiceId ?? undefined,
      custom_id: capture.customId ?? undefined,
      final_capture: true,
      create_time: iso(capture.createdAt),
      update_time: iso(capture.createdAt),
      links: [],
    };
  }

  private renderOrder(order: OrderRecord): unknown {
    const captures = order.captureIds.map((id) => this.renderCapture(this.requireCapture(id)));
    return {
      id: order.id,
      intent: 'CAPTURE',
      status: order.status,
      payer:
        order.payer === null
          ? undefined
          : { payer_id: order.payer.payerId, email_address: order.payer.email, name: { given_name: order.payer.name.split(' ')[0] ?? '', surname: order.payer.name.split(' ').slice(1).join(' ') } },
      purchase_units: [
        {
          reference_id: order.referenceId ?? undefined,
          custom_id: order.customId ?? undefined,
          invoice_id: order.invoiceId ?? undefined,
          description: order.description ?? undefined,
          amount: { ...amount(order.currency, order.totalCents), breakdown: order.lines === null ? undefined : { item_total: amount(order.currency, order.totalCents) } },
          items: order.lines?.map((l) => ({ name: l.name, sku: l.sku, quantity: String(l.quantity), unit_amount: amount(order.currency, l.unitCents) })),
          payee: { merchant_id: this.opts.merchant.merchantId, email_address: this.opts.merchant.email },
          payments: captures.length === 0 ? undefined : { captures },
        },
      ],
      create_time: iso(order.createdAt),
      links:
        order.status === 'PAYER_ACTION_REQUIRED'
          ? [
              { href: `https://api-m.sandbox.paypal.com/v2/checkout/orders/${order.id}`, rel: 'self', method: 'GET' },
              { href: `${this.opts.approvalUrl}?token=${order.id}`, rel: 'payer-action', method: 'GET' },
            ]
          : [{ href: `https://api-m.sandbox.paypal.com/v2/checkout/orders/${order.id}`, rel: 'self', method: 'GET' }],
    };
  }

  private renderDispute(d: DisputeRecord): unknown {
    const capture = this.requireCapture(d.captureId);
    const order = this.requireOrder(capture.orderId);
    const allowed = this.allowedOptions(d);
    return {
      dispute_id: d.id,
      create_time: iso(d.createdAt),
      update_time: iso(d.updatedAt),
      disputed_transactions: [
        {
          seller_transaction_id: capture.id,
          create_time: iso(capture.createdAt),
          transaction_status: capture.status === 'COMPLETED' ? 'COMPLETED' : capture.status,
          gross_amount: amount(capture.currency, capture.amountCents),
          invoice_number: capture.invoiceId ?? undefined,
          custom: capture.customId ?? undefined,
          buyer: { name: order.payer?.name ?? 'Sandbox Buyer' },
          seller: { merchant_id: this.opts.merchant.merchantId, email: this.opts.merchant.email, name: this.opts.merchant.name },
          items: order.lines?.map((l) => ({ item_id: l.sku, item_description: l.name, item_quantity: String(l.quantity) })),
        },
      ],
      reason: d.reason,
      status: d.status,
      dispute_amount: amount(d.currency, d.amountCents),
      dispute_life_cycle_stage: d.stage,
      dispute_channel: 'INTERNAL',
      messages: d.messages,
      evidences: d.evidences,
      seller_response_due_date: iso(d.dueAt),
      offer: d.offer === null ? undefined : { seller_offered_amount: d.offer.seller_offered_amount, offer_type: d.offer.offer_type },
      dispute_outcome: d.outcome ?? undefined,
      allowed_response_options: {
        accept_claim: { accept_claim_types: allowed.accept },
        make_offer: { offer_types: allowed.offers },
      },
      links: [{ href: `https://api-m.sandbox.paypal.com/v1/customer/disputes/${d.id}`, rel: 'self', method: 'GET' }],
    };
  }
}

function errorResult(error: SimError): Result {
  const name = error.errorName;
  return {
    status: error.status,
    body: {
      name,
      message: error.message,
      debug_id: `SIMDEBUG${Math.abs(hash32(`${name}${error.message}`)).toString(16).padStart(8, '0')}`,
      details: error.issue === null ? [] : [{ issue: error.issue, description: error.message }],
      links: [],
    },
  };
}

function hash32(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  return h;
}

function toResponse(result: Result): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  const body = result.body;
  if (isRec(body) && typeof body['debug_id'] === 'string') headers.set('paypal-debug-id', body['debug_id']);
  return new Response(body === null || body === undefined ? null : JSON.stringify(body), { status: result.status, headers });
}
