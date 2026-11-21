// Unassigned QC (C9 04-UI-UX §2.5). Permission quality.qc_run.read is checked in observationsPage before any API call.
import { observationsPage } from '@/features/quality/server/pages';

export default async function QcObservationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return observationsPage(await searchParams);
}
