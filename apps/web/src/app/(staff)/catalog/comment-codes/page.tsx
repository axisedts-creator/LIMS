// SCR-10 Comment codes — server component via the BFF; 403 → no-access page.
import { getShellSession } from '@/core/session/server';
import { CatalogForbidden } from '@/features/catalog/components/CatalogForbidden';
import { CommentCodesScreen } from '@/features/catalog/components/CommentCodesScreen';
import { listCommentCodes } from '@/features/catalog/server/listCommentCodes.server';
import { listDepartments } from '@/features/catalog/server/listDepartments.server';
import { orForbidden } from '@/features/catalog/server/shared';

export default async function CommentCodesPage() {
  const session = await getShellSession();
  const r = await orForbidden(() => Promise.all([listCommentCodes({ isActive: 'all', limit: 200 }), listDepartments({ isActive: 'all', limit: 200 })]));
  if (!r) return <CatalogForbidden />;
  return <CommentCodesScreen commentCodes={r[0].data} departments={r[1].data} permissions={session?.actor.permissions ?? []} />;
}
