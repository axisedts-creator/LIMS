// T0B-SYNC-5 (LD-322, done_when 3): retention of the offline sync ledger, run by the per tenant worker task core.sync_retention as lims_worker
// with system claims of the tenant. Every batch is its OWN db.tx call (own commit) and takes row locks only (SELECT ... FOR UPDATE SKIP LOCKED,
// then DELETE by key), so a push of the same tenant never waits on it and two runs never remove a row twice.
// Removed: resolved conflicts with resolved_at older than the retention; operations with server_received_at older than the retention that have
// no conflict row left and no print marker in state pending or recall_required, together with their sign off outcomes, alerts and confirmed marker.
// Never removed: open conflicts (and their operation), pending / recall_required markers (and their operation), the row audit log of the tenant.
import type { Tx } from './repository.js';

export const DEFAULT_SYNC_RETENTION_DAYS = 180;
const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_MAX_BATCHES = 200;
const DAY_MS = 86_400_000;

export interface PurgeDb { tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> }
export interface PurgeOptions {
  tenantId: string; now: string | Date; retentionDays?: number; batchSize?: number; maxBatches?: number;
  metrics?: { inc(name: string, labels?: Readonly<Record<string, string | number>>, by?: number): void };
}
export interface PurgeResult { conflicts: number; operations: number; batches: number; capped: boolean }

const CONFLICT_BATCH = `WITH c AS (
    SELECT id FROM core.sync_conflict WHERE tenant_id = $1 AND status = 'resolved' AND resolved_at < $2
    ORDER BY resolved_at LIMIT $3 FOR UPDATE SKIP LOCKED)
  DELETE FROM core.sync_conflict t USING c WHERE t.tenant_id = $1 AND t.id = c.id RETURNING t.id`;

const OP_CANDIDATES = `SELECT o.op_id FROM core.sync_operation o
  WHERE o.tenant_id = $1 AND o.server_received_at < $2 AND o.status IN ('accepted','duplicate','rejected','conflict')
    AND NOT EXISTS (SELECT 1 FROM core.sync_conflict c WHERE c.tenant_id = o.tenant_id AND c.op_id = o.op_id)
    AND NOT EXISTS (SELECT 1 FROM core.sync_print_marker m WHERE m.tenant_id = o.tenant_id AND m.op_id = o.op_id AND m.state IN ('pending','recall_required'))
  ORDER BY o.server_received_at LIMIT $3 FOR UPDATE OF o SKIP LOCKED`;
// children first (foreign keys to core.sync_operation); a marker that moved to recall_required meanwhile keeps its operation: the delete of
// that operation then fails its foreign key, the batch rolls back alone and the next run skips it
const OP_DELETES = [
  `DELETE FROM core.sync_alert WHERE tenant_id = $1 AND op_id = ANY($2::uuid[])`,
  `DELETE FROM core.sync_signoff_outcome WHERE tenant_id = $1 AND op_id = ANY($2::uuid[])`,
  `DELETE FROM core.sync_print_marker WHERE tenant_id = $1 AND op_id = ANY($2::uuid[]) AND state = 'confirmed'`,
];
const OP_DELETE = `DELETE FROM core.sync_operation WHERE tenant_id = $1 AND op_id = ANY($2::uuid[]) RETURNING op_id`;

const positiveInt = (v: unknown, name: string): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) throw new Error(`purgeSyncLedger: ${name} must be a positive integer`);
  return v;
};

export async function purgeSyncLedger(db: PurgeDb, o: PurgeOptions): Promise<PurgeResult> {
  // fail closed: every option is checked before the first statement
  const days = positiveInt(o.retentionDays ?? DEFAULT_SYNC_RETENTION_DAYS, 'retentionDays');
  const batchSize = positiveInt(o.batchSize ?? DEFAULT_BATCH_SIZE, 'batchSize');
  const maxBatches = positiveInt(o.maxBatches ?? DEFAULT_MAX_BATCHES, 'maxBatches');
  if (typeof o.tenantId !== 'string' || !/^[0-9a-f-]{36}$/i.test(o.tenantId)) throw new Error('purgeSyncLedger: tenantId must be a uuid');
  const now = new Date(o.now);
  if (Number.isNaN(now.getTime())) throw new Error('purgeSyncLedger: invalid now');
  const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString();

  const out: PurgeResult = { conflicts: 0, operations: 0, batches: 0, capped: false };
  const phases: Array<{ table: 'sync_conflict' | 'sync_operation'; run: (tx: Tx) => Promise<number> }> = [
    { table: 'sync_conflict', run: async (tx) => (await tx.query(CONFLICT_BATCH, [o.tenantId, cutoff, batchSize])).rows.length },
    { table: 'sync_operation', run: async (tx) => {
      const ids = (await tx.query(OP_CANDIDATES, [o.tenantId, cutoff, batchSize])).rows.map((r) => String(r.op_id));
      if (ids.length === 0) return 0;
      for (const sql of OP_DELETES) await tx.query(sql, [o.tenantId, ids]);
      return (await tx.query(OP_DELETE, [o.tenantId, ids])).rows.length;
    } },
  ];
  for (const p of phases) {
    for (;;) {
      if (out.batches >= maxBatches) {                               // budget spent while the last batch was full: more is left for the next run
        out.capped = true;
        o.metrics?.inc('lims_core_retention_purge_capped_total', { table: p.table });
        return out;
      }
      const n = await db.tx(p.run);
      if (n === 0) break;
      out.batches += 1;
      if (p.table === 'sync_conflict') out.conflicts += n; else out.operations += n;
      o.metrics?.inc('lims_core_retention_purged_total', { table: p.table }, n);
      if (n < batchSize) break;
    }
  }
  return out;
}
