import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { OrderDetailDto, OrderRowDto } from '@warrant/server/api-types';
import { api } from '../../api';
import { Ledger } from '../../components/Ledger';
import { Badge, Card, ConfirmButton, Empty, ErrorNote, Findings, Spinner, StatusBadge } from '../../components/ui';
import { dateTime, money, RULE_NAMES } from '../../format';
import { useAction, useInterval, useLoad } from '../../hooks';
import { useShowLab } from './labContext';

const STATUSES = ['', 'pending_review', 'created', 'approved', 'captured', 'rejected', 'failed', 'cancelled'];

export function Orders() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const showLab = useShowLab();
  const list = useLoad(() => api.console.orders(status === '' ? undefined : status, showLab), [status, showLab]);
  useInterval(list.reload, 5000);

  return (
    <div className="split">
      <Card
        title="Orders"
        actions={
          <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s === '' ? 'All statuses' : s.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        }
      >
        {list.data === null ? (
          list.error === null ? <Spinner /> : <ErrorNote error={list.error} onRetry={list.reload} />
        ) : list.data.orders.length === 0 ? (
          <Empty>No orders{status === '' ? ' yet. Place one from the shop.' : ' with that status.'}</Empty>
        ) : (
          <OrdersTable rows={list.data.orders} selected={id} onSelect={(row) => navigate(`/console/orders/${row.id}`)} />
        )}
      </Card>
      {id === undefined ? <Card><Empty>Select an order to see its checks, payment and audit trail.</Empty></Card> : <OrderPanel id={id} onChanged={list.reload} />}
    </div>
  );
}

function OrdersTable({ rows, selected, onSelect }: { rows: readonly OrderRowDto[]; selected: string | undefined; onSelect: (row: OrderRowDto) => void }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Placed</th>
            <th>Items</th>
            <th className="right">Total</th>
            <th>Status</th>
            <th>Checks</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.id} className={`clickable ${o.id === selected ? 'selected' : ''}`} onClick={() => onSelect(o)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onSelect(o)}>
              <td className="small">{dateTime(o.createdAt)}</td>
              <td>{o.items}</td>
              <td className="right">{money(o.totalCents, o.currency)}</td>
              <td>
                <StatusBadge status={o.status} />
              </td>
              <td>
                <StatusBadge status={o.verification === 'NO_WARRANT' ? 'neutral' : o.verification} label={o.verification === 'NO_WARRANT' ? 'no warrant' : o.verification.toLowerCase()} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OrderPanel({ id, onChanged }: { id: string; onChanged: () => void }) {
  const detail = useLoad(() => api.console.order(id), [id]);
  const refresh = () => {
    detail.reload();
    onChanged();
  };
  if (detail.data === null) return <Card>{detail.error === null ? <Spinner /> : <ErrorNote error={detail.error} onRetry={detail.reload} />}</Card>;
  const d = detail.data;
  return (
    <div className="stack">
      <Card title={`Order ${d.row.id}`} actions={<StatusBadge status={d.row.status} />}>
        <dl className="facts">
          <dt>Items</dt>
          <dd>{d.row.items}</dd>
          <dt>Total</dt>
          <dd>{money(d.row.totalCents, d.row.currency)}</dd>
          <dt>Merchant mode</dt>
          <dd>{d.row.verifierMode}</dd>
          <dt>PayPal order</dt>
          <dd className="mono small">{d.row.paypalOrderId ?? 'not opened'}</dd>
          <dt>PayPal payment</dt>
          <dd className="mono small">{d.row.captureId ?? 'none'}</dd>
          <dt>Invoice id</dt>
          <dd className="mono small">{d.row.invoiceId ?? 'none'}</dd>
          {d.row.note !== null && (
            <>
              <dt>Note</dt>
              <dd>{d.row.note}</dd>
            </>
          )}
        </dl>
        {d.row.cartJti !== null && (
          <p style={{ marginTop: 10 }}>
            <Link className="btn small" to={`/v/${d.row.cartJti}`}>Open the public proof</Link>
          </p>
        )}
        <OrderActions detail={d} onDone={refresh} />
      </Card>
      <Card title="What the verifier found">
        {d.order.verification.outcome === 'NO_WARRANT' ? <Empty>No warrant: this order was placed without one.</Empty> : <Findings findings={d.order.verification.findings} />}
        {d.order.verification.payer !== undefined && (
          <>
            <h3>Payer check, after PayPal approval</h3>
            <Findings findings={[d.order.verification.payer]} />
          </>
        )}
        {d.row.rejectedRules.length > 0 && <p className="muted small">Rules that did not pass: {d.row.rejectedRules.map((r) => RULE_NAMES[r] ?? r).join('; ')}.</p>}
      </Card>
      <Card title="Fulfilment and refunds">
        {d.tracking === null ? <p className="muted">Not shipped.</p> : (
          <p>
            {d.tracking.carrier} <span className="mono">{d.tracking.trackingNumber}</span> <Badge tone={d.tracking.status === 'delivered' ? 'good' : 'info'}>{d.tracking.status}</Badge>
            <br />
            <span className="muted small">Shipped {dateTime(d.tracking.shippedAt)}{d.tracking.deliveredAt !== null ? `, delivered ${dateTime(d.tracking.deliveredAt)}` : ''}{d.tracking.promisedBy !== null ? `, promised by ${dateTime(d.tracking.promisedBy)}` : ''}</span>
          </p>
        )}
        {d.refunds.map((r) => (
          <p key={r.id} className="small">Refunded {money(r.amountCents)} on {dateTime(r.createdAt)}</p>
        ))}
      </Card>
      <Card title="Audit ledger">
        <Ledger entries={d.ledger.entries} verification={d.ledger.verification} />
      </Card>
    </div>
  );
}

