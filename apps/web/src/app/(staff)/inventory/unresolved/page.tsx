// S15 Waiting consumption — server component (route staff.inventory.unresolved; needs inventory.item.read). GET /consumption-facts?status=unresolved.
// Analyser, test and store names are joined from the C7/C3/C12 lists (optional lookups). The dismiss reasons are the `fact_dismiss` group of the shared reasons set.
// LD-140 (2026-11-13): built from packages/ui components only.
import { ErrorState } from '@lims/ui/components/ErrorState';
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { getShellSession } from '@/core/session/server';
import { UnresolvedView } from '@/features/inventory/components/UnresolvedView';
import { listFacts, listInstruments, listReasons, listStores, listTests, soft } from '@/features/inventory/server/read.server';
import { settle } from '@/features/inventory/server/reports.server';
import { FACT_DISMISS_GROUP } from '@/features/inventory/server/types';

export default async function UnresolvedPage() {
  const session = await getShellSession();
  const perms = session?.actor.permissions ?? [];
  if (!perms.includes('inventory.item.read')) return <PermissionDenied />;
  const canManage = perms.includes('inventory.master.manage');

  const res = await settle(() => listFacts({ status: 'unresolved' }));
  if (!res.ok) {
    return res.status === 403 ? (
      <PermissionDenied />
    ) : (
      <div role="alert">
        <ErrorState title={res.title || 'Waiting consumption could not be loaded'} {...(res.requestId ? { requestId: res.requestId } : {})} />
      </div>
    );
  }
  const [instruments, tests, stores, reasons] = await Promise.all([
    soft(listInstruments, []),
    soft(listTests, []),
    soft(() => listStores().then((r) => r.data), []),
    canManage ? soft(() => listReasons(FACT_DISMISS_GROUP), []) : [],
  ]);

  return <UnresolvedView facts={res.data.data} nextCursor={res.data.page.next_cursor} instruments={instruments} tests={tests} stores={stores} reasons={reasons} canManage={canManage} />;
}
