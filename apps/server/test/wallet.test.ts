import { FIXTURE_PRODUCTS, listingHash } from '@warrant/catalog';
import {
  HUMAN_NOT_PRESENT_CONSENT,
  agentIssuer,
  decodeConsent,
  decodeMandate,
  hashPayerId,
  merchantAudience,
  verifyJws,
  type CartLineInput,
} from '@warrant/warrant';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_ID, AGENT_ISS, AGENT_PLATFORM_ID } from '../src/identity';
import { WalletError, WalletService, type MandateTerms } from '../src/services/wallet';
import { makeServerWorld, type TestWorld } from './helpers';
import { registerIdentities } from '../src/services/bootstrap';

const MERCHANT_ID = 'SIMMERCHANT01';
const AUD = merchantAudience(MERCHANT_ID);
const DESK = FIXTURE_PRODUCTS.find((p) => p.category === 'office_furniture')!;

let w: TestWorld;
let wallet: WalletService;
beforeEach(async () => {
  w = await makeServerWorld();
  await registerIdentities(w.registry, w.keys, w.clock);
  wallet = new WalletService({ db: w.db, clock: w.clock, ids: w.ids, key: w.keys.wallet, merchants: new Map([[AUD, 'Warrant Demo Store']]) });
});
afterEach(async () => {
  await w.close();
});

const agent = () => ({ platform: AGENT_PLATFORM_ID, agentId: AGENT_ID, kid: w.keys.agent.kid });
const terms = (over: Partial<MandateTerms> = {}): MandateTerms => ({
  instructionText: 'Find a standing desk converter under $120',
  maxTotalCents: 12_000,
  maxItems: 1,
  categoriesAllow: null,
  mode: 'human_present',
  budgetMode: 'per_cart',
  ...over,
});
const line = (over: Partial<CartLineInput> = {}): CartLineInput => ({ sku: DESK.id, title: DESK.title, qty: 1, unitPriceCents: 9_900, listingHash: listingHash(DESK), ...over });
const proposal = (mandateJti: string, over: Partial<Parameters<WalletService['proposeCart']>[0]> = {}) => ({
  mandateJti,
  cartJti: w.ids.next('crt'),
  nonce: w.ids.token(),
  aud: AUD,
  proposedBy: AGENT_ISS,
  lines: [line()],
  currency: 'USD',
  ...over,
});

async function setup(over: Partial<MandateTerms> = {}) {
  const principal = await wallet.ensurePrincipal('visitor-0000001', 'Riley');
  const mandate = await wallet.issueMandate(principal.id, agent(), terms(over));
  return { principal, mandate };
}

const failsWith = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(WalletError);
  expect((error as WalletError).code).toBe(code);
  return error as WalletError;
};

describe('principals', () => {
  it('creates one principal per visitor and reuses it', async () => {
    const a = await wallet.ensurePrincipal('visitor-0000001', 'Riley');
    const b = await wallet.ensurePrincipal('visitor-0000001', 'Someone else');
    expect(b).toEqual(a);
    expect(a.displayName).toBe('Riley');
    expect(a.payerIdHash).toBeNull();
    expect((await wallet.ensurePrincipal('visitor-0000002')).id).not.toBe(a.id);
    expect(await wallet.principal('missing')).toBeNull();
  });

  it('rejects odd visitor ids', async () => {
    await failsWith(wallet.ensurePrincipal('short'), 'INVALID');
    await failsWith(wallet.ensurePrincipal('has spaces in it'), 'INVALID');
  });

  it('binds the PayPal payer on first use and refuses a different payer afterwards', async () => {
    const { principal } = await setup();
    const first = hashPayerId('PAYER1');
    expect(await wallet.bindPayer(principal.id, first)).toBe(true);
    expect(await wallet.bindPayer(principal.id, first)).toBe(true);
    expect(await wallet.bindPayer(principal.id, hashPayerId('PAYER2'))).toBe(false);
    expect((await wallet.principal(principal.id))?.payerIdHash).toBe(first);
    // A mandate issued after binding carries the hash (V11).
    const mandate = await wallet.issueMandate(principal.id, agent(), terms());
    expect(mandate.payload.principal.paypal_payer_id_hash).toBe(first);
  });
});

