import { describe, expect, it } from 'vitest';
import { buildEvidencePacket } from '../src/evidence';
import { computeFacts } from '../src/facts';
import { GENESIS_HASH, appendEntry, verifyChain } from '../src/ledger';
import type { CartPayload } from '../src/schema';
import { scopeProblems, verifyCheckout, type VerifyContext } from '../src/verify';
import { SKU, factsInput, makeWorld } from './fixtures';

/**
 * The verifier takes functions from the caller (registry, catalog, nonce store, wallet record, velocity). If one of them
 * throws, the checkout must be rejected with a finding that says so: never an exception, never an accept.
 */
describe('verifyCheckout fails closed when an injected function throws', () => {
  const boom = (): never => {
    throw new Error('backend unavailable');
  };

  it.each<[string, (ctx: VerifyContext) => Partial<VerifyContext>, string[]]>([
    ['the catalog', () => ({ catalog: boom }), ['V08_REPRICE']],
    ['the nonce store', () => ({ nonceSeen: boom }), ['V05_NONCE']],
    ['the wallet record', () => ({ walletRecord: boom }), ['V10_CONSENT']],
    ['the registry', () => ({ registry: boom }), ['V01_SIGNATURE', 'V02_KEY_STATUS']],
  ])('%s', async (_name, patch, rules) => {
    const w = await makeWorld();
    const result = await verifyCheckout(w.bundle, { ...w.ctx, ...patch(w.ctx) });
    expect(result.outcome).toBe('REJECT');
    for (const rule of rules) {
      expect(result.findings.some((f) => f.rule === rule && f.outcome === 'reject' && f.detail.includes('rule failed to evaluate: backend unavailable'))).toBe(true);
    }
  });

  it('the velocity counter', async () => {
    const w = await makeWorld();
    const velocity = { windowSeconds: 60, maxPerPrincipal: 1, maxPerPlatform: 1, count: boom };
    const result = await verifyCheckout(w.bundle, { ...w.ctx, velocity });
    expect(result.outcome).toBe('REJECT');
    expect(result.findings.some((f) => f.rule === 'V12_VELOCITY' && f.outcome === 'reject')).toBe(true);
  });

  it('a non-Error throw is still reported', async () => {
    const w = await makeWorld();
    const result = await verifyCheckout(w.bundle, {
      ...w.ctx,
      nonceSeen: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- the point of the test is a non-Error throw
        throw 'a string';
      },
    });
    expect(result.findings.some((f) => f.rule === 'V05_NONCE' && f.detail.includes('unknown error'))).toBe(true);
  });
});

describe('scopeProblems on a mandate with unusable amounts', () => {
  it('reports it instead of comparing against garbage', async () => {
    const w = await makeWorld();
    const broken = { ...w.mandate, scope: { ...w.mandate.scope, max_total: 'abc', max_per_item: '1.005' } };
    expect(scopeProblems(broken, w.cart, 'DEMOMERCHANTID', () => null)).toContain('mandate scope amounts are not valid');
  });
});

describe('facts and evidence with unusual stored data', () => {
  it('an undecodable consent signature makes F4 and F2 false and is named in the evidence', async () => {
    const w = await makeWorld();
    const cart: CartPayload = { ...w.cart, consent: { ...w.cart.consent, signature: 'not.a.jws' } };
    const facts = await computeFacts(factsInput(w, { bundle: await w.resign({ cart }) }));
    expect(facts.F2.value).toBe(false);
    expect(facts.F4.value).toBe(false);
    expect(facts.F4.evidence).toContain('problem:consent does not cover consent_undecodable');
    expect(facts.F5.value).toBe(false);
  });

  it('the packet for a human_not_present warrant shows empty consent fields as null', async () => {
    const w = await makeWorld({ scopeMode: 'human_not_present', scope: { categoriesAllow: ['office_furniture'] } });
    const facts = await computeFacts(factsInput(w));
    const packet = buildEvidencePacket(facts, w.bundle);
    expect(packet['consented_cart']).toMatchObject({ consent: { mode: 'human_not_present', approved_at: null, method: null, presented_hash: null } });
    expect(packet['mandate']).toMatchObject({ scope: { categories_allow: ['office_furniture'], mode: 'human_not_present' } });
    expect(packet['signatures']).toMatchObject({ all_valid: true, consent: true });
  });

  it('the packet records both the claimed and the recomputed cart hash', async () => {
    const w = await makeWorld();
    const wrongHash: CartPayload = { ...w.cart, cart_hash: w.mandateHash };
    const bundle = await w.resign({ cart: wrongHash });
    const facts = await computeFacts(factsInput(w, { bundle }));
    const packet = buildEvidencePacket(facts, bundle);
    expect(packet['warrant']).toMatchObject({ cart_hash: w.mandateHash, presented_cart_hash: w.cartHash });
    expect(facts.F4.value).toBe(false);
  });

  it('without an order, F5 and F7 have no detail and the packet still builds', async () => {
    const w = await makeWorld();
    const facts = await computeFacts(factsInput(w, { order: null, tracking: null }));
    const packet = buildEvidencePacket(facts, w.bundle);
    expect(packet['order_matches_consent']).toMatchObject({ value: false });
    expect((packet['order_matches_consent'] as Record<string, unknown>)['detail']).toBeUndefined();
    expect(packet['order_id']).toBeNull();
  });
});

describe('verifyChain input hygiene', () => {
  const good = appendEntry(null, { chainId: 'c', type: 'T', payload: { a: 1 } });

  it.each([
    ['an empty chainId', { ...good, chainId: '' }],
    ['an empty type', { ...good, type: '' }],
    ['a payload that is not JSON', { ...good, payload: undefined }],
    ['an array instead of an entry', [good]],
    ['an unknown extra field', { ...good, extra: 1 }],
  ])('rejects entries with %s as malformed', (_name, entry) => {
    expect(verifyChain([entry])).toMatchObject({ ok: false, reason: 'MALFORMED_ENTRY', brokenSeq: 1 });
  });

  it('refuses to append a payload that is not canonical JSON, or after an inconsistent entry', () => {
    expect(() => appendEntry(null, { chainId: 'c', type: 'T', payload: { n: Number.POSITIVE_INFINITY } })).toThrow(/canonical JSON/);
    expect(good.prevHash).toBe(GENESIS_HASH);
    expect(() => appendEntry({ ...good, payload: { a: 2 } }, { chainId: 'c', type: 'T', payload: 1 })).toThrow(/does not match/);
  });
});

describe('SKU used by the fixtures', () => {
  it('exists in the default catalog', async () => {
    const w = await makeWorld();
    expect(w.ctx.catalog(SKU)).not.toBeNull();
  });
});
