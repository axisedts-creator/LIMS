// 04-UI-UX §4 Micro instrument data — async server component via the BFF (AC-08.4–AC-08.6). LD-140 (2026-11-13): the screen is built from @lims/ui only.
// 403 on the list → full-page "no access" (no fan-out to C7); any other failure rejects to error.tsx (no partial table). The port flag is read here, on the server (TRD §11):
// "true" = LabPort.lookupSpecimens is on and the manual-matching banner is hidden; unset or anything else = off.
import { getShellSession } from '@/core/session/server';
import { InstrumentRecordsScreen } from '@/features/micro/components/instrument-records/InstrumentRecordsScreen';
import { MicroForbidden } from '@/features/micro/components/MicroForbidden';
import { listInstrumentRecordsPage } from '@/features/micro/server/instrumentRecordActions';
import { orForbidden } from '@/features/micro/server/shared';

type SearchParams = Record<string, string | string[] | undefined>;

export default async function MicroInstrumentRecordsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const session = await getShellSession();
  const page = await orForbidden(() => listInstrumentRecordsPage(sp));
  if (!page) return <MicroForbidden />;
  return (
    <InstrumentRecordsScreen
      rows={page.rows}
      instruments={page.instruments}
      {...(page.nextCursor ? { nextCursor: page.nextCursor } : {})}
      lookupPortOn={process.env['LIMS_MICRO_SPECIMEN_LOOKUP_PORT'] === 'true'}
      permissions={session?.actor.permissions ?? []}
    />
  );
}
