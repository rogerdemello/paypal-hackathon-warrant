import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/clock';
import { createPayPalGateway } from '../src/services/paypal';
import { T0_MS, testConfig } from './helpers';

/** The dispute agent reads through the real PayPal Agent Toolkit code; here its HTTP is pointed at the PayPal simulator. */

async function gatewayWithDispute() {
  const gateway = createPayPalGateway(testConfig(), new ManualClock(T0_MS));
  const sim = gateway.simulator;
  if (sim === null) throw new Error('expected the simulator');
  const created = await gateway.client.createOrder(
    {
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
    },
    'create-ord_1',
  );
  sim.approveOrder(created.id);
  const paid = await gateway.client.captureOrder(created.id, 'capture-ord_1');
  const captureId = paid.captures[0]?.id;
  if (captureId === undefined) throw new Error('capture missing');
  const dispute = sim.openDispute({ captureId, reason: 'UNAUTHORISED', message: 'I never ordered this' });
  return { gateway, orderId: created.id, disputeId: dispute.disputeId };
}

describe('dispute reads through the PayPal Agent Toolkit', () => {
  it('get_dispute and get_order return what the typed client returns', async () => {
    const { gateway, orderId, disputeId } = await gatewayWithDispute();
    expect(await gateway.tools.getDispute(disputeId)).toEqual(await gateway.client.getDispute(disputeId));
    expect(await gateway.tools.getOrder(orderId)).toEqual(await gateway.client.getOrder(orderId));
    expect(gateway.tools.stats()).toEqual({ toolkit: 2, fallback: 0 });
  });

  it('counts a failed Toolkit read as a fallback and reports the error from the REST client', async () => {
    const { gateway } = await gatewayWithDispute();
    await expect(gateway.tools.getDispute('PP-D-NOPE')).rejects.toThrow();
    expect(gateway.tools.stats()).toEqual({ toolkit: 0, fallback: 1 });
  });
});
