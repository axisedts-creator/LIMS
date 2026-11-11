import { redirect } from 'next/navigation';
import { Notice } from '@/features/portal/Notice';
import { Card } from '@lims/ui/components/Card';
import { HealthSummary } from '@/features/portal/HealthSummary';
import { ErrorNotice, RateNotice, fmtDate } from '@/features/portal/notices';
import { callApi, GATEWAY_LABEL, retryMinutes, token22, type PortalReport } from '@/server/api';
import { getSession } from '@/server/session';

export const metadata = { title: 'Your lab report' };

const nonce = () => crypto.randomUUID(); // hidden form nonce = the PP1 Idempotency-Key (one per rendered form: a double submit replays)

/** Dues card (08 A11.1, 04-UI-UX §4). The amount shown is a hint; the exact amount is confirmed by the payment system when the payment starts. */
function Dues({ token, dues, pay }: { token: string; dues: NonNullable<PortalReport['dues']>; pay?: string | undefined }) {
  return (
    <Card title="Payment">
      <p>Amount due: NPR {(dues.balance_due_paisa / 100).toFixed(2)}</p>
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
              <button type="submit" className="portal-btn">
                Pay with {GATEWAY_LABEL[g]}
              </button>
            </form>
          ))}
        </>
      )}
    </Card>
  );
}

export default async function Report({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ pay?: string }> }) {
  const { token } = await params;
  const { pay } = await searchParams;
  const session = await getSession();
  if (!token22(token) || !session) redirect(`/r/${encodeURIComponent(token)}`); // AC-11.12: no session, no content
  const r = await callApi<PortalReport>('GET', '/portal/report', { stage: 'session', credential: session });
  if (r.status === 401 || r.status === 404) redirect(`/r/${token}`); // expired / ended session -> new OTP (AC-11.8)
  if (r.status === 429) return <RateNotice minutes={retryMinutes(r)} />;
  if (r.status !== 200 || !r.body) return <ErrorNotice reference={(r.body as { request_id?: string } | undefined)?.request_id} />;
  const { lab_name, patient_display, report, smart_summary } = r.body;
  return (
    <>
      <h1>Your lab report</h1>
      {report.updated_notice ? (
        <Notice tone="info" title={`This report was updated on ${fmtDate(report.updated_notice.updated_at)}. You are seeing the latest version.`} />
      ) : null}
      <Card title={lab_name}>
        <p>Report for {patient_display}</p>
        <p>
          Status: <strong>{report.status_label}</strong>
        </p>
        <p>Issued {fmtDate(report.issued_at)}</p>
        <ul>
          {report.panel_names.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
        <a className="portal-btn portal-btn-primary" href={`/r/${token}/download`}>
          Download PDF
        </a>
        <form method="post" action={`/r/${token}/signout`}>
          <button type="submit" className="portal-btn">
            Sign out
          </button>
        </form>
      </Card>
      {r.body.dues ? <Dues token={token} dues={r.body.dues} pay={pay} /> : null}
      {smart_summary ? <HealthSummary summary={smart_summary} /> : null}
    </>
  );
}
