import { redirect } from 'next/navigation';
import { Card } from '@lims/ui/components/Card';
import { ErrorNotice, RateNotice } from '@/features/portal/notices';
import { Finished, isOpen, Refresh, refreshN } from '@/features/portal/PaymentStatus';
import { callApi, GATEWAY_LABEL, PAYMENT_ID, retryMinutes, token22, type PortalPayment } from '@/server/api';
import { getSession } from '@/server/session';

export const metadata = { title: 'Your payment', referrer: 'no-referrer' }; // the gateway link must not leak the portal URL (03-APP-FLOW §2.7)

export default async function PaymentStatusPage({ params, searchParams }: { params: Promise<{ token: string; id: string }>; searchParams: Promise<{ n?: string }> }) {
  const { token, id } = await params;
  const n = refreshN((await searchParams).n);
  const session = await getSession();
  if (!token22(token) || !session) redirect(`/r/${encodeURIComponent(token)}`);
  if (!PAYMENT_ID.test(id)) redirect(`/r/${token}/report`);
  const r = await callApi<PortalPayment>('GET', `/portal/payment-requests/${encodeURIComponent(id)}`, { stage: 'session', credential: session });
  if (r.status === 401 || r.status === 404) redirect(`/r/${token}/report`);
  if (r.status === 429) return <RateNotice minutes={retryMinutes(r)} />;
  if (r.status !== 200 || !r.body) return <ErrorNotice reference={(r.body as { request_id?: string } | undefined)?.request_id} />;
  const p = r.body;
  const back = <a href={`/r/${token}/report`}>Back to your report</a>;
  return (
    <>
      <h1>Your payment</h1>
      {isOpen(p) ? (
        <>
          {/* [CONV] no auto-refresh once the Continue link is shown: the patient acts, and a timed refresh on a page with a decision fails WCAG 2.2.1 (axe meta-refresh) */}
          {p.action_url ? null : <Refresh href={`/r/${token}/payments/${id}`} n={n} />}
          {p.status === 'ready' && p.review ? (
            <Card><p role="status">We are confirming your payment. This can take a few minutes.</p></Card>
          ) : p.status === 'ready' && p.action_url ? (
            <Card>
              <p>Your payment is ready.</p>
              {/* the only place the gateway URL is rendered: a plain anchor, no referrer, no script */}
              <a className="portal-btn portal-btn-primary" href={p.action_url} rel="noreferrer noopener">
                Continue to {GATEWAY_LABEL[p.gateway]}
              </a>
            </Card>
          ) : (
            <Card><p role="status">Preparing your payment…</p></Card>
          )}
        </>
      ) : (
        <Finished p={p} back={back} />
      )}
    </>
  );
}
