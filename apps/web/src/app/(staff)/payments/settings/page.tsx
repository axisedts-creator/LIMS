// Payment gateways / settings (C15 04-UI-UX §2.6; US-PG-10). Permission first. Only the deployment's environment is read and shown;
// every account is re-built from an allow-list on the server, so a secret value can never be passed to the client component (REQ-SEC-058).
import { notFound } from 'next/navigation';
import { ApiError } from '@/core/api/server-fetch';
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { getShellSession } from '@/core/session/server';
import { SettingsView } from '@/features/payments/components/SettingsView';
import { getPaymentSettings, listMerchantAccounts } from '@/features/payments/server/read.server';

export default async function PaymentSettingsPage() {
  const permissions = (await getShellSession())?.actor.permissions ?? [];
  if (!permissions.includes('payments.merchant_config.read')) notFound();
  const environment = process.env['LIMS_PAYMENTS_GATEWAY_ENV'];
  if (environment !== 'uat' && environment !== 'production') throw new Error('LIMS_PAYMENTS_GATEWAY_ENV must be "uat" or "production"');
  try {
    const [accounts, settings] = await Promise.all([listMerchantAccounts(), getPaymentSettings()]);
    return <SettingsView environment={environment} accounts={accounts.filter((a) => a.environment === environment)} settings={settings} permissions={permissions} />;
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) return <PermissionDenied />;
    throw e; // 5xx and the rest render error.tsx
  }
}
