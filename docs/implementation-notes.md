# Implementation notes: how the specs were read, and what is still open

This file records what `packages/warrant` does where the specs ([warrant-spec.md](warrant-spec.md), [verification-rules.md](verification-rules.md), [dispute-resolution.md](dispute-resolution.md)) leave a choice, and the weaknesses found while implementing them. Section 1 is behaviour that is implemented and tested. Section 2 lists what is still open: a problem, why it matters, and a proposed fix that needs a decision. Section 3 is the design of the Warrant 0.2 change (G1 consent binding, G2 cumulative budget), now implemented. Section 5 records the wording that was applied to the other docs so they match the code. Section 6 records what building the server, the web app and the evaluation harness turned up.

The code is the reference for behaviour: [packages/warrant](../packages/warrant/README.md), with deterministic [test vectors](test-vectors.json).

## 1. Interpretations that are implemented

### Formats

| Topic | Choice |
|---|---|
| Hash string | `sha256:` plus the **unpadded** base64url digest (43 characters). The spec says "base64url" without saying whether to pad |
| `mandate.hash` | Hash of the canonical mandate **payload**, not of the compact JWS string, so it does not depend on how the JSON was laid out |
| `cart_hash` | Hash of the canonical `{ currency, items, total }` object only. It excludes `jti`, `nonce`, `aud`, `iat`, `exp` and `consent`; since 0.2 the consent signs `cart_jti` and `aud` itself, so identical carts no longer share a consent |
| "Cart warrant hash" (transparency log) | Hash of the whole canonical cart payload |
| Consent payload | `{ "typ": "consent", "cart_hash", "cart_jti", "aud", "presented_hash", "approved_at", "mandate_hash" }`. `typ` was added for domain separation; the spec's `mandate.hash` is the field `mandate_hash`; `cart_jti` and `aud` are the 0.2 binding to one cart warrant and one merchant |
| Version | Bundles carry `"warrant_version": "0.2"`. 0.1 bundles are rejected (there is no deployed base to keep compatible) |
| `scope.budget_mode` | New required mandate field, `cumulative` or `per_cart`. See G2 |
| JWS header | Exactly `{ "alg": "EdDSA", "kid": ... }` (the spec example). Anything else, including `typ`, `jwk` or `crit`, is rejected |
| JWS encoding | Three canonical base64url segments, no padding. The underlying library accepts a signature re-encoded with different trailing bits; this package rejects it |
| Time | `NumericDate` claims are integers (the JWT definition also allows fractions). `approved_at` is `YYYY-MM-DDTHH:MM:SS[.mmm]Z` only |
| Keys | Private: base64 PKCS#8 DER. Public: base64 SPKI DER. `pnpm keygen` prints `WALLET_SIGNING_KEY`, `AGENT_PLATFORM_SIGNING_KEY` and `REGISTRY_LOG_KEY` |
| Registry key owner | Agent keys: the platform id. Wallet keys: the mandate `iss`. The spec does not say how a key is tied to an issuer |
| Key history | `statusChangedAt` records when a key left `active`. A real registry needs a full status history; this is the smallest model that answers "was it active at time t" |

### Verifier (V01-V12)

| Rule | Reading |
|---|---|
| V01 | The consent signature must verify **and** cover all six values (`cart_hash`, `cart_jti`, `aud`, `presented_hash`, `approved_at`, mandate hash). A `human_present` cart with no consent signature fails here as well as in V10. An unparseable bundle returns one V01 finding (there is no "V00") with `null` hashes |
| V02 | "Active now" and "not revoked at `iat`" contradict each other for a key revoked since. Both are checked: now, and at issue (agent key at the cart's `iat`, wallet key at the mandate's `iat`, consent key at `approved_at`). Key kind and owner are checked here |
| V03 | The 60 s skew applies on both sides of every window. The cart lifetime limit (900 s) is inclusive. Beyond the spec's list, it also rejects a cart whose `iat` falls outside the mandate's `[nbf, exp]` (with the skew), and a mandate whose `iat` is after its `nbf`, so a cart cannot claim to be issued before the mandate existed or after it ended. The consent `approved_at` is still not bounded (G4) |
| V04 | `aud` must equal `paypal-merchant:<merchantId>` exactly |
| V05 | Two findings: the nonce and the cart `jti` must each be unseen (`nonceSeen`, `cartSeen`). The verifier only checks; the caller must record both atomically after accepting. A consent signs one `jti`, so a repeated `jti` is a replayed consent |
| V06 | Also requires the cart's `mandate.jti` to match, the cart's header `kid` to equal the mandate's `agent.kid` (otherwise `agent.kid` would be decoration), and `instruction.hash` to equal `hashText(instruction.text)`, the hash of the human's request as UTF-8 bytes with no normalisation. The definition is stated in `warrant-spec.md` section 3.1, because another implementation that hashed the instruction differently would be rejected here |
| V07 | "Canonical cart object" is `{ currency, items, total }` |
| V08 | If the merchant catalog supplies a listing hash it must equal the line's `listing_hash`. The catalog total must equal `cart.total` |
| V09 | "Per item" is the **unit price** of each line. "Item count" is the **sum of quantities**. Merchant rules match the merchant id, the full `paypal-merchant:<id>` audience, or `*`; deny beats allow; an empty allow list allows nothing. With a category allow list, an item whose category is unknown fails. With `scope.budget_mode` `cumulative`, `max_total` and `max_items` are totals over the mandate's life: the spend already recorded plus this cart must fit. Unknown spend (no `spentUnderMandate`, or it returns `null`) is a **review**, not a pass; a malformed spend (negative, fractional, not a number) is a reject because it can only be a caller bug. `per_cart` mandates apply the limits to each cart and need no spend source |
| V10 | `human_present` needs `approved_at`, `method`, `presented_hash`, `signature` **and** a wallet record, looked up by the cart `jti`, whose `presented_hash` matches. A `human_not_present` cart under a `human_present` mandate is rejected |
| V11 | Compares `hashText(payer_id)` with the mandate's hash. No hash yet means `REVIEW` with `firstUse: true`; the caller records the hash. It reads the mandate without checking its signature (call it after `verifyCheckout`) |
| V12 | `REVIEW` when the prior count in the window is at or above the limit, for the principal or the agent platform. "Stay under the limit" is read as prior count `< limit` |

