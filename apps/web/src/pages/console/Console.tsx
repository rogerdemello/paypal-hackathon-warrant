import { lazy, Suspense, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { ApiError, api } from '../../api';
import { Card, ErrorNote, Spinner } from '../../components/ui';
import { useConfig } from '../../config';
import { useLoad } from '../../hooks';
import { consoleToken, readStored, writeStored } from '../../storage';
import { Attempts } from './Attempts';
import { Catalog } from './Catalog';
import { Disputes } from './Disputes';
import { Orders } from './Orders';
import { Overview } from './Overview';
import { ShowLabContext } from './labContext';
import { RegistryPage } from './RegistryPage';

const Studio = lazy(() => import('./Studio'));


/** The merchant console. In judge mode it is open; otherwise it asks for the console token. */
export function Console() {
  const config = useConfig();
  const [, setTokenVersion] = useState(0);
  const [showLab, setShowLab] = useState(readStored('warrant.showLab') === '1');
  const probe = useLoad(() => api.console.overview(showLab), [config.consoleTokenRequired, showLab]);

  if (probe.error instanceof ApiError && probe.error.code === 'CONSOLE_AUTH') {
    return <TokenForm onSaved={() => { setTokenVersion((v) => v + 1); probe.reload(); }} wrong={consoleToken.get() !== null} />;
  }
  if (probe.data === null && probe.error !== null && !(probe.error instanceof ApiError && probe.error.code === 'CONSOLE_AUTH')) return <div className="page"><ErrorNote error={probe.error} onRetry={probe.reload} /></div>;
  if (probe.data === null) return <div className="page">{probe.error === null ? <Spinner label="Opening the console" /> : <ErrorNote error={probe.error} onRetry={probe.reload} />}</div>;

  const needAttention = probe.data.disputes.needAttention;
  return (
    <div className="page">
      <div className="card-head">
        <div>
          <h1>Merchant console</h1>
          <p className="muted" style={{ margin: 0 }}>
            {config.merchantName}. Orders, rejected checkouts, disputes and the keys behind every signature.
          </p>
        </div>
        <label className="check small">
          <input
            type="checkbox"
            checked={showLab}
            onChange={(e) => {
              writeStored('warrant.showLab', e.target.checked ? '1' : null);
              setShowLab(e.target.checked);
            }}
          />
          Include Dispute Lab runs
        </label>
      </div>
      <nav className="tabs" aria-label="Console sections">
        <NavLink to="/console" end>Overview</NavLink>
        <NavLink to="/console/orders">Orders</NavLink>
        <NavLink to="/console/disputes">Disputes{needAttention > 0 ? ` (${needAttention})` : ''}</NavLink>
        <NavLink to="/console/checkouts">Checkouts</NavLink>
        <NavLink to="/console/catalog">Catalog</NavLink>
        <NavLink to="/console/registry">Registry</NavLink>
        <NavLink to="/console/studio">Analytics</NavLink>
      </nav>
      <ShowLabContext.Provider value={showLab}>
      <Routes>
        <Route index element={<Overview />} />
        <Route path="orders" element={<Orders />} />
        <Route path="orders/:id" element={<Orders />} />
        <Route path="disputes" element={<Disputes />} />
        <Route path="disputes/:id" element={<Disputes />} />
        <Route path="checkouts" element={<Attempts />} />
        <Route path="catalog" element={<Catalog />} />
        <Route path="registry" element={<RegistryPage />} />
        <Route
          path="studio"
          element={
            <Suspense fallback={<Spinner label="Loading analytics" />}>
              <Studio />
            </Suspense>
          }
        />
        <Route path="*" element={<Navigate to="/console" replace />} />
      </Routes>
      </ShowLabContext.Provider>
    </div>
  );
}

function TokenForm({ onSaved, wrong }: { onSaved: () => void; wrong: boolean }) {
  const [value, setValue] = useState('');
  return (
    <div className="page narrow">
      <Card title="Console access">
        <p>This console needs its access token.</p>
        {wrong && <div className="note bad">That token was not accepted.</div>}
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            consoleToken.set(value.trim());
            onSaved();
          }}
        >
          <label className="field">
            Access token
            <input type="password" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" />
          </label>
          <button className="primary" type="submit" disabled={value.trim() === ''}>
            Open the console
          </button>
        </form>
      </Card>
    </div>
  );
}