describe('mandates', () => {
  it('signs a mandate that verifies against the registered wallet key', async () => {
    const { principal, mandate } = await setup();
    expect(mandate).toMatchObject({ principalId: principal.id, status: 'active', instructionText: 'Find a standing desk converter under $120' });
    const decoded = decodeMandate(mandate.jws);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.hash).toBe(mandate.hash);
    expect(decoded.kid).toBe(w.keys.wallet.kid);
    expect(decoded.payload).toMatchObject({
      iss: 'wallet:warrant-wallet',
      principal: { ref: principal.id },
      agent: { platform: AGENT_PLATFORM_ID, agent_id: AGENT_ID, kid: w.keys.agent.kid },
      scope: { currency: 'USD', max_total: '120.00', max_per_item: '120.00', max_items: 1, categories_allow: null, merchants_allow: [MERCHANT_ID], mode: 'human_present', budget_mode: 'per_cart' },
    });
    const key = (await w.registry.lookup())(w.keys.wallet.kid)!;
    expect((await verifyJws(mandate.jws, key.publicKey)).ok).toBe(true);
    expect(mandate.exp - mandate.nbf).toBe(24 * 3600);
  });

  it('lists a principal\'s mandates newest first and finds one by id', async () => {
    const { principal, mandate } = await setup();
    w.clock.advanceSeconds(5);
    const second = await wallet.issueMandate(principal.id, agent(), terms({ instructionText: 'Buy a book' }));
    expect((await wallet.mandatesOf(principal.id)).map((m) => m.jti)).toEqual([second.jti, mandate.jti]);
    expect((await wallet.mandate(mandate.jti))?.hash).toBe(mandate.hash);
    expect(await wallet.mandate('nope')).toBeNull();
  });

  it('refuses terms that are not sensible', async () => {
    const principal = await wallet.ensurePrincipal('visitor-0000001');
    const bad = async (over: Partial<MandateTerms>) => (await failsWith(wallet.issueMandate(principal.id, agent(), terms(over)), 'INVALID')).problems;
    expect(await bad({ instructionText: '   ' })).toHaveLength(1);
    expect(await bad({ maxTotalCents: 0 })).toHaveLength(1);
    expect(await bad({ maxTotalCents: 10_000_001 })).toHaveLength(1);
    expect(await bad({ maxTotalCents: 12.5 })).toHaveLength(1);
    expect(await bad({ maxItems: 0 })).toHaveLength(1);
    expect(await bad({ maxItems: 101 })).toHaveLength(1);
    expect(await bad({ maxPerItemCents: -5 })).toHaveLength(1);
    expect(await bad({ validForSeconds: 5 })).toHaveLength(1);
    expect(await bad({ validForSeconds: 31 * 24 * 3600 })).toHaveLength(1);
    await failsWith(wallet.issueMandate('missing', agent(), terms()), 'NOT_FOUND');
  });

  it('only the owner can revoke, and revoking declines waiting carts', async () => {
    const { principal, mandate } = await setup();
    const pending = await wallet.proposeCart(proposal(mandate.jti));
    await failsWith(wallet.revokeMandate('prn_someoneelse', mandate.jti), 'FORBIDDEN');
    await failsWith(wallet.revokeMandate(principal.id, 'nope'), 'NOT_FOUND');
    const revoked = await wallet.revokeMandate(principal.id, mandate.jti);
    expect(revoked.status).toBe('revoked');
    expect(revoked.revokedAt).not.toBeNull();
    expect((await wallet.proposal(pending.id))?.status).toBe('declined');
    await failsWith(wallet.proposeCart(proposal(mandate.jti)), 'REVOKED');
    expect((await wallet.revokeMandate(principal.id, mandate.jti)).status).toBe('revoked');
  });
});

