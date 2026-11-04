import { PayPalClient, PayPalSimulator, SANDBOX_BASE_URL } from '@warrant/paypal';
import { describe, expect, it } from 'vitest';
import { doctorPassed, runPayPalDoctor, type DoctorOptions } from '../src/paypal-doctor';

/** The doctor is tested against the simulator (which speaks PayPal's API) and against clients that fail in the ways a real setup does. */

function simulated(over: Partial<{ clientSecret: string; fetch: typeof fetch }> = {}) {
  const simulator = new PayPalSimulator({
    approvalUrl: 'http://localhost:8787/sim/paypal/approve',
    now: () => Date.UTC(2026, 5, 1, 12),
    merchant: { merchantId: 'SIMMERCHANT01', email: 'm@example.com', name: 'Test merchant' },
  });
  const client = new PayPalClient({
    baseUrl: SANDBOX_BASE_URL,
    clientId: simulator.credentials.clientId,
    clientSecret: over.clientSecret ?? simulator.credentials.clientSecret,
    fetch: over.fetch ?? simulator.fetch,
    sleep: () => Promise.resolve(),
    maxRetries: 0,
  });
  return { simulator, client };
}

const options = (client: PayPalClient, webhookId: string | null, over: Partial<DoctorOptions> = {}): DoctorOptions => ({
  client,
  environment: 'simulator',
  webhookId,
  merchantId: 'SIMMERCHANT01',
  publicBaseUrl: 'https://warrant.example.com',
  returnUrl: 'http://localhost:5173/checkout/return',
  cancelUrl: 'http://localhost:5173/checkout/cancel',
  runId: 'abc',
  ...over,
});

const by = (checks: Awaited<ReturnType<typeof runPayPalDoctor>>, name: string) => checks.find((c) => c.name === name);

describe('paypal:doctor', () => {
  it('passes against a working setup and says what it did', async () => {
    const { simulator, client } = simulated();
    const checks = await runPayPalDoctor(options(client, simulator.webhookId));
    expect(doctorPassed(checks)).toBe(true);
    expect(by(checks, 'Credentials and Orders API')?.detail).toMatch(/created test order .* never paid/);
    expect(by(checks, 'Buyer approval link')?.ok).toBe(true);
    expect(by(checks, 'Order lookup')?.ok).toBe(true);
    expect(by(checks, 'Disputes API')?.detail).toMatch(/no disputes yet/);
    expect(by(checks, 'Webhook id')?.detail).toMatch(/refused a forged delivery/);
    expect(by(checks, 'Environment')?.detail).toMatch(/simulator, not PayPal/);
  });

  it('points at the keys when the credentials are wrong, and does not go on to claim other things work', async () => {
    const { client } = simulated({ clientSecret: 'wrong' });
    const checks = await runPayPalDoctor(options(client, 'WH-1'));
    expect(doctorPassed(checks)).toBe(false);
    expect(by(checks, 'Credentials and Orders API')).toMatchObject({ ok: false });
    expect(by(checks, 'Credentials and Orders API')?.detail).toMatch(/PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET/);
    expect(by(checks, 'Order lookup')).toBeUndefined();
  });

  it('reports a missing webhook id and merchant id as warnings, not failures', async () => {
    const { client } = simulated();
    const checks = await runPayPalDoctor(options(client, null, { merchantId: null }));
    expect(by(checks, 'Webhook id')).toMatchObject({ ok: false, optional: true });
    expect(by(checks, 'Merchant id')).toMatchObject({ ok: false, optional: true });
    expect(doctorPassed(checks)).toBe(true);
  });

  it('warns that PayPal cannot reach a local address, only against the real sandbox', async () => {
    const { simulator, client } = simulated();
    const local = await runPayPalDoctor(options(client, simulator.webhookId, { environment: 'sandbox', publicBaseUrl: 'http://localhost:8787' }));
    expect(by(local, 'Public address')).toMatchObject({ ok: false, optional: true });
    expect(by(local, 'Public address')?.detail).toMatch(/tunnel/);
    const hosted = await runPayPalDoctor(options(client, simulator.webhookId, { environment: 'sandbox' }));
    expect(by(hosted, 'Public address')).toBeUndefined();
    const simulatorOnly = await runPayPalDoctor(options(client, simulator.webhookId, { publicBaseUrl: 'http://localhost:8787' }));
    expect(by(simulatorOnly, 'Public address')).toBeUndefined();
  });

  it('explains how to enable the Disputes API when only that call fails', async () => {
    const { simulator } = simulated();
    const guarded: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/v1/customer/disputes')) {
        return new Response(JSON.stringify({ name: 'NOT_AUTHORIZED', message: 'Authorization failed', debug_id: 'dbg-1' }), { status: 403, headers: { 'content-type': 'application/json', 'paypal-debug-id': 'dbg-1' } });
      }
      return simulator.fetch(input, init);
    };
    const client = new PayPalClient({ baseUrl: SANDBOX_BASE_URL, ...simulator.credentials, fetch: guarded, sleep: () => Promise.resolve(), maxRetries: 0 });
    const checks = await runPayPalDoctor(options(client, simulator.webhookId));
    expect(doctorPassed(checks)).toBe(false);
    expect(by(checks, 'Disputes API')?.detail).toMatch(/403.*Disputes feature is enabled/s);
    expect(by(checks, 'Credentials and Orders API')?.ok).toBe(true);
  });

  it('refuses a webhook id that would accept a forged delivery, and reports a webhook call that errors', async () => {
    const { simulator } = simulated();
    const respond = (verification: unknown, status = 200): typeof fetch => async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('verify-webhook-signature')) return new Response(JSON.stringify(verification), { status, headers: { 'content-type': 'application/json' } });
      return simulator.fetch(input, init);
    };
    const make = (f: typeof fetch) => new PayPalClient({ baseUrl: SANDBOX_BASE_URL, ...simulator.credentials, fetch: f, sleep: () => Promise.resolve(), maxRetries: 0 });
    const accepting = await runPayPalDoctor(options(make(respond({ verification_status: 'SUCCESS' })), 'WH-1'));
    expect(by(accepting, 'Webhook id')).toMatchObject({ ok: false });
    expect(by(accepting, 'Webhook id')?.detail).toMatch(/do not use this webhook id/);
    const failing = await runPayPalDoctor(options(make(respond({ name: 'INVALID_RESOURCE_ID', message: 'Invalid webhook id' }, 400)), 'WH-nope'));
    expect(by(failing, 'Webhook id')?.detail).toMatch(/Invalid webhook id.*PAYPAL_WEBHOOK_ID/s);
  });
});
