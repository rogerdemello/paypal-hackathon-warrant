# @warrant/server

The Fastify API behind everything: the wallet, the registry, the demo merchant with its verifier, the PayPal webhook handling, the dispute agent, the console and the Dispute Lab. One process plays all the roles with separate keys, tables and route prefixes, so the trust boundaries stay visible ([docs/architecture.md](../../docs/architecture.md)). It also serves the built web app.

```bash
pnpm dev          # from the repository root: this server on :8787 and the web app on :5173
pnpm --filter @warrant/server start    # the server alone
pnpm db:migrate                         # apply migrations without starting
pnpm paypal:doctor                      # check the PayPal credentials
```

With no environment at all it starts a complete demo: fixtures mode, the built-in PayPal simulator, an embedded database and development keys. See [docs/setup.md](../../docs/setup.md) and [`.env.example`](../../.env.example); every configuration problem is reported at once at startup.

## What is in it

| Area | Where | Notes |
|---|---|---|
| Configuration | `src/config.ts` | Validated once. Production refuses to start without real signing keys, a database and a public address |
| Database | `src/db`, `src/db/migrations.ts` | PGlite (embedded) or Postgres behind one interface; six migrations; hash-chained ledgers (`src/chain.ts`) |
| Wallet | `services/wallet.ts` | Mandates, proposals, the consent screen's data, signing, payer link, spend; one consent per cart `jti` |
| Registry | `services/registry.ts` | Keys and status history, transparency log, signed checkpoints, inclusion proofs, audit |
| Shopping agent | `services/agent.ts`, `intent.ts`, `agent-platform.ts` | A conversation with stages; rules-based in fixtures mode, a model with `ANTHROPIC_API_KEY`. The agent platform signs the cart warrant; it cannot sign the consent |
| Merchant | `services/merchant.ts`, `store.ts` | Checkout in `STRICT`, `PERMISSIVE` or `NONE` mode, PayPal orders carrying `custom_id` and `invoice_id`, capture, tracking, refunds, one transaction per checkout under a per-mandate lock |
| PayPal | `services/paypal.ts`, `simulator-state.ts`, `paypal-toolkit.ts` | The real sandbox client or the simulator (same interface); the simulator's memory is saved with the database. Dispute reads go through the PayPal Agent Toolkit, with the typed client as fallback |
| Webhooks | `services/webhooks.ts` | Verified against the raw body, deduplicated on event id |
| Dispute agent | `services/disputes.ts`, `claims.ts`, `notes.ts`, `pdf.ts` | Facts F1-F13 from `@warrant/warrant`, claim reading, the outcome table, plan vetting against PayPal's allowed options, notes with a grounding check, an evidence packet, one proposed action, approval or autopilot |
| Verification page data | `services/verification.ts` | Recomputes everything from the stored signed objects |
| Lab | `lab/` | 87 labelled scenarios, a forger for tampered warrants, and the runner used by the Lab page and by `pnpm eval` |
| Routes | `routes/public.ts`, `shopper.ts`, `console.ts`, `lab.ts` | Public and merchant routes; the visitor's wallet and agent (`x-visitor-id`); the console and Lab (open in judge mode, otherwise `x-console-token`) |

## Rules for this package

Sandbox PayPal only. Money is integer cents. No secret appears in a response. A language model never decides a verification result, a fact or a dispute outcome, and its text is accepted only if every identifier, amount and date in it is in the case record ([CONTRIBUTING.md](../../CONTRIBUTING.md)).

## Tests

`pnpm --filter @warrant/server test` runs about 300 tests against an embedded database with a fixed clock and sequential ids, plus the Postgres driver against a Postgres wire-protocol server, and checks coverage thresholds (about 95% of lines). Notable files: `merchant.test.ts` (modes, concurrency), `disputes.test.ts`, `api.test.ts` (every route), `lab.test.ts` (all 87 scenarios), `restart.test.ts` (a server that keeps its data), `postgres.test.ts`.

## What is not verified

The real PayPal sandbox, the live Anthropic and Channel3 paths, and Render have not been exercised from here; see [docs/implementation-notes.md](../../docs/implementation-notes.md#64-not-built-or-built-less-than-the-plan-said).
