// S2 Items list — server component; data via BFF server functions (02-CONVENTIONS §2.4). 403 -> no-access state; other failures -> error.tsx.
// LD-140 (2026-11-13): list + right Drawer; the screen is built from packages/ui components only.
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { getShellSession } from '@/core/session/server';
import { ItemsList } from '@/features/inventory/components/ItemsList';
import { FORBIDDEN, guarded, listCodedSet, listItems, soft } from '@/features/inventory/server/read.server';

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const CATEGORIES = ['reagent', 'kit', 'consumable', 'control', 'calibrator', 'other'];

export default async function ItemsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  const perms = session?.actor.permissions ?? [];
  if (!perms.includes('inventory.item.read')) return <PermissionDenied />;
  const canManage = perms.includes('inventory.master.manage');
  const category = one(sp['category']);
  const isActive = one(sp['is_active']);
  const q = one(sp['q'])?.slice(0, 60);
  const cursor = one(sp['cursor']);
  const r = await guarded(() =>
    listItems({
      ...(category && CATEGORIES.includes(category) ? { category } : {}),
      ...(isActive === 'true' || isActive === 'false' ? { isActive } : {}),
      ...(q ? { q } : {}),
      ...(cursor ? { cursor } : {}),
    }),
  );
  if (r === FORBIDDEN) return <PermissionDenied />;
  const [uom, tax] = canManage ? await Promise.all([soft(() => listCodedSet('uom'), []), soft(() => listCodedSet('tax_codes'), [])]) : [[], []];
  return <ItemsList items={r.data} {...(r.page.next_cursor ? { nextCursor: r.page.next_cursor } : {})} hasPrevious={!!cursor} canManage={canManage} uom={uom} tax={tax} />;
}
