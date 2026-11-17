// 04-UI-UX §2.8 Reporting settings (staff.reporting.settings, reporting.settings.manage).
import { ReportingSettingsForm } from '@/features/reporting/components/ReportingSettingsForm';
import { gate } from '@/features/reporting/server/gate.server';
import { getReportingSettings, listCentreContacts, listCentres } from '@/features/reporting/server/read.server';

export default async function ReportingSettingsPage() {
  return gate('reporting.settings.manage', async (permissions) => {
    const [settings, contacts, centres] = await Promise.all([getReportingSettings(), listCentreContacts(), listCentres()]);
    return <ReportingSettingsForm settings={settings} contacts={contacts.data} centres={centres} permissions={permissions} />;
  });
}
