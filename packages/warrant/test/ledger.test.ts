import { isDeepStrictEqual } from 'node:util';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalize, hashBytes, isHash, type JsonValue } from '../src/canonical';
import {
  GENESIS_HASH,
  LedgerError,
  appendEntry,
  computeEntryHash,
  verifyChain,
  type LedgerEntry,
} from '../src/ledger';

const CHAIN = 'chain_A';

function build(count: number, chainId = CHAIN): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  let prev: LedgerEntry | null = null;
  for (let i = 1; i <= count; i++) {
    prev = appendEntry(prev, { chainId, type: i % 2 === 0 ? 'DECISION' : 'EVENT', payload: { n: i, note: `entry ${i}`, nested: { ok: true, items: [i, i + 1] } } });
    entries.push(prev);
  }
  return entries;
}

/** A mutable deep copy, as an attacker with database access (or a deserializer) would hold. */
function copy(entries: readonly LedgerEntry[]): Array<Record<string, any>> {
  return JSON.parse(JSON.stringify(entries)) as Array<Record<string, any>>;
}

describe('computeEntryHash', () => {
  it('is SHA-256 over prevHash followed by the RFC 8785 canonical entry body', () => {
    const body = { chainId: 'c', seq: 1, type: 'T', payload: { b: 2, a: [1, null] } };
    const expected = hashBytes(GENESIS_HASH + canonicalize(body));
    expect(computeEntryHash(GENESIS_HASH, body)).toBe(expected);
    expect(canonicalize(body)).toBe('{"chainId":"c","payload":{"a":[1,null],"b":2},"seq":1,"type":"T"}');
  });

  it('matches a fixed known-answer vector (guards against accidental format changes)', () => {
    const hash = computeEntryHash(GENESIS_HASH, { chainId: 'chain_1', seq: 1, type: 'WARRANT_ISSUED', payload: { cents: 30000 } });
    expect(isHash(hash)).toBe(true);
    expect(hash).toBe('sha256:ZCpAZZ0VsBmZY0NB0Zw4yTnQCRsBYkxkzs2EzzcHAMw');
  });

  it('covers every field: changing any one of them changes the hash', () => {
    const body = { chainId: 'c', seq: 1, type: 'T', payload: { a: 1 } };
    const base = computeEntryHash(GENESIS_HASH, body);
    expect(computeEntryHash(GENESIS_HASH, { ...body, chainId: 'd' })).not.toBe(base);
    expect(computeEntryHash(GENESIS_HASH, { ...body, seq: 2 })).not.toBe(base);
    expect(computeEntryHash(GENESIS_HASH, { ...body, type: 'U' })).not.toBe(base);
    expect(computeEntryHash(GENESIS_HASH, { ...body, payload: { a: 2 } })).not.toBe(base);
    expect(computeEntryHash('sha256:' + 'B'.repeat(43), body)).not.toBe(base);
  });
});

