// SCR-01 Catalog home — server component via the BFF. A failed read renders the in-page error state (tiles "—",
// Reference + Retry, 03-APP-FLOW §5) instead of throwing; only the request id travels, never the problem detail.
import { ApiError } from '@/core/api/server-fetch';
import { getShellSession } from '@/core/session/server';
import { CatalogHome } from '@/features/catalog/components/CatalogHome';
import { EMPTY_REPORT, getCatalogCounts } from '@/features/catalog/server/catalogCounts';
import { getCatalogHealthReport } from '@/features/catalog/server/getCatalogHealthReport.server';
import { getCatalogRevision } from '@/features/catalog/server/getCatalogRevision.server';

export default async function CatalogHomePage() {
  const session = await getShellSession();
  const permissions = session?.actor.permissions ?? [];
  const tests = permissions.includes('catalog.test.read'); // health report + revision need catalog.test.read
  try {
    const [health, revision, counts] = await Promise.all([
      tests ? getCatalogHealthReport() : EMPTY_REPORT,
      tests ? getCatalogRevision() : null,
      getCatalogCounts(permissions),
    ]);
    return <CatalogHome health={health} counts={counts} revision={revision?.catalog_revision ?? null} permissions={permissions} />;
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    const id = e.problem.request_id;
    return <CatalogHome health={null} counts={null} revision={null} permissions={permissions} {...(typeof id === 'string' ? { requestId: id } : {})} />;
  }
}
