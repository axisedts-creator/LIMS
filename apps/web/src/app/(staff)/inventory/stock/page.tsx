// S8 Stock & issue — server component (route staff.inventory.stock). ?store=<id> picks the store (default: the first visible store); the other filters are
// forwarded to GET /stock. Departments and analysers (issue targets) are loaded only for inventory.stock.manage holders; they are optional lookups.
// LD-140 (2026-11-13): built from packages/ui components only.
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { getShellSession } from '@/core/session/server';
import { StockView } from '@/features/inventory/components/StockView';
import { FORBIDDEN, guarded, listDepartments, listInstruments, listStock, listStores, listTransfers, soft } from '@/features/inventory/server/read.server';
import { UUID_RE } from '@/features/inventory/server/types';

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function StockPage({ searchParams }: { searchParams: Promise<SP> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  const perms = session?.actor.permissions ?? [];
  if (!perms.includes('inventory.item.read')) return <PermissionDenied />;
  const canManage = perms.includes('inventory.stock.manage');

  const stores = await guarded(() => listStores());
  if (stores === FORBIDDEN) return <PermissionDenied />;
  const asked = one(sp['store']);
  const storeId = asked && UUID_RE.test(asked) ? asked : stores.data[0]?.id;

  const category = one(sp['category']);
  const q = one(sp['q']);
  const below = one(sp['below_reorder']);
  const within = one(sp['expiring_within_days']);
  const zero = one(sp['show_zero']);
  const base = await guarded(() =>
    Promise.all([
      storeId
        ? listStock({ storeId, ...(category ? { category } : {}), ...(q ? { q } : {}), ...(below === 'true' ? { belowReorder: 'true' } : {}), ...(within ? { expiringWithinDays: within } : {}), ...(zero === 'true' ? { includeZero: 'true' } : {}) })
        : Promise.resolve({ data: [], page: { limit: 200 } }),
      soft(() => listTransfers({ status: 'dispatched' }), { data: [], page: { limit: 100 } }),
    ]),
  );
  if (base === FORBIDDEN) return <PermissionDenied />;
  const [departments, instruments] = canManage ? await Promise.all([soft(listDepartments, []), soft(listInstruments, [])]) : [[], []];

  return <StockView stores={stores.data} storeId={storeId} rows={base[0].data} transfers={base[1].data} canManage={canManage} departments={departments} instruments={instruments} />;
}
