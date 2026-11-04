/** Formatting and plain-language labels. The server sends ids and codes; people read these. */

export function money(cents: number, currency = 'USD'): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const text = `${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
  return `${sign}${currency === 'USD' ? '$' : ''}${text}${currency === 'USD' ? '' : ` ${currency}`}`;
}

/** A decimal string from a warrant ("89.00") shown as money. */
export function moneyText(amount: string, currency = 'USD'): string {
  return currency === 'USD' ? `$${amount}` : `${amount} ${currency}`;
}

export function dateTime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return 'unknown';
  return new Date(seconds * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function isoDateTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return 'unknown';
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** "in 3 days", "2 hours ago". `now` is injectable for tests. */
export function relative(seconds: number | null | undefined, now = Date.now() / 1000): string {
  if (seconds === null || seconds === undefined) return 'unknown';
  const delta = Math.round(seconds - now);
  const abs = Math.abs(delta);
  const [value, unit] = abs < 90 ? [abs, 'second'] : abs < 5400 ? [Math.round(abs / 60), 'minute'] : abs < 129_600 ? [Math.round(abs / 3600), 'hour'] : [Math.round(abs / 86_400), 'day'];
  const text = `${value} ${unit}${value === 1 ? '' : 's'}`;
  return delta >= 0 ? `in ${text}` : `${text} ago`;
}

export function shortHash(hash: string | null | undefined, keep = 10): string {
  if (hash === null || hash === undefined) return 'none';
  const body = hash.startsWith('sha256:') ? hash.slice(7) : hash;
  return body.length <= keep * 2 ? hash : `${hash.startsWith('sha256:') ? 'sha256:' : ''}${body.slice(0, keep)}...${body.slice(-4)}`;
}

export function words(code: string): string {
  const text = code.toLowerCase().replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const RULE_NAMES: Readonly<Record<string, string>> = {
  V01_SIGNATURE: 'Signatures are genuine',
  V02_KEY_STATUS: 'Signing keys are in good standing',
  V03_FRESHNESS: 'Mandate and cart are in date',
  V04_AUDIENCE: 'Addressed to this merchant',
  V05_NONCE: 'Not a replay',
  V06_MANDATE_BINDING: 'Cart belongs to this mandate',
  V07_CART_HASH: 'Cart contents match their hash',
  V08_REPRICE: 'Prices match the merchant catalog',
  V09_SCOPE: 'Within what the mandate allows',
  V10_CONSENT: 'The human approved this cart',
  V11_PAYER_BINDING: 'Paid by the person who authorised it',
  V12_VELOCITY: 'Normal order volume',
};

export const FACT_LABELS: Readonly<Record<string, string>> = {
  F1: 'A signed warrant is on file',
  F2: 'All signatures verify',
  F3: 'Keys were active when signed',
  F4: 'Consent is valid',
  F5: 'The order matches what was consented to',
  F6: 'Within the mandate',
  F7: 'Paid by the bound PayPal account',
  F8: 'Nonce and cart id used once',
  F9: 'Delivered',
  F10: 'The listing matches what shipped',
  F11: 'Already refunded',
  F12: 'Hours left to respond',
  F13: 'Disputed amount is within the payment',
};

export const OUTCOME_LABELS: Readonly<Record<string, string>> = {
  FIGHT: 'Contest the dispute',
  ACCEPT_AGENT_FAULT: 'Accept: agent platform at fault',
  NO_PROOF: 'No proof of authorisation',
  REFUND_MERCHANT_FAULT: 'Refund: merchant at fault',
  ACCEPT: 'Accept the claim',
  ALREADY_RESOLVED: 'Already resolved',
  ESCALATE_TO_HUMAN: 'Needs a person',
};

export const ACTION_LABELS: Readonly<Record<string, string>> = {
  'provide-evidence': 'Send evidence to PayPal',
  'accept-claim': 'Accept the claim and refund',
  'make-offer': 'Offer the buyer a remedy',
  alert: 'Hand to a person',
  none: 'No action needed',
};

export const REASON_LABELS: Readonly<Record<string, string>> = {
  UNAUTHORISED: 'Unauthorised',
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: 'Item not received',
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: 'Not as described',
  INCORRECT_AMOUNT: 'Incorrect amount',
  DUPLICATE_TRANSACTION: 'Duplicate charge',
  OTHER: 'Other',
};

export type Tone = 'good' | 'warn' | 'bad' | 'info' | 'neutral';

export function outcomeTone(outcome: string | null): Tone {
  if (outcome === null) return 'neutral';
  switch (outcome) {
    case 'FIGHT':
      return 'good';
    case 'ACCEPT_AGENT_FAULT':
    case 'REFUND_MERCHANT_FAULT':
    case 'ACCEPT':
      return 'warn';
    case 'NO_PROOF':
    case 'ESCALATE_TO_HUMAN':
      return 'bad';
    default:
      return 'neutral';
  }
}

export function statusTone(status: string): Tone {
  if (['captured', 'executed', 'closed', 'active', 'approved', 'ACCEPT', 'pass'].includes(status)) return 'good';
  if (['pending_review', 'created', 'awaiting_approval', 'proposed', 'suspended', 'review', 'REVIEW', 'responded'].includes(status)) return 'warn';
  if (['rejected', 'failed', 'cancelled', 'revoked', 'escalated', 'declined', 'expired', 'REJECT', 'reject'].includes(status)) return 'bad';
  return 'neutral';
}
