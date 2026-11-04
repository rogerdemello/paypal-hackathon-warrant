# Verification rules (merchant checkout)

The verifier is a pure function: `verify(bundle, context) -> Result`. It performs no network calls itself; the caller supplies registry data, the merchant's own catalog prices, the nonce store, the cart `jti` store, the wallet's consent records (looked up by cart `jti`), for cumulative mandates the spend already recorded under the mandate, and the current time. This keeps it deterministic and testable.

```ts
type Outcome = 'ACCEPT' | 'REVIEW' | 'REJECT';
type Finding = { rule: string; outcome: 'pass' | 'review' | 'reject'; detail: string };
type Result  = { outcome: Outcome; findings: Finding[]; cartHash: string; mandateHash: string };
```

**Precedence:** any `reject` produces `REJECT`; otherwise any `review` produces `REVIEW`; otherwise `ACCEPT`. All rules always run, so the console can show every reason.

## Rules

| ID | Check | On failure |
|---|---|---|
| V01 `SIGNATURE` | Cart JWS verifies against the agent key named by its `kid`. Mandate JWS verifies against the wallet key. Consent signature verifies and covers `cart_hash`, `cart_jti`, `aud`, `presented_hash`, `approved_at` and `mandate.hash`, where `cart_jti` and `aud` equal the cart's `jti` and `aud` | reject |
| V02 `KEY_STATUS` | Both keys are known to the registry and `active` now. They were not revoked at `iat`. Each key is of the right kind and owned by the claimed issuer (agent keys by the platform, wallet keys by the mandate `iss`). Keys are checked now and when the signed object was issued | reject |
| V03 `FRESHNESS` | Now is within `[nbf, exp]` of the mandate and `[iat, exp]` of the cart. Cart lifetime at most 15 minutes. Skew at most 60 seconds. The cart's `iat` falls inside the mandate's `[nbf, exp]` (with skew), and the mandate's `iat` is not after its `nbf` | reject |
| V04 `AUDIENCE` | `aud` names this merchant | reject |
| V05 `NONCE` | `nonce` **and** the cart `jti` have not been seen by this merchant. The verifier does not record them; the caller records both atomically after accepting | reject (replay) |
| V06 `MANDATE_BINDING` | `cart.mandate.hash` equals the hash of the presented mandate payload, and the mandate's `agent` matches the cart's `iss`. `cart.mandate.jti` matches; the cart's header `kid` equals the mandate's `agent.kid`; `instruction.hash` equals the hash of `instruction.text` | reject |
| V07 `CART_HASH` | `cart_hash` equals the hash of the canonical cart. Line totals sum to `cart.total` | reject |
| V08 `REPRICE` | The merchant recomputes every line from its own catalog (price, availability, currency). Any difference | reject |
| V09 `SCOPE` | Per-item cap (unit price), categories and merchant rules hold for this cart. Total and item count (sum of quantities) hold for this cart and, when `scope.budget_mode` is `cumulative`, for the spend already recorded under the mandate plus this cart. If the spend is unknown the result is review | reject; review when the spend is unknown |
| V10 `CONSENT` | `human_present`: consent present and its `presented_hash` matches what the wallet recorded for this cart's `jti`. `human_not_present`: the mandate's `scope.mode` allows it | reject |
| V11 `PAYER_BINDING` | Evaluated after the buyer approves the PayPal order: hash of `payer.payer_id` equals `principal.paypal_payer_id_hash` when present. When absent, record the hash (first use) | reject on mismatch, review on first use |
| V12 `VELOCITY` | Warrants per principal and per agent platform within the window stay under the limit. Under the limit means the prior count in the window is below it | review |

## Merchant modes

For demonstrating dispute outcomes the demo merchant can run three modes:

| Mode | Behaviour |
|---|---|
| `STRICT` | Enforces the result. `REJECT` stops checkout, `REVIEW` holds for manual approval |
| `PERMISSIVE` | Records the result but proceeds. Models a merchant that accepts agent orders without enforcing |
| `NONE` | No warrant support; orders carry no warrant references |

`PERMISSIVE` and `NONE` exist so the dispute agent can be shown handling the real-world case where a bad order slipped through.

## After the PayPal approval and capture

- Save the bundle, the verification result, the PayPal order id and the capture id.
- Add shipment tracking when the item ships (`POST /v2/checkout/orders/{id}/track`).
- Append the cart warrant hash to the registry transparency log if the wallet has not already done so.
- Record the nonce, the cart `jti` and, for cumulative mandates, the spend, in one transaction that locks the mandate.

## Tests required for each rule

Each rule needs a passing and a failing unit test, plus a scenario in the `sim/` corpus that exercises it end to end. Adversarial cases to include: wrong key, revoked key, expired mandate, replayed nonce, warrant for another merchant, edited cart after consent, edited mandate scope, item repriced by the merchant, payer mismatch, consent signature copied from another cart, consent reused for an identical cart, consent presented to another merchant, replayed cart `jti` with a fresh nonce, budget stretch across several carts.
