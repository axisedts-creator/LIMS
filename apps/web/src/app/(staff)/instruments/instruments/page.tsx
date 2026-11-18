// SCR-05 Instruments — server component; data via BFF server functions (02-CONVENTIONS §2.4). Filters/sort live in the URL.
import { ApiError } from '@/core/api/server-fetch';
import { getShellSession } from '@/core/session/server';
import { pendingOr } from '@/core/shell/NotAvailable';
import { InstrumentsList } from '@/features/instruments/components/InstrumentsList';
import { listAgents } from '@/features/instruments/server/listAgents.server';
import { listDrivers } from '@/features/instruments/server/listDrivers.server';
import { listInstruments } from '@/features/instruments/server/listInstruments.server';
import { parseInstrumentQuery } from '@/features/instruments/server/types';

export default async function InstrumentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  // T0D-UNSLOP-1 / LD-353 rule 6: 501 operation_pending keeps the title and a header row (NotAvailable), never error.tsx.
  return pendingOr('Instruments', ['Code', 'Name', 'Agent', 'Driver', 'Last message', 'Status'], async () => {
    const [main, agents, drivers] = await Promise.all([
      listInstruments({ ...parseInstrumentQuery(sp), limit: 50 }).then((r) => ({ ok: true as const, data: r.data }), (e: unknown) => ({ ok: false as const, e })),
      listAgents({ limit: 200 }).catch(() => ({ data: [] })), // [CONV] filter/select data is secondary (needs instruments.agent.read); never blocks the list
      listDrivers().catch(() => ({ data: [] })),
    ]);
    // Centres in scope: no core API in apps/web yet (CR .orchestra/cr/WEB-T02.md, item b) → the Centre filter stays empty.
    const common = { permissions: session?.actor.permissions ?? [], centres: [], agents: agents.data, drivers: drivers.data };
    if (main.ok) return <InstrumentsList instruments={main.data} {...common} />;
    // T0D-UILIST-1 (LD-353 rule 6): a failed read keeps the title and the filters; the table body shows ErrorState with reference and Retry.
    const e = main.e;
    if (!(e instanceof ApiError) || e.status === 403 || e.status === 501) throw e;
    return <InstrumentsList instruments={[]} {...common} loadError={e.problem.request_id ? { requestId: e.problem.request_id } : {}} />;
  });
}
