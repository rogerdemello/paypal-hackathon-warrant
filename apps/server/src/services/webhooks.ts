import type { WebhookDelivery } from '@warrant/paypal';
import type { WebhookHeaders } from '@warrant/paypal';
import type { MerchantService } from './merchant';

/** PayPal's signature headers, from a lookup that is case-insensitive (Fastify lower-cases names). Null if any is missing. */
export function webhookHeadersFrom(get: (name: string) => string | undefined): WebhookHeaders | null {
  const authAlgo = get('paypal-auth-algo');
  const certUrl = get('paypal-cert-url');
  const transmissionId = get('paypal-transmission-id');
  const transmissionSig = get('paypal-transmission-sig');
  const transmissionTime = get('paypal-transmission-time');
  if (authAlgo === undefined || certUrl === undefined || transmissionId === undefined || transmissionSig === undefined || transmissionTime === undefined) return null;
  return { authAlgo, certUrl, transmissionId, transmissionSig, transmissionTime };
}

/** The simulator's delivery hook: hand each signed event to the merchant exactly as an HTTP POST would. */
export function simulatorSink(merchant: MerchantService): (delivery: WebhookDelivery) => Promise<void> {
  return async (delivery) => {
    const lower = new Map(Object.entries(delivery.headers).map(([k, v]) => [k.toLowerCase(), v]));
    const headers = webhookHeadersFrom((name) => lower.get(name));
    if (headers === null) return;
    await merchant.handleWebhook(headers, delivery.body);
  };
}
