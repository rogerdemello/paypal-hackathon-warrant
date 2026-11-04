import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalize, hashBytes, hashJson, hashText } from '../src/canonical';
import { computeFacts } from '../src/facts';
import { importSigningKey, importVerificationKey, publicKeyOf } from '../src/keys';
import { GENESIS_HASH, verifyChain } from '../src/ledger';
import { parseMoney, tryParseMoney } from '../src/money';
import { decideOutcome, type ClaimType } from '../src/outcome';
import { combine, hashPayerId, verifyCheckout, verifyPayerBinding } from '../src/verify';
import { signCart, signConsent, signMandate } from '../src/warrant';
import { mkFacts } from './factsBuilder';
import { KIDS } from './fixtures';
import {
  contextFromJson,
  factsInputFromJson,
  type FactsVector,
  serializeVectors,
  type HashVectors,
  type LedgerVector,
  type OutcomeVector,
  type PayerVector,
  type VerifyVector,
} from './vectors';

const FILE = new URL('../../../docs/test-vectors.json', import.meta.url);
const HINT = 'docs/test-vectors.json is missing or stale. Regenerate it with: pnpm --filter @warrant/warrant vectors';

function load(): Record<string, any> {
  try {
    return JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, any>;
  } catch {
    throw new Error(HINT);
  }
}

function loadVerifyVectors(): VerifyVector[] {
  try {
    return load()['verify'] as VerifyVector[];
  } catch {
    return [];
  }
}

