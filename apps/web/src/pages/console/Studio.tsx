import { AgStudioLicenseManager } from 'ag-studio';
import { AgStudio } from 'ag-studio-react';
import { useMemo } from 'react';
import { api } from '../../api';
import { Card, ErrorNote, Spinner } from '../../components/ui';
import { useLoad } from '../../hooks';
import { useShowLab } from './labContext';

const licence = import.meta.env['VITE_AG_STUDIO_LICENCE_KEY'] as string | undefined;
if (licence !== undefined && licence !== '') AgStudioLicenseManager.setLicenseKey(licence);

const iso = (seconds: number | null): string | null => (seconds === null ? null : new Date(seconds * 1000).toISOString());

/**
 * AG Studio over the console's data: orders, refused checkouts and disputes become tables an analyst can drag onto a canvas,
 * filter and chart. The data never leaves the browser; AG Studio runs its own engine over these arrays.
 */
export default function Studio() {
  const showLab = useShowLab();
  const data = useLoad(async () => {
    const [orders, attempts, disputes] = await Promise.all([api.console.orders(undefined, showLab), api.console.attempts(showLab), api.console.disputes(undefined, showLab)]);
    return { orders: orders.orders, attempts: attempts.attempts, disputes: disputes.disputes };
  }, [showLab]);

  const sources = useMemo(() => {
    if (data.data === null) return null;
    return [
      {
        id: 'orders',
        data: data.data.orders.map((o) => ({
          order: o.id,
          placed: iso(o.createdAt),
          status: o.status,
          total_usd: o.totalCents / 100,
          items: o.itemCount,
          verifier_mode: o.verifierMode,
          verification: o.verification,
          rules_not_passed: o.rejectedRules.join(', '),
          refunded_usd: o.refundedCents / 100,
          shipping: o.trackingStatus ?? 'not shipped',
        })),
      },
      {
        id: 'checkouts',
        data: data.data.attempts.map((a) => ({
          checkout: a.id,
          when: iso(a.createdAt),
          verdict: a.outcome,
          failed_rules: a.failedRules.join(', '),
          reason: a.reasons[0] ?? '',
          order_created: a.orderId !== null,
        })),
      },
      {
        id: 'disputes',
        data: data.data.disputes.map((d) => ({
          dispute: d.id,
          opened: iso(d.createdAt),
          paypal_reason: d.reason,
          claim: d.claim ?? 'unknown',
          amount_usd: d.amountCents / 100,
          outcome: d.outcome ?? 'pending',
          rule: d.rule ?? '',
          proposed_action: d.action ?? 'none',
          state: d.state,
          hours_left: d.hoursLeft,
        })),
      },
    ];
  }, [data.data]);

  if (sources === null) return data.error === null ? <Spinner label="Loading data" /> : <ErrorNote error={data.error} onRetry={data.reload} />;
  return (
    <Card
      title="Analytics (AG Studio)"
      actions={
        <button className="small" onClick={data.reload}>
          Reload data
        </button>
      }
    >
      <p className="muted small">
        Build your own views: drag fields from <strong>orders</strong>, <strong>checkouts</strong> and <strong>disputes</strong> onto the canvas, for example refused checkouts by rule, or disputes by outcome and responsibility.
      </p>
      <div className="studio-frame">
        <AgStudio data={{ sources }} mode="edit" />
      </div>
    </Card>
  );
}
