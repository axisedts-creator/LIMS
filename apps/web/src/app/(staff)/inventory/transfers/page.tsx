// S9 Transfers — server component (route staff.inventory.transfers). ?transfer=<id> opens the detail drawer (404 -> notFound()).
// "To store" candidates come from GET /stores?purpose=transfer_target (every tenant store, also outside the sender's branch scope);
// "From" and the Receive gate use the visible stores (AC-10.3). Item and lot labels for the lines are optional lookups.
// LD-140 (2026-11-13): built from packages/ui components only.
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { getShellSession } from '@/core/session/server';
import { TransfersView } from '@/features/inventory/components/TransfersView';
import { FORBIDDEN, getTransfer, guarded, listCodedSet, listItems, listStores, listTransfers, listTransferTargets, lotsByItems, soft } from '@/features/inventory/server/read.server';

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function TransfersPage({ searchParams }: { searchParams: Promise<SP> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  const perms = session?.actor.permissions ?? [];
  if (!perms.includes('inventory.item.read')) return <PermissionDenied />;
  const canManage = perms.includes('inventory.stock.manage');
  const transferId = one(sp['transfer']);

  const base = await guarded(() => Promise.all([listTransfers(), listStores(), transferId ? getTransfer(transferId) : Promise.resolve(undefined)]));
  if (base === FORBIDDEN) return <PermissionDenied />;
  const [transfers, stores, selected] = base;
  const [targets, items, lots, reasons] = await Promise.all([
    canManage ? soft(listTransferTargets, []) : [],
    selected ? soft(() => listItems({ limit: 200 }).then((r) => r.data), []) : [],
    selected ? lotsByItems(selected.lines.map((l) => l.item_id)) : [],
    selected && canManage ? soft(() => listCodedSet('transfer_discrepancy'), []) : [],
  ]);

  return <TransfersView transfers={transfers.data} stores={stores.data} targets={targets} {...(selected ? { selected } : {})} items={items} lots={lots} discrepancyReasons={reasons} canManage={canManage} />;
}
