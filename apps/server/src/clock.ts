import { randomBytes } from 'node:crypto';

/** Time and identifiers are injected so tests, the Dispute Lab and the evaluation runner are deterministic. */

export interface Clock {
  /** Milliseconds since the epoch. */
  nowMs(): number;
}

export const systemClock: Clock = { nowMs: () => Date.now() };

/** A clock you can move. */
export class ManualClock implements Clock {
  constructor(private ms: number) {}
  nowMs(): number {
    return this.ms;
  }
  advanceSeconds(seconds: number): void {
    this.ms += seconds * 1000;
  }
  set(ms: number): void {
    this.ms = ms;
  }
}

/** NumericDate seconds for a clock. */
export const nowSeconds = (clock: Clock): number => Math.floor(clock.nowMs() / 1000);

export interface Ids {
  /** A new unique id such as `crt_01JXXXXXXXXXXXXXXXXXXXXXXX`. */
  next(prefix: string): string;
  /** A new random token (nonces). */
  token(bytes?: number): string;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeBase32(bytes: Uint8Array, length: number): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < length) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.padEnd(length, '0');
}

/** ULID-like ids: 10 characters of time (sortable) and 16 of randomness. */
export function ulidIds(clock: Clock, random: (n: number) => Uint8Array = (n) => randomBytes(n)): Ids {
  return {
    next(prefix: string): string {
      const ms = clock.nowMs();
      const time = new Uint8Array(6);
      let rest = ms;
      for (let i = 5; i >= 0; i--) {
        time[i] = rest % 256;
        rest = Math.floor(rest / 256);
      }
      return `${prefix}_${encodeBase32(time, 10)}${encodeBase32(random(10), 16)}`;
    },
    token(bytes = 12): string {
      return random(bytes).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
    },
  };
}

/** Counter-based ids for tests: `crt_00000001`, never random. */
export function sequentialIds(start = 1): Ids {
  let n = start;
  return {
    next: (prefix) => `${prefix}_${String(n++).padStart(8, '0')}`,
    token: () => `tok${String(n++).padStart(8, '0')}`,
  };
}
