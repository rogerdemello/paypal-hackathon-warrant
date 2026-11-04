import { CatalogError, RISKY_CATEGORIES, budgetFromText, isAvailable, type Catalog, type Product } from '@warrant/catalog';
import { formatMoney, merchantAudience, type CartLineInput } from '@warrant/warrant';
import type { AgentMessageDto, AgentPart, AgentSessionDto, FindingDto, MandateTermsDto, ProductDto } from '../api-types';
import { nowSeconds, type Clock, type Ids } from '../clock';
import type { Config } from '../config';
import { json, maybeOne, type Db } from '../db';
import { AGENT_ID, AGENT_ISS, AGENT_PLATFORM_ID } from '../identity';
import type { AgentPlatform } from './agent-platform';
import { eligible, type Intent, type IntentParser, type ProductPicker } from './intent';
import type { MerchantService } from './merchant';
import type { StoreProduct, StoreService } from './store';
import { WalletError, type MandateTerms, type WalletService } from './wallet';

/**
 * The shopping agent: the untrusted party. It turns a request into search results and a proposed cart, and asks the wallet
 * for everything that needs the human: the mandate (their delegation) and the cart approval (their consent). It cannot
 * sign either. A model, when configured, only parses the request and chooses among results; deterministic checks overrule
 * it (see intent.ts), and the wallet and the merchant re-check everything it produces.
 */

export class AgentError extends Error {
  override readonly name = 'AgentError';
  constructor(
    readonly code: 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT' | 'INVALID',
    message: string,
  ) {
    super(message);
  }
}

type Stage = AgentSessionDto['stage'];

interface AgentState {
  stage: Stage;
  intent: Intent | null;
  terms: MandateTermsDto | null;
  suggestedCategories: string[];
  proposalId: string | null;
  orderId: string | null;
}

const EMPTY_STATE: AgentState = { stage: 'start', intent: null, terms: null, suggestedCategories: [], proposalId: null, orderId: null };

export interface ShoppingAgentOptions {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly config: Config;
  readonly catalog: Catalog;
  readonly store: StoreService;
  readonly wallet: WalletService;
  readonly platform: AgentPlatform;
  readonly merchant: MerchantService;
  readonly intents: IntentParser;
  readonly picker: ProductPicker;
  /** Mandate kid of the agent platform's signing key. */
  readonly agentKid: string;
}

interface SessionRow {
  id: string;
  principal_id: string;
  mandate_jti: string | null;
  state: AgentState;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  id: string;
  seq: number;
  role: 'user' | 'assistant';
  parts: AgentPart[];
  created_at: number;
}

const productDto = (p: Product): ProductDto => ({
  sku: p.id,
  title: p.title,
  brand: p.brand,
  category: p.category,
  imageUrl: p.imageUrl,
  priceCents: p.priceCents,
  currency: p.currency,
  merchantDomain: p.merchantDomain,
  available: isAvailable(p),
});

const money = (cents: number) => `$${formatMoney(cents)}`;

export class ShoppingAgent {
  private readonly o: ShoppingAgentOptions;
  constructor(options: ShoppingAgentOptions) {
    this.o = options;
  }

  // ---- sessions -----------------------------------------------------------------------------------------------------

  async startSession(principalId: string): Promise<AgentSessionDto> {
    const principal = await this.o.wallet.principal(principalId);
    if (principal === null) throw new AgentError('NOT_FOUND', 'unknown principal');
    const id = this.o.ids.next('ses');
    const now = nowSeconds(this.o.clock);
    await this.o.db.query('INSERT INTO agent_sessions (id, principal_id, mandate_jti, state, created_at, updated_at) VALUES ($1,$2,NULL,$3::jsonb,$4,$4)', [id, principalId, json(EMPTY_STATE), now]);
    await this.append(id, 'assistant', [
      { kind: 'text', text: 'Hi, I\'m your shopping agent. Tell me what you\'d like to buy and your budget, for example "a standing desk converter under $120". I can search and prepare a cart, but I can\'t spend anything until you authorise it.' },
    ]);
    return this.getSession(id, principalId);
  }

  async getSession(sessionId: string, principalId: string): Promise<AgentSessionDto> {
    const row = await this.load(sessionId, principalId);
    const messages = await this.o.db.query<MessageRow>('SELECT id, seq, role, parts, created_at FROM agent_messages WHERE session_id = $1 ORDER BY seq', [sessionId]);
    return {
      id: row.id,
      mandateJti: row.mandate_jti,
      stage: row.state.stage,
      createdAt: row.created_at,
      messages: messages.map((m): AgentMessageDto => ({ id: m.id, seq: m.seq, role: m.role, parts: m.parts, createdAt: m.created_at })),
    };
  }

