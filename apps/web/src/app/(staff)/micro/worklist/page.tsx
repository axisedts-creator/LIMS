// 04-UI-UX §2 Micro worklist — async server component via the BFF. LD-140 (2026-11-13): the screen is built from @lims/ui only.
// 403 on the culture list → full-page "no access" (no fan-out to C5 / C2 / counts); any other failure rejects to error.tsx (no partial table).
import { getShellSession } from '@/core/session/server';
import { MicroForbidden } from '@/features/micro/components/MicroForbidden';
import { WorklistScreen } from '@/features/micro/components/worklist/WorklistScreen';
import { getSpecimens } from '@/features/micro/server/getSpecimen.server';
import { listCentres } from '@/features/micro/server/listCentres.server';
import { COUNTED_TABS, DEFAULT_RECENT_DAYS, countCultures, listCultures, parseTab, worklistFilters, worklistQuery } from '@/features/micro/server/listCultures.server';
import { orForbidden } from '@/features/micro/server/shared';
import { getMicroSettings } from '@/features/micro/server/settings.server';
import type { TabId } from '@/features/micro/server/types';

type SearchParams = Record<string, string | string[] | undefined>;

/** recent_window_days from the settings; any failure → the default (the window is a convenience, not a gate). */
async function recentWindowDays(): Promise<number> {
  try {
    const d = (await getMicroSettings()).recent_window_days;
    return Number.isInteger(d) && d >= 1 ? d : DEFAULT_RECENT_DAYS;
  } catch {
    return DEFAULT_RECENT_DAYS;
  }
}

export default async function MicroWorklistPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const tab = parseTab(sp['tab']);
  const days = tab === 'recent' ? await recentWindowDays() : DEFAULT_RECENT_DAYS;
  const session = await getShellSession();

  const list = await orForbidden(() => listCultures(worklistQuery(tab, sp, days)));
  if (!list) return <MicroForbidden />;

  const filters = worklistFilters(sp);
  const others = COUNTED_TABS.filter((t) => t !== tab);
  const [centres, specimens, probed] = await Promise.all([
    listCentres(),
    getSpecimens(list.data.map((c) => c.specimen_id)),
    Promise.all(others.map(async (t) => [t, await countCultures(t, filters)] as const)),
  ]);
  const counts: Partial<Record<TabId, number>> = Object.fromEntries(probed.filter(([, n]) => n !== undefined));
  if (tab !== 'recent' && list.page.total !== undefined) counts[tab] = list.page.total;

  return (
    <WorklistScreen
      tab={tab}
      cultures={list.data}
      counts={counts}
      centres={centres}
      specimens={specimens}
      {...(list.page.next_cursor ? { nextCursor: list.page.next_cursor } : {})}
      recentWindowDays={days}
      permissions={session?.actor.permissions ?? []}
    />
  );
}
