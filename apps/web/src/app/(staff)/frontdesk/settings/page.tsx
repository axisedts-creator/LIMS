// 04-UI-UX §8.11 (route /frontdesk/settings, frontdesk.settings.manage). LD-255 (FOUNDER): the administrator controls the discount limits here.
// Permission first (the API is never called without it). The API's 403 auth.mfa_required is a page state (step-up banner); any other 403 is the permission-denied page.
import { ApiError } from '@/core/api/server-fetch';
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { getShellSession } from '@/core/session/server';
import { SettingsView } from '@/features/frontdesk/settings/SettingsView';
import { getFrontdeskSettings } from '@/features/frontdesk/settings/server';

export const metadata = { title: 'Front desk settings' };

export default async function FrontdeskSettingsPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const [session] = await Promise.all([getShellSession(), searchParams]);
  if (!(session?.actor.permissions ?? []).includes('frontdesk.settings.manage')) return <PermissionDenied />;
  try {
    const settings = await getFrontdeskSettings();
    return <SettingsView key={settings.version} settings={settings} />; // key: "Reload" (router.refresh) remounts the form with the fresh values
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) return e.problem.code === 'auth.mfa_required' ? <SettingsView mfaRequired /> : <PermissionDenied />;
    throw e; // 5xx and the rest render error.tsx
  }
}
