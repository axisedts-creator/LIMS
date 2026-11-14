// C9 T-12 repository for runs read + review actions (05-SCHEMA qc_observations / qc_runs / qc_corrective_actions / qc_run_reviews / coded sets; 02-TRD §5.5 #26-#33, §7.7). Schema `quality` only.
// Every statement is parameterised and names tenant_id = $n on top of RLS (REQ-SEC-024). Timestamps leave as ISO text with milliseconds, numerics as decimal text. Postgres errors pass through unchanged.
// qc_corrective_actions / qc_run_reviews are append-only (INSERT + SELECT only); the only observation UPDATE sets the exclusion columns (trigger quality.enforce_observation_exclusion backs it).
// Staff names (listUserLabels / listMembershipLabels) are an OPEN seam: the spec names no directory view (same gap as .orchestra/cr/C9.T-15.nonblocking.md), so they return no labels and the
// service renders the placeholder `Unknown user` instead of reading a table this chunk does not own.
import { LimsError } from '../../../core/errors.js';
import { runCols, ts } from './run.repo.js';
import type { Page, Row, SetupTx as Tx } from './setup.repo.js';

export interface ReviewRepo {
  listObservations(tx: Tx, t: string, q: { planId?: string; instrumentId?: string; analyteId?: string; levelId?: string; lotId?: string; statuses?: string[]; from: string; to: string; sort: 'observed_at' | '-observed_at'; cursor?: string; limit: number }): Promise<Page>;
  findObservation(tx: Tx, t: string, id: string): Promise<Row | undefined>;
  excludeObservation(tx: Tx, t: string, id: string, expectedVersion: number, patch: { excluded_reason_code: string; excluded_comment: string | null; excluded_by: string; excluded_at: string; updated_by: string }): Promise<Row | undefined>;
  listRuns(tx: Tx, t: string, q: { planId?: string; instrumentId?: string; analyteId?: string; statuses?: string[]; outcomes?: string[]; needsAction?: boolean; from: string; to: string; cursor?: string; limit: number }): Promise<Page>;
  findRun(tx: Tx, t: string, id: string): Promise<Row | undefined>;
  listRunObservations(tx: Tx, t: string, runId: string): Promise<Row[]>;
  listCorrectiveActions(tx: Tx, t: string, runId: string): Promise<Row[]>;
  listReviews(tx: Tx, t: string, runId: string): Promise<Row[]>;
  hasLaterAcceptedRun(tx: Tx, t: string, planId: string, after: string): Promise<boolean>;
  insertCorrectiveAction(tx: Tx, t: string, row: Row): Promise<Row>;
  insertReview(tx: Tx, t: string, row: Row): Promise<Row>;
  findCode(tx: Tx, t: string, set: 'corrective_actions' | 'exclusion_reasons', code: string): Promise<{ code: string; display: string; is_active: boolean; source: string } | undefined>;
  listUserLabels(tx: Tx, t: string, userIds: string[]): Promise<Array<{ user_id: string; display_name: string }>>;
  listMembershipLabels(tx: Tx, t: string, membershipIds: string[]): Promise<Array<{ membership_id: string; display_name: string }>>;
}

