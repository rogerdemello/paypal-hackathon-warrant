import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type WarrantApi, WarrantApiError } from './api';

/**
 * The tools a shopping agent, an analyst's assistant or a coding agent can use to look at Warrant's records. They are
 * read-only on purpose:
 *
 *   - they take an identifier and nothing else, so a caller cannot supply a price, a payee, a URL or a document to be trusted;
 *   - they answer from the server's own recomputation of the signed objects and the case record, not from anything the
 *     caller says;
 *   - neither can pay, refund, accept, contest or change anything.
 *
 * Responses carry the facts and the decision; the language in them is fixed text, not generated.
 */

const ID = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/, 'letters, digits and _ . : - only');

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> });
const failure = (message: string) => ({ isError: true as const, content: [{ type: 'text' as const, text: message }] });

/** Fixed, human-readable names for the facts (the same ones the public Verify page shows). */
const FACT_NAMES: Readonly<Record<string, string>> = {
  F1: 'A warrant was presented for this order',
  F2: 'Every signature on it verifies',
  F3: 'The signing keys were in good standing when they signed',
  F4: 'The consent is valid and covers the cart',
  F5: 'The order matches what was approved',
  F6: 'The cart was within the mandate',
  F7: 'Paid by the PayPal account bound to the wallet',
  F8: 'The warrant was logged before the dispute',
  F9: 'Delivered on time',
  F10: 'The listing matched when signed',
  F11: 'Refunded',
};

export function createWarrantMcpServer(api: WarrantApi, info: { name?: string; version?: string } = {}): McpServer {
  const server = new McpServer({ name: info.name ?? 'warrant', version: info.version ?? '0.0.0' });

  server.registerTool(
    'verify_warrant',
    {
      title: 'Verify a warrant',
      description:
        'Re-checks the signed record of what a human authorised an AI agent to buy, for one cart warrant, and reports what is established: whether every signature verifies, whether the keys were in good standing, ' +
        'whether the order matches the approved cart, and whether the warrant was logged in the public transparency log. Takes the cart warrant id (the `cart_jti`, shown on a Warrant verification page and ' +
        'as `wrt:<cart_jti>` in the PayPal order). Read-only.',
      inputSchema: { cart_jti: ID.describe('The id of the cart warrant, for example the part after "wrt:" in a PayPal order custom_id.') },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ cart_jti }) => {
      try {
        const report = await api.verification(cart_jti);
        if (!report.found) {
          return text({ cart_jti, verdict: 'not_found', summary: 'The server holds no signed warrant with that id.' });
        }
        const signaturesOk = report.signers.length > 0 && report.signers.every((s) => s.ok);
        const notEstablished = report.facts.filter((f) => f.id !== 'F9' && f.id !== 'F11' && f.value !== true).map((f) => f.id);
        const verdict = !signaturesOk ? 'not_verified' : report.order === null || notEstablished.length > 0 ? 'signed_with_open_questions' : 'verified';
        const summary =
          verdict === 'verified'
            ? 'Every signature verifies, the keys were in good standing, and the order matches what the human approved.'
            : verdict === 'not_verified'
              ? 'At least one signature does not verify: the record cannot be relied on.'
              : report.order === null
                ? 'The signatures verify, but no order was placed from this cart, so there is nothing yet to compare.'
                : `The signatures verify, but these are not established: ${notEstablished.map((id) => `${id} (${FACT_NAMES[id] ?? id})`).join('; ')}.`;
        return text({
          cart_jti: report.cartJti,
          verdict,
          summary,
          mandate: report.mandate === null ? null : { instruction: report.mandate.instruction, max_total: report.mandate.scope.maxTotal, currency: report.mandate.scope.currency, max_items: report.mandate.scope.maxItems, valid_until: report.mandate.validUntil, payer_linked: report.mandate.payerLinked },
          cart: report.cart === null ? null : { total: report.cart.total, currency: report.cart.currency, items: report.cart.items.map((i) => ({ title: i.title, qty: i.qty, unit_price: i.unit_price })), consent_method: report.cart.consent.method, approved_at: report.cart.consent.approvedAt },
          signatures: report.signers.map((s) => ({ subject: s.subject, ok: s.ok, key_status: s.keyStatus, detail: s.detail })),
          facts: report.facts.map((f) => ({ id: f.id, name: FACT_NAMES[f.id] ?? f.name, established: f.value === true, evidence: f.evidence })),
          checkout_findings: report.checkoutFindings,
          order: report.order,
          transparency_log: report.transparency,
          dispute: report.dispute,
        });
      } catch (error) {
        return failure(error instanceof WarrantApiError ? error.message : `verify_warrant failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  server.registerTool(
    'get_dispute_facts',
    {
      title: 'Get a dispute\'s facts and decision',
      description:
        'Returns what Warrant established about one PayPal dispute: the facts F1-F13 computed from the signed record and the order history (each with its evidence), the claim the buyer is making, ' +
        'the outcome the deterministic rules table chose and why, who is responsible, and the action proposed to the merchant. Takes the dispute id. Read-only: it does not answer, accept or contest anything.',
      inputSchema: { dispute_id: ID.describe('The PayPal dispute id, for example PP-D-1234.') },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ dispute_id }) => {
      try {
        const detail = await api.dispute(dispute_id);
        if (detail === null) return failure(`No dispute with id ${dispute_id}.`);
        const proposed = [...detail.actions].reverse().find((a) => a.status !== 'superseded') ?? null;
        return text({
          dispute_id: detail.dispute.id,
          paypal_reason: detail.dispute.reason,
          state: detail.dispute.state,
          amount_cents: detail.dispute.amountCents,
          currency: detail.dispute.currency,
          response_due_by: detail.dispute.responseDueBy,
          buyer_message: detail.dispute.buyerMessage,
          claim: detail.dispute.claimType,
          claim_conflict: detail.dispute.claimConflict,
          order: detail.order,
          decision:
            detail.analysis === null
              ? null
              : {
                  outcome: detail.analysis.decision.outcome,
                  rule: detail.analysis.decision.rule,
                  confidence: detail.analysis.decision.confidence,
                  attribution: detail.analysis.decision.attribution,
                  flags: detail.analysis.decision.flags,
                  caveat: detail.analysis.decision.caveat,
                  facts_used: detail.analysis.decision.factsUsed,
                },
          facts: detail.analysis === null ? [] : Object.values(detail.analysis.facts).flatMap((f) => (f === undefined ? [] : [{ id: f.id, name: f.name, value: f.value, evidence: f.evidence }])),
          proposed_action: proposed === null ? null : { type: proposed.actionType, status: proposed.status, params: proposed.params, note_source: proposed.noteSource },
          public_proof: detail.verifyUrl,
        });
      } catch (error) {
        return failure(error instanceof WarrantApiError ? error.message : `get_dispute_facts failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  return server;
}
