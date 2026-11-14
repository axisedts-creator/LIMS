// S1 Inventory home — server component (04-UI-UX §3 S1; AC-20.1: one alert row per open pair, with its occurrence count).
// LD-140 (2026-11-13): built from packages/ui components only. Counts are of OPEN alerts / unresolved facts; any API failure other than 403 throws to
// error.tsx (no fake zero counts), 403 shows the no-access state. Store, item and lot labels are resolved here so the browser gets codes, not ids.
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { getShellSession } from '@/core/session/server';
import { InventoryHome, type HomeAlertRow } from '@/features/inventory/components/InventoryHome';
import { FORBIDDEN, getItem, getSettings, guarded, listAlerts, listBindings, listItems, listOpeningMovements, listRules, listStores, listUnresolvedFacts, lotsByItems, soft } from '@/features/inventory/server/read.server';
import type { Alert, AlertKind, Binding, ItemSummary, Page, Store } from '@/features/inventory/server/types';

const NEWEST = 10;
const empty = <T,>(): Page<T> => ({ data: [], page: { limit: 1 } });

// Each tile counts its own kind (alert_kind filter) so one noisy kind cannot hide another; "200+" only when that kind has more pages.
const count = (p: Page<unknown>) => `${p.data.length}${p.page.next_cursor ? '+' : ''}`;

async function checklist(consumptionOn: boolean) {
  const [stores, items, rules, bindings, opening] = await Promise.all([
    soft(listStores, empty<Store>()),
    soft(() => listItems({ isActive: 'true', limit: 1 }), empty<ItemSummary>()),
    soft(listRules, empty<{ id: string }>()),
    soft(listBindings, empty<Binding>()),
    soft(listOpeningMovements, empty<{ id: string }>()),
  ]);
  const first = items.data[0];
  const packs = first ? await soft(async () => ((await getItem(first.id)).packs?.length ?? 0) > 0, false) : false;
  return [
    { label: 'Stores per branch', done: stores.data.length > 0 },
    { label: 'Items', done: items.data.length > 0 },
    { label: 'Packs', done: packs },
    { label: 'Rules', done: rules.data.length > 0 },
    { label: 'Analyser bindings', done: bindings.data.length > 0 },
    { label: 'Opening balances', done: opening.data.length > 0 },
    { label: 'Consumption switched on', done: consumptionOn },
  ];
}

export default async function InventoryHomePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await searchParams; // no query params on S1; awaited so Next treats the page as dynamic
  const session = await getShellSession();
  const perms = session?.actor.permissions ?? [];
  if (!perms.includes('inventory.item.read')) return <PermissionDenied />;

  const open = (alertKind?: AlertKind) => listAlerts({ status: ['open'], alertKind });
  const base = await guarded(() =>
    Promise.all([open(), open('below_reorder'), open('expiry_soon'), open('expired_on_hand'), listUnresolvedFacts(), getSettings()]),
  );
  if (base === FORBIDDEN) return <PermissionDenied />;
  const [alerts, belowReorder, expiring, expired, facts, settings] = base;

  const newest: Alert[] = [...alerts.data].sort((a, b) => b.last_raised_at.localeCompare(a.last_raised_at)).slice(0, NEWEST);

  const [stores, items, lots, steps] = await Promise.all([
    soft(listStores, empty<Store>()),
    soft(() => listItems({ limit: 200 }), empty<ItemSummary>()),
    lotsByItems(newest.filter((a) => a.lot_id && a.item_id).map((a) => a.item_id!)),
    checklist(!!settings.consumption_enabled_at),
  ]);
  const storeCode = new Map(stores.data.map((s) => [s.id, s.store_code]));
  const itemCode = new Map(items.data.map((i) => [i.id, i.item_code]));
  const lotNo = new Map(lots.map((l) => [l.id, l.lot_no]));
  const rows: HomeAlertRow[] = newest.map((a) => ({
    alert: a,
    store: (a.store_id && storeCode.get(a.store_id)) || '—',
    item: (a.item_id && itemCode.get(a.item_id)) || '—',
    lot: (a.lot_id && lotNo.get(a.lot_id)) || '—',
  }));

  return (
    <InventoryHome
      counts={{ belowReorder: count(belowReorder), expiring: count(expiring), expired: count(expired), waiting: count(facts) }}
      expiryDays={settings.expiry_alert_days}
      consumptionOn={!!settings.consumption_enabled_at}
      canManageSettings={perms.includes('inventory.master.manage')}
      canNewPo={perms.includes('inventory.po.manage')}
      canReceive={perms.includes('inventory.stock.manage')}
      rows={rows}
      checklist={steps}
    />
  );
}
