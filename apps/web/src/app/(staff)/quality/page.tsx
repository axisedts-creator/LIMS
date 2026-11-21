// QC status board (C9 04-UI-UX §2.1). Permission quality.qc_run.read is checked in statusBoardPage before any API call.
import { statusBoardPage } from '@/features/quality/server/pages';

export default async function QcStatusPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return statusBoardPage(await searchParams);
}
