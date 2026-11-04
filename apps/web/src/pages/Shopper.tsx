import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AgentPart, AgentSessionDto, MandateDto, MandateTermsDto, ProductDto, ProposalDto, WalletMeDto } from '@warrant/server/api-types';
import { ApiError, api } from '../api';
import { ProposalView, MandateRequest, ConsentScreen } from '../components/Consent';
import { Badge, Card, Empty, ErrorNote, Findings, Spinner, StatusBadge } from '../components/ui';
import { useConfig } from '../config';
import { dateTime, money, moneyText } from '../format';
import { useAction, useLoad, type Loaded } from '../hooks';
import { lastSession } from '../storage';

const SUGGESTIONS = [
  'A standing desk converter under $120',
  'A wireless mouse under $40',
  'A book about ergonomics under $30',
  'A premium desk organizer under $50',
];

export function Shopper() {
  const config = useConfig();
  const [session, setSession] = useState<AgentSessionDto | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [booting, setBooting] = useState(true);
  const [draft, setDraft] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  const wallet = useLoad(() => Promise.all([api.wallet.me(), api.wallet.mandates()]), []);

  const adopt = useCallback((next: AgentSessionDto) => {
    lastSession.set(next.id);
    setSession(next);
    setError(null);
  }, []);

  // Pick up the conversation where the visitor left it, or start one.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const latest = await api.agent.latest();
        const current = latest.session ?? (await api.agent.start()).session;
        if (!cancelled) adopt(current);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [adopt]);

  useEffect(() => {
    bottom.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' });
  }, [session?.messages.length, booting]);

  const step = useCallback(
    async (call: (id: string) => Promise<{ session: AgentSessionDto }>) => {
      if (session === null) return;
      try {
        adopt((await call(session.id)).session);
        wallet.reload();
      } catch (e) {
        setError(e instanceof Error ? e : new Error(String(e)));
        // The conversation may have moved on (for example another tab); show its current state.
        if (e instanceof ApiError && e.status === 409) adopt((await api.agent.get(session.id)).session);
      }
    },
    [session, adopt, wallet],
  );

  const send = useAction(async (text: string) => {
    setDraft('');
    await step((id) => api.agent.say(id, text));
  });
  const fresh = useAction(async () => {
    adopt((await api.agent.start()).session);
  });

  if (booting) return <div className="page narrow"><Spinner label="Opening your wallet and agent" /></div>;

  const messages = session?.messages ?? [];
  const lastMandateRequest = [...messages].reverse().flatMap((m) => m.parts).find((p) => p.kind === 'mandate_request');
  const lastProposal = [...messages].reverse().flatMap((m) => m.parts).find((p) => p.kind === 'cart_proposal');
  const lastCheckout = [...messages].reverse().flatMap((m) => m.parts).find((p) => p.kind === 'checkout');
  const onlyGreeting = messages.length <= 1;

  return (
    <div className="page">
      <div className="cols">
        <div>
          <div className="card-head">
            <div>
              <h1>Shop with an AI agent, safely</h1>
              <p className="muted" style={{ margin: 0 }}>
                Tell the agent what you want. It can look and propose, but nothing is bought until your wallet signs your approval, and the merchant checks that signature.
              </p>
            </div>
            <button className="small" onClick={() => void fresh.run()} disabled={fresh.busy}>
              New conversation
            </button>
          </div>

          <div className="chat" style={{ marginTop: 16 }} aria-live="polite">
            {messages.map((m) => (
              <div key={m.id} className={`msg ${m.role}`}>
                {m.parts.map((part, i) => (
                  <PartView
                    key={`${m.id}-${i}`}
                    part={part}
                    session={session}
                    isLatestMandate={part === lastMandateRequest}
                    isLatestProposal={part === lastProposal}
                    isLatestCheckout={part === lastCheckout}
                    payerLinked={wallet.data?.[0].payerLinked ?? true}
                    onAuthorize={async (edits) => step((id) => api.agent.authorize(id, edits))}
                    onConsent={async (decision) => step((id) => (decision === 'approved' ? api.agent.checkout(id) : api.agent.decline(id)))}
                  />
                ))}
              </div>
            ))}
            <div ref={bottom} />
          </div>

          {error !== null && <ErrorNote error={error} />}
          {onlyGreeting && (
            <div className="chips" style={{ margin: '12px 0' }}>
              {SUGGESTIONS.map((s) => (
                <button key={s} className="chip" onClick={() => void send.run(s)} disabled={send.busy}>
                  {s}
                </button>
              ))}
            </div>
          )}
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              if (draft.trim() !== '') void send.run(draft.trim());
            }}
          >
            <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder='What would you like to buy? e.g. "a standing desk converter under $120"' aria-label="Message to your shopping agent" maxLength={1000} disabled={send.busy} />
            <button className="primary" type="submit" disabled={send.busy || draft.trim() === ''}>
              {send.busy ? 'Thinking...' : 'Send'}
            </button>
          </form>
          {config.mode === 'fixtures' && <p className="muted small">Demo data: products come from a built-in catalog and the agent follows fixed rules (no model calls).</p>}
        </div>

        <aside className="stack">
          <WalletPanel loaded={wallet} onChanged={wallet.reload} />
          <Card title="What is happening behind the scenes">
            <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
              <li>You sign a <strong>mandate</strong>: your words and the limits.</li>
              <li>The agent proposes a cart; your wallet shows it and you <strong>sign consent</strong>.</li>
              <li>The merchant checks twelve rules, then PayPal takes the payment.</li>
              <li>If anyone disputes it later, the signed record is the evidence.</li>
            </ol>
          </Card>
        </aside>
      </div>
    </div>
  );
}

