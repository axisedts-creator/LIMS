// W2 Visit detail (C17 04-UI-UX §2.2). Permission and id are checked before any API call (notFound); H2 is read exactly once (it writes the access-log row)
// and never carries a phone (H21 is a button press in the view). The visit is rebuilt from an allow-list in read.server.ts. H20 sets are read only for
// visit.assign holders. 404 -> shell not-found; 403 visit_not_assigned (phlebotomist-only actor) -> a plain sentence; anything else reaches error.tsx.
import { notFound } from 'next/navigation';
import { ApiError } from '@/core/api/server-fetch';
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { getShellSession } from '@/core/session/server';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { VisitDetailView } from '@/features/homecollection/components/VisitDetailView';
import { getVisit, isUuid, listReasons } from '@/features/homecollection/server/read.server';

const ok = <T,>(r: PromiseSettledResult<T>): T => {
  if (r.status === 'rejected') throw r.reason;
  return r.value;
};

export default async function VisitPage({ params }: { params: Promise<{ visit_id: string }> }) {
  const session = await getShellSession();
  const permissions = session?.actor.permissions ?? [];
  if (!permissions.includes('homecollection.visit.read')) notFound();
  const { visit_id } = await params;
  if (!isUuid(visit_id)) notFound();
  const canAssign = permissions.includes('homecollection.visit.assign');
  try {
    // allSettled: every request finishes before the page answers; the first failure (H2 first) is rethrown.
    const done = await Promise.allSettled([
      getVisit(visit_id, canAssign),
      canAssign ? listReasons('review_reasons') : [],
      canAssign ? listReasons('flag_resolutions') : [],
      canAssign ? listReasons('visit_cancel_reasons') : [],
      canAssign ? listReasons('unassign_reasons') : [],
      canAssign ? listReasons('revisit_reasons') : [],
    ] as const);
    const visit = ok(done[0]);
    const codes = { review_reasons: ok(done[1]), flag_resolutions: ok(done[2]), visit_cancel_reasons: ok(done[3]), unassign_reasons: ok(done[4]), revisit_reasons: ok(done[5]) };
    return <VisitDetailView visit={visit} permissions={permissions} codes={codes} />;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    if (e instanceof ApiError && e.status === 403) return e.problem.code === 'homecollection.visit_not_assigned' ? <EmptyState title="This visit isn't assigned to you." /> : <PermissionDenied />;
    throw e;
  }
}
