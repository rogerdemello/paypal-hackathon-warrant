import {
  agentIssuer,
  buildCartBody,
  buildCartPayload,
  buildEvidencePacket,
  buildHumanPresentConsent,
  buildMandate,
  computeFacts,
  decideOutcome,
  generateSigningKey,
  hashCartBody,
  hashMandate,
  hashText,
  makeBundle,
  merchantAudience,
  paypalReferences,
  signCart,
  signConsent,
  signMandate,
  staticRegistry,
  verifyCheckout,
  verifyPayerBinding,
  type RegistryKey,
  type VerifyContext,
} from '@warrant/warrant';

/** Wallet, agent platform and merchant in one script: checkout verification, then a dispute. */
export async function quickstart() {
  const now = 1_793_000_700; // The package never reads a clock: you pass `now` (seconds since the epoch).
  const wallet = generateSigningKey();
  const agent = generateSigningKey();
  const listingHash = hashText('listing snapshot of c3_abc123');
  // The agent platform picks the cart warrant's jti and the merchant before the human consents; the consent signs both.
  const cartJti = 'crt_1';
  const aud = merchantAudience('MERCHANT1');

  // 1. The wallet signs a mandate: what the human allowed the agent to do. A cumulative budget covers all carts under it.
  const mandate = buildMandate({
    jti: 'mnd_1', iss: 'wallet:demo-wallet', iat: 1_793_000_000, nbf: 1_793_000_000, exp: 1_793_003_600,
    principalRef: 'prn_1', principalPayerIdHash: hashText('PAYER123'),
    agent: { platform: 'ap_demo', agentId: 'shopper-1', kid: 'ap_demo#1' },
    instructionText: 'Find a standing desk converter under $120',
    scope: { currency: 'USD', maxTotalCents: 12_000, maxPerItemCents: 12_000, maxItems: 2, categoriesAllow: null, merchantsAllow: ['*'], merchantsDeny: [], mode: 'human_present', budgetMode: 'cumulative' },
  });
  const signedMandate = await signMandate(mandate, wallet.privateKey, 'wallet-1');

  // 2. The human approves one cart on the consent screen; the wallet signs the consent over that cart, its jti and its merchant.
  const cartBody = buildCartBody('USD', [{ sku: 'c3_abc123', title: 'Desk converter 32in', qty: 1, unitPriceCents: 8_900, listingHash }]);
  const presentedHash = hashText('the exact consent screen the human saw');
  const approvedAt = '2026-10-26T07:44:10Z';
  const consent = await signConsent({ cartHash: hashCartBody(cartBody), cartJti, aud, presentedHash, approvedAt, mandateHash: hashMandate(mandate) }, wallet.privateKey, 'wallet-1');

  // 3. The agent platform signs the cart warrant and sends the bundle with its checkout request.
  const cart = buildCartPayload({
    jti: cartJti, iss: agentIssuer('ap_demo', 'shopper-1'), aud, iat: 1_793_000_600, exp: 1_793_001_500,
    nonce: 'n_0001', mandate: { jti: mandate.jti, hash: hashMandate(mandate) }, cart: cartBody,
    consent: buildHumanPresentConsent({ approvedAt, method: 'click', presentedHash, signature: consent.jws }),
  });
  const bundle = makeBundle(signedMandate.jws, (await signCart(cart, agent.privateKey, 'ap_demo#1')).jws);

  // 4. The merchant verifies V01-V10 and V12. Everything it needs is passed in; nothing is fetched.
  const registryKey = (kid: string, kind: 'wallet' | 'agent', owner: string, publicKey: RegistryKey['publicKey']): RegistryKey =>
    ({ kid, kind, owner, publicKey, status: 'active', validFrom: 1_700_000_000, validTo: null, statusChangedAt: null });
  const registry = staticRegistry([
    registryKey('wallet-1', 'wallet', 'wallet:demo-wallet', wallet.publicKey),
    registryKey('ap_demo#1', 'agent', 'ap_demo', agent.publicKey),
  ]);
  const seenNonces = new Set<string>();
  const seenJtis = new Set<string>();
  const context: VerifyContext = {
    now, merchantId: 'MERCHANT1', registry,
    nonceSeen: (nonce) => seenNonces.has(nonce),
    cartSeen: (jti) => seenJtis.has(jti), // a consent signs one jti, so a repeated jti is a replay
    catalog: (sku) => (sku === 'c3_abc123' ? { unitPriceCents: 8_900, currency: 'USD', available: true, category: 'office', listingHash } : null),
    walletRecord: ({ cartJti: jti }) => (jti === cartJti ? { presentedHash } : null),
    velocity: null,
    spentUnderMandate: () => ({ totalCents: 0, itemCount: 0 }), // nothing bought under this mandate yet; null would mean "unknown"
  };
  const verification = await verifyCheckout(bundle, context); // { outcome: 'ACCEPT', findings: [...], cartHash, mandateHash }
  if (verification.outcome === 'ACCEPT') {
    // Record nonce, jti and the spend together, atomically, in one transaction that locks the mandate.
    seenNonces.add(cart.nonce);
    seenJtis.add(cart.jti);
  }

  // 5. After the buyer approves the PayPal order, check that the paying account is the principal (V11).
  const payer = verifyPayerBinding(bundle, 'PAYER123');
  const references = paypalReferences(cart); // custom_id and invoice_id for the PayPal order

  // 6. Later the buyer disputes the payment. Facts come from code; a model only picks the claim type.
  const facts = await computeFacts({
    now: now + 3 * 86_400, bundle, merchantId: 'MERCHANT1', merchantMode: 'STRICT', registry,
    categoryOf: () => 'office', walletRecord: context.walletRecord, nonceUseCount: 1, jtiUseCount: 1,
    spentBefore: { totalCents: 0, itemCount: 0 },
    order: { id: 'ORDER1', currency: 'USD', totalCents: 8_900, payerId: 'PAYER123', lines: [{ sku: 'c3_abc123', quantity: 1, unitAmountCents: 8_900 }] },
    capture: { id: 'CAP1', amountCents: 8_900, currency: 'USD' },
    dispute: { id: 'PP-D-1', disputedAmountCents: 8_900, responseDueBy: now + 8 * 86_400 },
    tracking: { delivered: true, deliveredAt: now + 86_400, promisedBy: now + 3 * 86_400, trackingNumber: 'TRK1' },
    fulfilledListings: { c3_abc123: listingHash }, refunds: [], transparency: null,
  });
  const decision = decideOutcome('UNAUTHORIZED', facts); // { outcome: 'FIGHT', action: { type: 'provide-evidence' }, ... }
  const packet = buildEvidencePacket(facts, bundle); // deterministic JSON with a packet_hash

  return { verification, payer, references, decision, packet };
}