function OrderActions({ detail, onDone }: { detail: OrderDetailDto; onDone: () => void }) {
  const [carrier, setCarrier] = useState('UPS');
  const [tracking, setTracking] = useState('');
  const [refund, setRefund] = useState('');
  const review = useAction(async (decision: 'approve' | 'reject') => {
    await api.console.review(detail.row.id, decision);
    onDone();
  });
  const ship = useAction(async () => {
    const result = await api.console.ship(detail.row.id, carrier, tracking);
    if (result.warning !== null) window.alert(result.warning);
    onDone();
  });
  const deliver = useAction(async () => {
    await api.console.deliver(detail.row.id);
    onDone();
  });
  const doRefund = useAction(async () => {
    const cents = refund.trim() === '' ? undefined : Math.round(Number(refund) * 100);
    await api.console.refund(detail.row.id, cents);
    setRefund('');
    onDone();
  });
  const err = review.error ?? ship.error ?? deliver.error ?? doRefund.error;
  const status = detail.row.status;
  return (
    <div className="stack" style={{ marginTop: 12 }}>
      {status === 'pending_review' && (
        <div className="note warn">
          <strong>This order is held for review.</strong> The checks passed with a question (for example unusual volume).
          <div className="row" style={{ marginTop: 8 }}>
            <button className="primary small" onClick={() => void review.run('approve')} disabled={review.busy}>Approve</button>
            <button className="small danger" onClick={() => void review.run('reject')} disabled={review.busy}>Reject</button>
          </div>
        </div>
      )}
      {status === 'captured' && detail.tracking === null && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void ship.run(); }}>
          <input value={carrier} onChange={(e) => setCarrier(e.target.value)} aria-label="Carrier" style={{ width: 90 }} />
          <input value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder="Tracking number" aria-label="Tracking number" />
          <button className="small" type="submit" disabled={ship.busy || tracking.trim() === ''}>Mark shipped</button>
        </form>
      )}
      {status === 'captured' && detail.tracking?.status === 'shipped' && (
        <button className="small" onClick={() => void deliver.run()} disabled={deliver.busy}>Mark delivered</button>
      )}
      {status === 'captured' && (
        <div className="row">
          <input value={refund} onChange={(e) => setRefund(e.target.value)} placeholder="Amount (blank = rest)" aria-label="Refund amount in dollars" inputMode="decimal" style={{ width: 170 }} />
          <ConfirmButton className="small danger" confirm="Refund this payment through PayPal?" onConfirm={() => void doRefund.run()} disabled={doRefund.busy}>
            Refund
          </ConfirmButton>
        </div>
      )}
      <ErrorNote error={err} />
    </div>
  );
}
