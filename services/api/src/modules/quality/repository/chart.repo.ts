// C9 T-14 repository for the Levey-Jennings chart #35 (02-TRD §7.10, §5.5; 05-SCHEMA indexes qc_observations__tenant_plan_observed__idx / qc_targets__tenant_plan_lot_from__idx).
// SELECT only, on the caller's tx; never opens a transaction, never locks. Every statement is parameterised and names tenant_id = $n on top of RLS (REQ-SEC-024).
// quality.* only; no SELECT *, no internal / personal columns (REQ-SEC-081). Timestamps leave as ISO text with ms, numerics as decimal text. One statement per method.
import { ts, type Tx } from './run.repo.js';

export interface ChartPlan { plan_id: string; instrument_id: string; analyte_id: string; test_id: string }
export interface ChartObservation { id: string; level_id: string; level_code: string; lot_id: string; lot_no: string; observed_at: string; value: string; z: string | null; status: string; qc_run_id: string | null }
export interface ChartRun { id: string; status: string; outcome: string | null; rule_detail: Array<{ rule: string; observation_ids: string[] }> }
export interface ChartTarget { id: string; level_id: string; lot_id: string; mean: string; sd: string; source: 'manufacturer' | 'established'; effective_from: string; effective_to: string | null }

export interface ChartRepo {
  findPlan(tx: Tx, tenantId: string, planId: string): Promise<ChartPlan | undefined>;
  /** Newest first (observed_at DESC, id DESC), at most `limit` rows; both ends of the period inclusive. */
  listChartObservations(tx: Tx, tenantId: string, q: { planId: string; levelId?: string; lotId?: string; from: string; to: string; limit: number }): Promise<ChartObservation[]>;
  listRunsForChart(tx: Tx, tenantId: string, runIds: string[]): Promise<ChartRun[]>;
  /** Targets of the plan that were ever in force (active|superseded|retired) and overlap [from, to]. */
  listTargetsForChart(tx: Tx, tenantId: string, q: { planId: string; lotIds: string[]; from: string; to: string }): Promise<ChartTarget[]>;
}

export function createChartRepo(): ChartRepo {
  return {
    async findPlan(tx, tenantId, planId) {
      const { rows } = await tx.query('SELECT id AS plan_id, instrument_id, analyte_id, test_id FROM quality.qc_plans WHERE tenant_id = $1 AND id = $2', [tenantId, planId]);
      return rows[0];
    },

    async listChartObservations(tx, tenantId, q) {
      const values: unknown[] = [tenantId, q.planId, q.from, q.to];
      const bind = (v: unknown) => `$${values.push(v)}`;
      const level = q.levelId === undefined ? '' : ` AND o.level_id = ${bind(q.levelId)}`;
      const lot = q.lotId === undefined ? '' : ` AND o.lot_id = ${bind(q.lotId)}`;
      const { rows } = await tx.query(
        `SELECT o.id, o.level_id, l.level_code, o.lot_id, t.lot_no, ${ts('o.observed_at', 'observed_at')}, o.value::text AS value, o.z::text AS z, o.status, o.qc_run_id
           FROM quality.qc_observations o
           JOIN quality.control_levels l ON l.tenant_id = o.tenant_id AND l.id = o.level_id
           JOIN quality.control_lots t ON t.tenant_id = o.tenant_id AND t.id = o.lot_id
          WHERE o.tenant_id = $1 AND o.plan_id = $2 AND o.observed_at >= $3::timestamptz AND o.observed_at <= $4::timestamptz
            AND o.level_id IS NOT NULL AND o.lot_id IS NOT NULL AND o.value IS NOT NULL${level}${lot}
          ORDER BY o.observed_at DESC, o.id DESC LIMIT ${bind(q.limit)}`, values);
      return rows;
    },

    async listRunsForChart(tx, tenantId, runIds) {
      if (!runIds.length) return [];
      const { rows } = await tx.query('SELECT id, status, outcome, rule_detail FROM quality.qc_runs WHERE tenant_id = $1 AND id = ANY($2::uuid[])', [tenantId, runIds]);
      return rows;
    },

    async listTargetsForChart(tx, tenantId, q) {
      if (!q.lotIds.length) return [];
      const { rows } = await tx.query(
        `SELECT id, level_id, lot_id, mean::text AS mean, sd::text AS sd, source, ${ts('effective_from', 'effective_from')}, ${ts('effective_to', 'effective_to')}
           FROM quality.qc_targets
          WHERE tenant_id = $1 AND plan_id = $2 AND lot_id = ANY($3::uuid[]) AND status IN ('active', 'superseded', 'retired')
            AND effective_from <= $5::timestamptz AND (effective_to IS NULL OR effective_to > $4::timestamptz)
          ORDER BY effective_from, id`, [tenantId, q.planId, q.lotIds, q.from, q.to]);
      return rows;
    },
  };
}
