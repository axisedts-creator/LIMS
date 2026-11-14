// SCR-01 Agents — server component; data via BFF server functions (02-CONVENTIONS §2.4). Filters/sort live in the URL.
import { getShellSession } from '@/core/session/server';
import { AgentsList } from '@/features/instruments/components/AgentsList';
import { listAgents } from '@/features/instruments/server/listAgents.server';
import { parseAgentQuery } from '@/features/instruments/server/types';

export default async function AgentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  const { data } = await listAgents({ ...parseAgentQuery(sp), limit: 50 });
  // Centres in scope + working centre: no core API in apps/web yet (CR .orchestra/cr/WEB-T02.md); the dialog shows a field error until then.
  return <AgentsList agents={data} permissions={session?.actor.permissions ?? []} centres={[]} />;
}
