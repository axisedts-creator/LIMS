// C13.T19 PP-1 Price list — /price-list (04-UI-UX PP-1). P1 listPartnerPriceList with q (<= 64, non-PHI), kind, source, sort, cursor only.
import { get, initialOf, query, type Paged, type Search } from '@/features/common/api';
import type { PriceListItem } from '@/features/common/types';
import { PriceList } from '@/features/price-list/PriceList';

const RULES = { q: { text: 64 }, kind: { one: ['test', 'panel'] }, source: { one: ['partner', 'standard'] }, sort: { one: ['code', 'name'] }, cursor: 'cursor' } as const;
type PriceBody = Paged<PriceListItem> & { price_list_version?: number; synced_at?: string };

export default async function PriceListPage({ searchParams }: { searchParams: Promise<Search> }) {
  const search = await searchParams;
  const body = await get<PriceBody>(`/v1/partners/price-list${query(search, RULES)}`);
  if (!Array.isArray(body.data)) throw new Error('partner_api_failed');
  return <PriceList rows={body.data} nextCursor={body.page?.next_cursor} version={body.price_list_version} syncedAt={body.synced_at} initial={initialOf(search, ['q', 'kind', 'source'])} />;
}
