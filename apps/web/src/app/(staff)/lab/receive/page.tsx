// 04-UI-UX §3.3 (route /lab/receive). Reference reads only; each is best-effort so a refused read never takes the scan screen down:
// no centres → the screen asks for a location it cannot offer; no settings → recollection_default false (no stale default).
import { getShellSession } from '@/core/session/server';
import { ReceiveScreen } from '@/features/lab/components/ReceiveScreen';
import { listCentres } from '@/features/frontdesk/server/read.server';
import { getRecollectionDefault, listRejectionReasons } from '@/features/lab/server/read.server';

export const metadata = { title: 'Receive specimens' };

export default async function ReceivePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session] = await Promise.all([getShellSession(), searchParams]);
  const permissions = session?.actor.permissions ?? [];
  const [centres, rejectionReasons, recollectionDefault] = await Promise.all([
    listCentres().catch(() => []),
    permissions.includes('lab.specimen.reject') ? listRejectionReasons().catch(() => []) : [],
    getRecollectionDefault().catch(() => false),
  ]);
  return <ReceiveScreen centres={centres} rejectionReasons={rejectionReasons} recollectionDefault={recollectionDefault} permissions={permissions} />;
}
