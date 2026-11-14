// SCR-05 Instruments — server component; data via BFF server functions (02-CONVENTIONS §2.4). Filters/sort live in the URL.
import { getShellSession } from '@/core/session/server';
import { InstrumentsList } from '@/features/instruments/components/InstrumentsList';
import { listAgents } from '@/features/instruments/server/listAgents.server';
import { listDrivers } from '@/features/instruments/server/listDrivers.server';
import { listInstruments } from '@/features/instruments/server/listInstruments.server';
import { parseInstrumentQuery } from '@/features/instruments/server/types';

export default async function InstrumentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  const [{ data }, agents, drivers] = await Promise.all([
    listInstruments({ ...parseInstrumentQuery(sp), limit: 50 }),
    listAgents({ limit: 200 }).catch(() => ({ data: [] })), // [CONV] filter/select data is secondary (needs instruments.agent.read); never blocks the list
    listDrivers().catch(() => ({ data: [] })),
  ]);
  // Centres in scope: no core API in apps/web yet (CR .orchestra/cr/WEB-T02.md, item b) → the Centre filter stays empty.
  return <InstrumentsList instruments={data} permissions={session?.actor.permissions ?? []} centres={[]} agents={agents.data} drivers={drivers.data} />;
}
