// W5 Settings (C17 04-UI-UX §2.5). Permission is checked before any API call; H18 is rebuilt key by key in read.server.ts. A 403 renders PermissionDenied.
// T0D-UISETTINGS-1 (LD-353 rule 6): 501 → NotAvailable, 5xx → ErrorState in the page (title, reference, Retry).
import { notFound } from 'next/navigation';
import { ApiError } from '@/core/api/server-fetch';
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { t } from '@/core/i18n/messages';
import { getShellSession } from '@/core/session/server';
import { loadOr } from '@/core/shell/NotAvailable';
import { SettingsForm } from '@/features/homecollection/components/SettingsForm';
import { getSettings } from '@/features/homecollection/server/read.server';

export default async function SettingsPage() {
  const session = await getShellSession();
  if (!(session?.actor.permissions ?? []).includes('homecollection.settings.manage')) notFound();
  return loadOr(t('homecollection.nav.settings'), undefined, async () => {
    try {
      const settings = await getSettings();
      return <SettingsForm key={settings.version} settings={settings} />; // a new version (after Save + refresh) remounts the form with the stored values
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) return <PermissionDenied />;
      throw e;
    }
  });
}
