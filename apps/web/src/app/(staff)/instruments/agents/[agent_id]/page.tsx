// SCR-02 Agent detail — server component. 404 (incl. another centre's agent, AC-16.2) → notFound(); other errors → error.tsx.
import { notFound } from 'next/navigation';
import { ApiError } from '@/core/api/server-fetch';
import { getShellSession } from '@/core/session/server';
import { AgentDetail } from '@/features/instruments/components/AgentDetail';
import { getAgent } from '@/features/instruments/server/getAgent.server';
import { listAgentHealthTransitions } from '@/features/instruments/server/listAgentHealthTransitions.server';

export default async function AgentPage({ params }: { params: Promise<{ agent_id: string }> }) {
  const { agent_id } = await params;
  const [session, agent, transitions] = await Promise.all([
    getShellSession(),
    getAgent(agent_id).catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 404) notFound();
      throw e;
    }),
    listAgentHealthTransitions(agent_id).catch(() => ({ data: [] })), // [CONV] history is secondary; never blocks the page
  ]);
  // ponytail: instruments tab is fed by E21 (WEB-T03 owns listInstruments); empty until then.
  return <AgentDetail agent={agent} transitions={transitions.data} instruments={[]} permissions={session?.actor.permissions ?? []} />;
}
