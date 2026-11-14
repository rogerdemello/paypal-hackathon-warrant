# Demo video script and Devpost text

Target: under 3 minutes (about 400 spoken words). Record on the hosted demo, https://warrant-paypal.onrender.com, or locally with `pnpm dev`. Everything below is true of the repository as it stands; the numbers come from `pnpm eval`.

## Before recording (5 minutes)

1. Open the hosted URL once and wait for it to load: the free instance sleeps, and the first load takes about a minute.
2. Use a private window, so the wallet is new. Press **Link the sandbox buyer now** before you start recording (so the proof shows as fully verified); you will mention it in one sentence.
3. Have three tabs ready: the shop (`/`), the Dispute Lab (`/lab`), the console (`/console`).
4. Browser zoom at 110%, notifications off, window about 1280 wide.
5. Do one dry run. If a step stalls, reload; the state is in the database.

## Script

| Time | On screen | Say |
|---|---|---|
| 0:00 | Title card or the shop page | "When an AI agent buys the wrong thing, who pays? Today nobody knows, and merchants end up eating the dispute. Warrant puts signed proof of what the human authorised on every PayPal order, and uses it in the dispute." |
| 0:20 | Shop. Click *A standing desk converter under $120* | "I ask my shopping agent for a standing desk converter under a hundred and twenty dollars. It can search, but it can't spend. First it needs my permission." |
| 0:32 | Permission request. Click **Sign this mandate** | "My wallet signs a mandate: my words, the budget, one item, twenty-four hours. The merchant will check every cart against it." |
| 0:45 | Consent screen with the cart | "The agent picks a cart. My wallet shows me exactly what it will submit, and nothing is bought until I approve. Approving signs the cart's fingerprint. The agent cannot forge that signature." Click **Approve and sign** |
| 1:00 | "What the merchant checked" expanded, then the PayPal page | "At checkout the merchant runs twelve checks: signatures, key status, freshness, replay, the cart hash, the price, the mandate limits, and that the PayPal account paying is mine. All passed, so the order goes to PayPal with the warrant's ids in it." Click **Approve payment** |
| 1:20 | Public proof page | "Anyone can check this. No login, and it doesn't trust the shop: everything is recomputed from the signed objects. Verified: the human authorised exactly this purchase." |
| 1:35 | Lab > *Raise a dispute on an order*. Choose the order, reason Unauthorised, **Raise the dispute** | "Now I play the buyer, and say I never ordered this." |
| 1:45 | Console > the dispute. Scroll the facts, the decision, the proposed action | "The dispute agent rebuilds what happened from code, not from a language model: thirteen facts, each with its evidence. A rules table decides: contest it. The model only writes the explanation, and every number and date in it must appear in the record. The merchant stays in charge: it proposes, I approve." Click **Approve and send evidence** |
| 2:05 | Lab > the *Cart swap* scenario, **Run** | "The harder case: the agent signed a cart the human never approved. Warrant doesn't fight this one. It accepts the claim and attributes it to the agent platform, instead of losing the dispute." |
| 2:30 | Terminal with the `pnpm eval` summary, or the numbers on a slide | "We run eighty-seven labelled scenarios through this pipeline. Every honest warrant is accepted; every forged, replayed or swapped one is refused by a strict merchant. Remove the warrant facts, and twenty of thirty-nine dispute decisions change, and eleven of twelve contestable cases are lost. That is what the proof adds. The corpus is ours, so it shows the design works, not real win rates." |
| 2:50 | Title card with the URL | "Warrant: proof of what the human authorised, checked at checkout, used in the dispute. It runs on a PayPal sandbox simulator; the repository and a live demo are linked below." |

If you run long, cut the 2:05 cart-swap beat to one sentence over the Lab result and keep the numbers.

## Devpost text

**Tagline.** Signed proof of what a human authorised an AI agent to buy, verified at PayPal checkout and used to resolve disputes.

