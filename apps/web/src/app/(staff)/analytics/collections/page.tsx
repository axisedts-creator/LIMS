// S2b Collections history, route staff.analytics.collections (D-46, C8 04-UI-UX §4.3). Permission: analytics.collections.read only.
import { collectionsPage } from '@/features/analytics/server/report-page';

export default async function CollectionsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return collectionsPage(await searchParams);
}
