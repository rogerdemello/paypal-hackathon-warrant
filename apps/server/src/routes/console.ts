import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { readChain, toLedgerEntry, verifyStoredChain } from '../chain';
import { nowSeconds } from '../clock';
import type { Container } from '../container';
import { HttpError, parse } from '../http';
import type { AttemptRowDto, DisputeRowDto, OrderRowDto, OverviewDto } from '../api-types';
import type { DisputeRecord } from '../services/disputes';
import type { OrderRecord } from '../services/merchant';

/** The merchant console: orders, rejected checkouts, catalog, settings, keys, ledgers and the dispute desk. */

/** Console and Lab requests are open in judge mode; otherwise they must carry the console token. */
export function consoleGuard(c: Container) {
  return (request: FastifyRequest, _reply: unknown, done: (error?: Error) => void): void => {
    if (c.config.judgeModeEnabled) return done();
    const header = request.headers['x-console-token'];
    const given = Buffer.from(Array.isArray(header) ? (header[0] ?? '') : (header ?? ''));
    const expected = Buffer.from(c.config.consoleToken ?? '');
    if (expected.length === 0 || given.length !== expected.length || !timingSafeEqual(given, expected)) return done(new HttpError(401, 'the console needs its access token (x-console-token)', 'CONSOLE_AUTH'));
    return done();
  };
}

const ACTOR = 'console';

