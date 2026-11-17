import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { Notice } from '@/features/portal/Notice';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { Card } from '@lims/ui/components/Card';
import { ErrorNotice, RateNotice, fmtDate } from '@/features/portal/notices';
import { callApi, retryMinutes, type ApiResult, type QrResult } from '@/server/api';

export const metadata = { title: 'Verify a lab report' };

// QR verify (AC-10.1..10.3): public Q1 call with the QR token in the body. Unknown, revoked, unreleased and
// malformed tokens all render the same "not found" page (no oracle).
export default async function Verify() {
  const token = (await headers()).get('x-qr-token') ?? ''; // set by middleware (token-independent payload)
  // Every token, malformed included, goes to Q1: the API answers malformed with the same 404 (AC-10.3), so the
  // portal has one code path and one timing profile for all four not-found cases.
  const r: ApiResult<QrResult> = await callApi<QrResult>('POST', '/verifications', { json: { qr_token: token } });
  const q = r.body;
  let content;
  if (r.status === 429) content = <RateNotice minutes={retryMinutes(r)} />;
  else if (r.status === 404) notFound(); // AC-10.3: HTTP 404, rendered by ./not-found.tsx
  else if (r.status === 200 && q) {
    const superseded = q.status === 'superseded';
    content = (
      <>
        {superseded ? <Notice tone="warning" title="This report was replaced by a newer version." /> : <Notice tone="success" title="This report is genuine." />}
        <Card>
          <DescriptionList
            items={[
              { term: 'Laboratory', value: q.lab_name },
              { term: 'Patient', value: q.patient_display },
              { term: 'Tests', value: q.panel_names.join(', ') },
              { term: 'Issued', value: fmtDate(q.issued_at) },
              { term: 'Version', value: String(q.version_no) },
            ]}
          />
          {superseded ? <p>Ask the laboratory for the current report.</p> : null}
        </Card>
      </>
    );
  } else content = <ErrorNotice reference={(r.body as { request_id?: string } | undefined)?.request_id} />;
  return (
    <>
      <h1>Verify a lab report</h1>
      {content}
    </>
  );
}
