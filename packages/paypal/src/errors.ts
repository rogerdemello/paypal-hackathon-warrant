/** A PayPal REST call failed. Carries what support needs: status, PayPal's error name and `debug_id`. */
export class PayPalError extends Error {
  override readonly name = 'PayPalError';

  constructor(
    message: string,
    readonly status: number,
    /** PayPal's machine-readable error name, for example `UNPROCESSABLE_ENTITY` or `INSTRUMENT_DECLINED`. */
    readonly code: string | null,
    /** PayPal's `debug_id`: keep it in the audit ledger. */
    readonly debugId: string | null,
    readonly details: readonly unknown[] = [],
  ) {
    super(message);
  }

  /** True if any `details[].issue` equals `issue` (for example `ORDER_ALREADY_CAPTURED`). */
  hasIssue(issue: string): boolean {
    return this.details.some((d) => typeof d === 'object' && d !== null && (d as { issue?: unknown }).issue === issue);
  }
}

/** The response was not what the PayPal API documents (a missing field, an amount that is not a decimal). */
export class PayPalProtocolError extends Error {
  override readonly name = 'PayPalProtocolError';
}
