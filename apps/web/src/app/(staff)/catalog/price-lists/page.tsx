// SCR-13 Price lists — server component via the BFF; 403 → no-access page.
import { getShellSession } from '@/core/session/server';
import { CatalogForbidden } from '@/features/catalog/components/CatalogForbidden';
import { PriceListsList } from '@/features/catalog/components/PriceListsList';
import { listPriceLists } from '@/features/catalog/server/listPriceLists.server';
import { orForbidden } from '@/features/catalog/server/shared';

export default async function PriceListsPage() {
  const session = await getShellSession();
  const r = await orForbidden(() => listPriceLists({ isActive: 'all', limit: 200 }));
  if (!r) return <CatalogForbidden />;
  return <PriceListsList priceLists={r.data} permissions={session?.actor.permissions ?? []} />;
}
