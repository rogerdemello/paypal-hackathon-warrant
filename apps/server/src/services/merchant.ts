import { PayPalError, mapWebhookEvent, type OrderSummary, type WebhookEvent, type WebhookHeaders } from '@warrant/paypal';
import {
  addCents,
  decodeBundle,
  hashCartBody,
  hashCartWarrant,
  hashPayerId,
  paypalReferences,
  parseBundle,
  parseMoney,
  verifyCheckout,
  verifyPayerBinding,
  type CartPayload,
  type Finding,
  type JsonValue,
  type MerchantMode,
  type Outcome,
  type Spend,
  type VelocityContext,
  type VerifyResult,
} from '@warrant/warrant';
import { appendToChain } from '../chain';
import { nowSeconds, type Clock, type Ids } from '../clock';
import type { Config } from '../config';
import { isUniqueViolation, json, maybeOne, type Db, type Queryable } from '../db';
import type { PayPalGateway } from './paypal';
import type { RegistryService } from './registry';
import type { StoreService } from './store';
import type { WalletService } from './wallet';

/**
 * The merchant side: checkout verification (V01-V12), PayPal order creation and capture, fulfilment records, refunds and
 * webhooks. Everything that decides money state is deterministic code; PayPal stays the source of truth for payment state.
 */

export type OrderStatus = 'pending_review' | 'created' | 'approved' | 'captured' | 'rejected' | 'failed' | 'cancelled';

export interface OrderLineRecord {
  readonly sku: string;
  readonly title: string;
  readonly qty: number;
  readonly unitPriceCents: number;
  readonly listingHash: string | null;
}

export interface VerificationRecord {
  readonly outcome: Outcome | 'NO_WARRANT';
  readonly findings: readonly Finding[];
  readonly cartHash: string | null;
  readonly mandateHash: string | null;
  /** V11, once the buyer approved the PayPal order. */
  readonly payer?: Finding;
}

export interface OrderRecord {
  readonly id: string;
  readonly cartJti: string | null;
  readonly mandateJti: string | null;
  readonly paypalOrderId: string | null;
  readonly captureId: string | null;
  readonly status: OrderStatus;
  readonly verifierMode: MerchantMode;
  readonly verificationOutcome: string;
  readonly verification: VerificationRecord;
  readonly totalCents: number;
  readonly itemCount: number;
  readonly currency: string;
  readonly lines: readonly OrderLineRecord[];
  readonly payerIdHash: string | null;
  /** The PayPal `invoice_id` the order was opened with: `WRT-<cart hash prefix>`, with a counter when the cart repeats. */
  readonly invoiceId: string | null;
  readonly approvalUrl: string | null;
  readonly note: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface TrackingRecord {
  readonly orderId: string;
  readonly carrier: string;
  readonly trackingNumber: string;
  readonly status: 'shipped' | 'delivered';
  readonly promisedBy: number | null;
  readonly shippedAt: number;
  readonly deliveredAt: number | null;
  /** sku -> listing hash the store had when the order shipped (dispute fact F10). */
  readonly fulfilledListings: Readonly<Record<string, string>>;
}

export interface RefundRecord {
  readonly id: string;
  readonly orderId: string;
  readonly captureId: string;
  readonly amountCents: number;
  readonly status: string;
  readonly createdAt: number;
}

export interface CheckoutResult {
  readonly status: 'rejected' | 'pending_review' | 'approval_required' | 'failed';
  readonly outcome: Outcome;
  readonly findings: readonly Finding[];
  readonly attemptId: string;
  readonly orderId: string | null;
  readonly approvalUrl: string | null;
  readonly message: string;
}

export type CompleteStatus = 'captured' | 'awaiting_approval' | 'rejected' | 'failed' | 'not_payable';

export interface CompleteResult {
  readonly status: CompleteStatus;
  readonly order: OrderRecord;
  readonly message: string;
}

export interface MerchantOptions {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly config: Config;
  readonly registry: RegistryService;
  readonly wallet: WalletService;
  readonly store: StoreService;
  readonly paypal: PayPalGateway;
  readonly velocity?: Omit<VelocityContext, 'count'> | null;
}

export class MerchantError extends Error {
  override readonly name = 'MerchantError';
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID' | 'PAYPAL',
    message: string,
  ) {
    super(message);
  }
}

const DEFAULT_VELOCITY = { windowSeconds: 3600, maxPerPrincipal: 20, maxPerPlatform: 200 } as const;

interface OrderRow {
  id: string;
  cart_jti: string | null;
  mandate_jti: string | null;
  paypal_order_id: string | null;
  capture_id: string | null;
  status: OrderStatus;
  verifier_mode: MerchantMode;
  verification_outcome: string;
  verification: VerificationRecord;
  total_cents: number;
  item_count: number;
  currency: string;
  lines: OrderLineRecord[];
  payer_id_hash: string | null;
  invoice_id: string | null;
  approval_url: string | null;
  note: string | null;
  created_at: number;
  updated_at: number;
}

const ORDER_COLUMNS = 'id, cart_jti, mandate_jti, paypal_order_id, capture_id, status, verifier_mode, verification_outcome, verification, total_cents, item_count, currency, lines, payer_id_hash, invoice_id, approval_url, note, created_at, updated_at';

