// Task micro.refresh_metrics (02-TRD §9, §11; 08 A13 P-6). per_tenant cron, pure read: sets the per-tenant gauges (the next run supersedes, no retry).
// Gauges are zero-filled over their whole label domain so an emptied status reads 0. Labels: tenant_id + status / match_status only (never a culture, centre or user id).
import { LimsError } from '../../../../../api/src/core/errors.js';
import type { TaskHandler } from '../../../core/manifest.js';

const CULTURE_STATUSES = ['awaiting_setup', 'incubating', 'growth_detected', 'final_submitted', 'amending', 'cancelled'] as const;
const OPEN_RECORD_STATUSES = ['pending_match', 'needs_mapping', 'conflict', 'late_after_final'] as const;

const BY_STATUS = 'SELECT status, count(*)::int AS n FROM micro.cultures WHERE tenant_id = $1 GROUP BY status';
const OVERDUE = "SELECT count(*)::int AS n FROM micro.cultures WHERE tenant_id = $1 AND status IN ('incubating', 'growth_detected') AND next_read_due_at < now()";
const OPEN_RECORDS = "SELECT match_status, count(*)::int AS n FROM micro.instrument_records WHERE tenant_id = $1 AND match_status IN ('pending_match', 'needs_mapping', 'conflict', 'late_after_final') GROUP BY match_status";

export const refreshMetrics: TaskHandler = async (payload, ctx) => {
  const tenantId = ctx.tenantId;
  if (!tenantId || (payload?.tenant_id !== undefined && payload.tenant_id !== tenantId)) throw new LimsError('common.internal', 'micro refresh_metrics: tenant mismatch');
  const q = (text: string) => ctx.tx.query(text, [tenantId]) as Promise<{ rows: Array<Record<string, any>> }>;
  const [byStatus, overdue, open] = [await q(BY_STATUS), await q(OVERDUE), await q(OPEN_RECORDS)];
  const metrics = (ctx as any).metrics;
  const counts = (rows: Array<Record<string, any>>, key: string) => new Map(rows.map((r) => [String(r[key]), Number(r['n'])]));
  const cultures = counts(byStatus.rows, 'status'), records = counts(open.rows, 'match_status');
  for (const status of CULTURE_STATUSES) metrics.set('lims_micro_cultures_by_status', cultures.get(status) ?? 0, { tenant_id: tenantId, status });
  metrics.set('lims_micro_reads_overdue', Number(overdue.rows[0]?.['n'] ?? 0), { tenant_id: tenantId });
  for (const match_status of OPEN_RECORD_STATUSES) metrics.set('lims_micro_instrument_records_open', records.get(match_status) ?? 0, { tenant_id: tenantId, match_status });
};
