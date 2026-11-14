// Quality settings (C9 04-UI-UX §2.11). Permission quality.qc_run.read is checked in settingsPage before any API call.
import { settingsPage } from '@/features/quality/settings/settings.pages';

export default async function QualitySettingsPage() {
  return settingsPage();
}
