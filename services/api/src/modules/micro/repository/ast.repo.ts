// micro.ast_panels / ast_panel_antibiotics / ast_results statements of M11, M12, M29–M32 (02-TRD §4.2–4.4, §5; 05-SCHEMA §8; 06-IMPLEMENTATION-PLAN T-10).
// REQ-SEC-024: every statement binds tenant_id explicitly in addition to RLS. Static SQL only; values are always parameters.
// AC-16.1 / S-05: NO statement here writes or returns-by-name `report_visibility` — v1 has no API that sets it, the database default ('shown') applies to every row this module creates.
// [CONV] single-table statements only (no JOIN): the service joins in memory, so 60 entries cost a fixed number of reads (02-TRD §10).
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;
type Row = Record<string, any>;

const PANEL_COLS = 'id, code, version_no, display, organism_code, organism_group_code, specimen_site_code, default_method, superseded_at, version, is_active, created_at, updated_at';
/** AST row columns of the DTO WITHOUT report_visibility (the service carries that value from its own read; see header). */
const RESULT_COLS = `id, version, isolate_id, antibiotic_code, method, raw_value, raw_qualifier, raw_numeric::text AS raw_numeric, unit_code, category_code, standard, standard_version,
  standard_source, interpretation_raw, interpretation_source, breakpoint_set_id, suggestion_overridden, source, instrument_id, instrument_result_time, is_reportable, off_panel, panel_sort_order, entered_at`;

/** `($1, $2), ($3, $4)` style placeholder groups for a multi-row VALUES list. */
const groupsOf = (rows: number, width: number): string =>
  Array.from({ length: rows }, (_, r) => `(${Array.from({ length: width }, (_, c) => `$${r * width + c + 1}`).join(', ')})`).join(', ');

// ================================================================ panels (M11 selection, M29–M32)
/** Current, active panels of the tenant: the input of the 02-TRD §4.2 precedence (pure rule: domain/selection.ts). */
export async function currentPanels(tx: Q, a: { tenantId: string }): Promise<Row[]> {
  return (await tx.query(
    `SELECT id, code, organism_code, organism_group_code, specimen_site_code, is_active, superseded_at FROM micro.ast_panels
      WHERE tenant_id = $1 AND is_active = TRUE AND superseded_at IS NULL ORDER BY code, id`, [a.tenantId])).rows;
}

export async function getPanel(tx: Q, a: { tenantId: string; id: string; forUpdate?: boolean }): Promise<Row | undefined> {
  return (await tx.query(`SELECT ${PANEL_COLS} FROM micro.ast_panels WHERE tenant_id = $1 AND id = $2${a.forUpdate ? ' FOR UPDATE' : ''}`, [a.tenantId, a.id])).rows[0];
}

export async function listPanels(tx: Q, a: { tenantId: string; includeSuperseded: boolean; organismCode?: string | undefined; organismGroupCode?: string | undefined }): Promise<Row[]> {
  const where = ['tenant_id = $1'];
  const params: unknown[] = [a.tenantId];
  if (!a.includeSuperseded) where.push('superseded_at IS NULL');
  if (a.organismCode !== undefined) { params.push(a.organismCode); where.push(`organism_code = $${params.length}`); }
  if (a.organismGroupCode !== undefined) { params.push(a.organismGroupCode); where.push(`organism_group_code = $${params.length}`); }
  return (await tx.query(`SELECT ${PANEL_COLS} FROM micro.ast_panels WHERE ${where.join(' AND ')} ORDER BY code, version_no LIMIT 200`, params)).rows;
}

export async function panelAntibiotics(tx: Q, a: { tenantId: string; panelIds: readonly string[] }): Promise<Row[]> {
  if (a.panelIds.length === 0) return [];
  return (await tx.query(
    `SELECT panel_id, antibiotic_code, sort_order, method, is_reported_default FROM micro.ast_panel_antibiotics
      WHERE tenant_id = $1 AND panel_id = ANY($2::uuid[]) ORDER BY sort_order, id`, [a.tenantId, a.panelIds])).rows;
}

