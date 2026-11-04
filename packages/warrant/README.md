# @warrant/warrant

The pure TypeScript core of [Warrant](../../README.md): the signed objects, the merchant checkout verifier (V01-V12), the dispute facts engine (F1-F13), the outcome table, the evidence packet, and the primitives they stand on (integer-cents money, RFC 8785 canonical JSON, Ed25519 JWS, a hash-chained ledger).

**It does no I/O.** No network, no database, no clock, no randomness inside `src/` except key generation. Time, registry data, catalog prices, the nonce store, PayPal data and the wallet's records are all arguments. ESLint enforces this (`eslint.config.js` forbids I/O imports, `fetch`, `process`, `console`, `Date.now`, `new Date()` and `Math.random` in `src/`).

**Version: Warrant 0.2** (the spec is [warrant-spec.md](../../docs/warrant-spec.md) v0.2; the consent binding and cumulative budget it added are designed in [implementation-notes.md](../../docs/implementation-notes.md) section 3). Bundles carry `"warrant_version": "0.2"`; 0.1 bundles are rejected.

Specifications this implements: [warrant-spec.md](../../docs/warrant-spec.md), [verification-rules.md](../../docs/verification-rules.md), [dispute-resolution.md](../../docs/dispute-resolution.md). Where those leave room, this package made a choice; every choice and every known gap is listed in [implementation-notes.md](../../docs/implementation-notes.md).

## Quickstart

This is `examples/quickstart.ts`. It is run by the test suite, and a test fails if this README stops showing exactly that file.

