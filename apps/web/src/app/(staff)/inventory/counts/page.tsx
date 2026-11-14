// S11 Stock counts list — server component (route staff.inventory.counts). "New count" needs inventory.stock.manage.
// LD-140 (2026-11-13): built from packages/ui components only.
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { getShellSession } from '@/core/session/server';
import { CountsView } from '@/features/inventory/components/CountsView';
import { FORBIDDEN, guarded, listCounts, listStores } from '@/features/inventory/server/read.server';

export default async function CountsPage() {
  const session = await getShellSession();
  const perms = session?.actor.permissions ?? [];
  if (!perms.includes('inventory.item.read')) return <PermissionDenied />;
  const base = await guarded(() => Promise.all([listCounts(), listStores()]));
  if (base === FORBIDDEN) return <PermissionDenied />;
  return <CountsView counts={base[0].data} stores={base[1].data} canManage={perms.includes('inventory.stock.manage')} />;
}
