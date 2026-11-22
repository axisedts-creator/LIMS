// S10 Wastage | Adjustment | Expiry write-off — server component. ?store=<id> picks the store (default: the first visible store).
// The page needs inventory.item.read; the forms need inventory.stock.manage (Adjustment: inventory.stock.adjust). Reason lists are the C12 coded sets.
// LD-140 (2026-11-13): built from packages/ui components only.
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { getShellSession } from '@/core/session/server';
import { WastageView } from '@/features/inventory/components/WastageView';
import { Banner } from '@lims/ui/components/Banner';
import { FORBIDDEN, guarded, listCodedSet, listStock, listStores, softOr } from '@/features/inventory/server/read.server';
import { UUID_RE } from '@/features/inventory/server/types';

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function WastagePage({ searchParams }: { searchParams: Promise<SP> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  const perms = session?.actor.permissions ?? [];
  if (!perms.includes('inventory.item.read') || !perms.includes('inventory.stock.manage')) return <PermissionDenied />;
  const canAdjust = perms.includes('inventory.stock.adjust');

  const stores = await guarded(() => listStores());
  if (stores === FORBIDDEN) return <PermissionDenied />;
  const asked = one(sp['store']);
  const storeId = asked && UUID_RE.test(asked) ? asked : stores.data[0]?.id;
  if (!storeId) return <PermissionDenied />;

  const base = await guarded(() => Promise.all([listStock({ storeId }), listStock({ storeId, expiredOnly: true })]));
  if (base === FORBIDDEN) return <PermissionDenied />;
  // T0D-FIX-9 (LD-455): a failed reason read is shown with its reference, never an empty reason list
  const [wastage, adjustment] = await Promise.all([softOr(() => listCodedSet('wastage'), []), canAdjust ? softOr(() => listCodedSet('adjustment'), []) : { value: [] as Awaited<ReturnType<typeof listCodedSet>>, failed: undefined }]);
  const failed = [wastage, adjustment].find((r) => r.failed !== undefined)?.failed;

  return (
    <>
      {failed !== undefined ? (
        <div role="alert">
          <Banner tone="danger" title="The reason lists could not be loaded. Saving needs a reason, so try again.">
            {failed ? <p>{`Reference: ${failed}`}</p> : null}
          </Banner>
        </div>
      ) : null}
      <WastageView stores={stores.data} storeId={storeId} balances={base[0].data} expired={base[1].data} wastageReasons={wastage.value} adjustmentReasons={adjustment.value} canAdjust={canAdjust} />
    </>
  );
}