```ts
import {
  agentIssuer,
  buildCartBody,
  buildCartPayload,
  buildEvidencePacket,
  buildHumanPresentConsent,
  buildMandate,
  computeFacts,
  decideOutcome,
  generateSigningKey,
  hashCartBody,
  hashMandate,
  hashText,
  makeBundle,
  merchantAudience,
  paypalReferences,
  signCart,
  signConsent,
  signMandate,
  staticRegistry,
  verifyCheckout,
  verifyPayerBinding,
  type RegistryKey,
  type VerifyContext,
} from '@warrant/warrant';

/** Wallet, agent platform and merchant in one script: checkout verification, then a dispute. */
export async function quickstart() {
  const now = 1_793_000_700; // The package never reads a clock: you pass `now` (seconds since the epoch).
  const wallet = generateSigningKey();
  const agent = generateSigningKey();
  const listingHash = hashText('listing snapshot of c3_abc123');
  // The agent platform picks the cart warrant's jti and the merchant before the human consents; the consent signs both.
  const cartJti = 'crt_1';
  const aud = merchantAudience('MERCHANT1');

  // 1. The wallet signs a mandate: what the human allowed the agent to do. A cumulative budget covers all carts under it.
  const mandate = buildMandate({
    jti: 'mnd_1', iss: 'wallet:demo-wallet', iat: 1_793_000_000, nbf: 1_793_000_000, exp: 1_793_003_600,
    principalRef: 'prn_1', principalPayerIdHash: hashText('PAYER123'),
    agent: { platform: 'ap_demo', agentId: 'shopper-1', kid: 'ap_demo#1' },
    instructionText: 'Find a standing desk converter under $120',
    scope: { currency: 'USD', maxTotalCents: 12_000, maxPerItemCents: 12_000, maxItems: 2, categoriesAllow: null, merchantsAllow: ['*'], merchantsDeny: [], mode: 'human_present', budgetMode: 'cumulative' },
  });
  const signedMandate = await signMandate(mandate, wallet.privateKey, 'wallet-1');

  // 2. The human approves one cart on the consent screen; the wallet signs the consent over that cart, its jti and its merchant.
  const cartBody = buildCartBody('USD', [{ sku: 'c3_abc123', title: 'Desk converter 32in', qty: 1, unitPriceCents: 8_900, listingHash }]);
  const presentedHash = hashText('the exact consent screen the human saw');
  const approvedAt = '2026-10-26T07:44:10Z';
  const consent = await signConsent({ cartHash: hashCartBody(cartBody), cartJti, aud, presentedHash, approvedAt, mandateHash: hashMandate(mandate) }, wallet.privateKey, 'wallet-1');

  // 3. The agent platform signs the cart warrant and sends the bundle with its checkout request.
  const cart = buildCartPayload({
    jti: cartJti, iss: agentIssuer('ap_demo', 'shopper-1'), aud, iat: 1_793_000_600, exp: 1_793_001_500,
    nonce: 'n_0001', mandate: { jti: mandate.jti, hash: hashMandate(mandate) }, cart: cartBody,
    consent: buildHumanPresentConsent({ approvedAt, method: 'click', presentedHash, signature: consent.jws }),
  });
  const bundle = makeBundle(signedMandate.jws, (await signCart(cart, agent.privateKey, 'ap_demo#1')).jws);

  // 4. The merchant verifies V01-V10 and V12. Everything it needs is passed in; nothing is fetched.
  const registryKey = (kid: string, kind: 'wallet' | 'agent', owner: string, publicKey: RegistryKey['publicKey']): RegistryKey =>
    ({ kid, kind, owner, publicKey, status: 'active', validFrom: 1_700_000_000, validTo: null, statusChangedAt: null });
  const registry = staticRegistry([
    registryKey('wallet-1', 'wallet', 'wallet:demo-wallet', wallet.publicKey),
    registryKey('ap_demo#1', 'agent', 'ap_demo', agent.publicKey),
  ]);
  const seenNonces = new Set<string>();
  const seenJtis = new Set<string>();
  const context: VerifyContext = {
    now, merchantId: 'MERCHANT1', registry,
    nonceSeen: (nonce) => seenNonces.has(nonce),
    cartSeen: (jti) => seenJtis.has(jti), // a consent signs one jti, so a repeated jti is a replay
    catalog: (sku) => (sku === 'c3_abc123' ? { unitPriceCents: 8_900, currency: 'USD', available: true, category: 'office', listingHash } : null),
    walletRecord: ({ cartJti: jti }) => (jti === cartJti ? { presentedHash } : null),
    velocity: null,
    spentUnderMandate: () => ({ totalCents: 0, itemCount: 0 }), // nothing bought under this mandate yet; null would mean "unknown"
  };
  const verification = await verifyCheckout(bundle, context); // { outcome: 'ACCEPT', findings: [...], cartHash, mandateHash }
  if (verification.outcome === 'ACCEPT') {
    // Record nonce, jti and the spend together, atomically, in one transaction that locks the mandate.
    seenNonces.add(cart.nonce);
    seenJtis.add(cart.jti);
  }

  // 5. After the buyer approves the PayPal order, check that the paying account is the principal (V11).
  const payer = verifyPayerBinding(bundle, 'PAYER123');
  const references = paypalReferences(cart); // custom_id and invoice_id for the PayPal order

  // 6. Later the buyer disputes the payment. Facts come from code; a model only picks the claim type.
  const facts = await computeFacts({
    now: now + 3 * 86_400, bundle, merchantId: 'MERCHANT1', merchantMode: 'STRICT', registry,
    categoryOf: () => 'office', walletRecord: context.walletRecord, nonceUseCount: 1, jtiUseCount: 1,
    spentBefore: { totalCents: 0, itemCount: 0 },
    order: { id: 'ORDER1', currency: 'USD', totalCents: 8_900, payerId: 'PAYER123', lines: [{ sku: 'c3_abc123', quantity: 1, unitAmountCents: 8_900 }] },
    capture: { id: 'CAP1', amountCents: 8_900, currency: 'USD' },
    dispute: { id: 'PP-D-1', disputedAmountCents: 8_900, responseDueBy: now + 8 * 86_400 },
    tracking: { delivered: true, deliveredAt: now + 86_400, promisedBy: now + 3 * 86_400, trackingNumber: 'TRK1' },
    fulfilledListings: { c3_abc123: listingHash }, refunds: [], transparency: null,
  });
  const decision = decideOutcome('UNAUTHORIZED', facts); // { outcome: 'FIGHT', action: { type: 'provide-evidence' }, ... }
  const packet = buildEvidencePacket(facts, bundle); // deterministic JSON with a packet_hash

  return { verification, payer, references, decision, packet };
}
```

## Modules

