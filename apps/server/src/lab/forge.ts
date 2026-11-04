import {
  HUMAN_NOT_PRESENT_CONSENT,
  buildCartBody,
  buildCartPayload,
  buildMandate,
  decodeBundle,
  generateSigningKey,
  hashMandate,
  makeBundle,
  merchantAudience,
  parseBundle,
  signCart,
  signConsent,
  signMandate,
  decodeConsent,
  formatInstant,
  type Bundle,
  type CartLineInput,
  type CartPayload,
  type Consent,
  type MandatePayload,
} from '@warrant/warrant';
import type { Container } from '../container';
import { AGENT_ID, AGENT_ISS, AGENT_PLATFORM_ID, WALLET_ISS } from '../identity';
import type { MandateRecord, Proposal } from '../services/wallet';
import type { Attack, HonestBasedAttack, LineSpec, StandaloneAttack } from './scenario';

/**
 * Builds the tampered bundles of the adversarial scenarios. The server holds every key in the demo (wallet, agent platform
 * and the registry's), so it can play a compromised agent platform, a forger or a replayer faithfully: each attack is built
 * with the real signing code and then altered in the one way the scenario is about.
 */

export interface HonestBase {
  readonly mandate: MandateRecord;
  readonly proposal: Proposal;
  readonly bundle: Bundle;
  readonly lines: readonly CartLineInput[];
}

export interface Forged {
  readonly bundle: unknown;
  /** Runs just before checkout (revoke a key, change the store, move the clock). */
  readonly prepare?: () => Promise<void>;
  /** Submitted (and accepted) first, then `bundle` is the replay. */
  readonly submitFirst?: unknown;
  readonly description: string;
}

export interface ForgeEnv {
  readonly c: Container;
  readonly nowSeconds: number;
  /** The scenario's cart line for a sku, priced from the store. */
  readonly line: (spec: LineSpec) => Promise<CartLineInput>;
  /** The store sku that a scenario sku maps to (each run has its own copies of the products). */
  readonly storeSku: (sku: string) => string;
  readonly principalId: string;
  readonly principalRef: string;
}

/** Attacks that start from an honest, human-approved purchase and alter it. */
const HONEST_BASED: ReadonlySet<Attack['type']> = new Set<HonestBasedAttack['type']>([
  'edit_total',
  'edit_item_price',
  'wrong_key',
  'unknown_key',
  'swap_cart',
  'other_mandate_hash',
  'edit_instruction',
  'replay',
  'nonce_reuse',
  'other_merchant',
  'consent_for_other_merchant',
  'consent_fresh_jti',
  'expired_cart',
  'cart_too_long_lived',
  'cart_from_future',
  'price_changed',
  'item_unavailable',
  'listing_changed',
]);

