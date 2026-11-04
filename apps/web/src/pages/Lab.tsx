import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ScenarioDto, ScenarioResultDto } from '@warrant/server/api-types';
import { ApiError, api } from '../api';
import { Badge, Card, Empty, ErrorNote, Spinner, Tabs } from '../components/ui';
import { OUTCOME_LABELS, REASON_LABELS, RULE_NAMES, money, outcomeTone, words } from '../format';
import { useAction, useLoad } from '../hooks';
import { consoleToken } from '../storage';

/** The Dispute Lab: replay labelled stories through the real system, or raise a dispute on any paid order. */
export function Lab() {
  const [tab, setTab] = useState<'scenarios' | 'raise'>('scenarios');
  return (
    <div className="page">
      <h1>Dispute Lab</h1>
      <p className="muted">
        Each scenario is a short story run through the real services: a mandate, a cart (sometimes tampered with), a checkout at a strict, permissive or non-supporting merchant, then a payment, delivery and a dispute with a stated claim. The result is compared with what the rules say should happen. Everything runs in the {`PayPal simulator`} or sandbox, never with real money.
      </p>
      <Tabs
        tabs={[
          { id: 'scenarios', label: 'Scenarios' },
          { id: 'raise', label: 'Raise a dispute on an order' },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'scenarios' ? <Scenarios /> : <RaiseDispute />}
    </div>
  );
}

function Scenarios() {
  const list = useLoad(() => api.lab.scenarios(), []);
  const [results, setResults] = useState<Record<string, ScenarioResultDto | { error: string }>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [family, setFamily] = useState<string>('all');

  const runOne = async (id: string): Promise<void> => {
    setRunning(id);
    try {
      const { result } = await api.lab.run(id);
      setResults((r) => ({ ...r, [id]: result }));
    } catch (e) {
      setResults((r) => ({ ...r, [id]: { error: e instanceof Error ? e.message : String(e) } }));
    } finally {
      setRunning(null);
    }
  };
  const batch = useAction(async (ids: readonly string[]) => {
    for (const id of ids) await runOne(id);
  });

  const all = list.data?.scenarios;
  const shown = useMemo(() => (all ?? []).filter((s) => family === 'all' || s.family === family), [all, family]);
  if (list.data === null) {
    if (list.error instanceof ApiError && list.error.code === 'CONSOLE_AUTH') {
      return <Card><p>The Lab needs the console token. <Link to="/console">Enter it in the console</Link>, then come back.</p></Card>;
    }
    return list.error === null ? <Spinner /> : <ErrorNote error={list.error} onRetry={list.reload} />;
  }
  const done = Object.values(results);
  const passed = done.filter((r) => 'passed' in r && r.passed).length;
  const runnable = shown.filter((s) => s.runnable);

  return (
    <div className="stack">
      {!list.data.simulator && <div className="note warn">This server talks to the real PayPal sandbox, so scenarios that need a simulated buyer or dispute desk cannot run here. Checkout-only scenarios still can.</div>}
      <Card
        title="Choose scenarios"
        actions={
          <div className="row">
            <select value={family} onChange={(e) => setFamily(e.target.value)} aria-label="Scenario family">
              <option value="all">All families ({list.data.scenarios.length})</option>
              {list.data.families.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.title} ({f.count})
                </option>
              ))}
            </select>
            <button className="primary small" onClick={() => void batch.run(runnable.map((s) => s.id))} disabled={batch.busy || running !== null}>
              {batch.busy ? 'Running...' : `Run ${runnable.length} shown`}
            </button>
          </div>
        }
      >
        {done.length > 0 && (
          <div className={`note ${passed === done.length ? 'good' : 'bad'}`}>
            {passed} of {done.length} scenarios run did what the rules say they should.
          </div>
        )}
        <ErrorNote error={batch.error} />
      </Card>
      {shown.map((s) => (
        <ScenarioCard key={s.id} scenario={s} result={results[s.id]} running={running === s.id} disabled={running !== null} onRun={() => void runOne(s.id)} />
      ))}
    </div>
  );
}

function ScenarioCard({ scenario, result, running, disabled, onRun }: { scenario: ScenarioDto; result: ScenarioResultDto | { error: string } | undefined; running: boolean; disabled: boolean; onRun: () => void }) {
  const exp = scenario.expect;
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <div className="muted small">{scenario.familyTitle} · {scenario.id}</div>
          <h3 style={{ marginTop: 2 }}>{scenario.title}</h3>
        </div>
        <button className="small" onClick={onRun} disabled={disabled || !scenario.runnable}>
          {running ? 'Running...' : result === undefined ? 'Run' : 'Run again'}
        </button>
      </div>
      <p>{scenario.story}</p>
      <div className="row">
        <Badge>{scenario.merchantMode.toLowerCase()} merchant</Badge>
        {scenario.attack !== null && <Badge tone="warn">{words(scenario.attack)}</Badge>}
        {scenario.dispute !== null && <Badge tone="info">{REASON_LABELS[scenario.dispute.reason] ?? scenario.dispute.reason}</Badge>}
        <span className="muted small">Expected:</span>
        {exp.dispute !== undefined ? (
          <Badge tone={outcomeTone(exp.dispute.outcome)}>{OUTCOME_LABELS[exp.dispute.outcome] ?? exp.dispute.outcome}</Badge>
        ) : (
          <Badge tone={exp.sold ? 'good' : 'bad'}>{exp.sold ? 'order taken' : 'refused'}</Badge>
        )}
        {exp.rejectedRules !== undefined && exp.rejectedRules.length > 0 && <span className="muted small">by {exp.rejectedRules.map((r) => RULE_NAMES[r] ?? r).join(', ')}</span>}
      </div>
      {!scenario.runnable && <p className="muted small">Needs the PayPal simulator.</p>}
      {result !== undefined && ('error' in result ? <div className="note bad" style={{ marginTop: 10 }}>{result.error}</div> : <ResultView result={result} />)}
    </section>
  );
}

