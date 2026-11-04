import { Link, useParams } from 'react-router-dom';
import type { VerificationReportDto } from '@warrant/server/api-types';
import { ApiError, api } from '../api';
import { Badge, Card, Empty, ErrorNote, Findings, Hash, Json, Spinner, StatusBadge } from '../components/ui';
import { FACT_LABELS, dateTime, isoDateTime, money, moneyText, outcomeTone, OUTCOME_LABELS } from '../format';
import { useLoad } from '../hooks';

/** The facts that together say "the human authorised exactly this": F1 to F8. */
const AUTHORISATION_FACTS = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8'] as const;

export type Verdict = { tone: 'good' | 'warn' | 'bad'; headline: string; detail: string };

/** One headline for the page, from the same facts the dispute agent uses. */
export function verdictOf(report: VerificationReportDto): Verdict {
  if (!report.found) return { tone: 'bad', headline: 'No such warrant', detail: 'This merchant has no signed warrant with that id.' };
  const brokenSigner = report.signers.find((s) => !s.ok);
  if (brokenSigner !== undefined) return { tone: 'bad', headline: 'A signature does not verify', detail: brokenSigner.detail };
  const badKey = report.signers.find((s) => s.keyStatus !== 'active');
  if (badKey !== undefined) return { tone: 'bad', headline: 'A signing key is not in good standing', detail: `The ${badKey.subject} key is ${badKey.keyStatus ?? 'unknown to the registry'}.` };
  if (report.transparency.proofValid === false) return { tone: 'bad', headline: 'The transparency log does not vouch for this warrant', detail: report.transparency.proofReason ?? 'The inclusion proof failed.' };
  const failed = AUTHORISATION_FACTS.flatMap((id) => report.facts.filter((f) => f.id === id && !f.value));
  if (report.facts.length === 0) return { tone: 'warn', headline: 'Signed, but no order has been matched yet', detail: 'The signatures verify. The order, payer and delivery checks need a PayPal order.' };
  if (failed.length > 0) return { tone: 'warn', headline: 'Signed, with open questions', detail: `Not established: ${failed.map((f) => FACT_LABELS[f.id] ?? f.name).join('; ')}.` };
  return { tone: 'good', headline: 'Verified: the human authorised exactly this purchase', detail: 'Every signature verifies, the keys were in good standing, and the order matches what was approved.' };
}