export const isHonestBased = (attack: Attack): attack is HonestBasedAttack => HONEST_BASED.has(attack.type);

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const unb64 = (part: string | undefined): Record<string, unknown> => JSON.parse(Buffer.from(part ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;

/** Replace the payload of a compact JWS without re-signing it. */
function editPayload(jws: string, edit: (payload: Record<string, unknown>) => void): string {
  const [header, payload, signature] = jws.split('.');
  const body = unb64(payload);
  edit(body);
  return `${header}.${b64(body)}.${signature}`;
}

function cartOf(base: HonestBase): CartPayload {
  const decoded = decodeBundle(base.bundle);
  if (!decoded.cart.ok) throw new Error('the honest bundle has no readable cart');
  return decoded.cart.payload;
}

/** The agent platform signs a cart payload (this is what a compromised or malicious platform can always do). */
async function signedByAgent(env: ForgeEnv, payload: CartPayload): Promise<string> {
  return (await signCart(payload, env.c.keys.agent.privateKey, env.c.keys.agent.kid)).jws;
}

export async function forgeFromHonest(env: ForgeEnv, base: HonestBase, attack: HonestBasedAttack): Promise<Forged> {
  const { c } = env;
  const honestCart = cartOf(base);
  const bundleWith = (cartJws: string, mandateJws = base.mandate.jws): Bundle => makeBundle(mandateJws, cartJws);
  const resign = async (change: (cart: CartPayload) => CartPayload): Promise<Bundle> => bundleWith(await signedByAgent(env, change(honestCart)));

  switch (attack.type) {
    case 'edit_total': {
      const cartJws = editPayload(parseCart(base.bundle), (p) => {
        (p['cart'] as Record<string, unknown>)['total'] = '1.00';
      });
      return { bundle: bundleWith(cartJws), description: 'the cart total was edited after the agent platform signed it' };
    }
    case 'edit_item_price': {
      const cartJws = editPayload(parseCart(base.bundle), (p) => {
        const cart = p['cart'] as { items: Array<Record<string, unknown>>; total: string };
        if (cart.items[0] !== undefined) cart.items[0]['unit_price'] = '1.00';
        cart.total = '1.00';
      });
      return { bundle: bundleWith(cartJws), description: 'an item price and the total were edited after signing' };
    }
    case 'wrong_key': {
      const stranger = generateSigningKey();
      const jws = (await signCart(honestCart, stranger.privateKey, c.keys.agent.kid)).jws;
      return { bundle: bundleWith(jws), description: 'the cart is signed with a key that is not the agent platform\'s registered key' };
    }
    case 'unknown_key': {
      const stranger = generateSigningKey();
      const jws = (await signCart(honestCart, stranger.privateKey, 'agent-never-registered')).jws;
      return { bundle: bundleWith(jws), description: 'the cart is signed under a key id the registry has never heard of' };
    }
    case 'swap_cart': {
      const lines = await Promise.all(attack.lines.map(env.line));
      const swapped = buildCartPayload({
        jti: honestCart.jti,
        iss: honestCart.iss,
        aud: honestCart.aud,
        iat: honestCart.iat,
        exp: honestCart.exp,
        nonce: honestCart.nonce,
        mandate: honestCart.mandate,
        cart: buildCartBody(honestCart.cart.currency, lines),
        consent: honestCart.consent,
      });
      return { bundle: bundleWith(await signedByAgent(env, swapped)), description: 'the agent platform signed a different cart but kept the consent the human gave for the first' };
    }
    case 'other_mandate_hash':
      return { bundle: await resign((cart) => ({ ...cart, mandate: { jti: cart.mandate.jti, hash: 'sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } })), description: 'the cart points at a mandate hash that is not the presented mandate' };
    case 'edit_instruction': {
      const mandateJws = editPayload(base.mandate.jws, (p) => {
        (p['instruction'] as Record<string, unknown>)['text'] = 'Buy anything the agent likes';
      });
      return { bundle: bundleWith(parseCart(base.bundle), mandateJws), description: 'the human\'s instruction text in the mandate was rewritten' };
    }
    case 'replay':
      return { bundle: base.bundle, submitFirst: base.bundle, description: 'the same bundle is submitted a second time' };
    case 'nonce_reuse': {
      const second = await c.wallet.proposeCart({
        mandateJti: base.mandate.jti,
        cartJti: c.ids.next('crt'),
        nonce: honestCart.nonce,
        aud: honestCart.aud,
        proposedBy: AGENT_ISS,
        lines: base.lines,
        currency: honestCart.cart.currency,
      });
      await c.wallet.approve(env.principalId, second.id);
      return { bundle: await c.platform.bundleFor(second.id), submitFirst: base.bundle, description: 'a second, separately approved cart reuses the first cart\'s nonce' };
    }
    case 'other_merchant':
      return { bundle: await resign((cart) => ({ ...cart, aud: merchantAudience('SOMEOTHERMERCHANT') })), description: 'a warrant addressed to a different merchant is presented here' };
    case 'consent_for_other_merchant': {
      const consent = await consentFor(env, base, honestCart, { aud: merchantAudience('SOMEOTHERMERCHANT') });
      return { bundle: await resign((cart) => ({ ...cart, consent })), description: 'the human\'s consent was given for a different merchant' };
    }
    case 'consent_fresh_jti': {
      const fresh = buildCartPayload({ ...cartFields(honestCart), jti: c.ids.next('crt'), nonce: c.ids.token(), consent: honestCart.consent });
      return { bundle: bundleWith(await signedByAgent(env, fresh)), description: 'an identical cart under a new id reuses the consent signed for the first' };
    }
    case 'expired_cart':
      return { bundle: await resign((cart) => ({ ...cart, iat: env.nowSeconds - 3_600, exp: env.nowSeconds - 3_000 })), description: 'the cart warrant expired an hour ago' };
    case 'cart_too_long_lived':
      return { bundle: await resign((cart) => ({ ...cart, exp: cart.iat + 3_600 })), description: 'the cart warrant claims to be valid for an hour (the limit is 15 minutes)' };
    case 'cart_from_future':
      return { bundle: await resign((cart) => ({ ...cart, iat: env.nowSeconds + attack.seconds, exp: env.nowSeconds + attack.seconds + 600 })), description: `the cart warrant was issued ${attack.seconds} seconds in the future` };
    case 'price_changed':
      return {
        bundle: base.bundle,
        prepare: async () => {
          const sku = storeSkuOf(env, base);
          const product = await c.store.get(sku);
          if (product === null) throw new Error(`the store has no product ${sku}`);
          await c.store.setPrice(sku, product.priceCents + attack.deltaCents);
        },
        description: `the store moved the price by ${attack.deltaCents} cents after the human approved`,
      };
    case 'item_unavailable':
      return { bundle: base.bundle, prepare: async () => void (await c.store.setAvailability(storeSkuOf(env, base), false)), description: 'the item went out of stock after the human approved' };
    case 'listing_changed':
      return { bundle: base.bundle, prepare: async () => void (await c.store.setListingText(storeSkuOf(env, base), { title: 'Renamed listing' })), description: 'the store changed the listing after the human approved' };
  }
}

function storeSkuOf(_env: ForgeEnv, base: HonestBase): string {
  const first = base.lines[0];
  if (first === undefined) throw new Error('the honest cart has no lines');
  return first.sku;
}

function parseCart(bundle: Bundle): string {
  const parsed = parseBundle(bundle);
  if (!parsed.ok) throw new Error('bundle is not readable');
  return parsed.value.cart;
}

function cartFields(cart: CartPayload) {
  return { jti: cart.jti, iss: cart.iss, aud: cart.aud, iat: cart.iat, exp: cart.exp, nonce: cart.nonce, mandate: cart.mandate, cart: cart.cart };
}

/** A consent signed by the wallet over this cart, with some field changed. */
async function consentFor(env: ForgeEnv, base: HonestBase, cart: CartPayload, change: { aud?: string; cartJti?: string }): Promise<Consent> {
  const original = cart.consent;
  const signed = original.signature === undefined ? null : decodeConsent(original.signature);
  if (signed === null || !signed.ok) throw new Error('the honest cart has no readable consent');
  const jws = await signConsent(
    {
      cartHash: signed.payload.cart_hash,
      cartJti: change.cartJti ?? signed.payload.cart_jti,
      aud: change.aud ?? signed.payload.aud,
      presentedHash: signed.payload.presented_hash,
      approvedAt: signed.payload.approved_at,
      mandateHash: base.mandate.hash,
    },
    env.c.keys.wallet.privateKey,
    env.c.keys.wallet.kid,
  );
  return { ...original, signature: jws.jws };
}

// ---- attacks that need no honest purchase ----------------------------------------------------------------------------------

export interface MandateOnlyInput {
  readonly principalId: string;
  readonly principalRef: string;
  readonly instruction: string;
  readonly scope: MandatePayload['scope'];
}

/** A throwaway signer that the registry knows, so the scenario can revoke or suspend it without touching the real keys. */
async function registerThrowawayKey(env: ForgeEnv, kind: 'agent' | 'wallet') {
  const pair = generateSigningKey();
  const kid = `lab-${kind}-${env.c.ids.token(6)}`;
  const nowS = env.nowSeconds;
  await env.c.registry.registerKey({
    kid,
    kind,
    owner: kind === 'agent' ? AGENT_PLATFORM_ID : WALLET_ISS,
    ...(kind === 'agent' ? { platformId: AGENT_PLATFORM_ID } : {}),
    publicKeyBase64: Buffer.from(pair.publicKey.export({ format: 'der', type: 'spki' })).toString('base64'),
    validFrom: nowS - 3_600,
  });
  return { pair, kid };
}

/** Sign a cart (human_not_present) under a mandate for lines the scenario chose, without asking the wallet. */
async function forgedCart(env: ForgeEnv, mandate: { jti: string; hash: string }, lines: readonly CartLineInput[], options: { aud?: string; iat?: number; exp?: number; key?: { privateKey: Parameters<typeof signCart>[1]; kid: string }; consent?: Consent }): Promise<string> {
  const now = env.nowSeconds;
  const payload = buildCartPayload({
    jti: env.c.ids.next('crt'),
    iss: AGENT_ISS,
    aud: options.aud ?? merchantAudience(env.c.config.paypal.merchantId),
    iat: options.iat ?? now,
    exp: options.exp ?? now + 600,
    nonce: env.c.ids.token(),
    mandate,
    cart: buildCartBody('USD', lines),
    consent: options.consent ?? HUMAN_NOT_PRESENT_CONSENT,
  });
  const key = options.key ?? { privateKey: env.c.keys.agent.privateKey, kid: env.c.keys.agent.kid };
  return (await signCart(payload, key.privateKey, key.kid)).jws;
}

export async function forgeWithoutHonest(env: ForgeEnv, mandate: MandateRecord, attack: StandaloneAttack, cartLines: readonly CartLineInput[]): Promise<Forged> {
  const { c } = env;
  const ref = { jti: mandate.jti, hash: mandate.hash };
  switch (attack.type) {
    case 'garbage':
      return { bundle: { warrant_version: '0.2', mandate: 'not.a.jws', cart: 'also.not.a.jws' }, description: 'the request carries text that is not a signed warrant at all' };
    case 'forged_cart': {
      const lines = await Promise.all(attack.lines.map(env.line));
      const aud = attack.aud === 'other_merchant' ? merchantAudience('SOMEOTHERMERCHANT') : undefined;
      return { bundle: makeBundle(mandate.jws, await forgedCart(env, ref, lines, aud === undefined ? {} : { aud })), description: 'the agent platform signed a cart outside the mandate' };
    }
    case 'no_consent':
      return { bundle: makeBundle(mandate.jws, await forgedCart(env, ref, cartLines, {})), description: 'the mandate needs the human\'s approval for every cart, but the cart carries none' };
    case 'consent_unseen_by_wallet': {
      const stranger = generateSigningKey();
      const fake = await signConsent({ cartHash: 'sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', cartJti: 'crt_invented', aud: merchantAudience(c.config.paypal.merchantId), presentedHash: 'sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', approvedAt: formatInstant(env.nowSeconds), mandateHash: mandate.hash }, stranger.privateKey, c.keys.wallet.kid);
      const consent: Consent = { mode: 'human_present', approved_at: formatInstant(env.nowSeconds), method: 'click', presented_hash: 'sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', signature: fake.jws };
      return { bundle: makeBundle(mandate.jws, await forgedCart(env, ref, cartLines, { consent })), description: 'a consent signature the wallet never made, under the wallet\'s key id' };
    }
    case 'revoked_agent_key': {
      const lab = await registerThrowawayKey(env, 'agent');
      const own = await c.wallet.issueMandate(env.principalId, { platform: AGENT_PLATFORM_ID, agentId: AGENT_ID, kid: lab.kid }, { instructionText: 'Buy a standing desk converter', maxTotalCents: 12_000, maxItems: 1, categoriesAllow: null, mode: 'human_not_present', budgetMode: 'per_cart' });
      const cart = await forgedCart(env, { jti: own.jti, hash: own.hash }, cartLines, { key: { privateKey: lab.pair.privateKey, kid: lab.kid } });
      return { bundle: makeBundle(own.jws, cart), prepare: () => c.registry.setKeyStatus(lab.kid, 'revoked'), description: 'the agent platform\'s signing key was revoked before the cart reached the merchant' };
    }
    case 'suspended_wallet_key': {
      const lab = await registerThrowawayKey(env, 'wallet');
      const now = env.nowSeconds;
      const payload = buildMandate({
        jti: c.ids.next('mdt'),
        iss: WALLET_ISS,
        iat: now,
        nbf: now,
        exp: now + 86_400,
        principalRef: env.principalRef,
        agent: { platform: AGENT_PLATFORM_ID, agentId: AGENT_ID, kid: c.keys.agent.kid },
        instructionText: 'Buy a standing desk converter',
        scope: { currency: 'USD', maxTotalCents: 12_000, maxPerItemCents: 12_000, maxItems: 1, categoriesAllow: null, merchantsAllow: [c.config.paypal.merchantId], merchantsDeny: [], mode: 'human_not_present', budgetMode: 'per_cart' },
      });
      const signed = await signMandate(payload, lab.pair.privateKey, lab.kid);
      return { bundle: makeBundle(signed.jws, await forgedCart(env, { jti: payload.jti, hash: hashMandate(payload) }, cartLines, {})), prepare: () => c.registry.setKeyStatus(lab.kid, 'suspended'), description: 'the wallet key that signed the mandate was suspended' };
    }
    case 'expired_mandate': {
      const now = env.nowSeconds;
      const payload = buildMandate({
        jti: c.ids.next('mdt'),
        iss: WALLET_ISS,
        iat: now - 7_200,
        nbf: now - 7_200,
        exp: now - 3_600,
        principalRef: env.principalRef,
        agent: { platform: AGENT_PLATFORM_ID, agentId: AGENT_ID, kid: c.keys.agent.kid },
        instructionText: 'Buy a standing desk converter',
        scope: { currency: 'USD', maxTotalCents: 12_000, maxPerItemCents: 12_000, maxItems: 1, categoriesAllow: null, merchantsAllow: [c.config.paypal.merchantId], merchantsDeny: [], mode: 'human_not_present', budgetMode: 'per_cart' },
      });
      const signed = await signMandate(payload, c.keys.wallet.privateKey, c.keys.wallet.kid);
      return { bundle: makeBundle(signed.jws, await forgedCart(env, { jti: payload.jti, hash: hashMandate(payload) }, cartLines, {})), description: 'the mandate expired an hour ago' };
    }
  }
}
