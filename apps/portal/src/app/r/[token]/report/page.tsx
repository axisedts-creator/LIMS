import { redirect } from 'next/navigation';
import { Notice } from '@/features/portal/Notice';
import { Card } from '@lims/ui/components/Card';
import { HealthSummary } from '@/features/portal/HealthSummary';
import { ErrorNotice, RateNotice, fmtDate } from '@/features/portal/notices';
import { callApi, retryMinutes, token22, type PortalReport } from '@/server/api';
import { getSession } from '@/server/session';

export const metadata = { title: 'Your lab report' };

export default async function Report({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
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
      {smart_summary ? <HealthSummary summary={smart_summary} /> : null}
    </>
  );
}
