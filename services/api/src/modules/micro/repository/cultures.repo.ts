// micro.cultures + micro.culture_transitions writes used by the lab.specimen.status_changed.v1 consumer (02-TRD §8.2; 05-SCHEMA cultures).
// REQ-SEC-024: every statement binds tenant_id explicitly in addition to RLS. Static SQL only; values are always parameters.
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;
type Row = Record<string, any>;

/** The culture of (order item, specimen) = the creation key, locked for the delivery. */
export async function findByItemSpecimen(tx: Q, a: { tenantId: string; orderItemId: string; specimenId: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    'SELECT id, status, last_specimen_seq, centre_id FROM micro.cultures WHERE tenant_id = $1 AND order_item_id = $2 AND specimen_id = $3 FOR UPDATE',
    [a.tenantId, a.orderItemId, a.specimenId]);
  return rows[0];
}

/** Every culture of one specimen (rejection fan-out), locked, with "has a submitted report version". */
export async function listBySpecimen(tx: Q, a: { tenantId: string; specimenId: string }): Promise<Row[]> {
  const { rows } = await tx.query(
    `SELECT c.id, c.status, c.last_specimen_seq, c.centre_id,
            EXISTS (SELECT 1 FROM micro.report_versions rv WHERE rv.tenant_id = c.tenant_id AND rv.culture_id = c.id) AS has_report
       FROM micro.cultures c WHERE c.tenant_id = $1 AND c.specimen_id = $2 ORDER BY c.id FOR UPDATE OF c`, [a.tenantId, a.specimenId]);
  return rows;
}

export interface NewCulture {
  id: string; tenantId: string; centreId: string; orderId: string; orderItemId: string; specimenId: string; patientId: string; testId: string;
  specimenTypeCode: string; receivedAt: string; seq: number; userId: string;
}
/** ON CONFLICT on the creation key; undefined = another delivery created it first. */
export async function insertCulture(tx: Q, c: NewCulture): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `INSERT INTO micro.cultures (id, tenant_id, centre_id, order_id, order_item_id, specimen_id, patient_id, test_id, specimen_type_code, status, received_at, last_specimen_seq, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)
     ON CONFLICT (tenant_id, order_item_id, specimen_id) DO NOTHING RETURNING id`,
    [c.id, c.tenantId, c.centreId, c.orderId, c.orderItemId, c.specimenId, c.patientId, c.testId, c.specimenTypeCode, 'awaiting_setup', c.receivedAt, c.seq, c.userId]);
  return rows[0];
}