| Module | What it gives you |
|---|---|
| `money` | Integer cents. `parseMoney("89.99") -> 8999` (strict: no sign, no exponent, no separators, at most two decimals), `formatMoney`, overflow-checked `addCents`, `mulCents`, `sumCents` |
| `canonical` | `canonicalize` (RFC 8785), `hashBytes` / `hashText` / `hashJson` (`sha256:` + base64url), `isHash` |
| `keys` | Ed25519 keys as Node `KeyObject`s: `generateSigningKey`, `importSigningKey`, `importVerificationKey`, `exportVerificationKey`, `publicKeyOf`, `generateKeyEnv` (what `pnpm keygen` prints) |
| `jws` | `signJws`, `decodeJws` (no signature check), `verifyJws`. Strict: see "Wire formats" |
| `ledger` | `appendEntry`, `verifyChain`, `computeEntryHash`, `GENESIS_HASH`: an append-only hash chain |
| `time` | `NumericDate` (whole seconds), `parseInstantSeconds`, `formatInstant`, the 60 s skew and 15 min cart limits |
| `schema` | Strict zod schemas and types for the mandate, cart warrant, consent payload and bundle |
| `registry` | `RegistryKey`, `RegistryLookup`, `keyStateAt`, `staticRegistry` |
| `warrant` | Builders and signers (`buildMandate`, `signMandate`, `signConsent`, `buildCartPayload`, `signCart`), `makeBundle`, `parseBundle`, `paypalReferences`, unverified `decode*` helpers |
| `verify` | `verifyCheckout` (V01-V10, V12), `verifyPayerBinding` (V11) |
| `facts` | `computeFacts` (F1-F13) |
| `outcome` | `decideOutcome(claimType, facts)` |
| `evidence` | `buildEvidencePacket(facts, bundle)` |

Everything is exported from the package root (`import { ... } from '@warrant/warrant'`).

## Wire formats

| Thing | Format |
|---|---|
| Hash | `sha256:` followed by the unpadded base64url SHA-256 digest (43 characters). JSON is hashed over its RFC 8785 canonical form |
| Signature | JWS compact serialization, `alg` `EdDSA` (Ed25519). The protected header is exactly `{"alg":"EdDSA","kid":"<registered key id>"}`. The payload is the canonical JSON of the document |
| Private key | Base64 PKCS#8 DER, 64 characters (the last 32 bytes are the seed). This is what `pnpm keygen` prints |
| Public key | Base64 SPKI DER, 60 characters |
| Money in documents | Decimal strings such as `"89.00"`: no sign, no exponent, at most two decimals |
| Money in code | Integer cents (`number`, safe integers only) |
| Time | JWT claims are `NumericDate` integer seconds. `consent.approved_at` is an ISO 8601 UTC instant (`2026-11-04T10:00:00Z`). `now` arguments are `NumericDate` seconds |
| Consent signature | A JWS by the wallet over `{ "typ": "consent", "cart_hash", "cart_jti", "aud", "presented_hash", "approved_at", "mandate_hash" }`. `cart_jti` and `aud` bind the consent to one cart warrant and one merchant, so it can be spent once. The agent platform picks the `jti` and merchant when it proposes the cart; the wallet signs them |

What each hash covers:

| Hash | Covers |
|---|---|
| `mandate.hash` | The canonical mandate **payload** (not the compact JWS string) |
| `cart_hash` | The canonical `{ currency, items, total }` object only |
| Cart warrant hash | The whole canonical cart payload. This is what the transparency log records |
| `invoice_id` | `WRT-` plus the first 16 characters of the `cart_hash` digest; `custom_id` is `wrt:<cart jti>` |
| Payer id hash | `hashText(payer.payer_id)` |

`decodeJws` and `verifyJws` reject anything that is not exactly one canonical encoding: three base64url segments with no padding, a header of exactly `alg` and `kid`, and a payload that is UTF-8 JSON that can be canonicalized. In particular a signature cannot be re-encoded into a different but equivalent string (jose itself accepts that), so any single-character change to a JWS is detected.

## Verifying a checkout

`verifyCheckout(bundle, context)` is deterministic. Every rule always runs and reports; the outcome is `REJECT` if any finding rejects, otherwise `REVIEW` if any asks for review, otherwise `ACCEPT`.

