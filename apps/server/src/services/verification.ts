import { checkSignatures, decodeBundle, keyStateAt, parseBundle, type Facts } from '@warrant/warrant';
import type { FactDto, SignerDto, VerificationReportDto } from '../api-types';
import { nowSeconds, type Clock } from '../clock';
import type { Db } from '../db';
import type { DisputeService } from './disputes';
import type { MerchantService } from './merchant';
import { verifyInclusionProof, type RegistryService } from './registry';

/**
 * The public verification report behind `/v/:cartJti`: what was authorised, who signed it, whether the keys were good, what
 * the order is, and whether the registry's log vouches for the time. It re-derives everything from the stored bundle and
 * the registry rather than trusting a stored verdict, using the same facts engine the dispute agent uses.
 */
export class VerificationService {
  constructor(
    private readonly o: { readonly db: Db; readonly clock: Clock; readonly registry: RegistryService; readonly merchant: MerchantService; readonly disputes: DisputeService },
  ) {}

  async report(cartJti: string): Promise<VerificationReportDto> {
    const now = nowSeconds(this.o.clock);
    const transparencyBase = { included: false, seq: null, entryHash: null, loggedAt: null, proofValid: null, proofReason: null, checkpointSeq: null };
    const missing: VerificationReportDto = { found: false, cartJti, mandate: null, cart: null, signers: [], facts: [], checkoutFindings: [], order: null, transparency: transparencyBase, dispute: null, generatedAt: now };

    const bundleInput = await this.o.merchant.bundleOf(cartJti);
    if (bundleInput === null) return missing;
    const parsed = parseBundle(bundleInput);
    if (!parsed.ok) return missing;
    const bundle = parsed.value;
    const decoded = decodeBundle(bundle);
    const registry = await this.o.registry.lookup();

    const checks = await checkSignatures(bundle, decoded, registry);
    const signers: SignerDto[] = checks.map((c) => {
      const key = c.kid === null ? null : registry(c.kid);
      return { subject: c.subject, kid: c.kid, ok: c.ok, detail: c.detail, keyStatus: key === null ? null : keyStateAt(key, now), owner: key?.owner ?? null };
    });

    const order = await this.o.merchant.orderByCartJti(cartJti);
    let facts: Facts | null = null;
    if (order !== null) facts = await this.o.disputes.factsForOrder(order);
    const factDtos: FactDto[] =
      facts === null ? [] : [facts.F1, facts.F2, facts.F3, facts.F4, facts.F5, facts.F6, facts.F7, facts.F8, facts.F9, facts.F10, facts.F11].map((f) => ({ id: f.id, name: f.name, value: f.value, evidence: f.evidence }));

    const view = await this.o.registry.transparencyView(cartJti);
    let proofValid: boolean | null = null;
    let proofReason: string | null = null;
    let checkpointSeq: number | null = null;
    if (view.included) {
      const proof = await this.o.registry.inclusionProof(cartJti);
      if (proof !== null) {
        const verdict = await verifyInclusionProof(proof, this.o.registry.logPublicKey().publicKey);
        proofValid = verdict.ok;
        proofReason = verdict.ok ? null : verdict.reason;
        checkpointSeq = proof.checkpoint.seq;
      }
    }

    const disputeRow = order === null ? null : (await this.o.disputes.disputes({ limit: 500 })).find((d) => d.orderId === order.id) ?? null;
    const disputeAnalysis = disputeRow === null ? null : await this.o.disputes.latestAnalysis(disputeRow.id);

    const m = decoded.mandate.ok ? decoded.mandate.payload : null;
    const c = decoded.cart.ok ? decoded.cart.payload : null;
    return {
      found: true,
      cartJti,
      mandate:
        m === null || !decoded.mandate.ok
          ? null
          : {
              jti: m.jti,
              hash: decoded.mandate.hash,
              instruction: m.instruction.text,
              issuer: m.iss,
              validFrom: m.nbf,
              validUntil: m.exp,
              scope: {
                currency: m.scope.currency,
                maxTotal: m.scope.max_total,
                maxPerItem: m.scope.max_per_item,
                maxItems: m.scope.max_items,
                categoriesAllow: m.scope.categories_allow,
                mode: m.scope.mode,
                budgetMode: m.scope.budget_mode,
              },
              payerLinked: m.principal.paypal_payer_id_hash !== undefined,
            },
      cart:
        c === null
          ? null
          : {
              issuer: c.iss,
              audience: c.aud,
              issuedAt: c.iat,
              expiresAt: c.exp,
              cartHash: c.cart_hash,
              total: c.cart.total,
              currency: c.cart.currency,
              items: c.cart.items,
              consent: { mode: c.consent.mode, approvedAt: c.consent.approved_at ?? null, method: c.consent.method ?? null, presentedHash: c.consent.presented_hash ?? null },
            },
      signers,
      facts: factDtos,
      checkoutFindings: order?.verification.findings.map((f) => ({ rule: f.rule, outcome: f.outcome, detail: f.detail })) ?? [],
      order:
        order === null
          ? null
          : { id: order.id, status: order.status, totalCents: order.totalCents, currency: order.currency, paypalOrderId: order.paypalOrderId, captureId: order.captureId, createdAt: order.createdAt },
      transparency: { included: view.included, seq: view.seq, entryHash: view.entryHash, loggedAt: view.loggedAt, proofValid, proofReason, checkpointSeq },
      dispute: disputeRow === null ? null : { id: disputeRow.id, state: disputeRow.state, outcome: disputeAnalysis?.decision.outcome ?? null, rule: disputeAnalysis?.decision.rule ?? null },
      generatedAt: now,
    };
  }
}
