import { createHash } from 'node:crypto';
import { PayPalError, type AcceptClaimReason, type DisputeSummary, type OfferType, type WebhookEvent } from '@warrant/paypal';
import {
  buildEvidencePacket,
  computeFacts,
  decideOutcome,
  decodeBundle,
  formatInstant,
  formatMoney,
  hashCartBody,
  parseBundle,
  parseMoney,
  type ActionType,
  type CartPayload,
  type ClaimType,
  type Facts,
  type FactsInput,
  type JsonValue,
  type OutcomeDecision,
  type ProposedAction,
} from '@warrant/warrant';
import { appendToChain } from '../chain';
import { nowSeconds, type Clock, type Ids } from '../clock';
import type { Config } from '../config';
import { json, maybeOne, type Db } from '../db';
import { resolveClaim, type ClaimExtractor } from './claims';
import type { MerchantService, OrderRecord } from './merchant';
import type { CaseRecord, NoteWriter } from './notes';
import type { PayPalGateway } from './paypal';
import { textPdf } from './pdf';
import type { RegistryService } from './registry';
import type { StoreService } from './store';
import type { WalletService } from './wallet';

/**
 * The dispute agent. A dispute arrives from PayPal; the agent maps it to an order and its warrant, computes the facts F1-F13
 * deterministically, reads the claim as a closed enum, looks the decision up in the outcome table, and only then asks for
 * words (memo, evidence note, buyer message). It prepares a PDF evidence packet and proposes ONE PayPal action, checked
 * against what PayPal currently allows. A person approves it in the console; autopilot, when switched on, approves the
 * clear-cut cases only. Language models never reach the facts, the table or the money.
 */

export type DisputeState = 'received' | 'awaiting_approval' | 'responded' | 'closed' | 'escalated';
export type ActionStatus = 'proposed' | 'executed' | 'rejected' | 'failed' | 'superseded';

export interface DisputeRecord {
  readonly id: string;
  readonly orderId: string | null;
  readonly captureId: string | null;
  readonly reason: string;
  readonly stage: string | null;
  readonly status: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly buyerMessage: string | null;
  readonly claimType: ClaimType | null;
  readonly claimSource: string | null;
  readonly claimConflict: boolean;
  readonly responseDueBy: number | null;
  readonly state: DisputeState;
  readonly outcomeCode: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** The outcome-table decision as stored, with what the claim reading added. */
export interface StoredDecision extends OutcomeDecision {
  readonly claimConflict: boolean;
  readonly claimSource: string;
}

export interface AnalysisRecord {
  readonly id: string;
  readonly disputeId: string;
  readonly facts: Facts;
  readonly decision: StoredDecision;
  readonly computedAt: number;
}

export interface ActionRecord {
  readonly id: string;
  readonly disputeId: string;
  readonly factsId: string;
  readonly outcome: string;
  readonly rule: string;
  readonly actionType: ActionType;
  readonly params: Readonly<Record<string, JsonValue>>;
  readonly memo: string;
  readonly evidenceNote: string;
  readonly buyerMessage: string;
  readonly noteSource: string;
  readonly status: ActionStatus;
  readonly approvedBy: string | null;
  readonly paypalResponse: JsonValue | null;
  readonly error: string | null;
  readonly createdAt: number;
  readonly decidedAt: number | null;
}

export interface PacketMeta {
  readonly id: string;
  readonly disputeId: string;
  readonly actionId: string | null;
  readonly fileName: string;
  readonly contentType: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly createdAt: number;
}

export interface DisputeDetail {
  readonly dispute: DisputeRecord;
  readonly order: OrderRecord | null;
  readonly analysis: AnalysisRecord | null;
  readonly actions: readonly ActionRecord[];
  readonly packet: PacketMeta | null;
  readonly paypal: DisputeSummary | null;
}

export class DisputeError extends Error {
  override readonly name = 'DisputeError';
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'PAYPAL',
    message: string,
  ) {
    super(message);
  }
}

export interface DisputeServiceOptions {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly config: Config;
  readonly registry: RegistryService;
  readonly wallet: WalletService;
  readonly store: StoreService;
  readonly merchant: MerchantService;
  readonly paypal: PayPalGateway;
  readonly claims: ClaimExtractor;
  readonly notes: NoteWriter;
}

interface DisputeRow {
  paypal_dispute_id: string;
  order_id: string | null;
  capture_id: string | null;
  reason: string;
  stage: string | null;
  status: string;
  amount_cents: number;
  currency: string;
  buyer_message: string | null;
  claim_type: ClaimType | null;
  claim_source: string | null;
  claim_conflict: boolean;
  response_due_by: number | null;
  state: DisputeState;
  outcome_code: string | null;
  raw: DisputeSummary;
  created_at: number;
  updated_at: number;
}

