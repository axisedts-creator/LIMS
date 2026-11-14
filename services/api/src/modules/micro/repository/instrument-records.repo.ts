// micro.instrument_records + the isolate / AST statements of instrument apply + micro.instrument_vocab_maps / instrument_ast_defaults (02-TRD §4.8, §5.3, §5.4; 05-SCHEMA §8; T-14).
// REQ-SEC-024: every statement binds tenant_id explicitly in addition to RLS. Static SQL only; values are always parameters. expires_at is set by the DATABASE clock
// (now() + rawInstrumentYears) in the same UPDATE that makes the record applied/ignored (08 A17 D-65; CHECK instrument_records__expires__ck).
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;
type Row = Record<string, any>;

export const OPEN = ['pending_match', 'needs_mapping', 'conflict', 'late_after_final'] as const;

const RECORD_COLS = `id, version, tenant_id, centre_id, record_kind, instrument_id, instrument_message_id, instrument_analyte_code, sample_barcode, isolate_seq, organism_code_raw, antibiotic_code_raw,
  method, raw_value, organism_code, antibiotic_code, interpretation_raw, standard, standard_version, instrument_result_time, received_at, is_rerun, match_status, match_reason,
  specimen_id, culture_id, isolate_id, ast_result_id, ignore_reason_code, ignore_comment, expires_at`;

export interface NewRecord {
  id: string; tenantId: string; centreId: string; eventId: string; idempotencyKey: string; instrumentMessageId: string; instrumentId: string; sampleBarcode: string; recordKind: string;
  analyteCode: string; isolateSeq: number | null; organismCodeRaw: string | null; antibioticCodeRaw: string | null; method: string | null; rawValue: string | null; organismCode: string | null;
  antibioticCode: string | null; interpretationRaw: string | null; standard: string | null; standardVersion: string | null; resultTime: string | null; receivedAt: string; isRerun: boolean; userId: string;
}
/** AC-08.2: one row per (tenant, idempotency_key). undefined = the key already exists (re-delivery or a lost race) = success, nothing else to do. */
export async function insertRecord(tx: Q, r: NewRecord): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `INSERT INTO micro.instrument_records (id, tenant_id, centre_id, event_id, idempotency_key, instrument_message_id, instrument_id, sample_barcode, record_kind, instrument_analyte_code,
            isolate_seq, organism_code_raw, antibiotic_code_raw, method, raw_value, organism_code, antibiotic_code, interpretation_raw, standard, standard_version,
            instrument_result_time, received_at, is_rerun, match_status, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, 'pending_match', $24, $24)
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id`,
    [r.id, r.tenantId, r.centreId, r.eventId, r.idempotencyKey, r.instrumentMessageId, r.instrumentId, r.sampleBarcode, r.recordKind, r.analyteCode, r.isolateSeq, r.organismCodeRaw,
      r.antibioticCodeRaw, r.method, r.rawValue, r.organismCode, r.antibioticCode, r.interpretationRaw, r.standard, r.standardVersion, r.resultTime, r.receivedAt, r.isRerun, r.userId]);
  return rows[0];
}

/** A record by id, unlocked (RLS + tenant: another tenant's / centre's record is simply absent). */
export async function getRecord(tx: Q, a: { tenantId: string; id: string; forUpdate?: boolean }): Promise<Row | undefined> {
  return (await tx.query(`SELECT ${RECORD_COLS} FROM micro.instrument_records WHERE tenant_id = $1 AND id = $2${a.forUpdate ? ' FOR UPDATE' : ''}`, [a.tenantId, a.id])).rows[0];
}

