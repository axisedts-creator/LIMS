// C13.T19 PR-1 Reports — /reports (04-UI-UX PR-1). R1 listPartnerReports with the whitelisted names (released_at_from/to, is_new, include_superseded, sort, cursor); superseded versions are hidden unless asked for.
import { getList, getMe, initialOf, query, type Search } from '@/features/common/api';
import type { PartnerReport } from '@/features/common/types';
import { ReportList } from '@/features/reports/ReportList';

const RULES = { released_at_from: 'date', released_at_to: 'date', is_new: 'bool', include_superseded: 'bool', sort: { one: ['-released_at'] }, cursor: 'cursor' } as const;

export default async function ReportsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const search = await searchParams;
  const [list, me] = await Promise.all([getList<PartnerReport>(`/v1/partners/reports${query(search, RULES, { include_superseded: 'false' })}`), getMe()]);
  return <ReportList rows={list.data} nextCursor={list.page?.next_cursor} slips={me.features.access_slip_enabled === true} initial={initialOf(search, ['released_at_from', 'released_at_to', 'is_new', 'include_superseded'])} />;
}
