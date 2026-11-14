// QC set-up › Materials (C9 04-UI-UX §2.6). Permission quality.qc_run.read is checked in materialsPage before any API call.
import { materialsPage } from '@/features/quality/forms/setup.pages';

export default async function SetupMaterialsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return materialsPage(await searchParams);
}