| `VerifyContext` field | Meaning |
|---|---|
| `now` | Current time, `NumericDate` seconds |
| `merchantId` | This merchant's id. A warrant's `aud` must be `paypal-merchant:<merchantId>` |
| `registry` | `(kid) => RegistryKey \| null` |
| `nonceSeen` | `(nonce) => boolean`. Verification does **not** consume the nonce: record it atomically (insert-if-absent) after you accept |
| `cartSeen` | `(jti) => boolean`: has this merchant seen the cart warrant `jti`? Record the jti with the nonce, in the same transaction. A consent signs one jti, so a repeated jti is a replayed consent |
| `catalog` | `(sku) => { unitPriceCents, currency, available, category, listingHash? } \| null`, from the merchant's own catalog |
| `walletRecord` | `({ cartJti, cartHash }) => { presentedHash } \| null`: what the wallet recorded when it showed that cart to the human, looked up by cart warrant `jti` |
| `velocity` | `{ windowSeconds, maxPerPrincipal, maxPerPlatform, count(query) }`, or `null` to disable V12 |
| `spentUnderMandate` | Optional. `(mandateJti) => { totalCents, itemCount } \| null`: what was already bought under this mandate, excluding the cart being verified. `null` means unknown. For a `cumulative` mandate, absent or `null` makes V09 ask for review. Read it, verify and record the reservation in one transaction that locks the mandate |
| `skewSeconds` | Optional. Default and maximum 60 |

| Rule | What this implementation checks | On failure |
|---|---|---|
| V01 `SIGNATURE` | Cart and mandate signatures verify against the registry key named by their `kid`; the consent signature verifies and covers `cart_hash`, `cart_jti`, `aud`, `presented_hash`, `approved_at` and the mandate hash; a `human_present` cart without a consent signature fails | reject |
| V02 `KEY_STATUS` | Each key is in the registry, of the right kind, owned by the claimed issuer, and `active` both now and when the signed object was issued | reject |
| V03 `FRESHNESS` | Now is inside the mandate's `[nbf, exp]` and the cart's `[iat, exp]` with the skew; the cart lives at most 900 s; `nbf <= exp`, `iat < exp`; the cart's `iat` falls inside the mandate's `[nbf, exp]` (with the skew); the mandate's `iat <= nbf` | reject |
| V04 `AUDIENCE` | `aud` is exactly `paypal-merchant:<merchantId>` | reject |
| V05 `NONCE` | `nonceSeen(nonce)` is false **and** `cartSeen(jti)` is false (two findings) | reject |
| V06 `MANDATE_BINDING` | `cart.mandate.hash` and `.jti` match the presented mandate; `iss` is `agent:<platform>/<agent_id>` from the mandate; the cart's `kid` is the mandate's `agent.kid`; `instruction.hash` is `hashText(instruction.text)` | reject |
| V07 `CART_HASH` | `cart_hash` is the hash of the canonical cart object; the lines sum to `cart.total` | reject |
| V08 `REPRICE` | For every line the catalog knows the SKU, has the same currency and unit price, has it available, and (when it has one) the same listing hash; the catalog total equals `cart.total` | reject |
| V09 `SCOPE` | Currency, total, per-item unit price, item count (sum of quantities), categories and merchant allow/deny rules from the mandate. With `scope.budget_mode` `"cumulative"`, `max_total` and `max_items` are totals over the mandate's life: `spent + this cart` must fit, and unknown spend is a review. With `"per_cart"` they apply to each cart | reject / review |
| V10 `CONSENT` | `human_present`: all consent fields present and `presented_hash` equals the wallet's record for this cart `jti`. `human_not_present`: the mandate's `scope.mode` allows it | reject |
| V11 `PAYER_BINDING` | `verifyPayerBinding(bundle, payerId)`: payer hash equals the mandate's principal hash; no hash yet means `REVIEW` (first use) and you record `payerIdHash` | reject / review |
| V12 `VELOCITY` | Prior warrants in the window are below the limit for the principal and for the agent platform | review |

A malformed bundle returns `REJECT` with a single V01 finding and `null` hashes. `verifyPayerBinding` reads the mandate **without** checking its signature, so call it only for a bundle `verifyCheckout` did not reject.

## Registry data

