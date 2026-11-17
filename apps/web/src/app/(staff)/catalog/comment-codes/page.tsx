// SCR-10 Comment codes — server component via the BFF; 403 → no-access page.
import { getShellSession } from '@/core/session/server';
import { CatalogForbidden } from '@/features/catalog/components/CatalogForbidden';
import { CommentCodesScreen } from '@/features/catalog/components/CommentCodesScreen';
import { listCommentCodes } from '@/features/catalog/server/listCommentCodes.server';
import { listDepartments } from '@/features/catalog/server/listDepartments.server';
import { orForbidden } from '@/features/catalog/server/shared';

export default async function CommentCodesPage() {
  const session = await getShellSession();
  // T0D-TESTMGMT-FIX-1 (LD-340): departments only feeds a dropdown; a failure renders the list with a note instead of error.tsx.
  let deptFailed = false;
  const r = await orForbidden(() =>
    Promise.all([
      listCommentCodes({ isActive: 'all', limit: 200 }),
      listDepartments({ isActive: 'all', limit: 200 }).catch(() => { deptFailed = true; return { data: [] as Awaited<ReturnType<typeof listDepartments>>['data'] }; }),
    ]),
  );
  if (!r) return <CatalogForbidden />;
  return (
    <>
      {deptFailed ? <p role="note" className="lims-description">Departments could not be loaded; the page is shown without them. Reload to try again.</p> : null}
      <CommentCodesScreen commentCodes={r[0].data} departments={r[1].data} permissions={session?.actor.permissions ?? []} />
    </>
  );
}
