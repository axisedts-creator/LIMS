// QC set-up › Targets (C9 04-UI-UX §2.6). Permission quality.qc_run.read is checked in targetsPage before any API call; plan_id is whitelisted as a UUID.
import { targetsPage } from '@/features/quality/forms/setup.pages';

export default async function SetupTargetsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return targetsPage(await searchParams);
}
