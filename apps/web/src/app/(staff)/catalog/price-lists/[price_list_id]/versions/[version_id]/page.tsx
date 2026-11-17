// SCR-14 price-list version editor — the version must belong to the list in the path (else 404); 403 → no-access page.
import { notFound } from 'next/navigation';
import { getShellSession } from '@/core/session/server';
import { CatalogForbidden } from '@/features/catalog/components/CatalogForbidden';
import { PriceVersionEditor } from '@/features/catalog/components/PriceVersionEditor';
import { getPriceListDetail } from '@/features/catalog/server/getPriceListDetail.server';
import { listDepartments } from '@/features/catalog/server/listDepartments.server';
import { loadAllItems, loadPricedOrderables } from '@/features/catalog/server/pricingPage';
import { orForbidden, orMissing } from '@/features/catalog/server/shared';

export default async function PriceListVersionPage({ params }: { params: Promise<{ price_list_id: string; version_id: string }> }) {
  const [{ price_list_id, version_id }, session] = await Promise.all([params, getShellSession()]);
  const r = await orForbidden(async () => {
    const list = await orMissing(() => getPriceListDetail(price_list_id));
    const version = list?.versions.find((v) => v.id === version_id);
    if (!list || !version) return undefined;
    const currentId = list.current_version?.id;
    const [items, currentItems, orderables, depts] = await Promise.all([
      loadAllItems(version.id),
      currentId && currentId !== version.id ? loadAllItems(currentId) : Promise.resolve(undefined),
      loadPricedOrderables(),
      listDepartments({ isActive: 'all', limit: 200 }),
    ]);
    return { list, version, items, currentItems: currentItems ?? (currentId === version.id ? items : []), orderables, departments: depts.data };
  });
  if (r === null) return <CatalogForbidden />;
  if (!r) notFound();
  return (
    <PriceVersionEditor
      priceList={{ id: r.list.id, code: r.list.code, name: r.list.name }}
      version={r.version}
      items={r.items}
      currentItems={r.currentItems}
      orderables={r.orderables}
      departments={r.departments}
      permissions={session?.actor.permissions ?? []}
    />
  );
}