/** Any version of a panel code of the tenant (a current one always exists while the code exists: versioning supersedes then inserts). */
export async function codeTaken(tx: Q, a: { tenantId: string; code: string }): Promise<boolean> {
  return (await tx.query('SELECT id FROM micro.ast_panels WHERE tenant_id = $1 AND code = $2 LIMIT 1', [a.tenantId, a.code])).rows.length > 0;
}

export interface PanelValues { display: string; defaultMethod: string; organismCode: string | null; organismGroupCode: string | null; specimenSiteCode: string | null }
export async function insertPanel(tx: Q, a: { tenantId: string; userId: string; id: string; code: string; versionNo: number; values: PanelValues }): Promise<Row> {
  const v = a.values;
  return (await tx.query(
    `INSERT INTO micro.ast_panels (id, tenant_id, code, version_no, display, organism_code, organism_group_code, specimen_site_code, default_method, created_at, created_by, updated_at, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10, now(), $10) RETURNING ${PANEL_COLS}`,
    [a.id, a.tenantId, a.code, a.versionNo, v.display, v.organismCode, v.organismGroupCode, v.specimenSiteCode, v.defaultMethod, a.userId])).rows[0]!;
}

export interface PanelAntibiotic { id: string; antibioticCode: string; sortOrder: number; method: string | null; isReportedDefault: boolean }
export async function insertPanelAntibiotics(tx: Q, a: { tenantId: string; userId: string; panelId: string; rows: readonly PanelAntibiotic[] }): Promise<void> {
  if (a.rows.length === 0) return;
  const params = a.rows.flatMap((r) => [r.id, a.tenantId, a.panelId, r.antibioticCode, r.sortOrder, r.method, r.isReportedDefault, a.userId, a.userId]);
  await tx.query(
    `INSERT INTO micro.ast_panel_antibiotics (id, tenant_id, panel_id, antibiotic_code, sort_order, method, is_reported_default, created_by, updated_by) VALUES ${groupsOf(a.rows.length, 9)}`, params);
}

/** M31: the current version leaves the precedence (and the partial unique index) BEFORE its successor is inserted. undefined = the version moved. */
export async function supersedePanel(tx: Q, a: { tenantId: string; userId: string; id: string; expectedVersion: number }): Promise<Row | undefined> {
  return (await tx.query(
    `UPDATE micro.ast_panels SET superseded_at = now(), version = version + 1, updated_at = now(), updated_by = $4
      WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING ${PANEL_COLS}`, [a.tenantId, a.id, a.expectedVersion, a.userId])).rows[0];
}

export async function deactivatePanel(tx: Q, a: { tenantId: string; userId: string; id: string; expectedVersion: number }): Promise<Row | undefined> {
  return (await tx.query(
    `UPDATE micro.ast_panels SET is_active = FALSE, version = version + 1, updated_at = now(), updated_by = $4
      WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING ${PANEL_COLS}`, [a.tenantId, a.id, a.expectedVersion, a.userId])).rows[0];
}

// ================================================================ M11
/** The isolate's panel + default method; version-guarded (the caller holds the isolate FOR UPDATE and checked If-Match). */
export async function setIsolatePanel(tx: Q, a: { tenantId: string; id: string; expectedVersion: number; panelId: string; method: string; userId: string }): Promise<Row | undefined> {
  return (await tx.query(
    `UPDATE micro.isolates SET ast_panel_id = $4, ast_method = $5, version = version + 1, updated_at = now(), updated_by = $6
      WHERE tenant_id = $1 AND id = $2 AND version = $3
      RETURNING id, version, culture_id, centre_id, specimen_id, isolate_seq, plate_id, status, organism_code, organism_source, identified_at, colony_description, quantity_text, is_reportable, withdraw_reason_code, ast_panel_id, ast_method`,
    [a.tenantId, a.id, a.expectedVersion, a.panelId, a.method, a.userId])).rows[0];
}

