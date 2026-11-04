import { tryParseMoney, type Cents, type NumericDate, parseInstantSeconds } from '@warrant/warrant';
import { PayPalProtocolError } from './errors';

/** Narrowing helpers for untrusted JSON from PayPal. They throw PayPalProtocolError rather than returning `any`. */

export type Rec = Record<string, unknown>;

export function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function rec(value: unknown, what: string): Rec {
  if (!isRec(value)) throw new PayPalProtocolError(`${what} is not an object`);
  return value;
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

export function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function reqStr(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new PayPalProtocolError(`${what} is missing`);
  return value;
}

/** `{ currency_code, value }` to integer cents. Anything that is not a plain decimal is a protocol error. */
export function money(value: unknown, what: string): { currency: string; cents: Cents } {
  const m = rec(value, what);
  const currency = reqStr(m['currency_code'], `${what}.currency_code`);
  const cents = tryParseMoney(reqStr(m['value'], `${what}.value`));
  if (cents === null) throw new PayPalProtocolError(`${what}.value is not a decimal amount`);
  return { currency, cents };
}

export function optMoney(value: unknown, what: string): { currency: string; cents: Cents } | null {
  return value === undefined || value === null ? null : money(value, what);
}

/** An ISO 8601 timestamp to NumericDate seconds, tolerating offsets and fractions. Null when absent. */
export function when(value: unknown): NumericDate | null {
  const text = str(value);
  if (text === null) return null;
  const strict = parseInstantSeconds(text);
  if (strict !== null) return Math.floor(strict);
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
}
