# Warrant specification (v0.2, draft)

A **Warrant** is a small, signed record of what a human authorised an AI agent to buy, bound to a specific cart and to the PayPal order that paid for it. A merchant verifies it at checkout. If a dispute is opened later, it becomes evidence.

This is a hackathon-stage draft. It is meant to be read, criticised and implemented, not treated as a standard.

## 1. Goals and non-goals

**Goals**
1. Let a merchant (and PayPal) check, in milliseconds and offline from the agent, that a named agent platform was acting within limits a real principal set, and that the principal saw and approved *this* cart.
2. Make that proof available as structured evidence when a payment is disputed.
3. Be small enough to implement in a day, and able to wrap richer credentials (AP2 mandates, Mastercard Verifiable Intent) rather than compete with them.

**Non-goals**
- Not a payment protocol. Money still moves through PayPal Orders and Payments.
- Not a legal liability rule. Warrant produces *evidence and a recommendation*; who pays is decided by PayPal's policies, card-network rules and law.
- Not agent behaviour control. Spending limits on the buyer side are a separate concern; the mandate's scope is evidence of what was allowed, and enforcing it before signing is the wallet's job.

## 2. Roles

| Role | Description | Holds |
|---|---|---|
| **Principal** | The human buyer with a PayPal account | Nothing directly; acts through a wallet |
| **Wallet** | App that shows the consent screen and signs on the principal's behalf | Principal signing key (demo: server-held; production: device-bound passkey) |
| **Agent platform** | The company or app running the shopping agent | Agent signing key, registered in the registry |
| **Merchant** | Seller, receives the PayPal payment | Verifier, order records |
| **Registry** | Directory of agent platforms and wallet keys, with status | Public keys, key status, a transparency log |
| **PayPal** | Payment and dispute system | Orders, captures, disputes |

## 3. Objects

A **Warrant bundle** is JSON with two compact JWS strings:

```json
{ "warrant_version": "0.2", "mandate": "<JWS>", "cart": "<JWS>" }
```

### 3.1 Mandate (signed by the wallet, on behalf of the principal)

What the human allowed the agent to do.

| Field | Type | Meaning |
|---|---|---|
| `typ` | `"mandate"` | Domain separation |
| `jti` | string | Unique id (`mnd_...`) |
| `iss` | string | Wallet identifier |
| `iat`, `nbf`, `exp` | NumericDate | Validity window |
| `principal.ref` | string | Opaque principal id |
| `principal.paypal_payer_id_hash` | `sha256:` string, optional | Hash of the principal's PayPal payer id, once linked |
| `agent.platform`, `agent.agent_id`, `agent.kid` | strings | Which agent may use this mandate |
| `instruction.text`, `instruction.hash` | string | The human's request in their own words. `instruction.hash` is the SHA-256 hash (section 4 format) of the UTF-8 bytes of `instruction.text`, with no normalisation |
| `scope.currency` | string | ISO 4217 |
| `scope.max_total`, `scope.max_per_item` | decimal string | Spend limits |
| `scope.max_items` | integer | Item count limit |
| `scope.categories_allow` | array or null | Allowed categories |
| `scope.merchants_allow`, `scope.merchants_deny` | arrays | Merchant rules (`*` allowed) |
| `scope.mode` | `human_present` or `human_not_present` | Whether each cart needs fresh consent |
| `scope.budget_mode` | `cumulative` or `per_cart` | `cumulative`: `max_total` and `max_items` are totals over the life of the mandate, counting every cart under it that the verifier is told about. `per_cart`: they apply to each cart separately. `max_per_item` is the limit for one unit in both modes |

### 3.2 Cart warrant (signed by the agent platform)

What the agent is buying right now.

| Field | Type | Meaning |
|---|---|---|
| `typ` | `"cart"` | Domain separation |
| `jti` | string | Unique id (`crt_...`) |
| `iss` | string | `agent:<platform>/<agent_id>` |
| `aud` | string | `paypal-merchant:<merchant id>`. Binds the warrant to one merchant |
| `iat`, `exp` | NumericDate | Short validity (default 15 minutes) |
| `nonce` | string | One-time value; the merchant rejects reuse |
| `mandate.jti`, `mandate.hash` | strings | Which mandate this cart relies on |
| `cart.currency` | string | ISO 4217 |
| `cart.items[]` | array | `sku`, `title`, `qty`, `unit_price`, `listing_hash` |
| `cart.total` | decimal string | Must equal the sum of lines |
| `cart_hash` | `sha256:` string | Hash of the canonical cart object |
| `consent` | object | See below |