describe('appendEntry', () => {
  it('starts a chain at seq 1 on the genesis hash and links each entry to the previous one', () => {
    const [first, second, third] = build(3) as [LedgerEntry, LedgerEntry, LedgerEntry];
    expect(first.seq).toBe(1);
    expect(first.prevHash).toBe(GENESIS_HASH);
    expect(second.seq).toBe(2);
    expect(second.prevHash).toBe(first.hash);
    expect(third.seq).toBe(3);
    expect(third.prevHash).toBe(second.hash);
    expect(third.hash).toBe(computeEntryHash(second.hash, { chainId: CHAIN, seq: 3, type: third.type, payload: third.payload }));
  });

  it('owns its data: later mutation of the draft payload cannot change the entry', () => {
    const payload = { amount: 100, tags: ['a'] };
    const entry = appendEntry(null, { chainId: CHAIN, type: 'T', payload });
    payload.amount = 999;
    payload.tags.push('evil');
    expect(entry.payload).toEqual({ amount: 100, tags: ['a'] });
    expect(verifyChain([entry]).ok).toBe(true);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.payload)).toBe(true);
  });

  it('omits undefined object members, exactly like a database round trip would', () => {
    const entry = appendEntry(null, { chainId: CHAIN, type: 'T', payload: { a: 1, b: undefined } as unknown as JsonValue });
    expect(entry.payload).toEqual({ a: 1 });
    expect(verifyChain(JSON.parse(JSON.stringify([entry]))).ok).toBe(true);
  });

  it.each([
    ['an empty chain id', { chainId: '', type: 'T', payload: 1 }],
    ['an empty type', { chainId: CHAIN, type: '', payload: 1 }],
    ['an over-long type', { chainId: CHAIN, type: 'T'.repeat(129), payload: 1 }],
    ['a non-string type', { chainId: CHAIN, type: 5, payload: 1 }],
    ['a NaN payload', { chainId: CHAIN, type: 'T', payload: Number.NaN }],
    ['an undefined payload', { chainId: CHAIN, type: 'T', payload: undefined }],
    ['a Date payload', { chainId: CHAIN, type: 'T', payload: new Date(0) }],
  ])('rejects %s', (_label, draft) => {
    expect(() => appendEntry(null, draft as never)).toThrow();
  });

  it('refuses to append to an entry of another chain', () => {
    const [other] = build(1, 'chain_B') as [LedgerEntry];
    expect(() => appendEntry(other, { chainId: CHAIN, type: 'T', payload: 1 })).toThrow(LedgerError);
  });

  it('refuses to append to a previous entry that is itself malformed or inconsistent', () => {
    const [entry] = build(1) as [LedgerEntry];
    expect(() => appendEntry({ ...entry, hash: GENESIS_HASH }, { chainId: CHAIN, type: 'T', payload: 1 })).toThrow(LedgerError);
    expect(() => appendEntry({ seq: 1 } as never, { chainId: CHAIN, type: 'T', payload: 1 })).toThrow(LedgerError);
  });
});

