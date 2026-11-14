// S7 Goods receipts — server component (route staff.inventory.receipts). ?grn=<id> opens a receipt (404 -> notFound()); ?po=<id> opens "New receipt"
// prefilled from that purchase order (only for inventory.stock.manage). List filters: status, store, supplier, po_id.
// LD-140 (2026-11-13): built from packages/ui components only.
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { getShellSession } from '@/core/session/server';
import { GrnView } from '@/features/inventory/components/GrnView';
import { FORBIDDEN, getGrn, getItem, getPo, guarded, listCodedSet, listGrns, listStores, listSuppliers, soft } from '@/features/inventory/server/read.server';
import type { CodedValue, Item } from '@/features/inventory/server/types';

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function ReceiptsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  const perms = session?.actor.permissions ?? [];
  if (!perms.includes('inventory.item.read')) return <PermissionDenied />;
  const canManage = perms.includes('inventory.stock.manage');
  const grnId = one(sp['grn']);
  const poId = canManage ? one(sp['po']) : undefined;
  const filters = { status: one(sp['status']), store: one(sp['store']), supplier: one(sp['supplier']), poId: one(sp['po_id']) };

  const base = await guarded(() => Promise.all([listGrns(filters), listStores(), listSuppliers(), grnId ? getGrn(grnId) : Promise.resolve(undefined)]));
  if (base === FORBIDDEN) return <PermissionDenied />;
  const [grns, stores, suppliers, selected] = base;
  const prefillPo = poId ? await soft(() => getPo(poId), undefined) : undefined;
  const lineItems = [...new Set([...(selected?.lines.map((l) => l.item_id) ?? []), ...(prefillPo?.lines.map((l) => l.item_id) ?? [])])].slice(0, 100);
  const [taxCodes, items] = await Promise.all([
    canManage || selected ? soft(() => listCodedSet('tax_codes'), [] as CodedValue[]) : Promise.resolve([] as CodedValue[]),
    Promise.all(lineItems.map((id) => soft<Item | undefined>(() => getItem(id), undefined))),
  ]);

  return (
    <GrnView
      grns={grns.data}
      stores={stores.data}
      suppliers={suppliers.data}
      {...(selected ? { selected } : {})}
      {...(prefillPo ? { prefillPo } : {})}
      items={items.filter((i): i is Item => !!i)}
      taxCodes={taxCodes}
      perms={perms}
    />
  );
}
