import { useState } from 'react';
import type { MandateTermsDto, PresentedScreenDto, ProposalDto } from '@warrant/server/api-types';
import { api } from '../api';
import { isoDateTime, moneyText } from '../format';
import { errorText, useAction } from '../hooks';
import { Badge, ErrorNote, Hash } from './ui';

/**
 * The consent screen. The wallet rendered this from the cart data itself and signs a hash of exactly what is shown here, so
 * what you see is what you approve; the shopping agent cannot change it.
 */
export function ConsentScreen({ presented, presentedHash, status, onApproved, onDeclined }: { presented: PresentedScreenDto; presentedHash: string; status: ProposalDto['status']; onApproved?: () => Promise<void> | void; onDeclined?: () => Promise<void> | void }) {
  return (
    <div className="consent" aria-label="Wallet consent screen">
      <header>
        <span>Your wallet is asking you to approve this purchase</span>
        <Badge tone={status === 'approved' ? 'good' : status === 'pending' ? 'warn' : 'bad'}>{status}</Badge>
      </header>
      <div className="body">
        <p className="muted small" style={{ marginTop: 0 }}>
          Your shopping agent ({presented.agent.replace(/^agent:/, '')}) wants to buy from <strong>{presented.merchant.name}</strong> for {presented.principal}, because you said: &ldquo;{presented.instruction}&rdquo;
        </p>
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th className="right">Qty</th>
              <th className="right">Price</th>
              <th className="right">Line</th>
            </tr>
          </thead>
          <tbody>
            {presented.items.map((i) => (
              <tr key={i.sku}>
                <td>{i.title}</td>
                <td className="right">{i.qty}</td>
                <td className="right">{moneyText(i.unit_price, presented.currency)}</td>
                <td className="right">{moneyText(i.line_total, presented.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="total">
          <span>Total</span>
          <span>{moneyText(presented.total, presented.currency)}</span>
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          Within your limits: up to {moneyText(presented.limits.max_total, presented.currency)} in total, {presented.limits.max_items} item{presented.limits.max_items === 1 ? '' : 's'}. Offer valid until {isoDateTime(presented.expires_at)}.
        </p>
        <p className="muted small" style={{ margin: '6px 0 0' }}>
          Screen fingerprint <Hash value={presentedHash} />. Your approval signs this fingerprint.
        </p>
      </div>
      {status === 'pending' && onApproved !== undefined && onDeclined !== undefined && <ConsentActions onApproved={onApproved} onDeclined={onDeclined} />}
    </div>
  );
}

function ConsentActions({ onApproved, onDeclined }: { onApproved: () => Promise<void> | void; onDeclined: () => Promise<void> | void }) {
  const approve = useAction(async () => onApproved());
  const decline = useAction(async () => onDeclined());
  return (
    <footer>
      <button className="primary" disabled={approve.busy || decline.busy} onClick={() => void approve.run()}>
        {approve.busy ? 'Signing...' : 'Approve and sign'}
      </button>
      <button disabled={approve.busy || decline.busy} onClick={() => void decline.run()}>
        Decline
      </button>
      {(approve.error ?? decline.error) !== null && <ErrorNote error={approve.error ?? decline.error} />}
    </footer>
  );
}

/** What the agent is asking permission to do (the mandate), with the limits the human may tighten before signing. */
export function MandateRequest({ terms, suggestedCategories, resolved, payerLinked, onAuthorize }: { terms: MandateTermsDto; suggestedCategories: readonly string[]; resolved: boolean; payerLinked: boolean; onAuthorize: (edits: Partial<MandateTermsDto>) => Promise<void> }) {
  const [budget, setBudget] = useState((terms.maxTotalCents / 100).toFixed(2));
  const [items, setItems] = useState(String(terms.maxItems));
  const [hours, setHours] = useState(String(Math.round(terms.validForSeconds / 3600)));
  const [alone, setAlone] = useState(terms.mode === 'human_not_present');
  const [categories, setCategories] = useState<string[]>([...(terms.categoriesAllow ?? suggestedCategories)]);
  const action = useAction(onAuthorize);
  const cents = Math.round(Number(budget) * 100);
  const valid = Number.isFinite(cents) && cents > 0 && Number.isInteger(Number(items)) && Number(items) >= 1 && categories.length > 0;

  if (resolved) return <div className="note">Permission request (answered).</div>;
  return (
    <div className="card flat stack" aria-label="Permission request">
      <div className="card-head">
        <h3>Permission for your agent</h3>
        <Badge tone="warn">needs your signature</Badge>
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        Your wallet signs a mandate: a record of what you asked for and the limits the agent must stay inside. The merchant checks every cart against it.
      </p>
      {!payerLinked && (
        <div className="note info small">
          Your PayPal account is not linked to your wallet yet. This purchase will link it, but a dispute about this very first order would rest on weaker evidence. Link it first (Your wallet, on the right) for the strongest proof.
        </div>
      )}
      <div className="grid2">
        <label className="field">
          Most the agent may spend (USD)
          <input inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} aria-label="Budget in dollars" />
        </label>
        <label className="field">
          Most items
          <input inputMode="numeric" value={items} onChange={(e) => setItems(e.target.value)} aria-label="Maximum items" />
        </label>
        <label className="field">
          Valid for (hours)
          <select value={hours} onChange={(e) => setHours(e.target.value)} aria-label="Valid for hours">
            {['1', '24', '72', '168'].map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
        </label>
        <div>
          <div className="muted small">Kinds of product</div>
          <div className="row" style={{ marginTop: 4 }}>
            {suggestedCategories.map((c) => (
              <label key={c} className="check">
                <input type="checkbox" checked={categories.includes(c)} onChange={(e) => setCategories(e.target.checked ? [...categories, c] : categories.filter((x) => x !== c))} />
                {c.replace(/_/g, ' ')}
              </label>
            ))}
          </div>
        </div>
      </div>
      <label className="check">
        <input type="checkbox" checked={alone} onChange={(e) => setAlone(e.target.checked)} />
        <span>Let the agent buy within these limits without asking me each time</span>
      </label>
      <p className="muted small" style={{ margin: 0 }}>
        Your words: &ldquo;{terms.instructionText}&rdquo;. Gift cards, prepaid cards, crypto, gambling and adult items can never be authorised in this demo.
      </p>
      <div className="row">
        <button
          className="primary"
          disabled={!valid || action.busy}
          onClick={() =>
            void action.run({
              maxTotalCents: cents,
              maxPerItemCents: cents,
              maxItems: Number(items),
              categoriesAllow: categories,
              mode: alone ? 'human_not_present' : 'human_present',
              validForSeconds: Number(hours) * 3600,
            })
          }
        >
          {action.busy ? 'Signing...' : 'Sign this mandate'}
        </button>
        {!valid && <span className="muted small">Enter a budget, at least one item and one kind of product.</span>}
      </div>
      {errorText(action.error) !== null && <ErrorNote error={action.error} />}
    </div>
  );
}

/** A wallet proposal looked up by id, so the chat can show the live consent screen. */
export function ProposalView({ proposal, onChanged }: { proposal: ProposalDto; onChanged: (action: 'approved' | 'declined') => Promise<void> }) {
  return (
    <ConsentScreen
      presented={proposal.presented}
      presentedHash={proposal.presentedHash}
      status={proposal.status}
      onApproved={async () => {
        await api.wallet.approve(proposal.id);
        await onChanged('approved');
      }}
      onDeclined={async () => {
        await api.wallet.decline(proposal.id);
        await onChanged('declined');
      }}
    />
  );
}

