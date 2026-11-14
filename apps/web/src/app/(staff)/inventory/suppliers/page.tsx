// S5 Suppliers — server component. ?supplier=<id> opens the supplier drawer (404 -> notFound()).
// Money (last price) is stripped here unless the actor has inventory.cost.read, so it never reaches the browser (REQ-SEC-081).
// LD-140 (2026-11-13): built from packages/ui components only.
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { getShellSession } from '@/core/session/server';
import type { ItemInfo } from '@/features/inventory/components/SupplierItems';
import { SuppliersView } from '@/features/inventory/components/SuppliersView';
import { FORBIDDEN, getItem, getSupplier, guarded, listCodedSet, listSupplierItems, listSuppliers, soft } from '@/features/inventory/server/read.server';
import type { Supplier, SupplierItem } from '@/features/inventory/server/types';

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function SuppliersPage({ searchParams }: { searchParams: Promise<SP> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  const perms = session?.actor.permissions ?? [];
  if (!perms.includes('inventory.item.read')) return <PermissionDenied />;
  const canManage = perms.includes('inventory.master.manage');
  const canCost = perms.includes('inventory.cost.read');
  const supplierId = one(sp['supplier']);

  const list = await guarded(() => listSuppliers());
  if (list === FORBIDDEN) return <PermissionDenied />;

  let selected: Supplier | undefined;
  let rows: SupplierItem[] = [];
  const itemInfo: Record<string, ItemInfo> = {};
  let tax: Awaited<ReturnType<typeof listCodedSet>> = [];
  if (supplierId) {
    const r = await guarded(() => Promise.all([getSupplier(supplierId), listSupplierItems(supplierId)]));
    if (r === FORBIDDEN) return <PermissionDenied />;
    selected = r[0];
    rows = canCost ? r[1].data : r[1].data.map(({ last_unit_price_paisa: _price, ...rest }) => rest);
    // ponytail: one GET per distinct item (a supplier links a handful); batch the lookup if suppliers ever list hundreds of items
    const ids = [...new Set(rows.map((x) => x.item_id))];
    const found = await Promise.all(ids.map((id) => soft(() => getItem(id), undefined)));
    for (const it of found) if (it) itemInfo[it.id] = { id: it.id, item_code: it.item_code, name: it.name, packs: it.packs };
    if (canManage) tax = await soft(() => listCodedSet('tax_codes'), []);
  }
  return <SuppliersView key={selected?.id ?? 'none'} suppliers={list.data} canManage={canManage} canCost={canCost} tax={tax} {...(selected ? { selected } : {})} supplierItems={rows} itemInfo={itemInfo} />;
}
