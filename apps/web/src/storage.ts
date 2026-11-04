/**
 * Small per-browser conveniences: the anonymous visitor id, the current conversation and the console token. Browser storage
 * can be missing or throw (private windows, blocked site data), so every access is guarded and falls back to memory.
 */

const memory = new Map<string, string>();

export function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key) ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}

export function writeStored(key: string, value: string | null): void {
  if (value === null) memory.delete(key);
  else memory.set(key, value);
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Kept in memory for this page load only.
  }
}

const VISITOR_KEY = 'warrant.visitor';

function randomId(): string {
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A random id that stands in for a login in the demo; it names this browser's wallet. */
export function visitorId(): string {
  const existing = readStored(VISITOR_KEY);
  if (existing !== null && /^[A-Za-z0-9_-]{8,128}$/.test(existing)) return existing;
  const fresh = `v${randomId()}`;
  writeStored(VISITOR_KEY, fresh);
  return fresh;
}

export const consoleToken = {
  get: (): string | null => readStored('warrant.consoleToken'),
  set: (value: string): void => writeStored('warrant.consoleToken', value),
  clear: (): void => writeStored('warrant.consoleToken', null),
};

export const lastSession = {
  get: (): string | null => readStored('warrant.session'),
  set: (id: string): void => writeStored('warrant.session', id),
  clear: (): void => writeStored('warrant.session', null),
};