export interface Settle {
  tenantId: string; id: string; userId: string; status: string; reason: string | null; specimenId: string | null; cultureId: string | null; isolateId: string | null; astResultId: string | null;
  ignoreReason: string | null; ignoreComment: string | null; membershipId: string | null; resolved: boolean;
  /** rawInstrumentYears; required (and only used) when status is applied/ignored. */
  years: number | null;
}
/** Run state of a record. applied/ignored set expires_at = now() + years in the same statement (D-65); every other status clears it. */
export async function settleRecord(tx: Q, s: Settle): Promise<Row> {
  const closed = s.status === 'applied' || s.status === 'ignored';
  const { rows } = await tx.query(
    `UPDATE micro.instrument_records SET match_status = $3, match_reason = $4, specimen_id = COALESCE($5, specimen_id), culture_id = COALESCE($6, culture_id), isolate_id = $7, ast_result_id = $8,
            ignore_reason_code = $9, ignore_comment = $10,
            resolved_by_membership_id = CASE WHEN $11::boolean THEN $12::uuid ELSE resolved_by_membership_id END, resolved_at = CASE WHEN $11::boolean THEN now() ELSE resolved_at END,
            expires_at = CASE WHEN $13::int IS NULL THEN NULL ELSE now() + make_interval(years => $13::int) END,
            version = version + 1, updated_at = now(), updated_by = $14
      WHERE tenant_id = $1 AND id = $2 RETURNING ${RECORD_COLS}`,
    [s.tenantId, s.id, s.status, s.reason, s.specimenId, s.cultureId, s.isolateId, s.astResultId, s.ignoreReason, s.ignoreComment, s.resolved, s.membershipId, closed ? s.years : null, s.userId]);
  return rows[0]!;
}

