import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { FindingDto, LedgerEntryDto, PresentedScreenDto, VerificationReportDto } from '@warrant/server/api-types';
import { ConsentScreen, MandateRequest } from '../src/components/Consent';
import { Ledger } from '../src/components/Ledger';
import { ConfirmButton, ErrorNote, Findings, Hash, Tabs } from '../src/components/ui';
import { ApiError } from '../src/api';
import { verdictOf } from '../src/pages/Verify';

const presented: PresentedScreenDto = {
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
};
const HASH = 'sha256:Fo4Q_3TwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAeMa8';

describe('ConsentScreen', () => {
  it('shows exactly what the wallet rendered: merchant, items, total, limits and the fingerprint', () => {
    render(<ConsentScreen presented={presented} presentedHash={HASH} status="pending" />);
    expect(screen.getByText('FlexiRise Standing Desk Converter 32in')).toBeInTheDocument();
    expect(screen.getByText('Total').nextSibling).toHaveTextContent('$89.00');
    expect(screen.getByText(/Warrant Demo Store/)).toBeInTheDocument();
    expect(screen.getByText(/up to \$120.00 in total, 1 item/)).toBeInTheDocument();
    expect(screen.getByText(/shopper-1/)).toBeInTheDocument();
    expect(screen.queryByText(/agent:/)).toBeNull();
    expect(screen.getByLabelText('Wallet consent screen')).toHaveTextContent('pending');
  });

  it('offers approval only while pending, and reports a failed approval', async () => {
    const user = userEvent.setup();
    const approve = vi.fn(() => Promise.reject(new ApiError(410, 'EXPIRED', 'this cart is no longer valid')));
    const decline = vi.fn(() => Promise.resolve());
    const { rerender } = render(<ConsentScreen presented={presented} presentedHash={HASH} status="pending" onApproved={approve} onDeclined={decline} />);
    await user.click(screen.getByRole('button', { name: 'Approve and sign' }));
    expect(approve).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('alert')).toHaveTextContent('this cart is no longer valid');
    await user.click(screen.getByRole('button', { name: 'Decline' }));
    expect(decline).toHaveBeenCalledTimes(1);
    rerender(<ConsentScreen presented={presented} presentedHash={HASH} status="approved" onApproved={approve} onDeclined={decline} />);
    expect(screen.queryByRole('button', { name: 'Approve and sign' })).toBeNull();
  });
});

