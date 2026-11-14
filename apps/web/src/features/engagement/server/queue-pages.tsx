import 'server-only';
// C16.T-Q4 page loaders for W6 (queue/page.tsx) and W7 (queue/setup/page.tsx). Order: permission → centre → reads. Missing permission → notFound().
import { PageHeader } from '@lims/ui/components/PageHeader';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { QueueConsoleHost, QueueSetupHost } from '../components/QueueHosts';
import * as api from './queue.server';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Lab name for the slip header. The tenant display name from the session; never a patient or user name. */
async function labName() {
  const { getShellSession } = await import('@/core/session/server');
  return (await getShellSession())?.actor.tenantCode ?? '';
}

export async function consolePage(searchParams: SearchParams) {
  await api.requirePerm(api.OPERATE); // engagement.queue.operate
  const centreId = await api.resolveCentre(first((await searchParams)['centre_id']));
  if (!centreId) return <EmptyState title="No centre is available for this account." />;
  const [queues, counters, tokens, lab] = await Promise.all([api.listQueues(centreId), api.listCounters(centreId), api.listTokens(centreId), labName()]);
  return (
    <>
      <PageHeader title="Queue console" helpKey="engagement.queue" />
      <QueueConsoleHost labName={lab} centreId={centreId} queues={queues} counters={counters} tokens={tokens} />
    </>
  );
}

export async function setupPage(searchParams: SearchParams) {
  await api.requirePerm(api.MANAGE); // engagement.queue.manage
  const centreId = await api.resolveCentre(first((await searchParams)['centre_id']));
  if (!centreId) return <EmptyState title="No centre is available for this account." />;
  const [queues, counters, displays] = await Promise.all([api.listQueueDefinitions(centreId), api.listCounterDefinitions(centreId), api.listDisplays(centreId)]);
  return (
    <>
      <PageHeader title="Queue setup" helpKey="engagement.queue_setup" />
      <QueueSetupHost centreId={centreId} queues={queues} counters={counters} displays={displays} />
    </>
  );
}
