// W1 Dispatch board (C17 04-UI-UX §2.1). Permission is checked before any API call; the URL is reduced to a whitelisted H1 / H10 query; every row is
// rebuilt from an allow-list in read.server.ts. A 403 from the API renders PermissionDenied; anything else reaches error.tsx.
import { notFound } from 'next/navigation';
import { ApiError } from '@/core/api/server-fetch';
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { getShellSession } from '@/core/session/server';
import { DispatchBoard } from '@/features/homecollection/components/DispatchBoard';
import { dispatchQuery } from '@/features/homecollection/query';
import { listCentres, listReasons, listRoutes, listVisits } from '@/features/homecollection/server/read.server';

const ok = <T,>(r: PromiseSettledResult<T>): T => {
  if (r.status === 'rejected') throw r.reason;
  return r.value;
};

export default async function DispatchPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await getShellSession();
  const permissions = session?.actor.permissions ?? [];
  if (!permissions.includes('homecollection.visit.read')) notFound();
  const sp = await searchParams;
  const centres = await listCentres().catch(() => []); // a centre list that cannot be read must not break the board
  const { date, centreId, visits, routes, filter } = dispatchQuery(sp, Date.now(), centres);
  const canAssign = permissions.includes('homecollection.visit.assign');
  try {
    // allSettled: every request finishes before the page answers, so none outlives a failed render; the first failure (H1 first) is rethrown.
    const done = await Promise.allSettled([
      listVisits(visits), listRoutes(routes), canAssign ? listReasons('visit_cancel_reasons') : [], canAssign ? listReasons('unassign_reasons') : [],
    ] as const);
    const [list, routeRows, visit_cancel_reasons, unassign_reasons] = [ok(done[0]), ok(done[1]), ok(done[2]), ok(done[3])] as const;
    return (
      <DispatchBoard
        date={date} centreId={centreId} centres={centres} visits={list.rows} routes={routeRows} permissions={permissions}
        codes={{ visit_cancel_reasons, unassign_reasons }} filter={filter} nextCursor={list.next}
      />
    );
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) return <PermissionDenied />;
    throw e;
  }
}
