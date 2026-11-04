import { describe, expect, it } from 'vitest';
import { LIVE_BASE_URL, PayPalClient, PayPalError, PayPalProtocolError, PayPalSimulator, mapOrder, mapDispute, mapRefund, mapWebhookEvent } from '../src';
import { harness, orderInput, paidOrder, T0_MS } from './helpers';

describe('PayPalClient: orders and payments (against the simulator)', () => {
  it('creates an order with the Warrant references and line items, and returns the payer-action link', async () => {
    const h = harness();
    const order = await h.client.createOrder(orderInput(), 'ord-crt_1-create');
    expect(order).toMatchObject({
      status: 'PAYER_ACTION_REQUIRED',
      currency: 'USD',
      totalCents: 8900,
      customId: 'wrt:crt_01JEXAMPLE',
      invoiceId: 'WRT-abcdefghijklmnop',
      referenceId: 'ord_1',
      payerId: null,
      lines: [{ sku: 'c3_abc123', name: 'Desk converter 32in', quantity: 1, unitAmountCents: 8900 }],
      captures: [],
    });
    expect(order.approveUrl).toBe(`http://localhost:8787/sim/paypal/approve?token=${order.id}`);
  });

  it('cannot capture before the buyer approves, then captures once approved and exposes the payer id', async () => {
    const h = harness();
    const created = await h.client.createOrder(orderInput(), 'create');
    const early = await h.client.captureOrder(created.id, 'cap-early').catch((e: unknown) => e);
    expect(early).toBeInstanceOf(PayPalError);
    expect((early as PayPalError).hasIssue('ORDER_NOT_APPROVED')).toBe(true);
    expect((early as PayPalError).status).toBe(422);

    h.sim.approveOrder(created.id);
    const approved = await h.client.getOrder(created.id);
    expect(approved).toMatchObject({ status: 'APPROVED', payerId: 'SIMPAYER0001', payerEmail: 'sandbox-buyer@example.com' });

    const done = await h.client.captureOrder(created.id, 'cap-1');
    expect(done.status).toBe('COMPLETED');
    expect(done.captures).toHaveLength(1);
    expect(done.captures[0]).toMatchObject({ status: 'COMPLETED', currency: 'USD', amountCents: 8900, invoiceId: 'WRT-abcdefghijklmnop', customId: 'wrt:crt_01JEXAMPLE' });
  });

  it('is idempotent for a repeated PayPal-Request-Id and refuses a second capture under a new one', async () => {
    const h = harness();
    const created = await h.client.createOrder(orderInput(), 'create');
    h.sim.approveOrder(created.id);
    const first = await h.client.captureOrder(created.id, 'same-request');
    const replay = await h.client.captureOrder(created.id, 'same-request');
    expect(replay.captures[0]?.id).toBe(first.captures[0]?.id);
    expect(h.sim.state.captures).toBe(1);

    const again = await h.client.captureOrder(created.id, 'another-request').catch((e: unknown) => e);
    expect((again as PayPalError).hasIssue('ORDER_ALREADY_CAPTURED')).toBe(true);
    expect(h.sim.state.captures).toBe(1);
  });

  it('rejects a second paid order that reuses an invoice id (duplicate invoice protection)', async () => {
    const h = harness();
    await paidOrder(h);
    const second = await h.client.createOrder(orderInput({ referenceId: 'ord_2' }), 'create-2');
    h.sim.approveOrder(second.id);
    const error = await h.client.captureOrder(second.id, 'cap-2').catch((e: unknown) => e);
    expect((error as PayPalError).hasIssue('DUPLICATE_INVOICE_ID')).toBe(true);
  });

  it('refuses an order whose total does not match its items', async () => {
    const h = harness();
    const error = await h.client.createOrder(orderInput({ totalCents: 9000 }), 'bad').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PayPalError);
    expect((error as PayPalError).hasIssue('ITEM_TOTAL_MISMATCH')).toBe(true);
    expect((error as PayPalError).debugId).toMatch(/^SIMDEBUG/);
  });

  it('refuses over-long custom_id and invoice_id', async () => {
    const h = harness();
    const long = await h.client.createOrder(orderInput({ customId: 'x'.repeat(256) }), 'a').catch((e: unknown) => e);
    expect((long as PayPalError).hasIssue('FIELD_VALUE_TOO_LONG')).toBe(true);
    const longInvoice = await h.client.createOrder(orderInput({ invoiceId: 'x'.repeat(128) }), 'b').catch((e: unknown) => e);
    expect((longInvoice as PayPalError).hasIssue('FIELD_VALUE_TOO_LONG')).toBe(true);
  });

  it('surfaces a forced decline from PayPal-Mock-Response', async () => {
    const h = harness({
      fetchWrapper: (inner) => (input, init) => {
        const headers = new Headers(init?.headers);
        if (typeof input === 'string' && input.includes('/capture')) headers.set('PayPal-Mock-Response', '{"mock_application_codes":"INSTRUMENT_DECLINED"}');
        return inner(input, { ...init, headers });
      },
    });
    const created = await h.client.createOrder(orderInput(), 'create');
    h.sim.approveOrder(created.id);
    const error = await h.client.captureOrder(created.id, 'cap').catch((e: unknown) => e);
    expect((error as PayPalError).hasIssue('INSTRUMENT_DECLINED')).toBe(true);
  });

  it('adds tracking for a capture of this order only', async () => {
    const h = harness();
    const { order, captureId } = await paidOrder(h);
    await expect(h.client.addTracking(order.id, { captureId, trackingNumber: '122533485', carrier: 'FEDEX' }, 'track-1')).resolves.toBeUndefined();
    const error = await h.client.addTracking(order.id, { captureId: 'SIMCAP-OTHER', trackingNumber: '1', carrier: 'FEDEX' }, 'track-2').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PayPalError);
  });

  it('refunds fully, partially and never more than was captured', async () => {
    const h = harness();
    const { captureId } = await paidOrder(h);
    const partial = await h.client.refundCapture({ captureId, currency: 'USD', amountCents: 2500, note: 'partial' }, 'ref-1');
    expect(partial).toMatchObject({ status: 'COMPLETED', currency: 'USD', amountCents: 2500 });
    expect((await h.client.getCapture(captureId)).status).toBe('PARTIALLY_REFUNDED');

    const over = await h.client.refundCapture({ captureId, currency: 'USD', amountCents: 6401 }, 'ref-2').catch((e: unknown) => e);
    expect((over as PayPalError).hasIssue('REFUND_AMOUNT_EXCEEDED')).toBe(true);

    const rest = await h.client.refundCapture({ captureId, currency: 'USD' }, 'ref-3');
    expect(rest.amountCents).toBe(6400);
    expect((await h.client.getCapture(captureId)).status).toBe('REFUNDED');
  });

  it('reads a capture back with cents', async () => {
    const h = harness();
    const { captureId } = await paidOrder(h);
    expect(await h.client.getCapture(captureId)).toMatchObject({ id: captureId, amountCents: 8900, currency: 'USD', invoiceId: 'WRT-abcdefghijklmnop' });
  });

  it('returns a 404 PayPalError for unknown ids', async () => {
    const h = harness();
    const error = await h.client.getOrder('NOPE').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PayPalError);
    expect((error as PayPalError).status).toBe(404);
    expect((error as PayPalError).code).toBe('RESOURCE_NOT_FOUND');
  });
});

