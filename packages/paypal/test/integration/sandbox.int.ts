import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PayPalClient, PayPalError, SANDBOX_BASE_URL } from '../../src';

/**
 * Integration tests against the real PayPal sandbox: `pnpm test:int`. They need the sandbox app's credentials in the
 * environment (or the repository's `.env`):
 *
 *   PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET   the sandbox app's keys
 *   PAYPAL_WEBHOOK_ID                        optional; enables the webhook-verification test
 *
 * What they cover is what can be done without a person in the loop: token, order creation with the warrant references,
 * idempotent retries, lookups, errors, the dispute list and the refusal of a forged webhook. Approving an order as the
 * sandbox buyer needs a browser, so capture, tracking, refunds and the dispute actions are covered by the simulator tests
 * and, against the real sandbox, by walking through docs/setup.md once by hand. Nothing here is ever paid.
 */

const clientId = process.env['PAYPAL_CLIENT_ID']?.trim();
const clientSecret = process.env['PAYPAL_CLIENT_SECRET']?.trim();
const webhookId = process.env['PAYPAL_WEBHOOK_ID']?.trim();
const configured = clientId !== undefined && clientId !== '' && clientSecret !== undefined && clientSecret !== '' && (process.env['PAYPAL_ENV'] ?? 'sandbox').toLowerCase() === 'sandbox';

if (!configured) {
  console.warn('PayPal sandbox integration tests skipped: set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (sandbox keys) and leave PAYPAL_ENV unset or "sandbox".');
}

describe.skipIf(!configured)('PayPal sandbox', () => {
  const client = new PayPalClient({ baseUrl: SANDBOX_BASE_URL, clientId: clientId ?? '', clientSecret: clientSecret ?? '' });
  const run = randomUUID().slice(0, 8);
  const input = {
    referenceId: `int-${run}`,
    customId: `wrt:int-${run}`,
    invoiceId: `WRT-INT-${run}`,
    description: 'Warrant integration test (never paid)',
    currency: 'USD',
    lines: [
      { sku: 'INT-1', name: 'Integration test item', quantity: 2, unitCents: 1250 },
      { sku: 'INT-2', name: 'Second item', quantity: 1, unitCents: 99 },
    ],
    totalCents: 2599,
    brandName: 'Warrant integration test',
    returnUrl: 'https://example.com/return',
    cancelUrl: 'https://example.com/cancel',
  } as const;

  it('creates an order that carries the warrant references, the lines and an approval link', async () => {
    const order = await client.createOrder(input, `int-create-${run}`);
    expect(order.id).toBeTruthy();
    expect(['CREATED', 'PAYER_ACTION_REQUIRED']).toContain(order.status);
    expect(order.customId).toBe(input.customId);
    expect(order.invoiceId).toBe(input.invoiceId);
    expect(order.totalCents).toBe(2599);
    expect(order.approveUrl).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\//);
    expect(order.lines?.map((l) => [l.sku, l.quantity, l.unitAmountCents])).toEqual([['INT-1', 2, 1250], ['INT-2', 1, 99]]);

    const again = await client.getOrder(order.id);
    expect(again.id).toBe(order.id);
    expect(again.customId).toBe(input.customId);
    expect(again.captures).toEqual([]);
  });

  it('treats a retried create with the same request id as the same order', async () => {
    const first = await client.createOrder({ ...input, invoiceId: `${input.invoiceId}-idem` }, `int-idem-${run}`);
    const second = await client.createOrder({ ...input, invoiceId: `${input.invoiceId}-idem` }, `int-idem-${run}`);
    expect(second.id).toBe(first.id);
  });

  it('reports an unknown order as a PayPal error with a debug id', async () => {
    const error = await client.getOrder('0AAAAAAAAAAAAAAAA').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PayPalError);
    expect((error as PayPalError).status).toBe(404);
    expect((error as PayPalError).debugId).toBeTruthy();
  });

  it('lists disputes (possibly none) with the fields the dispute agent reads', async () => {
    const disputes = await client.listDisputes({ pageSize: 5 });
    expect(Array.isArray(disputes)).toBe(true);
    for (const d of disputes) {
      expect(d.id).toBeTruthy();
      expect(d.amountCents).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(d.allowedAcceptClaimTypes)).toBe(true);
    }
  });

  it.skipIf(webhookId === undefined || webhookId === '')('refuses a forged webhook delivery', async () => {
    const genuine = await client.verifyWebhookSignature(
      { authAlgo: 'SHA256withRSA', certUrl: 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-forged', transmissionId: randomUUID(), transmissionSig: 'AAAA', transmissionTime: new Date().toISOString() },
      JSON.stringify({ id: 'WH-FORGED', event_type: 'CUSTOMER.DISPUTE.CREATED', resource: {} }),
      webhookId ?? '',
    ).catch((e: unknown) => e);
    // PayPal answers FAILURE for a bad signature; it may instead reject the unfetchable certificate outright. Either way it is not accepted.
    expect(genuine).not.toBe(true);
  });
});
