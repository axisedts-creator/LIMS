// C9 T-10 repository for QC runs (05-SCHEMA qc_runs / qc_observations / qc_activity / qc_corrective_actions; 02-TRD §7.3, §7.7, §14). Schema `quality` only, never lab.*.
// Every statement is parameterised and names tenant_id = $n on top of RLS (REQ-SEC-024). Timestamps leave as ISO text with milliseconds, numerics as decimal text. Postgres errors pass through unchanged.
// [CONV] the pair lock is a row lock on quality.qc_plans (FOR UPDATE), the same row T-09 locks by (instrument, analyte): one lock object per pair.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../core/errors.js';

export type Row = Record<string, any>;
export interface Tx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }

export interface PlanParams {
  plan_id: string; instrument_id: string; analyte_id: string; version_no: number; controls_per_run: 2 | 3 | 4;
  composition: Array<{ level_id: string; count: number }>; mean_rule: string; two_two_s_across_runs: boolean; count_rules_across_materials: boolean;
  exclude_rejected_runs_from_history: boolean; run_window_minutes: number; hold_lookback_hours: number;
}

export interface RunRepo {
  lockPlan(tx: Tx, tenantId: string, planId: string): Promise<PlanParams | undefined>;
  findCollectingRun(tx: Tx, tenantId: string, planId: string): Promise<Row | undefined>;
  findLatestEarlyRejectedRun(tx: Tx, tenantId: string, planId: string): Promise<Row | undefined>;
  listCollectingRuns(tx: Tx, tenantId: string): Promise<Array<Row & { run_window_minutes: number }>>;
  insertRun(tx: Tx, tenantId: string, row: Row): Promise<void>;
  updateRun(tx: Tx, tenantId: string, runId: string, patch: Row): Promise<Row>;
  listRunMembers(tx: Tx, tenantId: string, runId: string): Promise<Row[]>;
  listHistory(tx: Tx, tenantId: string, planId: string, o: { excludeRunId: string; excludeRejectedRuns: boolean; limit: number }): Promise<Row[]>;
  latestInControlRunAt(tx: Tx, tenantId: string, planId: string, beforeRunAt: string): Promise<string | undefined>;
  resetQcActivity(tx: Tx, tenantId: string, planId: string, runAt: string): Promise<void>;
  oldestRejectedWithoutActionAt(tx: Tx, tenantId: string): Promise<string | undefined>;
}

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
export const ts = (expr: string, as: string) => `to_char(${expr} AT TIME ZONE 'UTC', ${ISO}) AS ${as}`;

const TS_COLS = ['run_at', 'last_member_received_at', 'last_assembled_at', 'evaluated_at', 'last_in_control_run_at', 'hold_since', 'closed_at', 'created_at', 'updated_at'];
const PLAIN_COLS = ['id', 'tenant_id', 'plan_id', 'plan_version_no', 'instrument_id', 'analyte_id', 'controls_per_run', 'rule_mode', 'mean_rule', 'observation_count', 'status', 'outcome', 'is_complete',
  'rules_violated', 'warning_rules', 'rule_detail', 'evaluated_by', 'rejection_event_id', 'closed_by', 'version', 'created_by', 'updated_by'];
export const runCols = (p = '') => [...PLAIN_COLS.map((c) => `${p}${c}`), ...TS_COLS.map((c) => ts(`${p}${c}`, c))].join(', ');

/** column -> bind cast. The allowlist for insert and update is this map (tenant_id, id, created_*, plan_id, version are never patched). */
const TYPE: Record<string, string> = {
  id: 'uuid', tenant_id: 'uuid', plan_id: 'uuid', plan_version_no: 'integer', instrument_id: 'uuid', analyte_id: 'uuid', controls_per_run: 'integer', rule_mode: 'text', mean_rule: 'text',
  run_at: 'timestamptz', last_member_received_at: 'timestamptz', last_assembled_at: 'timestamptz', observation_count: 'integer', status: 'text', outcome: 'text', is_complete: 'boolean',
  rules_violated: 'text[]', warning_rules: 'text[]', rule_detail: 'jsonb', evaluated_at: 'timestamptz', evaluated_by: 'uuid', last_in_control_run_at: 'timestamptz', hold_since: 'timestamptz',
  rejection_event_id: 'uuid', closed_at: 'timestamptz', closed_by: 'uuid', version: 'integer', created_at: 'timestamptz', created_by: 'uuid', updated_at: 'timestamptz', updated_by: 'uuid',
};
const PATCHABLE = new Set(['status', 'outcome', 'is_complete', 'rules_violated', 'warning_rules', 'rule_detail', 'evaluated_at', 'evaluated_by', 'last_in_control_run_at', 'hold_since', 'rejection_event_id',
  'observation_count', 'last_member_received_at', 'last_assembled_at', 'updated_by',
  'closed_at', 'closed_by']);   // T-12: QR7 close sets status + closed_at/closed_by only; the frozen columns stay out of reach (quality.enforce_run_frozen)
