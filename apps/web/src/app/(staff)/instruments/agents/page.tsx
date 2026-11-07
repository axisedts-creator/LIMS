// SCR-01 Agents — server component; data via BFF server functions (02-CONVENTIONS §2.4).
import { getShellSession } from '@/core/session/server';
import { AgentsList } from '@/features/instruments/components/AgentsList';
import { listAgents } from '@/features/instruments/server/listAgents.server';

export default async function AgentsPage() {
  const session = await getShellSession();
  // 04-UI-UX SCR-01: default status filter = all except retired; default sort agent code.
  const { data } = await listAgents({ status: ['pending_enrolment', 'active', 'revoked'], sort: 'agent_code', limit: 50 });
  // ponytail: centres in scope + working centre come from the core session/centre API (not exposed to apps/web yet); ids shown until then.
  return <AgentsList agents={data} permissions={session?.actor.permissions ?? []} centres={[]} />;
}
