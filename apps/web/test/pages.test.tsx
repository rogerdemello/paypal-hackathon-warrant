import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentPart, AgentSessionDto, OverviewDto, ProposalDto, ScenarioListDto, VerificationReportDto } from '@warrant/server/api-types';
import { CheckoutReturn } from '../src/pages/CheckoutReturn';
import { Console } from '../src/pages/console/Console';
import { Lab } from '../src/pages/Lab';
import { Shopper } from '../src/pages/Shopper';
import { Verify } from '../src/pages/Verify';
import { consoleToken, lastSession } from '../src/storage';
import { CONFIG, mockApi, renderApp, type MockApi } from './helpers';

const HASH = 'sha256:Fo4Q_3TwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAeMa8';
let server: MockApi;

beforeEach(() => {
  window.localStorage.clear();
  server = mockApi();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const roleOf = (p: AgentPart[], i: number): 'user' | 'assistant' => (p[0]?.kind === 'text' && i === 0 ? 'user' : 'assistant');

const session = (stage: AgentSessionDto['stage'], parts: AgentPart[][] = []): AgentSessionDto => ({
  id: 'ses_1',
  mandateJti: null,
  stage,
  createdAt: 1,
  messages: [
    { id: 'm1', seq: 1, role: 'assistant', parts: [{ kind: 'text', text: 'Hi, I am your shopping agent.' }], createdAt: 1 },
    ...parts.map((p, i) => ({ id: `m${i + 2}`, seq: i + 2, role: roleOf(p, i), parts: p, createdAt: 2 })),
  ],
});

const proposal = (status: ProposalDto['status']): ProposalDto => ({
  id: 'prp_1',
  mandateJti: 'mdt_1',
  cartJti: 'crt_1',
  status,
  presentedHash: HASH,
  cartHash: HASH,
  expiresAt: 2_000_000_000,
  createdAt: 1,
  presented: {
    screen: 'warrant.consent.v1',
    merchant: { audience: 'paypal-merchant:SIMMERCHANT01', name: 'Warrant Demo Store' },
    principal: 'Riley',
    agent: 'agent:warrant-agents/shopper-1',
    instruction: 'a standing desk converter under $120',
    items: [{ sku: 'fx_desk_conv_32', title: 'FlexiRise Standing Desk Converter 32in', qty: 1, unit_price: '89.00', line_total: '89.00' }],
    currency: 'USD',
    total: '89.00',
    limits: { max_total: '120.00', max_per_item: '120.00', max_items: 1, budget_mode: 'cumulative', mode: 'human_present' },
    expires_at: '2026-06-01T12:10:00Z',
  },
});

function walletMocks(payerLinked = true) {
  server.on('GET', '/api/wallet/me', { id: 'prn_1', displayName: 'Demo Shopper', payerLinked, canLinkSandboxBuyer: true });
  server.on('GET', '/api/wallet/mandates', { mandates: [] });
}

describe('the shopper', () => {
  it('starts a conversation, walks the human through the mandate and the consent, and offers PayPal', async () => {
    const user = userEvent.setup();
    walletMocks();
    server.on('GET', '/api/agent/sessions/latest', { session: null });
    server.on('POST', '/api/agent/sessions', { session: session('start') });
    renderApp(<Shopper />);
    expect(await screen.findByText('Hi, I am your shopping agent.')).toBeInTheDocument();
    expect(lastSession.get()).toBe('ses_1');

    // 1. A request becomes a permission card.
    const terms = { instructionText: 'a standing desk converter under $120', maxTotalCents: 12_000, maxPerItemCents: 12_000, maxItems: 1, categoriesAllow: ['office_furniture'], mode: 'human_present' as const, budgetMode: 'cumulative' as const, validForSeconds: 86_400 };
    const asked = session('awaiting_mandate', [[{ kind: 'text', text: 'a standing desk converter under $120' }], [{ kind: 'text', text: 'To shop for you I need your permission first.' }, { kind: 'mandate_request', terms, suggestedCategories: ['office_furniture'], resolved: false }]]);
    server.handle('POST', '/api/agent/sessions/ses_1/messages', ({ body }) => {
      expect(body).toEqual({ text: 'A standing desk converter under $120' });
      return { session: asked };
    });
    await user.click(screen.getByRole('button', { name: 'A standing desk converter under $120' }));
    expect(await screen.findByLabelText('Permission request')).toBeInTheDocument();

    // 2. Signing it brings back the products and the wallet's consent screen.
    const proposed = session('awaiting_consent', [
      [{ kind: 'text', text: 'a standing desk converter under $120' }],
      [{ kind: 'mandate_request', terms, suggestedCategories: ['office_furniture'], resolved: true }],
      [
        { kind: 'products', items: [{ sku: 'fx_desk_conv_32', title: 'FlexiRise Standing Desk Converter 32in', brand: null, category: 'office_furniture', imageUrl: null, priceCents: 8900, currency: 'USD', merchantDomain: 'officegear.example', available: true }], chosenSku: 'fx_desk_conv_32', reason: 'the best match' },
        { kind: 'cart_proposal', proposalId: 'prp_1' },
      ],
    ]);
    server.handle('POST', '/api/agent/sessions/ses_1/authorize', ({ body }) => {
      expect(body).toMatchObject({ edits: { maxTotalCents: 12_000, categoriesAllow: ['office_furniture'], mode: 'human_present' } });
      return { session: proposed };
    });
    server.on('GET', '/api/wallet/proposals/prp_1', { proposal: proposal('pending') });
    await user.click(screen.getByRole('button', { name: 'Sign this mandate' }));
    expect(await screen.findByLabelText('Wallet consent screen')).toHaveTextContent('Warrant Demo Store');
    expect(screen.getByText("agent's pick")).toBeInTheDocument();

    // 3. Approving signs the consent, then the agent checks out and the human is sent to PayPal.
    const checkedOut = session('checking_out', [
      [{ kind: 'cart_proposal', proposalId: 'prp_1' }],
      [{ kind: 'checkout', status: 'approval_required', orderId: 'ord_1', approvalUrl: 'http://localhost:8787/sim/paypal/approve?token=X', message: 'ok', findings: [{ rule: 'V01_SIGNATURE', outcome: 'pass', detail: 'valid' }] }],
    ]);
    server.on('POST', '/api/wallet/proposals/prp_1/approve', { proposal: proposal('approved') });
    server.on('POST', '/api/agent/sessions/ses_1/checkout', { session: checkedOut });
    await user.click(screen.getByRole('button', { name: 'Approve and sign' }));
    const pay = await screen.findByRole('link', { name: 'Continue to PayPal to pay' });
    expect(pay).toHaveAttribute('href', 'http://localhost:8787/sim/paypal/approve?token=X');
    expect(server.calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual(['/api/agent/sessions', '/api/agent/sessions/ses_1/messages', '/api/agent/sessions/ses_1/authorize', '/api/wallet/proposals/prp_1/approve', '/api/agent/sessions/ses_1/checkout']);
  });

  it('resumes the latest conversation and shows a finished order with a link to the public proof', async () => {
    walletMocks();
    const done = session('done', [[{ kind: 'order', orderId: 'ord_1', status: 'captured', totalCents: 8900, currency: 'USD', cartJti: 'crt_1', message: 'The payment went through.' }]]);
    server.on('GET', '/api/agent/sessions/latest', { session: done });
    renderApp(<Shopper />);
    expect(await screen.findByText('Payment complete')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /public proof/ })).toHaveAttribute('href', '/v/crt_1');
    expect(screen.queryByRole('button', { name: 'A standing desk converter under $120' })).toBeNull();
  });

  it('lets a first-time buyer link their PayPal account from the wallet panel', async () => {
    const user = userEvent.setup();
    walletMocks(false);
    server.on('GET', '/api/agent/sessions/latest', { session: session('start') });
    server.on('POST', '/api/wallet/link-paypal', { payerLinked: true });
    renderApp(<Shopper />);
    await user.click(await screen.findByRole('button', { name: 'Link the sandbox buyer now' }));
    await waitFor(() => expect(server.calls.some((c) => c.url === '/api/wallet/link-paypal')).toBe(true));
  });

  it('says plainly when the server refuses a message', async () => {
    const user = userEvent.setup();
    walletMocks();
    server.on('GET', '/api/agent/sessions/latest', { session: session('start') });
    server.on('POST', '/api/agent/sessions/ses_1/messages', { status: 429, body: { error: { code: 'MODEL_BUDGET', message: 'the daily model budget for this demo is used up' } } });
    renderApp(<Shopper />);
    await user.type(await screen.findByLabelText('Message to your shopping agent'), 'a mouse under $40');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('the daily model budget for this demo is used up');
  });
});

describe('the public verification page', () => {
  const report = (over: Partial<VerificationReportDto> = {}): VerificationReportDto => ({
    found: true,
    cartJti: 'crt_1',
    mandate: { jti: 'mdt_1', hash: HASH, instruction: 'a standing desk converter under $120', issuer: 'wallet:warrant-wallet', validFrom: 1_780_315_200, validUntil: 1_780_401_600, scope: { currency: 'USD', maxTotal: '120.00', maxPerItem: '120.00', maxItems: 1, categoriesAllow: ['office_furniture'], mode: 'human_present', budgetMode: 'cumulative' }, payerLinked: true },
    cart: { issuer: 'agent:warrant-agents/shopper-1', audience: 'paypal-merchant:SIMMERCHANT01', issuedAt: 1, expiresAt: 2, cartHash: HASH, total: '89.00', currency: 'USD', items: [{ sku: 'fx_desk_conv_32', title: 'FlexiRise Standing Desk Converter 32in', qty: 1, unit_price: '89.00', listing_hash: HASH }], consent: { mode: 'human_present', approvedAt: '2026-06-01T12:00:00Z', method: 'click', presentedHash: HASH } },
    signers: [
      { subject: 'cart', kid: 'agent-1', ok: true, detail: 'valid', keyStatus: 'active', owner: 'warrant-agents' },
      { subject: 'mandate', kid: 'wallet-1', ok: true, detail: 'valid', keyStatus: 'active', owner: 'wallet:warrant-wallet' },
    ],
    facts: ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11'].map((id) => ({ id, name: id, value: id !== 'F9' && id !== 'F10' && id !== 'F11', evidence: [`e:${id}`] })),
    checkoutFindings: [{ rule: 'V01_SIGNATURE', outcome: 'pass', detail: 'cart signature valid' }],
    order: { id: 'ord_1', status: 'captured', totalCents: 8900, currency: 'USD', paypalOrderId: 'SIMORDER1', captureId: 'SIMCAP1', createdAt: 1_780_315_200 },
    transparency: { included: true, seq: 3, entryHash: HASH, loggedAt: 1_780_315_200, proofValid: true, proofReason: null, checkpointSeq: 3 },
    dispute: null,
    generatedAt: 1_780_315_300,
    ...over,
  });
  const page = () =>
    renderApp(
      <Routes>
        <Route path="/v/:cartJti" element={<Verify />} />
      </Routes>,
      '/v/crt_1',
    );

  it('shows the proof in order and a green headline when everything holds', async () => {
    server.on('GET', '/api/verify/crt_1', report());
    page();
    expect(await screen.findByText('Verified: the human authorised exactly this purchase')).toBeInTheDocument();
    expect(screen.getAllByText(/a standing desk converter under \$120/)[0]).toBeInTheDocument();
    expect(screen.getAllByText('FlexiRise Standing Desk Converter 32in')[0]).toBeInTheDocument();
    expect(screen.getByText('Not delivered yet', { selector: 'summary' })).toBeInTheDocument();
    expect(screen.getByText(/valid, checkpoint 3/)).toBeInTheDocument();
    // After-sale facts are not presented as failures of authorisation.
    expect(screen.queryByText('Delivered', { selector: 'summary *' })).toBeNull();
  });

  it('is honest when a key has since been revoked or the log disagrees', async () => {
    server.on('GET', '/api/verify/crt_1', report({ signers: [{ subject: 'cart', kid: 'agent-1', ok: true, detail: 'valid', keyStatus: 'revoked', owner: 'warrant-agents' }] }));
    page();
    expect(await screen.findByText('A signing key is not in good standing')).toBeInTheDocument();
  });

  it('says so when there is no such warrant', async () => {
    server.on('GET', '/api/verify/crt_1', { status: 404, body: { found: false } });
    page();
    expect(await screen.findByText('No such warrant')).toBeInTheDocument();
  });

  it('mentions a dispute that has been opened', async () => {
    server.on('GET', '/api/verify/crt_1', report({ dispute: { id: 'PP-D-1', state: 'responded', outcome: 'FIGHT', rule: 'UNAUTHORIZED_1_AUTHORISATION_CONFIRMED' } }));
    page();
    expect(await screen.findByText(/A dispute was opened: PP-D-1/)).toBeInTheDocument();
  });
});

describe('the merchant console', () => {
  const overview: OverviewDto = {
    mode: 'fixtures',
    paypalEnv: 'simulator',
    merchantMode: 'STRICT',
    autopilot: false,
    orders: { total: 2, byStatus: { captured: 2 }, capturedCents: 17_800 },
    attempts: { total: 3, accepted: 2, review: 0, rejected: 1 },
    disputes: { total: 1, byState: { awaiting_approval: 1 }, needAttention: 1 },
    keys: [{ kid: 'agent-1', kind: 'agent', owner: 'warrant-agents', status: 'active' }],
    transparency: { length: 4, headHash: HASH },
  };
  const consoleAt = (path = '/console') =>
    renderApp(
      <Routes>
        <Route path="/console/*" element={<Console />} />
      </Routes>,
      path,
    );

  it('opens straight away in judge mode and shows the numbers', async () => {
    server.on('GET', '/api/console/overview', overview);
    server.on('GET', '/api/console/settings', { merchantMode: 'STRICT', disputeAutopilot: false });
    consoleAt();
    expect(await screen.findByText('$178.00')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Disputes (1)' })).toBeInTheDocument();
    expect(screen.getByText('disputes waiting for you')).toBeInTheDocument();
  });

  it('changes the verifier mode and autopilot through the API', async () => {
    const user = userEvent.setup();
    server.on('GET', '/api/console/overview', overview);
    server.on('PUT', '/api/console/settings', { merchantMode: 'PERMISSIVE', disputeAutopilot: false });
    consoleAt();
    await user.selectOptions(await screen.findByLabelText('Verifier mode'), 'PERMISSIVE');
    await waitFor(() => expect(server.calls.find((c) => c.method === 'PUT')?.body).toEqual({ merchantMode: 'PERMISSIVE' }));
    await user.click(screen.getByRole('checkbox', { name: /Autopilot for clear-cut disputes/ }));
    await waitFor(() => expect(server.calls.filter((c) => c.method === 'PUT').at(-1)?.body).toEqual({ disputeAutopilot: true }));
  });

  it('asks for the access token when the console is locked, and uses it', async () => {
    const user = userEvent.setup();
    let calls = 0;
    server.handle('GET', /^\/api\/console\/overview/, ({ headers }) => {
      calls += 1;
      return headers['x-console-token'] === 'letmein' ? overview : { status: 401, body: { error: { code: 'CONSOLE_AUTH', message: 'the console needs its access token (x-console-token)' } } };
    });
    consoleAt();
    await user.type(await screen.findByLabelText('Access token'), 'letmein');
    await user.click(screen.getByRole('button', { name: 'Open the console' }));
    expect(await screen.findByText('Merchant console')).toBeInTheDocument();
    expect(consoleToken.get()).toBe('letmein');
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('shows a wrong token as wrong', async () => {
    consoleToken.set('nope');
    server.on('GET', '/api/console/overview', { status: 401, body: { error: { code: 'CONSOLE_AUTH', message: 'locked' } } });
    consoleAt();
    expect(await screen.findByText('That token was not accepted.')).toBeInTheDocument();
  });

  it('lists the dispute queue and approves the proposed action', async () => {
    const user = userEvent.setup();
    server.on('GET', '/api/console/overview', overview);
    const row = { id: 'PP-D-1', orderId: 'ord_1', captureId: 'CAP1', reason: 'UNAUTHORISED', status: 'WAITING_FOR_SELLER_RESPONSE', stage: 'INQUIRY', state: 'awaiting_approval', amountCents: 8900, currency: 'USD', claim: 'UNAUTHORIZED', claimConflict: false, responseDueBy: 2_000_000_000, hoursLeft: 240, outcome: 'FIGHT', rule: 'UNAUTHORIZED_1_AUTHORISATION_CONFIRMED', confidence: 'normal', action: 'provide-evidence', actionStatus: 'proposed', actionId: 'act_1', approvedBy: null, createdAt: 1_780_315_200, lab: false };
    server.on('GET', /^\/api\/console\/disputes(\?.*)?$/, { disputes: [row] });
    const factsOf = Object.fromEntries(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'F13'].map((id) => [id, { id, name: id, value: id === 'F12' ? 240 : true, evidence: [`e:${id}`] }]));
    let status = 'proposed';
    server.handle('GET', '/api/console/disputes/PP-D-1', () => ({
      dispute: { id: 'PP-D-1', reason: 'UNAUTHORISED', status: 'WAITING_FOR_SELLER_RESPONSE', stage: 'INQUIRY', state: 'awaiting_approval', amountCents: 8900, currency: 'USD', buyerMessage: 'I did not authorize this', claimType: 'UNAUTHORIZED', claimConflict: false, responseDueBy: 2_000_000_000, outcomeCode: null, createdAt: 1_780_315_200 },
      row: { ...row, actionStatus: status },
      order: { id: 'ord_1', status: 'captured', totalCents: 8900, currency: 'USD' },
      analysis: { id: 'fct_1', computedAt: 1, facts: factsOf, decision: { claim: 'UNAUTHORIZED', outcome: 'FIGHT', rule: 'UNAUTHORIZED_1_AUTHORISATION_CONFIRMED', action: { type: 'provide-evidence' }, alternatives: [], confidence: 'normal', attribution: { agent_platform: 'none', merchant: 'none', principal: 'primary' }, factsUsed: [], flags: [], caveat: 'Advisory. PayPal and applicable rules decide liability.', claimConflict: false, claimSource: 'reason_code_and_message' } },
      actions: [{ id: 'act_1', actionType: 'provide-evidence', status, outcome: 'FIGHT', rule: 'UNAUTHORIZED_1_AUTHORISATION_CONFIRMED', params: { evidence_type: 'PROOF_OF_FULFILLMENT' }, memo: 'Dispute PP-D-1 memo text', evidenceNote: 'A signed warrant records what the buyer authorised.', buyerMessage: 'Thanks', noteSource: 'template', approvedBy: null, error: null, createdAt: 1, decidedAt: null }],
      packet: { fileName: 'warrant-evidence-PP-D-1.pdf', sha256: HASH, sizeBytes: 5000 },
      ledger: { chainId: 'dispute:PP-D-1', entries: [], verification: { ok: true, length: 0 } },
      verifyUrl: 'http://localhost:8787/v/crt_1',
    }));
    server.handle('POST', '/api/console/actions/act_1/approve', () => {
      status = 'executed';
      return { action: { id: 'act_1', status } };
    });
    consoleAt('/console/disputes/PP-D-1');
    expect(await screen.findByText('Dispute PP-D-1')).toBeInTheDocument();
    expect(await screen.findByText(/Dispute PP-D-1 memo text/)).toBeInTheDocument();
    expect(screen.getByText('I did not authorize this')).toBeInTheDocument();
    expect(screen.getAllByText('Contest the dispute', { selector: '.badge' }).length).toBeGreaterThanOrEqual(1);
    await user.click(screen.getByRole('button', { name: 'Approve and send evidence' }));
    await waitFor(() => expect(server.calls.some((c) => c.url === '/api/console/actions/act_1/approve')).toBe(true));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Approve and send evidence' })).toBeNull());
  });

  it('hides Dispute Lab runs until asked, and remembers the choice', async () => {
    const user = userEvent.setup();
    server.handle('GET', /^\/api\/console\/overview/, ({ url }) => ({ ...overview, orders: { ...overview.orders, total: url.includes('lab=1') ? 90 : 2 } }));
    consoleAt();
    expect(await screen.findByText('2', { selector: '.kpi .value' })).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Include Dispute Lab runs' }));
    expect(await screen.findByText('90', { selector: '.kpi .value' })).toBeInTheDocument();
    expect(window.localStorage.getItem('warrant.showLab')).toBe('1');
  });
});

describe('the dispute lab', () => {
  const list: ScenarioListDto = {
    families: [{ id: 'remorse', title: 'Honest purchase, later "I never ordered"', count: 1 }, { id: 'forgery', title: 'Forgery', count: 1 }],
    simulator: true,
    scenarios: [
      { id: 'remorse-01', family: 'remorse', familyTitle: 'Honest purchase, later "I never ordered"', title: 'Buyer denies an authorised, delivered purchase', story: 'Everything is signed.', merchantMode: 'STRICT', attack: null, dispute: { reason: 'UNAUTHORISED', message: 'I did not authorize this charge.' }, expect: { verifier: 'ACCEPT', sold: true, dispute: { claim: 'UNAUTHORIZED', outcome: 'FIGHT', rule: 'UNAUTHORIZED_1_AUTHORISATION_CONFIRMED', action: 'provide-evidence' } }, runnable: true },
      { id: 'forge-01', family: 'forgery', familyTitle: 'Forgery', title: 'Signed with the wrong key', story: 'The key id is right, the key is not.', merchantMode: 'STRICT', attack: 'wrong_key', dispute: null, expect: { verifier: 'REJECT', rejectedRules: ['V01_SIGNATURE'], sold: false }, runnable: true },
    ],
  };
  const result = (id: string, passed: boolean) => ({
    result: {
      id,
      family: 'remorse',
      title: 'x',
      passed,
      failures: passed ? [] : ['outcome: expected "FIGHT", got "NO_PROOF"'],
      steps: [{ name: 'checkout', detail: 'approval_required', ok: true }],
      actual: { verifier: 'ACCEPT', rejectedRules: [], sold: true, payment: 'captured', orderId: 'ord_1', cartJti: 'crt_1', disputeId: 'PP-D-1', claim: 'UNAUTHORIZED', outcome: 'FIGHT', rule: 'UNAUTHORIZED_1_AUTHORISATION_CONFIRMED', action: 'provide-evidence', attribution: { agent_platform: 'none', merchant: 'none', principal: 'primary' }, flags: [], confidence: 'normal', state: 'awaiting_approval', noteSource: null },
      latencyMs: 40,
      durationMs: 100,
    },
  });

  it('runs one scenario and shows what happened, with links to the evidence', async () => {
    const user = userEvent.setup();
    server.on('GET', '/api/lab/scenarios', list);
    server.on('POST', '/api/lab/scenarios/remorse-01/run', result('remorse-01', true));
    renderApp(<Lab />);
    expect(await screen.findByText('Buyer denies an authorised, delivered purchase')).toBeInTheDocument();
    const card = screen.getByText('Buyer denies an authorised, delivered purchase').closest('section') as HTMLElement;
    await user.click(within(card).getByRole('button', { name: 'Run' }));
    expect(await within(card).findByText(/As the rules say\./)).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Open the dispute in the console' })).toHaveAttribute('href', '/console/disputes/PP-D-1');
    expect(within(card).getByRole('link', { name: 'Open the public proof' })).toHaveAttribute('href', '/v/crt_1');
  });

  it('runs a whole family and reports how many did what the rules say', async () => {
    const user = userEvent.setup();
    server.on('GET', '/api/lab/scenarios', list);
    server.handle('POST', /^\/api\/lab\/scenarios\/.+\/run$/, ({ url }) => result(url.split('/')[4] ?? '', url.includes('remorse')));
    renderApp(<Lab />);
    await screen.findByText('Signed with the wrong key');
    await user.click(screen.getByRole('button', { name: 'Run 2 shown' }));
    expect(await screen.findByText('1 of 2 scenarios run did what the rules say they should.')).toBeInTheDocument();
    expect(screen.getByText(/expected "FIGHT", got "NO_PROOF"/)).toBeInTheDocument();
  });

  it('filters by family', async () => {
    const user = userEvent.setup();
    server.on('GET', '/api/lab/scenarios', list);
    renderApp(<Lab />);
    await screen.findByText('Signed with the wrong key');
    await user.selectOptions(screen.getByLabelText('Scenario family'), 'forgery');
    expect(screen.queryByText('Buyer denies an authorised, delivered purchase')).toBeNull();
    expect(screen.getByRole('button', { name: 'Run 1 shown' })).toBeInTheDocument();
  });

  it('raises a dispute on a paid order', async () => {
    const user = userEvent.setup();
    server.on('GET', '/api/lab/scenarios', list);
    server.on('GET', '/api/console/orders?status=captured', { orders: [{ id: 'ord_1', items: '1 x FlexiRise Standing Desk Converter 32in', totalCents: 8900, currency: 'USD' }] });
    server.handle('POST', '/api/lab/orders/ord_1/dispute', ({ body }) => {
      expect(body).toMatchObject({ reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', message: 'It never came', dueInHours: 240 });
      return { disputeId: 'PP-D-9', via: 'simulator' };
    });
    renderApp(<Lab />);
    await user.click(await screen.findByRole('tab', { name: 'Raise a dispute on an order' }));
    await user.selectOptions(await screen.findByLabelText('Paid order'), 'ord_1');
    await user.selectOptions(screen.getByLabelText('Reason'), 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED');
    const message = screen.getByLabelText('What the buyer writes');
    await user.clear(message);
    await user.type(message, 'It never came');
    await user.click(screen.getByRole('button', { name: 'Raise the dispute' }));
    expect(await screen.findByText(/PP-D-9/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open it in the console' })).toHaveAttribute('href', '/console/disputes/PP-D-9');
  });
});

describe('returning from PayPal', () => {
  const at = () =>
    renderApp(
      <Routes>
        <Route path="/checkout/return" element={<CheckoutReturn />} />
        <Route path="/" element={<p>the shop</p>} />
        <Route path="/v/:id" element={<p>the proof</p>} />
      </Routes>,
      '/checkout/return?order=ord_1',
    );

  it('finishes the order through the conversation and goes back to the shop', async () => {
    lastSession.set('ses_1');
    server.on('POST', '/api/agent/sessions/ses_1/complete', { session: session('done') });
    at();
    expect(await screen.findByText('the shop')).toBeInTheDocument();
  });

  it('finishes the order directly when the conversation is not this browser\'s, and goes to the proof', async () => {
    lastSession.set('ses_gone');
    server.on('POST', '/api/agent/sessions/ses_gone/complete', { status: 403, body: { error: { code: 'FORBIDDEN', message: 'not yours' } } });
    server.on('POST', '/api/merchant/orders/ord_1/complete', { status: 'captured', message: 'payment captured', orderId: 'ord_1', orderStatus: 'captured', cartJti: 'crt_1' });
    at();
    expect(await screen.findByText('the proof')).toBeInTheDocument();
  });

  it('explains when the payment was not confirmed', async () => {
    server.on('POST', '/api/merchant/orders/ord_1/complete', { status: 'rejected', message: 'payer id hash does not match the principal bound in the mandate', orderId: 'ord_1', orderStatus: 'rejected', cartJti: 'crt_1' });
    at();
    expect(await screen.findByText(/does not match the principal/)).toBeInTheDocument();
  });

  it('needs an order id', async () => {
    renderApp(<CheckoutReturn />, '/checkout/return');
    expect(await screen.findByRole('alert')).toHaveTextContent('needs an order id');
  });
});

it('the configuration has what the pages rely on', () => {
  expect(CONFIG.paypalEnv).toBe('simulator');
});