export function registerConsoleRoutes(root: FastifyInstance, c: Container): void {
  root.register((app, _options, done) => {
    app.addHook('onRequest', consoleGuard(c));

    /** Mandates (and so orders) made by Dispute Lab scenarios, whose visitor ids start with "lab-". */
    const labMandates = async (): Promise<Set<string>> =>
      new Set((await c.db.query<{ jti: string }>("SELECT m.jti FROM mandates m JOIN principals p ON p.id = m.principal_id WHERE p.visitor_id LIKE 'lab-%'")).map((r) => r.jti));
    const includeLab = (request: { query: unknown }): boolean => (request.query as { lab?: string }).lab === '1';

    const orderRow = async (o: OrderRecord, lab: Set<string>): Promise<OrderRowDto> => {
      const tracking = await c.merchant.tracking(o.id);
      const refunds = await c.merchant.refunds(o.id);
      return {
        id: o.id,
        status: o.status,
        createdAt: o.createdAt,
        totalCents: o.totalCents,
        currency: o.currency,
        itemCount: o.itemCount,
        items: o.lines.map((l) => `${l.qty} x ${l.title}`).join('; '),
        cartJti: o.cartJti,
        mandateJti: o.mandateJti,
        verifierMode: o.verifierMode,
        verification: o.verificationOutcome,
        rejectedRules: o.verification.findings.filter((f) => f.outcome !== 'pass').map((f) => f.rule),
        paypalOrderId: o.paypalOrderId,
        captureId: o.captureId,
        invoiceId: o.invoiceId,
        trackingStatus: tracking?.status ?? null,
        trackingNumber: tracking?.trackingNumber ?? null,
        refundedCents: refunds.reduce((sum, r) => sum + r.amountCents, 0),
        note: o.note,
        lab: o.mandateJti !== null && lab.has(o.mandateJti),
      };
    };

    const disputeRow = async (d: DisputeRecord, labOrders: Set<string>): Promise<DisputeRowDto> => {
      const analysis = await c.disputes.latestAnalysis(d.id);
      const actions = await c.disputes.actions(d.id);
      const current = [...actions].reverse().find((a) => a.status !== 'superseded') ?? null;
      const now = nowSeconds(c.clock);
      return {
        id: d.id,
        orderId: d.orderId,
        captureId: d.captureId,
        reason: d.reason,
        status: d.status,
        stage: d.stage,
        state: d.state,
        amountCents: d.amountCents,
        currency: d.currency,
        claim: d.claimType,
        claimConflict: d.claimConflict,
        responseDueBy: d.responseDueBy,
        hoursLeft: d.responseDueBy === null ? null : Math.round(((d.responseDueBy - now) / 3600) * 10) / 10,
        outcome: analysis?.decision.outcome ?? null,
        rule: analysis?.decision.rule ?? null,
        confidence: analysis?.decision.confidence ?? null,
        action: current?.actionType ?? null,
        actionStatus: current?.status ?? null,
        actionId: current?.id ?? null,
        approvedBy: current?.approvedBy ?? null,
        createdAt: d.createdAt,
        lab: d.orderId !== null && labOrders.has(d.orderId),
      };
    };

    /** Order ids made by Lab scenarios. */
    const labOrderIds = async (): Promise<Set<string>> => {
      const lab = await labMandates();
      return new Set((await c.merchant.orders({ limit: 5000 })).filter((o) => o.mandateJti !== null && lab.has(o.mandateJti)).map((o) => o.id));
    };

    // ---- overview ---------------------------------------------------------------------------------------------------

    app.get('/api/console/overview', async (request): Promise<OverviewDto> => {
      const withLab = includeLab(request);
      const lab = await labMandates();
      const labOrders = await labOrderIds();
      const orders = (await c.merchant.orders({ limit: 1000 })).filter((o) => withLab || !labOrders.has(o.id));
      const byStatus: Record<string, number> = {};
      for (const o of orders) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
      const attempts = (await c.merchant.attempts(1000)).filter((a) => withLab || a.mandateJti === null || !lab.has(a.mandateJti));
      const disputes = (await c.disputes.disputes({ limit: 1000 })).filter((d) => withLab || d.orderId === null || !labOrders.has(d.orderId));
      const byState: Record<string, number> = {};
      for (const d of disputes) byState[d.state] = (byState[d.state] ?? 0) + 1;
      const head = await c.registry.head();
      return {
        mode: c.config.mode,
        paypalEnv: c.paypal.env,
        merchantMode: await c.store.merchantMode(),
        autopilot: await c.disputes.autopilot(),
        orders: { total: orders.length, byStatus, capturedCents: orders.filter((o) => o.status === 'captured').reduce((sum, o) => sum + o.totalCents, 0) },
        attempts: { total: attempts.length, accepted: attempts.filter((a) => a.outcome === 'ACCEPT').length, review: attempts.filter((a) => a.outcome === 'REVIEW').length, rejected: attempts.filter((a) => a.outcome === 'REJECT').length },
        disputes: { total: disputes.length, byState, needAttention: disputes.filter((d) => d.state === 'awaiting_approval' || d.state === 'escalated').length },
        keys: (await c.registry.jwks()).keys.map((k) => ({ kid: String(k['kid']), kind: String(k['kind']), owner: String(k['owner']), status: String(k['status']) })),
        transparency: { length: head?.seq ?? 0, headHash: head?.hash ?? null },
      };
    });

    // ---- orders -----------------------------------------------------------------------------------------------------

    app.get('/api/console/orders', async (request) => {
      const q = parse(z.object({ status: z.enum(['pending_review', 'created', 'approved', 'captured', 'rejected', 'failed', 'cancelled']).optional(), limit: z.coerce.number().int().min(1).max(500).optional() }), request.query);
      const orders = await c.merchant.orders({ ...(q.status === undefined ? {} : { status: q.status }), limit: q.limit ?? 200 });
      const lab = await labMandates();
      const rows = await Promise.all(orders.map((o) => orderRow(o, lab)));
      return { orders: includeLab(request) ? rows : rows.filter((r) => !r.lab) };
    });

    app.get<{ Params: { id: string } }>('/api/console/orders/:id', async (request) => {
      const order = await c.merchant.order(request.params.id);
      if (order === null) throw new HttpError(404, 'unknown order', 'NOT_FOUND');
      const chainId = `order:${order.id}`;
      return {
        order,
        row: await orderRow(order, await labMandates()),
        tracking: await c.merchant.tracking(order.id),
        refunds: await c.merchant.refunds(order.id),
        ledger: { chainId, entries: await readChain(c.db, 'ledger_entries', chainId), verification: await verifyStoredChain(c.db, 'ledger_entries', chainId) },
      };
    });

    app.post<{ Params: { id: string } }>('/api/console/orders/:id/review', async (request) => {
      const { decision } = parse(z.object({ decision: z.enum(['approve', 'reject']) }), request.body);
      return { order: await c.merchant.decideReview(request.params.id, decision, ACTOR) };
    });

    app.post<{ Params: { id: string } }>('/api/console/orders/:id/ship', async (request) => {
      const input = parse(z.object({ carrier: z.string().min(1).max(60), trackingNumber: z.string().min(1).max(60), promisedBy: z.number().int().positive().optional() }), request.body);
      return c.merchant.ship(request.params.id, { carrier: input.carrier, trackingNumber: input.trackingNumber, ...(input.promisedBy === undefined ? {} : { promisedBy: input.promisedBy }) });
    });

    app.post<{ Params: { id: string } }>('/api/console/orders/:id/deliver', async (request) => ({ tracking: await c.merchant.deliver(request.params.id) }));

    app.post<{ Params: { id: string } }>('/api/console/orders/:id/refund', async (request) => {
      const input = parse(z.object({ amountCents: z.number().int().positive().optional(), note: z.string().max(200).optional() }), request.body);
      return { refund: await c.merchant.refund(request.params.id, { ...(input.amountCents === undefined ? {} : { amountCents: input.amountCents }), ...(input.note === undefined ? {} : { note: input.note }) }) };
    });

    app.get('/api/console/attempts', async (request) => {
      const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(500).optional() }), request.query);
      const lab = await labMandates();
      const withLab = includeLab(request);
      const attempts = (await c.merchant.attempts(q.limit ?? 100)).filter((a) => withLab || a.mandateJti === null || !lab.has(a.mandateJti));
      return {
        attempts: attempts.map((a): AttemptRowDto => ({
          id: a.id,
          createdAt: a.createdAt,
          cartJti: a.cartJti,
          outcome: a.outcome,
          orderId: a.orderId,
          failedRules: [...new Set(a.findings.filter((f) => f.outcome !== 'pass').map((f) => f.rule))],
          reasons: a.findings.filter((f) => f.outcome !== 'pass').map((f) => f.detail),
          findings: a.findings,
          lab: a.mandateJti !== null && lab.has(a.mandateJti),
        })),
      };
    });

    // ---- catalog and settings ---------------------------------------------------------------------------------------

    app.get('/api/console/products', async () => ({ products: await c.store.all() }));

    app.patch<{ Params: { sku: string } }>('/api/console/products/:sku', async (request) => {
      const input = parse(z.object({ priceCents: z.number().int().positive().max(100_000_000).optional(), available: z.boolean().optional(), title: z.string().min(1).max(200).optional(), description: z.string().max(2000).optional() }), request.body);
      const sku = request.params.sku;
      if (input.priceCents !== undefined) await c.store.setPrice(sku, input.priceCents);
      if (input.available !== undefined) await c.store.setAvailability(sku, input.available);
      if (input.title !== undefined || input.description !== undefined) await c.store.setListingText(sku, { ...(input.title === undefined ? {} : { title: input.title }), ...(input.description === undefined ? {} : { description: input.description }) });
      const product = await c.store.get(sku);
      if (product === null) throw new HttpError(404, 'unknown product', 'NOT_FOUND');
      return { product };
    });

    app.get('/api/console/settings', async () => ({ merchantMode: await c.store.merchantMode(), disputeAutopilot: await c.disputes.autopilot() }));

    app.put('/api/console/settings', async (request) => {
      const input = parse(z.object({ merchantMode: z.enum(['STRICT', 'PERMISSIVE', 'NONE']).optional(), disputeAutopilot: z.boolean().optional() }), request.body);
      if (input.merchantMode !== undefined) await c.store.setMerchantMode(input.merchantMode);
      if (input.disputeAutopilot !== undefined) await c.disputes.setAutopilot(input.disputeAutopilot);
      return { merchantMode: await c.store.merchantMode(), disputeAutopilot: await c.disputes.autopilot() };
    });

    // ---- disputes ---------------------------------------------------------------------------------------------------

    app.get('/api/console/disputes', async (request) => {
      const q = parse(z.object({ state: z.enum(['received', 'awaiting_approval', 'responded', 'closed', 'escalated']).optional() }), request.query);
      const disputes = await c.disputes.disputes(q.state === undefined ? {} : { state: q.state });
      const labOrders = await labOrderIds();
      const rows = await Promise.all(disputes.map((d) => disputeRow(d, labOrders)));
      return { disputes: includeLab(request) ? rows : rows.filter((r) => !r.lab) };
    });

    app.get<{ Params: { id: string } }>('/api/console/disputes/:id', async (request) => {
      const detail = await c.disputes.detail(request.params.id);
      const orderLedger = detail.order === null ? null : await readChain(c.db, 'ledger_entries', `order:${detail.order.id}`);
      const chainId = `dispute:${request.params.id}`;
      return {
        ...detail,
        row: await disputeRow(detail.dispute, await labOrderIds()),
        ledger: { chainId, entries: await readChain(c.db, 'ledger_entries', chainId), verification: await verifyStoredChain(c.db, 'ledger_entries', chainId) },
        orderLedger: orderLedger === null ? null : orderLedger.map(toLedgerEntry),
        verifyUrl: (detail.order?.cartJti ?? null) === null ? null : `${c.config.publicBaseUrl}/v/${detail.order?.cartJti ?? ''}`,
      };
    });

    app.post<{ Params: { id: string } }>('/api/console/disputes/:id/refresh', async (request) => ({ detail: await c.disputes.ingest(request.params.id) }));

    app.post<{ Params: { id: string } }>('/api/console/disputes/:id/analyze', async (request) => {
      await c.disputes.detail(request.params.id);
      const { analysis, action } = await c.disputes.analyze(request.params.id);
      return { analysis, action };
    });

    app.post<{ Params: { id: string } }>('/api/console/actions/:id/approve', async (request) => ({ action: await c.disputes.approve(request.params.id, ACTOR) }));
    app.post<{ Params: { id: string } }>('/api/console/actions/:id/reject', async (request) => ({ action: await c.disputes.reject(request.params.id, ACTOR) }));

    app.get<{ Params: { id: string } }>('/api/console/disputes/:id/packet', async (request, reply) => {
      const file = await c.disputes.packetFile(request.params.id);
      if (file === null) throw new HttpError(404, 'no evidence packet for this dispute', 'NOT_FOUND');
      return reply.header('content-type', file.contentType).header('content-disposition', `attachment; filename="${file.fileName}"`).header('x-content-sha256', file.sha256).send(Buffer.from(file.bytes));
    });

    // ---- ledgers and keys -------------------------------------------------------------------------------------------

    app.get<{ Params: { chainId: string } }>('/api/console/ledger/:chainId', async (request) => {
      const chainId = request.params.chainId;
      if (!/^(order|dispute):[A-Za-z0-9_.:-]{1,100}$/.test(chainId)) throw new HttpError(400, 'chain ids look like order:<id> or dispute:<id>', 'INVALID_REQUEST');
      return { chainId, entries: await readChain(c.db, 'ledger_entries', chainId), verification: await verifyStoredChain(c.db, 'ledger_entries', chainId) };
    });

    app.get('/api/console/keys', async () => (await c.registry.jwks()));

    app.post<{ Params: { kid: string } }>('/api/console/keys/:kid/status', async (request) => {
      const { status } = parse(z.object({ status: z.enum(['active', 'suspended', 'revoked']) }), request.body);
      try {
        await c.registry.setKeyStatus(request.params.kid, status);
      } catch (error) {
        if (error instanceof Error && /unknown key/.test(error.message)) throw new HttpError(404, error.message, 'NOT_FOUND');
        throw error;
      }
      return c.registry.jwks();
    });

    app.post('/api/console/registry/checkpoint', async () => ({ checkpoint: await c.registry.checkpoint(), audit: await c.registry.audit() }));

    done();
  });
}
