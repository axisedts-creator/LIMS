// C13.T19 PM-1 Manifests — /manifests (04-UI-UX PM-1). M2 listManifests: only the whitelisted query params reach the API (state csv, created_at_from/to, sort, cursor).
import { can, getList, getMe, initialOf, query, type Search } from '@/features/common/api';
import type { ManifestSummary } from '@/features/common/types';
import { ManifestList } from '@/features/manifests/ManifestList';

const RULES = {
  state: { csv: ['draft', 'submitted', 'partially_received', 'received', 'withdrawn', 'discarded'] },
  created_at_from: 'date', created_at_to: 'date',
  sort: { one: ['-created_at', '-submitted_at'] }, cursor: 'cursor',
} as const;

export default async function ManifestsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const search = await searchParams;
  const [list, me] = await Promise.all([getList<ManifestSummary>(`/v1/partners/manifests${query(search, RULES)}`), getMe()]);
  return <ManifestList rows={list.data} nextCursor={list.page?.next_cursor} canCreate={can(me, 'partners.manifest.submit')} initial={initialOf(search, ['state', 'created_at_from', 'created_at_to'])} />;
}
