import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { DisputeActionDto, DisputeDetailDto, DisputeRowDto } from '@warrant/server/api-types';
import { api } from '../../api';
import { Ledger } from '../../components/Ledger';
import { Badge, Card, Empty, ErrorNote, Hash, Spinner, StatusBadge } from '../../components/ui';
import { ACTION_LABELS, FACT_LABELS, OUTCOME_LABELS, REASON_LABELS, dateTime, money, outcomeTone, words } from '../../format';
import { useAction, useInterval, useLoad } from '../../hooks';
import { useShowLab } from './labContext';

const STATES = ['', 'awaiting_approval', 'escalated', 'responded', 'closed', 'received'];
const FACT_IDS = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'F13'] as const;

export function Disputes() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState('');
  const showLab = useShowLab();
  const list = useLoad(() => api.console.disputes(state === '' ? undefined : state, showLab), [state, showLab]);
  useInterval(list.reload, 4000);

  return (
    <div className="split">
      <Card
        title="Dispute queue"
        actions={
          <select value={state} onChange={(e) => setState(e.target.value)} aria-label="Filter by state">
            {STATES.map((s) => (
              <option key={s} value={s}>
                {s === '' ? 'All' : words(s)}
              </option>
            ))}
          </select>
        }
      >
        {list.data === null ? (
          list.error === null ? <Spinner /> : <ErrorNote error={list.error} onRetry={list.reload} />
        ) : list.data.disputes.length === 0 ? (
          <Empty>
            No disputes. Raise one in the <Link to="/lab">Dispute Lab</Link> on a paid order, or run a scenario.
          </Empty>
        ) : (
          <Queue rows={list.data.disputes} selected={id} onSelect={(row) => navigate(`/console/disputes/${row.id}`)} />
        )}
      </Card>
      {id === undefined ? <Card><Empty>Select a dispute to see the proof, the decision and what the agent proposes to do.</Empty></Card> : <DisputePanel id={id} onChanged={list.reload} />}
    </div>
  );
}

