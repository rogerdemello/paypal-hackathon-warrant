import { PayPalClient, PayPalSimulator, SANDBOX_BASE_URL } from '@warrant/paypal';
import type { Clock } from '../clock';
import type { Config } from '../config';
import { createDisputeTools, routeToolkitToSimulator, type DisputeTools } from './paypal-toolkit';

/**
 * The PayPal side of the server: either the real sandbox (`PAYPAL_ENV=sandbox`) or the in-process simulator that speaks the
 * same API (`PAYPAL_ENV=simulator`, the default). The rest of the server cannot tell them apart: both are a `PayPalClient`.
 */
export interface PayPalGateway {
  readonly env: 'sandbox' | 'simulator';
  readonly client: PayPalClient;
  /** The dispute agent's reads (`get_dispute`, `get_order`), done through the PayPal Agent Toolkit. */
  readonly tools: DisputeTools;
  /** Set only for the simulator; it also lets the demo play the buyer and the dispute desk. */
  readonly simulator: PayPalSimulator | null;
  /** The webhook id deliveries are verified against. */
  readonly webhookId: string;
}

export function createPayPalGateway(config: Config, clock: Clock): PayPalGateway {
  if (config.paypal.env === 'sandbox') {
    if (config.paypal.clientId === null || config.paypal.clientSecret === null || config.paypal.webhookId === null) {
      throw new Error('PayPal sandbox credentials are incomplete');
    }
    const client = new PayPalClient({ baseUrl: SANDBOX_BASE_URL, clientId: config.paypal.clientId, clientSecret: config.paypal.clientSecret });
    return {
      env: 'sandbox',
      client,
      tools: createDisputeTools({ credentials: { clientId: config.paypal.clientId, clientSecret: config.paypal.clientSecret }, client }),
      simulator: null,
      webhookId: config.paypal.webhookId,
    };
  }
  const simulator = new PayPalSimulator({
    approvalUrl: `${config.publicBaseUrl}/sim/paypal/approve`,
    now: () => clock.nowMs(),
    merchant: { merchantId: config.paypal.merchantId, email: 'merchant@warrant-demo.example', name: config.merchantName },
  });
  const client = new PayPalClient({
    baseUrl: SANDBOX_BASE_URL,
    ...simulator.credentials,
    fetch: simulator.fetch,
    now: () => clock.nowMs(),
    sleep: () => Promise.resolve(),
  });
  routeToolkitToSimulator(simulator);
  const tools = createDisputeTools({ credentials: simulator.credentials, client });
  return { env: 'simulator', client, tools, simulator, webhookId: simulator.webhookId };
}
