// S6 Scheduled reports list (C8 04-UI-UX §8; US-18). Permission analytics.schedule.manage is checked in schedulesListPage before any API call.
import { schedulesListPage } from '@/features/analytics/server/schedules-page';

export default async function SchedulesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return schedulesListPage(await searchParams);
}
