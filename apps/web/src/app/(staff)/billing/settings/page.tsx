// 04-UI-UX §8.11 billing half (billing.settings.manage).
// T0D-PRINTCFG-1 (LD-316): the Print and stationery section opens on Bills; tabs without their permission are read only.
import { getShellSession } from '@/core/session/server';
import { BillingSettingsForm } from '@/features/billing/components/BillingSettingsForm';
import { getBillingSettings } from '@/features/billing/server/read.server';
import { PrintStationery } from '@/features/reporting/components/PrintStationery';

export default async function BillingSettingsPage() {
  const [settings, session] = await Promise.all([getBillingSettings(), getShellSession()]);
  return (
    <>
      <BillingSettingsForm settings={settings} />
      <PrintStationery permissions={session?.actor.permissions ?? []} initialKind="invoice" />
    </>
  );
}
