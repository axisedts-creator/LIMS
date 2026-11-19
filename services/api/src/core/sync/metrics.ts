// T0B-SYNC-5 (LD-322, done_when 4): snapshot gauges of the offline sync ledger, set by the worker task core.sync_metrics (one tenant per call,
// on the caller's tx under RLS). The accepted / duplicate / rejected / conflict counts stay lims_core_sync_operations_total{status} (T0B-SYNC-2).
// Read only; every statement names tenant_id (RLS is the second wall).
import type { Tx } from './repository.js';

export interface GaugeSink { set(name: string, value: number, labels?: Readonly<Record<string, string | number>>): void }

const COUNTS_SQL = `SELECT
  (SELECT count(*)::int FROM core.sync_conflict WHERE tenant_id = $1 AND status = 'open') AS conflicts_open,
  (SELECT count(*)::int FROM core.sync_print_marker WHERE tenant_id = $1 AND state = 'recall_required') AS recalls`;
// backlog: a device seen after its last sync (or since first contact when never synced) has unsent work since then; never negative
const BACKLOG_SQL = `SELECT id::text AS device_id,
  CASE WHEN last_seen_at > COALESCE(last_sync_at, first_seen_at)
       THEN GREATEST(0, floor(extract(epoch FROM ($2::timestamptz - COALESCE(last_sync_at, first_seen_at)))))::bigint ELSE 0 END AS age
  FROM core.sync_device WHERE tenant_id = $1 AND status = 'active'`;

export async function refreshSyncGauges(tx: Tx, metrics: GaugeSink, o: { tenantId: string; now: string | Date }): Promise<void> {
  const now = new Date(o.now);
  if (Number.isNaN(now.getTime())) throw new Error('refreshSyncGauges: invalid now');
  const labels = { tenant_id: o.tenantId };
  const c = (await tx.query(COUNTS_SQL, [o.tenantId])).rows[0] ?? {};
  metrics.set('lims_core_sync_conflicts_open', Number(c.conflicts_open ?? 0), labels);
  metrics.set('lims_core_sync_print_recalls', Number(c.recalls ?? 0), labels);
  for (const r of (await tx.query(BACKLOG_SQL, [o.tenantId, now.toISOString()])).rows) {
    metrics.set('lims_core_sync_device_backlog_age_seconds', Number(r.age), { tenant_id: o.tenantId, device_id: String(r.device_id) });
  }
}
