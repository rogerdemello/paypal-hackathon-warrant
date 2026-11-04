import { FIXTURE_PRODUCTS, FixtureCatalog, listingHash, type Catalog } from '@warrant/catalog';
import { hashPayerId, merchantAudience, type Bundle, type CartLineInput } from '@warrant/warrant';
import { AGENT_ID, AGENT_ISS, AGENT_PLATFORM_ID } from '../src/identity';
import { ShoppingAgent } from '../src/services/agent';
import { AgentPlatform } from '../src/services/agent-platform';
import { RulesIntentParser, RulesProductPicker, type IntentParser, type ProductPicker } from '../src/services/intent';
import { RulesClaimExtractor, type ClaimExtractor } from '../src/services/claims';
import { DisputeService } from '../src/services/disputes';
import { TemplateNoteWriter, type NoteWriter } from '../src/services/notes';
import { registerIdentities } from '../src/services/bootstrap';
import { MerchantService, type CheckoutResult, type MerchantOptions } from '../src/services/merchant';
import { createPayPalGateway, type PayPalGateway } from '../src/services/paypal';
import { StoreService } from '../src/services/store';
import { WalletService, type MandateRecord, type MandateTerms, type Principal, type Proposal } from '../src/services/wallet';
import { simulatorSink } from '../src/services/webhooks';
import { makeServerWorld, type TestWorld } from './helpers';

export const MERCHANT_ID = 'SIMMERCHANT01';
export const AUD = merchantAudience(MERCHANT_ID);
export const DESK = FIXTURE_PRODUCTS.find((p) => p.category === 'office_furniture')!;
export const BOOK = FIXTURE_PRODUCTS.find((p) => p.category === 'books')!;

export interface Shop extends TestWorld {
  readonly wallet: WalletService;
  readonly store: StoreService;
  readonly merchant: MerchantService;
  readonly agent: AgentPlatform;
  readonly paypal: PayPalGateway;
  readonly disputes: DisputeService;
  readonly shopper: ShoppingAgent;
}

/** The whole demo wired against a fresh database, the PayPal simulator and a manual clock. */
export async function makeShop(options: { env?: Record<string, string>; velocity?: MerchantOptions['velocity']; claims?: ClaimExtractor; notes?: NoteWriter; catalog?: Catalog; intents?: IntentParser; picker?: ProductPicker } = {}): Promise<Shop> {
  const world = await makeServerWorld(options.env);
  await registerIdentities(world.registry, world.keys, world.clock);
  const store = new StoreService(world.db, world.clock);
  await store.seedFixtures();
  const wallet = new WalletService({ db: world.db, clock: world.clock, ids: world.ids, key: world.keys.wallet, merchants: new Map([[AUD, world.config.merchantName]]) });
  const paypal = createPayPalGateway(world.config, world.clock);
  const merchant = new MerchantService({ db: world.db, clock: world.clock, ids: world.ids, config: world.config, registry: world.registry, wallet, store, paypal, ...(options.velocity === undefined ? {} : { velocity: options.velocity }) });
  paypal.simulator?.setWebhookSink(simulatorSink(merchant));
  const agent = new AgentPlatform({ clock: world.clock, key: world.keys.agent, wallet });
  const disputes = new DisputeService({
    db: world.db,
    clock: world.clock,
    ids: world.ids,
    config: world.config,
    registry: world.registry,
    wallet,
    store,
    merchant,
    paypal,
    claims: options.claims ?? new RulesClaimExtractor(),
    notes: options.notes ?? new TemplateNoteWriter(),
  });
  merchant.onDisputeEvent((event) => disputes.handleEvent(event));
  const shopper = new ShoppingAgent({
    db: world.db,
    clock: world.clock,
    ids: world.ids,
    config: world.config,
    catalog: options.catalog ?? new FixtureCatalog(),
    store,
    wallet,
    platform: agent,
    merchant,
    intents: options.intents ?? new RulesIntentParser(),
    picker: options.picker ?? new RulesProductPicker(),
    agentKid: world.keys.agent.kid,
  });
  return { ...world, wallet, store, merchant, agent, paypal, disputes, shopper };
}

/** What preparing a bundle needs; a Shop satisfies it, and so does a Container (with `agent` = its platform). */
export type BundleDeps = Pick<Shop, 'wallet' | 'agent' | 'ids' | 'keys'>;

export const agentRef = (shop: Pick<Shop, 'keys'>) => ({ platform: AGENT_PLATFORM_ID, agentId: AGENT_ID, kid: shop.keys.agent.kid });

export const defaultTerms = (over: Partial<MandateTerms> = {}): MandateTerms => ({
  instructionText: 'Find a standing desk converter under $120',
  maxTotalCents: 12_000,
  maxItems: 1,
  categoriesAllow: null,
  mode: 'human_present',
  budgetMode: 'per_cart',
  ...over,
});

export const lineFor = (product = DESK, over: Partial<CartLineInput> = {}): CartLineInput => ({
  sku: product.id,
  title: product.title,
  qty: 1,
  unitPriceCents: product.priceCents,
  listingHash: listingHash(product),
  ...over,
});

export interface Purchase {
  readonly principal: Principal;
  readonly mandate: MandateRecord;
  readonly proposal: Proposal;
  readonly bundle: Bundle;
}

/** A principal with a mandate, one proposed and approved cart, and the signed bundle. Nothing sent to the merchant yet. */
export async function prepareBundle(
  shop: BundleDeps,
  options: { visitor?: string; terms?: Partial<MandateTerms>; lines?: CartLineInput[]; mandate?: MandateRecord; principal?: Principal; linkedPayerId?: string } = {},
): Promise<Purchase> {
  const principal = options.principal ?? (await shop.wallet.ensurePrincipal(options.visitor ?? 'visitor-0000001', 'Riley'));
  // A principal whose PayPal account is already linked: their mandates carry the payer hash (V11, fact F7).
  if (options.linkedPayerId !== undefined) await shop.wallet.bindPayer(principal.id, hashPayerId(options.linkedPayerId));
  const mandate = options.mandate ?? (await shop.wallet.issueMandate(principal.id, agentRef(shop), defaultTerms(options.terms)));
  const proposal = await shop.wallet.proposeCart({
    mandateJti: mandate.jti,
    cartJti: shop.ids.next('crt'),
    nonce: shop.ids.token(),
    aud: AUD,
    proposedBy: AGENT_ISS,
    lines: options.lines ?? [lineFor()],
    currency: 'USD',
  });
  if (proposal.status === 'pending') await shop.wallet.approve(principal.id, proposal.id);
  const bundle = await shop.agent.bundleFor(proposal.id);
  return { principal, mandate, proposal, bundle };
}

/** prepareBundle, then check out: the buyer is sent to PayPal. */
export async function checkoutNew(shop: Shop, options: Parameters<typeof prepareBundle>[1] = {}): Promise<Purchase & { result: CheckoutResult }> {
  const purchase = await prepareBundle(shop, options);
  const result = await shop.merchant.checkout(purchase.bundle);
  return { ...purchase, result };
}

/** The buyer approves at PayPal (as `payerId`) and the merchant completes the order. */
export async function pay(shop: Shop, orderId: string, payer = { payerId: 'SIMPAYER0001', email: 'buyer@example.com', name: 'Sandbox Buyer' }) {
  const order = await shop.merchant.order(orderId);
  if (order?.paypalOrderId === null || order === null) throw new Error('order has no PayPal order');
  shop.paypal.simulator?.approveOrder(order.paypalOrderId, payer);
  await shop.paypal.simulator?.flush();
  return shop.merchant.completeOrder(orderId);
}
