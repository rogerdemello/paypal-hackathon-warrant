# Setup guide

Two ways to run Warrant: the hosted demo (nothing to install) or locally. Either way you use the **PayPal sandbox**. No real money is involved.

## Contents
0. [Quick start: no accounts, no keys](#quick-start-no-accounts-no-keys)
1. [Judge test accounts](#judge-test-accounts)
2. [Accounts and keys you need to build](#accounts-and-keys)
3. [PayPal sandbox setup](#paypal-sandbox-setup)
4. [Local run](#local-run)
5. [Webhooks in development](#webhooks-in-development)
6. [Deploying to Render](#deploying-to-render)
7. [Troubleshooting](#troubleshooting)

---

## Quick start: no accounts, no keys

```bash
pnpm install
pnpm dev
```

Open http://localhost:5173. With no `.env` at all the server starts in a complete demo: **fixtures mode** (a built-in catalog and a rule-following shopping agent, no model calls), the **built-in PayPal simulator** (an approval page at `/sim/paypal/approve` stands in for PayPal), an embedded database and development signing keys. Everything in the README works: shop, sign, pay, verify, dispute, console, Lab. Nothing leaves your machine.

- The database and development keys live in your user data folder (`%LOCALAPPDATA%\warrant` on Windows, `~/.local/share/warrant` on Linux, `~/Library/Application Support/warrant` on macOS), **not** in the repository. A repository inside OneDrive or Dropbox cannot host the embedded database (its lock file cannot be created there), which is why. Set `DATA_DIR` to move it. Delete the folder to start from nothing.
- Port 5173 is the web app (Vite), 8787 the API. `pnpm build && pnpm start` serves both from 8787.
- The simulator is not PayPal. It implements the documented paths and the failures Warrant needs. Use the real sandbox (below) to check anything that depends on PayPal's actual behaviour.
- Other ways to run it: `pnpm e2e` (a browser test of the whole flow), `docker build -t warrant . && docker run --rm -p 8787:8787 -e NODE_ENV=development -e WEB_ORIGIN=http://localhost:8787 warrant`, or `docker compose --profile app up` (the app plus Postgres).

---

## Judge test accounts

> Fill this section in once the sandbox accounts exist. These are **sandbox-only** credentials, which the hackathon rules allow you to publish for testing. Never publish live credentials.

| Role | Email | Password | Notes |
|---|---|---|---|
| Sandbox buyer (Personal) | `<BUYER_SANDBOX_EMAIL>` | `<BUYER_SANDBOX_PASSWORD>` | Approve orders with this account at the PayPal sandbox page |
| Sandbox merchant (Business) | `<MERCHANT_SANDBOX_EMAIL>` | `<MERCHANT_SANDBOX_PASSWORD>` | Optional: see orders arrive with `custom_id` and `invoice_id` set |

**Judge Mode** on the hosted demo creates an anonymous session, so no sign-up is needed. It is rate-limited to protect the model budget. If you hit the limit, run locally in fixtures mode.

---

## Accounts and keys

| Service | Needed for | Where | Cost |
|---|---|---|---|
| PayPal Developer account | Sandbox APIs, webhooks, disputes | developer.paypal.com | Free |
| Anthropic API key | Shopping agent, dispute agent, Studio agent | console.anthropic.com | Pay per use. Not needed in fixtures mode |
| Channel3 API key | Product search and repricing | trychannel3.com/developers | 20,000 free credits with code `PAYPAL-HACKATHON-2026`. Not needed in fixtures mode |
| AG Studio licence (optional) | Removing the watermark on the hosted build | ag-grid.com (trial licence) | 45-day trial. Local development needs no key |
| Render account | Hosting | render.com | $50 credits via the hackathon page |
| GitHub account | Public repo | github.com | Free |

---

## PayPal sandbox setup

1. Sign in at **developer.paypal.com** with an existing PayPal account, or create one.
2. **Apps & Credentials** > **Sandbox** tab > **Create App** (type: Merchant). Copy the **Client ID** and **Secret** into `.env`. Keep the secret server-side only.
3. **Testing Tools** > **Sandbox Accounts**. You get a default Business and a default Personal account. Create a custom **Personal** buyer with a USD balance (and a linked test card if you want card-based dispute cases) and note the generated email and password. Note the Business account's **merchant id** and put it in `PAYPAL_MERCHANT_ID`.
4. Open your app > **Add Webhook**. Enter your public URL ending in `/api/merchant/webhooks/paypal` (see below) and subscribe to: `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.REFUNDED`, `CUSTOMER.DISPUTE.CREATED`, `CUSTOMER.DISPUTE.UPDATED`, `CUSTOMER.DISPUTE.RESOLVED`. Copy the **Webhook ID** into `PAYPAL_WEBHOOK_ID`.
5. In the app's feature options, enable what you need (accept payments, and disputes if offered).
6. Run `pnpm paypal:doctor`. It gets a token, creates one unpaid one-dollar test order (PayPal lets it expire), reads it back, lists disputes, asks PayPal to check a forged webhook delivery against your webhook id, and says in plain words what to change if anything failed. `pnpm test:int` runs a longer set of checks against the sandbox. Neither has been run against the real sandbox by the authors; the simulator versions of both are tested.

Optional while building: install the **PayPal AI Toolkit** plugin in Claude Code (`/plugin install paypal@claude-plugins-official`, then `/reload-plugins`) and the **APIMatic Context Plugin for PayPal** from the hackathon's APIMatic page.

### Creating a test dispute

Follow the two options in [paypal-integration.md](paypal-integration.md#4-disputes-in-the-sandbox). In short: either open an Item Not Received or Significantly Not As Described case from the sandbox buyer account's Resolution Center, or use the sandbox create-dispute API (ask on the PayPal Discord to have it enabled). Wait a few minutes after creation before sandbox actions become available, then use the sandbox-only `require-evidence` and `adjudicate` endpoints to move the case.

### Day-1 spike checklist

See [paypal-integration.md](paypal-integration.md#8-spike-checklist-days-1-to-3). Record what you observed in that file.

---

## Local run

The [quick start](#quick-start-no-accounts-no-keys) needs nothing. To use the real PayPal sandbox, real models, or Postgres:

Requirements: Node 22+, pnpm 9+, Docker only if you want Postgres.

```bash
git clone <REPO_URL> warrant
cd warrant
cp .env.example .env        # then fill in what you have; leave the rest blank
pnpm install
pnpm keygen                 # prints WALLET_SIGNING_KEY, AGENT_PLATFORM_SIGNING_KEY, REGISTRY_LOG_KEY
docker compose up -d db     # optional: Postgres on localhost:5432 (set DATABASE_URL, see .env.example)
pnpm paypal:doctor          # after adding the sandbox credentials
pnpm dev
```

- Web: http://localhost:5173
- API: http://localhost:8787
- The server migrates its database on start; `pnpm db:migrate` does it without starting the server.
- Each part is independent. Without `PAYPAL_CLIENT_ID` the PayPal simulator is used; `WARRANT_MODE=fixtures` (the default) needs no Anthropic or Channel3 key; without `DATABASE_URL` the embedded database is used. `PAYPAL_ENV=sandbox` needs `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID` and `PAYPAL_MERCHANT_ID`; `WARRANT_MODE=live` needs both `ANTHROPIC_API_KEY` and `CHANNEL3_API_KEY`. The server lists every missing value at once when it refuses to start.
- Tests: `pnpm test` (everything, no network), `pnpm eval` (the scenario corpus), `pnpm e2e` (browser; first run `pnpm --filter @warrant/e2e exec playwright install chromium`, or set `E2E_CHANNEL=chrome` or `msedge` to use a browser you already have), `pnpm test:int` (real sandbox, needs credentials).

### Environment variables

See [.env.example](../.env.example). The important ones:

| Variable | Meaning |
|---|---|
| `WARRANT_MODE` | `live` uses Anthropic and Channel3. `fixtures` (default) uses a built-in catalog and rule-based agent |
| `PAYPAL_ENV` | `simulator` (default without credentials) or `sandbox`. Production is refused: Warrant is sandbox only |
| `PUBLIC_BASE_URL`, `WEB_ORIGIN` | Where the server and the web app are reached. In production the web app is served by the server, so `WEB_ORIGIN` defaults to `PUBLIC_BASE_URL`, which defaults to Render's `RENDER_EXTERNAL_URL` |
| `DATABASE_URL` | Postgres. Unset: an embedded database in `DATA_DIR`. TLS is used for any host that is not this machine or a private name; add `?sslmode=disable` or `?sslmode=verify-full` to decide |
| `CONSOLE_TOKEN`, `JUDGE_MODE_ENABLED` | With judge mode on (default) the console and Lab are open to anyone who reaches the server. Turn it off and set a token for anything public you do not want driven by strangers |
| `PAYPAL_MERCHANT_ID` | Sandbox Business merchant id; it appears in each warrant's audience |
| `WALLET_SIGNING_KEY`, `AGENT_PLATFORM_SIGNING_KEY`, `REGISTRY_LOG_KEY` | Base64 Ed25519 private keys |
| `DISPUTE_AUTOPILOT` | If `true`, the dispute agent executes approved-type actions without a click (sandbox demo only) |
| `LLM_DAILY_BUDGET_USD` | Global cap for the hosted demo |

---

## Webhooks in development

PayPal needs a public HTTPS URL to deliver events. Use a tunnel:

```bash
cloudflared tunnel --url http://localhost:8787
# or: ngrok http 8787
```

Register `https://<tunnel-host>/api/merchant/webhooks/paypal` in the dashboard, set `PAYPAL_WEBHOOK_ID`, and set `PUBLIC_BASE_URL` to the tunnel URL so PayPal's `return_url` points back at you. Tunnel URLs change on restart, so update the webhook then.

If webhooks do not arrive, nothing polls PayPal in the background. An order is finished when the buyer returns to the shop, and the console's **Refresh from PayPal** button on a dispute re-reads it.

---

## Deploying to Render

1. Push the repo to GitHub.
2. In Render, create a **Blueprint** from the repo (`render.yaml`). It builds the Dockerfile as a web service and provisions Postgres. Check the plans in the file against Render's current ones first.
3. Render asks for the values marked `sync: false`: the three signing keys (from `pnpm keygen`), `PAYPAL_ENV` (`sandbox`, or `simulator` for a demo with the built-in stand-in), the PayPal values, and `WARRANT_MODE` (`live` with both API keys, or `fixtures`). `PUBLIC_BASE_URL` is taken from Render itself; `CONSOLE_TOKEN` is generated.
4. Update the PayPal webhook URL to the Render URL and set the real `PAYPAL_WEBHOOK_ID`.
5. Open the deployed URL, run the shopper flow and one dispute scenario, and keep the service running through **Dec 15, 2026** (end of judging).

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| 401 from PayPal | Wrong sandbox or live keys, or an expired token | Check `PAYPAL_ENV=sandbox` and the app's sandbox keys |
| Approval link fails | Order expired | Create a new checkout |
| Verifier rejects with `AUDIENCE` | `PAYPAL_MERCHANT_ID` differs from the warrant's `aud` | Use the same merchant id in the wallet and the merchant |
| `SIGNATURE` or `KEY_STATUS` rejects | Registry has a different key set than the signer | Re-run `pnpm keygen`, re-seed the registry |
| Dispute actions unavailable | Dispute is not in the right state yet | Wait a few minutes; check `allowed_response_options`; use sandbox `require-evidence` |
| No dispute webhook | Wrong webhook URL or ID, or event not subscribed | Re-check the dashboard; the app also polls |
| Webhook verification fails | Wrong `PAYPAL_WEBHOOK_ID`, or body parsed before verification | Use the ID for this URL and verify against the raw body |
| Everything declines | Business account has Negative Testing on | Turn it off in the sandbox Business account settings |
| AG Studio watermark | No licence key on a production build | Add a trial key via `AgStudioLicenseManager.setLicenseKey` |
| `ag-studio` and `ag-studio-react` errors | Version mismatch | Pin both packages to the identical version |