const toOrder = (r: OrderRow): OrderRecord => ({
  id: r.id,
  cartJti: r.cart_jti,
  mandateJti: r.mandate_jti,
  paypalOrderId: r.paypal_order_id,
  captureId: r.capture_id,
  status: r.status,
  verifierMode: r.verifier_mode,
  verificationOutcome: r.verification_outcome,
  verification: r.verification,
  totalCents: r.total_cents,
  itemCount: r.item_count,
  currency: r.currency,
  lines: r.lines,
  payerIdHash: r.payer_id_hash,
  invoiceId: r.invoice_id,
  approvalUrl: r.approval_url,
  note: r.note,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

interface Peek {
  readonly cart: CartPayload | null;
  readonly cartHash: string | null;
  readonly mandateJti: string | null;
  readonly principalRef: string | null;
  readonly platform: string | null;
  readonly mandateHash: string | null;
}

/** What can be read from a bundle without trusting it, to know which records to load. Verification re-checks everything. */
function peek(bundleInput: unknown): Peek {
  const empty: Peek = { cart: null, cartHash: null, mandateJti: null, principalRef: null, platform: null, mandateHash: null };
  const parsed = parseBundle(bundleInput);
  if (!parsed.ok) return empty;
  const decoded = decodeBundle(parsed.value);
  const cart = decoded.cart.ok ? decoded.cart.payload : null;
  const mandate = decoded.mandate.ok ? decoded.mandate.payload : null;
  return {
    cart,
    cartHash: cart === null ? null : hashCartBody(cart.cart),
    mandateJti: mandate?.jti ?? cart?.mandate.jti ?? null,
    principalRef: mandate?.principal.ref ?? null,
    platform: mandate?.agent.platform ?? null,
    mandateHash: decoded.mandate.ok ? decoded.mandate.hash : null,
  };
}

export type DisputeEventHandler = (event: WebhookEvent) => Promise<void>;

export class MerchantService {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: Ids;
  private readonly config: Config;
  private readonly registry: RegistryService;
  private readonly wallet: WalletService;
  private readonly store: StoreService;
  private readonly paypal: PayPalGateway;
  private readonly velocity: Omit<VelocityContext, 'count'> | null;
  private disputeHandler: DisputeEventHandler | null = null;

  constructor(options: MerchantOptions) {
    this.db = options.db;
    this.clock = options.clock;
    this.ids = options.ids;
    this.config = options.config;
    this.registry = options.registry;
    this.wallet = options.wallet;
    this.store = options.store;
    this.paypal = options.paypal;
    this.velocity = options.velocity === undefined ? DEFAULT_VELOCITY : options.velocity;
  }

  /** The dispute agent registers here to hear about `CUSTOMER.DISPUTE.*` events. */
  onDisputeEvent(handler: DisputeEventHandler): void {
    this.disputeHandler = handler;
  }

  get merchantId(): string {
    return this.config.paypal.merchantId;
  }

  // ---- checkout -----------------------------------------------------------------------------------------------------

  /**
   * Verify a warrant bundle and, if it passes, reserve its nonce, its cart id and the mandate spend, record the order and
   * open a PayPal order for the buyer to approve. Verification, the replay record and the spend reservation happen in one
   * transaction that holds a lock on the mandate, so two carts cannot both spend the same budget.
   */
  async checkout(bundleInput: unknown, options: { returnUrl?: string; cancelUrl?: string } = {}): Promise<CheckoutResult> {
    const now = nowSeconds(this.clock);
    const attemptId = this.ids.next('att');
    const seen = peek(bundleInput);
    const mode = await this.store.merchantMode();
    if (mode === 'NONE') return this.checkoutIgnoringWarrant(seen, attemptId, options);
    const enforce = mode === 'STRICT';

    const stored = await this.db
      .transaction(async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`mandate:${seen.mandateJti ?? 'none'}`]);
        const result = await this.verifyInTransaction(tx, bundleInput, seen, now);
        // A STRICT merchant turns away anything the rules reject. A PERMISSIVE one runs the same rules, records what they
        // found, and sells anyway; it can only refuse a bundle it cannot read at all.
        if ((enforce && result.outcome === 'REJECT') || seen.cart === null || seen.cartHash === null || seen.mandateJti === null) {
          await this.recordAttempt(tx, attemptId, seen.cart?.jti ?? null, seen.mandateJti, result, null, now);
          return { result, orderId: null as string | null, resubmitted: false };
        }
        const cart = seen.cart;
        let storedNonce = cart.nonce;
        if (!enforce) {
          // Resubmitting a cart that already has an order is idempotent; a reused nonce under a new cart is kept and counted.
          const existing = maybeOne(await tx.query<{ id: string }>('SELECT id FROM orders WHERE cart_jti = $1', [cart.jti]));
          if (existing !== null) {
            await this.recordAttempt(tx, attemptId, cart.jti, seen.mandateJti, result, existing.id, now);
            return { result, orderId: existing.id, resubmitted: true };
          }
          const used = await count(tx, "SELECT count(*)::int AS n FROM warrants WHERE nonce = $1 OR nonce LIKE $1 || '#%'", [cart.nonce]);
          if (used > 0) storedNonce = `${cart.nonce}#${used + 1}`;
        }
        const totalCents = parseMoney(cart.cart.total);
        const itemCount = cart.cart.items.reduce((sum, l) => sum + l.qty, 0);
        const orderId = this.ids.next('ord');
        await tx.query('INSERT INTO warrants (cart_jti, nonce, mandate_jti, mandate_hash, cart_hash, warrant_hash, principal_ref, platform, bundle, received_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)', [
          cart.jti,
          storedNonce,
          seen.mandateJti,
          result.mandateHash ?? cart.mandate.hash,
          result.cartHash,
          hashCartWarrant(cart),
          seen.principalRef,
          seen.platform,
          json(bundleInput),
          now,
        ]);
        await tx.query(
          'INSERT INTO mandate_spend (mandate_jti, total_cents, item_count) VALUES ($1, $2, $3) ON CONFLICT (mandate_jti) DO UPDATE SET total_cents = mandate_spend.total_cents + EXCLUDED.total_cents, item_count = mandate_spend.item_count + EXCLUDED.item_count',
          [seen.mandateJti, totalCents, itemCount],
        );
        const lines: OrderLineRecord[] = cart.cart.items.map((l) => ({ sku: l.sku, title: l.title, qty: l.qty, unitPriceCents: parseMoney(l.unit_price), listingHash: l.listing_hash }));
        const status: OrderStatus = enforce && result.outcome === 'REVIEW' ? 'pending_review' : 'created';
        const unenforced = !enforce && result.outcome === 'REJECT';
        const verification: VerificationRecord = { outcome: result.outcome, findings: result.findings, cartHash: result.cartHash, mandateHash: result.mandateHash };
        await tx.query(
          `INSERT INTO orders (${ORDER_COLUMNS}) VALUES ($1,$2,$3,NULL,NULL,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb,NULL,NULL,NULL,$13,$12,$12)`,
          [orderId, cart.jti, seen.mandateJti, status, mode, result.outcome, json(verification), totalCents, itemCount, cart.cart.currency, json(lines), now, unenforced ? `accepted without enforcement (${mode} merchant): ${firstReason(result.findings)}` : null],
        );
        await this.recordAttempt(tx, attemptId, cart.jti, seen.mandateJti, result, orderId, now);
        await appendToChain(
          tx,
          'ledger_entries',
          { chainId: `order:${orderId}`, type: 'order_received', payload: { cart_jti: cart.jti, cart_hash: result.cartHash, mandate_jti: seen.mandateJti, verification: result.outcome, total_cents: totalCents } },
          now,
        );
        return { result, orderId: orderId, resubmitted: false };
      })
      .catch((error: unknown) => {
        // A nonce or cart id the lock did not cover (the same nonce under another mandate): it is a replay all the same.
        if (!isUniqueViolation(error)) throw error;
        return { replay: true as const };
      });

    if ('replay' in stored) {
      const finding: Finding = { rule: 'V05_NONCE', outcome: 'reject', detail: 'the nonce or cart warrant jti was recorded by another checkout at the same moment (replay)' };
      await this.db.query('INSERT INTO checkout_attempts (id, cart_jti, outcome, findings, order_id, mandate_jti, created_at) VALUES ($1,$2,$3,$4::jsonb,NULL,$5,$6)', [attemptId, seen.cart?.jti ?? null, 'REJECT', json([finding]), seen.mandateJti, now]);
      return { status: 'rejected', outcome: 'REJECT', findings: [finding], attemptId, orderId: null, approvalUrl: null, message: 'checkout rejected: replay' };
    }

    const { result, orderId, resubmitted } = stored;
    if (orderId === null) {
      return { status: 'rejected', outcome: 'REJECT', findings: result.findings, attemptId, orderId: null, approvalUrl: null, message: `checkout rejected: ${firstReason(result.findings)}` };
    }
    if (resubmitted) {
      const existing = await this.requireOrder(orderId);
      const status = existing.status === 'created' && existing.approvalUrl !== null ? 'approval_required' : existing.status === 'pending_review' ? 'pending_review' : 'failed';
      return { status, outcome: result.outcome, findings: result.findings, attemptId, orderId, approvalUrl: status === 'approval_required' ? existing.approvalUrl : null, message: 'this cart already has an order' };
    }
    if (enforce && result.outcome === 'REVIEW') {
      return { status: 'pending_review', outcome: 'REVIEW', findings: result.findings, attemptId, orderId, approvalUrl: null, message: 'the merchant needs to review this order before payment' };
    }
    const opened = await this.openPayPalOrder(orderId, result, attemptId, options);
    return !enforce && result.outcome === 'REJECT' && opened.status === 'approval_required'
      ? { ...opened, message: `accepted without enforcement (${mode} merchant); the checks failed: ${firstReason(result.findings)}` }
      : opened;
  }

  /** A merchant that does not use warrants at all (mode NONE): the bundle is ignored and the cart is sold at the store's prices. */
  private async checkoutIgnoringWarrant(seen: Peek, attemptId: string, options: { returnUrl?: string; cancelUrl?: string }): Promise<CheckoutResult> {
    const now = nowSeconds(this.clock);
    const reject = async (detail: string): Promise<CheckoutResult> => {
      const finding: Finding = { rule: 'V01_SIGNATURE', outcome: 'reject', detail };
      await this.db.query('INSERT INTO checkout_attempts (id, cart_jti, outcome, findings, order_id, created_at) VALUES ($1,$2,$3,$4::jsonb,NULL,$5)', [attemptId, seen.cart?.jti ?? null, 'REJECT', json([finding]), now]);
      return { status: 'rejected', outcome: 'REJECT', findings: [finding], attemptId, orderId: null, approvalUrl: null, message: `checkout rejected: ${detail}` };
    };
    if (seen.cart === null) return reject('the request has no readable cart');
    try {
      return await this.directCheckout(seen.cart.cart.items.map((l) => ({ sku: l.sku, qty: l.qty })), options);
    } catch (error) {
      if (error instanceof MerchantError) return reject(error.message);
      throw error;
    }
  }

  private async verifyInTransaction(tx: Queryable, bundleInput: unknown, seen: Peek, now: number): Promise<VerifyResult> {
    const registry = await this.registry.lookup(tx);
    const catalog = await this.store.catalogFor(seen.cart?.cart.items.map((l) => l.sku) ?? [], tx);
    const nonceSeen = seen.cart === null ? false : (await tx.query('SELECT 1 FROM warrants WHERE nonce = $1', [seen.cart.nonce])).length > 0;
    const cartSeen = seen.cart === null ? false : (await tx.query('SELECT 1 FROM warrants WHERE cart_jti = $1', [seen.cart.jti])).length > 0;
    const record = seen.cart !== null && seen.cartHash !== null ? await this.wallet.walletRecord({ cartJti: seen.cart.jti, cartHash: seen.cartHash }, tx) : null;
    const spent = seen.mandateJti === null ? null : await this.spendUnder(seen.mandateJti, tx);
    const counts = await this.velocityCounts(tx, seen, now);
    return verifyCheckout(bundleInput, {
      now,
      merchantId: this.merchantId,
      registry,
      nonceSeen: () => nonceSeen,
      cartSeen: () => cartSeen,
      catalog,
      walletRecord: () => record,
      velocity: this.velocity === null ? null : { ...this.velocity, count: () => counts },
      spentUnderMandate: () => spent,
    });
  }

  private async velocityCounts(tx: Queryable, seen: Peek, now: number): Promise<{ principal: number; platform: number }> {
    if (this.velocity === null) return { principal: 0, platform: 0 };
    const since = now - this.velocity.windowSeconds;
    const principal = seen.principalRef === null ? 0 : await count(tx, 'SELECT count(*)::int AS n FROM warrants WHERE principal_ref = $1 AND received_at >= $2', [seen.principalRef, since]);
    const platform = seen.platform === null ? 0 : await count(tx, 'SELECT count(*)::int AS n FROM warrants WHERE platform = $1 AND received_at >= $2', [seen.platform, since]);
    return { principal, platform };
  }

  /** The spend recorded under a mandate: carts accepted and not abandoned. Zero when none. */
  async spendUnder(mandateJti: string, q: Queryable = this.db): Promise<Spend> {
    const row = maybeOne(await q.query<{ total_cents: number; item_count: number }>('SELECT total_cents, item_count FROM mandate_spend WHERE mandate_jti = $1', [mandateJti]));
    return { totalCents: row?.total_cents ?? 0, itemCount: row?.item_count ?? 0 };
  }

  private async recordAttempt(tx: Queryable, id: string, cartJti: string | null, mandateJti: string | null, result: VerifyResult, orderId: string | null, now: number): Promise<void> {
    await tx.query('INSERT INTO checkout_attempts (id, cart_jti, outcome, findings, order_id, mandate_jti, created_at) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)', [id, cartJti, result.outcome, json(result.findings), orderId, mandateJti, now]);
  }

  /** Open the PayPal order for an accepted cart. On failure the order is marked failed and its spend released. */
  private async openPayPalOrder(orderId: string, result: VerifyResult, attemptId: string, options: { returnUrl?: string; cancelUrl?: string }): Promise<CheckoutResult> {
    const order = await this.requireOrder(orderId);
    const cart = order.cartJti === null ? null : await this.warrantCart(order.cartJti);
    const base = cart === null ? { customId: `ord:${order.id}`, invoiceId: `ORD-${order.id}`.slice(0, 127) } : paypalReferences(cart);
    // The invoice id is derived from the cart hash, so buying the same cart twice repeats it, and a merchant account that
    // blocks duplicate invoice ids would refuse the second capture. Count the earlier orders and suffix the repeat.
    const earlier = await count(this.db, "SELECT count(*)::int AS n FROM orders WHERE id <> $1 AND (invoice_id = $2 OR invoice_id LIKE $2 || '-%')", [order.id, base.invoiceId]);
    const refs = { customId: base.customId, invoiceId: earlier === 0 ? base.invoiceId : `${base.invoiceId}-${earlier + 1}` };
    try {
      const created = await this.paypal.client.createOrder(
        {
          referenceId: order.id,
          customId: refs.customId,
          invoiceId: refs.invoiceId,
          description: 'Agent purchase (sandbox demo)',
          currency: order.currency,
          lines: order.lines.map((l) => ({ sku: l.sku, name: l.title, quantity: l.qty, unitCents: l.unitPriceCents })),
          totalCents: order.totalCents,
          brandName: this.config.merchantName,
          returnUrl: options.returnUrl ?? `${this.config.webOrigin}/checkout/return?order=${encodeURIComponent(order.id)}`,
          cancelUrl: options.cancelUrl ?? `${this.config.webOrigin}/checkout/cancel?order=${encodeURIComponent(order.id)}`,
        },
        `${order.id}:create`,
      );
      const now = nowSeconds(this.clock);
      await this.db.transaction(async (tx) => {
        await tx.query("UPDATE orders SET paypal_order_id = $2, approval_url = $3, invoice_id = $5, updated_at = $4 WHERE id = $1 AND status IN ('created','pending_review')", [order.id, created.id, created.approveUrl, now, refs.invoiceId]);
        await appendToChain(tx, 'ledger_entries', { chainId: `order:${order.id}`, type: 'paypal_order_created', payload: { paypal_order_id: created.id, custom_id: refs.customId, invoice_id: refs.invoiceId } }, now);
      });
      return { status: 'approval_required', outcome: result.outcome, findings: result.findings, attemptId, orderId: order.id, approvalUrl: created.approveUrl, message: 'send the buyer to PayPal to approve the payment' };
    } catch (error) {
      const reason = error instanceof PayPalError ? `PayPal refused the order (${error.message})` : `PayPal could not be reached (${error instanceof Error ? error.message : 'unknown error'})`;
      await this.failOrder(order.id, reason);
      return { status: 'failed', outcome: result.outcome, findings: result.findings, attemptId, orderId: order.id, approvalUrl: null, message: reason };
    }
  }

  /** Mark an order failed or rejected and give its budget back. Idempotent. */
  private async failOrder(orderId: string, reason: string, status: 'failed' | 'rejected' | 'cancelled' = 'failed'): Promise<void> {
    const now = nowSeconds(this.clock);
    await this.db.transaction(async (tx) => {
      const order = maybeOne(await tx.query<{ status: OrderStatus; mandate_jti: string | null; total_cents: number; item_count: number }>('SELECT status, mandate_jti, total_cents, item_count FROM orders WHERE id = $1 FOR UPDATE', [orderId]));
      if (order === null || order.status === 'captured' || order.status === 'failed' || order.status === 'rejected' || order.status === 'cancelled') return;
      await tx.query('UPDATE orders SET status = $2, note = $3, updated_at = $4 WHERE id = $1', [orderId, status, reason, now]);
      if (order.mandate_jti !== null) {
        await tx.query('UPDATE mandate_spend SET total_cents = GREATEST(total_cents - $2, 0), item_count = GREATEST(item_count - $3, 0) WHERE mandate_jti = $1', [order.mandate_jti, order.total_cents, order.item_count]);
      }
      await appendToChain(tx, 'ledger_entries', { chainId: `order:${orderId}`, type: `order_${status}`, payload: { reason } }, now);
    });
  }

  /** The console decides a held order: approve opens the PayPal order, reject releases the budget. */
  async decideReview(orderId: string, decision: 'approve' | 'reject', actor = 'merchant'): Promise<OrderRecord> {
    const order = await this.requireOrder(orderId);
    if (order.status !== 'pending_review') throw new MerchantError('CONFLICT', `order ${orderId} is not waiting for review`);
    if (decision === 'reject') {
      await this.failOrder(orderId, `rejected in review by ${actor}`, 'rejected');
      return this.requireOrder(orderId);
    }
    const claimed = await this.db.query("UPDATE orders SET status = 'created', updated_at = $2 WHERE id = $1 AND status = 'pending_review' RETURNING id", [orderId, nowSeconds(this.clock)]);
    if (claimed.length === 0) throw new MerchantError('CONFLICT', `order ${orderId} was already decided`);
    const verification = order.verification;
    await this.openPayPalOrder(orderId, { outcome: 'REVIEW', findings: verification.findings, cartHash: verification.cartHash, mandateHash: verification.mandateHash }, this.ids.next('att'), {});
    return this.requireOrder(orderId);
  }

  // ---- orders made without a warrant (a human at the store) ---------------------------------------------------------

  /**
   * A purchase with no warrant. A STRICT merchant refuses it; PERMISSIVE and NONE merchants take it and mark it as having
   * no warrant, so a later dispute can say so.
   */
  async directCheckout(items: ReadonlyArray<{ sku: string; qty: number }>, options: { returnUrl?: string; cancelUrl?: string } = {}): Promise<CheckoutResult> {
    const mode = await this.store.merchantMode();
    const attemptId = this.ids.next('att');
    const now = nowSeconds(this.clock);
    if (mode === 'STRICT') {
      const finding: Finding = { rule: 'V01_SIGNATURE', outcome: 'reject', detail: 'this merchant requires a warrant for every purchase (STRICT mode)' };
      await this.db.query('INSERT INTO checkout_attempts (id, cart_jti, outcome, findings, order_id, created_at) VALUES ($1,NULL,$2,$3::jsonb,NULL,$4)', [attemptId, 'REJECT', json([finding]), now]);
      return { status: 'rejected', outcome: 'REJECT', findings: [finding], attemptId, orderId: null, approvalUrl: null, message: 'checkout rejected: a warrant is required' };
    }
    const lines: OrderLineRecord[] = [];
    for (const item of items) {
      const product = await this.store.get(item.sku);
      if (product === null || !product.available) throw new MerchantError('INVALID', `${item.sku} is not available`);
      if (!Number.isSafeInteger(item.qty) || item.qty < 1) throw new MerchantError('INVALID', 'quantity must be a positive whole number');
      lines.push({ sku: product.sku, title: product.title, qty: item.qty, unitPriceCents: product.priceCents, listingHash: product.listingHash });
    }
    if (lines.length === 0) throw new MerchantError('INVALID', 'the order has no items');
    const totalCents = lines.reduce((sum, l) => addCents(sum, l.unitPriceCents * l.qty), 0);
    const itemCount = lines.reduce((sum, l) => sum + l.qty, 0);
    const orderId = this.ids.next('ord');
    const verification: VerificationRecord = { outcome: 'NO_WARRANT', findings: [], cartHash: null, mandateHash: null };
    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO orders (${ORDER_COLUMNS}) VALUES ($1,NULL,NULL,NULL,NULL,'created',$2,'NO_WARRANT',$3::jsonb,$4,$5,'USD',$6::jsonb,NULL,NULL,NULL,'purchase without a warrant',$7,$7)`,
        [orderId, mode, json(verification), totalCents, itemCount, json(lines), now],
      );
      await tx.query('INSERT INTO checkout_attempts (id, cart_jti, outcome, findings, order_id, created_at) VALUES ($1,NULL,$2,$3::jsonb,$4,$5)', [attemptId, 'ACCEPT', '[]', orderId, now]);
      await appendToChain(tx, 'ledger_entries', { chainId: `order:${orderId}`, type: 'order_received', payload: { warrant: false, mode, total_cents: totalCents } }, now);
    });
    return this.openPayPalOrder(orderId, { outcome: 'ACCEPT', findings: [], cartHash: null, mandateHash: null }, attemptId, options);
  }

  // ---- after the buyer approves --------------------------------------------------------------------------------------

  /**
   * Called when the buyer comes back from PayPal (and again by the approval webhook; it is idempotent): read the order,
   * check the payer (V11), capture, then log the warrant in the transparency log.
   */
  async completeOrder(orderId: string): Promise<CompleteResult> {
    let order = await this.requireOrder(orderId);
    const done = (status: CompleteStatus, message: string, o: OrderRecord = order): CompleteResult => ({ status, order: o, message });
    if (order.status === 'captured') return done('captured', 'already captured');
    // An earlier call (the return redirect or the approval webhook) may already have ended the order; say how it ended.
    if (order.status === 'rejected') return done('rejected', order.note ?? 'the order was rejected');
    if (order.status === 'failed' || order.status === 'cancelled') return done('failed', order.note ?? `the order ${order.status}`);
    if (order.status !== 'created' && order.status !== 'approved') return done('not_payable', `order is ${order.status}`);
    if (order.paypalOrderId === null) return done('not_payable', 'the PayPal order has not been opened yet');

    let remote: OrderSummary;
    try {
      remote = await this.paypal.client.getOrder(order.paypalOrderId);
    } catch (error) {
      throw new MerchantError('PAYPAL', `could not read the PayPal order: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    if (remote.status === 'COMPLETED' && remote.captures[0] !== undefined) {
      await this.finishCapture(order, remote.captures[0].id, remote.payerId);
      return done('captured', 'captured', await this.requireOrder(orderId));
    }
    if (remote.status !== 'APPROVED' || remote.payerId === null) return done('awaiting_approval', 'the buyer has not approved the payment yet');

    // V11: the payer who approved must be the principal the mandate names (first use binds).
    let payerFinding: Finding | undefined;
    if (order.cartJti !== null) {
      const bundle = await this.bundleOf(order.cartJti);
      const binding = verifyPayerBinding(bundle, remote.payerId);
      payerFinding = binding.finding;
      const principalRef = peek(bundle).principalRef;
      let bound = binding.outcome !== 'REJECT';
      if (bound && binding.firstUse && principalRef !== null) bound = await this.wallet.bindPayer(principalRef, binding.payerIdHash);
      if (!bound && order.verifierMode === 'STRICT') {
        await this.db.query('UPDATE orders SET verification = $2::jsonb, payer_id_hash = $3 WHERE id = $1', [order.id, json({ ...order.verification, payer: payerFinding }), binding.payerIdHash]);
        await this.failOrder(order.id, `payer binding failed: ${binding.finding.detail}`, 'rejected');
        return done('rejected', binding.finding.detail, await this.requireOrder(orderId));
      }
      await this.db.query('UPDATE orders SET verification = $2::jsonb, payer_id_hash = $3 WHERE id = $1', [order.id, json({ ...order.verification, payer: payerFinding }), binding.payerIdHash]);
    }
    await this.db.query("UPDATE orders SET status = 'approved', updated_at = $2 WHERE id = $1 AND status = 'created'", [order.id, nowSeconds(this.clock)]);

    let captured: OrderSummary;
    try {
      captured = await this.paypal.client.captureOrder(order.paypalOrderId, `${order.id}:capture`);
    } catch (error) {
      const reason = error instanceof PayPalError ? `PayPal declined the capture (${error.message})` : `capture failed (${error instanceof Error ? error.message : 'unknown error'})`;
      await this.failOrder(order.id, reason);
      return done('failed', reason, await this.requireOrder(orderId));
    }
    const capture = captured.captures[0];
    if (capture === undefined || capture.status !== 'COMPLETED') {
      const reason = `the capture did not complete (${capture?.status ?? 'no capture'})`;
      await this.failOrder(order.id, reason);
      return done('failed', reason, await this.requireOrder(orderId));
    }
    await this.finishCapture(order, capture.id, remote.payerId);
    order = await this.requireOrder(orderId);
    return done('captured', 'payment captured');
  }

  private async finishCapture(order: OrderRecord, captureId: string, payerId: string | null): Promise<void> {
    const now = nowSeconds(this.clock);
    const payerHash = payerId === null ? order.payerIdHash : hashPayerId(payerId);
    const changed = await this.db.transaction(async (tx) => {
      const rows = await tx.query("UPDATE orders SET status = 'captured', capture_id = $2, payer_id_hash = COALESCE($3, payer_id_hash), updated_at = $4 WHERE id = $1 AND status <> 'captured' RETURNING id", [order.id, captureId, payerHash, now]);
      if (rows.length === 0) return false;
      await appendToChain(tx, 'ledger_entries', { chainId: `order:${order.id}`, type: 'order_captured', payload: { capture_id: captureId, total_cents: order.totalCents, payer_id_hash: payerHash } }, now);
      return true;
    });
    if (changed && order.cartJti !== null) await this.logWarrant(order.cartJti);
  }

  /** Append the cart warrant hash to the registry's transparency log (idempotent). */
  async logWarrant(cartJti: string): Promise<void> {
    const row = maybeOne(await this.db.query<{ warrant_hash: string; mandate_hash: string; platform: string }>('SELECT warrant_hash, mandate_hash, platform FROM warrants WHERE cart_jti = $1', [cartJti]));
    if (row === null) return;
    await this.registry.logWarrant({ cartJti, warrantHash: row.warrant_hash, mandateHash: row.mandate_hash, platform: row.platform });
  }

  // ---- fulfilment and refunds ----------------------------------------------------------------------------------------

  async ship(orderId: string, input: { carrier: string; trackingNumber: string; promisedBy?: number }): Promise<{ tracking: TrackingRecord; warning: string | null }> {
    const order = await this.requireOrder(orderId);
    if (order.status !== 'captured' || order.captureId === null || order.paypalOrderId === null) throw new MerchantError('CONFLICT', 'only a paid order can be shipped');
    if (input.carrier.trim() === '' || input.trackingNumber.trim() === '') throw new MerchantError('INVALID', 'carrier and tracking number are required');
    const now = nowSeconds(this.clock);
    const fulfilledListings: Record<string, string> = {};
    for (const line of order.lines) {
      const listed = await this.store.get(line.sku);
      if (listed !== null) fulfilledListings[line.sku] = listed.listingHash;
    }
    await this.db.transaction(async (tx) => {
      await tx.query(
        'INSERT INTO tracking (order_id, carrier, tracking_number, status, promised_by, shipped_at, delivered_at, fulfilled_listings) VALUES ($1,$2,$3,$4,$5,$6,NULL,$7::jsonb) ON CONFLICT (order_id) DO UPDATE SET carrier = EXCLUDED.carrier, tracking_number = EXCLUDED.tracking_number, promised_by = EXCLUDED.promised_by, fulfilled_listings = EXCLUDED.fulfilled_listings',
        [order.id, input.carrier, input.trackingNumber, 'shipped', input.promisedBy ?? now + 5 * 86_400, now, json(fulfilledListings)],
      );
      await appendToChain(tx, 'ledger_entries', { chainId: `order:${order.id}`, type: 'order_shipped', payload: { carrier: input.carrier, tracking_number: input.trackingNumber } }, now);
    });
    let warning: string | null = null;
    try {
      await this.paypal.client.addTracking(order.paypalOrderId, { captureId: order.captureId, trackingNumber: input.trackingNumber, carrier: input.carrier, notifyPayer: false }, `${order.id}:tracking:${input.trackingNumber}`);
    } catch (error) {
      warning = `shipped, but PayPal did not accept the tracking number (${error instanceof Error ? error.message : 'unknown error'})`;
    }
    return { tracking: (await this.tracking(order.id)) as TrackingRecord, warning };
  }

  async deliver(orderId: string): Promise<TrackingRecord> {
    const tracking = await this.tracking(orderId);
    if (tracking === null) throw new MerchantError('CONFLICT', 'the order has not shipped');
    const now = nowSeconds(this.clock);
    await this.db.transaction(async (tx) => {
      await tx.query("UPDATE tracking SET status = 'delivered', delivered_at = COALESCE(delivered_at, $2) WHERE order_id = $1", [orderId, now]);
      await appendToChain(tx, 'ledger_entries', { chainId: `order:${orderId}`, type: 'order_delivered', payload: { tracking_number: tracking.trackingNumber } }, now);
    });
    return (await this.tracking(orderId)) as TrackingRecord;
  }

  async tracking(orderId: string, q: Queryable = this.db): Promise<TrackingRecord | null> {
    const row = maybeOne(await q.query<{ order_id: string; carrier: string; tracking_number: string; status: 'shipped' | 'delivered'; promised_by: number | null; shipped_at: number; delivered_at: number | null; fulfilled_listings: Record<string, string> }>('SELECT order_id, carrier, tracking_number, status, promised_by, shipped_at, delivered_at, fulfilled_listings FROM tracking WHERE order_id = $1', [orderId]));
    return row === null
      ? null
      : { orderId: row.order_id, carrier: row.carrier, trackingNumber: row.tracking_number, status: row.status, promisedBy: row.promised_by, shippedAt: row.shipped_at, deliveredAt: row.delivered_at, fulfilledListings: row.fulfilled_listings };
  }

  async refund(orderId: string, input: { amountCents?: number; note?: string } = {}): Promise<RefundRecord> {
    const order = await this.requireOrder(orderId);
    if (order.status !== 'captured' || order.captureId === null) throw new MerchantError('CONFLICT', 'only a paid order can be refunded');
    const refundKey = `${order.id}:refund:${(await this.refunds(orderId)).length + 1}`;
    const summary = await this.paypal.client.refundCapture(
      { captureId: order.captureId, currency: order.currency, ...(input.amountCents === undefined ? {} : { amountCents: input.amountCents }), ...(input.note === undefined ? {} : { note: input.note }) },
      refundKey,
    );
    return this.recordRefund(order, summary.id, summary.amountCents, summary.status);
  }

  /** Record a refund PayPal reports (from our own refund call or from a webhook). Idempotent on the refund id. */
  async recordRefund(order: OrderRecord, refundId: string, amountCents: number, status: string): Promise<RefundRecord> {
    const now = nowSeconds(this.clock);
    await this.db.transaction(async (tx) => {
      const inserted = await tx.query('INSERT INTO refunds (id, order_id, capture_id, amount_cents, status, created_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING RETURNING id', [refundId, order.id, order.captureId ?? '', amountCents, status, now]);
      if (inserted.length > 0) await appendToChain(tx, 'ledger_entries', { chainId: `order:${order.id}`, type: 'order_refunded', payload: { refund_id: refundId, amount_cents: amountCents } }, now);
    });
    return (await this.refunds(order.id)).find((r) => r.id === refundId) as RefundRecord;
  }

  async refunds(orderId: string, q: Queryable = this.db): Promise<RefundRecord[]> {
    const rows = await q.query<{ id: string; order_id: string; capture_id: string; amount_cents: number; status: string; created_at: number }>('SELECT id, order_id, capture_id, amount_cents, status, created_at FROM refunds WHERE order_id = $1 ORDER BY created_at, id', [orderId]);
    return rows.map((r) => ({ id: r.id, orderId: r.order_id, captureId: r.capture_id, amountCents: r.amount_cents, status: r.status, createdAt: r.created_at }));
  }

  // ---- webhooks ------------------------------------------------------------------------------------------------------

  /**
   * Handle one PayPal webhook delivery. `rawBody` must be the exact bytes received. Forged deliveries are recorded as
   * unverified and ignored; genuine ones are deduplicated on the event id and processed once.
   */
  async handleWebhook(headers: WebhookHeaders, rawBody: string): Promise<{ status: 'processed' | 'duplicate' | 'unverified' | 'invalid'; eventType?: string }> {
    const now = nowSeconds(this.clock);
    let event: WebhookEvent;
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
      event = mapWebhookEvent(payload);
    } catch {
      return { status: 'invalid' };
    }
    const verified = await this.paypal.client.verifyWebhookSignature(headers, rawBody, this.paypal.webhookId).catch(() => false);
    if (!verified) {
      await this.db.query('INSERT INTO webhook_events (paypal_event_id, type, verified, payload, received_at, processed_at, error) VALUES ($1,$2,false,$3::jsonb,$4,NULL,$5) ON CONFLICT (paypal_event_id) DO NOTHING', [
        `unverified:${this.ids.next('wh')}`,
        event.eventType,
        json(payload as JsonValue),
        now,
        'signature not verified',
      ]);
      return { status: 'unverified', eventType: event.eventType };
    }
    const inserted = await this.db.query('INSERT INTO webhook_events (paypal_event_id, type, verified, payload, received_at, processed_at, error) VALUES ($1,$2,true,$3::jsonb,$4,NULL,NULL) ON CONFLICT (paypal_event_id) DO NOTHING RETURNING paypal_event_id', [event.id, event.eventType, json(payload as JsonValue), now]);
    if (inserted.length === 0) return { status: 'duplicate', eventType: event.eventType };
    try {
      await this.dispatch(event);
      await this.db.query('UPDATE webhook_events SET processed_at = $2 WHERE paypal_event_id = $1', [event.id, nowSeconds(this.clock)]);
    } catch (error) {
      // Leave the event retryable: PayPal will redeliver, and the row records why this attempt failed.
      await this.db.query('DELETE FROM webhook_events WHERE paypal_event_id = $1', [event.id]);
      await this.db.query('INSERT INTO webhook_events (paypal_event_id, type, verified, payload, received_at, processed_at, error) VALUES ($1,$2,true,$3::jsonb,$4,NULL,$5) ON CONFLICT (paypal_event_id) DO NOTHING', [
        `failed:${event.id}:${this.ids.next('wh')}`,
        event.eventType,
        json(payload as JsonValue),
        now,
        error instanceof Error ? error.message : 'unknown error',
      ]);
      throw error;
    }
    return { status: 'processed', eventType: event.eventType };
  }

  private async dispatch(event: WebhookEvent): Promise<void> {
    const resource = (typeof event.resource === 'object' && event.resource !== null ? event.resource : {}) as Record<string, unknown>;
    switch (event.eventType) {
      case 'CHECKOUT.ORDER.APPROVED': {
        const order = await this.orderByPayPalOrderId(typeof resource['id'] === 'string' ? resource['id'] : '');
        if (order !== null) await this.completeOrder(order.id);
        return;
      }
      case 'PAYMENT.CAPTURE.REFUNDED': {
        const captureId = captureIdOfRefund(resource);
        const order = captureId === null ? null : await this.orderByCaptureId(captureId);
        const refundId = typeof resource['id'] === 'string' ? resource['id'] : null;
        const amount = typeof resource['amount'] === 'object' && resource['amount'] !== null ? (resource['amount'] as Record<string, unknown>)['value'] : null;
        if (order !== null && refundId !== null && typeof amount === 'string') await this.recordRefund(order, refundId, parseMoney(amount), typeof resource['status'] === 'string' ? resource['status'] : 'COMPLETED');
        return;
      }
      default:
        if (event.eventType.startsWith('CUSTOMER.DISPUTE.') && this.disputeHandler !== null) await this.disputeHandler(event);
    }
  }

  // ---- reads ---------------------------------------------------------------------------------------------------------

  async order(id: string, q: Queryable = this.db): Promise<OrderRecord | null> {
    const row = maybeOne(await q.query<OrderRow>(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1`, [id]));
    return row === null ? null : toOrder(row);
  }

  private async requireOrder(id: string): Promise<OrderRecord> {
    const order = await this.order(id);
    if (order === null) throw new MerchantError('NOT_FOUND', `unknown order ${id}`);
    return order;
  }

  async orderByCartJti(cartJti: string): Promise<OrderRecord | null> {
    const row = maybeOne(await this.db.query<OrderRow>(`SELECT ${ORDER_COLUMNS} FROM orders WHERE cart_jti = $1`, [cartJti]));
    return row === null ? null : toOrder(row);
  }

  async orderByCaptureId(captureId: string): Promise<OrderRecord | null> {
    const row = maybeOne(await this.db.query<OrderRow>(`SELECT ${ORDER_COLUMNS} FROM orders WHERE capture_id = $1`, [captureId]));
    return row === null ? null : toOrder(row);
  }

  async orderByPayPalOrderId(paypalOrderId: string): Promise<OrderRecord | null> {
    const row = maybeOne(await this.db.query<OrderRow>(`SELECT ${ORDER_COLUMNS} FROM orders WHERE paypal_order_id = $1`, [paypalOrderId]));
    return row === null ? null : toOrder(row);
  }

  async orders(options: { status?: OrderStatus; limit?: number } = {}): Promise<OrderRecord[]> {
    const rows = await this.db.query<OrderRow>(
      `SELECT ${ORDER_COLUMNS} FROM orders ${options.status === undefined ? '' : 'WHERE status = $2'} ORDER BY created_at DESC, id DESC LIMIT $1`,
      options.status === undefined ? [options.limit ?? 100] : [options.limit ?? 100, options.status],
    );
    return rows.map(toOrder);
  }

  async attempts(limit = 50): Promise<Array<{ id: string; cartJti: string | null; mandateJti: string | null; outcome: string; findings: Finding[]; orderId: string | null; createdAt: number }>> {
    const rows = await this.db.query<{ id: string; cart_jti: string | null; mandate_jti: string | null; outcome: string; findings: Finding[]; order_id: string | null; created_at: number }>('SELECT id, cart_jti, mandate_jti, outcome, findings, order_id, created_at FROM checkout_attempts ORDER BY created_at DESC, id DESC LIMIT $1', [limit]);
    return rows.map((r) => ({ id: r.id, cartJti: r.cart_jti, mandateJti: r.mandate_jti, outcome: r.outcome, findings: r.findings, orderId: r.order_id, createdAt: r.created_at }));
  }

  /** The stored bundle for a cart warrant, as received. */
  async bundleOf(cartJti: string): Promise<unknown> {
    const row = maybeOne(await this.db.query<{ bundle: unknown }>('SELECT bundle FROM warrants WHERE cart_jti = $1', [cartJti]));
    return row?.bundle ?? null;
  }

  private async warrantCart(cartJti: string): Promise<CartPayload | null> {
    return peek(await this.bundleOf(cartJti)).cart;
  }
}

async function count(q: Queryable, sql: string, params: Array<string | number>): Promise<number> {
  return maybeOne(await q.query<{ n: number }>(sql, params))?.n ?? 0;
}

function firstReason(findings: readonly Finding[]): string {
  return findings.find((f) => f.outcome === 'reject')?.detail ?? 'verification failed';
}

/** A refund resource names its capture in a `links` entry (`rel: "up"`). */
function captureIdOfRefund(resource: Record<string, unknown>): string | null {
  const links = Array.isArray(resource['links']) ? (resource['links'] as unknown[]) : [];
  for (const link of links) {
    if (typeof link === 'object' && link !== null && (link as Record<string, unknown>)['rel'] === 'up') {
      const href = (link as Record<string, unknown>)['href'];
      if (typeof href === 'string') return href.split('/').pop() ?? null;
    }
  }
  return null;
}