```ts
interface RegistryKey {
  kid: string;
  kind: 'wallet' | 'agent';
  owner: string;            // agent: the platform id; wallet: the mandate `iss`, e.g. "wallet:demo-wallet"
  publicKey: KeyObject;
  status: 'active' | 'suspended' | 'revoked';
  validFrom: NumericDate;
  validTo: NumericDate | null;
  statusChangedAt: NumericDate | null;   // when it left `active`
}
```

`keyStateAt(key, t)` answers what the registry's history says about moment `t` (`active`, `suspended`, `revoked`, `not_yet_valid`, `expired`). A key revoked later is still valid for evidence issued before the revocation.

## Disputes

1. `computeFacts(input)` builds F1-F13 from the stored bundle, the registry, the PayPal order, capture, dispute, tracking and refunds (money already in integer cents), the merchant mode, the nonce and jti use counts, the spend recorded under the mandate when the cart was accepted, the fulfilled listings and the transparency-log record. Each fact has a `value`, an `evidence` list (ids, hashes, timestamps) and sometimes a `detail`.
2. A model may map the buyer's text to one of `UNAUTHORIZED`, `NOT_RECEIVED`, `NOT_AS_DESCRIBED`, `WRONG_AMOUNT`, `DUPLICATE`, `OTHER`. That is all it decides.
3. `decideOutcome(claim, facts)` is total and deterministic. It returns the outcome, the matched rule, the proposed PayPal action (and alternatives), a confidence, a categorical attribution (`primary`, `contributing`, `none`, `unknown`) for the agent platform, the merchant and the principal, the facts it used, and flags. Rows the table does not cover resolve to `ESCALATE_TO_HUMAN` with a `table_gap` flag. Free text in the facts can never change the decision.
4. `buildEvidencePacket(facts, bundle)` returns deterministic JSON (the consented cart, signature results, key status, transparency-log record, payer binding, tracking, listing snapshot, all facts) with a `packet_hash`. It contains no timestamps of its own.

The proposed action must still be checked against the dispute's `allowed_response_options` by the caller; money-moving actions are proposals.

## Ledger and transparency log

`appendEntry(previous, { chainId, type, payload })` returns a frozen entry whose hash is `SHA-256(prevHash || canonical({ chainId, seq, type, payload }))`. `verifyChain(entries, options)` recomputes the chain from untrusted input and reports the first broken `seq` and a reason. A chain alone cannot show that its tail was not cut off or that it was not rewritten consistently from some point; pass a trusted head hash as `expectedHeadHash` for that.

## Keys

```bash
pnpm keygen        # NAME=value lines for WALLET_SIGNING_KEY, AGENT_PLATFORM_SIGNING_KEY and REGISTRY_LOG_KEY
pnpm -s keygen     # the same without pnpm's banner
```

The public keys are printed on stderr. Private keys are secrets: keep them in an untracked `.env`.

## Errors

Decoding and verification never throw for bad input; they return `{ ok: false, error }` or a `REJECT` result. Builders and signers throw typed errors for programmer mistakes: `WarrantError` (invalid document), `KeyError`, `JwsError`, `MoneyError`, `CanonicalJsonError`, `LedgerError`.

## Tests

```bash
pnpm --filter @warrant/warrant test      # unit + property tests with a coverage gate (90% lines)
pnpm --filter @warrant/warrant vectors   # regenerate docs/test-vectors.json
```

- Every verifier rule has a passing and a failing test, and the adversarial list from `verification-rules.md` is covered.
- Property tests: any single-character change to a JWS or to a serialized bundle is never accepted, any single-byte change to a serialized ledger is detected, `decideOutcome` is total and deterministic.
- [docs/test-vectors.json](../../docs/test-vectors.json) holds deterministic vectors (fixed test keys, hashes, a signed honest warrant, checkout cases for every rule, payer binding, the outcome table, a ledger). A test fails if the file drifts from the code, and another replays the file with nothing but its own JSON, so another implementation can use it to check itself.

## Changing a rule

Follow [CONTRIBUTING.md](../../CONTRIBUTING.md): add the rule to `src/verify.ts` (or the fact to `src/facts.ts`), add a passing and a failing test, add a case to `test/vectors.ts` and regenerate `docs/test-vectors.json`, and update `docs/verification-rules.md` and [implementation-notes.md](../../docs/implementation-notes.md) if behaviour changes.