### 3.3 Consent (inside the cart warrant)

| Field | Meaning |
|---|---|
| `mode` | `human_present` or `human_not_present` |
| `approved_at` | When the principal approved (ISO 8601 UTC) |
| `method` | `click` (demo) or `passkey` (production) |
| `presented_hash` | Hash of the exact cart screen the principal saw |
| `signature` | JWS by the wallet/principal key over `{ typ: "consent", cart_hash, cart_jti, aud, presented_hash, approved_at, mandate_hash }` |

`cart_jti` and `aud` MUST equal the `jti` and `aud` of the cart warrant that carries this consent. The agent platform chooses the `jti` and the merchant when it proposes the cart; the wallet signs them. A consent therefore covers exactly one cart warrant at one merchant, and it is spent when that `jti` is first accepted.

The consent signature is the key idea: **the agent cannot produce it**, and it covers one specific cart hash. If the agent later shows the merchant a different cart than the principal approved, the hashes disagree and the signature does not cover it.

## 4. Encoding rules

- **Signatures:** JWS compact serialisation, `alg: EdDSA` (Ed25519), `kid` header naming a registered key.
- **Canonical JSON:** RFC 8785 (JCS) before hashing.
- **Hash format:** `sha256:` followed by base64url of the SHA-256 digest.
- **What is hashed:** `mandate.hash` is the hash of the canonical mandate payload (not of the compact JWS). `cart_hash` is the hash of the canonical object `{ currency, items, total }`. A cart warrant hash (for the transparency log) is the hash of the whole canonical cart payload. The payer id hash is the hash of the UTF-8 bytes of `payer.payer_id`. NumericDate claims are integers.
- **Money:** decimal strings in documents, integer minor units in code.
- **Time:** NumericDate for JWT claims, ISO 8601 UTC for descriptive fields. Allow 60 seconds of clock skew.

## 5. Binding to PayPal

| Warrant field | Where it appears in PayPal |
|---|---|
| `cart.jti` | Order `purchase_units[0].custom_id` as `wrt:<jti>` |
| `cart_hash` | Order `purchase_units[0].invoice_id` as `WRT-<first 16 chars of hash>` |
| `aud` | The order's payee (the merchant's PayPal merchant id) |
| `principal.paypal_payer_id_hash` | Compared with the hash of `payer.payer_id` returned after the buyer approves the order |
| Capture id | Stored by the merchant against the warrant, so a dispute's `seller_transaction_id` maps back to it |

Only references go into PayPal fields. The merchant stores the full bundle and exposes a **public verification page** (`/v/<cart jti>`) so a PayPal analyst can check it independently.

**Payer binding.** The first time a principal pays, the wallet learns the payer id from the approved order and records its hash (trust on first use). Later mandates carry the hash and the merchant compares it. A stronger link (Log in with PayPal) is listed as future work; verify availability in the sandbox before claiming it.

## 6. Lifecycle

1. The principal states a goal. The wallet creates and signs a **mandate**.
2. The agent finds a product and proposes a cart together with the `jti` and merchant it will use. The wallet shows the **consent screen** (including the merchant) and signs the consent over them if the principal approves.
3. The agent platform signs the **cart warrant** and sends the bundle with its checkout request.
4. The merchant **verifies** (see [verification-rules.md](verification-rules.md)), creates the PayPal order with the references, and the principal approves it in PayPal.
5. The merchant captures, stores the bundle and capture id, and the wallet appends the cart warrant hash to the registry's **transparency log**, so a warrant cannot be backdated or quietly dropped.
6. If a dispute arrives, the dispute agent rebuilds the facts from the warrant and PayPal data (see [dispute-resolution.md](dispute-resolution.md)).

## 7. Registry (a "Know Your Agent" lite)

A neutral service that, in production, only a party like PayPal could credibly run. The prototype implements:

