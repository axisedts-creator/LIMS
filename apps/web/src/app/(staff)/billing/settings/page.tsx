// 04-UI-UX §8.11 billing half (billing.settings.manage).
import { BillingSettingsForm } from '@/features/billing/components/BillingSettingsForm';
import { getBillingSettings } from '@/features/billing/server/read.server';

export default async function BillingSettingsPage() {
  return <BillingSettingsForm settings={await getBillingSettings()} />;
}
