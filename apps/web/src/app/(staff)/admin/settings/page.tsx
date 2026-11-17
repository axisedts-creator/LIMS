// AD-8 Lab settings (C2 04-UI-UX §6). Gate identity.settings.manage before any API call.
import { call } from '@/features/admin/server/api';
import { Denied, LoadError, gate } from '@/features/admin/server/page-kit';
import { SettingsScreen, type Annex, type Flag } from '@/features/admin/components/SettingsScreen';

export default async function SettingsPage() {
  if (!(await gate('identity.settings.manage'))) return <Denied />;
  const [settings, flags, annexes] = await Promise.all([
    call<Record<string, unknown> & { version: number }>('GET', '/v1/identity/settings'),
    call<{ data: Flag[] }>('GET', '/v1/identity/feature-flags'),
    call<{ data: Annex[] }>('GET', '/v1/identity/ird-annexes'),
  ]);
  if (!settings.ok) return <LoadError fail={settings} what="lab settings" />;
  return <SettingsScreen settings={settings.data} flags={flags.ok ? flags.data.data : null} annexes={annexes.ok ? annexes.data.data : null} />;
}
