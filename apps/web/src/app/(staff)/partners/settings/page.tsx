// SS-1 Partner settings (02-TRD §10.2). Reading needs partners.partner.read; saving needs partners.partner.manage (the form shows no Save without it).
import { ApiError } from '@/core/api/server-fetch';
import { getShellSession } from '@/core/session/server';
import { getSettings } from '@/features/partners/server/read.server';
import { PartnerSettings } from '@/features/partners/components/PartnerSettings';
import { PermissionNotice } from '@/features/partners/components/common';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { t } from '@/core/i18n/messages';
import { pendingOr } from '@/core/shell/NotAvailable';

export const metadata = { title: 'Partner settings' };

export default async function SettingsPage() {
  const session = await getShellSession();
  const perms = session?.actor.permissions ?? [];
  if (!perms.includes('partners.partner.read')) return <PermissionNotice />;
  // LD-301: getPartnerSettings is still an API stub (500 common.internal); say so plainly instead of the error page. Other failures still throw (error page + retry).
  // T0D-UISETTINGS-1 (LD-353 rule 6): 501 operation_pending -> NotAvailable with the title, never error.tsx.
  return pendingOr(t('partners.nav.settings'), undefined, async () => {
  const r = await getSettings().catch((e: unknown) => {
    if (e instanceof ApiError && e.status === 500 && e.problem.code === 'common.internal') return null;
    throw e;
  });
  // T0D-ELABMENU-3 (LD-340): heading = ElabAssist menu label, drawn by the shared PageHeader
  if (!r) return <main className="lims-page"><PageHeader title={t('partners.nav.settings')} helpKey="partners.settings" /><p>Partner settings are not available yet.</p></main>;
  const { settings, etag } = r;
  return <PartnerSettings initial={settings} etag={etag} canManage={perms.includes('partners.partner.manage')} />;
  });
}
