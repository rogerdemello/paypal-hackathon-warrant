import {
  HUMAN_NOT_PRESENT_CONSENT,
  agentIssuer,
  buildCartBody,
  buildCartPayload,
  buildHumanPresentConsent,
  buildMandate,
  formatInstant,
  formatMoney,
  hashCartBody,
  hashJson,
  hashMandate,
  mulCents,
  parseMoney,
  scopeProblems,
  signConsent,
  signMandate,
  type BudgetMode,
  type CartBody,
  type CartLineInput,
  type Cents,
  type Consent,
  type ConsentMode,
  type MandatePayload,
  type WalletRecord,
} from '@warrant/warrant';
import { nowSeconds, type Clock, type Ids } from '../clock';
import { isUniqueViolation, json, maybeOne, type Db, type Queryable } from '../db';
import { WALLET_ISS } from '../identity';
import type { KeyMaterial } from '../keys';

/**
 * The wallet: the human's side of Warrant. It holds the principal's signing key, signs mandates, shows every cart on a
 * consent screen it renders itself from the cart data, and signs the consent. The shopping agent proposes carts but
 * cannot produce the consent signature (docs/architecture.md section 1).
 */

export type WalletErrorCode = 'NOT_FOUND' | 'FORBIDDEN' | 'EXPIRED' | 'REVOKED' | 'OUT_OF_SCOPE' | 'INVALID' | 'CONFLICT' | 'UNKNOWN_MERCHANT';

export class WalletError extends Error {
  override readonly name = 'WalletError';
  constructor(
    readonly code: WalletErrorCode,
    message: string,
    readonly problems: readonly string[] = [],
  ) {
    super(message);
  }
}

export interface Principal {
  readonly id: string;
  readonly visitorId: string;
  readonly displayName: string;
  /** Hash of the PayPal payer id, learnt at the first approved order (trust on first use). */
  readonly payerIdHash: string | null;
  readonly createdAt: number;
}

export interface MandateTerms {
  readonly instructionText: string;
  readonly maxTotalCents: Cents;
  readonly maxPerItemCents?: Cents;
  readonly maxItems: number;
  /** Null: any category. */
  readonly categoriesAllow: readonly string[] | null;
  /** Merchant ids (or `paypal-merchant:<id>`); default is the one demo merchant. */
  readonly merchantsAllow?: readonly string[];
  readonly merchantsDeny?: readonly string[];
  readonly mode: ConsentMode;
  readonly budgetMode: BudgetMode;
  /** How long the mandate is valid. Default 24 hours, at most 30 days. */
  readonly validForSeconds?: number;
  readonly currency?: string;
}

export interface MandateRecord {
  readonly jti: string;
  readonly principalId: string;
  readonly hash: string;
  readonly payload: MandatePayload;
  readonly jws: string;
  readonly instructionText: string;
  readonly status: 'active' | 'revoked';
  readonly nbf: number;
  readonly exp: number;
  readonly createdAt: number;
  readonly revokedAt: number | null;
}

/** Exactly what the consent screen shows. Its hash is the `presented_hash` the principal's consent covers. */
export interface PresentedScreen {
  readonly screen: 'warrant.consent.v1';
  readonly merchant: { readonly audience: string; readonly name: string };
  readonly principal: string;
  readonly agent: string;
  readonly instruction: string;
  readonly items: ReadonlyArray<{ readonly sku: string; readonly title: string; readonly qty: number; readonly unit_price: string; readonly line_total: string }>;
  readonly currency: string;
  readonly total: string;
  readonly limits: { readonly max_total: string; readonly max_per_item: string; readonly max_items: number; readonly budget_mode: BudgetMode; readonly mode: ConsentMode };
  readonly expires_at: string;
}

export type ProposalStatus = 'pending' | 'approved' | 'declined' | 'expired';

export interface Proposal {
  readonly id: string;
  readonly mandateJti: string;
  readonly cartJti: string;
  readonly nonce: string;
  readonly aud: string;
  readonly proposedBy: string;
  readonly cart: CartBody;
  readonly cartHash: string;
  readonly presented: PresentedScreen;
  readonly presentedHash: string;
  readonly status: ProposalStatus;
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly decidedAt: number | null;
}