function Queue({ rows, selected, onSelect }: { rows: readonly DisputeRowDto[]; selected: string | undefined; onSelect: (row: DisputeRowDto) => void }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Dispute</th>
            <th>Reason</th>
            <th className="right">Amount</th>
            <th>Decision</th>
            <th>Time left</th>
            <th>State</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id} className={`clickable ${d.id === selected ? 'selected' : ''}`} onClick={() => onSelect(d)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onSelect(d)}>
              <td className="mono small">{d.id}</td>
              <td>{REASON_LABELS[d.reason] ?? words(d.reason)}</td>
              <td className="right">{money(d.amountCents, d.currency)}</td>
              <td>{d.outcome === null ? <span className="muted">analysing</span> : <Badge tone={outcomeTone(d.outcome)}>{OUTCOME_LABELS[d.outcome] ?? d.outcome}</Badge>}</td>
              <td>{d.hoursLeft === null ? '' : <Badge tone={d.hoursLeft < 24 ? 'bad' : 'neutral'}>{d.hoursLeft < 48 ? `${Math.max(d.hoursLeft, 0).toFixed(0)} h` : `${Math.round(d.hoursLeft / 24)} d`}</Badge>}</td>
              <td>
                <StatusBadge status={d.state} label={words(d.state)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DisputePanel({ id, onChanged }: { id: string; onChanged: () => void }) {
  const detail = useLoad(() => api.console.dispute(id), [id]);
  useInterval(detail.reload, 4000);
  const refresh = () => {
    detail.reload();
    onChanged();
  };
  const analyze = useAction(async () => {
    await api.console.analyze(id);
    refresh();
  });
  const refetch = useAction(async () => {
    await api.console.refreshDispute(id);
    refresh();
  });
  if (detail.data === null) return <Card>{detail.error === null ? <Spinner /> : <ErrorNote error={detail.error} onRetry={detail.reload} />}</Card>;
  const d = detail.data;
  const current = [...d.actions].reverse().find((a) => a.status !== 'superseded') ?? null;
  return (
    <div className="stack">
      <Card title={`Dispute ${d.dispute.id}`} actions={<StatusBadge status={d.dispute.state} label={words(d.dispute.state)} />}>
        <dl className="facts">
          <dt>Reason PayPal recorded</dt>
          <dd>{REASON_LABELS[d.dispute.reason] ?? d.dispute.reason}</dd>
          <dt>Amount</dt>
          <dd>{money(d.dispute.amountCents, d.dispute.currency)}</dd>
          <dt>PayPal status</dt>
          <dd>{words(d.dispute.status)}{d.dispute.stage !== null ? `, ${d.dispute.stage.toLowerCase()}` : ''}</dd>
          <dt>Respond by</dt>
          <dd>
            {dateTime(d.dispute.responseDueBy)} {d.row.hoursLeft !== null && <Badge tone={d.row.hoursLeft < 24 ? 'bad' : 'neutral'}>{Math.round(d.row.hoursLeft)} hours left</Badge>}
          </dd>
          <dt>Order</dt>
          <dd>{d.order === null ? <span className="muted">not one of ours</span> : <Link to={`/console/orders/${d.order.id}`}>{d.order.id}</Link>}</dd>
        </dl>
        {d.dispute.buyerMessage !== null && (
          <blockquote style={{ margin: '12px 0 0', padding: '8px 12px', borderLeft: '3px solid var(--line)' }}>
            <div className="muted small">The buyer wrote</div>
            {d.dispute.buyerMessage}
          </blockquote>
        )}
        <div className="row" style={{ marginTop: 12 }}>
          <button className="small" onClick={() => void refetch.run()} disabled={refetch.busy}>Refresh from PayPal</button>
          <button className="small" onClick={() => void analyze.run()} disabled={analyze.busy}>Run the analysis again</button>
          {d.verifyUrl !== null && <a className="btn small" href={d.verifyUrl.replace(/^https?:\/\/[^/]+/, '')}>Open the public proof</a>}
        </div>
        <ErrorNote error={refetch.error ?? analyze.error} />
      </Card>

      {d.analysis === null ? (
        <Card><Empty>No analysis yet.</Empty></Card>
      ) : (
        <>
          <Card title="1. The facts, computed from the signed record">
            <div className="grid2">
              {FACT_IDS.map((fid) => {
                const f = d.analysis?.facts[fid];
                if (f === undefined) return null;
                const numeric = typeof f.value === 'number';
                return (
                  <details key={fid}>
                    <summary>
                      <span aria-hidden="true">{numeric ? '•' : f.value === true ? '✓' : '✕'}</span> {FACT_LABELS[fid] ?? f.name}
                      {numeric && <strong>: {Math.round(Number(f.value))}</strong>} <span className="muted small">{fid}</span>
                    </summary>
                    <ul className="small mono" style={{ margin: 0, paddingLeft: 18 }}>
                      {f.evidence.map((e) => (
                        <li key={e}>{e}</li>
                      ))}
                    </ul>
                  </details>
                );
              })}
            </div>
          </Card>

          <Card title="2. The decision (deterministic table, not a model)">
            <div className="row">
              <Badge tone={outcomeTone(d.analysis.decision.outcome)}>{OUTCOME_LABELS[d.analysis.decision.outcome] ?? d.analysis.decision.outcome}</Badge>
              <span className="mono small">{d.analysis.decision.rule}</span>
              {d.analysis.decision.confidence === 'low' && <Badge tone="warn">low confidence</Badge>}
              {d.analysis.decision.claimConflict && <Badge tone="bad">reason and message disagree</Badge>}
            </div>
            <dl className="facts" style={{ marginTop: 10 }}>
              <dt>Claim read as</dt>
              <dd>{words(d.analysis.decision.claim)} <span className="muted small">(from {d.analysis.decision.claimSource.replace(/_/g, ' ')})</span></dd>
              <dt>Responsibility</dt>
              <dd>
                agent platform <strong>{d.analysis.decision.attribution.agent_platform}</strong>, merchant <strong>{d.analysis.decision.attribution.merchant}</strong>, buyer <strong>{d.analysis.decision.attribution.principal}</strong>
              </dd>
              {d.analysis.decision.flags.length > 0 && (
                <>
                  <dt>Flags</dt>
                  <dd>{d.analysis.decision.flags.map((f) => <Badge key={f}>{f.replace(/_/g, ' ')}</Badge>)}</dd>
                </>
              )}
            </dl>
            <p className="muted small" style={{ marginBottom: 0 }}>{d.analysis.decision.caveat}</p>
          </Card>
        </>
      )}

      {current !== null && <ActionCard action={current} dispute={d} onDone={refresh} />}

      <Card title="Audit ledger">
        <Ledger entries={d.ledger.entries} verification={d.ledger.verification} />
      </Card>
    </div>
  );
}

function ActionCard({ action, dispute, onDone }: { action: DisputeActionDto; dispute: DisputeDetailDto; onDone: () => void }) {
  const approve = useAction(async () => {
    await api.console.approveAction(action.id);
    onDone();
  });
  const reject = useAction(async () => {
    await api.console.rejectAction(action.id);
    onDone();
  });
  const download = useAction(async () => {
    const { blob, name } = await api.console.packet(dispute.dispute.id);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
  });
  const waiting = action.status === 'proposed';
  const label = action.actionType === 'alert' ? 'Acknowledge' : action.actionType === 'provide-evidence' ? 'Approve and send evidence' : action.actionType === 'accept-claim' ? 'Approve and accept the claim' : action.actionType === 'make-offer' ? 'Approve and make the offer' : 'Approve';
  return (
    <Card title="3. What the agent proposes" actions={<StatusBadge status={action.status} />}>
      <p style={{ fontSize: '1.05rem', marginTop: 0 }}>
        <strong>{ACTION_LABELS[action.actionType] ?? action.actionType}</strong>
        {Object.keys(action.params).length > 0 && <span className="muted small"> ({Object.entries(action.params).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${String(v)}`).join(', ')})</span>}
      </p>
      <p className="muted small">
        The action was checked against what PayPal allows for this dispute right now. {action.approvedBy !== null && <>Decided by <strong>{action.approvedBy}</strong>.</>}
      </p>
      <h3>Liability memo <Badge tone={action.noteSource === 'model' ? 'info' : 'neutral'}>{action.noteSource === 'model' ? 'written by a model, checked against the facts' : action.noteSource.startsWith('template (model') ? 'model text rejected, template used' : 'written from a template'}</Badge></h3>
      <pre style={{ whiteSpace: 'pre-wrap' }}>{action.memo}</pre>
      {action.actionType === 'provide-evidence' && (
        <>
          <h3 style={{ marginTop: 12 }}>Evidence note sent to PayPal</h3>
          <pre style={{ whiteSpace: 'pre-wrap' }}>{action.evidenceNote}</pre>
          {dispute.packet !== null && (
            <p className="small">
              Evidence packet: {dispute.packet.fileName}, {Math.round(dispute.packet.sizeBytes / 1024)} KB, <Hash value={dispute.packet.sha256} />{' '}
              <button className="small" onClick={() => void download.run()} disabled={download.busy}>Download PDF</button>
            </p>
          )}
        </>
      )}
      {(action.actionType === 'accept-claim' || action.actionType === 'make-offer') && (
        <>
          <h3 style={{ marginTop: 12 }}>Message to the buyer</h3>
          <pre style={{ whiteSpace: 'pre-wrap' }}>{action.buyerMessage}</pre>
        </>
      )}
      {action.error !== null && <div className="note bad" style={{ marginTop: 8 }}>{action.error}</div>}
      {waiting && (
        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" onClick={() => void approve.run()} disabled={approve.busy || reject.busy}>{approve.busy ? 'Sending...' : label}</button>
          {action.actionType !== 'alert' && <button onClick={() => void reject.run()} disabled={approve.busy || reject.busy}>I will handle it myself</button>}
        </div>
      )}
      <ErrorNote error={approve.error ?? reject.error ?? download.error} />
    </Card>
  );
}
