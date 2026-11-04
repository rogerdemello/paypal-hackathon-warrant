/**
 * Time in Warrant documents (docs/warrant-spec.md section 4): JWT claims use NumericDate (whole seconds
 * since the Unix epoch, UTC); descriptive fields use ISO 8601 UTC. This package never reads the clock:
 * `now` is always an argument, in NumericDate seconds.
 */

/** Whole seconds since 1970-01-01T00:00:00Z. */
export type NumericDate = number;

/** Clock skew the verifier tolerates (spec section 4). Callers may configure less, never more. */
export const MAX_SKEW_SECONDS = 60;

/** Longest cart warrant lifetime the verifier accepts (V03). */
export const MAX_CART_LIFETIME_SECONDS = 15 * 60;

export function isNumericDate(value: unknown): value is NumericDate {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

/**
 * Parse a UTC instant like `2026-11-04T10:00:00Z` (optional milliseconds) into NumericDate seconds, which can
 * be fractional when milliseconds are given. Returns null for anything else, including impossible dates.
 */
export function parseInstantSeconds(text: unknown): NumericDate | null {
  if (typeof text !== 'string') return null;
  const match = INSTANT.exec(text);
  if (match === null) return null;
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const d = new Date(ms);
  const sameFields =
    d.getUTCFullYear() === year &&
    d.getUTCMonth() + 1 === month &&
    d.getUTCDate() === day &&
    d.getUTCHours() === hour &&
    d.getUTCMinutes() === minute &&
    d.getUTCSeconds() === second;
  return sameFields ? ms / 1000 : null;
}

/** Format NumericDate seconds as `2026-11-04T10:00:00Z` (milliseconds only when present). */
export function formatInstant(seconds: NumericDate): string {
  return new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');
}