const KEY_TS = (expr: string, as: string) => `to_char(${expr} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${as}`;   // microseconds: exact keyset position
const KEY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encodeKey = (at: string, id: string): string => Buffer.from(JSON.stringify(['k', at, id]), 'utf8').toString('base64url');
function decodeKey(raw: string): { at: string; id: string } {
  const bad = () => new LimsError('common.invalid_cursor');
  if (typeof raw !== 'string' || raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw bad();
  let v: unknown;
  try { v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { throw bad(); }
  if (!Array.isArray(v) || v.length !== 3 || v[0] !== 'k' || typeof v[1] !== 'string' || !KEY.test(v[1]) || typeof v[2] !== 'string' || !UUID.test(v[2])) throw bad();
  return { at: v[1], id: v[2] };
}

const OBS_COLS = ['o.id', 'o.plan_id', 'o.instrument_id', 'o.analyte_id', 'o.level_id', 'o.lot_id', 'o.target_id', 'o.control_id_raw', 'o.control_lot_raw', 'o.control_level_raw', 'o.value::text AS value',
  'o.unit_code', ts('o.observed_at', 'observed_at'), ts('o.received_at', 'received_at'), 'o.observed_at_basis', 'o.source', 'o.status', 'o.qc_run_id', 'o.z::text AS z', 'o.excluded_reason_code',
  'o.excluded_comment', 'o.excluded_by', ts('o.excluded_at', 'excluded_at'), 'o.version'].join(', ');
const OBS_RETURNING = OBS_COLS.replace(/\bo\./g, '');
const RUN_COUNT = `(SELECT count(*)::int FROM quality.qc_corrective_actions ca WHERE ca.tenant_id = r.tenant_id AND ca.qc_run_id = r.id) AS corrective_action_count`;
const NEEDS_ACTION = `(r.outcome = 'rejected' AND r.status <> 'closed')`;

const SETS = { corrective_actions: ['quality.cs_corrective_actions', 'quality.g_cs_corrective_actions'], exclusion_reasons: ['quality.cs_exclusion_reasons', 'quality.g_cs_exclusion_reasons'] } as const;
const CA_COLS = ['id', 'qc_run_id', 'action_code', 'description', 'performed_at', 'performed_by_membership_id', 'created_at', 'created_by'] as const;
const REVIEW_COLS = ['id', 'qc_run_id', 'kind', 'comment', 'reviewed_by_membership_id', 'created_at', 'created_by'] as const;
const CA_TYPE: Record<string, string> = { id: 'uuid', qc_run_id: 'uuid', action_code: 'text', description: 'text', performed_at: 'timestamptz', performed_by_membership_id: 'uuid', created_at: 'timestamptz', created_by: 'uuid' };
const REVIEW_TYPE: Record<string, string> = { id: 'uuid', qc_run_id: 'uuid', kind: 'text', comment: 'text', reviewed_by_membership_id: 'uuid', created_at: 'timestamptz', created_by: 'uuid' };
const internal = (): never => { throw new LimsError('common.internal'); };

/** INSERT ... SELECT ... FROM quality.qc_runs keeps the tenant predicate on the insert and yields no row when the run is not visible (-> 404). Only allow-listed columns; tenant comes from the argument. */
async function insertLog(tx: Tx, t: string, table: string, cols: readonly string[], types: Record<string, string>, row: Row, returning: string): Promise<Row> {
  if (row['tenant_id'] !== undefined && row['tenant_id'] !== t) return internal();
  if (Object.keys(row).some((k) => k !== 'tenant_id' && !cols.includes(k))) return internal();
  const run = cols.indexOf('qc_run_id') + 2;
  const { rows } = await tx.query(
    `INSERT INTO ${table} (tenant_id, ${cols.join(', ')}) SELECT $1::uuid, ${cols.map((c, i) => `$${i + 2}::${types[c]}`).join(', ')} FROM quality.qc_runs r WHERE r.tenant_id = $1 AND r.id = $${run}::uuid RETURNING ${returning}`,
    [t, ...cols.map((c) => row[c] ?? null)]);
  if (rows.length === 0) throw new LimsError('common.not_found');
  return rows[0];
}

export function createReviewRepo(): ReviewRepo {
  return {
    async listObservations(tx, t, q) {
      const values: unknown[] = [t], where = ['o.tenant_id = $1'];
      const bind = (v: unknown, cast = '') => { values.push(v); return `$${values.length}${cast}`; };
      if (q.planId !== undefined) where.push(`o.plan_id = ${bind(q.planId, '::uuid')}`);
      if (q.instrumentId !== undefined) where.push(`o.instrument_id = ${bind(q.instrumentId, '::uuid')}`);
      if (q.analyteId !== undefined) where.push(`o.analyte_id = ${bind(q.analyteId, '::uuid')}`);
      if (q.levelId !== undefined) where.push(`o.level_id = ${bind(q.levelId, '::uuid')}`);
      if (q.lotId !== undefined) where.push(`o.lot_id = ${bind(q.lotId, '::uuid')}`);
      if (q.statuses !== undefined) where.push(`o.status = ANY(${bind(q.statuses, '::text[]')})`);
      where.push(`o.observed_at >= ${bind(q.from, '::timestamptz')}`, `o.observed_at <= ${bind(q.to, '::timestamptz')}`);
      const desc = q.sort === '-observed_at';
      if (q.cursor !== undefined) { const k = decodeKey(q.cursor); where.push(`(o.observed_at, o.id) ${desc ? '<' : '>'} (${bind(k.at, '::timestamptz')}, ${bind(k.id, '::uuid')})`); }
      const dir = desc ? 'DESC' : 'ASC';
      const { rows } = await tx.query(
        `SELECT ${OBS_COLS}, ${KEY_TS('o.observed_at', 'observed_at_key')} FROM quality.qc_observations o WHERE ${where.join(' AND ')} ORDER BY o.observed_at ${dir}, o.id ${dir} LIMIT ${bind(q.limit + 1)}`, values);
      if (rows.length <= q.limit) return { rows };
      const kept = rows.slice(0, q.limit), last = kept[kept.length - 1]!;
      return { rows: kept, nextCursor: encodeKey(last['observed_at_key'], last['id']) };
    },

    async findObservation(tx, t, id) {
      return (await tx.query(
        `SELECT ${OBS_COLS}, (SELECT r.status FROM quality.qc_runs r WHERE r.tenant_id = o.tenant_id AND r.id = o.qc_run_id) AS run_status FROM quality.qc_observations o WHERE o.tenant_id = $1 AND o.id = $2`, [t, id])).rows[0];
    },

    /** Optimistic lock in SQL: no row = stale version (or invisible row). Only the exclusion columns are written. */
    async excludeObservation(tx, t, id, expectedVersion, p) {
      return (await tx.query(
        `UPDATE quality.qc_observations SET status = 'excluded', excluded_reason_code = $3, excluded_comment = $4, excluded_by = $5::uuid, excluded_at = $6::timestamptz, updated_by = $7::uuid, updated_at = now(), version = version + 1
          WHERE tenant_id = $1 AND id = $2 AND version = $8::integer RETURNING ${OBS_RETURNING}`,
        [t, id, p.excluded_reason_code, p.excluded_comment, p.excluded_by, p.excluded_at, p.updated_by, expectedVersion])).rows[0];
    },

    async listRuns(tx, t, q) {
      const values: unknown[] = [t], where = ['r.tenant_id = $1'];
      const bind = (v: unknown, cast = '') => { values.push(v); return `$${values.length}${cast}`; };
      if (q.planId !== undefined) where.push(`r.plan_id = ${bind(q.planId, '::uuid')}`);
      if (q.instrumentId !== undefined) where.push(`r.instrument_id = ${bind(q.instrumentId, '::uuid')}`);
      if (q.analyteId !== undefined) where.push(`r.analyte_id = ${bind(q.analyteId, '::uuid')}`);
      if (q.statuses !== undefined) where.push(`r.status = ANY(${bind(q.statuses, '::text[]')})`);
      if (q.outcomes !== undefined) where.push(`r.outcome = ANY(${bind(q.outcomes, '::text[]')})`);
      if (q.needsAction === true) where.push(NEEDS_ACTION);
      if (q.needsAction === false) where.push(`(r.outcome IS DISTINCT FROM 'rejected' OR r.status = 'closed')`);
      where.push(`r.run_at >= ${bind(q.from, '::timestamptz')}`, `r.run_at <= ${bind(q.to, '::timestamptz')}`);
      if (q.cursor !== undefined) { const k = decodeKey(q.cursor); where.push(`(r.run_at, r.id) < (${bind(k.at, '::timestamptz')}, ${bind(k.id, '::uuid')})`); }
      const { rows } = await tx.query(
        `SELECT ${runCols('r.')}, ${RUN_COUNT}, ${KEY_TS('r.run_at', 'run_at_key')} FROM quality.qc_runs r WHERE ${where.join(' AND ')} ORDER BY r.run_at DESC, r.id DESC LIMIT ${bind(q.limit + 1)}`, values);
      if (rows.length <= q.limit) return { rows };
      const kept = rows.slice(0, q.limit), last = kept[kept.length - 1]!;
      return { rows: kept, nextCursor: encodeKey(last['run_at_key'], last['id']) };
    },

    /** The run + its corrective-action count + the run window of the plan's CURRENT version (the close-out guard of §7.7 / D-52 needs it). */
    async findRun(tx, t, id) {
      return (await tx.query(
        `SELECT ${runCols('r.')}, ${RUN_COUNT}, v.run_window_minutes FROM quality.qc_runs r
           JOIN quality.qc_plans p ON p.tenant_id = r.tenant_id AND p.id = r.plan_id
           JOIN quality.qc_plan_versions v ON v.tenant_id = p.tenant_id AND v.plan_id = p.id AND v.version_no = p.current_version_no
          WHERE r.tenant_id = $1 AND r.id = $2`, [t, id])).rows[0];
    },

    async listRunObservations(tx, t, runId) {
      return (await tx.query(`SELECT ${OBS_COLS} FROM quality.qc_observations o WHERE o.tenant_id = $1 AND o.qc_run_id = $2 ORDER BY o.observed_at, o.id`, [t, runId])).rows;
    },

    async listCorrectiveActions(tx, t, runId) {
      return (await tx.query(
        `SELECT ca.id, ca.qc_run_id, ca.action_code, COALESCE(tc.display, gc.display, ca.action_code) AS action_display, ca.description, ${ts('ca.performed_at', 'performed_at')}, ca.performed_by_membership_id, ${ts('ca.created_at', 'created_at')}
           FROM quality.qc_corrective_actions ca
           LEFT JOIN quality.cs_corrective_actions tc ON tc.tenant_id = ca.tenant_id AND tc.code = ca.action_code
           LEFT JOIN quality.g_cs_corrective_actions gc ON gc.code = ca.action_code
          WHERE ca.tenant_id = $1 AND ca.qc_run_id = $2 ORDER BY ca.created_at, ca.id`, [t, runId])).rows;
    },

    async listReviews(tx, t, runId) {
      return (await tx.query(
        `SELECT rv.id, rv.qc_run_id, rv.kind, rv.comment, rv.reviewed_by_membership_id, ${ts('rv.created_at', 'created_at')} FROM quality.qc_run_reviews rv
          WHERE rv.tenant_id = $1 AND rv.qc_run_id = $2 ORDER BY rv.created_at, rv.id`, [t, runId])).rows;
    },

    /** D-52: a run of the plan with outcome accepted | accepted_warning and run_at STRICTLY after `after` (= R.run_at + run_window_minutes). */
    async hasLaterAcceptedRun(tx, t, planId, after) {
      const { rows } = await tx.query(
        `SELECT 1 AS found FROM quality.qc_runs r WHERE r.tenant_id = $1 AND r.plan_id = $2::uuid AND r.outcome IN ('accepted', 'accepted_warning') AND r.run_at > $3::timestamptz LIMIT 1`, [t, planId, after]);
      return rows.length > 0;
    },

    insertCorrectiveAction: (tx, t, row) => insertLog(tx, t, 'quality.qc_corrective_actions', CA_COLS, CA_TYPE, row,
      `id, qc_run_id, action_code, description, ${ts('performed_at', 'performed_at')}, performed_by_membership_id, ${ts('created_at', 'created_at')}, created_by`),
    insertReview: (tx, t, row) => insertLog(tx, t, 'quality.qc_run_reviews', REVIEW_COLS, REVIEW_TYPE, row,
      `id, qc_run_id, kind, comment, reviewed_by_membership_id, ${ts('created_at', 'created_at')}, created_by`),

    /** Tenant override beats the global entry; the set name picks the tables from a fixed map, never from text. */
    async findCode(tx, t, set, code) {
      const tables = Object.hasOwn(SETS, set) ? SETS[set] : internal();
      return (await tx.query(
        `SELECT c.code, c.display, c.is_active, c.source FROM (
           SELECT x.code, x.display, x.is_active, 'tenant'::text AS source, 0 AS pri FROM ${tables[0]} x WHERE x.tenant_id = $1 AND x.code = $2
           UNION ALL
           SELECT g.code, g.display, g.is_active, 'global'::text AS source, 1 AS pri FROM ${tables[1]} g WHERE g.code = $2) c
          ORDER BY c.pri LIMIT 1`, [t, code])).rows[0];
    },

    async listUserLabels() { return []; },
    async listMembershipLabels() { return []; },
  };
}
