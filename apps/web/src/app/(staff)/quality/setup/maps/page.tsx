// QC set-up › Maps (C9 04-UI-UX §2.6). Permission quality.qc_run.read is checked in mapsPage before any API call.
import { mapsPage } from '@/features/quality/forms/setup.pages';

export default async function SetupMapsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return mapsPage(await searchParams);
}