function ResultView({ result }: { result: ScenarioResultDto }) {
  const a = result.actual;
  return (
    <div className="stack" style={{ marginTop: 12 }}>
      <div className={`note ${result.passed ? 'good' : 'bad'}`}>
        <strong>{result.passed ? 'As the rules say.' : 'Differs from the expectation.'}</strong> ({result.durationMs} ms{result.latencyMs !== null ? `, ${result.latencyMs} ms from dispute to proposed action` : ''})
        {result.failures.length > 0 && (
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {result.failures.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        )}
      </div>
      <ol className="timeline">
        {result.steps.map((s, i) => (
          <li key={`${s.name}-${i}`}>
            <strong>{words(s.name)}</strong> <span className="muted">{s.detail}</span>
          </li>
        ))}
      </ol>
      {a.outcome !== null && (
        <dl className="facts">
          <dt>Decision</dt>
          <dd>
            <Badge tone={outcomeTone(a.outcome)}>{OUTCOME_LABELS[a.outcome] ?? a.outcome}</Badge> <span className="mono small">{a.rule}</span>
          </dd>
          {a.attribution !== null && (
            <>
              <dt>Responsibility</dt>
              <dd>agent platform {a.attribution.agent_platform}, merchant {a.attribution.merchant}, buyer {a.attribution.principal}</dd>
            </>
          )}
          <dt>Proposed action</dt>
          <dd>{a.action}</dd>
        </dl>
      )}
      <div className="row">
        {a.disputeId !== null && <Link className="btn small" to={`/console/disputes/${a.disputeId}`}>Open the dispute in the console</Link>}
        {a.orderId !== null && <Link className="btn small" to={`/console/orders/${a.orderId}`}>Open the order</Link>}
        {a.cartJti !== null && <Link className="btn small" to={`/v/${a.cartJti}`}>Open the public proof</Link>}
      </div>
    </div>
  );
}

const REASONS = ['UNAUTHORISED', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', 'INCORRECT_AMOUNT', 'DUPLICATE_TRANSACTION', 'OTHER'];

function RaiseDispute() {
  const orders = useLoad(() => api.console.orders('captured'), []);
  const [orderId, setOrderId] = useState('');
  const [reason, setReason] = useState('UNAUTHORISED');
  const [message, setMessage] = useState('I did not authorize this charge.');
  const [hours, setHours] = useState('240');
  const [created, setCreated] = useState<string | null>(null);
  const create = useAction(async () => {
    const result = await api.lab.dispute(orderId, { reason, message, dueInHours: Number(hours) });
    setCreated(result.disputeId);
  });
  const adjudicate = useAction(async (outcome: 'BUYER_FAVOR' | 'SELLER_FAVOR') => {
    if (created !== null) await api.lab.adjudicate(created, outcome);
  });
  const accept = useAction(async () => {
    if (created !== null) await api.lab.buyerAccepts(created);
  });

  if (orders.data === null) return orders.error === null ? <Spinner /> : <ErrorNote error={orders.error} onRetry={orders.reload} />;
  const paid = orders.data.orders;
  return (
    <div className="grid2">
      <Card title="Play the buyer">
        {paid.length === 0 ? (
          <Empty>
            No paid orders yet. <Link to="/">Buy something in the shop</Link> first, then come back to dispute it.
          </Empty>
        ) : (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void create.run();
            }}
          >
            <label className="field">
              Paid order
              <select value={orderId} onChange={(e) => setOrderId(e.target.value)} required>
                <option value="">Choose an order</option>
                {paid.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.items} · {money(o.totalCents, o.currency)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Reason
              <select value={reason} onChange={(e) => setReason(e.target.value)}>
                {REASONS.map((r) => (
                  <option key={r} value={r}>
                    {REASON_LABELS[r] ?? r}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              What the buyer writes
              <textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={1500} />
            </label>
            <label className="field">
              Hours the merchant has to respond
              <input value={hours} onChange={(e) => setHours(e.target.value)} inputMode="decimal" />
            </label>
            <button className="primary" type="submit" disabled={create.busy || orderId === '' || message.trim() === ''}>
              {create.busy ? 'Raising...' : 'Raise the dispute'}
            </button>
            <p className="muted small">Try a message that contradicts the reason, or one that tells the agent what to do, and watch what the pipeline does with it.</p>
            <ErrorNote error={create.error} />
          </form>
        )}
      </Card>
      <Card title="Then play PayPal">
        {created === null ? (
          <Empty>Raise a dispute first.</Empty>
        ) : (
          <div className="stack">
            <div className="note good">
              Dispute <span className="mono">{created}</span> opened. The dispute agent has already read it.
            </div>
            <Link className="btn primary" to={`/console/disputes/${created}`}>
              Open it in the console
            </Link>
            <p className="muted small">After you (as the merchant) answer it, use these to move it along as PayPal and the buyer would:</p>
            <div className="row">
              <button className="small" onClick={() => void adjudicate.run('SELLER_FAVOR')} disabled={adjudicate.busy}>Decide for the seller</button>
              <button className="small" onClick={() => void adjudicate.run('BUYER_FAVOR')} disabled={adjudicate.busy}>Decide for the buyer</button>
              <button className="small" onClick={() => void accept.run()} disabled={accept.busy}>Buyer accepts the offer</button>
            </div>
            <ErrorNote error={adjudicate.error ?? accept.error} />
          </div>
        )}
        {consoleToken.get() !== null && <p className="muted small">Using the console token saved in this browser.</p>}
      </Card>
    </div>
  );
}