describe('PayPalClient: authentication, retries and safety', () => {
  it('fetches one token and reuses it until it is about to expire, then fetches another', async () => {
    const h = harness();
    await h.client.createOrder(orderInput(), 'a');
    await h.client.createOrder(orderInput({ referenceId: 'o2', invoiceId: 'WRT-2' }), 'b');
    expect(h.fetchLog.filter((l) => l.endsWith('/v1/oauth2/token'))).toHaveLength(1);
    h.clock.ms += 32_400 * 1000;
    await h.client.createOrder(orderInput({ referenceId: 'o3', invoiceId: 'WRT-3' }), 'c');
    expect(h.fetchLog.filter((l) => l.endsWith('/v1/oauth2/token'))).toHaveLength(2);
  });

  it('refreshes the token once on a 401 and carries on', async () => {
    let revoked = false;
    const h = harness({
      fetchWrapper: (inner) => (input, init) => {
        const url = typeof input === 'string' ? input : '';
        if (!revoked && url.includes('/v2/checkout/orders') && init?.method === 'POST') {
          revoked = true;
          return Promise.resolve(new Response(JSON.stringify({ name: 'AUTHENTICATION_FAILURE', message: 'expired' }), { status: 401 }));
        }
        return inner(input, init);
      },
    });
    const order = await h.client.createOrder(orderInput(), 'a');
    expect(order.status).toBe('PAYER_ACTION_REQUIRED');
    expect(h.fetchLog.filter((l) => l.endsWith('/v1/oauth2/token'))).toHaveLength(2);
  });

  it('rejects bad credentials with a PayPalError', async () => {
    const h = harness();
    const bad = new PayPalClient({ baseUrl: 'https://api-m.sandbox.paypal.com', clientId: 'x', clientSecret: 'y', fetch: h.sim.fetch, sleep: () => Promise.resolve() });
    const error = await bad.getOrder('X').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PayPalError);
    expect((error as PayPalError).status).toBe(401);
  });

  it('retries a GET and a keyed POST on 503 and then succeeds, but never an unkeyed POST', async () => {
    let failures = 2;
    const calls: string[] = [];
    const h = harness({
      fetchWrapper: (inner) => (input, init) => {
        const url = typeof input === 'string' ? input : '';
        if (!url.includes('oauth2') && failures > 0) {
          failures -= 1;
          calls.push(`${init?.method ?? 'GET'} fail`);
          return Promise.resolve(new Response(JSON.stringify({ name: 'INTERNAL_SERVER_ERROR' }), { status: 503 }));
        }
        calls.push(`${init?.method ?? 'GET'} ok`);
        return inner(input, init);
      },
    });
    const created = await h.client.createOrder(orderInput(), 'keyed');
    expect(created.id).toBeTruthy();
    expect(calls.filter((c) => c.endsWith('fail'))).toHaveLength(2);

    failures = 1;
    const sandboxOnly = await h.client.sandboxAdjudicate('PP-D-X', 'BUYER_FAVOR', 'k').catch((e: unknown) => e);
    expect(sandboxOnly).toBeInstanceOf(PayPalError); // 404 after the retried 503
  });

  it('gives up after maxRetries and throws the last PayPal error', async () => {
    const h = harness({
      maxRetries: 2,
      fetchWrapper: (inner) => (input, init) => {
        const url = typeof input === 'string' ? input : '';
        return url.includes('oauth2') ? inner(input, init) : Promise.resolve(new Response(JSON.stringify({ name: 'INTERNAL_SERVER_ERROR', debug_id: 'abc' }), { status: 500 }));
      },
    });
    const error = await h.client.getOrder('X').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PayPalError);
    expect((error as PayPalError).status).toBe(500);
    expect((error as PayPalError).debugId).toBe('abc');
  });

  it('retries network errors for GET but throws the network error once retries run out', async () => {
    let attempts = 0;
    const h = harness({
      maxRetries: 1,
      fetchWrapper: (inner) => (input, init) => {
        const url = typeof input === 'string' ? input : '';
        if (url.includes('oauth2')) return inner(input, init);
        attempts += 1;
        return Promise.reject(new Error('socket hang up'));
      },
    });
    await expect(h.client.getOrder('X')).rejects.toThrow('socket hang up');
    expect(attempts).toBe(2);
  });

  it('does not retry a POST that has no request id on a network error', async () => {
    let attempts = 0;
    const h = harness({
      fetchWrapper: (inner) => (input, init) => {
        const url = typeof input === 'string' ? input : '';
        if (url.includes('oauth2')) return inner(input, init);
        attempts += 1;
        return Promise.reject(new Error('reset'));
      },
    });
    await expect(h.client.acceptClaim('PP-D-1', { note: 'x' }, undefined as unknown as string)).rejects.toThrow('reset');
    expect(attempts).toBe(1);
  });

  it('refuses to be constructed against the live PayPal API', () => {
    expect(() => new PayPalClient({ baseUrl: LIVE_BASE_URL, clientId: 'a', clientSecret: 'b' })).toThrow(PayPalProtocolError);
  });

  it('uses the global fetch and Date.now when none are injected (construction only)', () => {
    expect(() => new PayPalClient({ baseUrl: 'https://api-m.sandbox.paypal.com', clientId: 'a', clientSecret: 'b' })).not.toThrow();
  });
});