### Facts (F1-F13)

| Fact | Reading |
|---|---|
| F1 | A bundle is stored (even if malformed; F2 then fails) |
| F2 | Cart, mandate and consent signatures all verify against the registry. Missing consent signature is fine only for `human_not_present` |
| F3 | Keys were active when issued. When a transparency-log time is supplied it is checked too, because the signed `iat` is chosen by the signer and could be backdated |
| F4 | Consent requirements of V10 hold, the consent signature verifies, and it covers this cart, its `jti` and its merchant |
| F5 | The order equals the **bundle** cart (currency, total, and lines when the order has any) **and** the bundle cart is what the consent covers. `detail` records both halves so attribution can tell an agent that signed an unapproved cart from a merchant that changed the order. When the order has no line items only the amount is compared, and `detail.linesCompared` says so |
| F6 | Same checks as V09, using the merchant's categories. For a `cumulative` mandate it uses `spentBefore`, the spend recorded when the cart was accepted. If that is unknown the fact is decided on the per-cart limits alone and `detail.cumulativeChecked` is `false`, so an agent platform is never blamed (outcome row 3) for something that cannot be shown |
| F7 | The mandate already carries a payer hash and it equals the order's payer. Trust-on-first-use alone does not count as bound |
| F8 | The nonce **and** the cart `jti` were each recorded exactly once (zero counts as false: it cannot be shown to be unique) |
| F9 | Tracking says delivered. `detail.onTime` is `deliveredAt <= promisedBy`; with no promised date any delivery is on time; delivered with no date against a promise is not on time |
| F10 | Every warrant line's `listing_hash` equals what the merchant fulfilled for that SKU. Unknown fulfilment counts as no match |
| F11 | Any refund exists |
| F12 | Hours to the response deadline, or `null` when PayPal gave none |
| F13 | The disputed amount does not exceed the capture |

### Outcome table

- The "any claim" rows are evaluated **before** the claim rows: already refunded (F11) first, then an unknown or short deadline (F12 `< 24` hours, or unknown) and an amount above the capture (F13), which escalate. A refunded dispute is never actioned.
- Claim rows are then evaluated top to bottom, first match wins. Rows 2 and 3 of `UNAUTHORIZED` come before row 4, so a cart that differs from the consent is attributed to the agent platform even if F3 or F7 also fail.
- A merchant that did not enforce verification (`PERMISSIVE` or `NONE`) is a `contributing` party in the agent-fault rows. If the agent's cart is what the human approved but the order that was paid differs, the merchant is `primary` and the agent platform `none`, with the flag `order_differs_from_signed_cart`, while the outcome stays `ACCEPT_AGENT_FAULT` as the table says.
- Row 2 of `UNAUTHORIZED` ("the order differs from what was approved") is entered when F2 is true **or** when the cart and mandate signatures verify and only the consent does not cover the cart (`signedObjectsAuthentic`). Found by the scenario corpus: with a plain F2 test, a swapped cart (the agent signed a cart the human never approved) made F2 false and fell through to `NO_PROOF`, so the row meant for exactly that case could not be reached.
- `DUPLICATE` and `OTHER` have no row.
- Rows the table does not cover resolve to `ESCALATE_TO_HUMAN` with the flag `table_gap`:

| Case | Rule id |
|---|---|
| `UNAUTHORIZED` with F1, F2, F3, F5, F6, F7 true but F4 or F8 false | `UNAUTHORIZED_GAP` |
| `NOT_RECEIVED`, delivered but late | `NOT_RECEIVED_GAP` |
| `WRONG_AMOUNT` with F5 true | `WRONG_AMOUNT_GAP` |
| `DUPLICATE` | `DUPLICATE_NO_ROW` |
| `OTHER` | `OTHER_NO_ROW` |

## 2. Open problems and proposed changes

Severity is for the product claim "the proof binds the agent to what the human approved".