export async function insertTransition(tx: Q, t: { id: string; tenantId: string; centreId: string; cultureId: string; from: string | null; to: string; reason: string | null; occurredAt: string; userId: string }): Promise<void> {
  await tx.query(
    `INSERT INTO micro.culture_transitions (id, tenant_id, centre_id, culture_id, from_status, to_status, reason_code, occurred_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [t.id, t.tenantId, t.centreId, t.cultureId, t.from, t.to, t.reason, t.occurredAt, t.userId]);
}

/** Aliquot re-point (only while awaiting_setup; cultures_guard re-checks). The audit trigger records the change. */
export async function repoint(tx: Q, a: { tenantId: string; id: string; specimenId: string; seq: number; userId: string }): Promise<void> {
  await tx.query(
    `UPDATE micro.cultures SET specimen_id = $3, last_specimen_seq = $4, version = version + 1, updated_at = now(), updated_by = $5
      WHERE tenant_id = $1 AND id = $2 AND status = 'awaiting_setup'`, [a.tenantId, a.id, a.specimenId, a.seq, a.userId]);
}

export async function cancelForRejection(tx: Q, a: { tenantId: string; id: string; seq: number; userId: string }): Promise<void> {
  await tx.query(
    `UPDATE micro.cultures SET status = 'cancelled', cancel_reason_code = 'specimen_rejected', cancelled_at = now(), last_specimen_seq = $3,
            version = version + 1, updated_at = now(), updated_by = $4
      WHERE tenant_id = $1 AND id = $2`, [a.tenantId, a.id, a.seq, a.userId]);
}

/** Advance last_specimen_seq of one culture, forward only. */
export async function bumpSeq(tx: Q, a: { tenantId: string; id: string; seq: number; userId: string }): Promise<void> {
  await tx.query(
    `UPDATE micro.cultures SET last_specimen_seq = $3, version = version + 1, updated_at = now(), updated_by = $4
      WHERE tenant_id = $1 AND id = $2 AND last_specimen_seq < $3`, [a.tenantId, a.id, a.seq, a.userId]);
}

/** Other statuses: last_specimen_seq of every culture of the specimen, forward only. */
export async function bumpSeqBySpecimen(tx: Q, a: { tenantId: string; specimenId: string; seq: number; userId: string }): Promise<void> {
  await tx.query(
    `UPDATE micro.cultures SET last_specimen_seq = $3, version = version + 1, updated_at = now(), updated_by = $4
      WHERE tenant_id = $1 AND specimen_id = $2 AND last_specimen_seq < $3`, [a.tenantId, a.specimenId, a.seq, a.userId]);
}

// ================================================================ T-07 reads (M1, M2, M15, M16; 02-TRD §5, 05-SCHEMA §8/§9)
// Explicit column lists (no SELECT *): only what the mappers may emit. RLS applies the centre scope (05-SCHEMA §4, D-63); tenant_id is bound as well (REQ-SEC-024).
// Static SQL fragments only; every value is a parameter.

/** "Open" instrument records = the states of the partial index instrument_records__tenant_id_open__p_idx (05-SCHEMA). */
const OPEN_RECORD = `LEFT JOIN LATERAL (SELECT count(*)::int AS n FROM micro.instrument_records r
     WHERE r.tenant_id = c.tenant_id AND r.culture_id = c.id AND r.match_status IN ('pending_match','needs_mapping','conflict','late_after_final')) o ON TRUE`;
const BASE_COLS = `c.id, c.version, c.status, c.order_id, c.order_item_id, c.specimen_id, c.patient_id, c.centre_id, c.test_id, c.specimen_type_code, c.specimen_site_code,
  c.outcome_code, c.received_at, c.planted_at, c.next_read_due_at, c.final_due_at, c.current_report_version_no, c.last_report_phase, c.chain_cancelled, c.barcode_snapshot,
  c.plating_protocol_id, c.amendment_reason_code, c.amendment_reason_text, c.cancel_reason_code, c.updated_at`;
const CULTURE_COLS = `${BASE_COLS}, coalesce(o.n, 0) AS open_instrument_record_count`;

export type CultureSort = 'received_at' | '-received_at' | 'next_read_due_at' | '-updated_at';
export interface CultureFilter {
  tenantId: string; now: string;
  statuses?: string[]; specimenId?: string; orderId?: string; centreId?: string; receivedFrom?: string; receivedTo?: string;
  readOverdue?: boolean; hasOpenRecords?: boolean; updatedFrom?: string;
}
/** Keyset per sort (column, direction); ties by id. Only next_read_due_at is nullable: NULLS LAST. */
const SORTS: Record<CultureSort, { col: string; desc: boolean }> = {
  'received_at': { col: 'received_at', desc: false },
  '-received_at': { col: 'received_at', desc: true },
  'next_read_due_at': { col: 'next_read_due_at', desc: false },
  '-updated_at': { col: 'updated_at', desc: true },
};

function where(f: CultureFilter, params: unknown[]): string {
  const p = (v: unknown): string => { params.push(v); return `$${params.length}`; };
  const w = [`c.tenant_id = ${p(f.tenantId)}`];
  if (f.statuses) w.push(`c.status = ANY(${p(f.statuses)}::text[])`);
  if (f.specimenId) w.push(`c.specimen_id = ${p(f.specimenId)}`);
  if (f.orderId) w.push(`c.order_id = ${p(f.orderId)}`);
  if (f.centreId) w.push(`c.centre_id = ${p(f.centreId)}`);
  if (f.receivedFrom) w.push(`c.received_at >= ${p(f.receivedFrom)}::timestamptz`);
  if (f.receivedTo) w.push(`c.received_at <= ${p(f.receivedTo)}::timestamptz`);
  if (f.updatedFrom) w.push(`c.updated_at >= ${p(f.updatedFrom)}::timestamptz`);
  if (f.readOverdue !== undefined) {   // 02-TRD §4.1: status in {incubating, growth_detected} and next_read_due_at < now
    const overdue = `(c.status IN ('incubating','growth_detected') AND c.next_read_due_at IS NOT NULL AND c.next_read_due_at < ${p(f.now)}::timestamptz)`;
    w.push(f.readOverdue ? overdue : `NOT ${overdue}`);
  }
  if (f.hasOpenRecords !== undefined) w.push(f.hasOpenRecords ? 'o.n > 0' : 'o.n = 0');
  return w.join(' AND ');
}

/** limit + 1 rows (the extra row says "there is a next page"). Cursor = sort key as microsecond UTC text (exact keyset) + id. */
export async function listCultures(tx: Q, f: CultureFilter, sort: CultureSort, cursor: { key: string | null; id: string } | undefined, limit: number): Promise<Row[]> {
  const params: unknown[] = [];
  const s = SORTS[sort];
  let sql = `SELECT ${CULTURE_COLS}, to_char(c.${s.col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_key
    FROM micro.cultures c ${OPEN_RECORD} WHERE ${where(f, params)}`;
  if (cursor) {
    params.push(cursor.id); const id = `$${params.length}::uuid`;
    if (cursor.key === null) sql += ` AND c.${s.col} IS NULL AND c.id > ${id}`;
    else {
      params.push(cursor.key); const k = `$${params.length}::timestamptz`;
      sql += s.desc ? ` AND (c.${s.col}, c.id) < (${k}, ${id})` : ` AND ((c.${s.col}, c.id) > (${k}, ${id}) OR c.${s.col} IS NULL)`;
    }
  }
  params.push(limit + 1);
  sql += (s.desc ? ` ORDER BY c.${s.col} DESC, c.id DESC` : ` ORDER BY c.${s.col} ASC NULLS LAST, c.id ASC`) + ` LIMIT $${params.length}`;
  return (await tx.query(sql, params)).rows;
}

/** include_total: count of the filtered set, capped (02-TRD §5 M1 [CONV] 10,000; S-25). */
export async function countCultures(tx: Q, f: CultureFilter, cap: number): Promise<number> {
  const params: unknown[] = [];
  const w = where(f, params);
  params.push(cap);
  const { rows } = await tx.query(`SELECT count(*)::int AS n FROM (SELECT 1 FROM micro.cultures c ${OPEN_RECORD} WHERE ${w} LIMIT $${params.length}) t`, params);
  return Number(rows[0]?.n ?? 0);
}

export async function getCulture(tx: Q, a: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT ${CULTURE_COLS} FROM micro.cultures c ${OPEN_RECORD} WHERE c.tenant_id = $1 AND c.id = $2`, [a.tenantId, a.id]);
  return rows[0];
}

type ChildKey = { tenantId: string; cultureId: string };
const child = async (tx: Q, sql: string, k: ChildKey): Promise<Row[]> => (await tx.query(sql, [k.tenantId, k.cultureId])).rows;

export const listPlates = (tx: Q, k: ChildKey): Promise<Row[]> => child(tx,
  `SELECT id, version, plate_no, media_code, incubation_text, parent_plate_id, source_isolate_id, planted_at, status
     FROM micro.culture_plates WHERE tenant_id = $1 AND culture_id = $2 ORDER BY plate_no, id`, k);
export const listObservations = (tx: Q, k: ChildKey): Promise<Row[]> => child(tx,
  `SELECT id, kind, plate_id, growth_code, quantity_text, finding_text, observed_at, hours_since_planting::text AS hours_since_planting, recorded_by_membership_id, corrects_observation_id
     FROM micro.culture_observations WHERE tenant_id = $1 AND culture_id = $2 ORDER BY observed_at, id`, k);
export const listIsolates = (tx: Q, k: ChildKey): Promise<Row[]> => child(tx,
  `SELECT id, version, isolate_seq, status, organism_code, organism_source, identified_at, colony_description, quantity_text, is_reportable, withdraw_reason_code, ast_panel_id, ast_method
     FROM micro.isolates WHERE tenant_id = $1 AND culture_id = $2 ORDER BY isolate_seq, id`, k);
export const listAst = (tx: Q, k: ChildKey): Promise<Row[]> => child(tx,
  `SELECT id, version, isolate_id, antibiotic_code, method, raw_value, raw_qualifier, raw_numeric::text AS raw_numeric, unit_code, category_code, standard, standard_version,
          standard_source, interpretation_raw, interpretation_source, breakpoint_set_id, suggestion_overridden, source, instrument_id, instrument_result_time,
          is_reportable, report_visibility, off_panel, panel_sort_order, entered_at
     FROM micro.ast_results WHERE tenant_id = $1 AND culture_id = $2 ORDER BY panel_sort_order NULLS LAST, antibiotic_code, id`, k);
export const listTransitions = (tx: Q, k: ChildKey): Promise<Row[]> => child(tx,
  `SELECT id, from_status, to_status, reason_code, occurred_at, created_by
     FROM micro.culture_transitions WHERE tenant_id = $1 AND culture_id = $2 ORDER BY occurred_at, id`, k);
const VERSION_SUMMARY = 'version_no, report_phase, version_kind, outcome_code, flag, is_critical, signed_by_membership_id, signed_at, lab_status_at_submit, amendment_reason_code';
export const listReportVersions = (tx: Q, k: ChildKey): Promise<Row[]> => child(tx,
  `SELECT ${VERSION_SUMMARY} FROM micro.report_versions WHERE tenant_id = $1 AND culture_id = $2 ORDER BY version_no`, k);

export async function getReportVersion(tx: Q, a: ChildKey & { versionNo: number }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `SELECT ${VERSION_SUMMARY}, culture_summary_text, isolates, ast, comments_text, early_final_reason, amendment_reason_text, lab_result_id, lab_result_version_no
       FROM micro.report_versions WHERE tenant_id = $1 AND culture_id = $2 AND version_no = $3`, [a.tenantId, a.cultureId, a.versionNo]);
  return rows[0];
}

/** code -> display of a coded-set view (tenant row else global, 05-SCHEMA §3). The view filters by the claims tenant; `$2` pins that to ctx.tenantId (REQ-SEC-024). */
async function codeDisplays(tx: Q, view: 'v_organisms' | 'v_antibiotics', tenantId: string, codes: string[]): Promise<Map<string, string>> {
  if (codes.length === 0) return new Map();
  const { rows } = await tx.query(`SELECT code, display FROM micro.${view} WHERE code = ANY($1::text[]) AND (SELECT app.current_tenant_id()) = $2::uuid`, [codes, tenantId]);
  return new Map(rows.map((r: Row) => [r['code'], r['display']]));
}
export const organismDisplays = (tx: Q, tenantId: string, codes: string[]): Promise<Map<string, string>> => codeDisplays(tx, 'v_organisms', tenantId, codes);
export const antibioticDisplays = (tx: Q, tenantId: string, codes: string[]): Promise<Map<string, string>> => codeDisplays(tx, 'v_antibiotics', tenantId, codes);

export async function astPanels(tx: Q, tenantId: string, ids: string[]): Promise<Row[]> {
  if (ids.length === 0) return [];
  return (await tx.query('SELECT id, code, version_no, display FROM micro.ast_panels WHERE tenant_id = $1 AND id = ANY($2::uuid[])', [tenantId, ids])).rows;
}

/** Active plating protocol keys of the tenant (02-TRD §4.2 selection input). */
export async function activeProtocolKeys(tx: Q, tenantId: string): Promise<Row[]> {
  return (await tx.query('SELECT protocol_code, test_id, specimen_type_code, is_active FROM micro.plating_protocol_keys WHERE tenant_id = $1 AND is_active ORDER BY protocol_code, id', [tenantId])).rows;
}

/** The current (active, not superseded) version of a protocol code. */
export async function currentProtocolByCode(tx: Q, a: { tenantId: string; code: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    'SELECT id, code, version_no, display FROM micro.plating_protocols WHERE tenant_id = $1 AND code = $2 AND is_active AND superseded_at IS NULL ORDER BY version_no DESC LIMIT 1', [a.tenantId, a.code]);
  return rows[0];
}

export async function getProtocol(tx: Q, a: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    'SELECT id, code, version_no, display, read_schedule_hours, final_no_growth_hours, requires_gram_stain FROM micro.plating_protocols WHERE tenant_id = $1 AND id = $2', [a.tenantId, a.id]);
  return rows[0];
}

