// S5 My exports (C8 04-UI-UX §7; US-17). Permission analytics.data.export is checked in exportsPage before any API call.
import { exportsPage } from '@/features/analytics/server/exports-page';

export default async function ExportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return exportsPage(await searchParams);
}
