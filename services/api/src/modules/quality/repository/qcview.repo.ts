// C9 T-09 repository for the QC observation import (02-TRD §6.1-§6.3). The ONLY lab object read is lab.v_pub_qc_result (03-IC §6.3); never lab.qc_results.
// Every statement is parameterised and names tenant_id = $n on top of RLS. Timestamps leave as ISO text with microseconds (an exact keyset: a millisecond key would skip or repeat
// rows of one second); numerics leave as decimal text. Postgres errors pass through UNCHANGED (the service needs the SQLSTATE for import_error).
// Page reads order + limit inside a subquery on the real timestamptz column (index lab.qc_results (tenant_id, created_at, id), CR-C9-005), then format outside (review item 1).
export type Row = Record<string, any>;
export interface Tx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }

export interface SyncRepo {
  getSyncState(tx: Tx, tenantId: string): Promise<{ qc_cursor_at: string; qc_cursor_id: string | null } | undefined>;
  lockSyncState(tx: Tx, tenantId: string): Promise<void>;
  readFirstPage(tx: Tx, tenantId: string, q: { cursorAt: string; overlapSeconds: number; limit: number }): Promise<Row[]>;
  readPageAfter(tx: Tx, tenantId: string, q: { afterAt: string; afterId: string; limit: number }): Promise<Row[]>;
  findExistingSourceIds(tx: Tx, tenantId: string, sourceIds: string[]): Promise<string[]>;
  lockPair(tx: Tx, tenantId: string, instrumentId: string, analyteId: string | null): Promise<void>;
  findActivePlan(tx: Tx, tenantId: string, instrumentId: string, analyteId: string): Promise<Row | undefined>;
  findControlMaps(tx: Tx, tenantId: string, instrumentId: string, controlIdRaw: string): Promise<Row[]>;
  findLot(tx: Tx, tenantId: string, lotId: string): Promise<Row | undefined>;
  listTargets(tx: Tx, tenantId: string, planId: string, lotId: string): Promise<Row[]>;
  latestEvaluatedRunAt(tx: Tx, tenantId: string, planId: string): Promise<string | undefined>;
  insertObservation(tx: Tx, tenantId: string, row: Row): Promise<{ id: string } | undefined>;
  advanceCursor(tx: Tx, tenantId: string, k: { at: string; id: string }): Promise<boolean>;
}

/** T-11 re-processing (02-TRD §6.4). Reads/updates stored quality.qc_observations only; the classification inputs still come from SyncRepo. */
export interface ReprocessRepo {
  getReprocessWindowDays(tx: Tx, tenantId: string): Promise<number>;
  findPlan(tx: Tx, tenantId: string, planId: string): Promise<{ id: string; instrument_id: string; analyte_id: string; status: string } | undefined>;
  listPendingObservations(tx: Tx, tenantId: string, q: { instrumentId: string; analyteId?: string; statuses: string[]; observedFrom?: string; observedBefore?: string }): Promise<Row[]>;
  updateObservation(tx: Tx, tenantId: string, id: string, expectedStatus: string, patch: Row): Promise<boolean>;
}
/** The ONLY columns a re-classification may write (05-SCHEMA enforce_mutable_columns; source columns stay frozen). */
const PATCH_COLS = ['status', 'plan_id', 'level_id', 'lot_id', 'target_id', 'mean', 'sd', 'z', 'qc_run_id', 'classified_at', 'updated_by'] as const;

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
const ts = (col: string, as = col) => `to_char(${col} AT TIME ZONE 'UTC', ${ISO}) AS ${as}`;
const VIEW_COLS = `q.tenant_id, q.qc_result_id, q.instrument_id, q.analyte_id, q.control_id_raw, q.control_lot_raw, q.control_level, q.value_numeric::text AS value_numeric, q.unit_code,
  ${ts('q.instrument_result_time', 'instrument_result_time')}, ${ts('q.received_at', 'received_at')}, q.source, ${ts('q.created_at', 'created_at')}`;