| # | Problem | Severity |
|---|---|---|
| G1 | **Resolved in 0.2.** Consent replay across identical carts, and across merchants: the consent now signs `cart_jti` and `aud`, and V05 refuses a repeated `jti` | Resolved |
| G2 | **Resolved in 0.2, with a limit.** `scope.budget_mode: "cumulative"` makes V09 add the recorded spend. The spend source is the caller's; a merchant that only sees its own orders sees only its own spend (section 3.3.3) | Resolved |
| G3 | **Resolved in 0.2.** The cart `jti` is deduplicated by V05 (`cartSeen`). The nonce is still agent-chosen and per merchant, which is acceptable now that the signed `jti` is what makes a consent single-use | Resolved |
| G4 | **Unbounded consent age.** Nothing limits how old `approved_at` may be relative to the cart. A consent from days ago can sit under a new cart warrant | Medium |
| G5, G6 | **Resolved in code** (see V03 and V06 above): the cart `iat` must fall inside the mandate window, the mandate `iat` must not be after its `nbf`, and `instruction.hash` must match `instruction.text`. `verification-rules.md` and `warrant-spec.md` now list these checks | Resolved |
| G7 | **Transparency log has no succinct inclusion proof.** A hash chain proves order, not membership, and cannot show its tail was not cut off. The spec promises "inclusion proofs" | Medium |
| G8 | **Registry status model.** One `statusChangedAt` cannot represent suspend, restore, revoke. Fine for a prototype, wrong for a registry | Low |
| G9 | **Outcome table gaps and ordering** (section 1). Each gap currently escalates, which is safe but means those cases never get an automated answer | Medium |
| G10 | **Trust on first use for payer binding.** A stolen account can be the first payer. Only a verified link fixes this (the README lists Log in with PayPal as future work) | Medium |
| G11 | **Order lines are optional in F5.** An order with the right total but different items passes when the merchant sent no line items | Low |

### Proposed changes for the remaining items (not implemented; need a decision)

