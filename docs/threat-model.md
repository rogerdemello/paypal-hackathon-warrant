# Threat model

## Scope and stance

Warrant produces **evidence and recommendations** about who authorised what. It does not decide liability and it does not move money on its own; the dispute agent proposes actions that a merchant approves (or an Autopilot toggle approves in the sandbox demo). The models involved (the shopping agent and the dispute agent) are treated as untrusted for facts: facts come from signatures, hashes and PayPal records.

Reference: OWASP Top 10 for LLM Applications (2025), notably prompt injection and excessive agency.

## Assets

1. The integrity of the proof (signatures, hashes, the transparency log).
2. The merchant's funds and dispute outcomes.
3. PayPal, model-provider and signing credentials.
4. Principal privacy (instructions, carts, payer id).
5. The availability and cost of the hosted demo.

## Adversaries

| ID | Adversary | Capability |
|---|---|---|
| A1 | Malicious or compromised agent platform | Signs carts the human never approved; tries to reuse consent |
| A2 | Dishonest buyer | Claims "I never ordered that" about an order they approved |
| A3 | Dishonest or careless merchant | Produces or withholds warrants selectively; skips verification |
| A4 | Fraudster using a stolen PayPal account | Pays through an account that is not the mandate's principal |
| A5 | Prompt injector | Plants instructions in dispute messages or product text |
| A6 | Network attacker | Forges webhooks, replays requests |
| A7 | Hostile visitor to the hosted demo | Burns model budget, probes endpoints |

## Attack catalog

| # | Attack | Mitigation | Rule / component | Sim case |
|---|---|---|---|---|
| T1 | Cart swap: consent for cart A, order for cart B | Consent signature covers `cart_hash`; merchant recomputes; mismatch rejects at checkout or is detected as F5 in a dispute | V01, V07, F5 | `swap-*` |
| T2 | Scope stretch: agent buys outside the mandate | Mandate is wallet-signed; cart checked against scope | V09, F6 | `scope-*` |
| T3 | Forged warrant | Signatures verify against registry keys | V01, V02 | `forge-*` |
| T4 | Replay the same warrant | One-time nonce per merchant | V05 | `replay-*` |
| T5 | Reuse a warrant at another merchant | `aud` binds to one merchant | V04 | `aud-*` |
| T6 | Expired or revoked key | Registry status and validity window | V02, V03 | `key-*` |
| T7 | Warrant valid but paid by a different PayPal account | Payer id hash comparison | V11, F7 | `payer-*` |
| T8 | Merchant skips verification, fights an unwinnable case | Facts engine recomputes from the stored bundle and routes to accept-and-attribute | F1-F8, outcome table | `permissive-*` |
| T9 | Merchant omits an inconvenient warrant | Wallet-side receipt and transparency-log entry exist independently | Registry log | `log-*` |
| T10 | Backdated warrant | Transparency log timestamps and hash chain | Registry log | `log-*` |
| T11 | Dishonest buyer claims "unauthorised" after approving | Valid consent, bound payer and matching order produce `FIGHT` with evidence | F1-F8 | `remorse-*` |
| T12 | Prompt injection in the dispute message | Model only picks a claim type from an enum, cannot call tools, and the outcome table is code; conflicts with PayPal's `reason` go to a human | Dispute agent design | `inject-*` |
| T13 | LLM invents a fact in the evidence notes | Every id, amount and date in generated text must appear in the facts JSON or the draft is rejected | Output check | `halluc-*` |
| T14 | Consent screen spoofing by the agent | Wallet renders the screen from the cart itself and signs the hash of what it rendered | Wallet | manual and e2e |
| T15 | Forged webhook | Verify with PayPal's verify API; dedupe by event id; re-read via GET | Webhook handler | `webhook-*` |
| T16 | Ledger tampering | Hash chain with a verify endpoint | Ledger | `ledger-*` |
| T17 | Registry compromise | Out of scope for the prototype; production needs an authority such as PayPal, with key transparency and monitoring | n/a | n/a |
| T18 | Burn the demo's model budget | Per-visitor and global caps, fixtures fallback, short runs | Demo controls | load test |
| T19 | Secrets in the repository | `.gitignore`, secret scanning in CI | Process | CI |
| T20 | Sandbox and production confusion | Startup check refuses a production base URL unless explicitly allowed; banner in the UI | Config | `config-*` |
| T21 | Consent reuse: the agent re-signs the consented cart under a fresh `jti`, or for another merchant | The consent signs `cart_jti` and `aud`; V05 refuses a repeated `jti` | V01, V05, F4, F8 | `consent-reuse-*` |
| T22 | Budget stretch: many carts that each fit the mandate but together exceed it | `budget_mode: cumulative` and the check against the spend already recorded under the mandate. Residual: a merchant only sees its own spend | V09, F6 | `budget-*` |

## Residual risks (stated honestly)

- **Warrant proves authorisation of a cart, not satisfaction.** A buyer who approved the cart can still have a legitimate "not as described" or "not received" dispute. The outcome table handles those on delivery and listing facts.
- **Trust on first use for payer binding.** The first order from a new principal cannot be compared with an earlier hash.
- **Server-held principal key in the demo.** A real deployment needs device-bound keys. In the demo the wallet service signs after the human clicks approve; say so.
- **Registry authority.** A directory is only as trustworthy as its operator. This is why the realistic home for it is a party like PayPal.
- **Self-authored evaluation.** The scenario corpus is ours. It shows the pipeline behaves as designed; it does not measure real dispute win rates.
- **Privacy.** The merchant sees the instruction text and cart. Selective disclosure is future work.
- **Category and listing accuracy** depend on catalog data; the listing hash proves what was shown, not that it was true.
- **Legal status.** Advisory output only. No claim is made about card-network rules or law.

## Verification

Each row with a sim case id is covered by `pnpm eval`. Do not publish numbers until the corpus has actually been run; the report is generated, not hand-written. See [testing.md](testing.md).
