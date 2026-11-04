import type { LedgerEntryDto, LedgerVerificationDto } from '@warrant/server/api-types';
import { dateTime, shortHash } from '../format';
import { Badge, Empty } from './ui';

/** A hash-chained audit ledger: each entry commits to the one before it, so any edit shows up as a broken link. */
export function Ledger({ entries, verification }: { entries: readonly LedgerEntryDto[]; verification: LedgerVerificationDto }) {
  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        {verification.ok ? <Badge tone="good">chain intact{verification.length === undefined ? '' : `: ${verification.length} entries`}</Badge> : <Badge tone="bad">chain broken at entry {verification.brokenSeq}</Badge>}
        {!verification.ok && verification.message !== undefined && <span className="muted small">{verification.message}</span>}
      </div>
      {entries.length === 0 ? (
        <Empty>No entries yet.</Empty>
      ) : (
        <ol className="timeline">
          {entries.map((e) => (
            <li key={e.seq}>
              <strong>{e.type.replace(/_/g, ' ')}</strong> <span className="muted small">{dateTime(e.createdAt)}</span>
              <div className="mono muted small" title={e.hash}>
                #{e.seq} {shortHash(e.hash, 8)} after {shortHash(e.prevHash, 6)}
              </div>
              <details>
                <summary className="small">Details</summary>
                <pre>{JSON.stringify(e.payload, null, 2)}</pre>
              </details>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
