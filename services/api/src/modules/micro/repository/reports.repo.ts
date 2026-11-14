// Reads and writes of M14 submitCultureReport (02-TRD §4.7; 05-SCHEMA §8 report_versions, cultures). REQ-SEC-024: every statement binds tenant_id besides RLS. Static SQL only; values are parameters.
// Single-table, equality-only reads on purpose: what goes into a snapshot is decided in domain/snapshot.ts, never by a SQL predicate. report_versions is INSERT-only (no UPDATE grant, AC-09.5).
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;
type Row = Record<string, any>;

/** The culture, locked for the whole submission (serialises parallel submissions; no If-Match on M14). RLS applies the centre scope. */
export async function lockCulture(tx: Q, a: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `SELECT id, version, status, centre_id, order_id, order_item_id, outcome_code, planted_at, final_due_at, current_report_version_no, last_report_phase,
            amendment_reason_code, amendment_reason_text
       FROM micro.cultures WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [a.tenantId, a.id]);
  return rows[0];
}

type Key = { tenantId: string; cultureId: string };
const child = async (tx: Q, sql: string, k: Key): Promise<Row[]> => (await tx.query(sql, [k.tenantId, k.cultureId])).rows;

export const listIsolates = (tx: Q, k: Key): Promise<Row[]> => child(tx,
  'SELECT id, isolate_seq, status, organism_code, plate_id, quantity_text, is_reportable FROM micro.isolates WHERE tenant_id = $1 AND culture_id = $2 ORDER BY isolate_seq', k);
export const listAst = (tx: Q, k: Key): Promise<Row[]> => child(tx,
  `SELECT id, isolate_id, antibiotic_code, method, raw_value, category_code, standard, standard_version, is_reportable, report_visibility, panel_sort_order
     FROM micro.ast_results WHERE tenant_id = $1 AND culture_id = $2 ORDER BY id`, k);
export const listObservations = (tx: Q, k: Key): Promise<Row[]> => child(tx,
  `SELECT id, kind, plate_id, growth_code, finding_text, observed_at, hours_since_planting::text AS hours_since_planting, corrects_observation_id
     FROM micro.culture_observations WHERE tenant_id = $1 AND culture_id = $2 ORDER BY observed_at, id`, k);

/** The phase of one stored version (the last approved phase = the row whose version_no is the approved moduleRef.versionNo, 02-TRD §4.7). */
export async function versionPhase(tx: Q, a: Key & { versionNo: number }): Promise<string | undefined> {
  const { rows } = await tx.query('SELECT version_no, report_phase FROM micro.report_versions WHERE tenant_id = $1 AND culture_id = $2 AND version_no = $3', [a.tenantId, a.cultureId, a.versionNo]);
  return rows[0]?.['report_phase'];
}

/** Rows of a resolved (tenant-over-global) coded-set view, active or not (the caller decides). `$2` pins the view's claims tenant to ctx.tenantId. */
export async function viewRows(tx: Q, a: { view: 'v_organisms' | 'v_antibiotics' | 'v_growth_codes' | 'v_culture_outcomes'; tenantId: string; codes: string[] }): Promise<Map<string, Row>> {
  if (a.codes.length === 0) return new Map();
  const cols = { v_organisms: 'code, display, is_active', v_antibiotics: 'code, display, is_active', v_growth_codes: 'code, display, is_active, indicates_growth',
    v_culture_outcomes: 'code, display, is_active, result_flag, requires_isolate' }[a.view];
  const { rows } = await tx.query(`SELECT ${cols} FROM micro.${a.view} WHERE code = ANY($1::text[]) AND (SELECT app.current_tenant_id()) = $2::uuid`, [a.codes, a.tenantId]);
  return new Map(rows.map((r: Row) => [r['code'], r]));
}

export interface NewVersion {
  id: string; tenantId: string; centreId: string; cultureId: string; orderItemId: string; versionNo: number; phase: 'preliminary' | 'final'; kind: 'initial' | 'update' | 'amendment';
  submissionKind: string; outcomeCode: string | null; earlyFinalReason: string | null; amendmentReasonCode: string | null; amendmentReasonText: string | null;
  summary: string; isolates: unknown[]; ast: unknown[]; comments: string | null; isCritical: boolean; flag: string; membershipId: string; signedAt: Date;
  labResultId: string; labResultVersionNo: number; labStatus: string; labReplayed: boolean; userId: string;
}
export async function insertVersion(tx: Q, v: NewVersion): Promise<void> {
  await tx.query(
    `INSERT INTO micro.report_versions (id, tenant_id, centre_id, culture_id, order_item_id, version_no, report_phase, version_kind, submission_kind, outcome_code, early_final_reason,
        amendment_reason_code, amendment_reason_text, culture_summary_text, isolates, ast, comments_text, is_critical, flag, signed_by_membership_id, signed_at,
        lab_result_id, lab_result_version_no, lab_status_at_submit, lab_replayed, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)`,
    [v.id, v.tenantId, v.centreId, v.cultureId, v.orderItemId, v.versionNo, v.phase, v.kind, v.submissionKind, v.outcomeCode, v.earlyFinalReason, v.amendmentReasonCode, v.amendmentReasonText,
      v.summary, JSON.stringify(v.isolates), JSON.stringify(v.ast), v.comments, v.isCritical, v.flag, v.membershipId, v.signedAt, v.labResultId, v.labResultVersionNo, v.labStatus, v.labReplayed, v.userId]);
}

/** After the version row: the counters; a final also sets outcome_code and the status (C5/C6). The row is locked by this transaction, so no version guard is needed. */
export async function updateAfterSubmit(tx: Q, a: { tenantId: string; id: string; versionNo: number; phase: 'preliminary' | 'final'; status: string; outcomeCode: string | null; userId: string }): Promise<void> {
  if (a.phase === 'final') {
    await tx.query(
      `UPDATE micro.cultures SET current_report_version_no = $3, last_report_phase = $4, status = $5, outcome_code = $6, version = version + 1, updated_at = now(), updated_by = $7
        WHERE tenant_id = $1 AND id = $2`, [a.tenantId, a.id, a.versionNo, a.phase, a.status, a.outcomeCode, a.userId]);
    return;
  }
  await tx.query(
    `UPDATE micro.cultures SET current_report_version_no = $3, last_report_phase = $4, version = version + 1, updated_at = now(), updated_by = $5
      WHERE tenant_id = $1 AND id = $2`, [a.tenantId, a.id, a.versionNo, a.phase, a.userId]);
}