export interface ProposeCartInput {
  readonly mandateJti: string;
  readonly cartJti: string;
  readonly nonce: string;
  readonly aud: string;
  /** The agent's `iss`: must be the agent the mandate names. */
  readonly proposedBy: string;
  readonly lines: readonly CartLineInput[];
  readonly currency: string;
}

export interface WalletOptions {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly key: KeyMaterial;
  /** Merchants the wallet is willing to show: audience -> display name. */
  readonly merchants: ReadonlyMap<string, string>;
  /** How long a proposal can wait for the human. Default 10 minutes (a cart warrant lives at most 15). */
  readonly proposalTtlSeconds?: number;
}

const MAX_VALIDITY = 30 * 24 * 3600;
const DEFAULT_VALIDITY = 24 * 3600;

interface PrincipalRow {
  id: string;
  visitor_id: string;
  display_name: string;
  payer_id_hash: string | null;
  created_at: number;
}
interface MandateRow {
  jti: string;
  principal_id: string;
  hash: string;
  payload: MandatePayload;
  jws: string;
  instruction_text: string;
  status: 'active' | 'revoked';
  nbf: number;
  exp: number;
  created_at: number;
  revoked_at: number | null;
}
interface ProposalRow {
  id: string;
  mandate_jti: string;
  cart_jti: string;
  nonce: string;
  aud: string;
  proposed_by: string;
  cart: CartBody;
  cart_hash: string;
  presented: PresentedScreen;
  presented_hash: string;
  status: ProposalStatus;
  expires_at: number;
  created_at: number;
  decided_at: number | null;
}

const toPrincipal = (r: PrincipalRow): Principal => ({ id: r.id, visitorId: r.visitor_id, displayName: r.display_name, payerIdHash: r.payer_id_hash, createdAt: r.created_at });
const toMandate = (r: MandateRow): MandateRecord => ({
  jti: r.jti,
  principalId: r.principal_id,
  hash: r.hash,
  payload: r.payload,
  jws: r.jws,
  instructionText: r.instruction_text,
  status: r.status,
  nbf: r.nbf,
  exp: r.exp,
  createdAt: r.created_at,
  revokedAt: r.revoked_at,
});
const toProposal = (r: ProposalRow): Proposal => ({
  id: r.id,
  mandateJti: r.mandate_jti,
  cartJti: r.cart_jti,
  nonce: r.nonce,
  aud: r.aud,
  proposedBy: r.proposed_by,
  cart: r.cart,
  cartHash: r.cart_hash,
  presented: r.presented,
  presentedHash: r.presented_hash,
  status: r.status,
  expiresAt: r.expires_at,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
});

const PROPOSAL_COLUMNS = 'id, mandate_jti, cart_jti, nonce, aud, proposed_by, cart, cart_hash, presented, presented_hash, status, expires_at, created_at, decided_at';
const MANDATE_COLUMNS = 'jti, principal_id, hash, payload, jws, instruction_text, status, nbf, exp, created_at, revoked_at';

export class WalletService {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: Ids;
  private readonly key: KeyMaterial;
  private readonly merchants: ReadonlyMap<string, string>;
  private readonly proposalTtl: number;

  constructor(options: WalletOptions) {
    this.db = options.db;
    this.clock = options.clock;
    this.ids = options.ids;
    this.key = options.key;
    this.merchants = options.merchants;
    this.proposalTtl = options.proposalTtlSeconds ?? 600;
  }

  // ---- principals ---------------------------------------------------------------------------------------------------

