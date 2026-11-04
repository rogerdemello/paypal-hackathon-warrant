import type { RegistryAuditDto } from '@warrant/server/api-types';
import { useState } from 'react';
import { api } from '../../api';
import { Badge, Card, ConfirmButton, ErrorNote, Hash, Spinner, StatusBadge } from '../../components/ui';
import { dateTime } from '../../format';
import { useAction, useLoad } from '../../hooks';

/** The registry: who may sign, whether they still may, and the append-only log that dates every warrant. */
export function RegistryPage() {
  const keys = useLoad(() => api.console.keys(), []);
  const log = useLoad(() => api.registry.log(), []);
  const [audit, setAudit] = useState<RegistryAuditDto | null>(null);
  const setStatus = useAction(async (kid: string, status: 'active' | 'suspended' | 'revoked') => {
    await api.console.setKeyStatus(kid, status);
    keys.reload();
    log.reload();
  });
  const check = useAction(async () => {
    const result = await api.console.checkpoint();
    setAudit(result.audit);
    log.reload();
  });

  return (
    <div className="stack">
      <Card title="Keys">
        <p className="muted small">
          Revoking a key stops anything it signs from being accepted from now on. Past signatures are judged by the key's status when they were made, so evidence already collected is not rewritten. Try it: revoke the agent platform key, then run a checkout.
        </p>
        {keys.data === null ? (
          keys.error === null ? <Spinner /> : <ErrorNote error={keys.error} onRetry={keys.reload} />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Kind</th>
                  <th>Owner</th>
                  <th>Status</th>
                  <th>Valid from</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {keys.data.keys.map((k) => (
                  <tr key={k.kid}>
                    <td className="mono small">{k.kid}</td>
                    <td>{k.kind}</td>
                    <td className="small">{k.owner}</td>
                    <td>
                      <StatusBadge status={k.status} />
                    </td>
                    <td className="small">{dateTime(k.valid_from)}</td>
                    <td className="row">
                      {k.status !== 'active' && <button className="small" onClick={() => void setStatus.run(k.kid, 'active')} disabled={setStatus.busy}>Reinstate</button>}
                      {k.status === 'active' && <button className="small" onClick={() => void setStatus.run(k.kid, 'suspended')} disabled={setStatus.busy}>Suspend</button>}
                      {k.status !== 'revoked' && (
                        <ConfirmButton className="small danger" confirm={`Revoke ${k.kid}? Carts signed with it will be refused.`} onConfirm={() => void setStatus.run(k.kid, 'revoked')} disabled={setStatus.busy}>
                          Revoke
                        </ConfirmButton>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <ErrorNote error={setStatus.error} />
      </Card>

      <Card
        title="Transparency log"
        actions={
          <button className="small" onClick={() => void check.run()} disabled={check.busy}>
            Sign a checkpoint and audit the log
          </button>
        }
      >
        {audit !== null && (
          <div className={`note ${audit.ok ? 'good' : 'bad'}`} style={{ marginBottom: 10 }}>
            {audit.ok ? `The log is intact: ${audit.length} entries, head ${audit.headSeq}.` : `Problems found: ${audit.problems.map((p) => p.message).join('; ')}`}
          </div>
        )}
        {log.data === null ? (
          log.error === null ? <Spinner /> : <ErrorNote error={log.error} onRetry={log.reload} />
        ) : (
          <>
            <p className="muted small">
              Head <Hash value={log.data.head?.hash} />
              {log.data.checkpoint !== null && <> · latest signed checkpoint covers entry {log.data.checkpoint.seq} ({dateTime(log.data.checkpoint.issuedAt)})</>} · log key <span className="mono">{log.data.logKey.kid}</span>
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>What</th>
                    <th>Details</th>
                    <th>Entry hash</th>
                  </tr>
                </thead>
                <tbody>
                  {[...log.data.entries].reverse().map((e) => {
                    const p = e.payload as Record<string, unknown>;
                    return (
                      <tr key={e.seq}>
                        <td>{e.seq}</td>
                        <td>
                          <Badge tone={e.type === 'warrant_logged' ? 'info' : 'neutral'}>{e.type.replace(/_/g, ' ')}</Badge>
                        </td>
                        <td className="small mono">{typeof p['cart_jti'] === 'string' ? p['cart_jti'] : typeof p['kid'] === 'string' ? p['kid'] : ''}</td>
                        <td>
                          <Hash value={e.hash} keep={6} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
