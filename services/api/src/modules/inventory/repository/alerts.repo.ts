// inventory.alerts (05 §2.27, class E). Explicit tenant filter on every statement. No DELETE here: expired alerts go through app.purge_inventory_alerts() only (08 A17 D-72).
import { type Row, type RepoCtx, Q, first, getRow, insertRow, limitOf, query, table, updateRow } from './_base.js';

const ALERTS = table('alerts', 'C', ['alert_kind', 'store_id', 'item_id', 'lot_id', 'instrument_id', 'test_id', 'dedupe_key', 'status', 'first_raised_at', 'last_raised_at',
  'occurrences', 'details', 'acknowledged_at', 'acknowledged_by', 'resolved_at', 'expires_at'], { json: ['details'] });

export const insertAlert = (rc: RepoCtx, row: Row) => insertRow(rc, ALERTS, row);
export const getAlert = (rc: RepoCtx, id: string) => getRow(rc, ALERTS, id);
/** The one unresolved alert for a key (partial unique index alerts__tenant_id_dedupe__p_uq); acknowledged still counts. */
export const findOpenAlertByDedupeKey = (rc: RepoCtx, key: string) =>
  first(rc, "SELECT * FROM inventory.alerts WHERE tenant_id = $1 AND dedupe_key = $2 AND status <> 'resolved'", [key]);
/** Newest raised first (index alerts__tenant_id_status_kind__idx). */
export function listAlerts(rc: RepoCtx, f: { status?: string; alertKind?: string; limit?: number } = {}): Promise<Row[]> {
  const q = new Q();
  let w = '';
  if (f.status !== undefined) w += ` AND status = ${q.p(f.status)}`;
  if (f.alertKind !== undefined) w += ` AND alert_kind = ${q.p(f.alertKind)}`;
  return query(rc, `SELECT * FROM inventory.alerts WHERE tenant_id = $1${w} ORDER BY last_raised_at DESC, id LIMIT ${q.p(limitOf(f.limit))}`, q.vals);
}
export const updateAlert = (rc: RepoCtx, id: string, expectedVersion: number, patch: Row) => updateRow(rc, ALERTS, id, expectedVersion, patch);
