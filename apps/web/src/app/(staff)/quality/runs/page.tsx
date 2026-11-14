// QC runs (C9 04-UI-UX §2.2). Permission quality.qc_run.read is checked in runsPage before any API call.
import { runsPage } from '@/features/quality/server/pages';

export default async function QcRunsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return runsPage(await searchParams);
}