interface ActionRow {
  id: string;
  dispute_id: string;
  facts_id: string;
  outcome: string;
  rule: string;
  action_type: ActionType;
  params: Record<string, JsonValue>;
  memo: string;
  evidence_note: string;
  buyer_message: string;
  note_source: string;
  status: ActionStatus;
  approved_by: string | null;
  paypal_response: JsonValue | null;
  error: string | null;
  created_at: number;
  decided_at: number | null;
}

const DISPUTE_COLUMNS = 'paypal_dispute_id, order_id, capture_id, reason, stage, status, amount_cents, currency, buyer_message, claim_type, claim_source, claim_conflict, response_due_by, state, outcome_code, raw, created_at, updated_at';
const ACTION_COLUMNS = 'id, dispute_id, facts_id, outcome, rule, action_type, params, memo, evidence_note, buyer_message, note_source, status, approved_by, paypal_response, error, created_at, decided_at';

const toDispute = (r: DisputeRow): DisputeRecord => ({
  id: r.paypal_dispute_id,
  orderId: r.order_id,
  captureId: r.capture_id,
  reason: r.reason,
  stage: r.stage,
  status: r.status,
  amountCents: r.amount_cents,
  currency: r.currency,
  buyerMessage: r.buyer_message,
  claimType: r.claim_type,
  claimSource: r.claim_source,
  claimConflict: r.claim_conflict,
  responseDueBy: r.response_due_by,
  state: r.state,
  outcomeCode: r.outcome_code,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toAction = (r: ActionRow): ActionRecord => ({
  id: r.id,
  disputeId: r.dispute_id,
  factsId: r.facts_id,
  outcome: r.outcome,
  rule: r.rule,
  actionType: r.action_type,
  params: r.params,
  memo: r.memo,
  evidenceNote: r.evidence_note,
  buyerMessage: r.buyer_message,
  noteSource: r.note_source,
  status: r.status,
  approvedBy: r.approved_by,
  paypalResponse: r.paypal_response,
  error: r.error,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
});

const AUTOPILOT_ACTIONS: ReadonlySet<ActionType> = new Set(['provide-evidence', 'accept-claim', 'make-offer']);

interface Plan {
  readonly type: ActionType;
  readonly params: Record<string, JsonValue>;
  /** Why the table's first choice could not be used, when it could not. */
  readonly note: string | null;
}

export class DisputeService {
  private readonly o: DisputeServiceOptions;

  constructor(options: DisputeServiceOptions) {
    this.o = options;
  }

  // ---- autopilot ----------------------------------------------------------------------------------------------------

  async autopilot(): Promise<boolean> {
    const row = maybeOne(await this.o.db.query<{ value: boolean }>("SELECT value FROM settings WHERE key = 'dispute_autopilot'"));
    return row === null ? this.o.config.disputeAutopilot : row.value === true;
  }

  async setAutopilot(on: boolean): Promise<void> {
    await this.o.db.query("INSERT INTO settings (key, value) VALUES ('dispute_autopilot', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [json(on)]);
  }

  // ---- intake -------------------------------------------------------------------------------------------------------

  /** Wired to `merchant.onDisputeEvent`: react to PayPal's dispute webhooks. */
  async handleEvent(event: WebhookEvent): Promise<void> {
    const resource = (typeof event.resource === 'object' && event.resource !== null ? event.resource : {}) as Record<string, unknown>;
    const id = typeof resource['dispute_id'] === 'string' ? resource['dispute_id'] : typeof resource['id'] === 'string' ? resource['id'] : null;
    if (id === null) return;
    await this.ingest(id);
  }

  /**
   * Read a dispute from PayPal, record it, and analyse it when it is waiting for us and has no open proposal. Safe to call
   * repeatedly (webhook retries, the console's refresh button).
   */
  async ingest(disputeId: string): Promise<DisputeDetail> {
    let summary: DisputeSummary;
    try {
      summary = await this.o.paypal.tools.getDispute(disputeId);
    } catch (error) {
      throw new DisputeError('PAYPAL', `could not read dispute ${disputeId} from PayPal: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    const before = await this.dispute(disputeId);
    await this.upsert(summary, before);
    if (summary.status === 'RESOLVED') {
      await this.close(disputeId, summary);
    } else if (summary.status === 'WAITING_FOR_SELLER_RESPONSE') {
      const open = (await this.actions(disputeId)).some((a) => a.status === 'proposed');
      if (before === null || (!open && (before.state === 'received' || before.state === 'responded'))) await this.analyze(disputeId);
    }
    return this.detail(disputeId);
  }

  private async upsert(summary: DisputeSummary, before: DisputeRecord | null): Promise<void> {
    const now = nowSeconds(this.o.clock);
    const captureId = summary.sellerTransactionIds[0] ?? null;
    const order = captureId === null ? null : await this.o.merchant.orderByCaptureId(captureId);
    const buyerMessage = [...summary.messages].reverse().find((m) => m.postedBy === 'BUYER')?.content ?? null;
    await this.o.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`dispute:${summary.id}`]);
      if (before === null) {
        await tx.query(
          `INSERT INTO disputes (${DISPUTE_COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,NULL,false,$10,'received',$11,$12::jsonb,$13,$13) ON CONFLICT (paypal_dispute_id) DO NOTHING`,
          [summary.id, order?.id ?? null, captureId, summary.reason, summary.stage, summary.status, summary.amountCents, summary.currency, buyerMessage, summary.sellerResponseDueBy, summary.outcomeCode, json(summary), now],
        );
        await appendToChain(tx, 'ledger_entries', { chainId: `dispute:${summary.id}`, type: 'dispute_received', payload: { reason: summary.reason, amount_cents: summary.amountCents, capture_id: captureId, order_id: order?.id ?? null } }, now);
      } else {
        await tx.query(
          'UPDATE disputes SET order_id = $2, capture_id = $3, reason = $4, stage = $5, status = $6, amount_cents = $7, currency = $8, buyer_message = $9, response_due_by = $10, outcome_code = $11, raw = $12::jsonb, updated_at = $13 WHERE paypal_dispute_id = $1',
          [summary.id, order?.id ?? null, captureId, summary.reason, summary.stage, summary.status, summary.amountCents, summary.currency, buyerMessage, summary.sellerResponseDueBy, summary.outcomeCode, json(summary), now],
        );
      }
    });
  }

  private async close(disputeId: string, summary: DisputeSummary): Promise<void> {
    const now = nowSeconds(this.o.clock);
    await this.o.db.transaction(async (tx) => {
      const rows = await tx.query("UPDATE disputes SET state = 'closed', outcome_code = $2, updated_at = $3 WHERE paypal_dispute_id = $1 AND state <> 'closed' RETURNING paypal_dispute_id", [disputeId, summary.outcomeCode, now]);
      if (rows.length === 0) return;
      await tx.query("UPDATE dispute_actions SET status = 'superseded', decided_at = $2 WHERE dispute_id = $1 AND status = 'proposed'", [disputeId, now]);
      await appendToChain(tx, 'ledger_entries', { chainId: `dispute:${disputeId}`, type: 'dispute_closed', payload: { outcome_code: summary.outcomeCode } }, now);
    });
  }

  // ---- analysis -----------------------------------------------------------------------------------------------------

  /** Facts, claim, table decision, notes, packet and a proposed action for one dispute. */
  async analyze(disputeId: string): Promise<{ analysis: AnalysisRecord; action: ActionRecord }> {
    const dispute = await this.require(disputeId);
    const summary = dispute.raw;
    const order = dispute.order_id === null ? null : await this.o.merchant.order(dispute.order_id);
    const { input, context } = await this.factsInput(summary, order);
    const facts = await computeFacts(input);

    const resolution = await resolveClaim({ reason: summary.reason, message: dispute.buyer_message }, this.o.claims);
    let decision: OutcomeDecision = decideOutcome(resolution.claim, facts);
    if (resolution.conflict) {
      decision = {
        ...decision,
        outcome: 'ESCALATE_TO_HUMAN',
        rule: 'CLAIM_CONFLICT',
        action: { type: 'alert' },
        alternatives: [decision.action, ...decision.alternatives],
        confidence: 'low',
        attribution: { agent_platform: 'unknown', merchant: 'unknown', principal: 'unknown' },
        flags: [...decision.flags, 'claim_conflict'],
      };
    }
    const stored: StoredDecision = { ...decision, claimConflict: resolution.conflict, claimSource: resolution.source };

    const plan = this.plan(stored, summary, context);
    const record = this.caseRecord(summary, order, input, context);
    const notes = await this.o.notes.write({ facts, decision: stored, record });
    const memo = plan.note === null ? notes.memo : `${notes.memo}\nNote: ${plan.note}`;

    const now = nowSeconds(this.o.clock);
    const factsId = this.o.ids.next('fct');
    const actionId = this.o.ids.next('act');
    const packet = context.bundle === null || plan.type !== 'provide-evidence' ? null : this.buildPacket(summary, order, facts, stored, notes.evidenceNote, context.bundle);

    await this.o.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`dispute:${disputeId}`]);
      await tx.query('INSERT INTO dispute_facts (id, dispute_id, facts, decision, computed_at) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5)', [factsId, disputeId, json(facts), json(stored), now]);
      await tx.query("UPDATE dispute_actions SET status = 'superseded', decided_at = $2 WHERE dispute_id = $1 AND status = 'proposed'", [disputeId, now]);
      await tx.query(
        `INSERT INTO dispute_actions (${ACTION_COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,'proposed',NULL,NULL,NULL,$12,NULL)`,
        [actionId, disputeId, factsId, stored.outcome, stored.rule, plan.type, json(plan.params), memo, notes.evidenceNote, notes.buyerMessage, notes.source, now],
      );
      if (packet !== null) {
        await tx.query('INSERT INTO evidence_packets (id, dispute_id, action_id, file_name, content_type, sha256, size_bytes, content_b64, packet, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)', [
          this.o.ids.next('pkt'),
          disputeId,
          actionId,
          packet.fileName,
          'application/pdf',
          packet.sha256,
          packet.bytes.length,
          Buffer.from(packet.bytes).toString('base64'),
          json(packet.json),
          now,
        ]);
      }
      const state: DisputeState = plan.type === 'alert' ? 'escalated' : 'awaiting_approval';
      await tx.query('UPDATE disputes SET claim_type = $2, claim_source = $3, claim_conflict = $4, state = $5, updated_at = $6 WHERE paypal_dispute_id = $1', [disputeId, resolution.claim, resolution.source, resolution.conflict, state, now]);
      await appendToChain(
        tx,
        'ledger_entries',
        { chainId: `dispute:${disputeId}`, type: 'analysis', payload: { facts_id: factsId, claim: resolution.claim, claim_source: resolution.source, conflict: resolution.conflict, outcome: stored.outcome, rule: stored.rule, action: plan.type, note_source: notes.source } },
        now,
      );
    });

    const action = (await this.action(actionId)) as ActionRecord;
    const analysis = (await this.latestAnalysis(disputeId)) as AnalysisRecord;
    if ((await this.autopilot()) && stored.confidence === 'normal' && !resolution.conflict && AUTOPILOT_ACTIONS.has(plan.type) && stored.outcome !== 'ESCALATE_TO_HUMAN') {
      return { analysis, action: await this.approve(actionId, 'autopilot') };
    }
    return { analysis, action };
  }

  /**
   * The facts for an order with no dispute attached: what a reviewer would see if one were opened now. The public
   * verification page uses it, so it shows the same computed facts the dispute agent relies on.
   */
  async factsForOrder(order: OrderRecord): Promise<Facts> {
    const summary: DisputeSummary = {
      id: `verification:${order.id}`,
      reason: 'OTHER',
      status: 'OTHER',
      stage: null,
      currency: order.currency,
      amountCents: 0,
      sellerTransactionIds: order.captureId === null ? [] : [order.captureId],
      createdAt: null,
      updatedAt: null,
      sellerResponseDueBy: null,
      messages: [],
      evidences: [],
      allowedAcceptClaimTypes: [],
      allowedOfferTypes: [],
      outcomeCode: null,
    };
    const { input } = await this.factsInput(summary, order);
    return computeFacts(input);
  }

  /** What the facts engine needs, read from PayPal and the merchant's own records. */
  private async factsInput(summary: DisputeSummary, order: OrderRecord | null): Promise<{ input: FactsInput; context: AnalysisContext }> {
    const { merchant, paypal, registry, wallet, store, clock, db } = this.o;
    const orderCartJti = order?.cartJti ?? null;
    const bundle = orderCartJti === null ? null : await merchant.bundleOf(orderCartJti);
    const parsed = bundle === null ? null : parseBundle(bundle);
    const decoded = parsed !== null && parsed.ok ? decodeBundle(parsed.value) : null;
    const cart: CartPayload | null = decoded !== null && decoded.cart.ok ? decoded.cart.payload : null;
    const mandate = decoded !== null && decoded.mandate.ok ? decoded.mandate.payload : null;
    const cartHash = cart === null ? null : hashCartBody(cart.cart);

    const [lookup, record] = await Promise.all([registry.lookup(), cart !== null && cartHash !== null ? wallet.walletRecord({ cartJti: cart.jti, cartHash }) : Promise.resolve(null)]);
    const categories = new Map<string, string>();
    for (const line of cart?.cart.items ?? []) {
      const product = await store.get(line.sku);
      if (product !== null) categories.set(line.sku, product.category);
    }
    const counts =
      cart === null
        ? { nonce: 0, jti: 0 }
        : {
            nonce: (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM warrants WHERE nonce = $1 OR nonce LIKE $1 || '#%'", [cart.nonce]))[0]?.n ?? 0,
            jti: (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM warrants WHERE cart_jti = $1', [cart.jti]))[0]?.n ?? 0,
          };
    const spentBefore =
      order === null || order.mandateJti === null
        ? null
        : await this.spendBefore(order);
    const captureId = summary.sellerTransactionIds[0] ?? null;
    const [remoteOrder, remoteCapture, tracking, refunds, transparency] = await Promise.all([
      (order?.paypalOrderId ?? null) === null ? Promise.resolve(null) : paypal.tools.getOrder(order?.paypalOrderId ?? '').catch(() => null),
      captureId === null ? Promise.resolve(null) : paypal.client.getCapture(captureId).catch(() => null),
      order === null ? Promise.resolve(null) : merchant.tracking(order.id),
      order === null ? Promise.resolve([]) : merchant.refunds(order.id),
      cart === null ? Promise.resolve(null) : registry.transparencyView(cart.jti),
    ]);

    const input: FactsInput = {
      now: nowSeconds(clock),
      bundle,
      merchantId: this.o.config.paypal.merchantId,
      merchantMode: order?.verifierMode ?? (await store.merchantMode()),
      registry: lookup,
      categoryOf: (sku) => categories.get(sku) ?? null,
      walletRecord: () => record,
      nonceUseCount: counts.nonce,
      jtiUseCount: counts.jti,
      spentBefore,
      order:
        remoteOrder === null
          ? null
          : { id: remoteOrder.id, currency: remoteOrder.currency, totalCents: remoteOrder.totalCents, payerId: remoteOrder.payerId, lines: remoteOrder.lines === null ? null : remoteOrder.lines.map((l) => ({ sku: l.sku, quantity: l.quantity, unitAmountCents: l.unitAmountCents })) },
      capture: remoteCapture === null ? null : { id: remoteCapture.id, amountCents: remoteCapture.amountCents, currency: remoteCapture.currency },
      dispute: { id: summary.id, disputedAmountCents: summary.amountCents, responseDueBy: summary.sellerResponseDueBy },
      tracking:
        tracking === null
          ? null
          : { delivered: tracking.status === 'delivered', deliveredAt: tracking.deliveredAt, promisedBy: tracking.promisedBy, trackingNumber: tracking.trackingNumber },
      fulfilledListings: tracking?.fulfilledListings ?? null,
      refunds: refunds.map((r) => ({ id: r.id, amountCents: r.amountCents })),
      transparency,
    };
    return { input, context: { bundle, cart, mandate, cartHash, tracking, captureCents: remoteCapture?.amountCents ?? null } };
  }

  /** Spend under the mandate before this order: earlier orders that were still counted against the budget. */
  private async spendBefore(order: OrderRecord): Promise<{ totalCents: number; itemCount: number } | null> {
    if (order.mandateJti === null) return null;
    const row = maybeOne(
      await this.o.db.query<{ t: number; n: number }>(
        "SELECT COALESCE(SUM(total_cents), 0)::bigint AS t, COALESCE(SUM(item_count), 0)::bigint AS n FROM orders WHERE mandate_jti = $1 AND status IN ('pending_review','created','approved','captured') AND (created_at < $2 OR (created_at = $2 AND id < $3))",
        [order.mandateJti, order.createdAt, order.id],
      ),
    );
    return { totalCents: Number(row?.t ?? 0), itemCount: Number(row?.n ?? 0) };
  }

  private caseRecord(summary: DisputeSummary, order: OrderRecord | null, input: FactsInput, context: AnalysisContext): CaseRecord {
    const cart = context.cart;
    return {
      disputeId: summary.id,
      reason: summary.reason,
      amountCents: summary.amountCents,
      currency: summary.currency,
      orderId: order?.id ?? null,
      captureId: summary.sellerTransactionIds[0] ?? null,
      cartJti: cart?.jti ?? null,
      cartHash: context.cartHash,
      consentApprovedAt: cart?.consent.approved_at ?? null,
      items: cart?.cart.items.map((i) => ({ title: i.title, qty: i.qty })) ?? [],
      tracking: context.tracking === null ? null : { carrier: context.tracking.carrier, number: context.tracking.trackingNumber, deliveredAt: context.tracking.deliveredAt },
      refundIds: input.refunds.map((r) => r.id),
      verifyUrl: cart === null ? null : `${this.o.config.publicBaseUrl}/v/${cart.jti}`,
      merchantName: this.o.config.merchantName,
    };
  }

  /**
   * Turn the table's action into a concrete PayPal call and check it against what PayPal allows right now. If the first
   * choice is not allowed, the table's alternatives are tried in order; if none is, the dispute goes to a person.
   */
  private plan(decision: OutcomeDecision, summary: DisputeSummary, context: AnalysisContext): Plan {
    const candidates: ProposedAction[] = [decision.action, ...decision.alternatives];
    const refusals: string[] = [];
    for (const candidate of candidates) {
      const result = this.vet(candidate, summary, context);
      if (result.ok) return { type: result.type, params: result.params, note: refusals.length === 0 ? null : `the first choice was not available (${refusals.join('; ')})` };
      refusals.push(result.reason);
    }
    return { type: 'alert', params: { reason: refusals.join('; ') }, note: null };
  }

  private vet(action: ProposedAction, summary: DisputeSummary, context: AnalysisContext): { ok: true; type: ActionType; params: Record<string, JsonValue> } | { ok: false; reason: string } {
    const waiting = summary.status === 'WAITING_FOR_SELLER_RESPONSE';
    switch (action.type) {
      case 'none':
      case 'alert':
        return { ok: true, type: action.type, params: {} };
      case 'provide-evidence':
        if (!waiting) return { ok: false, reason: `evidence cannot be provided while the dispute is ${summary.status}` };
        return { ok: true, type: 'provide-evidence', params: { evidence_type: context.tracking === null ? 'OTHER' : 'PROOF_OF_FULFILLMENT' } };
      case 'accept-claim': {
        const partial = action.detail === 'PARTIAL_REFUND';
        const type = partial ? 'PARTIAL_REFUND' : 'REFUND';
        if (!summary.allowedAcceptClaimTypes.includes(type)) return { ok: false, reason: `PayPal does not allow accept-claim ${type} for this dispute` };
        if (!partial) return { ok: true, type: 'accept-claim', params: { accept_claim_type: 'REFUND' } };
        const consented = context.cart === null ? null : parseMoney(context.cart.cart.total);
        const over = consented === null || context.captureCents === null ? 0 : Math.min(summary.amountCents, context.captureCents - consented);
        if (!(over > 0)) return { ok: false, reason: 'the overcharge to refund could not be worked out' };
        return { ok: true, type: 'accept-claim', params: { accept_claim_type: 'PARTIAL_REFUND', refund_amount_cents: over } };
      }
      case 'make-offer': {
        const offer = (action.detail ?? 'REFUND') as OfferType;
        if (!summary.allowedOfferTypes.includes(offer)) return { ok: false, reason: `PayPal does not allow an offer of type ${offer} for this dispute` };
        return { ok: true, type: 'make-offer', params: { offer_type: offer, offer_amount_cents: summary.amountCents } };
      }
    }
  }

  private buildPacket(summary: DisputeSummary, order: OrderRecord | null, facts: Facts, decision: StoredDecision, evidenceNote: string, bundle: unknown) {
    const packetJson = buildEvidencePacket(facts, bundle);
    const lines: string[] = [
      `Dispute ${summary.id}   Reason ${summary.reason}   Amount ${formatMoney(summary.amountCents)} ${summary.currency}`,
      `Order ${order?.id ?? 'none'}   Capture ${summary.sellerTransactionIds[0] ?? 'none'}   PayPal order ${order?.paypalOrderId ?? 'none'}`,
      `Prepared ${formatInstant(nowSeconds(this.o.clock))} by ${this.o.config.merchantName}`,
      '',
      'SUMMARY',
      ...evidenceNote.split('\n'),
      '',
      'VERIFICATION FACTS (computed by code from the signed record, PayPal data and merchant records)',
      ...(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'F13'] as const).flatMap((id) => {
        const f = facts[id];
        return [`${f.id} ${f.name}: ${String(f.value)}`, ...f.evidence.map((e) => `    ${e}`)];
      }),
      '',
      'DECISION (advisory)',
      `Claim ${decision.claim}   Outcome ${decision.outcome}   Rule ${decision.rule}`,
      `Responsibility: agent platform ${decision.attribution.agent_platform}, merchant ${decision.attribution.merchant}, buyer ${decision.attribution.principal}`,
      decision.caveat,
      '',
      'APPENDIX: EVIDENCE PACKET (machine-readable)',
      ...JSON.stringify(packetJson, null, 2).split('\n'),
    ];
    const bytes = textPdf({ title: `Warrant evidence packet - dispute ${summary.id}`, lines });
    const sha256 = `sha256:${createHash('sha256').update(bytes).digest('base64url')}`;
    return { bytes, sha256, json: packetJson as JsonValue, fileName: `warrant-evidence-${summary.id}.pdf` };
  }

  // ---- decisions ----------------------------------------------------------------------------------------------------

  /** Approve a proposed action and carry it out. `actor` is recorded: a console user, or `autopilot`. */
  async approve(actionId: string, actor: string): Promise<ActionRecord> {
    const claimed = await this.o.db.query<ActionRow>(`UPDATE dispute_actions SET approved_by = $2 WHERE id = $1 AND status = 'proposed' AND approved_by IS NULL RETURNING ${ACTION_COLUMNS}`, [actionId, actor]);
    const row = claimed[0];
    if (row === undefined) {
      const existing = await this.action(actionId);
      if (existing === null) throw new DisputeError('NOT_FOUND', `unknown action ${actionId}`);
      throw new DisputeError('CONFLICT', `action ${actionId} is ${existing.status}${existing.approvedBy === null ? '' : ` (decided by ${existing.approvedBy})`}`);
    }
    return this.execute(toAction(row), actor);
  }

  async reject(actionId: string, actor: string): Promise<ActionRecord> {
    const now = nowSeconds(this.o.clock);
    const rows = await this.o.db.transaction(async (tx) => {
      const updated = await tx.query<ActionRow>(`UPDATE dispute_actions SET status = 'rejected', approved_by = $2, decided_at = $3 WHERE id = $1 AND status = 'proposed' AND approved_by IS NULL RETURNING ${ACTION_COLUMNS}`, [actionId, actor, now]);
      const row = updated[0];
      if (row !== undefined) {
        await tx.query("UPDATE disputes SET state = 'escalated', updated_at = $2 WHERE paypal_dispute_id = $1 AND state <> 'closed'", [row.dispute_id, now]);
        await appendToChain(tx, 'ledger_entries', { chainId: `dispute:${row.dispute_id}`, type: 'action_rejected', payload: { action_id: actionId, by: actor, action: row.action_type } }, now);
      }
      return updated;
    });
    const row = rows[0];
    if (row === undefined) throw new DisputeError('CONFLICT', `action ${actionId} is not waiting for a decision`);
    return toAction(row);
  }

  private async execute(action: ActionRecord, actor: string): Promise<ActionRecord> {
    const now = () => nowSeconds(this.o.clock);
    const finish = async (status: 'executed' | 'failed', response: JsonValue | null, error: string | null, state: DisputeState): Promise<ActionRecord> => {
      const at = now();
      await this.o.db.transaction(async (tx) => {
        await tx.query('UPDATE dispute_actions SET status = $2, paypal_response = $3::jsonb, error = $4, decided_at = $5 WHERE id = $1', [action.id, status, response === null ? null : json(response), error, at]);
        await tx.query("UPDATE disputes SET state = CASE WHEN state = 'closed' THEN state ELSE $2 END, updated_at = $3 WHERE paypal_dispute_id = $1", [action.disputeId, state, at]);
        await appendToChain(tx, 'ledger_entries', { chainId: `dispute:${action.disputeId}`, type: status === 'executed' ? 'action_executed' : 'action_failed', payload: { action_id: action.id, action: action.actionType, by: actor, error } }, at);
      });
      return (await this.action(action.id)) as ActionRecord;
    };

    if (action.actionType === 'alert') return finish('executed', { note: 'escalated to a person; no PayPal call' }, null, 'escalated');
    if (action.actionType === 'none') return finish('executed', { note: 'no PayPal call needed' }, null, 'responded');

    const dispute = await this.require(action.disputeId);
    let current: DisputeSummary;
    try {
      current = await this.o.paypal.tools.getDispute(action.disputeId);
    } catch (error) {
      return finish('failed', null, `could not read the dispute from PayPal: ${error instanceof Error ? error.message : 'unknown error'}`, 'escalated');
    }
    if (current.status !== 'WAITING_FOR_SELLER_RESPONSE') {
      return finish('failed', null, `the dispute is now ${current.status}, not waiting for the seller`, current.status === 'RESOLVED' ? 'closed' : 'escalated');
    }
    const requestId = `${action.disputeId}:${action.id}`;
    const client = this.o.paypal.client;
    try {
      if (action.actionType === 'provide-evidence') {
        const packet = await this.packetFor(action.id);
        const tracking = dispute.order_id === null ? null : await this.o.merchant.tracking(dispute.order_id);
        const verifyLine = packet === null ? '' : ` Evidence packet sha256 ${packet.sha256}.`;
        await client.provideEvidence(
          action.disputeId,
          {
            evidences: [
              {
                evidenceType: typeof action.params['evidence_type'] === 'string' ? action.params['evidence_type'] : 'OTHER',
                notes: action.evidenceNote.slice(0, 2000),
                ...(tracking === null ? {} : { trackingInfo: [{ carrierName: tracking.carrier, trackingNumber: tracking.trackingNumber }] }),
              },
              ...(verifyLine === '' ? [] : [{ evidenceType: 'OTHER', notes: `Signed purchase record attached as PDF.${verifyLine}`.slice(0, 2000) }]),
            ],
            ...(packet === null ? {} : { files: [{ name: packet.fileName, contentType: packet.contentType, data: packet.bytes }] }),
          },
          requestId,
        );
      } else if (action.actionType === 'accept-claim') {
        const type = action.params['accept_claim_type'] === 'PARTIAL_REFUND' ? 'PARTIAL_REFUND' : 'REFUND';
        const reason: AcceptClaimReason = dispute.claim_type === 'NOT_RECEIVED' ? 'DID_NOT_SHIP_ITEM' : 'REASON_NOT_SET';
        const amount = Number(action.params['refund_amount_cents']);
        await client.acceptClaim(
          action.disputeId,
          { note: action.buyerMessage.slice(0, 2000), reason, acceptClaimType: type, ...(type === 'PARTIAL_REFUND' ? { refundAmount: { currency: current.currency, cents: amount } } : {}) },
          requestId,
        );
      } else {
        await client.makeOffer(
          action.disputeId,
          { note: action.buyerMessage.slice(0, 2000), offerType: action.params['offer_type'] as OfferType, offerAmount: { currency: current.currency, cents: Number(action.params['offer_amount_cents'] ?? current.amountCents) } },
          requestId,
        );
      }
    } catch (error) {
      const message = error instanceof PayPalError ? `PayPal refused the ${action.actionType}: ${error.message}` : `the ${action.actionType} failed: ${error instanceof Error ? error.message : 'unknown error'}`;
      return finish('failed', null, message, 'escalated');
    }
    return finish('executed', { request_id: requestId, action: action.actionType }, null, 'responded');
  }

  // ---- reads --------------------------------------------------------------------------------------------------------

  private async require(id: string): Promise<DisputeRow> {
    const row = maybeOne(await this.o.db.query<DisputeRow>(`SELECT ${DISPUTE_COLUMNS} FROM disputes WHERE paypal_dispute_id = $1`, [id]));
    if (row === null) throw new DisputeError('NOT_FOUND', `unknown dispute ${id}`);
    return row;
  }

  async dispute(id: string): Promise<DisputeRecord | null> {
    const row = maybeOne(await this.o.db.query<DisputeRow>(`SELECT ${DISPUTE_COLUMNS} FROM disputes WHERE paypal_dispute_id = $1`, [id]));
    return row === null ? null : toDispute(row);
  }

  async disputes(options: { state?: DisputeState; limit?: number } = {}): Promise<DisputeRecord[]> {
    const rows = await this.o.db.query<DisputeRow>(
      `SELECT ${DISPUTE_COLUMNS} FROM disputes ${options.state === undefined ? '' : 'WHERE state = $2'} ORDER BY created_at DESC, paypal_dispute_id DESC LIMIT $1`,
      options.state === undefined ? [options.limit ?? 100] : [options.limit ?? 100, options.state],
    );
    return rows.map(toDispute);
  }

  async action(id: string): Promise<ActionRecord | null> {
    const row = maybeOne(await this.o.db.query<ActionRow>(`SELECT ${ACTION_COLUMNS} FROM dispute_actions WHERE id = $1`, [id]));
    return row === null ? null : toAction(row);
  }

  async actions(disputeId: string): Promise<ActionRecord[]> {
    return (await this.o.db.query<ActionRow>(`SELECT ${ACTION_COLUMNS} FROM dispute_actions WHERE dispute_id = $1 ORDER BY created_at, id`, [disputeId])).map(toAction);
  }

  async latestAnalysis(disputeId: string): Promise<AnalysisRecord | null> {
    const row = maybeOne(await this.o.db.query<{ id: string; dispute_id: string; facts: Facts; decision: StoredDecision; computed_at: number }>('SELECT id, dispute_id, facts, decision, computed_at FROM dispute_facts WHERE dispute_id = $1 ORDER BY computed_at DESC, id DESC LIMIT 1', [disputeId]));
    return row === null ? null : { id: row.id, disputeId: row.dispute_id, facts: row.facts, decision: row.decision, computedAt: row.computed_at };
  }

  async detail(id: string): Promise<DisputeDetail> {
    const row = await this.require(id);
    const dispute = toDispute(row);
    return {
      dispute,
      order: dispute.orderId === null ? null : await this.o.merchant.order(dispute.orderId),
      analysis: await this.latestAnalysis(id),
      actions: await this.actions(id),
      packet: await this.packetMeta(id),
      paypal: row.raw,
    };
  }

  async packetMeta(disputeId: string): Promise<PacketMeta | null> {
    const row = maybeOne(await this.o.db.query<{ id: string; dispute_id: string; action_id: string | null; file_name: string; content_type: string; sha256: string; size_bytes: number; created_at: number }>('SELECT id, dispute_id, action_id, file_name, content_type, sha256, size_bytes, created_at FROM evidence_packets WHERE dispute_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [disputeId]));
    return row === null ? null : { id: row.id, disputeId: row.dispute_id, actionId: row.action_id, fileName: row.file_name, contentType: row.content_type, sha256: row.sha256, sizeBytes: row.size_bytes, createdAt: row.created_at };
  }

  /** The newest evidence packet file for a dispute (for download), or one tied to an action. */
  async packetFile(disputeId: string): Promise<{ fileName: string; contentType: string; sha256: string; bytes: Uint8Array } | null> {
    const row = maybeOne(await this.o.db.query<{ file_name: string; content_type: string; sha256: string; content_b64: string }>('SELECT file_name, content_type, sha256, content_b64 FROM evidence_packets WHERE dispute_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [disputeId]));
    return row === null ? null : { fileName: row.file_name, contentType: row.content_type, sha256: row.sha256, bytes: Buffer.from(row.content_b64, 'base64') };
  }

  private async packetFor(actionId: string): Promise<{ fileName: string; contentType: string; sha256: string; bytes: Uint8Array } | null> {
    const row = maybeOne(await this.o.db.query<{ file_name: string; content_type: string; sha256: string; content_b64: string }>('SELECT file_name, content_type, sha256, content_b64 FROM evidence_packets WHERE action_id = $1 ORDER BY created_at DESC LIMIT 1', [actionId]));
    return row === null ? null : { fileName: row.file_name, contentType: row.content_type, sha256: row.sha256, bytes: Buffer.from(row.content_b64, 'base64') };
  }
}

interface AnalysisContext {
  readonly bundle: unknown;
  readonly cart: CartPayload | null;
  readonly mandate: unknown;
  readonly cartHash: string | null;
  readonly tracking: Awaited<ReturnType<MerchantService['tracking']>>;
  readonly captureCents: number | null;
}
