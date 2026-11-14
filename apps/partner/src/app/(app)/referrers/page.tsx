// C13.T19 PF-1 Referring doctors — /referrers (04-UI-UX PF-1). F1 listPartnerReferrers (is_active, q <= 64, cursor). Admin actions are shown only with partners.referrer.manage (the API enforces it again).
import { can, getList, getMe, query, type Search } from '@/features/common/api';
import type { PartnerReferrer } from '@/features/common/types';
import { ReferrerList } from '@/features/referrers/ReferrerList';

const RULES = { is_active: 'bool', q: { text: 64 }, cursor: 'cursor' } as const;

export default async function ReferrersPage({ searchParams }: { searchParams: Promise<Search> }) {
  const [list, me] = await Promise.all([getList<PartnerReferrer>(`/v1/partners/referrers${query(await searchParams, RULES)}`), getMe()]);
  return <ReferrerList rows={list.data} nextCursor={list.page?.next_cursor} canManage={can(me, 'partners.referrer.manage')} />;
}
