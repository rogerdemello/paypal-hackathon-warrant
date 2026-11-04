# @warrant/paypal

A typed client for the PayPal REST endpoints Warrant uses ([docs/paypal-integration.md](../../docs/paypal-integration.md)), and an in-process simulator that speaks the same API.

## The client

`PayPalClient` covers OAuth, Orders v2 (create with `custom_id` and `invoice_id`, get, capture, tracking), Payments v2 (capture, refund), Disputes v1 (list, get, provide-evidence, accept-claim, make-offer, and the sandbox-only create, adjudicate and require-evidence helpers) and webhook signature verification.

- Sandbox base URL only; the live URL is refused.
- A deterministic `PayPal-Request-Id` on every POST that matters. Network errors, 5xx and 429 are retried with backoff; other 4xx are not.
- PayPal's `debug_id` is kept on every error for the audit ledger.
- Decimal strings are converted to integer cents here and nowhere else.
- Webhooks are verified with PayPal's verify API against the raw body.

## The simulator

`PayPalSimulator` is a stand-in for the sandbox so the whole product, the tests and CI run with no credentials: pass `simulator.fetch` as the client's `fetch`. It implements the documented paths, bodies and error shapes, a signed webhook feed and a verify-webhook-signature endpoint, plus the failures Warrant needs (not approved, already captured, duplicate invoice, declined instrument, refund over the captured amount, actions not allowed in a dispute state). It also has driver methods for what a buyer does outside the API (`approveOrder`, `openDispute`, `buyerAcceptsOffer`).

**It is not PayPal.** Anything that depends on PayPal's real behaviour has to be checked against the real sandbox. Its `snapshot()` and `restore()` let a server that keeps its database keep the simulator's memory too (`setChangeListener` says when to save).

## Tests

- `pnpm --filter @warrant/paypal test`: 48 tests against the simulator, with coverage thresholds.
- `pnpm test:int` (from the root): `test/integration/sandbox.int.ts` against the **real sandbox**. It needs `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` (and `PAYPAL_WEBHOOK_ID` for the webhook test) and skips itself without them. It creates unpaid one-dollar orders and reads disputes; approving an order needs a browser, so capture and the dispute actions are not covered there. **It has not been run against the real sandbox yet.**

Items marked **[spike]** in the integration doc must be confirmed against the live sandbox and the doc updated with what was observed.
