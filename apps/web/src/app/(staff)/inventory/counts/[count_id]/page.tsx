// S11 count entry — server component (route staff.inventory.count). 404 -> notFound(). BLIND count: users without inventory.stock.adjust get the
// count with the system quantities and variances REMOVED here, so the snapshot never reaches their browser. Item and lot labels are joined by id
// (CountLine carries ids only) and are optional lookups.
// LD-140 (2026-11-13): built from packages/ui components only.
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { getShellSession } from '@/core/session/server';
import { CountEntry } from '@/features/inventory/components/CountEntry';
import { blindLines, FORBIDDEN, getCount, guarded, listItems, listStores, lotsByItems, soft } from '@/features/inventory/server/read.server';

export default async function CountPage({ params }: { params: Promise<{ count_id: string }>; searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, { count_id }] = await Promise.all([getShellSession(), params]);
  const perms = session?.actor.permissions ?? [];
  if (!perms.includes('inventory.item.read')) return <PermissionDenied />;
  const canAdjust = perms.includes('inventory.stock.adjust');

  const count = await guarded(() => getCount(count_id));
  if (count === FORBIDDEN) return <PermissionDenied />;
  const [stores, items, lots] = await Promise.all([
    soft(() => listStores().then((r) => r.data), []),
    soft(() => listItems({ limit: 200 }).then((r) => r.data), []),
    lotsByItems(count.lines.map((l) => l.item_id)),
  ]);
  const view = { ...count, lines: blindLines(count.lines, perms) };

  return <CountEntry count={view} storeName={stores.find((s) => s.id === count.store_id)?.name ?? count.store_id} items={items} lots={lots} canManage={perms.includes('inventory.stock.manage')} canAdjust={canAdjust} />;
}
