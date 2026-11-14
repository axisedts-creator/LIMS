// C13.T19 PR-3 Report versions — /reports/{report_id} (04-UI-UX PR-3; routes.yaml partner.report). R1 has no report_id filter (spec gap, see impl note):
// read GET /reports?include_superseded=true (following cursors, bounded) and keep only this report's versions. No row -> "This report is no longer available." and no data.
import { notFound } from 'next/navigation';
import { getList, getMe, isUuid } from '@/features/common/api';
import type { PartnerReport } from '@/features/common/types';
import { ReportVersions } from '@/features/reports/ReportVersions';

const MAX_PAGES = 10; // ponytail: bounded scan of R1 pages; ask the API owner for a report_id filter if lists grow beyond this

export default async function ReportPage({ params }: { params: Promise<{ report_id: string }> }) {
  const { report_id: id } = await params;
  if (!isUuid(id)) notFound();
  const me = await getMe();
  const mine: PartnerReport[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i += 1) {
    const q = new URLSearchParams({ include_superseded: 'true', ...(cursor ? { cursor } : {}) });
    const page = await getList<PartnerReport>(`/v1/partners/reports?${q}`);
    mine.push(...page.data.filter((r) => r.report_id === id));
    cursor = page.page?.next_cursor;
    if (!cursor || !/^[A-Za-z0-9_\-=.]{1,512}$/.test(cursor)) break;
  }
  mine.sort((a, b) => b.version_no - a.version_no);
  return <ReportVersions versions={mine} slips={me.features.access_slip_enabled === true} />;
}
