import { Link } from 'react-router-dom';
import { api } from '../../api';
import { Badge, Card, ErrorNote, Hash, Spinner, StatusBadge } from '../../components/ui';
import { money, words } from '../../format';
import { useAction, useInterval, useLoad } from '../../hooks';
import { useShowLab } from './labContext';

const MODE_HELP: Record<string, string> = {
  STRICT: 'Refuses any order whose warrant fails a rule, and any order without a warrant.',
  PERMISSIVE: 'Runs the rules and records the result, but sells anyway. Disputes can then show the merchant did not enforce.',
  NONE: 'Does not use warrants at all. Disputes have no signed record to rely on.',
};

export function Overview() {
  const showLab = useShowLab();
  const overview = useLoad(() => api.console.overview(showLab), [showLab]);
  useInterval(overview.reload, 5000);
  const save = useAction(async (change: { merchantMode?: 'STRICT' | 'PERMISSIVE' | 'NONE'; disputeAutopilot?: boolean }) => {
    await api.console.saveSettings(change);
    overview.reload();
  });
  if (overview.data === null) return overview.error === null ? <Spinner /> : <ErrorNote error={overview.error} onRetry={overview.reload} />;
  const o = overview.data;
  return (
    <div className="stack">
      <div className="grid3">
        <div className="kpi">
          <div className="value">{o.orders.total}</div>
          <div className="label">orders</div>
        </div>
        <div className="kpi">
          <div className="value">{money(o.orders.capturedCents)}</div>
          <div className="label">paid through PayPal</div>
        </div>
        <div className="kpi">
          <div className="value">{o.attempts.rejected}</div>
          <div className="label">checkouts refused (of {o.attempts.total})</div>
        </div>
        <div className="kpi">
          <div className="value">{o.disputes.needAttention}</div>
          <div className="label">disputes waiting for you</div>
          <Link to="/console/disputes" className="small">Open the queue</Link>
        </div>
      </div>

      <div className="grid2">
        <Card title="How strictly this shop checks warrants">
          <label className="field">
            Verifier mode
            <select value={o.merchantMode} onChange={(e) => void save.run({ merchantMode: e.target.value as 'STRICT' | 'PERMISSIVE' | 'NONE' })} disabled={save.busy}>
              <option value="STRICT">STRICT</option>
              <option value="PERMISSIVE">PERMISSIVE</option>
              <option value="NONE">NONE</option>
            </select>
          </label>
          <p className="muted small">{MODE_HELP[o.merchantMode]}</p>
          <hr />
          <label className="check">
            <input type="checkbox" checked={o.autopilot} onChange={(e) => void save.run({ disputeAutopilot: e.target.checked })} disabled={save.busy} />
            <span>
              <strong>Autopilot for clear-cut disputes</strong>
              <br />
              <span className="muted small">When on, the dispute agent sends evidence or accepts a claim by itself when the facts are unambiguous. Cases it is unsure of still wait for you. Sandbox demo only.</span>
            </span>
          </label>
          <ErrorNote error={save.error} />
        </Card>

        <Card title="Orders by status">
          {Object.keys(o.orders.byStatus).length === 0 ? (
            <p className="muted">No orders yet. Place one from the shop.</p>
          ) : (
            <div className="row">
              {Object.entries(o.orders.byStatus).map(([status, n]) => (
                <span key={status} className="row">
                  <StatusBadge status={status} /> <strong>{n}</strong>
                </span>
              ))}
            </div>
          )}
          <h3 style={{ marginTop: 16 }}>Disputes by state</h3>
          {Object.keys(o.disputes.byState).length === 0 ? (
            <p className="muted">None.</p>
          ) : (
            <div className="row">
              {Object.entries(o.disputes.byState).map(([state, n]) => (
                <span key={state} className="row">
                  <Badge tone={state === 'escalated' || state === 'awaiting_approval' ? 'warn' : 'neutral'}>{words(state)}</Badge> <strong>{n}</strong>
                </span>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card title="Signing keys in the registry" actions={<Link to="/console/registry" className="small">Manage keys</Link>}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Key</th>
                <th>Kind</th>
                <th>Owner</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {o.keys.map((k) => (
                <tr key={k.kid}>
                  <td className="mono small">{k.kid}</td>
                  <td>{k.kind}</td>
                  <td className="small">{k.owner}</td>
                  <td>
                    <StatusBadge status={k.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small" style={{ marginTop: 8 }}>
          Transparency log: {o.transparency.length} entries, head <Hash value={o.transparency.headHash} />. Mode: {o.mode}, PayPal: {o.paypalEnv}.
        </p>
      </Card>
    </div>
  );
}
