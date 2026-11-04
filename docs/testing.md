# Testing and verification

Every claim in the README, the video and the Devpost text must map to a test or a reproducible command. If it does not, remove the claim.

## 1. Test layers

| Layer | Tooling | Scope | Gate |
|---|---|---|---|
| Unit | Vitest | `packages/warrant`: each verifier rule V01-V12 (pass and fail), each fact F1-F13, the outcome table, signing and hashing | Every commit; target at least 90% line coverage on `warrant` |
| Property | fast-check | Any single-byte change to a JWS or ledger entry is detected; `decideOutcome` is total and deterministic; hashes are stable under key reordering | Part of `pnpm test` |
| Service and API | Vitest, embedded Postgres (PGlite) and a Postgres wire-protocol server | `apps/server`: wallet, registry, merchant modes, concurrency, the dispute pipeline, every HTTP route, restarts with a saved database, the Postgres driver | `pnpm test`; coverage thresholds in `apps/server/vitest.config.ts` |
| Component | Vitest, React Testing Library, jsdom | `apps/web`: every page and the consent, verify and console views against a faked API | `pnpm test` |
| MCP | Vitest, the MCP SDK over an in-memory transport | The two tools against the real server routes, including refusal of anything that is not an identifier | `pnpm test` |
| Integration | Vitest + PayPal sandbox | Order create, approve, capture, track, refund; dispute fetch, evidence, accept, offer; webhook verification with a good and a forged signature | `pnpm test:int` (needs credentials); before every deploy |
| Evaluation | `sim/` runner | The labelled scenario corpus through the real pipeline | `pnpm eval`; writes `sim/report.json`; exits 1 if a scenario fails; CI gate |
| End to end | Playwright | Shopper consent, checkout on the simulator's page, the public verification page, a dispute from the Lab to the console, Lab scenarios, every console section, AG Studio loading | `pnpm e2e` against fixtures mode and the simulator in CI; can target any running server with `E2E_BASE_URL` |
| Manual | Checklist below | Real PayPal approval, real sandbox dispute, AG Studio rendering, mobile layout | Before recording and before submission |

## 2. Scenario corpus (`sim/`)

Each scenario is a short script that creates a mandate, a cart and a warrant (possibly tampered), runs checkout in a chosen merchant mode, optionally generates a dispute with a stated claim, and records the expected verifier result and expected dispute outcome.

| Family | Examples | Min cases |
|---|---|---|
| Honest purchase, later "I never ordered" (remorse) | Valid consent, bound payer, delivered | 8 |
| Cart swap | Consent for A, order for B | 8 |
| Scope stretch | Total, per item, count, category, merchant | 8 |
| Forgery | Wrong key, edited payload, unknown key | 8 |
| Replay and audience | Reused nonce, other merchant's warrant | 6 |
| Key and time | Revoked key, expired mandate or cart, clock skew | 6 |
| Payer mismatch | Different PayPal account paid | 4 |
| Merchant fault | Not delivered, listing mismatch, wrong amount | 10 |
| Injection and hallucination | Instructions in the buyer's message; invented facts in drafts | 8 |
| Permissive or no-support merchant | Verification skipped, dispute follows | 6 |
| Consent reuse | Identical cart under a fresh jti, consent presented to another merchant, replayed jti | 6 |
| Budget stretch | Several carts that each fit but together exceed `max_total` or `max_items`; unknown spend | 6 |

Target at least 60 scenarios. **87 are run**: remorse 8, cart swap 8, scope stretch 9, forgery 8, replay and audience 6, key and time 7, payer mismatch 4, merchant fault 11, injection and hallucination 8, permissive or no-support 6, consent reuse 6, budget stretch 6. The scenarios live in `apps/server/src/lab/scenarios.ts` so the Dispute Lab runs the same ones; `sim/` scores them.

## 3. Metrics (generated, never hand-written)

