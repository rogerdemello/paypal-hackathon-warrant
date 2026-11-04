import { DEFAULT_SIM_PAYER, type SimPayer } from '@warrant/paypal';
import { FIXTURE_PRODUCTS, type Product } from '@warrant/catalog';
import { hashPayerId, merchantAudience, type Attribution, type CartLineInput } from '@warrant/warrant';
import { RulesClaimExtractor } from '../services/claims';
import type { Container } from '../container';
import { AGENT_ID, AGENT_ISS, AGENT_PLATFORM_ID } from '../identity';
import { DisputeService } from '../services/disputes';
import type { CheckoutResult, OrderRecord } from '../services/merchant';
import { LlmNoteWriter } from '../services/notes';
import type { MandateTerms, Principal } from '../services/wallet';
import { forgeFromHonest, forgeWithoutHonest, isHonestBased, type Forged, type HonestBase } from './forge';
import type { LineSpec, Scenario, ScenarioResult, StepRecord } from './scenario';

/**
 * Runs scenarios through the real services. Each run gets its own visitor, mandate and copies of the products it uses, so
 * scenarios cannot disturb each other or the live demo; the merchant's mode, which is global, is put back afterwards, and
 * runs are executed one at a time.
 */

const OTHER_PAYER: SimPayer = { payerId: 'SIMPAYER0002', email: 'other-buyer@example.com', name: 'A Different Buyer' };

export interface RunnerOptions {
  /** Move the clock forward (only possible with a manual clock). Without it, time-based steps use the real clock. */
  readonly advanceClock?: (seconds: number) => void;
}

export function needsSimulator(scenario: Scenario): boolean {
  return scenario.setup.dispute !== undefined || scenario.expect.dispute !== undefined || scenario.expect.payment !== undefined;
}

export class ScenarioRunner {
  private queue: Promise<unknown> = Promise.resolve();
  private counter = 0;

  constructor(
    private readonly c: Container,
    private readonly options: RunnerOptions = {},
  ) {}