export interface PendingRow { id: string; antibioticCode: string; method: string; isReportable: boolean; sortOrder: number }
/** One pending row per panel antibiotic; a row the isolate already has (isolate, antibiotic, method) is kept as is — re-assigning never overwrites an AST row. */
export async function insertPendingRows(tx: Q, a: { tenantId: string; userId: string; centreId: string; cultureId: string; isolateId: string; rows: readonly PendingRow[] }): Promise<void> {
  if (a.rows.length === 0) return;
  const params = a.rows.flatMap((r) => [r.id, a.tenantId, a.centreId, a.cultureId, a.isolateId, r.antibioticCode, r.method, r.isReportable, false, r.sortOrder, 'manual', a.userId, a.userId]);
  await tx.query(
    `INSERT INTO micro.ast_results (id, tenant_id, centre_id, culture_id, isolate_id, antibiotic_code, method, is_reportable, off_panel, panel_sort_order, source, created_by, updated_by)
     VALUES ${groupsOf(a.rows.length, 13)} ON CONFLICT DO NOTHING`, params);
}

// ================================================================ M12
/** Every AST row of the isolate (one read for all entries). report_visibility is read here, by name, because it is read-only context for the DTO. */
export async function isolateResults(tx: Q, a: { tenantId: string; isolateId: string }): Promise<Row[]> {
  return (await tx.query(`SELECT ${RESULT_COLS}, report_visibility FROM micro.ast_results WHERE tenant_id = $1 AND isolate_id = $2 ORDER BY panel_sort_order, id`, [a.tenantId, a.isolateId])).rows;
}

export async function catalogInterpretations(tx: Q): Promise<Row[]> {
  return (await tx.query('SELECT standard, code, is_active FROM micro.g_cs_ast_interpretations')).rows;
}
export async function catalogRestrictions(tx: Q): Promise<Row[]> {
  return (await tx.query('SELECT standard, antibiotic_code, allowed_codes, is_active FROM micro.g_ast_category_restrictions')).rows;
}

export interface ResultValues {
  rawValue: string | null; rawQualifier: string | null; rawNumeric: string | null; unitCode: string | null; categoryCode: string | null; standard: string | null; standardVersion: string | null;
  standardSource: string | null; interpretationSource: string | null; isReportable: boolean;
}
export async function updateResult(tx: Q, a: { tenantId: string; id: string; expectedVersion: number; v: ResultValues; membershipId: string | null; at: Date; userId: string }): Promise<Row | undefined> {
  const v = a.v;
  return (await tx.query(
    `UPDATE micro.ast_results SET raw_value = $4, raw_qualifier = $5, raw_numeric = $6, unit_code = $7, category_code = $8, standard = $9, standard_version = $10, standard_source = $11,
            interpretation_source = $12, is_reportable = $13, entered_by_membership_id = $14, entered_at = $15, version = version + 1, updated_at = now(), updated_by = $16
      WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING ${RESULT_COLS}`,
    [a.tenantId, a.id, a.expectedVersion, v.rawValue, v.rawQualifier, v.rawNumeric, v.unitCode, v.categoryCode, v.standard, v.standardVersion, v.standardSource, v.interpretationSource,
      v.isReportable, a.membershipId, a.at, a.userId])).rows[0];
}

export async function insertResult(tx: Q, a: {
  tenantId: string; id: string; centreId: string; cultureId: string; isolateId: string; antibioticCode: string; method: string; v: ResultValues; offPanel: boolean; sortOrder: number | null;
  membershipId: string | null; at: Date; userId: string;
}): Promise<Row> {
  const v = a.v;
  return (await tx.query(
    `INSERT INTO micro.ast_results (id, tenant_id, centre_id, culture_id, isolate_id, antibiotic_code, method, raw_value, raw_qualifier, raw_numeric, unit_code, category_code, standard, standard_version,
            standard_source, interpretation_source, is_reportable, off_panel, panel_sort_order, source, entered_by_membership_id, entered_at, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, 'manual', $20, $21, $22, $22) RETURNING ${RESULT_COLS}`,
    [a.id, a.tenantId, a.centreId, a.cultureId, a.isolateId, a.antibioticCode, a.method, v.rawValue, v.rawQualifier, v.rawNumeric, v.unitCode, v.categoryCode, v.standard, v.standardVersion,
      v.standardSource, v.interpretationSource, v.isReportable, a.offPanel, a.sortOrder, a.membershipId, a.at, a.userId])).rows[0]!;
}
