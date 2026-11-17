// QC set-up › Plans (C9 04-UI-UX §2.6). Permission quality.qc_run.read is checked in plansPage before any API call.
import { plansPage } from '@/features/quality/forms/setup.pages';

export default async function SetupPlansPage() {
  return plansPage();
}
