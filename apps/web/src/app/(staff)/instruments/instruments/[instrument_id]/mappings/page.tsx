// SCR-08 Mappings — server component. Reads E25 + E32 (instruments.instrument.read); C3 maps + test names only with
// catalog.instrument_code_map.manage (D-39: otherwise NO /v1/catalog/* call). Malformed id / 404 → notFound(); other errors → error.tsx.
import { notFound } from 'next/navigation';
import { ApiError } from '@/core/api/server-fetch';
import { getShellSession } from '@/core/session/server';
import { problem } from '@/core/session/types';
import { InstrumentMappings } from '@/features/instruments/components/InstrumentMappings';
import { getTestRef } from '@/features/instruments/server/catalogLookups.server';
import { CODE_MAP_MANAGE, type TestRef } from '@/features/instruments/server/codeMaps';
import { getInstrument } from '@/features/instruments/server/getInstrument.server';
import { listInstrumentCodeMaps } from '@/features/instruments/server/listInstrumentCodeMaps.server';
import { listInstruments } from '@/features/instruments/server/listInstruments.server';
import { listObservedInstrumentCodes } from '@/features/instruments/server/listObservedInstrumentCodes.server';
import { UUID_RE } from '@/features/instruments/server/types';

const READ = 'instruments.instrument.read';

export default async function InstrumentMappingsPage({ params }: { params: Promise<{ instrument_id: string }> }) {
  const { instrument_id } = await params;
  if (!UUID_RE.test(instrument_id)) notFound(); // never forwarded to the API
  const permissions = (await getShellSession())?.actor.permissions ?? [];
  if (!permissions.includes(READ)) throw new ApiError(403, problem('auth.forbidden', 'Forbidden', 403));
  const manage = permissions.includes(CODE_MAP_MANAGE);
  const [instrument, observed, maps, instruments] = await Promise.all([
    getInstrument(instrument_id).catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 404) notFound();
      throw e;
    }),
    listObservedInstrumentCodes(instrument_id, { limit: 200 }), // ponytail: first 200 observed codes; add paging when an analyser exceeds it
    manage ? listInstrumentCodeMaps(instrument_id) : undefined,
    manage ? listInstruments({ limit: 200 }).catch(() => ({ data: [] })) : undefined, // [CONV] secondary (copy source list); never blocks the page
  ]);
  let tests: Record<string, TestRef> | undefined;
  if (maps) {
    const ids = [...new Set(maps.data.map((m) => m.test_id))];
    const found = await Promise.all(ids.map((id) => getTestRef(id).catch(() => undefined))); // a failed lookup shows the id, never breaks the page
    tests = Object.fromEntries(found.filter((t): t is TestRef => !!t).map((t) => [t.id, t]));
  }
  return (
    <InstrumentMappings
      instrument={instrument}
      observed={observed.data}
      permissions={permissions}
      {...(maps ? { maps: maps.data, tests: tests ?? {}, instruments: instruments?.data ?? [] } : {})}
    />
  );
}