  /** The newest session of a principal, if any (so a reload keeps the conversation). */
  async latestSession(principalId: string): Promise<AgentSessionDto | null> {
    const row = maybeOne(await this.o.db.query<{ id: string }>('SELECT id FROM agent_sessions WHERE principal_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [principalId]));
    return row === null ? null : this.getSession(row.id, principalId);
  }

  private async load(sessionId: string, principalId: string): Promise<SessionRow> {
    const row = maybeOne(await this.o.db.query<SessionRow>('SELECT id, principal_id, mandate_jti, state, created_at, updated_at FROM agent_sessions WHERE id = $1', [sessionId]));
    if (row === null) throw new AgentError('NOT_FOUND', 'unknown session');
    if (row.principal_id !== principalId) throw new AgentError('FORBIDDEN', 'this conversation belongs to someone else');
    return row;
  }

  private async save(sessionId: string, state: AgentState, mandateJti?: string | null): Promise<void> {
    await this.o.db.query('UPDATE agent_sessions SET state = $2::jsonb, mandate_jti = COALESCE($3, mandate_jti), updated_at = $4 WHERE id = $1', [sessionId, json(state), mandateJti ?? null, nowSeconds(this.o.clock)]);
  }

  private async append(sessionId: string, role: 'user' | 'assistant', parts: AgentPart[]): Promise<void> {
    await this.o.db.query(
      'INSERT INTO agent_messages (id, session_id, seq, role, parts, created_at) VALUES ($1, $2, COALESCE((SELECT MAX(seq) FROM agent_messages WHERE session_id = $2), 0) + 1, $3, $4::jsonb, $5)',
      [this.o.ids.next('msg'), sessionId, role, json(parts), nowSeconds(this.o.clock)],
    );
  }

  // ---- 1. the request -----------------------------------------------------------------------------------------------

  async sendMessage(sessionId: string, principalId: string, text: string, visitorId?: string): Promise<AgentSessionDto> {
    const row = await this.load(sessionId, principalId);
    const clean = text.trim().slice(0, 1000);
    if (clean === '') throw new AgentError('INVALID', 'say what you would like to buy');
    const state = row.state;
    await this.append(sessionId, 'user', [{ kind: 'text', text: clean }]);

    if (state.stage === 'awaiting_consent' || state.stage === 'checking_out') {
      await this.append(sessionId, 'assistant', [{ kind: 'notice', level: 'info', text: state.stage === 'awaiting_consent' ? 'Please approve or decline the cart above first.' : 'Your order is waiting for payment at PayPal.' }]);
      return this.getSession(sessionId, principalId);
    }

    // A reply that just gives the missing budget ("120" or "$120") completes the earlier request.
    let intent: Intent;
    if (state.intent !== null && state.intent.budgetCents === null && state.stage === 'start') {
      const bare = /^\s*\$?\s*(\d{1,6}(?:\.\d{1,2})?)\s*(?:dollars?|usd|bucks)?\s*$/i.exec(clean);
      const cents = budgetFromText(clean) ?? (bare?.[1] === undefined ? null : Math.round(Number(bare[1]) * 100));
      intent = cents === null ? await this.o.intents.parse(clean, visitorId) : { ...state.intent, budgetCents: cents };
    } else {
      intent = await this.o.intents.parse(clean, visitorId);
    }

    if (intent.budgetCents === null) {
      await this.append(sessionId, 'assistant', [{ kind: 'text', text: `Happy to look for "${intent.query}". What's the most you want to spend?` }]);
      await this.save(sessionId, { ...EMPTY_STATE, stage: 'start', intent });
      return this.getSession(sessionId, principalId);
    }
    if (intent.budgetCents <= 0 || intent.budgetCents > 10_000_000) {
      await this.append(sessionId, 'assistant', [{ kind: 'notice', level: 'warn', text: 'I can only work with budgets between $0.01 and $100,000.00 in this demo.' }]);
      return this.getSession(sessionId, principalId);
    }

    const unitMax = Math.floor(intent.budgetCents / intent.quantity);
    let found: Product[];
    try {
      found = await this.o.catalog.search(intent.query, { maxPriceCents: unitMax, limit: 8 });
    } catch (error) {
      if (!(error instanceof CatalogError)) throw error;
      await this.append(sessionId, 'assistant', [{ kind: 'notice', level: 'error', text: `Product search is unavailable right now (${error.message}). Please try again in a moment.` }]);
      return this.getSession(sessionId, principalId);
    }
    const usable = found.filter((p) => eligible(p, intent));
    if (usable.length === 0) {
      await this.append(sessionId, 'assistant', [{ kind: 'text', text: `I couldn't find anything for "${intent.query}" within ${money(intent.budgetCents)} that's in stock. Try a different product or a higher budget.` }]);
      await this.save(sessionId, { ...EMPTY_STATE, stage: 'start' });
      return this.getSession(sessionId, principalId);
    }

    // Restrict the mandate to the kinds of product the request is about (V09 then refuses anything else, such as a gift card).
    const suggested = [...new Set(usable.slice(0, 4).map((p) => p.category))];
    const terms: MandateTermsDto = {
      instructionText: clean,
      maxTotalCents: intent.budgetCents,
      maxPerItemCents: unitMax,
      maxItems: intent.quantity,
      categoriesAllow: suggested,
      mode: 'human_present',
      budgetMode: 'cumulative',
      validForSeconds: 24 * 3600,
    };
    await this.append(sessionId, 'assistant', [
      { kind: 'text', text: `I can look for "${intent.query}" up to ${money(intent.budgetCents)}. To shop for you I need your permission first. This is what I would be allowed to do:` },
      { kind: 'mandate_request', terms, suggestedCategories: suggested, resolved: false },
    ]);
    await this.save(sessionId, { stage: 'awaiting_mandate', intent, terms, suggestedCategories: suggested, proposalId: null, orderId: null });
    return this.getSession(sessionId, principalId);
  }

  // ---- 2. the mandate -----------------------------------------------------------------------------------------------

  /** The human confirms (and may tighten) the terms; the wallet signs the mandate; the agent then shops and proposes a cart. */
  async authorizeMandate(sessionId: string, principalId: string, edits: Partial<MandateTermsDto> = {}, visitorId?: string): Promise<AgentSessionDto> {
    const row = await this.load(sessionId, principalId);
    const state = row.state;
    if (state.stage !== 'awaiting_mandate' || state.terms === null || state.intent === null) throw new AgentError('CONFLICT', 'there is no request waiting for your permission');
    const terms = this.applyEdits(state.terms, edits);
    const walletTerms: MandateTerms = {
      instructionText: terms.instructionText,
      maxTotalCents: terms.maxTotalCents,
      maxPerItemCents: terms.maxPerItemCents,
      maxItems: terms.maxItems,
      categoriesAllow: terms.categoriesAllow === null ? null : [...terms.categoriesAllow],
      mode: terms.mode,
      budgetMode: terms.budgetMode,
      validForSeconds: terms.validForSeconds,
    };
    let mandateJti: string;
    try {
      const mandate = await this.o.wallet.issueMandate(principalId, { platform: AGENT_PLATFORM_ID, agentId: AGENT_ID, kid: this.o.agentKid }, walletTerms);
      mandateJti = mandate.jti;
    } catch (error) {
      if (error instanceof WalletError) throw new AgentError('INVALID', error.problems.length > 0 ? error.problems.join('; ') : error.message);
      throw error;
    }
    await this.append(sessionId, 'assistant', [{ kind: 'text', text: `Your wallet signed the mandate (up to ${money(terms.maxTotalCents)}, ${terms.maxItems} item${terms.maxItems === 1 ? '' : 's'}, valid for ${Math.round(terms.validForSeconds / 3600)} hours). Searching now.` }]);
    const intent: Intent = { ...state.intent, budgetCents: terms.maxTotalCents, quantity: terms.maxItems };
    await this.save(sessionId, { ...state, stage: 'start', intent, terms, proposalId: null }, mandateJti);
    return this.proposeFor(sessionId, principalId, mandateJti, intent, terms, visitorId);
  }

  /** The human can narrow what the agent proposed, never widen the sanity limits. */
  private applyEdits(terms: MandateTermsDto, edits: Partial<MandateTermsDto>): MandateTermsDto {
    const next: MandateTermsDto = {
      ...terms,
      ...(edits.maxTotalCents === undefined ? {} : { maxTotalCents: edits.maxTotalCents }),
      ...(edits.maxPerItemCents === undefined ? {} : { maxPerItemCents: edits.maxPerItemCents }),
      ...(edits.maxItems === undefined ? {} : { maxItems: edits.maxItems }),
      ...(edits.categoriesAllow === undefined ? {} : { categoriesAllow: edits.categoriesAllow }),
      ...(edits.mode === undefined ? {} : { mode: edits.mode }),
      ...(edits.budgetMode === undefined ? {} : { budgetMode: edits.budgetMode }),
      ...(edits.validForSeconds === undefined ? {} : { validForSeconds: edits.validForSeconds }),
    };
    const risky = new Set<string>(RISKY_CATEGORIES);
    if (next.categoriesAllow !== null && next.categoriesAllow.some((c) => risky.has(c))) {
      throw new AgentError('INVALID', 'the demo does not let an agent be authorised to buy gift cards, prepaid cards, crypto, gambling or adult items');
    }
    if (next.maxPerItemCents > next.maxTotalCents) return { ...next, maxPerItemCents: next.maxTotalCents };
    return next;
  }

  // ---- 3. shopping and the cart -------------------------------------------------------------------------------------

  private async proposeFor(sessionId: string, principalId: string, mandateJti: string, intent: Intent, terms: MandateTermsDto, visitorId?: string): Promise<AgentSessionDto> {
    const unitMax = Math.floor(terms.maxTotalCents / Math.max(intent.quantity, 1));
    let found: Product[];
    try {
      found = await this.o.catalog.search(intent.query, { maxPriceCents: Math.min(unitMax, terms.maxPerItemCents), limit: 8 });
    } catch (error) {
      if (!(error instanceof CatalogError)) throw error;
      await this.append(sessionId, 'assistant', [{ kind: 'notice', level: 'error', text: `Product search is unavailable right now (${error.message}).` }]);
      return this.getSession(sessionId, principalId);
    }
    const allowed = terms.categoriesAllow;
    const candidates = found.filter((p) => allowed === null || allowed.includes(p.category));
    const pick = await this.o.picker.pick({ intent: { ...intent, budgetCents: terms.maxTotalCents }, candidates }, visitorId);
    const shown = candidates.slice(0, 4).map(productDto);
    if (pick.product === null) {
      await this.append(sessionId, 'assistant', [{ kind: 'products', items: shown, chosenSku: null, reason: null }, { kind: 'text', text: `Nothing I found fits ${money(terms.maxTotalCents)} and your mandate. Ask me for something else.` }]);
      await this.save(sessionId, { ...EMPTY_STATE });
      return this.getSession(sessionId, principalId);
    }

    // The merchant lists the item at the retailer's price; the cart is built from the merchant's own listing.
    const listed: StoreProduct = await this.o.store.list(pick.product);
    const line: CartLineInput = { sku: listed.sku, title: listed.title, qty: intent.quantity, unitPriceCents: listed.priceCents, listingHash: listed.listingHash };
    let proposal;
    try {
      proposal = await this.o.wallet.proposeCart({
        mandateJti,
        cartJti: this.o.ids.next('crt'),
        nonce: this.o.ids.token(),
        aud: merchantAudience(this.o.config.paypal.merchantId),
        proposedBy: AGENT_ISS,
        lines: [line],
        currency: listed.currency,
      });
    } catch (error) {
      if (!(error instanceof WalletError)) throw error;
      await this.append(sessionId, 'assistant', [{ kind: 'products', items: shown, chosenSku: listed.sku, reason: pick.reason }, { kind: 'notice', level: 'warn', text: `Your wallet would not show this cart: ${error.problems.length > 0 ? error.problems.join('; ') : error.message}` }]);
      await this.save(sessionId, { ...EMPTY_STATE });
      return this.getSession(sessionId, principalId);
    }

    const total = money(line.unitPriceCents * line.qty);
    const base: AgentPart[] = [
      { kind: 'products', items: shown, chosenSku: listed.sku, reason: pick.reason },
      { kind: 'text', text: `I picked "${listed.title}" at ${money(listed.priceCents)}${line.qty > 1 ? ` x ${line.qty} = ${total}` : ''}: ${pick.reason}.` },
    ];
    if (proposal.status === 'approved') {
      // human_not_present mandate: the wallet approved it within the mandate, so the agent goes straight to checkout.
      await this.append(sessionId, 'assistant', [...base, { kind: 'cart_proposal', proposalId: proposal.id }, { kind: 'text', text: 'Your mandate lets me buy within these limits without asking again, so I am checking out.' }]);
      await this.save(sessionId, { stage: 'awaiting_consent', intent, terms, suggestedCategories: [], proposalId: proposal.id, orderId: null });
      return this.checkout(sessionId, principalId);
    }
    await this.append(sessionId, 'assistant', [...base, { kind: 'cart_proposal', proposalId: proposal.id }, { kind: 'text', text: 'Review the cart above. Your wallet shows it exactly as I\'ll submit it, and nothing is bought until you approve.' }]);
    await this.save(sessionId, { stage: 'awaiting_consent', intent, terms, suggestedCategories: [], proposalId: proposal.id, orderId: null });
    return this.getSession(sessionId, principalId);
  }

  // ---- 4. checkout --------------------------------------------------------------------------------------------------

  /** After the human approved the cart in the wallet: sign the cart warrant and send the bundle to the merchant. */
  async checkout(sessionId: string, principalId: string): Promise<AgentSessionDto> {
    const row = await this.load(sessionId, principalId);
    const state = row.state;
    if (state.stage !== 'awaiting_consent' || state.proposalId === null) throw new AgentError('CONFLICT', 'there is no approved cart to check out');
    const proposal = await this.o.wallet.proposal(state.proposalId);
    if (proposal === null) throw new AgentError('NOT_FOUND', 'unknown cart');
    if (proposal.status !== 'approved') {
      throw new AgentError('CONFLICT', proposal.status === 'pending' ? 'approve the cart in your wallet first' : `the cart was ${proposal.status}`);
    }
    const bundle = await this.o.platform.bundleFor(proposal.id);
    const result = await this.o.merchant.checkout(bundle);
    const findings: FindingDto[] = result.findings.map((f) => ({ rule: f.rule, outcome: f.outcome, detail: f.detail }));
    const part: AgentPart = { kind: 'checkout', status: result.status, orderId: result.orderId, approvalUrl: result.approvalUrl, message: result.message, findings };
    const text: Record<typeof result.status, string> = {
      approval_required: 'The merchant verified your signed approval (every check passed). Continue to PayPal to pay.',
      pending_review: 'The merchant\'s checks passed with a question, so it is holding the order for a quick review.',
      rejected: `The merchant rejected the order: ${result.message.replace(/^checkout rejected: /, '')}`,
      failed: `The order could not be opened with PayPal: ${result.message}`,
    };
    await this.append(sessionId, 'assistant', [part, { kind: 'text', text: text[result.status] }]);
    const next: Stage = result.status === 'approval_required' || result.status === 'pending_review' ? 'checking_out' : 'done';
    await this.save(sessionId, { ...state, stage: next, orderId: result.orderId });
    return this.getSession(sessionId, principalId);
  }

  /** The buyer is back from PayPal: finish the order. */
  async completeOrder(sessionId: string, principalId: string): Promise<AgentSessionDto> {
    const row = await this.load(sessionId, principalId);
    const state = row.state;
    if (state.orderId === null) throw new AgentError('CONFLICT', 'there is no order in progress');
    const done = await this.o.merchant.completeOrder(state.orderId);
    if (done.status === 'awaiting_approval') {
      await this.append(sessionId, 'assistant', [{ kind: 'notice', level: 'info', text: 'PayPal has not confirmed your approval yet. Finish paying at PayPal, then come back.' }]);
      return this.getSession(sessionId, principalId);
    }
    const order = done.order;
    await this.append(sessionId, 'assistant', [
      { kind: 'order', orderId: order.id, status: order.status, totalCents: order.totalCents, currency: order.currency, cartJti: order.cartJti, message: done.status === 'captured' ? 'The payment went through.' : done.message },
      { kind: 'text', text: done.status === 'captured' ? 'Payment complete. The signed record of what you authorised is on the public verification page.' : `The order did not complete: ${done.message}` },
    ]);
    await this.save(sessionId, { ...state, stage: 'done' });
    return this.getSession(sessionId, principalId);
  }

  /** The human changed their mind about the cart. */
  async declineCart(sessionId: string, principalId: string): Promise<AgentSessionDto> {
    const row = await this.load(sessionId, principalId);
    const state = row.state;
    if (state.proposalId !== null) {
      const proposal = await this.o.wallet.proposal(state.proposalId);
      if (proposal?.status === 'pending') await this.o.wallet.decline(principalId, proposal.id);
    }
    await this.append(sessionId, 'assistant', [{ kind: 'text', text: 'No problem, I have cancelled that cart. What would you like instead?' }]);
    await this.save(sessionId, { ...EMPTY_STATE });
    return this.getSession(sessionId, principalId);
  }
}