describe('docs/test-vectors.json', () => {
  it('is exactly what the code generates today', async () => {
    const committed = readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n');
    expect(committed, HINT).toBe(await serializeVectors());
  });

  it('is deterministic: generating twice gives identical bytes', async () => {
    expect(await serializeVectors()).toBe(await serializeVectors());
  });

  it('hashing and money vectors reproduce', () => {
    const h = load()['hashing'] as HashVectors;
    expect(h.genesis_hash).toBe(GENESIS_HASH);
    for (const t of h.text) expect(hashText(t.input)).toBe(t.hash);
    for (const c of h.canonical_json) {
      expect(canonicalize(c.input)).toBe(c.canonical);
      expect(hashJson(c.input)).toBe(c.hash);
      expect(hashBytes(c.canonical)).toBe(c.hash);
    }
    for (const m of h.money.valid) expect(parseMoney(m.decimal)).toBe(m.cents);
    for (const bad of h.money.invalid) expect(tryParseMoney(bad)).toBeNull();
  });

  it('the published test keys re-create the honest warrant byte for byte', async () => {
    const f = load();
    const wallet = importSigningKey(f['keys'].wallet.private_key_pkcs8_b64 as string);
    const agent = importSigningKey(f['keys'].agent.private_key_pkcs8_b64 as string);
    expect(Buffer.from(f['keys'].wallet.private_key_pkcs8_b64 as string, 'base64').subarray(16).toString('hex')).toBe(f['keys'].wallet.test_only_seed_hex);
    expect(publicKeyOf(wallet).export({ format: 'der', type: 'spki' }).toString('base64')).toBe(f['keys'].wallet.public_key_spki_b64);
    const honest = f['honest'];
    expect((await signMandate(honest.mandate.payload, wallet, KIDS.wallet)).jws).toBe(honest.mandate.jws);
    expect((await signCart(honest.cart.payload, agent, KIDS.agent)).jws).toBe(honest.cart.jws);
    const covers = honest.consent.covers;
    const consent = await signConsent(
      { cartHash: covers.cart_hash, cartJti: covers.cart_jti, aud: covers.aud, presentedHash: covers.presented_hash, approvedAt: covers.approved_at, mandateHash: covers.mandate_hash },
      wallet,
      KIDS.wallet,
    );
    expect(consent.jws).toBe(honest.consent.jws);
    expect(honest.bundle).toEqual({ warrant_version: '0.2', mandate: honest.mandate.jws, cart: honest.cart.jws });
    expect(honest.paypal_references.customId).toBe('wrt:crt_01JEXAMPLE');
    expect(honest.paypal_references.invoiceId).toBe(`WRT-${(honest.cart_hash as string).slice(7, 23)}`);
    expect(importVerificationKey(f['keys'].agent.public_key_spki_b64 as string).asymmetricKeyType).toBe('ed25519');
  });

  it('covers every verifier rule with a failing case, a review case and several passing cases', () => {
    const vectors = loadVerifyVectors();
    const rejected = new Set(vectors.flatMap((v) => v.expected.reject));
    for (const rule of ['V01_SIGNATURE', 'V02_KEY_STATUS', 'V03_FRESHNESS', 'V04_AUDIENCE', 'V05_NONCE', 'V06_MANDATE_BINDING', 'V07_CART_HASH', 'V08_REPRICE', 'V09_SCOPE', 'V10_CONSENT']) {
      expect(rejected.has(rule), `no failing vector for ${rule}`).toBe(true);
    }
    expect(vectors.some((v) => v.expected.review.includes('V12_VELOCITY'))).toBe(true);
    expect(vectors.filter((v) => v.expected.outcome === 'ACCEPT').length).toBeGreaterThanOrEqual(3);
  });

  it.each(loadVerifyVectors().map((v) => [v.name, v] as const))('verify vector %s', async (_name, v) => {
    const result = await verifyCheckout(v.bundle, contextFromJson(v.context));
    const reject = [...new Set(result.findings.filter((f) => f.outcome === 'reject').map((f) => f.rule))].sort();
    const review = [...new Set(result.findings.filter((f) => f.outcome === 'review').map((f) => f.rule))].sort();
    expect({ outcome: result.outcome, reject, review }).toEqual(v.expected);
    expect(combine(result.findings)).toBe(v.expected.outcome);
  });

  it('payer binding vectors reproduce', () => {
    for (const p of load()['payer_binding'] as PayerVector[]) {
      const result = verifyPayerBinding(p.bundle, p.payer_id);
      expect([p.name, result.outcome, result.firstUse, result.payerIdHash]).toEqual([p.name, p.expected, p.first_use, p.payer_id_hash]);
      expect(hashPayerId(p.payer_id)).toBe(p.payer_id_hash);
    }
  });

  it('facts vectors reproduce from their own JSON (bundle, registry, wallet records and inputs)', async () => {
    const list = load()['facts'] as FactsVector[];
    expect(list.length).toBeGreaterThanOrEqual(7);
    for (const v of list) {
      const facts = await computeFacts(factsInputFromJson(v));
      const actual = Object.fromEntries((['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'F13'] as const).map((id) => [id, facts[id].value]));
      expect({ name: v.name, ...actual }).toEqual({ name: v.name, ...v.expected });
      if (v.expected_f6_cumulative_checked !== undefined) {
        expect([v.name, facts.F6.detail?.['cumulativeChecked']]).toEqual([v.name, v.expected_f6_cumulative_checked]);
      }
    }
  });

  it('includes a vector for every Warrant 0.2 case (G1 and G2)', () => {
    const names = new Set(loadVerifyVectors().map((v) => v.name));
    for (const name of [
      'v01-consent-reused-for-identical-cart-new-jti',
      'v01-consent-for-other-merchant',
      'v01-consent-from-0-1-bundle',
      'v05-replayed-jti-fresh-nonce',
      'v10-wallet-record-for-other-jti',
      'v09-cumulative-total-exceeded',
      'v09-cumulative-items-exceeded',
      'v09-cumulative-exactly-at-limit',
      'v09-cumulative-spend-unknown',
      'v09-cumulative-not-configured',
      'v09-per-cart-ignores-spend',
    ]) {
      expect(names.has(name), `missing vector ${name}`).toBe(true);
    }
  });

  it('outcome table vectors reproduce', () => {
    const table = load()['outcome_table'];
    for (const o of table.vectors as OutcomeVector[]) {
      const d = decideOutcome(o.claim as ClaimType, mkFacts(o.facts));
      expect({ name: o.name, outcome: d.outcome, rule: d.rule, action: d.action.type, confidence: d.confidence, attribution: d.attribution }).toEqual({
        name: o.name,
        ...o.expected,
      });
    }
    expect((table.vectors as OutcomeVector[]).length).toBeGreaterThanOrEqual(25);
  });

  it('ledger vectors reproduce', () => {
    const l = load()['ledger'] as LedgerVector;
    expect(verifyChain(l.entries, { chainId: l.chain_id })).toMatchObject({ ok: true, length: 3, headHash: l.head_hash });
    expect(l.entries[0]?.prevHash).toBe(GENESIS_HASH);
    expect(verifyChain(l.tampered.entries)).toMatchObject({ ok: false, brokenSeq: l.tampered.expected_broken_seq, reason: l.tampered.expected_reason });
  });
});
