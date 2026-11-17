// S6-P Print view of a purchase order — server component. GET /purchase-orders/{id}/print-view is cost-gated: without inventory.cost.read there is
// no page and no API call. A malformed id or a 404 -> notFound(). LD-140 (2026-11-13): built from packages/ui components only.
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { getShellSession } from '@/core/session/server';
import { PoPrint } from '@/features/inventory/components/PoPrint';
import { FORBIDDEN, getPoPrintView, guarded } from '@/features/inventory/server/read.server';

export default async function PoPrintPage({ params }: { params: Promise<{ po_id: string }> }) {
  const [session, { po_id }] = await Promise.all([getShellSession(), params]);
  const perms = session?.actor.permissions ?? [];
  if (!perms.includes('inventory.item.read') || !perms.includes('inventory.cost.read')) return <PermissionDenied />;
  const doc = await guarded(() => getPoPrintView(po_id));
  if (doc === FORBIDDEN) return <PermissionDenied />;
  return <PoPrint doc={doc} />;
}