describe('cart proposals', () => {
  it('records exactly what it shows the principal', async () => {
    const { mandate } = await setup();
    const p = await wallet.proposeCart(proposal(mandate.jti, { lines: [line({ qty: 1 })] }));
    expect(p).toMatchObject({ status: 'pending', aud: AUD, proposedBy: AGENT_ISS, mandateJti: mandate.jti });
    expect(p.cart).toMatchObject({ currency: 'USD', total: '99.00', items: [{ sku: DESK.id, qty: 1, unit_price: '99.00' }] });
    expect(p.presented).toMatchObject({
      screen: 'warrant.consent.v1',
      merchant: { audience: AUD, name: 'Warrant Demo Store' },
      principal: 'Riley',
      agent: AGENT_ISS,
      instruction: 'Find a standing desk converter under $120',
      total: '99.00',
      items: [{ line_total: '99.00' }],
      limits: { max_total: '120.00', max_items: 1, mode: 'human_present' },
    });
    expect(p.presentedHash).toMatch(/^sha256:/);
    expect(p.expiresAt - p.createdAt).toBe(600);
    expect((await wallet.proposalByCartJti(p.cartJti))?.id).toBe(p.id);
  });

  it('refuses a proposal from anyone but the agent the mandate names', async () => {
    const { mandate } = await setup();
    await failsWith(wallet.proposeCart(proposal(mandate.jti, { proposedBy: agentIssuer('other-platform', 'bot') })), 'FORBIDDEN');
    await failsWith(wallet.proposeCart(proposal('nope')), 'NOT_FOUND');
  });

  it('refuses a merchant the wallet does not know', async () => {
    const { mandate } = await setup();
    await failsWith(wallet.proposeCart(proposal(mandate.jti, { aud: merchantAudience('EVIL') })), 'UNKNOWN_MERCHANT');
  });

  it('refuses a cart outside the mandate and says why', async () => {
    const { mandate } = await setup();
    const over = await failsWith(wallet.proposeCart(proposal(mandate.jti, { lines: [line({ unitPriceCents: 12_001 })] })), 'OUT_OF_SCOPE');
    expect(over.problems.join(' ')).toMatch(/exceeds max_total/);
    const many = await failsWith(wallet.proposeCart(proposal(mandate.jti, { lines: [line({ qty: 2, unitPriceCents: 1_000 })] })), 'OUT_OF_SCOPE');
    expect(many.problems.join(' ')).toMatch(/more than max_items/);
    const eur = await failsWith(wallet.proposeCart(proposal(mandate.jti, { currency: 'EUR' })), 'OUT_OF_SCOPE');
    expect(eur.problems.join(' ')).toMatch(/currency/);
  });

  it('leaves the category rule to the merchant but enforces the rest', async () => {
    const { mandate } = await setup({ categoriesAllow: ['office_furniture'] });
    expect((await wallet.proposeCart(proposal(mandate.jti))).status).toBe('pending');
  });

  it('refuses an expired mandate and a duplicate cart id', async () => {
    const { mandate } = await setup({ validForSeconds: 120 });
    const first = proposal(mandate.jti);
    await wallet.proposeCart(first);
    await failsWith(wallet.proposeCart(first), 'CONFLICT');
    w.clock.advanceSeconds(121);
    await failsWith(wallet.proposeCart(proposal(mandate.jti)), 'EXPIRED');
  });

  it('refuses an invalid cart', async () => {
    const { mandate } = await setup();
    await failsWith(wallet.proposeCart(proposal(mandate.jti, { lines: [] })), 'INVALID');
  });

  it('lists proposals for the owner, filtered by status', async () => {
    const { principal, mandate } = await setup();
    const a = await wallet.proposeCart(proposal(mandate.jti));
    w.clock.advanceSeconds(1);
    const b = await wallet.proposeCart(proposal(mandate.jti));
    await wallet.decline(principal.id, a.id);
    expect((await wallet.proposalsOf(principal.id)).map((p) => p.id)).toEqual([b.id, a.id]);
    expect((await wallet.proposalsOf(principal.id, 'pending')).map((p) => p.id)).toEqual([b.id]);
    expect(await wallet.proposalsOf('someone-else')).toEqual([]);
  });
});

