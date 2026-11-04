import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttemptRowDto, OrderDetailDto, OrderRowDto, OverviewDto, ProductRowDto } from '@warrant/server/api-types';
import { App } from '../src/App';
import { Console } from '../src/pages/console/Console';
import { mockApi, renderApp, type MockApi } from './helpers';

const HASH = 'sha256:Fo4Q_3TwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAeMa8';
let server: MockApi;

const overview: OverviewDto = {
  mode: 'fixtures',
  paypalEnv: 'simulator',
  merchantMode: 'STRICT',
  autopilot: false,
  orders: { total: 1, byStatus: { captured: 1 }, capturedCents: 8900 },
  attempts: { total: 2, accepted: 1, review: 0, rejected: 1 },
  disputes: { total: 0, byState: {}, needAttention: 0 },
  keys: [{ kid: 'agent-1', kind: 'agent', owner: 'warrant-agents', status: 'active' }],
  transparency: { length: 2, headHash: HASH },
};

const orderRow = (over: Partial<OrderRowDto> = {}): OrderRowDto => ({
  id: 'ord_1',
  status: 'captured',
  createdAt: 1_780_315_200,
  totalCents: 8900,
  currency: 'USD',
  itemCount: 1,
  items: '1 x FlexiRise Standing Desk Converter 32in',
  cartJti: 'crt_1',
  mandateJti: 'mdt_1',
  verifierMode: 'STRICT',
  verification: 'ACCEPT',
  rejectedRules: [],
  paypalOrderId: 'SIMORDER1',
  captureId: 'SIMCAP1',
  invoiceId: 'WRT-abc',
  trackingStatus: null,
  trackingNumber: null,
  refundedCents: 0,
  note: null,
  lab: false,
  ...over,
});

const orderDetail = (row: OrderRowDto, tracking: OrderDetailDto['tracking'] = null): OrderDetailDto => ({
  order: { id: row.id, status: row.status, lines: [{ sku: 'fx_desk_conv_32', title: 'FlexiRise Standing Desk Converter 32in', qty: 1, unitPriceCents: 8900 }], verification: { outcome: row.verification, findings: [{ rule: 'V08_REPRICE', outcome: 'reject', detail: 'price differs' }], payer: { rule: 'V11_PAYER_BINDING', outcome: 'pass', detail: 'payer matches' } }, note: row.note },
  row,
  tracking,
  refunds: [],
  ledger: { chainId: `order:${row.id}`, entries: [], verification: { ok: true, length: 0 } },
});

const consoleAt = (path: string) =>
  renderApp(
    <Routes>
      <Route path="/console/*" element={<Console />} />
    </Routes>,
    path,
  );