  /** The principal for a browser visitor, created on first sight. */
  async ensurePrincipal(visitorId: string, displayName = 'Demo Shopper'): Promise<Principal> {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(visitorId)) throw new WalletError('INVALID', 'visitor id must be 8-128 characters of A-Z a-z 0-9 _ -');
    const id = this.ids.next('prn');
    await this.db.query('INSERT INTO principals (id, visitor_id, display_name, payer_id_hash, created_at) VALUES ($1, $2, $3, NULL, $4) ON CONFLICT (visitor_id) DO NOTHING', [
      id,
      visitorId,
      displayName.slice(0, 80),
      nowSeconds(this.clock),
    ]);
    const row = maybeOne(await this.db.query<PrincipalRow>('SELECT id, visitor_id, display_name, payer_id_hash, created_at FROM principals WHERE visitor_id = $1', [visitorId]));
    if (row === null) throw new WalletError('NOT_FOUND', 'principal could not be created');
    return toPrincipal(row);
  }

  async principal(id: string, q: Queryable = this.db): Promise<Principal | null> {
    const row = maybeOne(await q.query<PrincipalRow>('SELECT id, visitor_id, display_name, payer_id_hash, created_at FROM principals WHERE id = $1', [id]));
    return row === null ? null : toPrincipal(row);
  }

  /**
   * Trust on first use (V11): remember which PayPal payer this principal pays with. Returns false when a different payer is
   * already bound, which the caller must treat as a mismatch.
   */
  async bindPayer(principalId: string, payerIdHash: string): Promise<boolean> {
    await this.db.query('UPDATE principals SET payer_id_hash = $2 WHERE id = $1 AND payer_id_hash IS NULL', [principalId, payerIdHash]);
    const principal = await this.principal(principalId);
    return principal?.payerIdHash === payerIdHash;
  }

  // ---- mandates -----------------------------------------------------------------------------------------------------

  /**
   * Sign a mandate for `principalId`. This is the human's act of delegation: the UI shows the terms and calls this only
   * after the principal confirms them.
   */
  async issueMandate(principalId: string, agent: { platform: string; agentId: string; kid: string }, terms: MandateTerms): Promise<MandateRecord> {
    const principal = await this.principal(principalId);
    if (principal === null) throw new WalletError('NOT_FOUND', 'unknown principal');
    const problems = this.termProblems(terms);
    if (problems.length > 0) throw new WalletError('INVALID', 'the mandate terms are not acceptable', problems);

    const now = nowSeconds(this.clock);
    const validFor = terms.validForSeconds ?? DEFAULT_VALIDITY;
    const merchantsAllow = terms.merchantsAllow ?? [...this.merchants.keys()].map((aud) => aud.slice('paypal-merchant:'.length));
    let payload: MandatePayload;
    try {
      payload = buildMandate({
        jti: this.ids.next('mdt'),
        iss: WALLET_ISS,
        iat: now,
        nbf: now,
        exp: now + validFor,
        principalRef: principal.id,
        ...(principal.payerIdHash === null ? {} : { principalPayerIdHash: principal.payerIdHash }),
        agent,
        instructionText: terms.instructionText,
        scope: {
          currency: terms.currency ?? 'USD',
          maxTotalCents: terms.maxTotalCents,
          maxPerItemCents: terms.maxPerItemCents ?? terms.maxTotalCents,
          maxItems: terms.maxItems,
          categoriesAllow: terms.categoriesAllow,
          merchantsAllow,
          merchantsDeny: [...(terms.merchantsDeny ?? [])],
          mode: terms.mode,
          budgetMode: terms.budgetMode,
        },
      });
    } catch (error) {
      throw new WalletError('INVALID', error instanceof Error ? error.message : 'invalid mandate');
    }
    const signed = await signMandate(payload, this.key.privateKey, this.key.kid);
    const hash = hashMandate(payload);
    await this.db.query(
      'INSERT INTO mandates (jti, principal_id, hash, payload, jws, instruction_text, status, nbf, exp, created_at, revoked_at) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,NULL)',
      [payload.jti, principal.id, hash, json(payload), signed.jws, terms.instructionText, 'active', payload.nbf, payload.exp, now],
    );
    return (await this.mandate(payload.jti)) as MandateRecord;
  }

  private termProblems(terms: MandateTerms): string[] {
    const problems: string[] = [];
    if (terms.instructionText.trim().length === 0 || terms.instructionText.length > 1000) problems.push('the instruction must be 1-1000 characters');
    if (!Number.isSafeInteger(terms.maxTotalCents) || terms.maxTotalCents <= 0) problems.push('the budget must be a positive amount');
    if (terms.maxTotalCents > 10_000_000) problems.push('the budget is above the demo limit of 100,000.00');
    if (terms.maxPerItemCents !== undefined && (!Number.isSafeInteger(terms.maxPerItemCents) || terms.maxPerItemCents <= 0)) problems.push('the per-item limit must be a positive amount');
    if (!Number.isSafeInteger(terms.maxItems) || terms.maxItems < 1 || terms.maxItems > 100) problems.push('the item limit must be between 1 and 100');
    if (terms.validForSeconds !== undefined && (!Number.isSafeInteger(terms.validForSeconds) || terms.validForSeconds < 60 || terms.validForSeconds > MAX_VALIDITY)) {
      problems.push('the mandate must be valid for between 1 minute and 30 days');
    }
    return problems;
  }

  async mandate(jti: string, q: Queryable = this.db): Promise<MandateRecord | null> {
    const row = maybeOne(await q.query<MandateRow>(`SELECT ${MANDATE_COLUMNS} FROM mandates WHERE jti = $1`, [jti]));
    return row === null ? null : toMandate(row);
  }

  async mandatesOf(principalId: string): Promise<MandateRecord[]> {
    return (await this.db.query<MandateRow>(`SELECT ${MANDATE_COLUMNS} FROM mandates WHERE principal_id = $1 ORDER BY created_at DESC, jti DESC`, [principalId])).map(toMandate);
  }

  /** Stop the agent buying under this mandate. Takes effect for every cart the wallet has not yet signed a consent for. */
  async revokeMandate(principalId: string, jti: string): Promise<MandateRecord> {
    const mandate = await this.mandate(jti);
    if (mandate === null) throw new WalletError('NOT_FOUND', 'unknown mandate');
    if (mandate.principalId !== principalId) throw new WalletError('FORBIDDEN', 'this mandate belongs to someone else');
    const now = nowSeconds(this.clock);
    await this.db.query("UPDATE mandates SET status = 'revoked', revoked_at = $2 WHERE jti = $1 AND status = 'active'", [jti, now]);
    await this.db.query("UPDATE proposals SET status = 'declined', decided_at = $2 WHERE mandate_jti = $1 AND status = 'pending'", [jti, now]);
    return (await this.mandate(jti)) as MandateRecord;
  }

  // ---- proposals and consent ----------------------------------------------------------------------------------------

  /**
   * The agent proposes a cart. The wallet checks it against the mandate, renders the consent screen itself and records
   * what it showed. For a `human_not_present` mandate the proposal is approved at once, with no consent signature.
   */
  async proposeCart(input: ProposeCartInput): Promise<Proposal> {
    const now = nowSeconds(this.clock);
    const mandate = await this.mandate(input.mandateJti);
    if (mandate === null) throw new WalletError('NOT_FOUND', 'unknown mandate');
    if (mandate.status === 'revoked') throw new WalletError('REVOKED', 'the principal has revoked this mandate');
    if (now < mandate.nbf || now > mandate.exp) throw new WalletError('EXPIRED', 'the mandate is outside its validity window');
    const agent = mandate.payload.agent;
    if (input.proposedBy !== agentIssuer(agent.platform, agent.agent_id)) throw new WalletError('FORBIDDEN', 'only the agent named in the mandate can propose carts under it');
    const merchantName = this.merchants.get(input.aud);
    if (merchantName === undefined) throw new WalletError('UNKNOWN_MERCHANT', `the wallet does not know merchant ${input.aud}`);

    let cart: CartBody;
    try {
      cart = buildCartBody(input.currency, input.lines);
    } catch (error) {
      throw new WalletError('INVALID', error instanceof Error ? error.message : 'invalid cart');
    }
    const cartHash = hashCartBody(cart);
    const merchantId = input.aud.slice('paypal-merchant:'.length);
    // The same per-cart scope rules the merchant will apply (V09), so the human is never shown a cart that cannot pass.
    const probe = buildCartPayload({
      jti: input.cartJti,
      iss: input.proposedBy,
      aud: input.aud,
      iat: now,
      exp: now + 600,
      nonce: input.nonce,
      mandate: { jti: mandate.jti, hash: mandate.hash },
      cart,
      consent: HUMAN_NOT_PRESENT_CONSENT,
    });
    // The wallet does not know the merchant's categories, so the category rule is left to the merchant's own check.
    const problems = scopeProblems(mandate.payload, probe, merchantId, () => null).filter((p) => !p.endsWith('but the mandate restricts categories'));
    if (problems.length > 0) throw new WalletError('OUT_OF_SCOPE', 'the cart is outside what the mandate allows', problems);

    const principal = await this.principal(mandate.principalId);
    const presented = this.presentedScreen(mandate, principal?.displayName ?? 'Shopper', input, cart, merchantName, now + this.proposalTtl);
    const presentedHash = hashJson(presented);
    const autoApprove = mandate.payload.scope.mode === 'human_not_present';
    const id = this.ids.next('prp');
    try {
      await this.db.query(
        `INSERT INTO proposals (${PROPOSAL_COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11,$12,$13,$14)`,
        [id, mandate.jti, input.cartJti, input.nonce, input.aud, input.proposedBy, json(cart), cartHash, json(presented), presentedHash, autoApprove ? 'approved' : 'pending', now + this.proposalTtl, now, autoApprove ? now : null],
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new WalletError('CONFLICT', 'a cart with this id has already been proposed');
      throw error;
    }
    return (await this.proposal(id)) as Proposal;
  }

  private presentedScreen(mandate: MandateRecord, principalName: string, input: ProposeCartInput, cart: CartBody, merchantName: string, expiresAt: number): PresentedScreen {
    const scope = mandate.payload.scope;
    return {
      screen: 'warrant.consent.v1',
      merchant: { audience: input.aud, name: merchantName },
      principal: principalName,
      agent: input.proposedBy,
      instruction: mandate.payload.instruction.text,
      items: cart.items.map((line) => ({
        sku: line.sku,
        title: line.title,
        qty: line.qty,
        unit_price: line.unit_price,
        line_total: formatMoney(mulCents(parseMoney(line.unit_price), line.qty)),
      })),
      currency: cart.currency,
      total: cart.total,
      limits: { max_total: scope.max_total, max_per_item: scope.max_per_item, max_items: scope.max_items, budget_mode: scope.budget_mode, mode: scope.mode },
      expires_at: formatInstant(expiresAt),
    };
  }

  async proposal(id: string, q: Queryable = this.db): Promise<Proposal | null> {
    const row = maybeOne(await q.query<ProposalRow>(`SELECT ${PROPOSAL_COLUMNS} FROM proposals WHERE id = $1`, [id]));
    return row === null ? null : this.expireIfDue(toProposal(row));
  }

  async proposalByCartJti(cartJti: string): Promise<Proposal | null> {
    const row = maybeOne(await this.db.query<ProposalRow>(`SELECT ${PROPOSAL_COLUMNS} FROM proposals WHERE cart_jti = $1`, [cartJti]));
    return row === null ? null : this.expireIfDue(toProposal(row));
  }

  /** Proposals under a principal's mandates, newest first. */
  async proposalsOf(principalId: string, status?: ProposalStatus): Promise<Proposal[]> {
    const rows = await this.db.query<ProposalRow>(
      `SELECT ${PROPOSAL_COLUMNS.split(', ').map((c) => `p.${c}`).join(', ')} FROM proposals p JOIN mandates m ON m.jti = p.mandate_jti
       WHERE m.principal_id = $1 ${status === undefined ? '' : 'AND p.status = $2'} ORDER BY p.created_at DESC, p.id DESC`,
      status === undefined ? [principalId] : [principalId, status],
    );
    return rows.map((r) => this.expireIfDue(toProposal(r)));
  }

  private expireIfDue(p: Proposal): Proposal {
    return p.status === 'pending' && nowSeconds(this.clock) > p.expiresAt ? { ...p, status: 'expired' } : p;
  }

  /**
   * The principal approves a pending proposal: the wallet signs a consent over the cart hash, the cart's jti and audience,
   * the hash of the screen it showed, the time and the mandate. Idempotent: approving twice returns the first consent.
   */
  async approve(principalId: string, proposalId: string, method: 'click' | 'passkey' = 'click'): Promise<{ proposal: Proposal; consent: Consent }> {
    const proposal = await this.ownedProposal(principalId, proposalId);
    const existing = await this.consentFor(proposal.cartJti);
    if (proposal.status === 'approved' && existing !== null) return { proposal, consent: existing };
    if (proposal.status === 'declined') throw new WalletError('CONFLICT', 'this cart was declined');
    if (proposal.status === 'expired') throw new WalletError('EXPIRED', 'this cart is no longer valid; ask the agent to propose it again');
    const mandate = await this.mandate(proposal.mandateJti);
    if (mandate === null || mandate.status === 'revoked') throw new WalletError('REVOKED', 'the mandate for this cart has been revoked');
    const now = nowSeconds(this.clock);
    if (now > mandate.exp) throw new WalletError('EXPIRED', 'the mandate has expired');

    const approvedAt = formatInstant(now);
    const signed = await signConsent(
      { cartHash: proposal.cartHash, cartJti: proposal.cartJti, aud: proposal.aud, presentedHash: proposal.presentedHash, approvedAt, mandateHash: mandate.hash },
      this.key.privateKey,
      this.key.kid,
    );
    await this.db.transaction(async (tx) => {
      const claimed = await tx.query("UPDATE proposals SET status = 'approved', decided_at = $2 WHERE id = $1 AND status = 'pending' RETURNING id", [proposal.id, now]);
      if (claimed.length === 0) throw new WalletError('CONFLICT', 'this cart was already decided');
      await tx.query('INSERT INTO consents (cart_jti, proposal_id, mandate_jti, aud, cart_hash, presented_hash, approved_at, method, signature, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [
        proposal.cartJti,
        proposal.id,
        proposal.mandateJti,
        proposal.aud,
        proposal.cartHash,
        proposal.presentedHash,
        approvedAt,
        method,
        signed.jws,
        now,
      ]);
    });
    const consent = (await this.consentFor(proposal.cartJti)) as Consent;
    return { proposal: (await this.proposal(proposal.id)) as Proposal, consent };
  }

  async decline(principalId: string, proposalId: string): Promise<Proposal> {
    const proposal = await this.ownedProposal(principalId, proposalId);
    if (proposal.status === 'approved') throw new WalletError('CONFLICT', 'this cart was already approved');
    await this.db.query("UPDATE proposals SET status = 'declined', decided_at = $2 WHERE id = $1 AND status = 'pending'", [proposal.id, nowSeconds(this.clock)]);
    return (await this.proposal(proposal.id)) as Proposal;
  }

  private async ownedProposal(principalId: string, proposalId: string): Promise<Proposal> {
    const proposal = await this.proposal(proposalId);
    if (proposal === null) throw new WalletError('NOT_FOUND', 'unknown cart proposal');
    const mandate = await this.mandate(proposal.mandateJti);
    if (mandate?.principalId !== principalId) throw new WalletError('FORBIDDEN', 'this cart belongs to someone else');
    return proposal;
  }

  /**
   * The consent object to put in the cart warrant: the signed consent for a human_present approval, the empty
   * `human_not_present` consent for an auto-approved proposal, or null when nothing has been approved.
   */
  async consentFor(cartJti: string): Promise<Consent | null> {
    const row = maybeOne(await this.db.query<{ approved_at: string; method: 'click' | 'passkey'; presented_hash: string; signature: string }>('SELECT approved_at, method, presented_hash, signature FROM consents WHERE cart_jti = $1', [cartJti]));
    if (row !== null) return buildHumanPresentConsent({ approvedAt: row.approved_at, method: row.method, presentedHash: row.presented_hash, signature: row.signature });
    const proposal = await this.proposalByCartJti(cartJti);
    if (proposal?.status !== 'approved') return null;
    const mandate = await this.mandate(proposal.mandateJti);
    return mandate?.payload.scope.mode === 'human_not_present' ? HUMAN_NOT_PRESENT_CONSENT : null;
  }

  /** V10's `walletRecord`: what the wallet recorded when it showed this cart. Null when it never did (or the human declined). */
  async walletRecord(key: { cartJti: string; cartHash: string }, q: Queryable = this.db): Promise<WalletRecord | null> {
    const row = maybeOne(await q.query<{ presented_hash: string; cart_hash: string; status: ProposalStatus }>('SELECT presented_hash, cart_hash, status FROM proposals WHERE cart_jti = $1', [key.cartJti]));
    if (row === null || row.cart_hash !== key.cartHash || row.status !== 'approved') return null;
    return { presentedHash: row.presented_hash };
  }
}
