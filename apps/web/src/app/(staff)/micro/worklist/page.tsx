// 04-UI-UX §2 Micro worklist — async server component via the BFF. LD-140 (2026-11-13): the screen is built from @lims/ui only.
// 403 on the culture list → full-page "no access" (no fan-out to C5 / C2 / counts); any other failure → ErrorState / NotAvailable in the page (T0D-UILIST-1, LD-353), no partial table.
import { ApiError } from '@/core/api/server-fetch';
import { NotAvailable, isPending } from '@/core/shell/NotAvailable';
import { getShellSession } from '@/core/session/server';
import { MicroLoadError } from '@/features/micro/components/common';
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

const TITLE = 'Microbiology';
const COLUMNS = ['Barcode', 'Reg no', 'Test', 'Specimen', 'Received', 'Next read', 'Status', 'Reports', 'Instrument data'] as const;

/** T0D-UILIST-1, LD-353 rule 6: 501 operation_pending → NotAvailable with the header row; any other failure (not 403) → ErrorState in the page. */
export default async function MicroWorklistPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  try {
    return await worklist(await searchParams);
  } catch (e) {
    if (isPending(e)) return <NotAvailable title={TITLE} columns={COLUMNS} />;
    if (!(e instanceof ApiError)) throw e; // Next redirect / notFound and programming errors keep their own path
    const requestId = e.problem.request_id;
    return <MicroLoadError title={TITLE} {...(requestId ? { requestId } : {})} />;
  }
}

async function worklist(sp: SearchParams) {
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