describe('MandateRequest', () => {
  const terms = { instructionText: 'a standing desk converter under $120', maxTotalCents: 12_000, maxPerItemCents: 12_000, maxItems: 1, categoriesAllow: ['office_furniture'], mode: 'human_present' as const, budgetMode: 'cumulative' as const, validForSeconds: 86_400 };

  it('sends the human\'s edits in cents when they sign', async () => {
    const user = userEvent.setup();
    const onAuthorize = vi.fn(() => Promise.resolve());
    render(<MandateRequest terms={terms} suggestedCategories={['office_furniture', 'electronics']} resolved={false} payerLinked onAuthorize={onAuthorize} />);
    const budget = screen.getByLabelText('Budget in dollars');
    await user.clear(budget);
    await user.type(budget, '95.50');
    await user.click(screen.getByLabelText('electronics'));
    await user.click(screen.getByLabelText(/without asking me each time/));
    await user.selectOptions(screen.getByLabelText('Valid for hours'), '72');
    await user.click(screen.getByRole('button', { name: 'Sign this mandate' }));
    expect(onAuthorize).toHaveBeenCalledWith({
      maxTotalCents: 9_550,
      maxPerItemCents: 9_550,
      maxItems: 1,
      categoriesAllow: ['office_furniture', 'electronics'],
      mode: 'human_not_present',
      validForSeconds: 72 * 3600,
    });
  });

  it('will not let an empty or nonsensical request be signed', async () => {
    const user = userEvent.setup();
    const onAuthorize = vi.fn(() => Promise.resolve());
    render(<MandateRequest terms={terms} suggestedCategories={['office_furniture']} resolved={false} payerLinked onAuthorize={onAuthorize} />);
    const sign = screen.getByRole('button', { name: 'Sign this mandate' });
    await user.clear(screen.getByLabelText('Budget in dollars'));
    expect(sign).toBeDisabled();
    await user.type(screen.getByLabelText('Budget in dollars'), 'abc');
    expect(sign).toBeDisabled();
    await user.clear(screen.getByLabelText('Budget in dollars'));
    await user.type(screen.getByLabelText('Budget in dollars'), '50');
    expect(sign).toBeEnabled();
    await user.click(screen.getByLabelText('office furniture'));
    expect(sign).toBeDisabled();
    expect(onAuthorize).not.toHaveBeenCalled();
  });

  it('nudges a first-time buyer to link their PayPal account, and shows an answered request quietly', () => {
    const { rerender } = render(<MandateRequest terms={terms} suggestedCategories={['office_furniture']} resolved={false} payerLinked={false} onAuthorize={() => Promise.resolve()} />);
    expect(screen.getByText(/not linked to your wallet yet/)).toBeInTheDocument();
    rerender(<MandateRequest terms={terms} suggestedCategories={['office_furniture']} resolved payerLinked onAuthorize={() => Promise.resolve()} />);
    expect(screen.getByText(/answered/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign this mandate' })).toBeNull();
  });

  it('shows the wallet\'s reason when it refuses', async () => {
    const user = userEvent.setup();
    const onAuthorize = vi.fn(() => Promise.reject(new ApiError(400, 'INVALID', 'the mandate terms are not acceptable', ['the budget is above the demo limit'])));
    render(<MandateRequest terms={terms} suggestedCategories={['office_furniture']} resolved={false} payerLinked onAuthorize={onAuthorize} />);
    await user.click(screen.getByRole('button', { name: 'Sign this mandate' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('the budget is above the demo limit');
  });
});

describe('shared pieces', () => {
  it('lists findings in plain words with their outcome', () => {
    const findings: FindingDto[] = [
      { rule: 'V01_SIGNATURE', outcome: 'pass', detail: 'cart signature valid' },
      { rule: 'V09_SCOPE', outcome: 'reject', detail: 'cart total exceeds max_total' },
      { rule: 'V12_VELOCITY', outcome: 'review', detail: 'unusual volume' },
    ];
    const { rerender } = render(<Findings findings={findings} />);
    expect(screen.getByText('Signatures are genuine')).toBeInTheDocument();
    expect(screen.getByText('Within what the mandate allows')).toBeInTheDocument();
    expect(screen.getByLabelText('reject')).toBeInTheDocument();
    rerender(<Findings findings={findings} showPasses={false} />);
    expect(screen.queryByText('Signatures are genuine')).toBeNull();
    rerender(<Findings findings={[]} />);
    expect(screen.getByText('No findings.')).toBeInTheDocument();
  });

  it('copies a hash on request', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<Hash value={HASH} />);
    await user.click(screen.getByRole('button', { name: `Copy ${HASH}` }));
    expect(writeText).toHaveBeenCalledWith(HASH);
    await waitFor(() => expect(screen.getByRole('button')).toHaveTextContent('copied'));
  });

  it('asks before a consequential click', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const confirm = vi.spyOn(window, 'confirm');
    render(<ConfirmButton confirm="Refund this payment?" onConfirm={onConfirm}>Refund</ConfirmButton>);
    confirm.mockReturnValueOnce(false);
    await user.click(screen.getByRole('button', { name: 'Refund' }));
    expect(onConfirm).not.toHaveBeenCalled();
    confirm.mockReturnValueOnce(true);
    await user.click(screen.getByRole('button', { name: 'Refund' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('shows an error with its problems and a retry', async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    render(<ErrorNote error={new ApiError(400, 'INVALID', 'not acceptable', ['one', 'two'])} onRetry={retry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('one');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalled();
    const { container } = render(<ErrorNote error={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('switches tabs', async () => {
    const user = userEvent.setup();
    const change = vi.fn();
    render(<Tabs tabs={[{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta', count: 3 }]} value="a" onChange={change} />);
    expect(screen.getByRole('tab', { name: 'Alpha' })).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('tab', { name: 'Beta (3)' }));
    expect(change).toHaveBeenCalledWith('b');
  });

  it('shows a ledger and flags a broken chain', () => {
    const entries: LedgerEntryDto[] = [
      { chainId: 'order:1', seq: 1, type: 'order_received', payload: { a: 1 }, prevHash: 'sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', hash: HASH, createdAt: 1_780_315_200 },
    ];
    const { rerender } = render(<Ledger entries={entries} verification={{ ok: true, length: 1 }} />);
    expect(screen.getByText('chain intact: 1 entries')).toBeInTheDocument();
    expect(screen.getByText('order received')).toBeInTheDocument();
    rerender(<Ledger entries={entries} verification={{ ok: false, brokenSeq: 1, message: 'entry 1 hash does not match its contents' }} />);
    expect(screen.getByText('chain broken at entry 1')).toBeInTheDocument();
    rerender(<Ledger entries={[]} verification={{ ok: true, length: 0 }} />);
    expect(screen.getByText('No entries yet.')).toBeInTheDocument();
  });
});

describe('the verification headline', () => {
  const ok = { subject: 'cart' as const, kid: 'agent-1', ok: true, detail: 'valid', keyStatus: 'active', owner: 'warrant-agents' };
  const facts = (over: Record<string, boolean> = {}) => ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8'].map((id) => ({ id, name: id, value: over[id] ?? true, evidence: [] }));
  const base = (over: Partial<VerificationReportDto> = {}): VerificationReportDto => ({
    found: true,
    cartJti: 'crt_1',
    mandate: null,
    cart: null,
    signers: [ok],
    facts: facts(),
    checkoutFindings: [],
    order: null,
    transparency: { included: true, seq: 1, entryHash: HASH, loggedAt: 1, proofValid: true, proofReason: null, checkpointSeq: 1 },
    dispute: null,
    generatedAt: 1,
    ...over,
  });

  it('says verified only when every authorisation fact holds', () => {
    expect(verdictOf(base())).toMatchObject({ tone: 'good' });
  });
  it('names the first thing wrong, in order of severity', () => {
    expect(verdictOf(base({ found: false }))).toMatchObject({ tone: 'bad', headline: 'No such warrant' });
    expect(verdictOf(base({ signers: [{ ...ok, ok: false, detail: 'cart signature invalid' }] }))).toMatchObject({ tone: 'bad', headline: 'A signature does not verify', detail: 'cart signature invalid' });
    expect(verdictOf(base({ signers: [{ ...ok, keyStatus: 'revoked' }] }))).toMatchObject({ tone: 'bad', headline: 'A signing key is not in good standing' });
    expect(verdictOf(base({ signers: [{ ...ok, keyStatus: null }] })).detail).toMatch(/unknown to the registry/);
    expect(verdictOf(base({ transparency: { included: true, seq: 1, entryHash: HASH, loggedAt: 1, proofValid: false, proofReason: 'bad checkpoint', checkpointSeq: 1 } }))).toMatchObject({ tone: 'bad', detail: 'bad checkpoint' });
  });
  it('is cautious when the payer is not bound or there is no order to compare', () => {
    expect(verdictOf(base({ facts: facts({ F7: false }) }))).toMatchObject({ tone: 'warn', detail: expect.stringContaining('Paid by the bound PayPal account') as string });
    expect(verdictOf(base({ facts: [] }))).toMatchObject({ tone: 'warn', headline: 'Signed, but no order has been matched yet' });
  });
});