describe('verifyChain', () => {
  it('accepts an empty chain and a well-formed chain', () => {
    expect(verifyChain([])).toEqual({ ok: true, length: 0, headSeq: null, headHash: null });
    const entries = build(10);
    expect(verifyChain(entries)).toEqual({ ok: true, length: 10, headSeq: 10, headHash: entries[9]?.hash });
  });

  it('accepts entries that went through a JSON round trip (database storage)', () => {
    const entries = build(6);
    expect(verifyChain(copy(entries)).ok).toBe(true);
  });

  type Tamper = [string, (rows: Array<Record<string, any>>) => void, number];
  const tampers: Tamper[] = [
    ['an edited payload value', (r) => (r[2]!['payload'].n = 999), 3],
    ['an edited nested payload value', (r) => (r[2]!['payload'].nested.items[1] = 0), 3],
    ['an added payload member', (r) => (r[2]!['payload'].extra = true), 3],
    ['a removed payload member', (r) => delete r[2]!['payload'].note, 3],
    ['an edited type', (r) => (r[2]!['type'] = 'CAPTURE'), 3],
    ['an edited seq', (r) => (r[2]!['seq'] = 4), 3],
    ['an edited chain id', (r) => (r[2]!['chainId'] = 'chain_B'), 3],
    ['an edited hash', (r) => (r[2]!['hash'] = 'sha256:' + 'a'.repeat(43)), 3],
    ['an upper-cased hash', (r) => (r[2]!['hash'] = String(r[2]!['hash']).toUpperCase().replace('SHA256', 'sha256')), 3],
    ['an edited prevHash', (r) => (r[2]!['prevHash'] = GENESIS_HASH), 3],
    ['a payload edited with its hash recomputed', (r) => {
      r[2]!['payload'].n = 999;
      r[2]!['hash'] = computeEntryHash(r[2]!['prevHash'], r[2] as never);
    }, 4],
    ['a deleted middle entry', (r) => void r.splice(2, 1), 3],
    ['a deleted first entry', (r) => void r.splice(0, 1), 1],
    ['two swapped entries', (r) => void ([r[1], r[2]] = [r[2]!, r[1]!]), 2],
    ['a duplicated entry', (r) => void r.splice(3, 0, structuredClone(r[2]!)), 4],
    ['an unknown extra field on an entry', (r) => (r[2]!['note'] = 'hi'), 3],
    ['a missing field on an entry', (r) => delete r[2]!['type'], 3],
    ['a null entry', (r) => (r[2] = null as never), 3],
    ['a non-object entry', (r) => (r[2] = 'entry' as never), 3],
    ['a string seq', (r) => (r[2]!['seq'] = '3'), 3],
    ['a fractional seq', (r) => (r[2]!['seq'] = 3.5), 3],
    ['a hash with the wrong shape', (r) => (r[2]!['hash'] = 'abc'), 3],
  ];
  it.each(tampers)('detects %s and points at the first broken seq', (_label, mutate, brokenSeq) => {
    const rows = copy(build(6));
    mutate(rows);
    const result = verifyChain(rows);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.brokenSeq).toBe(brokenSeq);
  });

  it('rejects input that is not an array', () => {
    for (const input of [null, undefined, {}, 'chain', 5]) {
      expect(verifyChain(input)).toMatchObject({ ok: false, reason: 'NOT_AN_ARRAY' });
    }
  });

  it('reports a reason code for each kind of failure', () => {
    const rows = () => copy(build(4));
    const reasonOf = (mutate: (r: Array<Record<string, any>>) => void) => {
      const r = rows();
      mutate(r);
      const result = verifyChain(r);
      return result.ok ? 'OK' : result.reason;
    };
    expect(reasonOf((r) => (r[1]!['payload'].n = 0))).toBe('HASH_MISMATCH');
    expect(reasonOf((r) => (r[1]!['prevHash'] = GENESIS_HASH))).toBe('PREV_HASH_MISMATCH');
    expect(reasonOf((r) => void r.splice(1, 1))).toBe('SEQ_MISMATCH');
    expect(reasonOf((r) => (r[1]!['chainId'] = 'other'))).toBe('CHAIN_ID_MISMATCH');
    expect(reasonOf((r) => delete r[1]!['hash'])).toBe('MALFORMED_ENTRY');
  });

  it('enforces an expected chain id', () => {
    const entries = build(3);
    expect(verifyChain(entries, { chainId: CHAIN }).ok).toBe(true);
    expect(verifyChain(entries, { chainId: 'chain_B' })).toMatchObject({ ok: false, reason: 'CHAIN_ID_MISMATCH', brokenSeq: 1 });
  });

  it('cannot see a truncated tail by itself, but detects it against an anchored head hash', () => {
    const entries = build(6);
    const truncated = entries.slice(0, 4);
    expect(verifyChain(truncated).ok).toBe(true); // a chain alone cannot prove it is complete
    const anchor = (entries[5] as LedgerEntry).hash;
    expect(verifyChain(entries, { expectedHeadHash: anchor }).ok).toBe(true);
    expect(verifyChain(truncated, { expectedHeadHash: anchor })).toMatchObject({ ok: false, reason: 'HEAD_MISMATCH' });
    expect(verifyChain([], { expectedHeadHash: anchor })).toMatchObject({ ok: false, reason: 'HEAD_MISMATCH' });
  });

  it('cannot see a chain rewritten consistently from some point, but detects it against an anchored head hash', () => {
    const original = build(5);
    let prev: LedgerEntry | null = original[1] ?? null;
    const rewritten: LedgerEntry[] = original.slice(0, 2);
    for (let i = 3; i <= 5; i++) {
      prev = appendEntry(prev, { chainId: CHAIN, type: 'REWRITTEN', payload: { n: i } });
      rewritten.push(prev);
    }
    expect(verifyChain(rewritten).ok).toBe(true);
    expect(verifyChain(rewritten, { expectedHeadHash: (original[4] as LedgerEntry).hash })).toMatchObject({ ok: false, reason: 'HEAD_MISMATCH' });
  });

  it('verifies a later segment of a chain against the entry before it', () => {
    const entries = build(8);
    const after = entries[3] as LedgerEntry;
    const segment = entries.slice(4);
    expect(verifyChain(segment, { after: { seq: after.seq, hash: after.hash } })).toMatchObject({ ok: true, length: 4, headSeq: 8 });
    expect(verifyChain(segment).ok).toBe(false);
    expect(verifyChain(segment, { after: { seq: 3, hash: after.hash } })).toMatchObject({ ok: false, reason: 'SEQ_MISMATCH' });
    expect(verifyChain(segment, { after: { seq: after.seq, hash: entries[2]?.hash ?? '' } })).toMatchObject({
      ok: false,
      reason: 'PREV_HASH_MISMATCH',
    });
    expect(verifyChain([], { after: { seq: after.seq, hash: after.hash } })).toMatchObject({ ok: true, length: 0, headSeq: 4, headHash: after.hash });
  });

  const payloadArb = fc.jsonValue().map((v) => JSON.parse(JSON.stringify(v)) as JsonValue);
  const draftArb = fc.record({
    type: fc.stringMatching(/^[A-Z][A-Z_]{0,19}$/),
    payload: payloadArb,
  });

  it('property: any sequence of appends verifies, and each entry commits to its predecessor', () => {
    fc.assert(
      fc.property(fc.array(draftArb, { maxLength: 25 }), (drafts) => {
        const entries: LedgerEntry[] = [];
        let prev: LedgerEntry | null = null;
        for (const draft of drafts) {
          prev = appendEntry(prev, { chainId: CHAIN, ...draft });
          entries.push(prev);
        }
        const result = verifyChain(entries);
        expect(result.ok).toBe(true);
        entries.forEach((entry, index) => {
          expect(entry.seq).toBe(index + 1);
          expect(entry.prevHash).toBe(index === 0 ? GENESIS_HASH : entries[index - 1]?.hash);
        });
        // A JSON round trip (database storage) must not change the verdict.
        expect(verifyChain(JSON.parse(JSON.stringify(entries))).ok).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('property: changing any single byte of the serialized ledger is detected', () => {
    // Serialize a chain, overwrite one byte anywhere with a different byte, then either the result is not
    // JSON any more, or it parses to something different that verifyChain must reject.
    fc.assert(
      fc.property(fc.array(draftArb, { minLength: 1, maxLength: 12 }), fc.nat(), fc.integer({ min: 1, max: 255 }), (drafts, where, delta) => {
        const entries: LedgerEntry[] = [];
        let prev: LedgerEntry | null = null;
        for (const draft of drafts) {
          prev = appendEntry(prev, { chainId: CHAIN, ...draft });
          entries.push(prev);
        }
        const bytes = Buffer.from(JSON.stringify(entries), 'utf8');
        const index = where % bytes.length;
        bytes[index] = ((bytes[index] ?? 0) + delta) % 256; // always a different byte
        let parsed: unknown;
        try {
          parsed = JSON.parse(new TextDecoder('utf-8').decode(bytes));
        } catch {
          return; // not even JSON: trivially detected
        }
        fc.pre(!isDeepStrictEqual(parsed, JSON.parse(JSON.stringify(entries))));
        expect(verifyChain(parsed).ok).toBe(false);
      }),
      { numRuns: 3000 },
    );
  });

  it('property: removing, swapping or replaying any entry is detected', () => {
    fc.assert(
      fc.property(fc.array(draftArb, { minLength: 2, maxLength: 12 }), fc.nat(), fc.nat(), (drafts, a, b) => {
        const entries: LedgerEntry[] = [];
        let prev: LedgerEntry | null = null;
        for (const draft of drafts) {
          prev = appendEntry(prev, { chainId: CHAIN, ...draft });
          entries.push(prev);
        }
        const i = a % entries.length;
        const j = b % entries.length;

        const removed = entries.filter((_, k) => k !== i);
        if (i < entries.length - 1) {
          expect(verifyChain(removed).ok).toBe(false); // removing the last entry is the truncation case
        }
        if (i !== j) {
          const swapped = [...entries];
          [swapped[i], swapped[j]] = [swapped[j] as LedgerEntry, swapped[i] as LedgerEntry];
          expect(verifyChain(swapped).ok).toBe(false);
        }
        const replayed = [...entries, entries[i] as LedgerEntry];
        expect(verifyChain(replayed).ok).toBe(false);
      }),
      { numRuns: 300 },
    );
  });
});
