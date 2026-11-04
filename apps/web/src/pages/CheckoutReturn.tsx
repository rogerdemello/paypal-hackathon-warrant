import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Card, ErrorNote, Spinner } from '../components/ui';
import { lastSession } from '../storage';

/** Where PayPal sends the buyer back to. Finishes the order, then returns to the conversation with the result. */
export function CheckoutReturn() {
  const [params] = useSearchParams();
  const order = params.get('order');
  const navigate = useNavigate();
  const [error, setError] = useState<Error | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current || order === null) return;
    started.current = true;
    void (async () => {
      try {
        const session = lastSession.get();
        if (session !== null) {
          try {
            const updated = await api.agent.complete(session);
            if (updated.session.stage === 'done') {
              void navigate('/', { replace: true });
              return;
            }
          } catch {
            // Not this browser's conversation, or it has moved on: finish the order directly below.
          }
        }
        const done = await api.merchant.complete(order);
        setMessage(done.status === 'captured' ? 'Payment complete.' : done.message);
        if (done.cartJti !== null && done.status === 'captured') void navigate(`/v/${done.cartJti}`, { replace: true });
      } catch (e) {
        setError(e instanceof Error ? e : new Error(String(e)));
      }
    })();
  }, [order, navigate]);

  if (order === null) return <div className="page narrow"><ErrorNote error={new Error('This page needs an order id.')} /></div>;
  return (
    <div className="page narrow stack">
      <Card title="Finishing your order">
        {error === null && message === null && <Spinner label="Confirming your payment with PayPal" />}
        {message !== null && <p>{message}</p>}
        <ErrorNote error={error} />
        <Link to="/">Back to the shop</Link>
      </Card>
    </div>
  );
}

export function CheckoutCancelled() {
  return (
    <div className="page narrow stack">
      <Card title="Payment cancelled">
        <p>You left PayPal without paying. Nothing was charged; your approved cart is still waiting if you want to continue.</p>
        <Link className="btn primary" to="/">
          Back to the shop
        </Link>
      </Card>
    </div>
  );
}
