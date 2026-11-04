import { useState, type ReactNode } from 'react';
import type { FindingDto } from '@warrant/server/api-types';
import { ApiError } from '../api';
import { RULE_NAMES, shortHash, statusTone, type Tone } from '../format';

/** Small building blocks shared by every page. */

export function Badge({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`badge ${tone === 'neutral' ? '' : tone}`} {...(title === undefined ? {} : { title })}>
      {children}
    </span>
  );
}

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return <Badge tone={statusTone(status)}>{label ?? status.replace(/_/g, ' ')}</Badge>;
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span className="row" role="status">
      <span className="spinner" aria-hidden="true" />
      <span className="muted small">{label}...</span>
    </span>
  );
}

export function ErrorNote({ error, onRetry }: { error: Error | null; onRetry?: () => void }) {
  if (error === null) return null;
  const problems = error instanceof ApiError ? error.problems : [];
  return (
    <div className="note bad" role="alert">
      <strong>{error.message}</strong>
      {problems.length > 0 && (
        <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {onRetry !== undefined && (
        <div style={{ marginTop: 8 }}>
          <button className="small" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="muted" style={{ padding: '12px 0' }}>{children}</p>;
}

export function Card({ title, actions, children, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title !== undefined || actions !== undefined) && (
        <div className="card-head">
          {typeof title === 'string' ? <h2>{title}</h2> : title}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

/** A hash or id, shortened, with its full value on hover and a copy button. */
export function Hash({ value, keep = 8 }: { value: string | null | undefined; keep?: number }) {
  const [copied, setCopied] = useState(false);
  if (value === null || value === undefined) return <span className="muted">none</span>;
  return (
    <span className="mono" title={value}>
      {shortHash(value, keep)}{' '}
      <button
        className="ghost small"
        aria-label={`Copy ${value}`}
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? 'copied' : 'copy'}
      </button>
    </span>
  );
}

const MARKS: Record<FindingDto['outcome'], string> = { pass: '✓', review: '?', reject: '✕' };

/** The verifier's findings, one line per rule result, in plain words. */
export function Findings({ findings, showPasses = true }: { findings: readonly FindingDto[]; showPasses?: boolean }) {
  const shown = showPasses ? findings : findings.filter((f) => f.outcome !== 'pass');
  if (shown.length === 0) return <Empty>No findings.</Empty>;
  return (
    <div>
      {shown.map((f, i) => (
        <div key={`${f.rule}-${i}`} className={`finding ${f.outcome}`}>
          <span className="mark" aria-label={f.outcome}>
            {MARKS[f.outcome]}
          </span>
          <div>
            <div className="what">
              {RULE_NAMES[f.rule] ?? f.rule} <span className="muted mono small">{f.rule.slice(0, 3)}</span>
            </div>
            <div className="muted small">{f.detail}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: ReadonlyArray<{ id: T; label: string; count?: number }>; value: T; onChange: (id: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={t.id === value} className={t.id === value ? 'active' : ''} onClick={() => onChange(t.id)}>
          {t.label}
          {t.count !== undefined && t.count > 0 ? ` (${t.count})` : ''}
        </button>
      ))}
    </div>
  );
}

export function Json({ value }: { value: unknown }) {
  return <pre>{JSON.stringify(value, null, 2)}</pre>;
}

/** Ask for confirmation before a consequential click. */
export function ConfirmButton({ children, confirm, onConfirm, className = '', disabled = false }: { children: ReactNode; confirm: string; onConfirm: () => void; className?: string; disabled?: boolean }) {
  return (
    <button
      className={className}
      disabled={disabled}
      onClick={() => {
        if (window.confirm(confirm)) onConfirm();
      }}
    >
      {children}
    </button>
  );
}