export function Verify() {
  const { cartJti = '' } = useParams();
  const report = useLoad(async () => {
    try {
      return await api.verify(cartJti);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        return { found: false, cartJti, mandate: null, cart: null, signers: [], facts: [], checkoutFindings: [], order: null, transparency: { included: false, seq: null, entryHash: null, loggedAt: null, proofValid: null, proofReason: null, checkpointSeq: null }, dispute: null, generatedAt: Math.floor(Date.now() / 1000) } satisfies VerificationReportDto;
      }
      throw e;
    }
  }, [cartJti]);

  if (report.data === null) {
    return <div className="page narrow">{report.error === null ? <Spinner label="Checking the record" /> : <ErrorNote error={report.error} onRetry={report.reload} />}</div>;
  }
  const r = report.data;
  const verdict = verdictOf(r);

  return (
    <div className="page narrow stack">
      <div>
        <h1>Warrant verification</h1>
        <p className="muted">
          This page re-checks a signed record of what a person authorised an AI agent to buy. It needs no login and does not trust the shop: everything below is recomputed from the signed objects and the public registry.
        </p>
      </div>

      <div className={`seal ${verdict.tone}`} role="status">
        <div className="icon" aria-hidden="true">{verdict.tone === 'good' ? '✓' : verdict.tone === 'warn' ? '!' : '✕'}</div>
        <div>
          <h2 style={{ margin: 0 }}>{verdict.headline}</h2>
          <div className="muted">{verdict.detail}</div>
          <div className="muted small mono" style={{ marginTop: 4 }}>cart warrant {r.cartJti}</div>
        </div>
      </div>

      {r.found && (
        <>
          {r.mandate !== null && (
            <Card title="1. What the person asked for">
              <p style={{ fontSize: '1.05rem' }}>&ldquo;{r.mandate.instruction}&rdquo;</p>
              <dl className="facts">
                <dt>Spending limit</dt>
                <dd>
                  {moneyText(r.mandate.scope.maxTotal, r.mandate.scope.currency)} in total ({r.mandate.scope.budgetMode === 'cumulative' ? 'across all carts' : 'per cart'}), {moneyText(r.mandate.scope.maxPerItem, r.mandate.scope.currency)} per item, {r.mandate.scope.maxItems} item{r.mandate.scope.maxItems === 1 ? '' : 's'}
                </dd>
                <dt>Kinds of product</dt>
                <dd>{r.mandate.scope.categoriesAllow === null ? 'any' : r.mandate.scope.categoriesAllow.map((c) => c.replace(/_/g, ' ')).join(', ')}</dd>
                <dt>Approval needed</dt>
                <dd>{r.mandate.scope.mode === 'human_present' ? 'for every cart' : 'not for each cart, within these limits'}</dd>
                <dt>Valid</dt>
                <dd>
                  {dateTime(r.mandate.validFrom)} to {dateTime(r.mandate.validUntil)}
                </dd>
                <dt>PayPal account bound</dt>
                <dd>{r.mandate.payerLinked ? 'yes, the mandate names the paying account' : 'no, not yet linked when signed'}</dd>
                <dt>Signed by</dt>
                <dd className="mono small">{r.mandate.issuer}</dd>
                <dt>Mandate fingerprint</dt>
                <dd>
                  <Hash value={r.mandate.hash} />
                </dd>
              </dl>
            </Card>
          )}

          {r.cart !== null && (
            <Card title="2. The cart that was approved">
              <table>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="right">Qty</th>
                    <th className="right">Unit price</th>
                  </tr>
                </thead>
                <tbody>
                  {r.cart.items.map((i) => (
                    <tr key={i.sku}>
                      <td>{i.title}</td>
                      <td className="right">{i.qty}</td>
                      <td className="right">{moneyText(i.unit_price, r.cart?.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p style={{ marginTop: 8 }}>
                <strong>Total {moneyText(r.cart.total, r.cart.currency)}</strong>
              </p>
              <dl className="facts">
                <dt>Consent</dt>
                <dd>
                  {r.cart.consent.mode === 'human_present'
                    ? `Approved by the person on ${isoDateTime(r.cart.consent.approvedAt)} (${r.cart.consent.method ?? 'click'})`
                    : 'Not needed for this cart: the mandate lets the agent buy within its limits'}
                </dd>
                {r.cart.consent.presentedHash !== null && (
                  <>
                    <dt>Screen they saw</dt>
                    <dd>
                      <Hash value={r.cart.consent.presentedHash} />
                    </dd>
                  </>
                )}
                <dt>Cart fingerprint</dt>
                <dd>
                  <Hash value={r.cart.cartHash} />
                </dd>
                <dt>Addressed to</dt>
                <dd className="mono small">{r.cart.audience}</dd>
                <dt>Agent platform</dt>
                <dd className="mono small">{r.cart.issuer}</dd>
              </dl>
            </Card>
          )}

          <Card title="3. Who signed, and were their keys good">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Signed object</th>
                    <th>Key</th>
                    <th>Owner</th>
                    <th>Key status now</th>
                    <th>Signature</th>
                  </tr>
                </thead>
                <tbody>
                  {r.signers.map((s) => (
                    <tr key={s.subject}>
                      <td>{s.subject}</td>
                      <td className="mono small">{s.kid ?? 'none'}</td>
                      <td className="small">{s.owner ?? 'unknown'}</td>
                      <td>{s.keyStatus === null ? <Badge tone="bad">not in registry</Badge> : <StatusBadge status={s.keyStatus} />}</td>
                      <td>{s.ok ? <Badge tone="good">valid</Badge> : <Badge tone="bad">invalid</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small">
              Keys are published at <a href="/api/registry/jwks.json">/api/registry/jwks.json</a>. The record is judged by the key's status at the time it was signed, so a later revocation does not rewrite history.
            </p>
          </Card>

          <Card title="4. The checks a reviewer would run">
            {r.facts.length === 0 ? (
              <Empty>No PayPal order is linked to this warrant yet, so the order, payer and delivery checks have nothing to compare.</Empty>
            ) : (
              <div className="stack">
                {r.facts
                  .filter((f) => (AUTHORISATION_FACTS as readonly string[]).includes(f.id))
                  .map((f) => (
                    <details key={f.id}>
                      <summary>
                        <span aria-hidden="true">{f.value ? '✓' : '✕'}</span> {FACT_LABELS[f.id] ?? f.name}{' '}
                        <span className="muted small">{f.id}</span>
                      </summary>
                      <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                        {f.evidence.map((e) => (
                          <li key={e} className="mono">{e}</li>
                        ))}
                      </ul>
                    </details>
                  ))}
                <h3 style={{ marginTop: 6 }}>After the sale</h3>
                {(['F9', 'F10', 'F11'] as const).map((id) => {
                  const f = r.facts.find((x) => x.id === id);
                  if (f === undefined) return null;
                  const text =
                    id === 'F9'
                      ? f.value
                        ? 'Delivered'
                        : 'Not delivered yet'
                      : id === 'F10'
                        ? f.value
                          ? 'The listing matches what shipped'
                          : 'Listing match not confirmed (nothing has shipped, or the listing changed)'
                        : f.value
                          ? 'Refunded'
                          : 'Not refunded';
                  return (
                    <details key={id}>
                      <summary>
                        {text} <span className="muted small">{id}</span>
                      </summary>
                      <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                        {f.evidence.map((e) => (
                          <li key={e} className="mono">{e}</li>
                        ))}
                      </ul>
                    </details>
                  );
                })}
              </div>
            )}
          </Card>

          <Card title="5. What the merchant's verifier found at checkout">
            <Findings findings={r.checkoutFindings} />
          </Card>

          <Card title="6. The registry's transparency log">
            {r.transparency.included ? (
              <dl className="facts">
                <dt>Logged</dt>
                <dd>
                  entry {r.transparency.seq} at {dateTime(r.transparency.loggedAt)}
                </dd>
                <dt>Entry hash</dt>
                <dd>
                  <Hash value={r.transparency.entryHash} />
                </dd>
                <dt>Inclusion proof</dt>
                <dd>{r.transparency.proofValid === true ? <Badge tone="good">valid, checkpoint {r.transparency.checkpointSeq}</Badge> : <Badge tone="bad">{r.transparency.proofReason ?? 'not checked'}</Badge>}</dd>
              </dl>
            ) : (
              <Empty>This warrant has not been logged yet. It is logged when the payment is captured.</Empty>
            )}
            <p className="muted small">
              The log is append-only and hash-chained, and its head is signed from time to time, so a warrant cannot be backdated or quietly dropped. Fetch the proof yourself at <a href={`/api/registry/log/proof/${r.cartJti}`}>/api/registry/log/proof/{r.cartJti}</a>.
            </p>
          </Card>

          {r.order !== null && (
            <Card title="7. The order">
              <dl className="facts">
                <dt>Status</dt>
                <dd>
                  <StatusBadge status={r.order.status} />
                </dd>
                <dt>Total paid</dt>
                <dd>{money(r.order.totalCents, r.order.currency)}</dd>
                <dt>PayPal order</dt>
                <dd className="mono small">{r.order.paypalOrderId ?? 'none'}</dd>
                <dt>PayPal payment</dt>
                <dd className="mono small">{r.order.captureId ?? 'none'}</dd>
                <dt>Placed</dt>
                <dd>{dateTime(r.order.createdAt)}</dd>
              </dl>
              {r.dispute !== null && (
                <div className="note info" style={{ marginTop: 10 }}>
                  A dispute was opened: {r.dispute.id} ({r.dispute.state.replace(/_/g, ' ')}).{' '}
                  {r.dispute.outcome !== null && <Badge tone={outcomeTone(r.dispute.outcome)}>{OUTCOME_LABELS[r.dispute.outcome] ?? r.dispute.outcome}</Badge>}
                </div>
              )}
            </Card>
          )}

          <details>
            <summary>Raw report</summary>
            <Json value={r} />
          </details>
        </>
      )}

      <p className="muted small">
        Checked {dateTime(r.generatedAt)}. <Link to="/">Back to the shop</Link>
      </p>
    </div>
  );
}
