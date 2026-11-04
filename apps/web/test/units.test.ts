import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api';
import { dateTime, isoDateTime, money, moneyText, outcomeTone, relative, shortHash, statusTone, words } from '../src/format';
import { consoleToken, lastSession, readStored, visitorId, writeStored } from '../src/storage';
import { mockApi } from './helpers';

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('formatting', () => {
  it('formats money from integer cents, including negatives and other currencies', () => {
    expect(money(8900)).toBe('$89.00');
    expect(money(5)).toBe('$0.05');
    expect(money(123456789)).toBe('$1,234,567.89');
    expect(money(-250)).toBe('-$2.50');
    expect(money(1999, 'EUR')).toBe('19.99 EUR');
    expect(moneyText('89.00')).toBe('$89.00');
    expect(moneyText('12.50', 'GBP')).toBe('12.50 GBP');
  });

  it('describes time relative to now', () => {
    const now = 1_000_000;
    expect(relative(now + 30, now)).toBe('in 30 seconds');
    expect(relative(now - 1, now)).toBe('1 second ago');
    expect(relative(now + 600, now)).toBe('in 10 minutes');
    expect(relative(now - 7200, now)).toBe('2 hours ago');
    expect(relative(now + 3 * 86_400, now)).toBe('in 3 days');
    expect(relative(null)).toBe('unknown');
  });

  it('renders instants and tolerates missing or malformed ones', () => {
    expect(dateTime(null)).toBe('unknown');
    expect(dateTime(1_780_315_200)).toMatch(/2026/);
    expect(isoDateTime(undefined)).toBe('unknown');
    expect(isoDateTime('2026-06-01T12:00:00Z')).toMatch(/2026/);
    expect(isoDateTime('not a date')).toBe('not a date');
  });

  it('shortens hashes but never lies about short ones', () => {
    const hash = 'sha256:Fo4Q_3TwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAeMa8';
    expect(shortHash(hash, 6)).toBe('sha256:Fo4Q_3...eMa8');
    expect(shortHash('sha256:abc')).toBe('sha256:abc');
    expect(shortHash(null)).toBe('none');
  });

  it('turns codes into words and picks tones', () => {
    expect(words('awaiting_approval')).toBe('Awaiting approval');
    expect(outcomeTone('FIGHT')).toBe('good');
    expect(outcomeTone('ACCEPT_AGENT_FAULT')).toBe('warn');
    expect(outcomeTone('NO_PROOF')).toBe('bad');
    expect(outcomeTone('ESCALATE_TO_HUMAN')).toBe('bad');
    expect(outcomeTone(null)).toBe('neutral');
    expect(outcomeTone('SOMETHING_NEW')).toBe('neutral');
    expect(statusTone('captured')).toBe('good');
    expect(statusTone('pending_review')).toBe('warn');
    expect(statusTone('revoked')).toBe('bad');
    expect(statusTone('weird')).toBe('neutral');
  });
});

describe('browser storage', () => {
  it('keeps one visitor id per browser and makes a valid one', () => {
    const first = visitorId();
    expect(first).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(visitorId()).toBe(first);
  });

  it('replaces a stored id that is not valid', () => {
    writeStored('warrant.visitor', 'bad id with spaces');
    expect(visitorId()).toMatch(/^v[0-9a-f]{32}$/);
  });

  it('round-trips the console token and the session id, and clears them', () => {
    expect(consoleToken.get()).toBeNull();
    consoleToken.set('secret');
    lastSession.set('ses_1');
    expect(consoleToken.get()).toBe('secret');
    expect(lastSession.get()).toBe('ses_1');
    consoleToken.clear();
    lastSession.clear();
    expect(consoleToken.get()).toBeNull();
    expect(lastSession.get()).toBeNull();
  });

  it('falls back to memory when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    writeStored('k', 'v');
    expect(readStored('k')).toBe('v');
    expect(visitorId()).toBe(visitorId());
  });
});

describe('api client', () => {
  it('sends the visitor id and the console token, and parses the answer', async () => {
    const server = mockApi();
    consoleToken.set('tok');
    server.on('GET', '/api/wallet/me', { id: 'prn_1', displayName: 'A', payerLinked: false, canLinkSandboxBuyer: true });
    const me = await api.wallet.me();
    expect(me.id).toBe('prn_1');
    const call = server.calls.find((c) => c.url === '/api/wallet/me');
    expect(call?.headers['x-visitor-id']).toBe(visitorId());
    expect(call?.headers['x-console-token']).toBe('tok');
  });

  it('posts JSON bodies and builds query strings only from what is set', async () => {
    const server = mockApi();
    server.handle('POST', '/api/agent/sessions/ses_1/messages', ({ body }) => ({ session: { id: 'ses_1', echoed: body } }));
    server.on('GET', /^\/api\/console\/orders/, { orders: [] });
    const said = await api.agent.say('ses_1', 'hello');
    expect((said.session as unknown as { echoed: unknown }).echoed).toEqual({ text: 'hello' });
    await api.console.orders();
    await api.console.orders('captured');
    await api.console.orders(undefined, true);
    await api.console.orders('captured', true);
    expect(server.calls.filter((c) => c.url.startsWith('/api/console/orders')).map((c) => c.url)).toEqual([
      '/api/console/orders',
      '/api/console/orders?status=captured',
      '/api/console/orders?lab=1',
      '/api/console/orders?status=captured&lab=1',
    ]);
  });

  it('turns the server\'s error shape into an ApiError with its problems', async () => {
    const server = mockApi();
    server.on('POST', '/api/agent/sessions/ses_1/authorize', { status: 400, body: { error: { code: 'INVALID', message: 'the mandate terms are not acceptable', problems: ['the budget must be a positive amount'] } } });
    const error = await api.agent.authorize('ses_1', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 400, code: 'INVALID', message: 'the mandate terms are not acceptable', problems: ['the budget must be a positive amount'] });
  });

  it('copes with an answer that is not JSON, and with the server being down', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('<html>bad gateway</html>', { status: 502 }))));
    expect(await api.health().catch((e: unknown) => e)).toMatchObject({ status: 502, code: 'ERROR' });
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('failed to fetch'))));
    expect(await api.health().catch((e: unknown) => e)).toMatchObject({ status: 0, code: 'NETWORK' });
  });

  it('downloads the evidence packet with the console token and reads its file name', async () => {
    consoleToken.set('tok');
    const fetchMock = vi.fn(() => Promise.resolve(new Response('%PDF-1.4', { status: 200, headers: { 'content-disposition': 'attachment; filename="warrant-evidence-PP-D-1.pdf"' } })));
    vi.stubGlobal('fetch', fetchMock);
    const file = await api.console.packet('PP-D-1');
    expect(file.name).toBe('warrant-evidence-PP-D-1.pdf');
    expect(await file.blob.text()).toBe('%PDF-1.4');
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ 'x-console-token': 'tok' });
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('', { status: 404 }))));
    await expect(api.console.packet('PP-D-2')).rejects.toBeInstanceOf(ApiError);
  });
});