### Inspiration

AI agents are starting to shop for people, and nobody has answered a simple question: when an agent buys something the human says they never wanted, who pays? Proof formats for agent authorisation exist. The missing last step is using that proof at the PayPal checkout and in the PayPal dispute.

### What it does

- **A signed Warrant.** The wallet signs a *mandate* (what the agent may do). After the human approves a specific cart, the wallet signs the consent and the agent platform signs the cart warrant. The agent cannot forge the consent.
- **A merchant verifier.** Twelve deterministic rules return accept, review or reject, and the warrant ids go into the PayPal order's `custom_id` and `invoice_id`.
- **A dispute agent.** A facts engine rebuilds what happened. A language model only reads the buyer's text (choosing from a fixed list of claims) and writes explanations that are checked against the facts. A rules table picks the outcome: fight with evidence, accept and attribute to the agent platform, no proof, or refund a merchant fault. Money-moving actions are proposals the merchant approves.
- **A registry** of agent keys and a hash-chained transparency log, **a public verification page** for every warrant, and **a Merchant Console** (AG Studio) with the dispute queue, orders and the audit ledgers.
- **A Dispute Lab** with 87 labelled scenarios, and an MCP server with two read-only tools.

### How we built it

TypeScript monorepo: a pure library for the warrant, verifier, facts and outcome table (574 tests); a Fastify server with embedded or Postgres storage; a React app; a typed PayPal client (Orders v2 with `custom_id` and `invoice_id`, Payments, Disputes v1, signed-webhook verification) plus the PayPal Agent Toolkit for the dispute agent's reads; Claude for the shopping agent, claim reading and notes (with a deterministic fallback); Channel3 for products; AG Studio in the console; Render for hosting. About 1,000 automated tests plus 11 browser tests, and a CI workflow.

### Challenges

The hard part was keeping the language model out of anything that decides: facts come from code, the outcome from a table, and generated text is rejected unless every identifier, amount and date appears in the case record. Running the whole system end to end also found real defects that unit tests missed, such as a restarted server reissuing PayPal order ids, a Postgres connection forced onto TLS inside Docker, and an outcome-table row that could not be reached for a swapped cart. Each is fixed and recorded in `docs/implementation-notes.md`.

### Accomplishments

- A complete flow: request, mandate, consent, checkout, verified proof, dispute, evidence, console.
- 87 of 87 labelled scenarios behave as labelled; 41 of 41 honest warrants accepted; 37 of 37 adversarial ones refused by a strict merchant; with the warrant facts removed, 20 of 39 dispute decisions change.
- It runs with no accounts or keys (`pnpm install && pnpm dev`), in a container, and on Render.

### What we learned

Proof only helps if it is checked at the moment of purchase and again at the dispute, and if the dispute decision stays deterministic and auditable. Attributing a swapped cart to the agent platform, instead of fighting it, is as important as winning the cases that can be won.

### What's next

Run everything against the real PayPal sandbox and live model and catalog keys (the client and tests exist; they have not been run there), pre-built AG Studio dashboards and a Studio agent, passkey-signed consent, Log in with PayPal for payer binding, and adapters for AP2 and Verifiable Intent.

### Honest limits

Sandbox only. The hosted demo and every number above use a built-in PayPal simulator, which is not PayPal. The scenario corpus is written by us, so it shows the pipeline behaves as designed, not that it wins real disputes. Payer binding is trust-on-first-use. The liability memo is advisory.

### Built with

TypeScript, Node, Fastify, React, Vite, PostgreSQL and PGlite, PayPal REST APIs and Agent Toolkit, Claude (Anthropic), Channel3, AG Studio (AG Grid), Playwright, Vitest, Docker, Render.

### Links

- Live demo: https://warrant-paypal.onrender.com
- Code: https://github.com/rogerdemello/paypal-hackathon-warrant
- Video: `<YOUTUBE_URL>`
