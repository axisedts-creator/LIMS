// C13.T19 PK-1 Pickups — /pickups (04-UI-UX PK-1). K2 listPickupRequests (state csv, sort, cursor).
import { can, getList, getMe, query, type Search } from '@/features/common/api';
import type { PickupRequest } from '@/features/common/types';
import { PickupList } from '@/features/pickups/PickupList';

const RULES = { state: { csv: ['requested', 'scheduled', 'picked_up', 'cancelled', 'rejected'] }, sort: { one: ['-created_at', 'window_start'] }, cursor: 'cursor' } as const;

export default async function PickupsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const [list, me] = await Promise.all([getList<PickupRequest>(`/v1/partners/pickup-requests${query(await searchParams, RULES)}`), getMe()]);
  return <PickupList rows={list.data} nextCursor={list.page?.next_cursor} canRequest={can(me, 'partners.pickup.request')} />;
}
