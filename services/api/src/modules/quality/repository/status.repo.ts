// C9 T-13 repository for qcStatusFor + the status board #34 (02-TRD §7.8 query note, §5.5 #34, §10.2). SELECT only, on the caller's tx; never opens a transaction, never locks.
// Every statement is parameterised and names tenant_id = $n on top of RLS (REQ-SEC-024). quality.* only, plus instruments.v_pub_instrument_directory for labels (CR-C9-006).
// No analyte code in SQL: catalog.analytes is C3's base table; the service reads the code through CatalogPort.getTest (T-13 ruling).
// Timestamps leave as ISO text with milliseconds. Postgres errors pass through unchanged (the service maps them).
import { ts, type Tx } from './run.repo.js';

export interface StatusRun { plan_id: string; id: string; status: string; outcome: string | null; run_at: string; closed_at: string | null; rules_violated: string[] }
export interface BoardPlan { plan_id: string; instrument_id: string; analyte_id: string; test_id: string; qc_validity_hours: number }
export interface Activity { plan_id: string; last_patient_result_at: string | null; patient_results_since_last_qc: number; last_qc_run_at: string | null }
export interface InstrumentLabel { instrument_id: string; instrument_code: string; display_name: string }

export interface StatusRepo {
  findPlanForPair(tx: Tx, tenantId: string, instrumentId: string, analyteId: string): Promise<{ plan_id: string; qc_validity_hours: number } | undefined>;
  listRunsForStatus(tx: Tx, tenantId: string, planIds: string[], at: string): Promise<StatusRun[]>;
  listBoardPlans(tx: Tx, tenantId: string): Promise<BoardPlan[]>;
  listActivity(tx: Tx, tenantId: string, planIds: string[]): Promise<Activity[]>;
  listInstrumentLabels(tx: Tx, tenantId: string, instrumentIds: string[]): Promise<InstrumentLabel[]>;
}

const RUN_WINDOW = 20;   // §7.8 query note: the latest 20 evaluated|closed runs per plan
const CURRENT_VERSION = 'JOIN quality.qc_plan_versions v ON v.tenant_id = p.tenant_id AND v.plan_id = p.id AND v.version_no = p.current_version_no';

export function createStatusRepo(): StatusRepo {
  return {
    /** Step 1: the plan of the pair in ANY status, with the validity of its current version. */
    async findPlanForPair(tx, tenantId, instrumentId, analyteId) {
      const { rows } = await tx.query(
        `SELECT p.id AS plan_id, v.qc_validity_hours FROM quality.qc_plans p ${CURRENT_VERSION}
          WHERE p.tenant_id = $1 AND p.instrument_id = $2 AND p.analyte_id = $3 LIMIT 1`, [tenantId, instrumentId, analyteId]);
      const r = rows[0];
      return r ? { plan_id: r.plan_id, qc_validity_hours: Number(r.qc_validity_hours) } : undefined;
    },

    /** Steps 2-3: per plan the latest 20 evaluated|closed runs with run_at <= at, plus every run still open-rejected at `at` however old. */
    // ponytail: row_number() over every run <= at of the plan; switch to a LATERAL ... LIMIT 20 per plan if the window scan shows up on real volumes.
    async listRunsForStatus(tx, tenantId, planIds, at) {
      if (!planIds.length) return [];
      const { rows } = await tx.query(
        `WITH w AS (
           SELECT r.plan_id, r.id, r.status, r.outcome, r.run_at, r.closed_at, r.rules_violated,
                  row_number() OVER (PARTITION BY r.plan_id ORDER BY r.run_at DESC, r.id DESC) AS rn
             FROM quality.qc_runs r
            WHERE r.tenant_id = $1 AND r.plan_id = ANY($2::uuid[]) AND r.status IN ('evaluated', 'closed') AND r.run_at <= $3::timestamptz)
         SELECT w.plan_id, w.id, w.status, w.outcome, ${ts('w.run_at', 'run_at')}, ${ts('w.closed_at', 'closed_at')}, w.rules_violated::text[] AS rules_violated
           FROM w
          WHERE w.rn <= ${RUN_WINDOW} OR (w.outcome = 'rejected' AND (w.closed_at IS NULL OR w.closed_at > $3::timestamptz))
          ORDER BY w.plan_id, w.run_at DESC`, [tenantId, planIds, at]);
      return rows;
    },

    async listBoardPlans(tx, tenantId) {
      const { rows } = await tx.query(
        `SELECT p.id AS plan_id, p.instrument_id, p.analyte_id, p.test_id, v.qc_validity_hours FROM quality.qc_plans p ${CURRENT_VERSION}
          WHERE p.tenant_id = $1 AND p.status = 'active' ORDER BY p.instrument_id, p.analyte_id, p.id`, [tenantId]);
      return rows.map((r) => ({ ...r, qc_validity_hours: Number(r.qc_validity_hours) }));
    },

    async listActivity(tx, tenantId, planIds) {
      if (!planIds.length) return [];
      const { rows } = await tx.query(
        `SELECT plan_id, ${ts('last_patient_result_at', 'last_patient_result_at')}, patient_results_since_last_qc, ${ts('last_qc_run_at', 'last_qc_run_at')}
           FROM quality.qc_activity WHERE tenant_id = $1 AND plan_id = ANY($2::uuid[])`, [tenantId, planIds]);
      return rows.map((r) => ({ ...r, patient_results_since_last_qc: Number(r.patient_results_since_last_qc) }));
    },

    /** Labels only (08 R25): the invoker view, so C7's RLS applies. */
    async listInstrumentLabels(tx, tenantId, instrumentIds) {
      if (!instrumentIds.length) return [];
      return (await tx.query('SELECT instrument_id, instrument_code, display_name FROM instruments.v_pub_instrument_directory WHERE tenant_id = $1 AND instrument_id = ANY($2::uuid[])',
        [tenantId, instrumentIds])).rows;
    },
  };
}