// ---------------------------------------------------------------- M19
export interface RecordFilter { tenantId: string; statuses: readonly string[]; cultureId?: string; instrumentId?: string; receivedFrom?: string; receivedTo?: string }
export async function listRecords(tx: Q, f: RecordFilter, desc: boolean, cursor: { key: string; id: string } | undefined, limit: number): Promise<Row[]> {
  const params: unknown[] = [f.tenantId, [...f.statuses]];
  const where = ['tenant_id = $1', 'match_status = ANY($2::text[])'];
  const add = (sql: string, v: unknown): void => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (f.cultureId !== undefined) add('culture_id = ?', f.cultureId);
  if (f.instrumentId !== undefined) add('instrument_id = ?', f.instrumentId);
  if (f.receivedFrom !== undefined) add('received_at >= ?::timestamptz', f.receivedFrom);
  if (f.receivedTo !== undefined) add('received_at <= ?::timestamptz', f.receivedTo);
  if (cursor) {
    params.push(cursor.key, cursor.id);
    where.push(`(received_at, id) ${desc ? '<' : '>'} ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(limit + 1);
  return (await tx.query(
    `SELECT ${RECORD_COLS}, to_char(received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_key FROM micro.instrument_records
      WHERE ${where.join(' AND ')} ORDER BY received_at ${desc ? 'DESC' : 'ASC'}, id ${desc ? 'DESC' : 'ASC'} LIMIT $${params.length}`, params)).rows;
}

// ---------------------------------------------------------------- consumer: specimen -> culture
/** Non-cancelled cultures of one specimen (TRD §4.8 step 3). The chosen one is locked afterwards (cultures.repo lockCulture). */
export async function candidateCultures(tx: Q, a: { tenantId: string; specimenId: string }): Promise<Row[]> {
  return (await tx.query(
    `SELECT id, status, specimen_id, centre_id, version FROM micro.cultures WHERE tenant_id = $1 AND specimen_id = $2 AND status <> 'cancelled' ORDER BY id`, [a.tenantId, a.specimenId])).rows;
}

// ---------------------------------------------------------------- vocabulary (step 4)
export async function activeMap(tx: Q, a: { tenantId: string; instrumentId: string; kind: 'organism' | 'antibiotic'; codeRaw: string }): Promise<Row | undefined> {
  return (await tx.query(
    `SELECT id, local_code FROM micro.instrument_vocab_maps WHERE tenant_id = $1 AND instrument_id = $2 AND kind = $3 AND code_raw = $4 AND is_active`,
    [a.tenantId, a.instrumentId, a.kind, a.codeRaw])).rows[0];
}
export async function astDefault(tx: Q, a: { tenantId: string; instrumentId: string }): Promise<Row | undefined> {
  return (await tx.query(
    `SELECT standard, standard_version FROM micro.instrument_ast_defaults WHERE tenant_id = $1 AND instrument_id = $2 AND is_active`, [a.tenantId, a.instrumentId])).rows[0];
}

// ---------------------------------------------------------------- isolates (steps 5–6)
const ISOLATE_COLS = 'id, version, culture_id, specimen_id, centre_id, isolate_seq, status, organism_code, organism_source, ast_panel_id';
export async function isolatesOfCulture(tx: Q, a: { tenantId: string; cultureId: string }): Promise<Row[]> {
  return (await tx.query(`SELECT ${ISOLATE_COLS} FROM micro.isolates WHERE tenant_id = $1 AND culture_id = $2 ORDER BY isolate_seq`, [a.tenantId, a.cultureId])).rows;
}
/** The (specimen, number) key is unique across the specimen's cultures, so a number can already be taken by another culture's isolate. */
export async function isolateBySpecimenSeq(tx: Q, a: { tenantId: string; specimenId: string; seq: number }): Promise<Row | undefined> {
  return (await tx.query(`SELECT ${ISOLATE_COLS} FROM micro.isolates WHERE tenant_id = $1 AND specimen_id = $2 AND isolate_seq = $3`, [a.tenantId, a.specimenId, a.seq])).rows[0];
}
/** counter = greatest(counter, seq): the next manual isolate never reuses an instrument-created number (TRD §4.8 step 5). */
export async function raiseCounter(tx: Q, a: { tenantId: string; specimenId: string; seq: number; userId: string }): Promise<void> {
  await tx.query(
    `INSERT INTO micro.specimen_isolate_counters (tenant_id, specimen_id, last_seq, created_by, updated_by) VALUES ($1, $2, $3, $4, $4)
     ON CONFLICT (tenant_id, specimen_id) DO UPDATE SET last_seq = GREATEST(specimen_isolate_counters.last_seq, EXCLUDED.last_seq), updated_at = now(), updated_by = $4`,
    [a.tenantId, a.specimenId, a.seq, a.userId]);
}
export async function insertInstrumentIsolate(tx: Q, a: { id: string; tenantId: string; centreId: string; cultureId: string; specimenId: string; seq: number; organismCode: string | null; at: Date; userId: string }): Promise<Row> {
  const identified = a.organismCode !== null;
  return (await tx.query(
    `INSERT INTO micro.isolates (id, tenant_id, centre_id, culture_id, specimen_id, isolate_seq, status, organism_code, organism_source, identified_at, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11) RETURNING ${ISOLATE_COLS}`,
    [a.id, a.tenantId, a.centreId, a.cultureId, a.specimenId, a.seq, identified ? 'identified' : 'pending_id', a.organismCode, identified ? 'instrument' : null, identified ? a.at : null, a.userId])).rows[0]!;
}
/** pending_id -> identified, or a replacement of a different organism (use_instrument / an earlier instrument identification): organism_source = instrument, version-guarded. */
export async function identifyByInstrument(tx: Q, a: { tenantId: string; id: string; expectedVersion: number; organismCode: string; at: Date; userId: string }): Promise<Row | undefined> {
  return (await tx.query(
    `UPDATE micro.isolates SET status = 'identified', organism_code = $4, organism_source = 'instrument', identified_at = $5, identified_by_membership_id = NULL,
            version = version + 1, updated_at = now(), updated_by = $6
      WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING ${ISOLATE_COLS}`, [a.tenantId, a.id, a.expectedVersion, a.organismCode, a.at, a.userId])).rows[0];
}

// ---------------------------------------------------------------- AST (step 6)
const AST_COLS = 'id, version, isolate_id, antibiotic_code, method, raw_value, source, instrument_result_time, off_panel, panel_sort_order';
export async function findAst(tx: Q, a: { tenantId: string; isolateId: string; antibioticCode: string; method: string }): Promise<Row | undefined> {
  return (await tx.query(`SELECT ${AST_COLS} FROM micro.ast_results WHERE tenant_id = $1 AND isolate_id = $2 AND antibiotic_code = $3 AND method = $4 FOR UPDATE`,
    [a.tenantId, a.isolateId, a.antibioticCode, a.method])).rows[0];
}
export async function panelPosition(tx: Q, a: { tenantId: string; panelId: string; antibioticCode: string }): Promise<Row | undefined> {
  return (await tx.query('SELECT sort_order FROM micro.ast_panel_antibiotics WHERE tenant_id = $1 AND panel_id = $2 AND antibiotic_code = $3 LIMIT 1', [a.tenantId, a.panelId, a.antibioticCode])).rows[0];
}
export interface AstValues {
  rawValue: string; rawQualifier: string | null; rawNumeric: string | null; unitCode: string | null; categoryCode: string | null; standard: string | null; standardVersion: string | null;
  standardSource: string | null; interpretationRaw: string | null; interpretationSource: string | null; instrumentRecordId: string; instrumentId: string; resultTime: string | null;
}
export async function insertInstrumentAst(tx: Q, a: { id: string; tenantId: string; centreId: string; cultureId: string; isolateId: string; antibioticCode: string; method: string; v: AstValues; offPanel: boolean; sortOrder: number | null; userId: string }): Promise<Row> {
  const v = a.v;
  return (await tx.query(
    `INSERT INTO micro.ast_results (id, tenant_id, centre_id, culture_id, isolate_id, antibiotic_code, method, raw_value, raw_qualifier, raw_numeric, unit_code, category_code, standard, standard_version,
            standard_source, interpretation_raw, interpretation_source, source, instrument_record_id, instrument_id, instrument_result_time, off_panel, panel_sort_order, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'instrument', $18, $19, $20, $21, $22, $23, $23) RETURNING ${AST_COLS}`,
    [a.id, a.tenantId, a.centreId, a.cultureId, a.isolateId, a.antibioticCode, a.method, v.rawValue, v.rawQualifier, v.rawNumeric, v.unitCode, v.categoryCode, v.standard, v.standardVersion,
      v.standardSource, v.interpretationRaw, v.interpretationSource, v.instrumentRecordId, v.instrumentId, v.resultTime, a.offPanel, a.sortOrder, a.userId])).rows[0]!;
}
/** Replace the value of an existing row (instrument rerun, empty panel placeholder, or use_instrument over a manual value — the DB audit trigger records old/new). */
export async function replaceWithInstrumentAst(tx: Q, a: { tenantId: string; id: string; expectedVersion: number; v: AstValues; userId: string }): Promise<Row | undefined> {
  const v = a.v;
  return (await tx.query(
    `UPDATE micro.ast_results SET raw_value = $4, raw_qualifier = $5, raw_numeric = $6, unit_code = $7, category_code = $8, standard = $9, standard_version = $10, standard_source = $11,
            interpretation_raw = $12, interpretation_source = $13, source = 'instrument', instrument_record_id = $14, instrument_id = $15, instrument_result_time = $16,
            breakpoint_set_id = NULL, breakpoint_band_id = NULL, suggestion_overridden = FALSE, version = version + 1, updated_at = now(), updated_by = $17
      WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING ${AST_COLS}`,
    [a.tenantId, a.id, a.expectedVersion, v.rawValue, v.rawQualifier, v.rawNumeric, v.unitCode, v.categoryCode, v.standard, v.standardVersion, v.standardSource, v.interpretationRaw,
      v.interpretationSource, v.instrumentRecordId, v.instrumentId, v.resultTime, a.userId])).rows[0];
}

// ---------------------------------------------------------------- M33–M36
const MAP_COLS = 'id, version, instrument_id, kind, code_raw, local_code, is_active, created_at, updated_at';
export async function listMaps(tx: Q, a: { tenantId: string; instrumentId?: string; kind?: string; isActive?: boolean; afterId?: string; limit: number }): Promise<Row[]> {
  const params: unknown[] = [a.tenantId];
  const where = ['tenant_id = $1'];
  const add = (sql: string, v: unknown): void => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (a.instrumentId !== undefined) add('instrument_id = ?', a.instrumentId);
  if (a.kind !== undefined) add('kind = ?', a.kind);
  if (a.isActive !== undefined) add('is_active = ?', a.isActive);
  if (a.afterId !== undefined) add('id > ?::uuid', a.afterId);
  params.push(a.limit + 1);
  return (await tx.query(`SELECT ${MAP_COLS} FROM micro.instrument_vocab_maps WHERE ${where.join(' AND ')} ORDER BY id LIMIT $${params.length}`, params)).rows;
}
export async function getMap(tx: Q, a: { tenantId: string; id: string; forUpdate?: boolean }): Promise<Row | undefined> {
  return (await tx.query(`SELECT ${MAP_COLS} FROM micro.instrument_vocab_maps WHERE tenant_id = $1 AND id = $2${a.forUpdate ? ' FOR UPDATE' : ''}`, [a.tenantId, a.id])).rows[0];
}
export async function insertMap(tx: Q, a: { id: string; tenantId: string; instrumentId: string; kind: string; codeRaw: string; localCode: string; userId: string }): Promise<Row> {
  return (await tx.query(
    `INSERT INTO micro.instrument_vocab_maps (id, tenant_id, instrument_id, kind, code_raw, local_code, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING ${MAP_COLS}`,
    [a.id, a.tenantId, a.instrumentId, a.kind, a.codeRaw, a.localCode, a.userId])).rows[0]!;
}
export async function updateMap(tx: Q, a: { tenantId: string; id: string; expectedVersion: number; localCode: string; userId: string }): Promise<Row | undefined> {
  return (await tx.query(
    `UPDATE micro.instrument_vocab_maps SET local_code = $4, version = version + 1, updated_at = now(), updated_by = $5 WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING ${MAP_COLS}`,
    [a.tenantId, a.id, a.expectedVersion, a.localCode, a.userId])).rows[0];
}
export async function deactivateMap(tx: Q, a: { tenantId: string; id: string; expectedVersion: number; userId: string }): Promise<Row | undefined> {
  return (await tx.query(
    `UPDATE micro.instrument_vocab_maps SET is_active = FALSE, version = version + 1, updated_at = now(), updated_by = $4 WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING ${MAP_COLS}`,
    [a.tenantId, a.id, a.expectedVersion, a.userId])).rows[0];
}

// ---------------------------------------------------------------- M37–M38
const DEFAULT_COLS = 'instrument_id, standard, standard_version, version';
export async function listDefaults(tx: Q, a: { tenantId: string }): Promise<Row[]> {
  return (await tx.query(`SELECT ${DEFAULT_COLS} FROM micro.instrument_ast_defaults WHERE tenant_id = $1 AND is_active ORDER BY instrument_id LIMIT 200`, [a.tenantId])).rows;
}
export async function getDefault(tx: Q, a: { tenantId: string; instrumentId: string }): Promise<Row | undefined> {
  return (await tx.query(`SELECT ${DEFAULT_COLS} FROM micro.instrument_ast_defaults WHERE tenant_id = $1 AND instrument_id = $2 FOR UPDATE`, [a.tenantId, a.instrumentId])).rows[0];
}
/** undefined = a concurrent request created the row first (409). The composite FK rejects an unknown / foreign instrument (23503). */
export async function insertDefault(tx: Q, a: { id: string; tenantId: string; instrumentId: string; standard: string; standardVersion: string; userId: string }): Promise<Row | undefined> {
  return (await tx.query(
    `INSERT INTO micro.instrument_ast_defaults (id, tenant_id, instrument_id, standard, standard_version, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $6)
     ON CONFLICT (tenant_id, instrument_id) DO NOTHING RETURNING ${DEFAULT_COLS}`, [a.id, a.tenantId, a.instrumentId, a.standard, a.standardVersion, a.userId])).rows[0];
}
export async function updateDefault(tx: Q, a: { tenantId: string; instrumentId: string; expectedVersion: number; standard: string; standardVersion: string; userId: string }): Promise<Row | undefined> {
  return (await tx.query(
    `UPDATE micro.instrument_ast_defaults SET standard = $4, standard_version = $5, is_active = TRUE, version = version + 1, updated_at = now(), updated_by = $6
      WHERE tenant_id = $1 AND instrument_id = $2 AND version = $3 RETURNING ${DEFAULT_COLS}`,
    [a.tenantId, a.instrumentId, a.expectedVersion, a.standard, a.standardVersion, a.userId])).rows[0];
}
