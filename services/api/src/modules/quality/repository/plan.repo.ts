// C9 T-07 repo: quality.qc_plans / qc_plan_versions (05-SCHEMA §2) + the activation-guard read over qc_targets/control_lots + instrument labels.
// Every statement is parameterised, schema-qualified and carries `tenant_id = $1` explicitly on top of RLS (REQ-SEC-022/024, 02-CV §5.13).
// qc_plan_versions is INSERT-only (05-SCHEMA §4/§5, S-06): this repo has no method that updates or deletes a version row. No deletes at all.
import { LimsError } from '../../../core/errors.js';
import type { Page, Row, SetupTx as Tx } from './setup.repo.js';

const TS = (c: string, a = '') => `to_char(${a}${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${c}`;
const PLAN_COLS = `id, tenant_id, instrument_id, test_id, analyte_id, status, current_version_no, is_active, version, ${TS('created_at')}`;
const PARAMS = ['controls_per_run', 'composition', 'mean_rule', 'two_two_s_across_runs', 'count_rules_across_materials', 'exclude_rejected_runs_from_history',
  'run_window_minutes', 'qc_validity_hours', 'hold_lookback_hours'] as const;
const VER_COLS = (a = '') => [`${a}id`, `${a}tenant_id`, `${a}plan_id`, `${a}version_no`, ...PARAMS.map((c) => a + c), `${a}change_reason`,
  TS('effective_from', a), `${a}is_active`, `${a}version`, TS('created_at', a), `${a}created_by`].join(', ');
const PLAN_INSERT = ['id', 'instrument_id', 'test_id', 'analyte_id', 'created_by', 'updated_by'] as const;
const VER_INSERT = ['id', 'plan_id', 'version_no', ...PARAMS, 'change_reason', 'effective_from', 'created_by', 'updated_by'] as const;
const PLAN_SETTABLE = ['status', 'current_version_no', 'updated_by'];