  /** Run scenarios one at a time, even if several are requested together. */
  run(scenario: Scenario): Promise<ScenarioResult> {
    const next = this.queue.then(() => this.execute(scenario));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async execute(scenario: Scenario): Promise<ScenarioResult> {
    const started = performance.now();
    const steps: StepRecord[] = [];
    const failures: string[] = [];
    const step = (name: string, detail: string, ok = true) => steps.push({ name, detail, ok });
    const previousMode = await this.c.store.merchantMode();
    const runId = `lab${(this.counter++).toString(36)}${this.c.ids.token(3)}`;
    const actual: { -readonly [K in keyof ScenarioResult['actual']]: ScenarioResult['actual'][K] } = {
      verifier: null,
      rejectedRules: [],
      sold: false,
      payment: null,
      orderId: null,
      cartJti: null,
      disputeId: null,
      claim: null,
      outcome: null,
      rule: null,
      action: null,
      attribution: null,
      flags: [],
      confidence: null,
      state: null,
      noteSource: null,
    };
    let latencyMs: number | null = null;

    try {
      if (needsSimulator(scenario) && this.c.paypal.simulator === null) {
        failures.push('this scenario needs the PayPal simulator (PAYPAL_ENV=simulator)');
        return this.finish(scenario, failures, steps, actual, latencyMs, started);
      }
      const setup = scenario.setup;
      await this.c.store.setMerchantMode(setup.merchantMode ?? 'STRICT');
      step('merchant', `${setup.merchantMode ?? 'STRICT'} merchant`);

      const skuMap = new Map<string, string>();
      const storeSku = (sku: string) => skuMap.get(sku) ?? sku;
      const lineFor = async (spec: LineSpec): Promise<CartLineInput> => {
        let runSku = skuMap.get(spec.sku);
        if (runSku === undefined) {
          const product = FIXTURE_PRODUCTS.find((p) => p.id === spec.sku);
          if (product === undefined) throw new Error(`unknown scenario product ${spec.sku}`);
          runSku = `${runId}-${spec.sku}`;
          skuMap.set(spec.sku, runSku);
          await this.c.store.list({ ...product, id: runSku, url: `${product.url}?run=${runId}` } satisfies Product);
        }
        const listed = await this.c.store.get(runSku);
        if (listed === null) throw new Error(`the store lost ${runSku}`);
        return { sku: listed.sku, title: listed.title, qty: spec.qty ?? 1, unitPriceCents: listed.priceCents, listingHash: listed.listingHash };
      };

      // The person and their wallet.
      const principal: Principal = await this.c.wallet.ensurePrincipal(`lab-${runId}`, 'Lab shopper');
      if (setup.linkedPayer !== false) await this.c.wallet.bindPayer(principal.id, hashPayerId(DEFAULT_SIM_PAYER.payerId));
      const env = { c: this.c, nowSeconds: Math.floor(this.c.clock.nowMs() / 1000), line: lineFor, storeSku, principalId: principal.id, principalRef: principal.id };

      const m = setup.mandate ?? {};
      const terms: MandateTerms = {
        instructionText: 'Find a standing desk converter under $120',
        maxTotalCents: m.maxTotalCents ?? 12_000,
        ...(m.maxPerItemCents === undefined ? {} : { maxPerItemCents: m.maxPerItemCents }),
        maxItems: m.maxItems ?? 1,
        categoriesAllow: m.categoriesAllow === undefined ? null : m.categoriesAllow === null ? null : [...m.categoriesAllow],
        ...(m.merchantsAllow === undefined ? {} : { merchantsAllow: [...m.merchantsAllow] }),
        ...(m.merchantsDeny === undefined ? {} : { merchantsDeny: [...m.merchantsDeny] }),
        mode: m.mode ?? 'human_present',
        budgetMode: m.budgetMode ?? 'cumulative',
      };
      const mandate = await this.c.wallet.issueMandate(principal.id, { platform: AGENT_PLATFORM_ID, agentId: AGENT_ID, kid: this.c.keys.agent.kid }, terms);
      step('mandate', `${terms.mode} mandate for up to $${(terms.maxTotalCents / 100).toFixed(2)}, ${terms.maxItems} item(s), ${terms.budgetMode}`);

      const honestCart = async (specs: readonly LineSpec[]): Promise<HonestBase> => {
        const lines = await Promise.all(specs.map(lineFor));
        const proposal = await this.c.wallet.proposeCart({ mandateJti: mandate.jti, cartJti: this.c.ids.next('crt'), nonce: this.c.ids.token(), aud: merchantAudience(this.c.config.paypal.merchantId), proposedBy: AGENT_ISS, lines, currency: 'USD' });
        if (proposal.status === 'pending') await this.c.wallet.approve(principal.id, proposal.id);
        return { mandate, proposal, bundle: await this.c.platform.bundleFor(proposal.id), lines };
      };

      // Earlier purchases under the same mandate.
      for (const prior of setup.priorCarts ?? []) {
        const base = await honestCart(prior);
        const first = await this.c.merchant.checkout(base.bundle);
        step('earlier cart', `${first.status} (${first.outcome})`, first.orderId !== null);
      }

      // The cart under test.
      const cartSpecs = setup.cart ?? [{ sku: 'fx_desk_conv_32' }];
      let forged: Forged;
      const attack = setup.attack;
      if (attack === undefined) {
        const base = await honestCart(cartSpecs);
        forged = { bundle: base.bundle, description: 'an honest, human-approved cart' };
      } else if (isHonestBased(attack)) {
        const base = await honestCart(cartSpecs);
        forged = await forgeFromHonest(env, base, attack);
      } else {
        forged = await forgeWithoutHonest(env, mandate, attack, await Promise.all(cartSpecs.map(lineFor)));
      }
      step('bundle', forged.description);

      if (forged.submitFirst !== undefined) {
        const first = await this.c.merchant.checkout(forged.submitFirst);
        step('first submission', `${first.status} (${first.outcome})`, first.orderId !== null);
      }
      await forged.prepare?.();

      // Checkout.
      const checkout: CheckoutResult = await this.c.merchant.checkout(forged.bundle);
      actual.verifier = checkout.outcome;
      actual.rejectedRules = [...new Set(checkout.findings.filter((f) => f.outcome === 'reject').map((f) => f.rule))];
      actual.sold = checkout.orderId !== null;
      actual.orderId = checkout.orderId;
      step('checkout', `${checkout.status}: ${checkout.message}`);

      let order: OrderRecord | null = checkout.orderId === null ? null : await this.c.merchant.order(checkout.orderId);
      actual.cartJti = order?.cartJti ?? null;

      // Payment.
      const wantsPayment = scenario.expect.payment !== undefined || setup.dispute !== undefined;
      if (order !== null && wantsPayment && checkout.status === 'approval_required' && order.paypalOrderId !== null) {
        const simulator = this.c.paypal.simulator;
        if (simulator === null) throw new Error('payment needs the simulator');
        simulator.approveOrder(order.paypalOrderId, setup.payer === 'other' ? OTHER_PAYER : DEFAULT_SIM_PAYER);
        await simulator.flush();
        const done = await this.c.merchant.completeOrder(order.id);
        order = done.order;
        actual.payment = done.status;
        step('payment', `${done.status}: ${done.message}`);
      }

      // Fulfilment.
      const fulfilment = setup.fulfilment ?? (setup.dispute === undefined ? 'none' : 'none');
      if (order?.status === 'captured' && fulfilment !== 'none') {
        if (setup.listingChangedBeforeShipping === true) {
          const first = order.lines[0];
          if (first !== undefined) await this.c.store.setListingText(first.sku, { title: 'A different product entirely' });
          step('listing', 'the store changed the listing before shipping');
        }
        const now = Math.floor(this.c.clock.nowMs() / 1000);
        await this.c.merchant.ship(order.id, { carrier: 'UPS', trackingNumber: `1Z${runId.toUpperCase()}`, ...(fulfilment === 'delivered_late' ? { promisedBy: now - 86_400 } : {}) });
        if (fulfilment === 'delivered' || fulfilment === 'delivered_late') {
          this.options.advanceClock?.(2 * 86_400);
          await this.c.merchant.deliver(order.id);
        }
        step('fulfilment', fulfilment);
      }
      if (order?.status === 'captured' && setup.chargeExtraCents !== undefined && setup.chargeExtraCents > 0) {
        order = await this.overcharge(order, setup.chargeExtraCents);
        step('charge', `PayPal was charged $${(setup.chargeExtraCents / 100).toFixed(2)} more than the consented cart`);
      }
      if (order?.status === 'captured' && setup.refundBeforeDispute === true) {
        await this.c.merchant.refund(order.id, { note: 'goodwill refund' });
        step('refund', 'the merchant refunded the order before the dispute');
      }

      // The dispute.
      if (order?.status === 'captured' && order.captureId !== null && setup.dispute !== undefined) {
        const simulator = this.simulator();
        const t0 = performance.now();
        const opened = simulator.openDispute({
          captureId: order.captureId,
          reason: setup.dispute.reason,
          message: setup.dispute.message,
          responseDueInSeconds: Math.round((setup.dispute.dueInHours ?? 240) * 3600),
          ...(setup.dispute.amountCents === undefined ? {} : { amountCents: setup.dispute.amountCents }),
        });
        await simulator.flush();
        latencyMs = Math.round(performance.now() - t0);
        actual.disputeId = opened.disputeId;
        step('dispute', `${setup.dispute.reason}: "${setup.dispute.message}"`);

        if (setup.notes !== undefined) {
          const analysis = await this.reanalyseWithNotes(opened.disputeId, setup.notes);
          actual.noteSource = analysis;
          step('notes', `a ${setup.notes} note writer produced: ${analysis}`);
        }
        const detail = await this.c.disputes.detail(opened.disputeId);
        const decision = detail.analysis?.decision;
        const current = [...detail.actions].reverse().find((a) => a.status !== 'superseded');
        actual.claim = detail.dispute.claimType;
        actual.outcome = decision?.outcome ?? null;
        actual.rule = decision?.rule ?? null;
        actual.action = current === undefined ? null : current.actionType;
        actual.attribution = decision?.attribution ?? null;
        actual.flags = decision?.flags ?? [];
        actual.confidence = decision?.confidence ?? null;
        actual.state = detail.dispute.state;
        step('decision', `${actual.outcome ?? 'none'} by ${actual.rule ?? 'no rule'}; proposed action ${actual.action ?? 'none'}`);
      }
    } catch (error) {
      failures.push(`the scenario stopped with an error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await this.c.store.setMerchantMode(previousMode);
    }
    return this.finish(scenario, failures, steps, actual, latencyMs, started);
  }

  /** The merchant is paid more than the consented cart: a second PayPal order stands in for the captured one. */
  private async overcharge(order: OrderRecord, extraCents: number): Promise<OrderRecord> {
    const simulator = this.simulator();
    const total = order.totalCents + extraCents;
    const created = await this.c.paypal.client.createOrder(
      {
        referenceId: `${order.id}-extra`,
        customId: order.cartJti === null ? `ord:${order.id}` : `wrt:${order.cartJti}`,
        invoiceId: `${order.invoiceId ?? order.id}-X`,
        description: 'Agent purchase (sandbox demo)',
        currency: order.currency,
        lines: order.lines.map((l, i) => ({ sku: l.sku, name: l.title, quantity: l.qty, unitCents: i === 0 ? l.unitPriceCents + Math.round(extraCents / l.qty) : l.unitPriceCents })),
        totalCents: total,
        brandName: this.c.config.merchantName,
        returnUrl: 'http://localhost/return',
        cancelUrl: 'http://localhost/cancel',
      },
      `${order.id}:extra:create`,
    );
    simulator.approveOrder(created.id, DEFAULT_SIM_PAYER);
    const captured = await this.c.paypal.client.captureOrder(created.id, `${order.id}:extra:capture`);
    const capture = captured.captures[0];
    if (capture === undefined) throw new Error('the replacement capture did not complete');
    await this.c.db.query('UPDATE orders SET paypal_order_id = $2, capture_id = $3 WHERE id = $1', [order.id, created.id, capture.id]);
    const updated = await this.c.merchant.order(order.id);
    if (updated === null) throw new Error('the order disappeared');
    return updated;
  }

  private simulator() {
    const simulator = this.c.paypal.simulator;
    if (simulator === null) throw new Error('this step needs the PayPal simulator');
    return simulator;
  }

  /** A second analysis with a note writer that either invents facts or sticks to the record. Returns the note source. */
  private async reanalyseWithNotes(disputeId: string, kind: 'hallucinating' | 'grounded'): Promise<string> {
    const grounded = kind === 'grounded';
    const writer = new LlmNoteWriter({
      complete: () =>
        Promise.resolve(
          JSON.stringify({
            memo: grounded ? 'The signed record supports the sale. This is advisory.' : 'Tracking 1Z999AA10123456785 shows the parcel was signed for on 2019-03-04 and a refund of $500.00 was already paid.',
            evidence_note: grounded ? 'The buyer\'s wallet signed the cart that was paid for.' : 'Payment SIMCAP9999999999 for $1,234.56 was delivered to the buyer.',
            buyer_message: 'Thank you for contacting us about your order.',
          }),
        ),
    });
    const service = new DisputeService({
      db: this.c.db,
      clock: this.c.clock,
      ids: this.c.ids,
      config: this.c.config,
      registry: this.c.registry,
      wallet: this.c.wallet,
      store: this.c.store,
      merchant: this.c.merchant,
      paypal: this.c.paypal,
      claims: new RulesClaimExtractor(),
      notes: writer,
    });
    const { action } = await service.analyze(disputeId);
    return action.noteSource;
  }

  private finish(scenario: Scenario, failures: string[], steps: StepRecord[], actual: ScenarioResult['actual'], latencyMs: number | null, started: number): ScenarioResult {
    const expect = scenario.expect;
    const check = (what: string, got: unknown, want: unknown) => {
      if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    };
    if (failures.every((f) => !f.startsWith('the scenario stopped') && !f.startsWith('this scenario needs'))) {
      check('verifier outcome', actual.verifier, expect.verifier);
      if (expect.rejectedRules !== undefined) check('rules that rejected', [...actual.rejectedRules].sort(), [...expect.rejectedRules].sort());
      check('order taken by the merchant', actual.sold, expect.sold);
      if (expect.payment !== undefined) check('payment', actual.payment, expect.payment);
      const d = expect.dispute;
      if (d !== undefined) {
        check('claim', actual.claim, d.claim);
        check('outcome', actual.outcome, d.outcome);
        check('rule', actual.rule, d.rule);
        check('proposed action', actual.action, d.action);
        if (d.confidence !== undefined) check('confidence', actual.confidence, d.confidence);
        if (d.noteSource !== undefined) check('note source', actual.noteSource, d.noteSource);
        for (const flag of d.flags ?? []) if (!actual.flags.includes(flag)) failures.push(`flag ${flag} missing; got ${JSON.stringify(actual.flags)}`);
        for (const [who, label] of Object.entries(d.attribution ?? {}) as Array<[keyof Attribution, string]>) {
          if (actual.attribution?.[who] !== label) failures.push(`${who} attribution: expected ${label}, got ${String(actual.attribution?.[who])}`);
        }
      }
    }
    return {
      id: scenario.id,
      family: scenario.family,
      title: scenario.title,
      passed: failures.length === 0,
      failures,
      steps,
      actual,
      latencyMs,
      durationMs: Math.round(performance.now() - started),
    };
  }
}