describe('consent', () => {
  it('signs a consent that covers the cart, its jti, the audience, the screen and the mandate', async () => {
    const { principal, mandate } = await setup();
    const p = await wallet.proposeCart(proposal(mandate.jti));
    expect(await wallet.consentFor(p.cartJti)).toBeNull();
    const { proposal: approved, consent } = await wallet.approve(principal.id, p.id);
    expect(approved.status).toBe('approved');
    expect(consent).toMatchObject({ mode: 'human_present', method: 'click', presented_hash: p.presentedHash });
    const decoded = decodeConsent(consent.signature!);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.payload).toMatchObject({ typ: 'consent', cart_hash: p.cartHash, cart_jti: p.cartJti, aud: AUD, presented_hash: p.presentedHash, mandate_hash: mandate.hash, approved_at: consent.approved_at });
    const key = (await w.registry.lookup())(w.keys.wallet.kid)!;
    expect((await verifyJws(consent.signature!, key.publicKey)).ok).toBe(true);
    expect(await wallet.consentFor(p.cartJti)).toEqual(consent);
  });

  it('is idempotent: approving twice returns the first consent', async () => {
    const { principal, mandate } = await setup();
    const p = await wallet.proposeCart(proposal(mandate.jti));
    const first = await wallet.approve(principal.id, p.id);
    w.clock.advanceSeconds(30);
    const second = await wallet.approve(principal.id, p.id);
    expect(second.consent).toEqual(first.consent);
  });

  it('concurrent approvals produce one consent', async () => {
    const { principal, mandate } = await setup();
    const p = await wallet.proposeCart(proposal(mandate.jti));
    const results = await Promise.allSettled([wallet.approve(principal.id, p.id), wallet.approve(principal.id, p.id), wallet.approve(principal.id, p.id)]);
    const consents = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value.consent.signature] : []));
    expect(consents.length).toBeGreaterThanOrEqual(1);
    expect(new Set(consents).size).toBe(1);
    expect((await w.db.query('SELECT 1 FROM consents WHERE cart_jti = $1', [p.cartJti])).length).toBe(1);
  });

  it('only the owner can approve or decline', async () => {
    const { mandate } = await setup();
    const p = await wallet.proposeCart(proposal(mandate.jti));
    const other = await wallet.ensurePrincipal('visitor-0000002');
    await failsWith(wallet.approve(other.id, p.id), 'FORBIDDEN');
    await failsWith(wallet.decline(other.id, p.id), 'FORBIDDEN');
    await failsWith(wallet.approve(other.id, 'nope'), 'NOT_FOUND');
  });

  it('a declined cart cannot be approved, and an approved one cannot be declined', async () => {
    const { principal, mandate } = await setup();
    const declined = await wallet.proposeCart(proposal(mandate.jti));
    expect((await wallet.decline(principal.id, declined.id)).status).toBe('declined');
    await failsWith(wallet.approve(principal.id, declined.id), 'CONFLICT');
    const approved = await wallet.proposeCart(proposal(mandate.jti));
    await wallet.approve(principal.id, approved.id);
    await failsWith(wallet.decline(principal.id, approved.id), 'CONFLICT');
  });

  it('a proposal that waited too long expires', async () => {
    const { principal, mandate } = await setup();
    const p = await wallet.proposeCart(proposal(mandate.jti));
    w.clock.advanceSeconds(601);
    expect((await wallet.proposal(p.id))?.status).toBe('expired');
    await failsWith(wallet.approve(principal.id, p.id), 'EXPIRED');
  });

  it('refuses consent once the mandate is revoked or expired', async () => {
    const { principal, mandate } = await setup({ validForSeconds: 300 });
    const p = await wallet.proposeCart(proposal(mandate.jti));
    w.clock.advanceSeconds(301);
    const q = await wallet.proposeCart(proposal(mandate.jti)).catch((e: unknown) => e);
    expect(q).toBeInstanceOf(WalletError);
    await failsWith(wallet.approve(principal.id, p.id), 'EXPIRED');
  });

  it('a human_not_present mandate approves carts without a signature', async () => {
    const { mandate } = await setup({ mode: 'human_not_present' });
    const p = await wallet.proposeCart(proposal(mandate.jti));
    expect(p.status).toBe('approved');
    expect(await wallet.consentFor(p.cartJti)).toEqual(HUMAN_NOT_PRESENT_CONSENT);
  });

  it('answers the verifier\'s wallet-record question', async () => {
    const { principal, mandate } = await setup();
    const p = await wallet.proposeCart(proposal(mandate.jti));
    expect(await wallet.walletRecord({ cartJti: p.cartJti, cartHash: p.cartHash })).toBeNull();
    await wallet.approve(principal.id, p.id);
    expect(await wallet.walletRecord({ cartJti: p.cartJti, cartHash: p.cartHash })).toEqual({ presentedHash: p.presentedHash });
    expect(await wallet.walletRecord({ cartJti: p.cartJti, cartHash: 'sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })).toBeNull();
    expect(await wallet.walletRecord({ cartJti: 'unknown', cartHash: p.cartHash })).toBeNull();
  });
});