// Keyset cursor over id (UUIDv7, time-ordered) [CONV] 02-CV §4.3.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const encode = (id: string) => Buffer.from(JSON.stringify(['id', id]), 'utf8').toString('base64url');
export function decode(raw: string): string {
  const bad = () => new LimsError('common.invalid_cursor');
  if (typeof raw !== 'string' || raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw bad();
  let v: unknown;
  try { v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { throw bad(); }
  if (!Array.isArray(v) || v.length !== 2 || v[0] !== 'id' || typeof v[1] !== 'string' || !UUID.test(v[1])) throw bad();
  return v[1];
}

export function createPlanRepo() {
  return {
    async listPlans(tx: Tx, tenantId: string, q: { instrumentId?: string; analyteId?: string; status?: 'active' | 'inactive'; cursor?: string; limit: number }): Promise<Page> {
      const values: unknown[] = [tenantId], where = ['tenant_id = $1'];
      const bind = (v: unknown) => { values.push(v); return `$${values.length}`; };
      if (q.instrumentId !== undefined) where.push(`instrument_id = ${bind(q.instrumentId)}::uuid`);
      if (q.analyteId !== undefined) where.push(`analyte_id = ${bind(q.analyteId)}::uuid`);
      if (q.status !== undefined) where.push(`status = ${bind(q.status)}`);
      if (q.cursor !== undefined) where.push(`id > ${bind(decode(q.cursor))}::uuid`);
      const { rows } = await tx.query(`SELECT ${PLAN_COLS} FROM quality.qc_plans WHERE ${where.join(' AND ')} ORDER BY id LIMIT ${bind(q.limit + 1)}`, values);
      if (rows.length <= q.limit) return { rows };
      const kept = rows.slice(0, q.limit);
      return { rows: kept, nextCursor: encode(kept[kept.length - 1]!['id']) };
    },

    async findPlan(tx: Tx, tenantId: string, id: string): Promise<Row | undefined> {
      return (await tx.query(`SELECT ${PLAN_COLS} FROM quality.qc_plans WHERE tenant_id = $1 AND id = $2`, [tenantId, id])).rows[0];
    },

    /** Unique / FK violations pass through unchanged (code + constraint) for the service to map. */
    async insertPlan(tx: Tx, tenantId: string, row: Row): Promise<Row> {
      const { rows } = await tx.query(
        `INSERT INTO quality.qc_plans (tenant_id, ${PLAN_INSERT.join(', ')}) VALUES ($1, ${PLAN_INSERT.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING ${PLAN_COLS}`,
        [tenantId, ...PLAN_INSERT.map((c) => row[c] ?? null)]);
      return rows[0]!;
    },

    /** Optimistic lock in SQL: no row = stale version (or invisible row). Identity columns are never settable. */
    async updatePlan(tx: Tx, tenantId: string, id: string, expectedVersion: number, patch: Row): Promise<Row | undefined> {
      const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
      for (const k of keys) if (!PLAN_SETTABLE.includes(k)) throw new Error(`plan.repo: column ${k} is not updatable`);
      const values: unknown[] = [tenantId, id, ...keys.map((k) => patch[k]), expectedVersion];
      const set = [...keys.map((k, i) => `${k} = $${i + 3}`), 'version = version + 1', 'updated_at = now()'];
      const { rows } = await tx.query(
        `UPDATE quality.qc_plans SET ${set.join(', ')} WHERE tenant_id = $1 AND id = $2 AND version = $${values.length} RETURNING ${PLAN_COLS}`, values);
      return rows[0];
    },

    async insertVersion(tx: Tx, tenantId: string, row: Row): Promise<Row> {
      const ph = VER_INSERT.map((c, i) => (c === 'composition' ? `$${i + 2}::jsonb` : `$${i + 2}`));
      const { rows } = await tx.query(
        `INSERT INTO quality.qc_plan_versions (tenant_id, ${VER_INSERT.join(', ')}) VALUES ($1, ${ph.join(', ')}) RETURNING ${VER_COLS()}`,
        [tenantId, ...VER_INSERT.map((c) => (c === 'composition' ? JSON.stringify(row[c]) : row[c] ?? null))]);
      return rows[0]!;
    },

    async listVersions(tx: Tx, tenantId: string, planId: string): Promise<Row[]> {
      return (await tx.query(`SELECT ${VER_COLS()} FROM quality.qc_plan_versions WHERE tenant_id = $1 AND plan_id = $2 ORDER BY version_no`, [tenantId, planId])).rows;
    },

    async listCurrentVersions(tx: Tx, tenantId: string, planIds: string[]): Promise<Row[]> {
      if (!planIds.length) return [];
      return (await tx.query(
        `SELECT ${VER_COLS('v.')} FROM quality.qc_plan_versions v JOIN quality.qc_plans p ON p.tenant_id = v.tenant_id AND p.id = v.plan_id AND p.current_version_no = v.version_no
         WHERE v.tenant_id = $1 AND p.tenant_id = $1 AND v.plan_id = ANY($2::uuid[])`, [tenantId, planIds])).rows;
    },

    async findLevels(tx: Tx, tenantId: string, levelIds: string[]): Promise<Row[]> {
      if (!levelIds.length) return [];
      return (await tx.query('SELECT id, tenant_id, material_id, level_code, is_active FROM quality.control_levels WHERE tenant_id = $1 AND id = ANY($2::uuid[])', [tenantId, levelIds])).rows;
    },

    /** Activation guard (02-TRD §5.3 #18): of `levelIds`, those with an ACTIVE target of this plan on an is_active lot. */
    async coveredLevelIds(tx: Tx, tenantId: string, planId: string, levelIds: string[]): Promise<string[]> {
      const { rows } = await tx.query(
        `SELECT DISTINCT t.level_id FROM quality.qc_targets t JOIN quality.control_lots l ON l.tenant_id = t.tenant_id AND l.id = t.lot_id
         WHERE t.tenant_id = $1 AND l.tenant_id = $1 AND t.plan_id = $2 AND t.level_id = ANY($3::uuid[]) AND t.status = $4 AND t.is_active AND l.is_active`,
        [tenantId, planId, levelIds, 'active']);
      return rows.map((r) => String(r.level_id));
    },

    /** Labels only (08 R25): the invoker view, so C7's RLS applies. */
    async listInstrumentLabels(tx: Tx, tenantId: string, instrumentIds: string[]): Promise<Array<{ instrument_id: string; instrument_code: string; display_name: string }>> {
      if (!instrumentIds.length) return [];
      return (await tx.query('SELECT instrument_id, instrument_code, display_name FROM instruments.v_pub_instrument_directory WHERE tenant_id = $1 AND instrument_id = ANY($2::uuid[])',
        [tenantId, instrumentIds])).rows;
    },

    /** [CONV] OPEN seam (.orchestra/cr/C9.T-15.md): no user-directory view is specified; no label, the mapper renders a placeholder. */
    async listUserLabels(_tx: Tx, _tenantId: string, _userIds: string[]): Promise<Array<{ user_id: string; display_name: string }>> {
      return [];
    },
  };
}
export type PlanRepo = ReturnType<typeof createPlanRepo>;