// ================================================================ T-08 writes (M3–M6; 02-TRD §5, §4.1)
/** The culture row the write handlers need, locked for the request (serialises setup / plates / reads of one culture). RLS applies the centre scope. */
export async function lockCulture(tx: Q, a: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `SELECT id, version, status, centre_id, specimen_id, test_id, specimen_type_code, specimen_site_code, plating_protocol_id, planted_at, next_read_due_at
       FROM micro.cultures WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [a.tenantId, a.id]);
  return rows[0];
}

/** The culture as the DTOs read it (CULTURE_COLS) after a write; the open-record count is its own statement so the locked row stays a plain single-table read. */
export async function reloadCulture(tx: Q, a: { tenantId: string; id: string }): Promise<Row | undefined> {
  const row = (await tx.query(`SELECT ${BASE_COLS} FROM micro.cultures c WHERE c.tenant_id = $1 AND c.id = $2`, [a.tenantId, a.id])).rows[0];
  if (!row) return undefined;
  const n = (await tx.query(
    `SELECT count(*)::int AS n FROM micro.instrument_records WHERE tenant_id = $1 AND culture_id = $2 AND match_status IN ('pending_match','needs_mapping','conflict','late_after_final')`,
    [a.tenantId, a.id])).rows[0]?.['n'];
  return { ...row, open_instrument_record_count: Number(n ?? 0) };
}

/** C2: awaiting_setup -> incubating, guarded by version and state; undefined = the version moved (409 common.version_conflict). */
export async function setupCulture(tx: Q, a: {
  tenantId: string; id: string; expectedVersion: number; userId: string; plantedAt: Date; nextReadDueAt: Date | null; finalDueAt: Date; protocolId: string | null; siteCode: string | null;
}): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `UPDATE micro.cultures SET status = 'incubating', planted_at = $4, next_read_due_at = $5, final_due_at = $6, plating_protocol_id = $7, specimen_site_code = $8,
            version = version + 1, updated_at = now(), updated_by = $9
      WHERE tenant_id = $1 AND id = $2 AND version = $3 AND status = 'awaiting_setup' RETURNING id, version`,
    [a.tenantId, a.id, a.expectedVersion, a.plantedAt, a.nextReadDueAt, a.finalDueAt, a.protocolId, a.siteCode, a.userId]);
  return rows[0];
}

// ================================================================ T-16 (M17 reopenCulture C8, M18 cancelCulture C9; 02-TRD §5, 03-APP-FLOW §2.1)
/** C8: final_submitted -> amending with the reason; undefined = the version or state moved (the caller already holds the row lock, so only a bug gets here). */
export async function reopenCulture(tx: Q, a: { tenantId: string; id: string; expectedVersion: number; userId: string; reasonCode: string; reasonText: string | null }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `UPDATE micro.cultures SET status = 'amending', amendment_reason_code = $4, amendment_reason_text = $5, version = version + 1, updated_at = now(), updated_by = $6
      WHERE tenant_id = $1 AND id = $2 AND version = $3 AND status = 'final_submitted' RETURNING id, version`,
    [a.tenantId, a.id, a.expectedVersion, a.reasonCode, a.reasonText, a.userId]);
  return rows[0];
}

/** C9 by a person: the open states only; cancel_reason_code + cancelled_at + status move together (cultures__cancel__ck). */
export async function cancelCulture(tx: Q, a: { tenantId: string; id: string; expectedVersion: number; userId: string; reasonCode: string; comment: string | null }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `UPDATE micro.cultures SET status = 'cancelled', cancel_reason_code = $4, cancel_comment = $5, cancelled_at = now(), version = version + 1, updated_at = now(), updated_by = $6
      WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING id, version`,
    [a.tenantId, a.id, a.expectedVersion, a.reasonCode, a.comment, a.userId]);
  return rows[0];
}

/** C9 effect (AC-01.6): the culture's open instrument records wait for a match again, reason culture_cancelled. applied / ignored records are history and stay. */
export async function releaseOpenRecords(tx: Q, a: { tenantId: string; cultureId: string; userId: string }): Promise<void> {
  await tx.query(
    `UPDATE micro.instrument_records SET match_status = 'pending_match', match_reason = 'culture_cancelled', version = version + 1, updated_at = now(), updated_by = $3
      WHERE tenant_id = $1 AND culture_id = $2 AND match_status = ANY($4::text[])`,
    [a.tenantId, a.cultureId, a.userId, ['pending_match', 'needs_mapping', 'conflict']]);
}

/** After a plate_read: new status (C3; same value when unchanged) and the recomputed next_read_due_at. */
export async function updateAfterRead(tx: Q, a: { tenantId: string; id: string; status: string; nextReadDueAt: Date | null; userId: string }): Promise<void> {
  await tx.query(
    `UPDATE micro.cultures SET status = $3, next_read_due_at = $4, version = version + 1, updated_at = now(), updated_by = $5
      WHERE tenant_id = $1 AND id = $2`, [a.tenantId, a.id, a.status, a.nextReadDueAt, a.userId]);
}
