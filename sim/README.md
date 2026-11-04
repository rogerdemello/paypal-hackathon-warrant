# @warrant/sim

The evaluation harness. `pnpm eval` replays a labelled corpus of 87 scenarios in 12 families through the real pipeline (wallet, verifier, merchant, PayPal simulator, dispute agent) and writes [`report.json`](report.json).

```bash
pnpm eval                              # every scenario, rewrites sim/report.json
pnpm eval --family forgery             # one family; prints results, does not write the report
pnpm eval --only remorse-01,forge-02   # specific scenarios
```

The command exits 1 if any scenario does not do what its label says, so it is a CI gate as well as a report.

## What a scenario is

A scenario ([`apps/server/src/lab/scenarios.ts`](../apps/server/src/lab/scenarios.ts)) says how the merchant is set up, what the shopper and agent do, optionally what goes wrong (an attack on the warrant, a merchant failure, a buyer's claim), and what the verifier, the checkout and the dispute agent should do. The corpus lives in the server because the Lab page of the web app runs the same scenarios live; this package only scores them.

The families are: honest purchase then "I never ordered", cart swap, scope stretch, forgery, replay and audience, key and time, payer mismatch, merchant fault, injection and hallucination, permissive or no-support merchants, consent reuse, budget stretch.

## What the report contains

| Section | What it shows |
|---|---|
| `corpus` | scenarios run, passed, failed, per family |
| `verifier` | honest warrants accepted; adversarial warrants flagged by the rules and refused by strict merchants; how many a permissive or no-support merchant sold anyway; catch rate per rule V01-V12 |
| `disputes` | outcome, rule and proposed action checked against the label, by claim type; how many went to a person |
| `evidence_notes` | template notes versus model drafts, and model drafts rejected because they stated a fact the case record does not hold |
| `ablation` | the same disputes decided by the same outcome table with every warrant-derived fact (F1-F8, F10) removed |
| `latency` | time from webhook to proposed action on the in-process pipeline |

Current result (see the file for the full numbers): 87 of 87 scenarios do what their label says; 41 of 41 honest warrants are accepted; 37 of 37 adversarial warrants are refused by strict merchants; the 9 adversarial warrants sent to permissive or no-support merchants are sold anyway (that is what those modes mean); dispute outcome accuracy is 39 of 39, with 10 sent to a person; with the warrant facts removed 20 of 39 decisions change, 11 of the 12 contestable cases are lost and none of the 5 agent-platform-fault attributions survives.

## What this does not show

The corpus is authored by us, so the numbers show that the pipeline behaves as designed. They are not a measurement of real-world dispute win rates, they do not measure any language model (the run uses the deterministic template notes and fixed time and ids), and the PayPal simulator is not PayPal. The report says so in its `limitation` field, and the README and the docs repeat it wherever a number appears.

## Files

- [`src/eval.ts`](src/eval.ts): the runner. Opens one in-memory PGlite, truncates it between scenarios, builds a fresh container with a manual clock and sequential ids, runs each scenario, collects facts and note source.
- [`src/metrics.ts`](src/metrics.ts): pure functions that turn the run records into the report. Unit tested in [`test/metrics.test.ts`](test/metrics.test.ts), which also checks that the committed `report.json` covers exactly the scenarios in the corpus.

`pnpm test` runs the metrics tests with coverage; `pnpm typecheck` checks the package. Seeds for new scenarios: [`docs/test-vectors.json`](../docs/test-vectors.json) holds a case for every verifier rule and every row of the outcome table.
