import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { Badge, Card, Empty, ErrorNote, Findings, Spinner, StatusBadge } from '../../components/ui';
import { RULE_NAMES, dateTime } from '../../format';
import { useInterval, useLoad } from '../../hooks';
import { useShowLab } from './labContext';

/** Every checkout the verifier saw, including the ones it turned away and why. */
export function Attempts() {
  const showLab = useShowLab();
  const attempts = useLoad(() => api.console.attempts(showLab), [showLab]);
  useInterval(attempts.reload, 5000);
  const [onlyRefused, setOnlyRefused] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  if (attempts.data === null) return attempts.error === null ? <Spinner /> : <ErrorNote error={attempts.error} onRetry={attempts.reload} />;
  const rows = attempts.data.attempts.filter((a) => !onlyRefused || a.outcome !== 'ACCEPT');
  return (
    <Card
      title="Checkouts the verifier saw"
      actions={
        <label className="check small">
          <input type="checkbox" checked={onlyRefused} onChange={(e) => setOnlyRefused(e.target.checked)} /> Only refused or held
        </label>
      }
    >
      {rows.length === 0 ? (
        <Empty>Nothing here yet. Tamper with a cart in the <Link to="/lab">Dispute Lab</Link> to see the verifier refuse it.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Verdict</th>
                <th>What failed</th>
                <th>Order</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <Fragment key={a.id}>
                  <tr className="clickable" onClick={() => setOpen(open === a.id ? null : a.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setOpen(open === a.id ? null : a.id)}>
                    <td className="small">{dateTime(a.createdAt)}</td>
                    <td>
                      <StatusBadge status={a.outcome} label={a.outcome.toLowerCase()} />
                    </td>
                    <td>
                      {a.failedRules.length === 0 ? <span className="muted">nothing</span> : a.failedRules.map((r) => <Badge key={r} tone="bad">{RULE_NAMES[r] ?? r}</Badge>)}
                      {a.reasons[0] !== undefined && <div className="muted small">{a.reasons[0]}</div>}
                    </td>
                    <td className="small">{a.orderId === null ? 'none' : <Link to={`/console/orders/${a.orderId}`}>{a.orderId}</Link>}</td>
                  </tr>
                  {open === a.id && (
                    <tr>
                      <td colSpan={4}>
                        <Findings findings={a.findings} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
