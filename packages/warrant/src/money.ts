/**
 * Money is integer cents everywhere inside the guard. Decimal strings exist only at the boundary
 * (the mandate document, PayPal request and response bodies) and are converted once, here.
 *
 * Every function either returns a safe-integer cents value or throws a MoneyError. Nothing ever
 * silently rounds, so a sub-cent rounding attack (many sub-cent amounts) has nowhere to hide.
 */

/** Integer cents. The type is an alias for readability; use `isCents` / `assertCents` at boundaries. */
export type Cents = number;

/** Largest representable amount: Number.MAX_SAFE_INTEGER cents (about 90 trillion units). */
export const MAX_CENTS: Cents = Number.MAX_SAFE_INTEGER;

export class MoneyError extends Error {
  override readonly name = 'MoneyError';
}

/** Unsigned decimal, no leading zeros, at most two fraction digits, no sign, no exponent, no whitespace. */
const DECIMAL_AMOUNT = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,2}))?$/;

export function isCents(value: unknown): value is Cents {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export function assertCents(value: unknown, label = 'amount'): asserts value is Cents {
  if (!isCents(value)) {
    throw new MoneyError(`${label} must be a safe integer number of cents`);
  }
}

/**
 * Parse a decimal money string ("89.99") into integer cents, or return null.
 * Accepts only `^(0|[1-9]\d*)(\.\d{1,2})?$`. Rejects signs, exponents, separators, whitespace,
 * more than two decimals and anything above MAX_CENTS.
 */
export function tryParseMoney(text: string): Cents | null {
  if (typeof text !== 'string') return null;
  const match = DECIMAL_AMOUNT.exec(text);
  if (match === null) return null;
  const whole = match[1];
  if (whole === undefined) return null;
  const fraction = (match[2] ?? '').padEnd(2, '0');
  const cents = BigInt(whole) * 100n + BigInt(fraction);
  if (cents > BigInt(MAX_CENTS)) return null;
  return Number(cents);
}

/** Like `tryParseMoney`, but throws a MoneyError. Use at the system boundary. */
export function parseMoney(text: string): Cents {
  const cents = tryParseMoney(text);
  if (cents === null) {
    throw new MoneyError(`not a valid decimal amount: ${JSON.stringify(text)}`);
  }
  return cents;
}

/** Format integer cents as a decimal string with exactly two fraction digits: 8999 -> "89.99". */
export function formatMoney(cents: Cents): string {
  assertCents(cents);
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const remainder = abs % 100;
  const whole = (abs - remainder) / 100;
  return `${negative ? '-' : ''}${whole}.${String(remainder).padStart(2, '0')}`;
}

function checked(result: number, what: string): Cents {
  if (!isCents(result)) {
    throw new MoneyError(`${what} does not fit in a safe integer number of cents`);
  }
  return result;
}

export function addCents(a: Cents, b: Cents): Cents {
  assertCents(a, 'left operand');
  assertCents(b, 'right operand');
  return checked(a + b, 'sum');
}

export function subCents(a: Cents, b: Cents): Cents {
  assertCents(a, 'left operand');
  assertCents(b, 'right operand');
  return checked(a - b, 'difference');
}

/** Unit price times an integer quantity. Both operands must be integers. */
export function mulCents(unit: Cents, quantity: number): Cents {
  assertCents(unit, 'unit price');
  if (!Number.isSafeInteger(quantity)) {
    throw new MoneyError('quantity must be a safe integer');
  }
  return checked(unit * quantity, 'product');
}

export function sumCents(values: readonly Cents[]): Cents {
  let total = 0;
  for (const value of values) {
    total = addCents(total, value);
  }
  return total;
}
