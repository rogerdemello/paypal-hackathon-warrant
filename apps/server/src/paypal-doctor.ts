import { PayPalError, type PayPalClient } from '@warrant/paypal';

/**
 * `pnpm paypal:doctor`: the first thing to run after putting sandbox credentials in `.env`. It makes a handful of small,
 * harmless calls and says plainly what worked and what to change. It creates one unpaid test order for one dollar (which
 * PayPal lets expire) and reads the dispute list; it never captures, refunds or answers anything.
 */

export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  /** What was found, or what to change. */
  readonly detail: string;
  /** A failed optional check is reported but does not make the run fail. */
  readonly optional?: boolean;
}

export interface DoctorOptions {
  readonly client: PayPalClient;
  readonly environment: 'sandbox' | 'simulator';
  readonly webhookId: string | null;
  readonly merchantId: string | null;
  readonly publicBaseUrl: string;
  readonly returnUrl: string;
  readonly cancelUrl: string;
  /** A unique suffix for the test order's invoice id. */
  readonly runId: string;
}

const describeError = (error: unknown): string => {
  if (error instanceof PayPalError) return `${error.message} (HTTP ${error.status}${error.code === null ? '' : `, ${error.code}`}${error.debugId === null ? '' : `, PayPal debug id ${error.debugId}`})`;
  return error instanceof Error ? error.message : String(error);
};

const isLocal = (url: string): boolean => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url);

export async function runPayPalDoctor(options: DoctorOptions): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const add = (check: DoctorCheck): void => void checks.push(check);

  checks.push({
    name: 'Environment',
    ok: true,
    detail: options.environment === 'sandbox' ? 'PayPal sandbox (api-m.sandbox.paypal.com)' : 'the built-in simulator, not PayPal: set PAYPAL_ENV=sandbox and the sandbox credentials to test the real thing',
  });

  let orderId: string | null = null;
  try {
    const order = await options.client.createOrder(
      {
        referenceId: 'doctor',
        customId: 'wrt:doctor',
        invoiceId: `WRT-DOCTOR-${options.runId}`.slice(0, 127),
        description: 'Warrant paypal:doctor test order (never paid)',
        currency: 'USD',
        lines: [{ sku: 'DOCTOR-1', name: 'Warrant doctor test', quantity: 1, unitCents: 100 }],
        totalCents: 100,
        brandName: 'Warrant doctor',
        returnUrl: options.returnUrl,
        cancelUrl: options.cancelUrl,
      },
      `doctor-${options.runId}`,
    );
    orderId = order.id;
    add({ name: 'Credentials and Orders API', ok: true, detail: `got an access token and created test order ${order.id} (${order.status}, $1.00); it is never paid and will expire` });
    if (order.approveUrl === null) add({ name: 'Buyer approval link', ok: false, detail: 'the order has no approval link; the checkout would have nowhere to send the buyer' });
    else add({ name: 'Buyer approval link', ok: true, detail: 'the order carries a link for the buyer to approve it' });
  } catch (error) {
    const unauthorised = error instanceof PayPalError && (error.status === 401 || error.status === 403);
    add({
      name: 'Credentials and Orders API',
      ok: false,
      detail: `${describeError(error)}${unauthorised ? '. Check PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are the sandbox keys of the same app, and that PAYPAL_ENV=sandbox.' : ''}`,
    });
  }

  if (orderId !== null) {
    try {
      const fetched = await options.client.getOrder(orderId);
      add({ name: 'Order lookup', ok: fetched.customId === 'wrt:doctor', detail: fetched.customId === 'wrt:doctor' ? 'read the order back with the warrant reference intact (custom_id)' : 'the order came back without the custom_id Warrant uses to link a payment to its signed cart' });
    } catch (error) {
      add({ name: 'Order lookup', ok: false, detail: describeError(error) });
    }
  }

  try {
    const disputes = await options.client.listDisputes({ pageSize: 5 });
    add({ name: 'Disputes API', ok: true, detail: disputes.length === 0 ? 'reachable; no disputes yet' : `reachable; ${disputes.length} dispute${disputes.length === 1 ? '' : 's'} listed (${[...new Set(disputes.map((d) => d.status))].join(', ')})` });
  } catch (error) {
    add({ name: 'Disputes API', ok: false, detail: `${describeError(error)}. In the PayPal developer dashboard, open the app and make sure the Disputes feature is enabled for it.` });
  }

  if (options.webhookId === null) {
    add({ name: 'Webhook id', ok: false, optional: true, detail: 'PAYPAL_WEBHOOK_ID is not set, so deliveries cannot be verified. Create the webhook in the dashboard (see docs/setup.md).' });
  } else {
    try {
      const accepted = await options.client.verifyWebhookSignature(
        { authAlgo: 'SHA256withRSA', certUrl: 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-doctor', transmissionId: 'doctor', transmissionSig: 'AAAA', transmissionTime: '2026-01-01T00:00:00Z' },
        '{"id":"WH-DOCTOR","event_type":"DOCTOR.CHECK"}',
        options.webhookId,
      );
      add({
        name: 'Webhook id',
        ok: !accepted,
        detail: accepted ? 'PayPal accepted a forged delivery as genuine; do not use this webhook id' : 'PayPal answered and refused a forged delivery, as it should; the id can be used to verify real ones',
      });
    } catch (error) {
      add({ name: 'Webhook id', ok: false, detail: `${describeError(error)}. Check PAYPAL_WEBHOOK_ID is the id of the webhook created for this app.` });
    }
  }

  if (options.merchantId === null) add({ name: 'Merchant id', ok: false, optional: true, detail: 'PAYPAL_MERCHANT_ID is not set; it is the audience of every warrant and must be the sandbox business account\'s merchant id' });
  else add({ name: 'Merchant id', ok: true, detail: `set (${options.merchantId}); it must be the merchant id of the sandbox business account that receives the payments` });

  if (options.environment === 'sandbox' && isLocal(options.publicBaseUrl)) {
    add({ name: 'Public address', ok: false, optional: true, detail: `PUBLIC_BASE_URL is ${options.publicBaseUrl}; PayPal cannot deliver webhooks to your own computer. Use a tunnel (docs/setup.md); until then orders finish when the buyer returns to the shop, and the console's "Refresh from PayPal" re-reads a dispute.` });
  }
  return checks;
}

/** A run passes when no required check failed. */
export const doctorPassed = (checks: readonly DoctorCheck[]): boolean => checks.every((c) => c.ok || c.optional === true);
