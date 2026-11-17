import { redirect } from 'next/navigation';
import { Card } from '@lims/ui/components/Card';
import { ErrorNotice, RateNotice } from '@/features/portal/notices';
import { callApi, GATEWAY_LABEL, retryMinutes, token22, type PortalDues } from '@/server/api';
import { getSession } from '@/server/session';

export const metadata = { title: 'Payment due' };

const nonce = () => crypto.randomUUID(); // hidden form nonce = the PP1 Idempotency-Key (one per rendered form: a double submit replays)

/** Dues page (08 A21.1, 04-UI-UX §4): the amount, the pay options and "report will be sent" — never report content, never a download. Reads P7 only. */
export default async function Dues({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ pay?: string }> }) {
  const { token } = await params;
  const { pay } = await searchParams;
  const session = await getSession();
  if (!token22(token) || !session) redirect(`/r/${encodeURIComponent(token)}`); // AC-11.12: no session, no content
  const r = await callApi<PortalDues>('GET', '/portal/dues', { stage: 'session', credential: session });
  if (r.status === 401 || r.status === 404) redirect(`/r/${token}`); // expired / ended session -> new OTP (AC-11.8)
  if (r.status === 429) return <RateNotice minutes={retryMinutes(r)} />;
  if (r.status !== 200 || !r.body) return <ErrorNotice reference={(r.body as { request_id?: string } | undefined)?.request_id} />;
  const { lab_name, dues } = r.body;
  return (
    <>
      <h1>Payment due</h1>
      <Card title={lab_name}>
        {dues ? (
          <>
            <p>Amount due: NPR {(dues.balance_due_paisa / 100).toFixed(2)}</p>
            <p>Your report will be sent once payment is complete.</p>
            {pay === 'in_progress' ? <p role="alert">A payment for this order is already in progress.</p> : null}
            {pay === 'error' ? <p role="alert">We could not start the payment. Please try again.</p> : null}
            {dues.open_request ? (
              <>
                <p>A payment is in progress.</p>
                <a href={`/r/${token}/payments/${dues.open_request.id}`}>See payment status</a>
              </>
            ) : dues.online_gateways.length === 0 ? (
              <p>Please pay at the lab counter or in the app.</p>
            ) : (
              <>
                <p>The exact amount is confirmed when you pay.</p>
                {dues.online_gateways.map((g) => (
                  <form key={g} method="post" action={`/r/${token}/pay`}>
                    <input type="hidden" name="gateway" value={g} />
                    <input type="hidden" name="nonce" value={nonce()} />
                    <input type="hidden" name="from" value="dues" />
                    <button type="submit" className="portal-btn">
                      Pay with {GATEWAY_LABEL[g]}
                    </button>
                  </form>
                ))}
              </>
            )}
          </>
        ) : (
          <p>Payment received — your report will be sent once it is released.</p>
        )}
        <form method="post" action={`/r/${token}/signout`}>
          <button type="submit" className="portal-btn">
            Sign out
          </button>
        </form>
      </Card>
    </>
  );
}