beforeEach(() => {
  window.localStorage.clear();
  server = mockApi();
  server.on('GET', /^\/api\/console\/overview/, overview);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('orders', () => {
  it('lists orders, filters by status, and opens one with its checks and ledger', async () => {
    const user = userEvent.setup();
    server.handle('GET', /^\/api\/console\/orders(\?.*)?$/, ({ url }) => ({ orders: url.includes('status=rejected') ? [] : [orderRow()] }));
    server.on('GET', '/api/console/orders/ord_1', orderDetail(orderRow()));
    consoleAt('/console/orders');
    const row = await screen.findByText('1 x FlexiRise Standing Desk Converter 32in');
    await user.click(row);
    expect(await screen.findByText('Order ord_1')).toBeInTheDocument();
    expect(screen.getByText('Prices match the merchant catalog')).toBeInTheDocument();
    expect(screen.getByText('Payer check, after PayPal approval')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the public proof' })).toHaveAttribute('href', '/v/crt_1');
    await user.selectOptions(screen.getByLabelText('Filter by status'), 'rejected');
    expect(await screen.findByText(/No orders with that status/)).toBeInTheDocument();
  });

  it('ships, delivers and refunds a paid order', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const row = orderRow();
    server.on('GET', /^\/api\/console\/orders(\?.*)?$/, { orders: [row] });
    let tracking: OrderDetailDto['tracking'] = null;
    server.handle('GET', '/api/console/orders/ord_1', () => orderDetail(row, tracking));
    server.handle('POST', '/api/console/orders/ord_1/ship', ({ body }) => {
      expect(body).toEqual({ carrier: 'UPS', trackingNumber: '1Z999' });
      tracking = { carrier: 'UPS', trackingNumber: '1Z999', status: 'shipped', shippedAt: 1_780_315_200, deliveredAt: null, promisedBy: 1_780_747_200 };
      return { tracking, warning: null };
    });
    server.handle('POST', '/api/console/orders/ord_1/deliver', () => {
      tracking = { ...(tracking as NonNullable<typeof tracking>), status: 'delivered', deliveredAt: 1_780_401_600 };
      return { tracking };
    });
    server.handle('POST', '/api/console/orders/ord_1/refund', ({ body }) => {
      expect(body).toEqual({ amountCents: 500 });
      return { refund: { id: 'SIMREF1', amountCents: 500 } };
    });
    consoleAt('/console/orders/ord_1');
    await user.type(await screen.findByLabelText('Tracking number'), '1Z999');
    await user.click(screen.getByRole('button', { name: 'Mark shipped' }));
    await user.click(await screen.findByRole('button', { name: 'Mark delivered' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Mark delivered' })).toBeNull());
    await user.type(screen.getByLabelText('Refund amount in dollars'), '5');
    await user.click(screen.getByRole('button', { name: 'Refund' }));
    await waitFor(() => expect(server.calls.some((c) => c.url === '/api/console/orders/ord_1/refund')).toBe(true));
  });

  it('lets the merchant decide an order held for review', async () => {
    const user = userEvent.setup();
    const held = orderRow({ status: 'pending_review', verification: 'REVIEW', captureId: null, paypalOrderId: null });
    server.on('GET', /^\/api\/console\/orders(\?.*)?$/, { orders: [held] });
    server.on('GET', '/api/console/orders/ord_1', orderDetail(held));
    server.handle('POST', '/api/console/orders/ord_1/review', ({ body }) => {
      expect(body).toEqual({ decision: 'approve' });
      return { order: {} };
    });
    consoleAt('/console/orders/ord_1');
    expect(await screen.findByText(/held for review/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(server.calls.some((c) => c.url === '/api/console/orders/ord_1/review')).toBe(true));
  });
});

describe('checkouts', () => {
  const attempts: AttemptRowDto[] = [
    { id: 'att_1', createdAt: 1_780_315_200, cartJti: 'crt_1', outcome: 'ACCEPT', orderId: 'ord_1', failedRules: [], reasons: [], findings: [{ rule: 'V01_SIGNATURE', outcome: 'pass', detail: 'valid' }], lab: false },
    { id: 'att_2', createdAt: 1_780_315_300, cartJti: 'crt_2', outcome: 'REJECT', orderId: null, failedRules: ['V05_NONCE'], reasons: ['nonce has already been seen by this merchant (replay)'], findings: [{ rule: 'V05_NONCE', outcome: 'reject', detail: 'nonce has already been seen by this merchant (replay)' }], lab: false },
  ];

  it('shows what was turned away and why, and can show only those', async () => {
    const user = userEvent.setup();
    server.on('GET', /^\/api\/console\/attempts/, { attempts });
    consoleAt('/console/checkouts');
    expect(await screen.findByText('Not a replay', { selector: '.badge' })).toBeInTheDocument();
    expect(screen.getByText('nonce has already been seen by this merchant (replay)')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /Only refused or held/ }));
    expect(screen.queryByText('nothing')).toBeNull();
    await user.click(screen.getByText('Not a replay', { selector: '.badge' }));
    expect(await screen.findByText('cart warrant jti has not been seen before').catch(() => null)).toBeNull();
  });
});

describe('catalog', () => {
  const product = (over: Partial<ProductRowDto> = {}): ProductRowDto => ({ sku: 'fx_desk_conv_32', title: 'FlexiRise Standing Desk Converter 32in', category: 'office_furniture', priceCents: 8900, currency: 'USD', available: true, listingHash: HASH, merchantDomain: 'officegear.example', source: 'fixture', ...over });

  it('changes a price and saves it, and filters the list', async () => {
    const user = userEvent.setup();
    server.on('GET', '/api/console/products', { products: [product(), product({ sku: 'fx_giftcard_store', title: 'Digital Gift Card $100', category: 'gift_cards', priceCents: 10_000 })] });
    server.handle('PATCH', '/api/console/products/fx_desk_conv_32', ({ body }) => {
      expect(body).toEqual({ priceCents: 9500, available: true });
      return { product: product({ priceCents: 9500 }) };
    });
    consoleAt('/console/catalog');
    const price = await screen.findByLabelText('Price of FlexiRise Standing Desk Converter 32in');
    await user.clear(price);
    await user.type(price, '95');
    const [save] = screen.getAllByRole('button', { name: 'Save' });
    await user.click(save as HTMLElement);
    await waitFor(() => expect(server.calls.some((c) => c.method === 'PATCH')).toBe(true));
    await user.type(screen.getByLabelText('Filter products'), 'gift');
    expect(screen.queryByText('FlexiRise Standing Desk Converter 32in')).toBeNull();
    expect(screen.getByText('Digital Gift Card $100')).toBeInTheDocument();
  });

  it('will not save an unchanged or invalid price', async () => {
    const user = userEvent.setup();
    server.on('GET', '/api/console/products', { products: [product()] });
    consoleAt('/console/catalog');
    const save = await screen.findByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    const price = screen.getByLabelText('Price of FlexiRise Standing Desk Converter 32in');
    await user.clear(price);
    await user.type(price, '-1');
    expect(save).toBeDisabled();
  });
});

describe('registry', () => {
  const keys = { keys: [{ kid: 'agent-1', kind: 'agent', owner: 'warrant-agents', status: 'active', valid_from: 1_780_315_200, valid_to: null, status_changed_at: null }, { kid: 'wallet-1', kind: 'wallet', owner: 'wallet:warrant-wallet', status: 'revoked', valid_from: 1_780_315_200, valid_to: null, status_changed_at: 1_780_315_300 }] };
  const log = { head: { chainId: 'registry', seq: 2, type: 'warrant_logged', payload: { cart_jti: 'crt_1' }, prevHash: HASH, hash: HASH, createdAt: 1 }, checkpoint: { seq: 2, headHash: HASH, issuedAt: 1 }, logKey: { kid: 'registry-1', publicKey: 'AAAA' }, entries: [{ chainId: 'registry', seq: 1, type: 'key_registered', payload: { kid: 'agent-1' }, prevHash: HASH, hash: HASH, createdAt: 1 }, { chainId: 'registry', seq: 2, type: 'warrant_logged', payload: { cart_jti: 'crt_1' }, prevHash: HASH, hash: HASH, createdAt: 1 }] };

  it('suspends and revokes keys, reinstates them, and audits the log', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    server.on('GET', '/api/console/keys', keys);
    server.on('GET', '/api/registry/log', log);
    server.handle('POST', /^\/api\/console\/keys\/.+\/status$/, ({ body }) => ({ keys: keys.keys, echoed: body }));
    server.on('POST', '/api/console/registry/checkpoint', { checkpoint: {}, audit: { ok: true, length: 2, headSeq: 2, headHash: HASH, problems: [] } });
    consoleAt('/console/registry');
    await user.click(await screen.findByRole('button', { name: 'Suspend' }));
    await user.click(screen.getAllByRole('button', { name: 'Revoke' })[0] as HTMLElement);
    await user.click(screen.getByRole('button', { name: 'Reinstate' }));
    const statusCalls = () => server.calls.filter((c) => c.url.includes('/status')).map((c) => [c.url, c.body]);
    await waitFor(() => expect(statusCalls()).toHaveLength(3));
    expect(statusCalls()).toEqual([
      ['/api/console/keys/agent-1/status', { status: 'suspended' }],
      ['/api/console/keys/agent-1/status', { status: 'revoked' }],
      ['/api/console/keys/wallet-1/status', { status: 'active' }],
    ]);
    await user.click(screen.getByRole('button', { name: 'Sign a checkpoint and audit the log' }));
    expect(await screen.findByText('The log is intact: 2 entries, head 2.')).toBeInTheDocument();
    expect(screen.getByText('warrant logged')).toBeInTheDocument();
  });
});

describe('the app shell', () => {
  it('shows the simulator banner, the navigation, and a not-found page', async () => {
    server.on('GET', '/api/agent/sessions/latest', { session: { id: 'ses_1', mandateJti: null, stage: 'start', createdAt: 1, messages: [] } });
    server.on('GET', '/api/wallet/me', { id: 'prn_1', displayName: 'A', payerLinked: true, canLinkSandboxBuyer: true });
    server.on('GET', '/api/wallet/mandates', { mandates: [] });
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    renderApp(<App />, '/nowhere');
    expect(await screen.findByText('Page not found')).toBeInTheDocument();
    expect(screen.getByText(/PayPal is replaced by a built-in sandbox simulator/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Merchant console' })).toHaveAttribute('href', '/console');
    expect(screen.getByRole('link', { name: 'Dispute Lab' })).toHaveAttribute('href', '/lab');
  });
});
