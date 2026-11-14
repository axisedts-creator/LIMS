// SCR-18 Imports & exports — server component via the BFF; 403 → no-access page. Kind-dependent permissions are enforced by the API and hinted in the UI.
import { getShellSession } from '@/core/session/server';
import { CatalogForbidden } from '@/features/catalog/components/CatalogForbidden';
import { ImportsScreen } from '@/features/catalog/components/ImportsScreen';
import { importPriceListsOrEmpty } from '@/features/catalog/server/importPriceLists.server';
import { listExports } from '@/features/catalog/server/listExports.server';
import { listImports } from '@/features/catalog/server/listImports.server';
import { orForbidden } from '@/features/catalog/server/shared';

export default async function ImportsPage() {
  const session = await getShellSession();
  const permissions = session?.actor.permissions ?? [];
  const r = await orForbidden(async () => {
    const [imports, exports] = await Promise.all([listImports({ limit: 100 }), listExports({ limit: 100 })]);
    return { imports: imports.data, exports: exports.data };
  });
  if (!r) return <CatalogForbidden />;
  const priceLists = await importPriceListsOrEmpty(permissions);
  return <ImportsScreen imports={r.imports} exports={r.exports} priceLists={priceLists} permissions={permissions} />;
}
