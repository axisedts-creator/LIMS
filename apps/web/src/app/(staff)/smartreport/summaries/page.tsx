// SR-01 Review queue (C14 04-UI-UX SR-01). Permission smartreport.summary.read is checked in summariesPage before any API call.
import { summariesPage } from '@/features/smartreport/server/summaries-page';

export default async function SummariesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return summariesPage(await searchParams);
}
