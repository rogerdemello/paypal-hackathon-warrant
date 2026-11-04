# PayPal integration

All calls target the **sandbox** (`https://api-m.sandbox.paypal.com`). Items marked **[spike]** must be confirmed against the live sandbox in the first days of the build, and this file updated with what you observed.

## 1. APIs used

| API | Endpoint | Purpose in Warrant |
|---|---|---|
| OAuth 2.0 | `POST /v1/oauth2/token` | Server-side access token |
| Orders v2 | `POST /v2/checkout/orders` (`intent: CAPTURE`) | Create the order with warrant references |
| Orders v2 | `GET /v2/checkout/orders/{id}` | Read approval state and payer id |
| Orders v2 | `POST /v2/checkout/orders/{id}/capture` | Capture after the buyer approves |
| Orders v2 | `POST /v2/checkout/orders/{id}/track` | Add shipment tracking (delivery evidence) |
| Payments v2 | `POST /v2/payments/captures/{id}/refund` | Refund when the outcome says so |
| Disputes v1 | `GET /v1/customer/disputes`, `GET /v1/customer/disputes/{id}` | List and read disputes |
| Disputes v1 | `POST /v1/customer/disputes/{id}/provide-evidence` | Submit the evidence packet (multipart) |
| Disputes v1 | `POST /v1/customer/disputes/{id}/accept-claim` | Accept liability (refund) |
| Disputes v1 | `POST /v1/customer/disputes/{id}/make-offer` | Offer a resolution |
| Disputes v1 (sandbox only) | `POST /v1/customer/disputes` (create), `/change-reason`, `/require-evidence`, `/adjudicate` | Drive test disputes through stages |
| Webhooks | `POST /v1/notifications/verify-webhook-signature` | Verify every inbound event |
| Agent Toolkit (`get_dispute`, `get_order` only) | The dispute agent's reads, in `apps/server/src/services/paypal-toolkit.ts` | Reads a dispute for analysis and for the pre-action check; reads the PayPal order and capture context |

## 2. Warrant references on the order

```http
POST /v2/checkout/orders
PayPal-Request-Id: ord-<cartJti>-create
Content-Type: application/json

{
  "intent": "CAPTURE",
  "purchase_units": [{
    "reference_id": "<orderId>",
    "custom_id": "wrt:<cartJti>",
    "invoice_id": "WRT-<first 16 chars of cart_hash>",
    "description": "Agent purchase (sandbox demo)",
    "amount": { "currency_code": "USD", "value": "89.00" }
  }],
  "payment_source": {
    "paypal": {
      "experience_context": {
        "brand_name": "Demo Store (sandbox)",
        "shipping_preference": "NO_SHIPPING",
        "user_action": "PAY_NOW",
        "return_url": "https://<host>/merchant/paypal/return",
        "cancel_url": "https://<host>/merchant/paypal/cancel"
      }
    }
  }
}
```

Redirect the buyer to the link with `rel` of `payer-action` (older responses use `approve`). Check the documented length limits for `custom_id` and `invoice_id` against the schema **[spike]**. After approval, `GET` the order and read the payer id for V11 **[spike: confirm the field and that its hash is stable across orders]**.

## 3. Tracking and capture mapping

After capture, store `purchase_units[0].payments.captures[0].id` with the warrant. A dispute lists `disputed_transactions[].seller_transaction_id`; that value is looked up in the `orders` table to find the warrant, order and tracking **[spike: confirm the id that appears there matches the capture id]**.

When the demo "ships" an item, call the tracking endpoint with a carrier and tracking number so delivery evidence exists in PayPal as well as locally.

## 4. Disputes in the sandbox

PayPal documents two ways to create a test dispute:

| Option | How | Notes |
|---|---|---|
| A. Buyer-initiated | Log in to the sandbox buyer account, open the transaction, open the Resolution Center, and create an Item Not Received or Significantly Not As Described case | Manual, but needs no special access. Card payments may be required for chargeback-type cases |
| B. Create dispute API | `POST /v1/customer/disputes` with `disputed_transactions` (buyer transaction id), `reason`, `dispute_amount`, `extensions`, plus a `PayPal-Auth-Assertion` header | Sandbox only. Parts of this API are described as limited release, so ask on the PayPal Discord to have it enabled **[spike]** |

After a dispute exists, wait a few minutes before sandbox actions become available. Sandbox-only helpers:

- `POST /v1/customer/disputes/{id}/require-evidence` with `action` of `BUYER_EVIDENCE` or `SELLER_EVIDENCE` (dispute must be `UNDER_REVIEW`).
- `POST /v1/customer/disputes/{id}/adjudicate` with `adjudication_outcome` of `BUYER_FAVOR` or `SELLER_FAVOR`.
- `POST /v1/customer/disputes/{id}/change-reason`.

