// SCR-07 Instrument detail — server component. 404 (incl. another centre's instrument) or a malformed id → notFound(); other errors → error.tsx.
import { notFound } from 'next/navigation';
import { ApiError } from '@/core/api/server-fetch';
import { getShellSession } from '@/core/session/server';
import { InstrumentDetail } from '@/features/instruments/components/InstrumentDetail';
import { getInstrument } from '@/features/instruments/server/getInstrument.server';
import { listAgents } from '@/features/instruments/server/listAgents.server';
import { listDrivers } from '@/features/instruments/server/listDrivers.server';
import { UUID_RE } from '@/features/instruments/server/types';

export default async function InstrumentPage({ params }: { params: Promise<{ instrument_id: string }> }) {
  const { instrument_id } = await params;
  if (!UUID_RE.test(instrument_id)) notFound(); // never forwarded to the API
  const [session, instrument, agents, drivers] = await Promise.all([
    getShellSession(),
    getInstrument(instrument_id).catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 404) notFound();
      throw e;
    }),
    listAgents({ limit: 200 }).catch(() => ({ data: [] })), // [CONV] secondary data (agent select); never blocks the page
    listDrivers().catch(() => ({ data: [] })),
  ]);
  return <InstrumentDetail instrument={instrument} agents={agents.data} drivers={drivers.data} permissions={session?.actor.permissions ?? []} />;
}