const RAW_COLS = 'tenant_id, qc_result_id, instrument_id, analyte_id, control_id_raw, control_lot_raw, control_level, value_numeric, unit_code, instrument_result_time, received_at, source, created_at';
const pageRead = (where: string) =>
  `SELECT ${VIEW_COLS} FROM (SELECT ${RAW_COLS} FROM lab.v_pub_qc_result WHERE ${where} ORDER BY created_at, qc_result_id LIMIT $4) q ORDER BY q.created_at, q.qc_result_id`;
const OBS_COLS = ['id', 'tenant_id', 'source_qc_result_id', 'source', 'instrument_id', 'analyte_id', 'control_id_raw', 'control_lot_raw', 'control_level_raw', 'value', 'unit_code',
  'instrument_result_time', 'received_at', 'observed_at', 'observed_at_basis', 'status', 'plan_id', 'level_id', 'lot_id', 'target_id', 'mean', 'sd', 'z', 'qc_run_id', 'classified_at', 'created_by', 'updated_by'];

export function createQcViewRepo(): SyncRepo & ReprocessRepo {
  return {
    async getReprocessWindowDays(tx, tenantId) {
      const { rows } = await tx.query('SELECT reprocess_window_days FROM quality.settings WHERE tenant_id = $1', [tenantId]);
      return rows[0]?.reprocess_window_days ?? 7;   // DDL default
    },
    async findPlan(tx, tenantId, planId) {
      const { rows } = await tx.query('SELECT id, instrument_id, analyte_id, status FROM quality.qc_plans WHERE tenant_id = $1 AND id = $2', [tenantId, planId]);
      return rows[0];
    },
    async listPendingObservations(tx, tenantId, q) {
      const { rows } = await tx.query(
        `SELECT id, tenant_id, source_qc_result_id, source, instrument_id, analyte_id, control_id_raw, control_lot_raw, control_level_raw, value::text AS value, unit_code,
                ${ts('instrument_result_time')}, ${ts('received_at')}, ${ts('observed_at')}, observed_at_basis, status, plan_id, level_id, lot_id, target_id, created_by
           FROM quality.qc_observations
          WHERE tenant_id = $1 AND instrument_id = $2 AND analyte_id IS NOT NULL AND ($3::uuid IS NULL OR analyte_id = $3::uuid) AND status = ANY($4::text[])
            AND ($5::timestamptz IS NULL OR observed_at >= $5::timestamptz) AND ($6::timestamptz IS NULL OR observed_at < $6::timestamptz)
          ORDER BY observed_at, received_at, source_qc_result_id`,
        [tenantId, q.instrumentId, q.analyteId ?? null, q.statuses, q.observedFrom ?? null, q.observedBefore ?? null]);
      return rows;
    },
    async updateObservation(tx, tenantId, id, expectedStatus, patch) {
      const values = PATCH_COLS.map((c) => patch[c] ?? null);
      const { rows } = await tx.query(
        `UPDATE quality.qc_observations SET ${PATCH_COLS.map((c, i) => `${c} = $${i + 4}`).join(', ')}, updated_at = now()
          WHERE tenant_id = $1 AND id = $2 AND status = $3 RETURNING id`, [tenantId, id, expectedStatus, ...values]);
      return rows.length > 0;
    },
    async getSyncState(tx, tenantId) {
      const { rows } = await tx.query(`SELECT ${ts('qc_cursor_at')}, qc_cursor_id FROM quality.sync_state WHERE tenant_id = $1`, [tenantId]);
      return rows[0];
    },
    async lockSyncState(tx, tenantId) {
      await tx.query('SELECT 1 FROM quality.sync_state WHERE tenant_id = $1 FOR UPDATE', [tenantId]);
    },
    async readFirstPage(tx, tenantId, q) {
      return (await tx.query(
        pageRead('tenant_id = $1 AND created_at >= $2::timestamptz - make_interval(secs => $3::int)'),
        [tenantId, q.cursorAt, q.overlapSeconds, q.limit])).rows;
    },
    async readPageAfter(tx, tenantId, q) {
      return (await tx.query(
        pageRead('tenant_id = $1 AND (created_at, qc_result_id) > ($2::timestamptz, $3::uuid)'),
        [tenantId, q.afterAt, q.afterId, q.limit])).rows;
    },
    async findExistingSourceIds(tx, tenantId, sourceIds) {
      if (!sourceIds.length) return [];
      const { rows } = await tx.query('SELECT source_qc_result_id FROM quality.qc_observations WHERE tenant_id = $1 AND source_qc_result_id = ANY($2::uuid[])', [tenantId, sourceIds]);
      return rows.map((r) => r.source_qc_result_id);
    },
    async lockPair(tx, tenantId, instrumentId, analyteId) {
      if (analyteId === null) return;   // unknown analyte: row 1 never reaches a plan, nothing to serialise
      await tx.query('SELECT id FROM quality.qc_plans WHERE tenant_id = $1 AND instrument_id = $2 AND analyte_id = $3 FOR UPDATE', [tenantId, instrumentId, analyteId]);
    },
    async findActivePlan(tx, tenantId, instrumentId, analyteId) {
      const { rows } = await tx.query(
        `SELECT p.id, v.composition FROM quality.qc_plans p JOIN quality.qc_plan_versions v ON v.tenant_id = p.tenant_id AND v.plan_id = p.id AND v.version_no = p.current_version_no
         WHERE p.tenant_id = $1 AND p.instrument_id = $2 AND p.analyte_id = $3 AND p.status = 'active'`, [tenantId, instrumentId, analyteId]);
      return rows[0];
    },
    async findControlMaps(tx, tenantId, instrumentId, controlIdRaw) {
      return (await tx.query('SELECT id, instrument_id, control_id_raw, control_lot_raw, lot_id FROM quality.control_id_maps WHERE tenant_id = $1 AND instrument_id = $2 AND control_id_raw = $3 AND is_active',
        [tenantId, instrumentId, controlIdRaw])).rows;
    },
    async findLot(tx, tenantId, lotId) {
      const { rows } = await tx.query(`SELECT id, level_id, to_char(expires_on, 'YYYY-MM-DD') AS expires_on FROM quality.control_lots WHERE tenant_id = $1 AND id = $2`, [tenantId, lotId]);
      return rows[0];
    },
    async listTargets(tx, tenantId, planId, lotId) {
      return (await tx.query(
        `SELECT id, mean::text AS mean, sd::text AS sd, unit_code, status, ${ts('effective_from')}, ${ts('effective_to')} FROM quality.qc_targets
         WHERE tenant_id = $1 AND plan_id = $2 AND lot_id = $3 AND status IN ('active', 'superseded')`, [tenantId, planId, lotId])).rows;
    },
    async latestEvaluatedRunAt(tx, tenantId, planId) {
      const { rows } = await tx.query(`SELECT ${ts('max(run_at)', 'run_at')} FROM quality.qc_runs WHERE tenant_id = $1 AND plan_id = $2 AND evaluated_at IS NOT NULL`, [tenantId, planId]);
      return rows[0]?.run_at ?? undefined;
    },
    async insertObservation(tx, tenantId, row) {
      const values = OBS_COLS.map((c) => (c === 'tenant_id' ? tenantId : row[c] ?? null));
      const { rows } = await tx.query(
        `INSERT INTO quality.qc_observations (${OBS_COLS.join(', ')}) VALUES (${OBS_COLS.map((_, i) => `$${i + 1}`).join(', ')}) ON CONFLICT (tenant_id, source_qc_result_id) DO NOTHING RETURNING id`, values);
      return rows[0] ? { id: rows[0].id } : undefined;
    },
    async advanceCursor(tx, tenantId, k) {
      const { rows } = await tx.query(
        `UPDATE quality.sync_state SET qc_cursor_at = $2::timestamptz, qc_cursor_id = $3::uuid, updated_at = now()
         WHERE tenant_id = $1 AND (qc_cursor_at, coalesce(qc_cursor_id, '00000000-0000-0000-0000-000000000000'::uuid)) < ($2::timestamptz, $3::uuid) RETURNING id`, [tenantId, k.at, k.id]);
      return rows.length > 0;
    },
  };
}
