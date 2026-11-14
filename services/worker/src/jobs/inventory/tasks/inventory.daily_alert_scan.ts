// inventory.daily_alert_scan (02-TRD §9; PRD AC-20.3; 08 A13 P-6 per_tenant): raises expiry_soon / expired_on_hand per (store, lot) with qty > 0, open_stability_exceeded per open container
// past open_expiry_at, re-evaluates below_reorder, and auto-resolves open alerts of those kinds whose condition is gone (resolved_at = now, expires_at = resolved_at + 365 d).
// One open alert per dedupe_key (a repeat raise = occurrences + 1). Writes alerts only: no balance, movement or fact row.
// dedupe keys [CONV]: expiry_soon / expired_on_hand `<kind>:<store>:<item>:<lot>`, open_stability_exceeded `open_stability_exceeded:<container>`, below_reorder `below_reorder:<store>:<item>` (as alerts.service).
import type { TaskHandler } from '../../../core/manifest.js';
import { addDaysYmd, ymdIn } from '../../../../../api/src/modules/inventory/domain/tenantTime.js';
import { type Row, query } from '../../../../../api/src/modules/inventory/repository/_base.js';
import { getSettings } from '../../../../../api/src/modules/inventory/repository/settings.repo.js';
import { type AlertRow, jobScope, raiseAlerts, resolveGone, tenantClock } from './_shared.js';

export const DAILY_ALERT_SCAN = 'inventory.daily_alert_scan';
const DEFAULT_EXPIRY_ALERT_DAYS = 30;

// lots with stock whose expiry_on lies in [$2, $3] (a null bound is open)
const LOTS_WITH_STOCK = `SELECT b.store_id, b.item_id, b.lot_id FROM inventory.stock_balances b JOIN inventory.lots l ON l.tenant_id = b.tenant_id AND l.id = b.lot_id
   WHERE b.tenant_id = $1 AND b.qty_base > 0 AND l.expiry_on IS NOT NULL AND ($2::date IS NULL OR l.expiry_on >= $2::date) AND ($3::date IS NULL OR l.expiry_on <= $3::date)
   ORDER BY b.store_id, b.item_id, b.lot_id`;
const OPEN_PAST_STABILITY = `SELECT c.id, c.store_id, c.item_id, c.lot_id FROM inventory.opened_containers c
   WHERE c.tenant_id = $1 AND c.status = 'open' AND c.open_expiry_at IS NOT NULL AND c.open_expiry_at < now() ORDER BY c.id`;
const BELOW_REORDER = `SELECT s.store_id, s.item_id FROM inventory.store_item_settings s
   WHERE s.tenant_id = $1 AND s.is_active AND s.reorder_level_base IS NOT NULL
     AND (SELECT coalesce(sum(b.qty_base), 0) FROM inventory.stock_balances b WHERE b.tenant_id = $1 AND b.store_id = s.store_id AND b.item_id = s.item_id) < s.reorder_level_base
   ORDER BY s.store_id, s.item_id`;

const lotAlert = (kind: string) => (r: Row): AlertRow => ({ store_id: r['store_id'], item_id: r['item_id'], lot_id: r['lot_id'], key: `${kind}:${r['store_id']}:${r['item_id']}:${r['lot_id']}` });

export const dailyAlertScan: TaskHandler = async (payload, jobCtx) => {
  const rc = jobScope('daily_alert_scan', payload, jobCtx);
  if (rc === null) return;
  const clock = await tenantClock(jobCtx);
  const today = ymdIn(clock.nowMs, clock.tz);
  const days = Number((await getSettings(rc))?.['expiry_alert_days'] ?? DEFAULT_EXPIRY_ALERT_DAYS);
  const sets: { kind: string; rows: AlertRow[] }[] = [
    { kind: 'expiry_soon', rows: (await query(rc, LOTS_WITH_STOCK, [today, addDaysYmd(today, days)])).map(lotAlert('expiry_soon')) },
    { kind: 'expired_on_hand', rows: (await query(rc, LOTS_WITH_STOCK, [null, addDaysYmd(today, -1)])).map(lotAlert('expired_on_hand')) },
    { kind: 'open_stability_exceeded', rows: (await query(rc, OPEN_PAST_STABILITY)).map((r) => ({ store_id: r['store_id'], item_id: r['item_id'], lot_id: r['lot_id'], key: `open_stability_exceeded:${r['id']}`, details: { container_id: r['id'] } })) },
    { kind: 'below_reorder', rows: (await query(rc, BELOW_REORDER)).map((r) => ({ store_id: r['store_id'], item_id: r['item_id'], key: `below_reorder:${r['store_id']}:${r['item_id']}` })) },
  ];
  for (const s of sets) {
    await raiseAlerts(rc, s.kind, s.rows);
    await resolveGone(rc, s.kind, s.rows.map((r) => r.key));
  }
};
