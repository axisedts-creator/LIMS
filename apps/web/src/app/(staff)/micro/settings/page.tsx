// 04-UI-UX §5 Micro settings — server component via the BFF; 403 → no-access page. Tab data (dictionaries, protocols, panels, mappings) loads in the client through server actions.
import { getShellSession } from '@/core/session/server';
import { MicroForbidden } from '@/features/micro/components/MicroForbidden';
import { MicroSettingsScreen } from '@/features/micro/components/settings/MicroSettingsScreen';
import { orForbidden } from '@/features/micro/server/shared';
import { getMicroSettings } from '@/features/micro/server/settings.server';

export default async function MicroSettingsPage() {
  const session = await getShellSession();
  const settings = await orForbidden(() => getMicroSettings());
  if (!settings) return <MicroForbidden />;
  return <MicroSettingsScreen settings={settings} permissions={session?.actor.permissions ?? []} />;
}
