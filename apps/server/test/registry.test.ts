import { generateSigningKey, hashBytes, keyStateAt, verifyChain } from '@warrant/warrant';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendToChain, chainHead, entryAt, readChain, toLedgerEntry, verifyStoredChain } from '../src/chain';
import { keyMaterial } from '../src/keys';
import { REGISTRY_CHAIN, verifyInclusionProof, type InclusionProof } from '../src/services/registry';
import { makeServerWorld, T0_MS, type TestWorld } from './helpers';

let w: TestWorld;
beforeEach(async () => {
  w = await makeServerWorld();
});
afterEach(async () => {
  await w.close();
});

const NOW = T0_MS / 1000;

async function seedKeys(): Promise<void> {
  await w.registry.ensurePlatform({ id: 'acme-agents', name: 'Acme Agents' });
  await w.registry.registerKey({ kid: w.keys.wallet.kid, kind: 'wallet', owner: 'wallet:demo', publicKeyBase64: w.keys.wallet.publicKeyBase64, validFrom: NOW - 100 });
  await w.registry.registerKey({ kid: w.keys.agent.kid, kind: 'agent', owner: 'acme-agents', platformId: 'acme-agents', publicKeyBase64: w.keys.agent.publicKeyBase64, validFrom: NOW - 100 });
}

