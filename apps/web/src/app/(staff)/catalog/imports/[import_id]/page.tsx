// SCR-19 Import detail — server component via the BFF. Unknown / other-tenant ids (404) and malformed ids (400) → notFound() (AB-5).
import { notFound } from 'next/navigation';
import { getShellSession } from '@/core/session/server';
import { CatalogForbidden } from '@/features/catalog/components/CatalogForbidden';
import { ImportDetail } from '@/features/catalog/components/ImportDetail';
import { getImport } from '@/features/catalog/server/getImport.server';
import { importPriceListOrUndefined } from '@/features/catalog/server/importPriceLists.server';
import { listImportIssues } from '@/features/catalog/server/listImportIssues.server';
import { orForbidden, orMissing } from '@/features/catalog/server/shared';
import { UUID_RE } from '@/features/catalog/server/types';

export default async function ImportDetailPage({ params }: { params: Promise<{ import_id: string }> }) {
  const { import_id } = await params;
  if (!UUID_RE.test(import_id)) notFound();
  const session = await getShellSession();
  const loaded = await orForbidden(() => orMissing(async () => {
    const row = await getImport(import_id);
    const issues = row.status === 'quarantined' || row.summary.errors + row.summary.warnings === 0 ? [] : (await listImportIssues(import_id, { limit: 200 })).data;
    return { row, issues };
  }));
  if (loaded === null) return <CatalogForbidden />;
  if (!loaded) notFound();
  const priceList = await importPriceListOrUndefined(loaded.row.target_price_list_id);
  return <ImportDetail importRow={loaded.row} issues={loaded.issues} priceList={priceList} permissions={session?.actor.permissions ?? []} />;
}
