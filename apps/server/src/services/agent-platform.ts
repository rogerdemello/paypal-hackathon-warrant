import { buildCartPayload, makeBundle, signCart, type Bundle } from '@warrant/warrant';
import { nowSeconds, type Clock } from '../clock';
import { AGENT_ISS } from '../identity';
import type { KeyMaterial } from '../keys';
import { WalletError, type WalletService } from './wallet';

/**
 * The agent platform: the only party that holds the cart-signing key. It turns a cart the human approved into a signed cart
 * warrant. It never sees the wallet key, so it cannot invent a consent.
 */
export class AgentPlatform {
  constructor(
    private readonly options: { readonly clock: Clock; readonly key: KeyMaterial; readonly wallet: WalletService; readonly cartLifetimeSeconds?: number },
  ) {}

  get kid(): string {
    return this.options.key.kid;
  }

  /** Sign the cart warrant for an approved proposal and package it with the mandate. */
  async bundleFor(proposalId: string): Promise<Bundle> {
    const { wallet, clock, key } = this.options;
    const proposal = await wallet.proposal(proposalId);
    if (proposal === null) throw new WalletError('NOT_FOUND', 'unknown cart proposal');
    if (proposal.status !== 'approved') throw new WalletError('CONFLICT', `the cart is ${proposal.status}, not approved`);
    const consent = await wallet.consentFor(proposal.cartJti);
    if (consent === null) throw new WalletError('CONFLICT', 'the wallet has no consent for this cart');
    const mandate = await wallet.mandate(proposal.mandateJti);
    if (mandate === null) throw new WalletError('NOT_FOUND', 'unknown mandate');
    const now = nowSeconds(clock);
    const payload = buildCartPayload({
      jti: proposal.cartJti,
      iss: AGENT_ISS,
      aud: proposal.aud,
      iat: now,
      exp: now + (this.options.cartLifetimeSeconds ?? 600),
      nonce: proposal.nonce,
      mandate: { jti: mandate.jti, hash: mandate.hash },
      cart: proposal.cart,
      consent,
    });
    const signed = await signCart(payload, key.privateKey, key.kid);
    return makeBundle(mandate.jws, signed.jws);
  }
}
