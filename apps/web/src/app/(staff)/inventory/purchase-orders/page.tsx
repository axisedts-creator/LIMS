// S6 Purchase orders — server component (route staff.inventory.purchase_orders). ?po=<id> opens the drawer (404 -> notFound()).
// Filters are query params: status, supplier, branch, created_from, created_to (-> API status / supplier_id / branch_id / created_at_from / created_at_to).
// Cost fields come from the API only for inventory.cost.read; the reason lists (reasons coded set, reason_group po_cancel | po_close) are loaded only when an action can use them.
// LD-140 (2026-11-13): built from packages/ui components only.
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { getShellSession } from '@/core/session/server';
import { PoView } from '@/features/inventory/components/PoView';
import { FORBIDDEN, getItem, getPo, guarded, listCodedSet, listPos, listReasons, listStores, listSuppliers, soft } from '@/features/inventory/server/read.server';
import { PO_REASON_GROUPS, type CodedValue, type Item } from '@/features/inventory/server/types';

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function PurchaseOrdersPage({ searchParams }: { searchParams: Promise<SP> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  const perms = session?.actor.permissions ?? [];
  if (!perms.includes('inventory.item.read')) return <PermissionDenied />;
  const canManage = perms.includes('inventory.po.manage');
  const poId = one(sp['po']);
  const filters = { status: one(sp['status']), supplier: one(sp['supplier']), branch: one(sp['branch']), createdFrom: one(sp['created_from']), createdTo: one(sp['created_to']) };

  const base = await guarded(() => Promise.all([listPos(filters), listStores(), listSuppliers(), poId ? getPo(poId) : Promise.resolve(undefined)]));
  if (base === FORBIDDEN) return <PermissionDenied />;
  const [pos, stores, suppliers, selected] = base;
  const actionable = !!selected && perms.includes('inventory.po.manage') && selected.status !== 'draft';
  const lineItems = [...new Set(selected?.lines.map((l) => l.item_id) ?? [])].slice(0, 100);
  const [taxCodes, items, cancel, close] = await Promise.all([
    canManage || selected ? soft(() => listCodedSet('tax_codes'), [] as CodedValue[]) : Promise.resolve([] as CodedValue[]),
    Promise.all(lineItems.map((id) => soft<Item | undefined>(() => getItem(id), undefined))),
    actionable ? soft(() => listReasons(PO_REASON_GROUPS.cancel), [] as CodedValue[]) : Promise.resolve([] as CodedValue[]),
    actionable ? soft(() => listReasons(PO_REASON_GROUPS.close), [] as CodedValue[]) : Promise.resolve([] as CodedValue[]),
  ]);

  return (
    <PoView
      pos={pos.data}
      stores={stores.data}
      suppliers={suppliers.data}
      {...(selected ? { selected } : {})}
      items={items.filter((i): i is Item => !!i)}
      taxCodes={taxCodes}
      perms={perms}
      reasons={{ cancel, close }}
    />
  );
}
