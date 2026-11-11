import { Card } from '@lims/ui/components/Card';
import { ErrorNotice, RateNotice } from '@/features/portal/notices';
import { Finished, isOpen, Refresh, refreshN } from '@/features/portal/PaymentStatus';
import { callApi, PAYMENT_ID, retryMinutes, token22, type PortalPayment } from '@/server/api';
import { getLinkToken, getSession } from '@/server/session';

export const metadata = { title: 'Your payment' };

// Gateway return / cancel page (route portal.payment_done). The URL carries values the gateway chose; none is read, rendered or forwarded (REQ-SEC-059): the only
// truth is the request row, asked of PP2 with the portal session cookie (SameSite=Lax travels on the gateway's top-level redirect).
export default async function PaymentDone({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ n?: string }> }) {
  const { id } = await params;
  const n = refreshN((await searchParams).n);
  const session = await getSession();
  if (!session || !PAYMENT_ID.test(id)) {
    return <Card><p role="status">Open your report link again to see your payment status.</p></Card>; // data-free: no API call
  }
  const r = await callApi<PortalPayment>('GET', `/portal/payment-requests/${encodeURIComponent(id)}`, { stage: 'session', credential: session });
  if (r.status === 401 || r.status === 404) return <Card><p role="status">Open your report link again to see your payment status.</p></Card>;
  if (r.status === 429) return <RateNotice minutes={retryMinutes(r)} />;
  if (r.status !== 200 || !r.body) return <ErrorNotice reference={(r.body as { request_id?: string } | undefined)?.request_id} />;
  const p = r.body;
  const link = await getLinkToken();
  const back = <a href={link && token22(link) ? `/r/${link}/report` : '/'}>Back to your report</a>;
  return (
    <>
      <h1>Your payment</h1>
      {isOpen(p) ? (
        <>
          <Refresh href={`/r/payments/${id}/done`} n={n} />
          <Card><p role="status">Checking your payment…</p>{back}</Card>
        </>
      ) : (
        <Finished p={p} back={back} />
      )}
    </>
  );
}
