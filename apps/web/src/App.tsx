import { NavLink, Route, Routes } from 'react-router-dom';
import { ConfigProvider, useConfig } from './config';
import { Console } from './pages/console/Console';
import { CheckoutCancelled, CheckoutReturn } from './pages/CheckoutReturn';
import { Lab } from './pages/Lab';
import { Shopper } from './pages/Shopper';
import { Verify } from './pages/Verify';
import { useTheme } from './theme';

export function App() {
  return (
    <ConfigProvider>
      <Shell />
    </ConfigProvider>
  );
}

function Shell() {
  const config = useConfig();
  const [theme, toggleTheme] = useTheme();
  return (
    <div className="shell">
      {config.paypalEnv === 'simulator' && (
        <div className="banner" role="note">
          Demo mode: PayPal is replaced by a built-in sandbox simulator. No real money moves, and no PayPal credentials are needed.
        </div>
      )}
      <header className="topbar">
        <NavLink to="/" className="brand" end>
          <span className="brand-mark" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 8.5l3.2 3.2L13 5" />
            </svg>
          </span>
          Warrant
        </NavLink>
        <nav className="nav" aria-label="Main">
          <NavLink to="/" end>Shop</NavLink>
          <NavLink to="/console">Merchant console</NavLink>
          <NavLink to="/lab">Dispute Lab</NavLink>
        </nav>
        <span className="spacer" />
        <span className="merchant-chip">{config.merchantName}</span>
        <button className="icon-btn" onClick={toggleTheme} aria-label={theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'} title={theme === 'dark' ? 'Light theme' : 'Dark theme'}>
          {theme === 'dark' ? '☀' : '☾'}
        </button>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Shopper />} />
          <Route path="/v/:cartJti" element={<Verify />} />
          <Route path="/checkout/return" element={<CheckoutReturn />} />
          <Route path="/checkout/cancel" element={<CheckoutCancelled />} />
          <Route path="/console/*" element={<Console />} />
          <Route path="/lab" element={<Lab />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <footer className="site-footer">
        <span>Warrant: signed proof of what a person authorised an AI agent to buy. Sandbox only; no real money moves.</span>
        <span>{config.paypalEnv === 'simulator' ? 'PayPal: built-in simulator' : 'PayPal: sandbox'}</span>
      </footer>
    </div>
  );
}

function NotFound() {
  return (
    <div className="page narrow">
      <h1>Page not found</h1>
      <p>
        <NavLink to="/">Back to the shop</NavLink>
      </p>
    </div>
  );
}