function WalletPanel({ loaded, onChanged }: { loaded: Loaded<[WalletMeDto, { mandates: MandateDto[] }]>; onChanged: () => void }) {
  const link = useAction(async () => {
    await api.wallet.linkPaypal();
    onChanged();
  });
  const revoke = useAction(async (jti: string) => {
    await api.wallet.revoke(jti);
    onChanged();
  });
  if (loaded.data === null) return <Card title="Your wallet">{loaded.error === null ? <Spinner /> : <ErrorNote error={loaded.error} onRetry={loaded.reload} />}</Card>;
  const [me, { mandates }] = loaded.data;
  return (
    <Card title="Your wallet">
      <dl className="facts">
        <dt>Wallet</dt>
        <dd className="mono small">{me.id}</dd>
        <dt>PayPal account</dt>
        <dd>{me.payerLinked ? <Badge tone="good">linked</Badge> : <Badge tone="warn">not linked yet</Badge>}</dd>
      </dl>
      {!me.payerLinked && (
        <div style={{ marginTop: 8 }}>
          <p className="muted small" style={{ marginBottom: 6 }}>
            Your first purchase links the PayPal account that pays. Linking first makes your later purchases easier to defend if one is disputed.
          </p>
          {me.canLinkSandboxBuyer && (
            <button className="small" onClick={() => void link.run()} disabled={link.busy}>
              Link the sandbox buyer now
            </button>
          )}
          <ErrorNote error={link.error} />
        </div>
      )}
      <h3 style={{ marginTop: 14 }}>Mandates you signed</h3>
      {mandates.length === 0 ? (
        <Empty>None yet.</Empty>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }} className="stack">
          {mandates.slice(0, 5).map((m) => (
            <li key={m.jti} className="note">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <StatusBadge status={m.status} />
                <span className="muted small">{dateTime(m.createdAt)}</span>
              </div>
              <div className="small" style={{ margin: '4px 0' }}>&ldquo;{m.instruction}&rdquo;</div>
              <div className="muted small">Up to {moneyText(m.scope.maxTotal)} · {m.scope.maxItems} item{m.scope.maxItems === 1 ? '' : 's'} · until {dateTime(m.validUntil)}</div>
              {m.status === 'active' && (
                <button className="small danger" style={{ marginTop: 6 }} onClick={() => void revoke.run(m.jti)} disabled={revoke.busy}>
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ErrorNote error={revoke.error} />
    </Card>
  );
}

interface PartProps {
  part: AgentPart;
  session: AgentSessionDto | null;
  isLatestMandate: boolean;
  isLatestProposal: boolean;
  isLatestCheckout: boolean;
  payerLinked: boolean;
  onAuthorize: (edits: Partial<MandateTermsDto>) => Promise<void>;
  onConsent: (decision: 'approved' | 'declined') => Promise<void>;
}

function PartView({ part, session, isLatestMandate, isLatestProposal, isLatestCheckout, payerLinked, onAuthorize, onConsent }: PartProps) {
  switch (part.kind) {
    case 'text':
      return <div className="bubble">{part.text}</div>;
    case 'notice':
      return <div className={`note ${part.level === 'error' ? 'bad' : part.level === 'warn' ? 'warn' : 'info'}`}>{part.text}</div>;
    case 'mandate_request':
      return <MandateRequest terms={part.terms} suggestedCategories={part.suggestedCategories} resolved={!(isLatestMandate && session?.stage === 'awaiting_mandate')} payerLinked={payerLinked} onAuthorize={onAuthorize} />;
    case 'products':
      return <Products items={part.items} chosenSku={part.chosenSku} reason={part.reason} />;
    case 'cart_proposal':
      return <ProposalLoader proposalId={part.proposalId} interactive={isLatestProposal && session?.stage === 'awaiting_consent'} onDecided={onConsent} />;
    case 'checkout':
      return (
        <div className="card flat stack" style={{ width: '100%' }}>
          <div className="row">
            <StatusBadge status={part.status === 'approval_required' ? 'approved' : part.status} label={part.status === 'approval_required' ? 'merchant accepted' : part.status.replace(/_/g, ' ')} />
            <span className="muted small">{part.message}</span>
          </div>
          <details>
            <summary>What the merchant checked ({part.findings.length} results)</summary>
            <Findings findings={part.findings} />
          </details>
          {part.status === 'approval_required' && part.approvalUrl !== null && isLatestCheckout && session?.stage === 'checking_out' && (
            <div>
              <a className="btn primary" href={part.approvalUrl}>
                Continue to PayPal to pay
              </a>
              <span className="muted small" style={{ marginLeft: 8 }}>You will be brought back here afterwards.</span>
            </div>
          )}
        </div>
      );
    case 'order':
      return (
        <div className={`note ${part.status === 'captured' ? 'good' : 'bad'}`} style={{ width: '100%' }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <strong>{part.status === 'captured' ? 'Payment complete' : `Order ${part.status}`}</strong>
            <span>{money(part.totalCents, part.currency)}</span>
          </div>
          <div className="small">Order {part.orderId}. {part.message}</div>
          {part.cartJti !== null && (
            <div style={{ marginTop: 8 }}>
              <Link className="btn small" to={`/v/${part.cartJti}`}>
                See the public proof of what you authorised
              </Link>
            </div>
          )}
        </div>
      );
  }
}

function Products({ items, chosenSku, reason }: { items: readonly ProductDto[]; chosenSku: string | null; reason: string | null }) {
  if (items.length === 0) return null;
  return (
    <div style={{ width: '100%' }}>
      <div className="products">
        {items.map((p) => (
          <div key={p.sku} className={`product ${p.sku === chosenSku ? 'chosen' : ''}`}>
            <div className="small muted">{p.merchantDomain}</div>
            <div>{p.title}</div>
            <div className="price">{money(p.priceCents, p.currency)}</div>
            {p.sku === chosenSku && <Badge tone="info">agent's pick</Badge>}
          </div>
        ))}
      </div>
      {reason !== null && <p className="muted small">Why this one: {reason}</p>}
    </div>
  );
}

function ProposalLoader({ proposalId, interactive, onDecided }: { proposalId: string; interactive: boolean; onDecided: (decision: 'approved' | 'declined') => Promise<void> }) {
  const proposal = useLoad(() => api.wallet.proposal(proposalId), [proposalId, interactive]);
  if (proposal.data === null) return proposal.error === null ? <Spinner label="Loading the consent screen" /> : <ErrorNote error={proposal.error} onRetry={proposal.reload} />;
  const p: ProposalDto = proposal.data.proposal;
  if (!interactive || p.status !== 'pending') return <ConsentScreen presented={p.presented} presentedHash={p.presentedHash} status={p.status} />;
  return <ProposalView proposal={p} onChanged={onDecided} />;
}

