// TAT alerts (C9 04-UI-UX §2.10). Permission quality.tat_alert.read is checked in tatAlertsPage before any API call.
import { tatAlertsPage } from '@/features/quality/tat/tat.pages';

export default async function TatAlertsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return tatAlertsPage(await searchParams);
}
