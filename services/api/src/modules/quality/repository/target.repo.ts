// C9 T-08 repo: quality.qc_targets (05-SCHEMA §2) + the reads establish/activate need (observation candidates, current composition, tenant settings).
// Every statement is parameterised, schema-qualified and carries `tenant_id = $1` explicitly on top of RLS (REQ-SEC-022/024/082).
// Values of a target are immutable (trigger qc_targets__mutable_columns, S-09): updateTarget can only SET the lifecycle columns; there is no DELETE.
// Postgres errors (23505 unique, P0001 immutable_row, 23514 CHECK) pass through unchanged for the service to map.
import { getSettings } from './settings.repo.js';
import { createPlanRepo, decode, encode } from './plan.repo.js';
import { createSetupRepo } from './setup.repo.js';
import type { Page, Row, SetupTx as Tx } from './setup.repo.js';

const TS = (c: string, a = '') => `to_char(${a}${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${c}`;   // microseconds: exact keyset + exact round trip
const COLS = ['id', 'tenant_id', 'plan_id', 'lot_id', 'level_id', 'mean', 'sd', 'unit_code', 'source', 'basis_n', TS('basis_from'), TS('basis_to'), 'basis_observation_ids_sha256',
  'note', 'status', TS('effective_from'), TS('effective_to'), TS('activated_at'), 'activated_by', TS('retired_at'), 'retired_by', 'retire_reason', 'is_active', 'version',
  TS('created_at'), 'created_by', TS('updated_at'), 'updated_by'].join(', ');
const INSERT = ['id', 'plan_id', 'lot_id', 'level_id', 'mean', 'sd', 'unit_code', 'source', 'basis_n', 'basis_from', 'basis_to', 'basis_observation_ids_sha256', 'note', 'status',
  'created_by', 'updated_by'] as const;
// = the allow-list of trigger qc_targets__mutable_columns (05-SCHEMA §4), minus updated_at/version which the repo sets itself.
const SETTABLE = ['status', 'effective_from', 'effective_to', 'activated_at', 'activated_by', 'retired_at', 'retired_by', 'retire_reason', 'updated_by'];

export function createTargetRepo() {
  const plans = createPlanRepo(), setup = createSetupRepo();
  return {
    async listTargets(tx: Tx, tenantId: string, q: { planId?: string; lotId?: string; statuses?: string[]; cursor?: string; limit: number }): Promise<Page> {
      const values: unknown[] = [tenantId], where = ['tenant_id = $1'];
      const bind = (v: unknown) => { values.push(v); return `$${values.length}`; };
      if (q.planId !== undefined) where.push(`plan_id = ${bind(q.planId)}::uuid`);
      if (q.lotId !== undefined) where.push(`lot_id = ${bind(q.lotId)}::uuid`);
      if (q.statuses !== undefined) where.push(`status = ANY(${bind(q.statuses)}::text[])`);
      if (q.cursor !== undefined) where.push(`id > ${bind(decode(q.cursor))}::uuid`);
      const { rows } = await tx.query(`SELECT ${COLS} FROM quality.qc_targets WHERE ${where.join(' AND ')} ORDER BY id LIMIT ${bind(q.limit + 1)}`, values);
      if (rows.length <= q.limit) return { rows };
      const kept = rows.slice(0, q.limit);
      return { rows: kept, nextCursor: encode(kept[kept.length - 1]!['id']) };
    },

    async findTarget(tx: Tx, tenantId: string, id: string): Promise<Row | undefined> {
      return (await tx.query(`SELECT ${COLS} FROM quality.qc_targets WHERE tenant_id = $1 AND id = $2`, [tenantId, id])).rows[0];
    },

    /** The one target of the key (plan x lot) in force (partial unique index qc_targets__tenant_plan_lot_active__p_uq). */
    async findActiveTarget(tx: Tx, tenantId: string, planId: string, lotId: string): Promise<Row | undefined> {
      return (await tx.query(`SELECT ${COLS} FROM quality.qc_targets WHERE tenant_id = $1 AND plan_id = $2 AND lot_id = $3 AND status = 'active'`, [tenantId, planId, lotId])).rows[0];
    },

    /** Only the INSERT columns of the row contract are read from `row`; tenant comes from the argument, is_active/version from the DDL defaults. */
    async insertTarget(tx: Tx, tenantId: string, row: Row): Promise<Row> {
      const { rows } = await tx.query(
        `INSERT INTO quality.qc_targets (tenant_id, ${INSERT.join(', ')}) VALUES ($1, ${INSERT.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING ${COLS}`,
        [tenantId, ...INSERT.map((c) => row[c] ?? null)]);
      return rows[0]!;
    },

    /** Optimistic lock in SQL: no row = stale version (or invisible row). Columns outside the trigger allow-list are never written, whatever the patch says. */
    async updateTarget(tx: Tx, tenantId: string, id: string, expectedVersion: number, patch: Row): Promise<Row | undefined> {
      const keys = SETTABLE.filter((k) => patch[k] !== undefined);
      const values: unknown[] = [tenantId, id, ...keys.map((k) => patch[k]), expectedVersion];
      const set = [...keys.map((k, i) => `${k} = $${i + 3}`), 'version = version + 1', 'updated_at = now()'];
      const { rows } = await tx.query(`UPDATE quality.qc_targets SET ${set.join(', ')} WHERE tenant_id = $1 AND id = $2 AND version = $${values.length} RETURNING ${COLS}`, values);
      return rows[0];
    },

    findPlan: plans.findPlan,
    listUserLabels: plans.listUserLabels,
    findLot: setup.findLot,
    getSettings: (tx: Tx, tenantId: string) => getSettings(tx, tenantId),

    /** Composition of the plan version whose version_no = plan.current_version_no; undefined for an unknown plan. */
    async currentComposition(tx: Tx, tenantId: string, planId: string): Promise<Array<{ level_id: string; count: number }> | undefined> {
      const { rows } = await tx.query(
        `SELECT v.composition FROM quality.qc_plan_versions v JOIN quality.qc_plans p ON p.tenant_id = v.tenant_id AND p.id = v.plan_id AND p.current_version_no = v.version_no
         WHERE v.tenant_id = $1 AND p.tenant_id = $1 AND v.plan_id = $2`, [tenantId, planId]);
      return rows[0]?.composition;
    },

    /** RAW observations of plan x lot with observed_at in [from, to] and their run outcome; the SERVICE applies the population rule. Read-only. */
    async listEstablishCandidates(tx: Tx, tenantId: string, q: { planId: string; lotId: string; from: string; to: string }): Promise<Row[]> {
      return (await tx.query(
        `SELECT o.id, o.value::text AS value, o.status, ${TS('observed_at', 'o.')}, r.outcome AS run_outcome
         FROM quality.qc_observations o LEFT JOIN quality.qc_runs r ON r.tenant_id = o.tenant_id AND r.id = o.qc_run_id AND r.tenant_id = $1
         WHERE o.tenant_id = $1 AND o.plan_id = $2 AND o.lot_id = $3 AND o.observed_at >= $4 AND o.observed_at <= $5`,
        [tenantId, q.planId, q.lotId, q.from, q.to])).rows;
    },
  };
}
export type TargetRepo = ReturnType<typeof createTargetRepo>;