Always read the dispute details first and use the HATEOAS links and `allowed_response_options` it returns; do not assume an action is available.

### What the dispute agent sends

**Provide evidence** is `multipart/form-data`: a JSON part named `input` plus document parts.

```json
{
  "evidences": [
    {
      "evidence_type": "PROOF_OF_FULFILLMENT",
      "evidence_info": { "tracking_info": [{ "carrier_name": "FEDEX", "tracking_number": "122533485" }] },
      "notes": "<at most 2000 characters, built from the facts JSON>"
    },
    { "evidence_type": "OTHER", "notes": "Agent authorisation proof: <public verification URL>" }
  ]
}
```

Documents: JPG, JPEG, GIF, PNG or PDF; under 10 MB each and 50 MB per request. Evidence types seen in PayPal's examples are `PROOF_OF_FULFILLMENT`, `PROOF_OF_REFUND` and `OTHER`; confirm the full list in the schema **[spike]**.

**Accept claim** takes optional `note`, `accept_claim_reason`, `invoice_id` and, for partial refunds, an `accept_claim_type` such as `REFUND` or `PARTIAL_REFUND` (confirm the full enum in the schema).

**Make offer** takes `note`, `offer_amount` and `offer_type`. `REFUND_WITH_REPLACEMENT` appears in PayPal's example; use `allowed_response_options` to see what applies.

## 5. Webhooks

Subscribe in the app to:

| Event | Handling |
|---|---|
| `CHECKOUT.ORDER.APPROVED` | Continue to payer binding and capture |
| `PAYMENT.CAPTURE.COMPLETED` / `DENIED` / `PENDING` | Update the order; ledger |
| `PAYMENT.CAPTURE.REFUNDED` | Record the refund (fact F11) |
| `CUSTOMER.DISPUTE.CREATED` | Start the dispute pipeline |
| `CUSTOMER.DISPUTE.UPDATED` | Evidence, messages, reason changes |
| `CUSTOMER.DISPUTE.RESOLVED` | Close the case, update statistics |

Verify with `/v1/notifications/verify-webhook-signature`, forwarding `auth_algo`, `cert_url`, `transmission_id`, `transmission_sig`, `transmission_time`, your `webhook_id` and the raw event body. Accept only `SUCCESS`. Keep the raw bytes before parsing. Deduplicate on event id. Treat webhooks as hints and the `GET` endpoints as truth.

## 6. Idempotency and errors

- Deterministic `PayPal-Request-Id` on every `POST`.
- Retry only on network errors and 5xx, with backoff and jitter. Never retry other 4xx except 429.
- Keep PayPal's `debug_id` in the ledger.
- Sandbox failures: `PayPal-Mock-Response: {"mock_application_codes":"INSTRUMENT_DECLINED"}`. Remember the Business account's Negative Testing setting can fail everything if left on.

## 7. How PayPal's AI tooling is used

| Tool | Where |
|---|---|
| **PayPal Agent Toolkit** (`@paypal/agent-toolkit/ai-sdk`, v1.11.0) | `get_dispute` and `get_order`, the only actions enabled. The Toolkit answers with a JSON string and reports PayPal errors as `{ ok: false, ... }` rather than throwing; the adapter parses and maps both. It caches its access token without refreshing, so a failed read rebuilds the toolkit and falls back to `packages/paypal`. Its `accept_dispute_claim` posts only `{ note }`, so accept-claim, `provide-evidence` and `make-offer` stay on `packages/paypal`. In simulator mode the Toolkit's own axios is pointed at the simulator, so the same Toolkit code runs |
| **PayPal AI Toolkit** (Claude Code plugin) | Best-practice guidance while building `packages/paypal` |
| **APIMatic Context Plugin for PayPal** | API context for the coding agent when generating request and response types |
| **PayPal MCP server** | Optional: lets a merchant's own assistant list disputes alongside Warrant's tools |

Record concrete examples of each during the build so the Devpost "Tools" section is specific and true.

## 8. Spike checklist (days 1 to 3)

- [ ] Create an order with `custom_id` and `invoice_id`; approve it as the sandbox buyer; capture it; read the payer id.
- [ ] Add tracking to the order.
- [ ] Create a dispute via Option A, and ask on Discord about Option B.
- [ ] Confirm `CUSTOMER.DISPUTE.CREATED` reaches the tunnel and verifies.
- [ ] `GET` the dispute: note `disputed_transactions`, `reason`, `status`, `dispute_life_cycle_stage`, deadline fields and `allowed_response_options`.
- [ ] Submit `provide-evidence` with a PDF; try `accept-claim` and `make-offer`; use `adjudicate`.
- [ ] Run `get_dispute` and `get_order` through the Agent Toolkit against the real sandbox (`pnpm test:int` covers the typed client only); check `gateway.tools.stats()` shows no fallbacks.
- [ ] Write what you saw into this file.