- `GET /registry/jwks.json`: public keys with `kid`, `alg`, `status` (`active`, `suspended`, `revoked`), `valid_from`, `valid_to`.
- `GET /registry/platforms/{id}`: name, status, keys, and outcome statistics (orders, disputes, agent-fault rulings).
- An append-only, hash-chained **transparency log** of issued warrant hashes with inclusion proofs.

## 8. Relationship to other work

| Work | Relationship |
|---|---|
| **AP2** (Google, with PayPal as a launch partner) | AP2 uses signed Intent, Cart and Payment mandates. Warrant's mandate/cart split mirrors that shape. Warrant adds the PayPal binding, merchant verification and dispute use. An adapter could embed an AP2 mandate as `mandate`. Warrant does **not** claim AP2 compliance. |
| **Mastercard Verifiable Intent** (draft v0.1, SD-JWT delegation chain: issuer identity, user intent constraints, agent action) | Same family of idea. An adapter could carry a Verifiable Intent chain as the mandate layer. Its published page does not describe a dispute process; Warrant's contribution is the dispute side on PayPal rails. |
| **Visa Trusted Agent Protocol** | Agent identity for merchants. Compatible in spirit with the registry. Not implemented. |

## 9. Privacy

- The payer id appears only as a hash.
- The instruction text and cart are visible to the merchant by necessity. A production version should use selective disclosure (for example SD-JWT) so the merchant sees only what it needs.
- The registry's statistics are aggregate counts, not purchase contents.

## 10. Example (illustrative, signatures abbreviated)

```json
{
  "warrant_version": "0.2",
  "mandate": "eyJhbGciOiJFZERTQSIsImtpZCI6IndhbGxldC0yMDI2LTEwIn0.<payload>.<sig>",
  "cart": "eyJhbGciOiJFZERTQSIsImtpZCI6ImFwX2RlbW9fc2hvcHBlciMyMDI2LTEwIn0.<payload>.<sig>"
}
```

Decoded mandate payload:

```json
{
  "typ": "mandate",
  "jti": "mnd_01JEXAMPLE",
  "iss": "wallet:demo-wallet",
  "iat": 1793000000, "nbf": 1793000000, "exp": 1793003600,
  "principal": { "ref": "prn_01JEXAMPLE", "paypal_payer_id_hash": "sha256:Zm9v..." },
  "agent": { "platform": "ap_demo_shopper", "agent_id": "shopper-1", "kid": "ap_demo_shopper#2026-10" },
  "instruction": { "text": "Find a standing desk converter under $120", "hash": "sha256:YmFy..." },
  "scope": {
    "currency": "USD", "max_total": "120.00", "max_per_item": "120.00", "max_items": 2,
    "categories_allow": null, "merchants_allow": ["*"], "merchants_deny": [],
    "mode": "human_present", "budget_mode": "cumulative"
  }
}
```

Decoded cart payload:

```json
{
  "typ": "cart",
  "jti": "crt_01JEXAMPLE",
  "iss": "agent:ap_demo_shopper/shopper-1",
  "aud": "paypal-merchant:DEMOMERCHANTID",
  "iat": 1793000600, "exp": 1793001500,
  "nonce": "n_7f3a...",
  "mandate": { "jti": "mnd_01JEXAMPLE", "hash": "sha256:..." },
  "cart": {
    "currency": "USD",
    "items": [{ "sku": "c3_abc123", "title": "Desk converter 32in", "qty": 1, "unit_price": "89.00", "listing_hash": "sha256:..." }],
    "total": "89.00"
  },
  "cart_hash": "sha256:...",
  "consent": {
    "mode": "human_present",
    "approved_at": "2026-11-04T10:00:00Z",
    "method": "click",
    "presented_hash": "sha256:...",
    "signature": "<JWS over cart_hash, cart_jti, aud, presented_hash, approved_at, mandate_hash>"
  }
}
```

## 11. Open questions

1. Who runs the registry in production, and what does "attested" mean for an agent platform?
2. Can PayPal accept a warrant by reference on Orders, or should it be an attachment?
3. Which party is liable when a valid warrant matches the cart but the human still says "I never wanted it"? (Policy, not cryptography.)
4. How to rotate and revoke keys without invalidating past evidence (the transparency log timestamps help).
5. Passkey-based consent signing on mobile.