describe('PayPalClient: disputes (against the simulator)', () => {
  it('reads a dispute with cents, the seller transaction id, messages, deadline and allowed options', async () => {
    const h = harness();
    const { captureId } = await paidOrder(h);
    const { disputeId } = h.sim.openDispute({ captureId, reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', message: 'It never arrived.' });
    const dispute = await h.client.getDispute(disputeId);
    expect(dispute).toMatchObject({
      id: disputeId,
      reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      status: 'WAITING_FOR_SELLER_RESPONSE',
      stage: 'INQUIRY',
      currency: 'USD',
      amountCents: 8900,
      sellerTransactionIds: [captureId],
      allowedAcceptClaimTypes: ['REFUND', 'PARTIAL_REFUND'],
      allowedOfferTypes: ['REFUND'],
      outcomeCode: null,
    });
    expect(dispute.messages).toEqual([{ postedBy: 'BUYER', content: 'It never arrived.', timePosted: Math.floor(T0_MS / 1000) }]);
    expect(dispute.sellerResponseDueBy).toBe(Math.floor(T0_MS / 1000) + 10 * 86_400);
  });

  it('an unauthorised dispute is a chargeback: only a full refund can be accepted and no offer can be made', async () => {
    const h = harness();
    const { captureId } = await paidOrder(h);
    const { disputeId } = h.sim.openDispute({ captureId, reason: 'UNAUTHORISED', message: 'I did not buy this.' });
    const dispute = await h.client.getDispute(disputeId);
    expect(dispute).toMatchObject({ stage: 'CHARGEBACK', allowedAcceptClaimTypes: ['REFUND'], allowedOfferTypes: [] });
    const error = await h.client.makeOffer(disputeId, { note: 'x', offerType: 'REFUND' }, 'offer').catch((e: unknown) => e);
    expect((error as PayPalError).hasIssue('DISPUTE_ACTION_NOT_ALLOWED')).toBe(true);
  });

  it('accepting a claim refunds the buyer and resolves the dispute in their favour', async () => {
    const h = harness();
    const { captureId } = await paidOrder(h);
    const { disputeId } = h.sim.openDispute({ captureId, reason: 'UNAUTHORISED', message: 'x' });
    await h.client.acceptClaim(disputeId, { note: 'Agent platform signed a cart the human did not approve.', reason: 'NOT_ABLE_TO_WIN' }, 'accept-1');
    const dispute = await h.client.getDispute(disputeId);
    expect(dispute).toMatchObject({ status: 'RESOLVED', outcomeCode: 'RESOLVED_BUYER_FAVOUR', allowedAcceptClaimTypes: [] });
    expect((await h.client.getCapture(captureId)).status).toBe('REFUNDED');
  });

  it('accepts a partial refund for an inquiry, and requires the amount', async () => {
    const h = harness();
    const { captureId } = await paidOrder(h);
    const { disputeId } = h.sim.openDispute({ captureId, reason: 'INCORRECT_AMOUNT', message: 'Charged too much.' });
    const missing = await h.client.acceptClaim(disputeId, { note: 'x', acceptClaimType: 'PARTIAL_REFUND' }, 'a1').catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(PayPalError);
    await h.client.acceptClaim(disputeId, { note: 'x', acceptClaimType: 'PARTIAL_REFUND', refundAmount: { currency: 'USD', cents: 1500 } }, 'a2');
    expect((await h.client.getCapture(captureId)).status).toBe('PARTIALLY_REFUNDED');
    expect((await h.client.getDispute(disputeId)).status).toBe('RESOLVED');
  });

  it('rejects an accept-claim type PayPal does not allow here', async () => {
    const h = harness();
    const { captureId } = await paidOrder(h);
    const { disputeId } = h.sim.openDispute({ captureId, reason: 'UNAUTHORISED', message: 'x' });
    const error = await h.client.acceptClaim(disputeId, { note: 'x', acceptClaimType: 'PARTIAL_REFUND', refundAmount: { currency: 'USD', cents: 100 } }, 'a').catch((e: unknown) => e);
    expect((error as PayPalError).hasIssue('INVALID_ACCEPT_CLAIM_TYPE')).toBe(true);
  });

  it('an offer waits for the buyer; when the buyer accepts, the refund happens and the dispute resolves', async () => {
    const h = harness();
    const { captureId } = await paidOrder(h);
    const { disputeId } = h.sim.openDispute({ captureId, reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', message: 'Not what the listing said.' });
    expect((await h.client.getDispute(disputeId)).allowedOfferTypes).toContain('REFUND_WITH_REPLACEMENT');
    await h.client.makeOffer(disputeId, { note: 'We will replace it.', offerType: 'REFUND_WITH_REPLACEMENT', offerAmount: { currency: 'USD', cents: 8900 } }, 'offer-1');
    expect((await h.client.getDispute(disputeId)).status).toBe('WAITING_FOR_BUYER_RESPONSE');
    h.sim.buyerAcceptsOffer(disputeId);
    expect(await h.client.getDispute(disputeId)).toMatchObject({ status: 'RESOLVED', outcomeCode: 'ACCEPTED' });
    expect((await h.client.getCapture(captureId)).status).toBe('REFUNDED');
  });

  it('rejects an offer type that is not allowed and a buyer acceptance with no offer', async () => {
    const h = harness();
    const { captureId } = await paidOrder(h);
    const { disputeId } = h.sim.openDispute({ captureId, reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', message: 'x' });
    const bad = await h.client.makeOffer(disputeId, { note: 'x', offerType: 'REPLACEMENT_WITHOUT_REFUND' }, 'o').catch((e: unknown) => e);
    expect((bad as PayPalError).hasIssue('INVALID_OFFER_TYPE')).toBe(true);
    expect(() => h.sim.buyerAcceptsOffer(disputeId)).toThrow();
  });

  it('provides evidence as multipart with a document, which puts the dispute under review', async () => {
    const h = harness();
    const { captureId } = await paidOrder(h);
    const { disputeId } = h.sim.openDispute({ captureId, reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', message: 'x' });
    await h.client.provideEvidence(
      disputeId,
      {
        evidences: [
          { evidenceType: 'PROOF_OF_FULFILLMENT', notes: 'Delivered.', trackingInfo: [{ carrierName: 'FEDEX', trackingNumber: '122533485' }] },
          { evidenceType: 'OTHER', notes: 'Agent authorisation proof: https://example.test/v/crt_1' },
        ],
        files: [{ name: 'packet.pdf', contentType: 'application/pdf', data: new Uint8Array([37, 80, 68, 70]) }],
      },
      'evidence-1',
    );
    const dispute = await h.client.getDispute(disputeId);
    expect(dispute.status).toBe('UNDER_REVIEW');
    expect(dispute.evidences.map((e) => e.evidenceType)).toEqual(['PROOF_OF_FULFILLMENT', 'OTHER']);
    expect(dispute.evidences[0]?.notes).toBe('Delivered.');
  });

  it('refuses evidence that is too long, empty, or sent when the dispute is not waiting for the seller', async () => {
    const h = harness();
    const { captureId } = await paidOrder(h);
    const { disputeId } = h.sim.openDispute({ captureId, reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', message: 'x' });
    // The client truncates notes to the PayPal limit, so a long note still goes through.
    await expect(h.client.provideEvidence(disputeId, { evidences: [{ evidenceType: 'OTHER', notes: 'n'.repeat(5000) }] }, 'e1')).resolves.toBeUndefined();
    expect((await h.client.getDispute(disputeId)).evidences[0]?.notes).toHaveLength(2000);
    const again = await h.client.provideEvidence(disputeId, { evidences: [{ evidenceType: 'OTHER' }] }, 'e2').catch((e: unknown) => e);
    expect((again as PayPalError).hasIssue('DISPUTE_ACTION_NOT_ALLOWED')).toBe(true);
    const h2 = harness();
    const second = await paidOrder(h2);
    const d2 = h2.sim.openDispute({ captureId: second.captureId, reason: 'OTHER', message: 'x' });
    const empty = await h2.client.provideEvidence(d2.disputeId, { evidences: [] }, 'e3').catch((e: unknown) => e);
    expect(empty).toBeInstanceOf(PayPalError);
  });

  it('sandbox helpers: require evidence, adjudicate for the seller or the buyer', async () => {
    const h = harness();
    const { captureId } = await paidOrder(h);
    const { disputeId } = h.sim.openDispute({ captureId, reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', message: 'x' });
    const early = await h.client.sandboxAdjudicate(disputeId, 'SELLER_FAVOR', 'adj-0').catch((e: unknown) => e);
    expect((early as PayPalError).hasIssue('DISPUTE_ACTION_NOT_ALLOWED')).toBe(true);
    await h.client.provideEvidence(disputeId, { evidences: [{ evidenceType: 'OTHER', notes: 'x' }] }, 'ev');
    await h.client.sandboxRequireEvidence(disputeId, 'BUYER_EVIDENCE', 'req-1');
    expect((await h.client.getDispute(disputeId)).status).toBe('WAITING_FOR_BUYER_RESPONSE');
    const stillWrong = await h.client.sandboxAdjudicate(disputeId, 'SELLER_FAVOR', 'adj-1').catch((e: unknown) => e);
    expect(stillWrong).toBeInstanceOf(PayPalError);

    const h2 = harness();
    const p = await paidOrder(h2);
    const d = h2.sim.openDispute({ captureId: p.captureId, reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', message: 'x' });
    await h2.client.provideEvidence(d.disputeId, { evidences: [{ evidenceType: 'OTHER' }] }, 'ev');
    await h2.client.sandboxAdjudicate(d.disputeId, 'BUYER_FAVOR', 'adj');
    expect(await h2.client.getDispute(d.disputeId)).toMatchObject({ status: 'RESOLVED', outcomeCode: 'RESOLVED_BUYER_FAVOUR' });
    expect((await h2.client.getCapture(p.captureId)).status).toBe('REFUNDED');

    const h3 = harness();
    const q = await paidOrder(h3);
    const e = h3.sim.openDispute({ captureId: q.captureId, reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', message: 'x' });
    await h3.client.provideEvidence(e.disputeId, { evidences: [{ evidenceType: 'OTHER' }] }, 'ev');
    await h3.client.sandboxAdjudicate(e.disputeId, 'SELLER_FAVOR', 'adj');
    expect(await h3.client.getDispute(e.disputeId)).toMatchObject({ status: 'RESOLVED', outcomeCode: 'RESOLVED_SELLER_FAVOUR' });
    expect((await h3.client.getCapture(q.captureId)).status).toBe('COMPLETED');
  });

  it('creates a dispute through the sandbox API and lists disputes', async () => {
    const h = harness();
    const { captureId } = await paidOrder(h);
    const created = await h.client.sandboxCreateDispute({ sellerTransactionId: captureId, reason: 'DUPLICATE_TRANSACTION', currency: 'USD', amountCents: 4000, message: 'Charged twice.' }, 'create-d');
    expect(created).toMatchObject({ reason: 'DUPLICATE_TRANSACTION', amountCents: 4000, sellerTransactionIds: [captureId] });
    const all = await h.client.listDisputes();
    expect(all.map((d) => d.id)).toEqual([created.id]);
    expect(await h.client.listDisputes({ status: 'RESOLVED', pageSize: 5 })).toEqual([]);
  });

  it('opening a dispute for an unknown capture fails', async () => {
    const h = harness();
    expect(() => h.sim.openDispute({ captureId: 'NOPE', reason: 'OTHER', message: 'x' })).toThrow();
    const error = await h.client.sandboxCreateDispute({ sellerTransactionId: 'NOPE', reason: 'OTHER', currency: 'USD', amountCents: 1, message: 'x' }, 'k').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PayPalError);
  });

  it('a response deadline can be shortened for the simulator (used by the Lab)', async () => {
    const h = harness();
    const { captureId } = await paidOrder(h);
    const { disputeId } = h.sim.openDispute({ captureId, reason: 'OTHER', message: 'x', responseDueInSeconds: 3600 * 12 });
    expect((await h.client.getDispute(disputeId)).sellerResponseDueBy).toBe(Math.floor(T0_MS / 1000) + 12 * 3600);
  });
});

describe('Webhooks', () => {
  it('delivers signed events for the order, capture, refund and dispute lifecycle', async () => {
    const h = harness();
    const { captureId } = await paidOrder(h);
    const { disputeId } = h.sim.openDispute({ captureId, reason: 'UNAUTHORISED', message: 'x' });
    await h.client.acceptClaim(disputeId, { note: 'x' }, 'a');
    await h.sim.flush();
    const types = h.deliveries.map((d) => (JSON.parse(d.body) as { event_type: string }).event_type);
    expect(types).toEqual([
      'CHECKOUT.ORDER.APPROVED',
      'PAYMENT.CAPTURE.COMPLETED',
      'CUSTOMER.DISPUTE.CREATED',
      'PAYMENT.CAPTURE.REFUNDED',
      'CUSTOMER.DISPUTE.RESOLVED',
    ]);
    expect(h.sim.deliveries).toHaveLength(5);
    const created = mapWebhookEvent(JSON.parse(h.deliveries[2]?.body ?? '{}'));
    expect(created.eventType).toBe('CUSTOMER.DISPUTE.CREATED');
    expect(mapDispute(created.resource).id).toBe(disputeId);
  });

  const headersOf = (d: { headers: Readonly<Record<string, string>> }) => ({
    authAlgo: d.headers['paypal-auth-algo'] ?? '',
    certUrl: d.headers['paypal-cert-url'] ?? '',
    transmissionId: d.headers['paypal-transmission-id'] ?? '',
    transmissionSig: d.headers['paypal-transmission-sig'] ?? '',
    transmissionTime: d.headers['paypal-transmission-time'] ?? '',
  });

  it('verifies a genuine delivery and rejects a forged body, signature, id or webhook id', async () => {
    const h = harness();
    await paidOrder(h);
    await h.sim.flush();
    const delivery = h.deliveries[1];
    if (delivery === undefined) throw new Error('no delivery');
    const headers = headersOf(delivery);
    expect(await h.client.verifyWebhookSignature(headers, delivery.body, h.sim.webhookId)).toBe(true);

    const forgedBody = delivery.body.replace('PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.REFUNDED');
    expect(await h.client.verifyWebhookSignature(headers, forgedBody, h.sim.webhookId)).toBe(false);
    expect(await h.client.verifyWebhookSignature({ ...headers, transmissionSig: 'AAAA' }, delivery.body, h.sim.webhookId)).toBe(false);
    expect(await h.client.verifyWebhookSignature({ ...headers, transmissionId: 'WH-OTHER' }, delivery.body, h.sim.webhookId)).toBe(false);
    expect(await h.client.verifyWebhookSignature(headers, delivery.body, 'SOME-OTHER-WEBHOOK')).toBe(false);
  });

  it('a sink that throws never breaks the API call', async () => {
    const h = harness();
    h.sim.setWebhookSink(() => Promise.reject(new Error('sink down')));
    const { captureId } = await paidOrder(h);
    await h.sim.flush();
    expect(captureId).toBeTruthy();
    h.sim.setWebhookSink(null);
    const { captureId: second } = await paidOrder(h, { invoiceId: 'WRT-second', referenceId: 'o2', customId: 'wrt:crt_2' });
    expect(second).toBeTruthy();
  });
});

describe('Simulator HTTP behaviour', () => {
  const sim = () => new PayPalSimulator({ approvalUrl: 'http://x/approve', now: () => T0_MS });

  it('answers 401 without a token, 404 for unknown routes, and 400 for malformed JSON', async () => {
    const s = sim();
    expect((await s.fetch('https://api-m.sandbox.paypal.com/v2/checkout/orders/X')).status).toBe(401);
    const tokenRes = await s.fetch('https://api-m.sandbox.paypal.com/v1/oauth2/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from('sim-client-id:sim-client-secret').toString('base64')}` },
      body: 'grant_type=client_credentials',
    });
    const token = ((await tokenRes.json()) as { access_token: string }).access_token;
    const auth = { Authorization: `Bearer ${token}` };
    expect((await s.fetch('https://api-m.sandbox.paypal.com/v9/nothing', { headers: auth })).status).toBe(404);
    const bad = await s.fetch('https://api-m.sandbox.paypal.com/v2/checkout/orders', { method: 'POST', headers: auth, body: '{not json' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { name: string }).name).toBe('INVALID_REQUEST');
  });

  it('rejects the wrong client secret', async () => {
    const s = sim();
    const res = await s.fetch('https://api-m.sandbox.paypal.com/v1/oauth2/token', { method: 'POST', headers: { Authorization: 'Basic eDp5' }, body: 'grant_type=client_credentials' });
    expect(res.status).toBe(401);
  });

  it('only supports intent CAPTURE and demands purchase units', async () => {
    const h = harness();
    const noUnits = await h.client.provideEvidence('x', { evidences: [] }, 'k').catch((e: unknown) => e);
    expect(noUnits).toBeInstanceOf(PayPalError);
    const res = await h.sim.fetch('https://api-m.sandbox.paypal.com/v1/oauth2/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from('sim-client-id:sim-client-secret').toString('base64')}` },
      body: 'grant_type=client_credentials',
    });
    const token = ((await res.json()) as { access_token: string }).access_token;
    const post = (body: unknown) =>
      h.sim.fetch('https://api-m.sandbox.paypal.com/v2/checkout/orders', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post({ intent: 'AUTHORIZE', purchase_units: [] })).status).toBe(422);
    expect((await post({ intent: 'CAPTURE' })).status).toBe(400);
    expect((await post({ intent: 'CAPTURE', purchase_units: [{ amount: { currency_code: 'USD', value: 'abc' } }] })).status).toBe(422);
  });

  it('approving an unknown or already captured order fails', async () => {
    const h = harness();
    expect(() => h.sim.approveOrder('NOPE')).toThrow();
    const { order } = await paidOrder(h);
    expect(() => h.sim.approveOrder(order.id)).toThrow();
  });

  it('accepts evidence sent as plain JSON as well as multipart', async () => {
    const h = harness();
    const { captureId } = await paidOrder(h);
    const { disputeId } = h.sim.openDispute({ captureId, reason: 'OTHER', message: 'x' });
    const tokenRes = await h.sim.fetch('https://api-m.sandbox.paypal.com/v1/oauth2/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from('sim-client-id:sim-client-secret').toString('base64')}` },
      body: 'grant_type=client_credentials',
    });
    const token = ((await tokenRes.json()) as { access_token: string }).access_token;
    const res = await h.sim.fetch(`https://api-m.sandbox.paypal.com/v1/customer/disputes/${disputeId}/provide-evidence`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ evidences: [{ evidence_type: 'OTHER', notes: 'json' }] }),
    });
    expect(res.status).toBe(200);
    expect((await h.client.getDispute(disputeId)).status).toBe('UNDER_REVIEW');
  });
});

describe('Mappers on malformed PayPal data', () => {
  it('throws a protocol error for amounts that are not plain decimals', () => {
    expect(() => mapOrder({ id: 'X', purchase_units: [{ amount: { currency_code: 'USD', value: '1e3' } }] })).toThrow(PayPalProtocolError);
    expect(() => mapOrder({ id: 'X', purchase_units: [{ amount: { currency_code: 'USD', value: '1.005' } }] })).toThrow(PayPalProtocolError);
    expect(() => mapOrder({ purchase_units: [] })).toThrow(PayPalProtocolError);
    expect(() => mapOrder(null)).toThrow(PayPalProtocolError);
    expect(() => mapRefund({ id: 'R', amount: { currency_code: 'USD' } })).toThrow(PayPalProtocolError);
    expect(() => mapDispute({ dispute_id: 'D' })).toThrow(PayPalProtocolError);
  });

  it('maps an older order with an approve link, no payer and no items', () => {
    const order = mapOrder({
      id: 'ORD1',
      status: 'CREATED',
      purchase_units: [{ amount: { currency_code: 'USD', value: '10.00' } }],
      links: [{ rel: 'approve', href: 'https://example.test/approve' }],
    });
    expect(order).toMatchObject({ approveUrl: 'https://example.test/approve', lines: null, payerId: null, captures: [], totalCents: 1000 });
  });

  it('tolerates timestamps with offsets and fractions', () => {
    const dispute = mapDispute({
      dispute_id: 'D',
      dispute_amount: { currency_code: 'USD', value: '1.00' },
      create_time: '2026-11-04T10:00:00.123Z',
      update_time: '2026-11-04T12:00:00+02:00',
      seller_response_due_date: 'not a date',
    });
    expect(dispute.createdAt).toBe(Math.floor(Date.UTC(2026, 10, 4, 10) / 1000));
    expect(dispute.updatedAt).toBe(Math.floor(Date.UTC(2026, 10, 4, 10) / 1000));
    expect(dispute.sellerResponseDueBy).toBeNull();
  });
});

describe('Simulator state that survives a restart', () => {
  it('a new simulator restored from a snapshot knows the paid order, can open a dispute on its capture, and never repeats an id', async () => {
    const first = harness();
    const { order, captureId } = await paidOrder(first);
    const snapshot = JSON.parse(JSON.stringify(first.sim.snapshot())) as ReturnType<typeof first.sim.snapshot>;

    const second = harness();
    second.sim.restore(snapshot);
    expect(second.sim.state).toEqual({ orders: 1, captures: 1, disputes: 0 });
    expect((await second.client.getOrder(order.id)).status).toBe('COMPLETED');
    expect((await second.client.getCapture(captureId)).id).toBe(captureId);

    const { disputeId } = second.sim.openDispute({ captureId, reason: 'UNAUTHORISED', message: 'I did not authorise this' });
    expect(disputeId).toMatch(/^PP-D-\d+$/);
    // The next order gets an id the first run never issued.
    const next = await second.client.createOrder(orderInput({ referenceId: 'ord_2', invoiceId: 'WRT-second-order-xx' }), 'create-ord_2');
    expect(next.id).not.toBe(order.id);
    const issued = [order.id, captureId, disputeId, next.id];
    expect(new Set(issued).size).toBe(issued.length);
  });

  it('tells a listener when something changed, but not when something was only read', async () => {
    const h = harness();
    let changes = 0;
    h.sim.setChangeListener(() => {
      changes += 1;
    });
    const created = await h.client.createOrder(orderInput(), 'create-1');
    expect(changes).toBeGreaterThan(0);
    const afterCreate = changes;
    await h.client.getOrder(created.id);
    expect(changes).toBe(afterCreate);
    h.sim.approveOrder(created.id);
    expect(changes).toBe(afterCreate + 1);
    const captured = await h.client.captureOrder(created.id, 'capture-1');
    const captureId = captured.captures[0]?.id ?? '';
    const before = changes;
    h.sim.openDispute({ captureId, reason: 'OTHER', message: 'hello' });
    expect(changes).toBe(before + 1);
    h.sim.setChangeListener(null);
    h.sim.approveOrder(created.id === '' ? 'x' : (await h.client.createOrder(orderInput({ referenceId: 'ord_3', invoiceId: 'WRT-third-order-xxx' }), 'create-3')).id);
    expect(changes).toBe(before + 1);
  });

  it('a snapshot is plain data, and a restore refuses anything that is not one', () => {
    const h = harness();
    const text = JSON.stringify(h.sim.snapshot());
    expect(JSON.parse(text)).toMatchObject({ version: 1, counter: 0, orders: [], captures: [], disputes: [] });
    const bad = [null, {}, { version: 2, counter: 0, orders: [], captures: [], disputes: [] }, { version: 1, counter: 'x', orders: [], captures: [], disputes: [] }, { version: 1, counter: 0, orders: [{ nope: 1 }], captures: [], disputes: [] }];
    for (const snapshot of bad) expect(() => h.sim.restore(snapshot as never)).toThrow(/not a PayPal simulator snapshot/);
  });

  it('the buyer accepting an offer is a change too', async () => {
    const h = harness();
    const { captureId } = await paidOrder(h);
    const { disputeId } = h.sim.openDispute({ captureId, reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', message: 'It never came' });
    await h.client.makeOffer(disputeId, { note: 'Partial refund?', offerAmount: { currency: 'USD', cents: 1000 }, offerType: 'REFUND' }, 'offer-1');
    let changes = 0;
    h.sim.setChangeListener(() => {
      changes += 1;
    });
    h.sim.buyerAcceptsOffer(disputeId);
    expect(changes).toBe(1);
  });
});
