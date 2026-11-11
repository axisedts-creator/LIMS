// SCR pending list (03-APP-FLOW §3.5).
import { getShellSession } from '@/core/session/server';
import { PendingPage } from '@/features/lab/components/pending/PendingPage';

export default async function Page() {
  const session = await getShellSession();
  return <PendingPage permissions={session?.actor.permissions ?? []} />;
}
