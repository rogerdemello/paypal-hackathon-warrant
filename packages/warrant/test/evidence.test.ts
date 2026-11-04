import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalize, hashJson } from '../src/canonical';
import { EVIDENCE_PACKET_VERSION, buildEvidencePacket } from '../src/evidence';
import { computeFacts } from '../src/facts';
import { hashCartWarrant, serializeBundle } from '../src/warrant';
import { KIDS, LISTING_HASH, SKU, factsInput, makeWorld } from './fixtures';

async function packetFor(overrides: Parameters<typeof factsInput>[1] = {}) {
  const w = await makeWorld();
  const input = factsInput(w, overrides);
  const facts = await computeFacts(input);
  return { w, facts, packet: buildEvidencePacket(facts, input.bundle) };
}

describe('buildEvidencePacket', () => {
  it('assembles the consented cart, signatures, registry, payer binding, tracking and listing snapshot', async () => {
    const { w, packet } = await packetFor();
    expect(packet).toMatchObject({
      packet_version: EVIDENCE_PACKET_VERSION,
      dispute_id: 'PP-D-1',
      capture_id: 'CAP1',
      order_id: 'ORDER1',
      warrant: {
        version: '0.2',
        mandate_jti: 'mnd_01JEXAMPLE',
        mandate_hash: w.mandateHash,
        cart_jti: 'crt_01JEXAMPLE',
        cart_hash: w.cartHash,
        cart_warrant_hash: hashCartWarrant(w.cart),
        verification_path: '/v/crt_01JEXAMPLE',
        bundle: { mandate: w.mandateJws, cart: w.cartJws },
      },
      consented_cart: {
        currency: 'USD',
        total: '89.00',
        items: [{ sku: SKU, title: 'Desk converter 32in', qty: 1, unit_price: '89.00', listing_hash: LISTING_HASH }],
        consent: { mode: 'human_present', method: 'click' },
      },
      mandate: { instruction: 'Find a standing desk converter under $120', agent: { kid: KIDS.agent }, scope: { max_total: '120.00', mode: 'human_present', budget_mode: 'cumulative' } },
      signatures: { all_valid: true, agent: true, wallet: true, consent: true },
      registry: { keys_active_at_issue: true },
      transparency_log: { included: true, seq: 7 },
      payer_binding: { bound: true },
      tracking: { delivered: true },
      listing_snapshot: [{ sku: SKU, warrant_listing_hash: LISTING_HASH, fulfilled_listing_hash: LISTING_HASH }],
      merchant_mode: 'STRICT',
    });
    for (const id of ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'F13']) {
      expect((packet['facts'] as Record<string, unknown>)[id]).toBeDefined();
    }
  });

  it('is deterministic: the same inputs produce byte-identical canonical JSON', async () => {
    const a = await packetFor();
    const b = await packetFor({ bundle: a.w.bundle });
    // Different worlds have different keys, so compare each packet with itself rebuilt from the same facts.
    expect(canonicalize(buildEvidencePacket(a.facts, a.w.bundle))).toBe(canonicalize(a.packet));
    expect(canonicalize(buildEvidencePacket(a.facts, serializeBundle(a.w.bundle)))).toBe(canonicalize(a.packet));
    expect(b.packet['packet_hash']).not.toBe(a.packet['packet_hash']);
  });

  it('carries a packet_hash over everything else', async () => {
    const { packet } = await packetFor();
    const { packet_hash, ...rest } = packet;
    expect(packet_hash).toBe(hashJson(rest));
  });

  it('every value is plain canonical JSON (no undefined, no NaN, no class instances)', async () => {
    const { packet } = await packetFor();
    expect(() => canonicalize(packet)).not.toThrow();
    expect(JSON.parse(JSON.stringify(packet))).toEqual(packet);
  });

  it('reflects a changed fact in the hash', async () => {
    const a = await packetFor();
    const w = a.w;
    const changed = await computeFacts(factsInput(w, { refunds: [] , tracking: { delivered: false, deliveredAt: null, promisedBy: null, trackingNumber: 'TRK1' } }));
    expect(buildEvidencePacket(changed, w.bundle)['packet_hash']).not.toBe(buildEvidencePacket(a.facts, w.bundle)['packet_hash']);
  });

  it('shows null parts, not invented ones, when no warrant is stored', async () => {
    const { packet } = await packetFor({ bundle: null });
    expect(packet).toMatchObject({
      warrant: null,
      consented_cart: null,
      mandate: null,
      signatures: { all_valid: false, agent: null, wallet: null, consent: null },
      payer_binding: { bound: false },
    });
  });

  it('shows null parts for a malformed stored bundle', async () => {
    const { packet } = await packetFor({ bundle: '{ nope' });
    expect(packet['warrant']).toBeNull();
    expect(packet['consented_cart']).toBeNull();
  });

  it('records a missing transparency log as null and an unknown listing as null', async () => {
    const { packet } = await packetFor({ transparency: null, fulfilledListings: null });
    expect(packet['transparency_log']).toBeNull();
    expect(packet['listing_snapshot']).toEqual([{ sku: SKU, warrant_listing_hash: LISTING_HASH, fulfilled_listing_hash: null }]);
  });

  it('property: the packet hash changes whenever any fact value changes', async () => {
    const w = await makeWorld();
    const base = await computeFacts(factsInput(w));
    const baseHash = buildEvidencePacket(base, w.bundle)['packet_hash'];
    const ids = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F13'] as const;
    fc.assert(
      fc.property(fc.constantFrom(...ids), (id) => {
        const flipped = { ...base, [id]: { ...base[id], value: !base[id].value } };
        expect(buildEvidencePacket(flipped, w.bundle)['packet_hash']).not.toBe(baseHash);
      }),
    );
  });
});

describe('buildEvidencePacket: Warrant 0.2 fields', () => {
  it('records what the consent signature covers and the mandate budget mode', async () => {
    const { w, packet } = await packetFor();
    expect(packet['consented_cart']).toMatchObject({
      consent: { covers: { cart_hash: w.cartHash, cart_jti: w.cart.jti, aud: w.cart.aud, mandate_hash: w.mandateHash } },
    });
    expect(packet['mandate']).toMatchObject({ scope: { budget_mode: 'cumulative' } });
  });

  it('shows the cumulative-budget fact detail and the jti count in the facts summary', async () => {
    const { packet } = await packetFor({ spentBefore: { totalCents: 3100, itemCount: 1 } });
    const facts = packet['facts'] as Record<string, { detail?: unknown; evidence: string[] }>;
    expect(facts['F6']?.detail).toEqual({ budgetMode: 'cumulative', cumulativeChecked: true });
    expect(facts['F8']?.evidence).toContain('jti_use_count=1');
  });

  it('has no covers section for a human_not_present warrant', async () => {
    const w = await makeWorld({ scopeMode: 'human_not_present' });
    const facts = await computeFacts(factsInput(w));
    const packet = buildEvidencePacket(facts, w.bundle);
    expect((packet['consented_cart'] as { consent: { covers: unknown } }).consent.covers).toBeNull();
  });
});
