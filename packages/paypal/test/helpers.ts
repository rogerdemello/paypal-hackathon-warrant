import { PayPalClient, PayPalSimulator, type CreateOrderInput, type OrderSummary, type SimPayer, type WebhookDelivery } from '../src';

export const T0_MS = Date.UTC(2026, 10, 4, 10, 0, 0);

export interface Harness {
  readonly sim: PayPalSimulator;
  readonly client: PayPalClient;
  readonly clock: { ms: number };
  readonly deliveries: WebhookDelivery[];
  /** How many token requests the simulator has seen. */
  readonly fetchLog: string[];
}

export function harness(options: { maxRetries?: number; fetchWrapper?: (inner: typeof fetch) => typeof fetch } = {}): Harness {
  const clock = { ms: T0_MS };
  const sim = new PayPalSimulator({ approvalUrl: 'http://localhost:8787/sim/paypal/approve', now: () => clock.ms });
  const deliveries: WebhookDelivery[] = [];
  sim.setWebhookSink((d) => {
    deliveries.push(d);
    return Promise.resolve();
  });
  const fetchLog: string[] = [];
  const logged: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    fetchLog.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
    return sim.fetch(input, init);
  };
  const client = new PayPalClient({
    baseUrl: 'https://api-m.sandbox.paypal.com',
    ...sim.credentials,
    fetch: options.fetchWrapper === undefined ? logged : options.fetchWrapper(logged),
    now: () => clock.ms,
    sleep: () => Promise.resolve(),
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
  });
  return { sim, client, clock, deliveries, fetchLog };
}

export function orderInput(overrides: Partial<CreateOrderInput> = {}): CreateOrderInput {
  return {
    referenceId: 'ord_1',
    customId: 'wrt:crt_01JEXAMPLE',
    invoiceId: 'WRT-abcdefghijklmnop',
    description: 'Agent purchase (sandbox demo)',
    currency: 'USD',
    lines: [{ sku: 'c3_abc123', name: 'Desk converter 32in', quantity: 1, unitCents: 8900 }],
    totalCents: 8900,
    brandName: 'Demo Store (sandbox)',
    returnUrl: 'http://localhost:8787/merchant/paypal/return',
    cancelUrl: 'http://localhost:8787/merchant/paypal/cancel',
    ...overrides,
  };
}

/** Create, approve and capture an order; returns the completed order and its capture id. */
export async function paidOrder(h: Harness, overrides: Partial<CreateOrderInput> = {}, payer?: SimPayer): Promise<{ order: OrderSummary; captureId: string }> {
  const input = orderInput(overrides);
  const created = await h.client.createOrder(input, `create-${input.referenceId}`);
  h.sim.approveOrder(created.id, payer);
  const order = await h.client.captureOrder(created.id, `capture-${input.referenceId}`);
  const captureId = order.captures[0]?.id;
  if (captureId === undefined) throw new Error('capture missing');
  return { order, captureId };
}
