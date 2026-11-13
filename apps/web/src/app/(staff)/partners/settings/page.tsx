// SS-1 Partner settings (02-TRD §10.2). Reading needs partners.partner.read; saving needs partners.partner.manage (the form shows no Save without it).
import { getShellSession } from '@/core/session/server';
import { getSettings } from '@/features/partners/server/read.server';
import { PartnerSettings } from '@/features/partners/components/PartnerSettings';
import { PermissionNotice } from '@/features/partners/components/common';

export const metadata = { title: 'Partner settings' };

export default async function SettingsPage() {
  const session = await getShellSession();
  const perms = session?.actor.permissions ?? [];
  if (!perms.includes('partners.partner.read')) return <PermissionNotice />;
  const { settings, etag } = await getSettings();
  return <PartnerSettings initial={settings} etag={etag} canManage={perms.includes('partners.partner.manage')} />;
}
