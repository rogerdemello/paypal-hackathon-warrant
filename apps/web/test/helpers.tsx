import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import type { PublicConfigDto } from '@warrant/server/api-types';
import { ConfigProvider } from '../src/config';

export const CONFIG: PublicConfigDto = {
  mode: 'fixtures',
  paypalEnv: 'simulator',
  merchantName: 'Warrant Demo Store (sandbox)',
  merchantId: 'SIMMERCHANT01',
  judgeMode: true,
  consoleTokenRequired: false,
  publicBaseUrl: 'http://localhost:8787',
};

type Handler = (request: { method: string; url: string; body: unknown; headers: Record<string, string> }) => unknown;

export interface MockApi {
  calls: Array<{ method: string; url: string; body: unknown; headers: Record<string, string> }>;
  /** Always answer with this JSON (or { status, body }). */
  on(method: string, path: string | RegExp, response: unknown): void;
  /** Answer by calling a function with the request. */
  handle(method: string, path: string | RegExp, handler: Handler): void;
}

/** A fake server: answer `fetch` calls from handlers keyed by method and path. Unhandled calls fail the test loudly. */
export function mockApi(): MockApi {
  const handlers: Array<{ method: string; path: string | RegExp; handler: Handler }> = [];
  const calls: MockApi['calls'] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname + input.search : input.url;
      const method = init?.method ?? 'GET';
      const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ method, url, body, headers });
      const match = handlers.find((h) => h.method === method && (typeof h.path === 'string' ? h.path === url : h.path.test(url)));
      if (match === undefined) return Promise.resolve(new Response(JSON.stringify({ error: { code: 'UNMOCKED', message: `no mock for ${method} ${url}` } }), { status: 500 }));
      const result = match.handler({ method, url, body, headers });
      const shaped = typeof result === 'object' && result !== null && 'status' in result && 'body' in result ? (result as { status: number; body: unknown }) : { status: 200, body: result };
      return Promise.resolve(new Response(shaped.body === undefined ? '' : JSON.stringify(shaped.body), { status: shaped.status, headers: { 'content-type': 'application/json' } }));
    }),
  );
  const api: MockApi = {
    calls,
    on: (method, path, response) => {
      handlers.unshift({ method, path, handler: () => response });
    },
    handle: (method, path, handler) => {
      handlers.unshift({ method, path, handler });
    },
  };
  api.on('GET', '/api/config', CONFIG);
  return api;
}

export function renderApp(ui: ReactElement, path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ConfigProvider>{ui}</ConfigProvider>
    </MemoryRouter>,
  );
}