const CLOSE_COLS = new Set(['status', 'closed_at', 'closed_by', 'updated_by']);
const bind = (col: string, v: unknown): unknown => (v === undefined ? null : v === null ? null : col === 'rule_detail' ? JSON.stringify(v) : v);

const MEMBER_COLS = `o.id, o.level_id, o.value::text AS value, o.mean::text AS mean, o.sd::text AS sd, ${ts('o.observed_at', 'observed_at')}, ${ts('o.received_at', 'received_at')}`;

export function createRunRepo(): RunRepo {
  return {
    async lockPlan(tx, tenantId, planId) {
      const { rows } = await tx.query(
        `SELECT p.id AS plan_id, p.instrument_id, p.analyte_id, p.current_version_no AS version_no, v.controls_per_run, v.composition, v.mean_rule, v.two_two_s_across_runs,
                v.count_rules_across_materials, v.exclude_rejected_runs_from_history, v.run_window_minutes, v.hold_lookback_hours
           FROM quality.qc_plans p JOIN quality.qc_plan_versions v ON v.tenant_id = p.tenant_id AND v.plan_id = p.id AND v.version_no = p.current_version_no
          WHERE p.tenant_id = $1 AND p.id = $2 FOR UPDATE OF p`, [tenantId, planId]);
      return rows[0];
    },
    async findCollectingRun(tx, tenantId, planId) {
      const { rows } = await tx.query(`SELECT ${runCols('r.')} FROM quality.qc_runs r WHERE r.tenant_id = $1 AND r.plan_id = $2 AND r.status = 'collecting'`, [tenantId, planId]);
      return rows[0];
    },
    async findLatestEarlyRejectedRun(tx, tenantId, planId) {
      const { rows } = await tx.query(
        `SELECT ${runCols('r.')} FROM quality.qc_runs r WHERE r.tenant_id = $1 AND r.plan_id = $2 AND r.status = 'evaluated' AND r.outcome = 'rejected' AND r.is_complete = false
          ORDER BY r.run_at DESC LIMIT 1`, [tenantId, planId]);
      return rows[0];
    },
    async listCollectingRuns(tx, tenantId) {
      return (await tx.query(
        `SELECT ${runCols('r.')}, v.run_window_minutes FROM quality.qc_runs r
           JOIN quality.qc_plans p ON p.tenant_id = r.tenant_id AND p.id = r.plan_id
           JOIN quality.qc_plan_versions v ON v.tenant_id = p.tenant_id AND v.plan_id = p.id AND v.version_no = p.current_version_no
          WHERE r.tenant_id = $1 AND r.status = 'collecting'`, [tenantId])).rows;
    },
    async insertRun(tx, tenantId, row) {
      if (row['tenant_id'] !== tenantId) throw new LimsError('common.internal');
      const cols = ['tenant_id', ...Object.keys(row).filter((c) => c !== 'tenant_id' && row[c] !== undefined)];
      if (cols.some((c) => !(c in TYPE)) || !cols.includes('plan_id')) throw new LimsError('common.internal');
      const values = cols.map((c) => (c === 'tenant_id' ? tenantId : bind(c, row[c])));
      const sel = cols.map((c, i) => `$${i + 1}::${TYPE[c]}`).join(', ');
      // SELECT ... FROM qc_plans keeps the tenant predicate on the insert and yields no row when the plan is not visible.
      const { rows } = await tx.query(
        `INSERT INTO quality.qc_runs (${cols.join(', ')}) SELECT ${sel} FROM quality.qc_plans p WHERE p.tenant_id = $1 AND p.id = $${cols.indexOf('plan_id') + 1} RETURNING id`, values);
      if (rows.length === 0) throw new LimsError('common.internal');
    },
    async updateRun(tx, tenantId, runId, patch) {
      const cols = Object.keys(patch).filter((c) => patch[c] !== undefined);
      if (cols.length === 0 || cols.some((c) => !PATCHABLE.has(c))) throw new LimsError('common.internal');
      if (patch['status'] === 'closed' && cols.some((c) => !CLOSE_COLS.has(c))) throw new LimsError('common.internal');   // QR7 never rewrites outcome / rules / hold (S-09)
      const set = cols.map((c, i) => `${c} = $${i + 1}::${TYPE[c]}`).join(', ');
      const n = cols.length;
      const { rows } = await tx.query(
        `UPDATE quality.qc_runs SET ${set}, version = version + 1, updated_at = now() WHERE tenant_id = $${n + 1} AND id = $${n + 2} RETURNING ${runCols()}`,
        [...cols.map((c) => bind(c, patch[c])), tenantId, runId]);
      if (rows.length === 0) throw new LimsError('common.not_found');
      return rows[0];
    },
    async listRunMembers(tx, tenantId, runId) {
      return (await tx.query(
        `SELECT ${MEMBER_COLS} FROM quality.qc_observations o WHERE o.tenant_id = $1 AND o.qc_run_id = $2 AND o.status = 'assigned' ORDER BY o.observed_at, o.id`, [tenantId, runId])).rows;
    },
    async listHistory(tx, tenantId, planId, q) {
      const notRejected = q.excludeRejectedRuns
        ? ` AND NOT EXISTS (SELECT 1 FROM quality.qc_runs r WHERE r.tenant_id = o.tenant_id AND r.id = o.qc_run_id AND r.outcome = 'rejected')` : '';
      return (await tx.query(
        `SELECT h.id, h.level_id, h.value, h.mean, h.sd, h.observed_at, h.received_at FROM (
           SELECT ${MEMBER_COLS}, o.observed_at AS ord_at FROM quality.qc_observations o
            WHERE o.tenant_id = $1 AND o.plan_id = $2 AND o.status = 'assigned' AND o.qc_run_id IS DISTINCT FROM $3${notRejected}
            ORDER BY o.observed_at DESC, o.id DESC LIMIT $4) h
          ORDER BY h.ord_at, h.id`, [tenantId, planId, q.excludeRunId, q.limit])).rows;
    },
    async latestInControlRunAt(tx, tenantId, planId, beforeRunAt) {
      const { rows } = await tx.query(
        `SELECT ${ts('r.run_at', 'run_at')} FROM quality.qc_runs r WHERE r.tenant_id = $1 AND r.plan_id = $2 AND r.outcome IN ('accepted', 'accepted_warning') AND r.run_at < $3::timestamptz
          ORDER BY r.run_at DESC LIMIT 1`, [tenantId, planId, beforeRunAt]);
      return rows[0]?.run_at ?? undefined;
    },
    async resetQcActivity(tx, tenantId, planId, runAt) {
      await tx.query(
        `INSERT INTO quality.qc_activity (id, tenant_id, plan_id, last_qc_run_at, patient_results_since_last_qc) VALUES ($1, $2, $3, $4::timestamptz, 0)
         ON CONFLICT (tenant_id, plan_id) DO UPDATE SET last_qc_run_at = EXCLUDED.last_qc_run_at, patient_results_since_last_qc = 0, updated_at = now()
         WHERE quality.qc_activity.tenant_id = $2`, [uuidv7(), tenantId, planId, runAt]);
    },
    async oldestRejectedWithoutActionAt(tx, tenantId) {
      const { rows } = await tx.query(
        `SELECT ${ts('min(r.evaluated_at)', 'evaluated_at')} FROM quality.qc_runs r WHERE r.tenant_id = $1 AND r.status = 'evaluated' AND r.outcome = 'rejected'
            AND NOT EXISTS (SELECT 1 FROM quality.qc_corrective_actions c WHERE c.tenant_id = r.tenant_id AND c.qc_run_id = r.id)`, [tenantId]);
      return rows[0]?.evaluated_at ?? undefined;
    },
  };
}