**G1, G2, G3:** implemented as Warrant 0.2; see [section 3](#3-g1-and-g2-the-warrant-02-change-implemented) for the design and [section 5](#5-wording-changes-applied-to-the-other-docs) for the wording applied to the other docs.

**G4: add a consent age bound.** For example `approved_at` must not be later than the cart `iat` plus skew, and not earlier than `iat` minus a configured maximum (say 15 minutes, the cart lifetime). Needs a number.

**G5/G6:** done, and documented in `verification-rules.md` (V03, V06) and `warrant-spec.md` (section 3.1 defines `instruction.hash`).

**G7: use a Merkle log.** Replace the registry's chain with an RFC 6962 style tree so the log can serve inclusion and consistency proofs; keep the hash chain for the merchant's audit ledger, where order is what matters.

**G9:** decide the missing rows. Candidates: `UNAUTHORIZED` with F4 false is `NO_PROOF`; `NOT_RECEIVED` delivered late is `FIGHT` at low confidence; `WRONG_AMOUNT` with F5 true and F1, F2, F4 true is `FIGHT`; `DUPLICATE` compares F8 and the capture count.

## 3. G1 and G2: the Warrant 0.2 change (implemented)

**Status: implemented** in `packages/warrant`, with tests and regenerated vectors. The design below is what was approved and built (all six decisions in 3.5 were accepted as recommended); 3.6 lists the small additions made while building it. The spec and rule documents were updated to match; section 5 records exactly what changed. Both changes alter signed documents, so they ship together as **Warrant 0.2**.

### 3.1 What goes wrong today

| | G1: consent replay | G2: no cumulative limits |
|---|---|---|
| Attack | An agent platform that already holds one valid consent for cart A signs a new cart warrant for the same items with a fresh `jti` and `nonce`, and checks out again, as often as it likes while the mandate lives | An agent platform makes many carts that each fit the mandate. Each passes V09 alone; together they exceed `max_total` and `max_items` |
| Why the rules miss it | `cart_hash` covers only `{currency, items, total}`, so the new cart has the same hash and the old consent still "covers" it. V05 sees a new nonce | V09 evaluates one cart. Nothing sums carts per mandate |
| Who it hurts | The principal (buys what they approved, again and again), and the merchant in a dispute (the proof looks valid but the human approved one purchase) | Same. In `human_not_present` mode no wallet signature is ever checked, so the merchant is the only line of defence |
| Reproduce | `verify.test.ts`: "G1: an IDENTICAL cart under a fresh jti and nonce cannot reuse the consent" (this test used to expect `ACCEPT` and now expects `REJECT`) | No test: it is the absence of a rule |

A related hole found while writing this: the consent does not cover the **audience** either. The agent can re-sign the consented cart with a different `aud` and present it to another merchant that stocks the same SKUs. Section 3.2 closes it in the same change.

### 3.2 G1: bind the consent to one cart warrant and one merchant

**Design.** The wallet signs the cart warrant's `jti` and `aud` inside the consent. Because the consent is signed before the agent signs the cart warrant (spec section 6, steps 2 and 3), the identity of the cart warrant has to exist before the consent is signed. The agent platform therefore chooses `jti` and `aud` when it proposes the cart, and the wallet puts them on the consent screen record and into the signature. The cart warrant must then carry exactly those values.

Why `jti` and `aud` and not `nonce`: with the `jti` signed and **single use** (3.2.3), a consent can be spent once. The nonce stays agent-chosen replay protection for the transport. Why not fold `jti` into `cart_hash`: that would make the hash of identical contents differ per warrant and lose the cheap "is this the same cart?" comparison that F5 and the evidence packet rely on.

**3.2.1 Document changes** (`docs/warrant-spec.md`)

| Where | Today | Proposed |
|---|---|---|
| Bundle | `"warrant_version": "0.1"` | `"0.2"`. A 0.2 verifier rejects 0.1 bundles (no deployed base to protect) |
| Section 3.3, consent `signature` | JWS over `{ cart_hash, presented_hash, approved_at, mandate.hash }` | JWS over `{ typ: "consent", cart_hash, cart_jti, aud, presented_hash, approved_at, mandate_hash }` |
| Section 4 or 3.3 | (silent) | "`cart_jti` and `aud` in the consent MUST equal the cart warrant's `jti` and `aud`." |
| Section 6, step 2 | "The agent finds a product and proposes a cart. The wallet shows the consent screen..." | "The agent proposes a cart together with the `jti` and `aud` it will use. The wallet shows the consent screen and signs the consent over them." |
| Section 5, last row | Capture id stored against the warrant | Unchanged. The consent jti makes the capture to warrant mapping unambiguous when two orders share a cart hash |

**3.2.2 Rule changes** (`docs/verification-rules.md`)

| Rule | Change |
|---|---|
| V01 | "...and covers `cart_hash`, `cart_jti`, `aud`, `presented_hash`, `approved_at` and `mandate.hash`". The coverage gap list gains `cart_jti` and `aud` |
| V05 | Becomes "`nonce` **and** cart `jti` have not been seen by this merchant" (also closes G3). Two findings, so the console shows which one repeated |
| V10 | The wallet record is looked up by cart `jti` (a cart hash can now have several consents): `walletRecord({ cartJti, cartHash })`. The match on `presented_hash` is unchanged |
| F4 (dispute) | Inherits the stricter V01 coverage |
| F8 `nonce_unique` | "The nonce **and the cart `jti`** were each used once" |

**3.2.3 Single use.** The consent can only be spent once if the merchant refuses a repeated `jti`. `VerifyContext.cartSeen(jti)` is checked by V05, and the caller records `jti` and `nonce` together, atomically, after `ACCEPT` (insert-if-absent on both). The wallet must also refuse to issue two consents for one `jti` (a unique constraint on `consents.cart_jti`).

**3.2.4 Code changes** (`packages/warrant`)

| File | Change |
|---|---|
| `src/schema.ts` | `consentPayloadSchema` gains `cart_jti: id` and `aud: shortText`; `bundleSchema.warrant_version` becomes `'0.2'` |
| `src/warrant.ts` | `WARRANT_VERSION = '0.2'`; `ConsentInput` gains `cartJti` and `aud`; `signConsent` writes them; `buildHumanPresentConsent` unchanged |
| `src/verify.ts` | `consentCoverageGaps` also compares `cart_jti` and `aud`; V05 emits a nonce finding and a jti finding; `VerifyContext` gains `cartSeen: (jti: string) => boolean`; `WalletRecordLookup` takes `{ cartJti, cartHash }`; `consentProblems` unchanged apart from the record lookup |
| `src/facts.ts` | `FactsInput` gains `jtiUseCount`; F8 requires `nonceUseCount === 1 && jtiUseCount === 1`; `walletRecord` signature as above |
| `src/evidence.ts` | The packet's consent section records the covered `cart_jti` and `aud` |
| `examples/quickstart.ts`, `test/fixtures.ts`, `test/vectors.ts`, README tables | Updated for the new inputs |
| `docs/test-vectors.json` | Regenerated (every consent, and therefore every honest signature, changes) |

**3.2.5 Tests and vectors G1 needs**

| Name | Setup | Expected |
|---|---|---|
| `v01-consent-reused-for-identical-cart-new-jti` | Honest consent; agent signs a second cart with identical items, new `jti` and `nonce`, same consent object | `REJECT`: V01 (`cart_jti` not covered). **Flips the existing "documented spec gap" test from `ACCEPT` to `REJECT`** |
| `v01-consent-for-other-merchant` | Consented cart re-signed with `aud = paypal-merchant:OTHERMERCHANT`, presented to OTHERMERCHANT (so V04 passes) | `REJECT`: V01 (`aud` not covered) |
| `v01-consent-from-0-1-bundle` | Consent payload without `cart_jti`/`aud` | `REJECT`: V01 (consent undecodable) |
| `v05-replayed-jti-fresh-nonce` | Honest bundle, `cartSeen(jti)` true, nonce unseen | `REJECT`: V05 |
| `v05-replayed-nonce-fresh-jti` | `nonceSeen` true, `cartSeen` false | `REJECT`: V05 |
| `v10-wallet-record-for-other-jti` | Record exists for the cart hash under a different jti | `REJECT`: V10 |
| `honest-*` | Regenerated with the new fields | `ACCEPT` |
| Unit | `signConsent` rejects missing or malformed `cartJti`/`aud`; `consentCoverageGaps` lists exactly the differing fields; F8 is false when only the jti repeats; the consent signature still fails on any single-character edit | pass |
| Fact vector | F8 with `jtiUseCount: 2` | false |

### 3.3 G2: make the limits a budget

**Design.** Let the mandate state what its limits mean, and give the verifier the spend already recorded under the mandate.

**3.3.1 Document changes** (`docs/warrant-spec.md` section 3.1)

| Field | Proposed |
|---|---|
| `scope.budget_mode` (new, required) | `"cumulative"`: `max_total` and `max_items` are totals over the life of the mandate. `"per_cart"`: they apply to each cart separately (today's behaviour). `max_per_item` is always per unit. The wallet sets `"cumulative"` for "find a desk under $120" |

**What counts as spent.** Every cart warrant under this mandate that was `ACCEPT`ed (or `REVIEW`ed and approved) and whose order was not abandoned before capture. Spend is **reserved when the merchant accepts** (not when the money moves) so that two concurrent checkouts cannot both fit. **Refunds do not restore budget**: a refund returns the buyer's money, it does not widen what the human authorised.

**3.3.2 Rule changes** (`docs/verification-rules.md`)

| Rule | `budget_mode: "per_cart"` | `budget_mode: "cumulative"` |
|---|---|---|
| V09 | As today | Also: `spent.totalCents + cartTotal <= max_total` and `spent.itemCount + cartItems <= max_items`, else **reject**. If the verifier cannot supply the spend (`spentUnderMandate` is absent or returns `null`), V09 returns **review**, never a silent pass |

**3.3.3 Where the spend comes from.** This is the real design question, because a mandate with `merchants_allow: ["*"]` can be used at several merchants and a single merchant sees only its own orders.

| Source | Sees | Cost |
|---|---|---|
| **Merchant's own orders** (prototype default) | Spend at this merchant only. Correct when the mandate allows one merchant, a lower bound otherwise | None. Already in the `orders` table |
| **Wallet** (`consents` table) | Every `human_present` cart, because each needed a wallet signature; blind to `human_not_present` carts | Merchant calls the wallet; couples checkout latency to the wallet |
| **Registry log** | Everything logged, across merchants, if each log entry carries `{ mandate_jti, currency, total, item_count }` besides the warrant hash | Privacy: the neutral registry learns amounts per opaque mandate id. Needs a log schema change (the log today stores only hashes) |

Recommendation for the hackathon: merchant orders for the live demo (one merchant), wallet check at consent time for `human_present`, and the registry aggregate listed as the production path. Say plainly in the README limitations that a multi-merchant budget needs a shared source.

**Caller contract.** The pure function cannot be atomic. The caller must read the spend, run `verifyCheckout`, and record the reservation inside one transaction that holds a per-mandate lock (for example `SELECT ... FOR UPDATE` on the mandate row), exactly like the nonce insert.

**3.3.4 Code changes** (`packages/warrant`)

| File | Change |
|---|---|
| `src/schema.ts` | `mandateSchema.scope` gains `budget_mode: z.enum(['cumulative', 'per_cart'])` |
| `src/warrant.ts` | `MandateInput.scope` gains `budgetMode`; `buildMandate` writes `budget_mode` |
| `src/verify.ts` | New `Spend = { totalCents: number; itemCount: number }`; `VerifyContext.spentUnderMandate?: (mandateJti: string) => Spend \| null`; `scopeProblems` takes the spend and `budget_mode`, and V09 maps the "cannot check" case to `review` |
| `src/facts.ts` | `FactsInput.spentBefore: Spend \| null` (the spend recorded when the cart was accepted); F6 applies the same cumulative check and records `detail.cumulativeChecked` |
| `src/evidence.ts` | The mandate section records `budget_mode` |
| `test/vectors.ts` and `VectorContext` | New field `spent_under_mandate: { total_cents, item_count } \| null \| "not_configured"` |

**3.3.5 Tests and vectors G2 needs** (honest cart is 89.00, `max_total` 120.00, `max_items` 2)

| Name | Mode | Spend before | Expected |
|---|---|---|---|
| `v09-cumulative-total-exceeded` | cumulative | 32.00, 1 item (32.00 + 89.00 = 121.00) | `REJECT`: V09 |
| `v09-cumulative-items-exceeded` | cumulative | 0.00, 2 items (2 + 1 > 2) | `REJECT`: V09 |
| `v09-cumulative-exactly-at-limit` | cumulative | 31.00, 1 item (31.00 + 89.00 = 120.00; 1 + 1 = 2) | `ACCEPT` |
| `v09-cumulative-spend-unknown` | cumulative | `null` | `REVIEW`: V09 |
| `v09-cumulative-not-configured` | cumulative | function absent | `REVIEW`: V09 |
| `v09-per-cart-ignores-spend` | per_cart | 999999.00, 99 items | `ACCEPT` |
| Fact vector | cumulative | `spentBefore` pushes the cart over | F6 false, `detail.cumulativeChecked: true` |
| Property | cumulative | random sequence of carts, each accepted cart's spend recorded | Total accepted never exceeds `max_total` and item count never exceeds `max_items`, for any sequence and any order |
| Unit | | | `budget_mode` required and validated; refunds do not reduce the spend passed in (documented, since the caller supplies the number) |

### 3.4 Effects on the rest of the system

- **Compatibility:** none is kept. All 0.1 signatures become invalid under 0.2, and `docs/test-vectors.json` changes entirely. Fine before any deployment; costly after.
- **Wallet service:** must reserve `jti`/`aud` with the agent, show the merchant on the consent screen (so `aud` is something the human actually saw), enforce one consent per `jti`, and for `cumulative` mandates refuse to sign a consent that would exceed the budget (its job per the spec).
- **Merchant server:** adds a unique index on cart `jti`, a per-mandate spend tally, and the transaction around verify, reserve and record.
- **Dispute engine:** F6 and F8 need the two new inputs; the outcome table is unchanged. The packet shows what the consent covered.
- **Threat model:** T4 (replay) and T2 (scope stretch) gain real mitigations for the cases above; `docs/threat-model.md` should list "consent reuse" and "budget stretch" as attacks with sim case ids `consent-reuse-*` and `budget-*`.
- **Size of the change in this package:** about 6 source files and the fixtures, an estimate of about a day including vectors and doc updates; no new dependencies.

### 3.5 Decisions (all six approved as recommended)

| # | Question | Decision |
|---|---|---|
| 1 | Hard version bump to 0.2 with no 0.1 support? | Yes |
| 2 | Cover `aud` in the consent as well as `jti`? | Yes: it closes the cross-merchant reuse for one extra field |
| 3 | Is a mandate's `max_total`/`max_items` a budget by default? | Yes, via an explicit `budget_mode`, so a per-cart ceiling stays expressible |
| 4 | Do refunds restore budget? | No |
| 5 | Where does the spend come from for the demo? | Merchant orders; document the multi-merchant limit |
| 6 | When spend is unavailable under a `cumulative` mandate: review or reject? | Review (a merchant can approve; reject would break checkout whenever the tally is down) |

### 3.6 What was built, and where it differs from the proposal

| Item | Note |
|---|---|
| `VerifyContext` | `cartSeen` is **required** (a breaking change for callers). `spentUnderMandate` is optional; `walletRecord` now takes `{ cartJti, cartHash }` |
| `FactsInput` | Gains required `jtiUseCount` and `spentBefore` |
| Malformed spend | Not in the proposal: a negative, fractional or non-number spend is a **reject** (it can only be a caller bug), not a review |
| `budgetCheck` | Exported from `verify.ts` and shared by V09 and F6; returns `rejects`, `reviews` and whether a cumulative check was made |
| Evidence packet | Records what the consent covers (`cart_jti`, `aud`, `cart_hash`, `mandate_hash`) and the mandate's `budget_mode`; F6's detail carries `cumulativeChecked` |
| Vectors | `docs/test-vectors.json` is regenerated for 0.2 and gains a `facts` section (jti used twice, cumulative over budget, at the limit, spend unknown, refunded). Verify vectors gain the five G1 cases and the six G2 cases listed in 3.2.5 and 3.3.5. Verify vectors now carry `used_cart_jtis` and `spent_under_mandate`, and wallet records are keyed by jti |
| Property tests | A new property replays random sequences of carts through `verifyCheckout` with a spend tracker: accepted carts never exceed `max_total` or `max_items`, and every cart that fits is accepted |
| Not done here | The wallet side (reserving jti and aud with the agent, one consent per jti, refusing a consent over budget), the merchant transaction around verify, reserve and record, and a shared spend source across merchants. These belong to `apps/server`; the contract is in the package README |

## 4. Commands

Everything the README and [setup.md](setup.md) describe exists. What each command was verified against:

| Command | What it does | Verified |
|---|---|---|
| `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test` | Workspace checks and every package's tests with coverage thresholds | Run in a clean copy (section 6.6) |
| `pnpm dev` | Server on :8787 and Vite on :5173 (proxying `/api` and `/sim`) | Started and probed |
| `pnpm start` | The server alone; serves `apps/web/dist` when it has been built | Run, and inside the Docker image |
| `pnpm db:migrate` | Applies migrations without starting the server | Run |
| `pnpm keygen` | Prints the three signing keys | Run |
| `pnpm eval` | The 87-scenario corpus through the real pipeline; writes `sim/report.json` | Run; also a CI gate |
| `pnpm e2e` | Builds the web app, starts the server on a temporary database, drives it with Playwright | Run (11 tests), also against the Docker image on Postgres |
| `pnpm paypal:doctor` | A few harmless calls that say whether the sandbox credentials work | Run against the simulator; **not run against the real sandbox** |
| `pnpm test:int` | Integration tests against the real PayPal sandbox | Skips without credentials; **never run against the real sandbox** |
| `pnpm docs:check`, `pnpm secrets:check` | Relative links and anchors resolve; nothing that looks like a secret is committed | Run; both are CI steps |

## 5. Wording changes applied to the other docs

The code implements Warrant 0.2 plus the extra V03/V06 checks from G5 and G6. This section records the edits that brought the other documents in line, so a reviewer can check each one against the code. "Before" quotes the wording that was replaced where there was any. Nothing outside this list was changed in those documents.

### `docs/warrant-spec.md`

| Where | Change |
|---|---|
| Title | "Warrant specification (v0.1, draft)" becomes "(v0.2, draft)" |
| Section 3, bundle JSON; section 10 example | `"warrant_version": "0.1"` becomes `"0.2"` |
| Section 3.1, table | Add a row: `scope.budget_mode` \| `cumulative` or `per_cart` \| `cumulative`: `max_total` and `max_items` are totals over the life of the mandate, counting every cart under it that the verifier is told about. `per_cart`: they apply to each cart separately. `max_per_item` is the limit for one unit in both modes |
| Section 3.1, `instruction.hash` row | Add: "SHA-256 hash (section 4 format) of the UTF-8 bytes of `instruction.text`, with no normalisation" |
| Section 3.3, `signature` row | Before: "JWS by the wallet/principal key over `{ cart_hash, presented_hash, approved_at, mandate.hash }`". After: "JWS by the wallet/principal key over `{ typ: "consent", cart_hash, cart_jti, aud, presented_hash, approved_at, mandate_hash }`" |
| Section 3.3, after the table | Add: "`cart_jti` and `aud` MUST equal the `jti` and `aud` of the cart warrant that carries this consent. The agent platform chooses the `jti` and the merchant when it proposes the cart; the wallet signs them. A consent therefore covers exactly one cart warrant at one merchant, and it is spent when that `jti` is first accepted." |
| Section 4 | Add: "`mandate.hash` is the hash of the canonical mandate payload (not of the compact JWS). `cart_hash` is the hash of the canonical object `{ currency, items, total }`. A cart warrant hash (for the transparency log) is the hash of the whole canonical cart payload. The payer id hash is the hash of the UTF-8 bytes of `payer.payer_id`. NumericDate claims are integers." |
| Section 6, step 2 | Before: "The agent finds a product and proposes a cart. The wallet shows the **consent screen** and signs the consent if the principal approves." After: "The agent finds a product and proposes a cart together with the `jti` and merchant it will use. The wallet shows the **consent screen** (including the merchant) and signs the consent over them if the principal approves." |
| Section 10 | Mandate example scope gains `"budget_mode": "cumulative"`; the cart example's `signature` comment becomes `<JWS over cart_hash, cart_jti, aud, presented_hash, approved_at, mandate_hash>` |

### `docs/verification-rules.md`

| Where | Change |
|---|---|
| Intro, context | "the caller supplies registry data, the merchant's own catalog prices, the nonce store and the current time" gains: "the cart `jti` store, the wallet's consent records (looked up by cart `jti`) and, for cumulative mandates, the spend already recorded under the mandate" |
| V01 | "...and covers `cart_hash`, `presented_hash`, `approved_at` and `mandate.hash`" becomes "...and covers `cart_hash`, `cart_jti`, `aud`, `presented_hash`, `approved_at` and `mandate.hash`, where `cart_jti` and `aud` equal the cart's `jti` and `aud`" |
| V02 | Add: "Each key is of the right kind and owned by the claimed issuer (agent keys by the platform, wallet keys by the mandate `iss`). Keys are checked now and when the signed object was issued" |
| V03 | Add: "The cart's `iat` falls inside the mandate's `[nbf, exp]` (with skew), and the mandate's `iat` is not after its `nbf`" |
| V05 | Before: "`nonce` has not been seen by this merchant" / reject (replay). After: "`nonce` **and** the cart `jti` have not been seen by this merchant" / reject (replay). Add: "The verifier does not record them; the caller records both atomically after accepting" |
| V06 | Add: "`cart.mandate.jti` matches; the cart's header `kid` equals the mandate's `agent.kid`; `instruction.hash` equals the hash of `instruction.text`" |
| V09 | Before: "Total, per-item cap, item count, categories and merchant rules from the mandate all hold for this cart" / reject. After: "Per-item cap (unit price), categories and merchant rules hold for this cart. Total and item count (sum of quantities) hold for this cart and, when `scope.budget_mode` is `cumulative`, for the spend already recorded under the mandate plus this cart. If the spend is unknown the result is **review**" / reject, review |
| V10 | "...matches what the wallet recorded for this cart" becomes "...matches what the wallet recorded for this cart's `jti`" |
| V12 | Add: "Under the limit means the prior count in the window is below it" |
| After capture, bullets | Add: "Record the nonce, the cart `jti` and, for cumulative mandates, the spend, in one transaction that locks the mandate" |
| Tests required, adversarial list | Add: consent reused for an identical cart, consent presented to another merchant, replayed cart `jti` with a fresh nonce, budget stretch across several carts |

### `docs/dispute-resolution.md`

| Where | Change |
|---|---|
| F4 | "`human_present` consent covers this cart hash" becomes "...covers this cart hash, warrant `jti` and merchant" |
| F6 | Add: "For a cumulative mandate, using the spend recorded when the cart was accepted. If that is unknown the fact is decided on the per-cart limits alone and flagged `cumulativeChecked: false`" |
| F8 | "The nonce was used once" becomes "The nonce and the cart warrant `jti` were each used once" |
| Section 4 | Add the gap handling: rows the table does not cover (see section 1 above) resolve to `ESCALATE_TO_HUMAN` |

### `docs/threat-model.md` and `docs/testing.md`

| File | Change |
|---|---|
| `threat-model.md` attack catalog | Add **T21 Consent reuse**: an agent re-signs the consented cart under a fresh `jti`, or for another merchant. Mitigation: the consent signs `cart_jti` and `aud`; V05 refuses a repeated `jti`. Rule: V01, V05, F4, F8. Sim: `consent-reuse-*`. Add **T22 Budget stretch**: many carts that each fit the mandate. Mitigation: `budget_mode: cumulative` and the spend check. Rule: V09, F6. Sim: `budget-*`. Residual risk to state: a merchant only sees its own spend |
| `testing.md` scenario table | Add families "Consent reuse" (min 6) and "Budget stretch" (min 6) |
| `architecture.md` data model | Wallet `consents`: add `cart_jti` (unique) and `aud`. Merchant `warrants`: add a unique index on `cart_jti`. Merchant: add a per-mandate spend tally updated in the same transaction as the nonce and jti |
| `README.md` limitations | Add: "A cumulative budget is only as complete as the spend source: a merchant that sees only its own orders cannot see spend at other merchants" |

## 6. Building the product: what it turned up

The library was finished first; `apps/server`, `apps/web`, `packages/paypal`, `packages/catalog`, `packages/mcp` and `sim` were built on it. This section records the choices that are not obvious from the code, the defects found by running the whole thing, and what is still unverified.

### 6.1 Choices

| Topic | Choice |
|---|---|
| PayPal without credentials | `PAYPAL_ENV=simulator` (the default) runs an in-process stand-in that speaks PayPal's REST paths, error shapes and signed-webhook feed, so `PayPalClient` runs unchanged against it. `PAYPAL_ENV=sandbox` talks to the real sandbox. Production is refused |
| Merchant modes | `STRICT` verifies and refuses on REJECT. `PERMISSIVE` verifies, records the findings, and sells anyway (a resubmitted cart is the same order; a reused nonce is stored as `nonce#n`). `NONE` ignores the bundle and sells at the store price. The Lab runs the same story under each |
| Repeated carts | An identical cart has an identical hash, so PayPal's `invoice_id` would repeat (PayPal rejects duplicate invoice ids). The server appends `-2`, `-3` and stores the id in `orders.invoice_id` (G12) |
| Payer binding | Trust on first use (G10). The first purchase of a wallet has no payer hash, so F7 is false and a dispute about it resolves as `NO_PROOF` with low confidence; linking the sandbox buyer first (a button in the wallet) gives `FIGHT`. The UI says this before the first purchase |
| Concurrency | Verify, record the nonce and `jti`, and reserve spend run in one transaction under a per-mandate advisory lock, so two simultaneous checkouts cannot both spend the last of a budget |
| Ledgers | Orders and disputes keep hash-chained ledgers; the registry keeps a transparency log with signed checkpoints. Both can be audited from the console |
| Claim reading | The claim comes from PayPal's reason and the buyer's message. When they disagree the claim is `CLAIM_CONFLICT` and the dispute goes to a person. In fixtures mode a rules extractor reads it; with a model key a model does, and its answer is only used if it is one of the fixed claims |
| Notes | A template writes the notes in fixtures mode. A model's draft is accepted only if every id, amount and date in it appears in the case record; otherwise the template is used and the console says so |
| Plan vetting | The proposed PayPal action is checked against the dispute's `allowed_response_options`; if not allowed, an allowed alternative is proposed, else an alert |
| Autopilot | Off by default. When on, it executes only normal-confidence, non-escalated `provide-evidence`, `accept-claim` and `make-offer` |
| Demo identity | A random visitor id in the browser (`x-visitor-id`) owns a wallet. The console and Lab are open in judge mode and need `x-console-token` otherwise |
| `spendBefore` | F6 under a cumulative mandate needs the spend before this cart. The server computes it from the order ledger at dispute time; it is an approximation if refunds or other merchants are involved (section 3.3.3) |

### 6.2 Defects found by running it

| Found by | Defect | Fix |
|---|---|---|
| Scenario corpus | Outcome table row 2 ("signed objects not authentic") was unreachable for a swapped cart, because F2 was true whenever the signatures verified | Row 2 now tests `signedObjectsAuthentic(F2)`, which also looks at the consent's coverage; vectors regenerated |
| Scenario corpus | Cumulative budgets also rejected replays, so replay scenarios tested the wrong rule | Replay and reuse scenarios use `per_cart` budgets |
| Browser test | A first purchase resolved as `NO_PROOF` without the shopper being told why | The payer-link nudge and the open-questions wording on the Verify page |
| Local run | The embedded database failed to start in a OneDrive-synced folder (the lock file cannot be created) | The default data folder is outside the repository, and the error names the cause |
| Container test | In production the server demanded TLS from any database with a non-local name, so a Postgres on the compose network could not be reached | `sslOptionFor`: an explicit `sslmode` wins; otherwise no TLS on this machine or a private name, TLS elsewhere |
| Restart test | After a restart, the simulator handed out order ids the database already held (`orders_paypal_order_id_key`), so checkout failed until the counter caught up, and old orders could not be disputed | The simulator's state is saved in the `settings` table and restored; a database without it seeds the counter past every row. `apps/server/test/restart.test.ts` fails without the fix |
| Container test | `WEB_ORIGIN` defaulted to the Vite port, so the simulator's return page pointed at a server that is not there in a single-server deployment | In production it defaults to the public address; `RENDER_EXTERNAL_URL` stands in for `PUBLIC_BASE_URL` on Render |

### 6.3 Evaluation

`pnpm eval` runs 87 labelled scenarios in 12 families through the real pipeline (fixed time, sequential ids, no model calls) and writes `sim/report.json`. The corpus is written by us, so it shows that the pipeline behaves as designed, not that it wins real disputes. The ablation removes the warrant-derived facts and re-decides the same disputes with the same table; it measures what the proof adds, not a language model. See [sim/README.md](../sim/README.md).

### 6.4 Not built, or built less than the plan said

| Item | State |
|---|---|
| Real PayPal sandbox | The client follows PayPal's documentation and is tested against the simulator only. Nothing has run against `api-m.sandbox.paypal.com`: the [spike] items in [paypal-integration.md](paypal-integration.md) are open. `pnpm paypal:doctor` and `pnpm test:int` exist to close them |
| Live models and catalog | The Anthropic and Channel3 paths are implemented against their documented APIs and unit tested with fakes. They have not been run with real keys |
| AG Studio | The console embeds AG Studio in edit mode over three data sources (orders, checkouts, disputes). There is no pre-built dashboard, no custom widget and no Studio agent |
| Verifier as middleware | `verifyCheckout` is a library function and the server's checkout route is the integration; there is no separate middleware package |
| Passkey signing, Log in with PayPal, AP2 and Verifiable Intent adapters | Not built (P2) |
| Spec gaps G4, G7, G8, G9, G11 | Still open (section 2) |
| MCP | `@warrant/mcp` has two read-only tools, `verify_warrant` and `get_dispute_facts`, taking only identifiers |
| Hosted demo, demo video | Not produced here. The Dockerfile and `docker-compose.yml` were checked by building the image and running it, with Postgres, in production mode; `render.yaml` was not applied to Render |

### 6.5 Simulator state

The simulator remembers what it has done in memory. A server that keeps its database also saves the simulator's state after every change (debounced by 250 ms) and restores it on start, so a restart is safe. A hard kill within a quarter of a second of the last change can lose that change; the next checkout then fails once on a duplicate id and the one after it succeeds. The tests (`pnpm test`) and `pnpm eval` use an in-memory database and a fresh simulator and save nothing.

### 6.6 Final gates

Run in a copy of the tree made without `node_modules` or build output, with `pnpm install --frozen-lockfile`: typecheck, lint, `pnpm test` (every package, coverage thresholds), `pnpm eval`, vector regeneration (no change), `pnpm docs:check`, `pnpm secrets:check`, `pnpm e2e`. The results are in the README's status section.