describe('audit chains in the database', () => {
  it('appends, links and verifies entries', async () => {
    const append = (type: string, payload: object) => w.db.transaction((tx) => appendToChain(tx, 'ledger_entries', { chainId: 'order:1', type, payload: payload as never }, NOW));
    const a = await append('order_created', { total: '10.00' });
    const b = await append('order_captured', { capture: 'C1' });
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect(b.prevHash).toBe(a.hash);
    expect(await chainHead(w.db, 'ledger_entries', 'order:1')).toMatchObject({ seq: 2, hash: b.hash });
    expect(await chainHead(w.db, 'ledger_entries', 'order:none')).toBeNull();
    const read = await readChain(w.db, 'ledger_entries', 'order:1');
    expect(verifyChain(read.map(toLedgerEntry)).ok).toBe(true);
    expect(await verifyStoredChain(w.db, 'ledger_entries', 'order:1')).toMatchObject({ ok: true, length: 2, headSeq: 2, headHash: b.hash });
    expect(await verifyStoredChain(w.db, 'ledger_entries', 'order:1', b.hash)).toMatchObject({ ok: true });
    expect(await verifyStoredChain(w.db, 'ledger_entries', 'order:none')).toMatchObject({ ok: true, length: 0, headSeq: null });
    expect((await entryAt(w.db, 'ledger_entries', 'order:1', 2))?.type).toBe('order_captured');
    expect(await entryAt(w.db, 'ledger_entries', 'order:1', 9)).toBeNull();
  });

  it('keeps chains independent', async () => {
    const append = (chainId: string) => w.db.transaction((tx) => appendToChain(tx, 'ledger_entries', { chainId, type: 't', payload: {} }, NOW));
    await append('a');
    await append('a');
    const first = await append('b');
    expect(first.seq).toBe(1);
  });

  it('concurrent appends to one chain line up with no gaps or forks', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => w.db.transaction((tx) => appendToChain(tx, 'ledger_entries', { chainId: 'race', type: 'n', payload: { i } }, NOW))));
    expect(results.map((r) => r.seq).sort((x, y) => x - y)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(await verifyStoredChain(w.db, 'ledger_entries', 'race')).toMatchObject({ ok: true, length: 12 });
  });

  it('detects an edited row, a deleted row and a truncated tail', async () => {
    for (let i = 0; i < 4; i++) await w.db.transaction((tx) => appendToChain(tx, 'ledger_entries', { chainId: 'x', type: 't', payload: { i } }, NOW));
    const head = await chainHead(w.db, 'ledger_entries', 'x');
    await w.db.query(`UPDATE ledger_entries SET payload = '{"i":99}'::jsonb WHERE chain_id = 'x' AND seq = 2`);
    const edited = await verifyStoredChain(w.db, 'ledger_entries', 'x');
    expect(edited).toMatchObject({ ok: false, brokenSeq: 2, reason: 'HASH_MISMATCH' });
    await w.db.query(`UPDATE ledger_entries SET payload = '{"i":1}'::jsonb WHERE chain_id = 'x' AND seq = 2`);
    expect((await verifyStoredChain(w.db, 'ledger_entries', 'x')).ok).toBe(true);
    await w.db.query(`DELETE FROM ledger_entries WHERE chain_id = 'x' AND seq = 3`);
    expect(await verifyStoredChain(w.db, 'ledger_entries', 'x')).toMatchObject({ ok: false, brokenSeq: 3, reason: 'SEQ_MISMATCH' });
    await w.db.query(`DELETE FROM ledger_entries WHERE chain_id = 'x' AND seq = 4`);
    await w.db.query(`INSERT INTO ledger_entries SELECT chain_id, seq, type, payload, prev_hash, hash, created_at FROM ledger_entries WHERE false`);
    // Without seq 3 and 4 the chain is consistent but short: only a pinned head catches that.
    expect((await verifyStoredChain(w.db, 'ledger_entries', 'x')).ok).toBe(true);
    expect(await verifyStoredChain(w.db, 'ledger_entries', 'x', head?.hash)).toMatchObject({ ok: false, reason: 'HEAD_MISMATCH' });
  });

  it('verifies chains longer than one page', async () => {
    await w.db.transaction(async (tx) => {
      for (let i = 0; i < 520; i++) await appendToChain(tx, 'ledger_entries', { chainId: 'long', type: 't', payload: { i } }, NOW);
    });
    expect(await verifyStoredChain(w.db, 'ledger_entries', 'long')).toMatchObject({ ok: true, length: 520, headSeq: 520 });
    await w.db.query(`UPDATE ledger_entries SET type = 'u' WHERE chain_id = 'long' AND seq = 510`);
    expect(await verifyStoredChain(w.db, 'ledger_entries', 'long')).toMatchObject({ ok: false, brokenSeq: 510 });
  });

  it('rolls an append back with its transaction', async () => {
    await expect(
      w.db.transaction(async (tx) => {
        await appendToChain(tx, 'ledger_entries', { chainId: 'rb', type: 't', payload: {} }, NOW);
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(await chainHead(w.db, 'ledger_entries', 'rb')).toBeNull();
  });
});

describe('registry keys', () => {
  it('registers keys, serves a verifier lookup and logs the registration', async () => {
    await seedKeys();
    const lookup = await w.registry.lookup();
    const wallet = lookup(w.keys.wallet.kid);
    expect(wallet).toMatchObject({ kind: 'wallet', owner: 'wallet:demo', status: 'active', validTo: null });
    expect(keyStateAt(wallet!, NOW)).toBe('active');
    expect(lookup('missing')).toBeNull();
    const log = await w.registry.entries();
    expect(log.map((e) => e.type)).toEqual(['key_registered', 'key_registered']);
    expect(log[0]?.payload).toMatchObject({ kid: w.keys.wallet.kid, logged_at: NOW });
    expect((await w.registry.platform('acme-agents'))?.name).toBe('Acme Agents');
    expect(await w.registry.platform('nope')).toBeNull();
  });

  it('registration is idempotent for the same key and refuses a different key under the same kid', async () => {
    await seedKeys();
    expect(await w.registry.registerKey({ kid: w.keys.wallet.kid, kind: 'wallet', owner: 'wallet:demo', publicKeyBase64: w.keys.wallet.publicKeyBase64, validFrom: NOW })).toBe(false);
    expect((await w.registry.entries()).length).toBe(2);
    const other = keyMaterial('wallet', generateSigningKey().privateKey);
    await expect(w.registry.registerKey({ kid: w.keys.wallet.kid, kind: 'wallet', owner: 'wallet:demo', publicKeyBase64: other.publicKeyBase64, validFrom: NOW })).rejects.toThrow(/different public key/);
  });

  it('ensurePlatform is idempotent', async () => {
    const a = await w.registry.ensurePlatform({ id: 'p', name: 'First' });
    const b = await w.registry.ensurePlatform({ id: 'p', name: 'Second' });
    expect(b.name).toBe(a.name);
  });

  it('suspension and revocation take effect from now on and are logged', async () => {
    await seedKeys();
    w.clock.advanceSeconds(600);
    await w.registry.setKeyStatus(w.keys.agent.kid, 'revoked');
    const agent = (await w.registry.lookup())(w.keys.agent.kid)!;
    expect(agent.status).toBe('revoked');
    expect(agent.statusChangedAt).toBe(NOW + 600);
    expect(keyStateAt(agent, NOW + 599)).toBe('active');
    expect(keyStateAt(agent, NOW + 600)).toBe('revoked');
    expect((await w.registry.entries()).at(-1)?.payload).toMatchObject({ kid: w.keys.agent.kid, from: 'active', to: 'revoked' });
    await w.registry.setKeyStatus(w.keys.agent.kid, 'revoked');
    expect((await w.registry.entries()).length).toBe(3);
    await w.registry.setKeyStatus(w.keys.agent.kid, 'active');
    expect(((await w.registry.lookup())(w.keys.agent.kid) as { statusChangedAt: number | null }).statusChangedAt).toBeNull();
    await expect(w.registry.setKeyStatus('ghost', 'revoked')).rejects.toThrow(/unknown key/);
  });

  it('publishes a JWKS with status and validity but no private material', async () => {
    await seedKeys();
    const { keys } = await w.registry.jwks();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatchObject({ kid: w.keys.wallet.kid, kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', kind: 'wallet', owner: 'wallet:demo', status: 'active', valid_to: null });
    expect(JSON.stringify(keys)).not.toContain('"d"');
  });
});

describe('transparency log', () => {
  const entry = (n: number) => ({ cartJti: `crt_${n}`, warrantHash: hashBytes(`w${n}`), mandateHash: hashBytes('m'), platform: 'acme-agents' });

  it('logs a warrant once per cart and serves the dispute-facts view', async () => {
    expect(await w.registry.transparencyView('crt_1')).toEqual({ included: false, seq: null, entryHash: null, loggedAt: null });
    const first = await w.registry.logWarrant(entry(1));
    w.clock.advanceSeconds(30);
    const again = await w.registry.logWarrant(entry(1));
    expect(again).toEqual(first);
    expect(first).toMatchObject({ included: true, seq: 1, loggedAt: NOW });
    expect(await w.registry.transparencyView('crt_1')).toEqual({ included: true, seq: 1, entryHash: first.entryHash, loggedAt: NOW });
    expect((await w.registry.entries()).length).toBe(1);
  });

  it('concurrent logging of the same cart yields one entry', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => w.registry.logWarrant(entry(7))));
    expect(new Set(results.map((r) => r.entryHash)).size).toBe(1);
    expect((await w.registry.entries()).length).toBe(1);
  });

  it('checkpoints the head, once per head', async () => {
    expect(await w.registry.checkpoint()).toBeNull();
    await w.registry.logWarrant(entry(1));
    const c1 = await w.registry.checkpoint();
    expect(c1).toMatchObject({ seq: 1, issuedAt: NOW });
    w.clock.advanceSeconds(5);
    expect(await w.registry.checkpoint()).toEqual(c1);
    await w.registry.logWarrant(entry(2));
    const c2 = await w.registry.checkpoint();
    expect(c2?.seq).toBe(2);
    expect(await w.registry.latestCheckpoint()).toEqual(c2);
    expect(await w.registry.checkpointAt(1)).toEqual(c1);
    expect(await w.registry.checkpointAt(5)).toBeNull();
  });

  it('inclusion proofs verify offline and fail when anything is altered', async () => {
    await w.registry.logWarrant(entry(1));
    await w.registry.logWarrant(entry(2));
    await w.registry.logWarrant(entry(3));
    const proof = (await w.registry.inclusionProof('crt_1'))!;
    expect(proof.entry.seq).toBe(1);
    expect(proof.chain.map((e) => e.seq)).toEqual([2, 3]);
    const { publicKey } = w.registry.logPublicKey();
    expect(await verifyInclusionProof(proof, publicKey)).toEqual({ ok: true });

    const middle = (await w.registry.inclusionProof('crt_2'))!;
    expect(await verifyInclusionProof(middle, publicKey)).toEqual({ ok: true });
    const last = (await w.registry.inclusionProof('crt_3'))!;
    expect(last.chain).toEqual([]);
    expect(await verifyInclusionProof(last, publicKey)).toEqual({ ok: true });

    const tampered: InclusionProof = { ...proof, entry: { ...proof.entry, payload: { ...(proof.entry.payload as object), warrant_hash: hashBytes('forged') } } };
    expect(await verifyInclusionProof(tampered, publicKey)).toMatchObject({ ok: false });
    const dropped: InclusionProof = { ...proof, chain: proof.chain.slice(0, 1) };
    expect(await verifyInclusionProof(dropped, publicKey)).toMatchObject({ ok: false });
    const wrongKey = keyMaterial('registry', generateSigningKey().privateKey).publicKeyBase64;
    expect(await verifyInclusionProof(proof, wrongKey)).toEqual({ ok: false, reason: 'checkpoint signature is invalid' });
    const relabelled: InclusionProof = { ...proof, checkpoint: { ...proof.checkpoint, seq: 2 } };
    expect(await verifyInclusionProof(relabelled, publicKey)).toEqual({ ok: false, reason: 'checkpoint does not match its signed statement' });
    expect(await w.registry.inclusionProof('crt_unknown')).toBeNull();
  });

  it('a proof made before the log grew still verifies against its own checkpoint', async () => {
    await w.registry.logWarrant(entry(1));
    const proof = (await w.registry.inclusionProof('crt_1'))!;
    await w.registry.logWarrant(entry(2));
    expect(await verifyInclusionProof(proof, w.registry.logPublicKey().publicKey)).toEqual({ ok: true });
    const later = (await w.registry.inclusionProof('crt_1'))!;
    expect(later.checkpoint.seq).toBe(1);
  });

  it('audits the log: clean, then a rewrite of history and a forged checkpoint are both caught', async () => {
    await seedKeys();
    await w.registry.logWarrant(entry(1));
    await w.registry.logWarrant(entry(2));
    await w.registry.checkpoint();
    expect(await w.registry.audit()).toMatchObject({ ok: true, length: 4, headSeq: 4, problems: [] });

    await w.db.query(`UPDATE transparency_log SET payload = jsonb_set(payload, '{platform}', '"evil"') WHERE seq = 3`);
    const broken = await w.registry.audit();
    expect(broken.ok).toBe(false);
    expect(broken.problems.map((p) => p.code)).toContain('CHAIN_BROKEN');
    await w.db.query(`UPDATE transparency_log SET payload = jsonb_set(payload, '{platform}', '"acme-agents"') WHERE seq = 3`);
    expect((await w.registry.audit()).ok).toBe(true);

    await w.db.query(`UPDATE transparency_checkpoints SET head_hash = 'sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'`);
    expect((await w.registry.audit()).problems.map((p) => p.code)).toContain('CHECKPOINT_MISMATCH');

    await w.db.query(`UPDATE transparency_checkpoints SET jws = 'a.b.c'`);
    expect((await w.registry.audit()).problems.map((p) => p.code)).toContain('CHECKPOINT_SIGNATURE');
  });

  it('the registry chain id is stable and keys and warrants share one chain', async () => {
    await seedKeys();
    await w.registry.logWarrant(entry(1));
    const all = await w.registry.entries();
    expect(new Set(all.map((e) => e.chainId))).toEqual(new Set([REGISTRY_CHAIN]));
    expect(all.map((e) => e.type)).toEqual(['key_registered', 'key_registered', 'warrant_logged']);
    expect((await w.registry.head())?.seq).toBe(3);
    expect(await w.registry.entries({ afterSeq: 2 })).toHaveLength(1);
    expect((await w.registry.entries({ limit: 1 })).length).toBe(1);
  });
});
