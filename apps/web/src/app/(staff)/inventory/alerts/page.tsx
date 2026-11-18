// S16 Alerts — server component (04-UI-UX §3 S16). ?alert_kind=<kind> ?status=<csv> ?store_id=<id> filter the list; every value is checked against
// the contract enums / UUID before it is forwarded, anything else is dropped (no query injection). Store and item codes are resolved here.
// LD-140 (2026-11-13): built from packages/ui components only.
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { ApiError } from '@/core/api/server-fetch';
import { isPending } from '@/core/shell/NotAvailable';
import { getShellSession } from '@/core/session/server';
import { AlertsView, type AlertRow, type AlertsLoadFailure } from '@/features/inventory/components/AlertsView';
import { FORBIDDEN, guarded, listAlerts, listItems, listStores, lotsByItems, soft } from '@/features/inventory/server/read.server';
import { ALERT_KINDS, ALERT_STATUSES, UUID_RE, type AlertKind, type AlertStatus, type ItemSummary, type Page, type Store } from '@/features/inventory/server/types';

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const empty = <T,>(): Page<T> => ({ data: [], page: { limit: 1 } });

export default async function AlertsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  const perms = session?.actor.permissions ?? [];
  if (!perms.includes('inventory.item.read')) return <PermissionDenied />;

  const kind = ALERT_KINDS.find((k) => k === one(sp['alert_kind']));
  const statuses = (one(sp['status']) ?? '').split(',').filter((s): s is AlertStatus => (ALERT_STATUSES as readonly string[]).includes(s));
  const storeParam = one(sp['store_id']);
  const storeId = storeParam && UUID_RE.test(storeParam) ? storeParam : undefined;

  return alerts(perms, kind as AlertKind | undefined, statuses, storeId);
}

async function alerts(perms: readonly string[], kind: AlertKind | undefined, statuses: AlertStatus[], storeId: string | undefined) {
  // T0D-UILIST-3 / LD-353 rule 6: a failed list read keeps the page (title, FilterBar, header row): 501 operation_pending shows the calm
  // NotAvailable line, any other failure an ErrorState with reference and Retry; nothing throws to error.tsx. Only 403 is the no-access page.
  const canAcknowledge = perms.includes('inventory.stock.manage');
  let list: Awaited<ReturnType<typeof listAlerts>> | typeof FORBIDDEN;
  try {
    list = await guarded(() => listAlerts({ ...(statuses.length ? { status: statuses } : {}), ...(kind ? { alertKind: kind as AlertKind } : {}), ...(storeId ? { storeId } : {}) }));
  } catch (e) {
    if (!(e instanceof ApiError)) throw e; // notFound() and programming errors keep their normal path
    const stores = await soft(listStores, empty<Store>());
    const failure: AlertsLoadFailure = isPending(e) ? { pending: true } : { pending: false, requestId: e.problem.request_id };
    return <AlertsView rows={[]} stores={stores.data.map((s) => ({ value: s.id, label: s.store_code }))} canAcknowledge={canAcknowledge} loadFailure={failure} />;
  }
  if (list === FORBIDDEN) return <PermissionDenied />;

  const [stores, items, lots] = await Promise.all([
    soft(listStores, empty<Store>()),
    soft(() => listItems({ limit: 200 }), empty<ItemSummary>()),
    lotsByItems(list.data.filter((a) => a.lot_id && a.item_id).map((a) => a.item_id!)),
  ]);
  const storeCode = new Map(stores.data.map((s) => [s.id, s.store_code]));
  const itemCode = new Map(items.data.map((i) => [i.id, i.item_code]));
  const lotNo = new Map(lots.map((l) => [l.id, l.lot_no]));
  const rows: AlertRow[] = list.data.map((a) => ({
    alert: a,
    store: (a.store_id && storeCode.get(a.store_id)) || '—',
    item: (a.item_id && itemCode.get(a.item_id)) || '—',
    lot: (a.lot_id && lotNo.get(a.lot_id)) || '—',
  }));

  return <AlertsView rows={rows} stores={stores.data.map((s) => ({ value: s.id, label: s.store_code }))} canAcknowledge={canAcknowledge} />;
}
