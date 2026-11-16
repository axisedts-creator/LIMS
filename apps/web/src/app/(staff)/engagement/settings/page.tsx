// C16 04-UI-UX §1.3 / W12 (route /engagement/settings, engagement.settings.manage). LD-255 (FOUNDER): the administrator controls booking, reminder and membership settings here.
// Permission first (the API is never called without it). The API's 403 auth.mfa_required is a page state (step-up banner); any other 403 is the permission-denied page.
import { ApiError } from '@/core/api/server-fetch';
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { getShellSession } from '@/core/session/server';
import { SettingsView } from '@/features/engagement/settings/SettingsView';
import { getEngagementSettings, listCentreOptions } from '@/features/engagement/settings/server';

export const metadata = { title: 'Engagement settings' };

export default async function EngagementSettingsPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const [session] = await Promise.all([getShellSession(), searchParams]);
  if (!(session?.actor.permissions ?? []).includes('engagement.settings.manage')) return <PermissionDenied />;
  try {
    const settings = await getEngagementSettings();
    const centres = await listCentreOptions();
    return <SettingsView key={settings.version} settings={settings} centres={centres} />; // key: "Reload" (router.refresh) remounts the form with the fresh values
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) return e.problem.code === 'auth.mfa_required' ? <SettingsView mfaRequired /> : <PermissionDenied />;
    throw e; // 5xx and the rest render error.tsx
  }
}
