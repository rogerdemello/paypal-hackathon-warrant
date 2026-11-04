import { arr, isRec, money, optMoney, rec, reqStr, str, when } from './json';
import type {
  CaptureSummary,
  DisputeEvidenceSummary,
  DisputeMessage,
  DisputeSummary,
  OrderLine,
  OrderSummary,
  RefundSummary,
  WebhookEvent,
} from './types';

/** Map PayPal JSON (untrusted) to domain types with integer cents. Throws PayPalProtocolError on a malformed amount. */

export function mapCapture(raw: unknown): CaptureSummary {
  const c = rec(raw, 'capture');
  const amount = money(c['amount'], 'capture.amount');
  return {
    id: reqStr(c['id'], 'capture.id'),
    status: str(c['status']) ?? 'UNKNOWN',
    currency: amount.currency,
    amountCents: amount.cents,
    invoiceId: str(c['invoice_id']),
    customId: str(c['custom_id']),
    createdAt: when(c['create_time']),
  };
}

function mapLine(raw: unknown): OrderLine {
  const item = rec(raw, 'order item');
  const unit = money(item['unit_amount'], 'item.unit_amount');
  const quantity = Number(str(item['quantity']) ?? item['quantity']);
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error('order item quantity is not a positive integer');
  return { sku: str(item['sku']), name: str(item['name']), quantity, unitAmountCents: unit.cents };
}

export function mapOrder(raw: unknown): OrderSummary {
  const o = rec(raw, 'order');
  const unit = rec(arr(o['purchase_units'])[0], 'order.purchase_units[0]');
  const amount = money(unit['amount'], 'purchase_unit.amount');
  const payer = isRec(o['payer']) ? o['payer'] : null;
  const items = unit['items'];
  const payments = isRec(unit['payments']) ? unit['payments'] : null;
  const links = arr(o['links']).filter(isRec);
  const approve = links.find((l) => l['rel'] === 'payer-action') ?? links.find((l) => l['rel'] === 'approve');
  return {
    id: reqStr(o['id'], 'order.id'),
    status: str(o['status']) ?? 'UNKNOWN',
    currency: amount.currency,
    totalCents: amount.cents,
    customId: str(unit['custom_id']),
    invoiceId: str(unit['invoice_id']),
    referenceId: str(unit['reference_id']),
    payerId: payer === null ? null : str(payer['payer_id']),
    payerEmail: payer === null ? null : str(payer['email_address']),
    lines: Array.isArray(items) ? (items as unknown[]).map(mapLine) : null,
    captures: payments === null ? [] : arr(payments['captures']).map(mapCapture),
    approveUrl: approve === undefined ? null : str(approve['href']),
  };
}

export function mapRefund(raw: unknown): RefundSummary {
  const r = rec(raw, 'refund');
  const amount = money(r['amount'], 'refund.amount');
  return { id: reqStr(r['id'], 'refund.id'), status: str(r['status']) ?? 'UNKNOWN', currency: amount.currency, amountCents: amount.cents };
}

function mapMessage(raw: unknown): DisputeMessage {
  const m = rec(raw, 'dispute message');
  return { postedBy: str(m['posted_by']) ?? 'UNKNOWN', content: str(m['content']) ?? '', timePosted: when(m['time_posted']) };
}

function mapEvidence(raw: unknown): DisputeEvidenceSummary {
  const e = rec(raw, 'dispute evidence');
  return { evidenceType: str(e['evidence_type']) ?? 'OTHER', source: str(e['source']), notes: str(e['notes']) };
}

function stringList(value: unknown): string[] {
  return arr(value).filter((v): v is string => typeof v === 'string');
}

export function mapDispute(raw: unknown): DisputeSummary {
  const d = rec(raw, 'dispute');
  const amount = money(d['dispute_amount'], 'dispute.dispute_amount');
  const options = isRec(d['allowed_response_options']) ? d['allowed_response_options'] : {};
  const accept = isRec(options['accept_claim']) ? options['accept_claim'] : {};
  const offer = isRec(options['make_offer']) ? options['make_offer'] : {};
  const outcome = isRec(d['dispute_outcome']) ? d['dispute_outcome'] : null;
  const transactions = arr(d['disputed_transactions']).filter(isRec);
  return {
    id: reqStr(d['dispute_id'], 'dispute.dispute_id'),
    reason: str(d['reason']) ?? 'OTHER',
    status: str(d['status']) ?? 'OTHER',
    stage: str(d['dispute_life_cycle_stage']),
    currency: amount.currency,
    amountCents: amount.cents,
    sellerTransactionIds: transactions.map((t) => str(t['seller_transaction_id'])).filter((v): v is string => v !== null),
    createdAt: when(d['create_time']),
    updatedAt: when(d['update_time']),
    sellerResponseDueBy: when(d['seller_response_due_date']),
    messages: arr(d['messages']).map(mapMessage),
    evidences: arr(d['evidences']).map(mapEvidence),
    allowedAcceptClaimTypes: stringList(accept['accept_claim_types']),
    allowedOfferTypes: stringList(offer['offer_types']),
    outcomeCode: outcome === null ? null : str(outcome['outcome_code']),
  };
}

export function mapWebhookEvent(raw: unknown): WebhookEvent {
  const e = rec(raw, 'webhook event');
  return {
    id: reqStr(e['id'], 'event.id'),
    eventType: reqStr(e['event_type'], 'event.event_type'),
    resourceType: str(e['resource_type']),
    createdAt: when(e['create_time']),
    summary: str(e['summary']),
    resource: e['resource'] ?? null,
  };
}

/** Used by tests and the simulator to check an optional amount without throwing. */
export function maybeAmount(value: unknown): { currency: string; cents: number } | null {
  return optMoney(value, 'amount');
}
