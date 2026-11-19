// SCR-10 Comment codes — server component via the BFF; 403 → no-access page.
import { t } from '@/core/i18n/messages';
import { getShellSession } from '@/core/session/server';
import { pendingOr } from '@/core/shell/NotAvailable';
import { CatalogForbidden } from '@/features/catalog/components/CatalogForbidden';
import { CommentCodesScreen } from '@/features/catalog/components/CommentCodesScreen';
import { listCommentCodes } from '@/features/catalog/server/listCommentCodes.server';
import { listDepartments } from '@/features/catalog/server/listDepartments.server';
import { PageError } from '@/features/catalog/components/PageError';
import { failedRequestId } from '@/features/catalog/components/page-failed';
import { orForbidden } from '@/features/catalog/server/shared';

export default async function CommentCodesPage() {
  const session = await getShellSession();
  // T0D-TESTMGMT-FIX-1 (LD-340): departments only feeds a dropdown; a failure renders the list with a note instead of error.tsx.
  // T0D-UNSLOP-1 / LD-353 rule 6: 501 operation_pending keeps the title and the header row (NotAvailable), never error.tsx.
  // T0D-UILIST-3 / LD-353 rule 6: any other failure keeps the title (PageError with Retry) instead of the error page.
  const title = t('catalog.nav.comment_codes');
  try {
    return await pendingOr(title, ['Code', 'Department', 'Text', 'Status', 'Version'], () => list(session?.actor.permissions ?? []));
  } catch (e) {
    return <PageError title={title} requestId={failedRequestId(e)} />;
  }
}

async function list(permissions: readonly string[]) {
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
      <CommentCodesScreen commentCodes={r[0].data} departments={r[1].data} permissions={permissions} />
    </>
  );
}
