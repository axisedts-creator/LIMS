// 04-UI-UX §4.7 Configuration "Pathology setup": server component via the BFF. Needs anatomic.config.manage (AC-14.4; the API enforces it too); no permission or a 403 → no-access state
// with no tabs and no configuration data; any other failure rejects to error.tsx. `?tab=` and `?set=` are narrowed to known values before anything is fetched.
// LD-140 (2026-11-13): screens are built from the kit only (see ConfigScreen).
import { getShellSession } from '@/core/session/server';
import { ConfigForbidden } from '@/features/anatomic/components/config/config-shared';
import { ConfigScreen } from '@/features/anatomic/components/config/ConfigScreen';
import { loadTab, pickSet, pickTab } from '@/features/anatomic/server/config.load.server';
import { orForbidden } from '@/features/anatomic/server/shared';

export default async function ConfigPage({ searchParams }: { searchParams: Promise<{ tab?: string | string[]; set?: string | string[] }> }) {
  const sp = await searchParams;
  const session = await getShellSession();
  if (!(session?.actor.permissions ?? []).includes('anatomic.config.manage')) return <ConfigForbidden />;
  const data = await orForbidden(() => loadTab(pickTab(sp.tab), pickSet(sp.set)));
  if (data === null) return <ConfigForbidden />;
  return <ConfigScreen data={data} />;
}
