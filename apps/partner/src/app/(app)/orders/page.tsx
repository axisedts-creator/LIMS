// C13.T19 PO-1 Samples — /orders (04-UI-UX PO-1). O1 listPartnerOrders with the whitelisted query names of 02-TRD §5.2; filter option lists from M2 / F1 (best effort).
// REQ-SEC-098: a patient name or any free-text search term in the page URL is never forwarded and never triggers O2 while rendering (the search form POSTs through the BFF).
import { can, getList, getMe, getOptional, initialOf, query, type Paged, type Search } from '@/features/common/api';
import type { ManifestSummary, PartnerOrder, PartnerReferrer } from '@/features/common/types';
import { OrderList } from '@/features/orders/OrderList';

const RULES = {
  tracking_status: { csv: ['registered', 'in_transit', 'in_lab', 'action_needed', 'partially_reported', 'reported', 'cancelled'] },
  manifest_id: 'uuid', referrer_id: 'uuid', registered_at_from: 'date', registered_at_to: 'date', has_new_report: 'bool',
  sort: { one: ['-registered_at', '-last_event_at'] }, cursor: 'cursor',
} as const;

export default async function OrdersPage({ searchParams }: { searchParams: Promise<Search> }) {
  const search = await searchParams;
  const me = await getMe();
  const [list, mf, refs] = await Promise.all([
    getList<PartnerOrder>(`/v1/partners/orders${query(search, RULES)}`),
    getOptional<Paged<ManifestSummary>>('/v1/partners/manifests?limit=50'),
    can(me, 'partners.referrer.read') ? getOptional<Paged<PartnerReferrer>>('/v1/partners/referrers?is_active=true') : Promise.resolve(undefined),
  ]);
  return (
    <OrderList
      rows={list.data}
      nextCursor={list.page?.next_cursor}
      manifests={(mf?.data ?? []).filter((m) => m.state !== 'draft').map((m) => ({ value: m.id, label: m.manifest_no }))}
      doctors={(refs?.data ?? []).map((r) => ({ value: r.id, label: r.display_name }))}
      initial={initialOf(search, ['tracking_status', 'manifest_id', 'referrer_id', 'registered_at_from', 'registered_at_to', 'has_new_report'])}
    />
  );
}
