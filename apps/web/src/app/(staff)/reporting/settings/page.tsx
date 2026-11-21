// 04-UI-UX §2.8 Reporting settings (staff.reporting.settings, reporting.settings.manage).
// T0D-PRINTCFG-1 (LD-316): Print and stationery and Signatories sit below the settings form; they read their own data so a failure stays inline.
import { PrintStationery } from '@/features/reporting/components/PrintStationery';
import { ReportingSettingsForm } from '@/features/reporting/components/ReportingSettingsForm';
import { SignatoryProfiles } from '@/features/reporting/components/SignatoryProfiles';
import { gate } from '@/features/reporting/server/gate.server';
import { getReportingSettings, listCentreContacts, listCentres } from '@/features/reporting/server/read.server';

export default async function ReportingSettingsPage() {
  return gate('reporting.settings.manage', async (permissions) => {
    const [settings, contacts, centres] = await Promise.all([getReportingSettings(), listCentreContacts(), listCentres()]);
    return (
      <>
        <ReportingSettingsForm settings={settings} contacts={contacts.data} centres={centres} permissions={permissions} />
        <PrintStationery permissions={permissions} initialKind="report" />
        <SignatoryProfiles permissions={permissions} />
      </>
    );
  });
}