- Verifier: adversarial warrants rejected, honest warrants accepted, per rule.
- Dispute pipeline: outcome accuracy against the labels, per claim type; fraction routed to a human.
- Evidence checks: share of generated drafts that pass the "every fact appears in the facts JSON" check on the first try.
- **Ablation:** run the same disputes with the warrant facts removed (LLM sees only the dispute text and PayPal data). Report what it decides. The point is to show what the proof adds, whatever the numbers turn out to be.
- Latency: time from webhook to proposed action.

State the limitation next to the numbers: the corpus is authored by us, so this shows the pipeline behaves as designed, not that it wins real disputes.

## 4. Claim verification matrix

Fill the "Evidence" column before submission.

"Simulator" below means the in-process PayPal stand-in, which is not PayPal. A claim is only marked verified against the real sandbox when that has been done.

| Claim | How it is verified | Evidence |
|---|---|---|
| A cart-swap order is rejected at checkout | Sim `swap-*` and library tests on V01/V07 | `pnpm eval`: the strict-merchant swap scenarios are refused (37 of 37 adversarial warrants refused) |
| A forged or replayed warrant is rejected | Sim `forge-*`, `replay-*` | `pnpm eval`, per-rule table in `sim/report.json` |
| The warrant references appear in the PayPal order | Server test and `pnpm paypal:doctor` against the simulator; `pnpm test:int` against the sandbox | Simulator: verified. **Real sandbox: not yet run** |
| Payer binding mismatch is caught | Sim `payer-*` | `pnpm eval` |
| The dispute agent reads a real sandbox dispute | `pnpm test:int` lists disputes; reading is tested against the simulator | Simulator: verified. **Real sandbox: not yet run** |
| Evidence is submitted through the Disputes API | Server tests and e2e against the simulator (evidence, packet hash, state) | Simulator: verified. **Real sandbox: not yet run** |
| An agent-fault case is accepted and attributed | Sim `swap-*` (permissive merchant) | `pnpm eval`: 5 of 5 agent-platform-fault attributions; ablation loses all 5 |
| Generated notes contain no invented facts | Grounding-check tests, sim `inject-06` and `inject-07` | `pnpm test`, `pnpm eval`. Real-model drafts: **not yet run** |
| Ledger and transparency log detect tampering | Property tests, server tests, the console's audit button | `pnpm test`; e2e signs a checkpoint and audits the log |
| The public verification page matches the stored bundle | E2E | `e2e/tests/shopper.spec.ts` |
| Runs with no external API keys | The default configuration; CI runs everything in it | `pnpm dev` with no `.env`; the container job |

## 5. Manual checklist

- [ ] Fresh clone, follow the README, reach a working app in under 10 minutes.
- [ ] Hosted demo: Shopper flow works in a private window and on a phone.
- [ ] A real sandbox dispute is read, answered and shown resolved at least once on the hosted build.
- [ ] The public verification page opens from an evidence note.
- [ ] Sandbox merchant account shows orders with `custom_id` and `invoice_id` set.
- [ ] No secrets in the repository history (run a secret scanner).
- [ ] No AG Studio watermark or console errors on the hosted build.
- [ ] README feature table matches reality.

## 6. CI

GitHub Actions (`.github/workflows/ci.yml`):

- **verify** (Node 22 and 24): `pnpm typecheck`, `pnpm lint`, `pnpm docs:check`, `pnpm secrets:check`, `pnpm test` (every package, coverage thresholds), regenerating the test vectors must change nothing, `pnpm eval` (fails if a scenario fails).
- **e2e**: builds the web app and runs Playwright in Chromium against the real server on a temporary database.
- **container**: builds the Docker image, starts it as the zero-config demo and checks it answers, and checks that the production default refuses to start without real keys.
- **sandbox** (manual dispatch, needs the `PAYPAL_*` repository secrets): `pnpm test:int`.

The workflow has not run on GitHub yet; each step was run locally.
