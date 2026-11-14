// S3 Item detail — server component. A 404 from the API (unknown or other-tenant id) becomes notFound(); 403 -> no-access state.
// LD-140 (2026-11-13): built from packages/ui components only.
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { getShellSession } from '@/core/session/server';
import { ItemDetail } from '@/features/inventory/components/ItemDetail';
import { FORBIDDEN, getItem, guarded, listCodedSet, soft } from '@/features/inventory/server/read.server';

export default async function ItemPage({ params, searchParams }: { params: Promise<{ item_id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, { item_id }] = await Promise.all([getShellSession(), params, searchParams]);
  const perms = session?.actor.permissions ?? [];
  if (!perms.includes('inventory.item.read')) return <PermissionDenied />;
  const canManage = perms.includes('inventory.master.manage');
  const item = await guarded(() => getItem(item_id));
  if (item === FORBIDDEN) return <PermissionDenied />;
  const [uom, tax] = await Promise.all([soft(() => listCodedSet('uom'), []), soft(() => listCodedSet('tax_codes'), [])]);
  return <ItemDetail item={item} canManage={canManage} uom={uom} tax={tax} />;
}
