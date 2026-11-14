// T-26 reads/writes behind service/worklist.service.ts: worklist (#18), pending (#19), worksheet create/list/get (#20-#22). 02-TRD §5.3; 05-SCHEMA lab.worksheets / worksheet_items.
// REQ-SEC-024: tenant_id = $1 from the ctx on every statement (see base.repo.query). Values are bound parameters; sort / filters are fixed SQL fragments, never caller text.
// worksheet_items is append-only (no UPDATE grant, 08 R3): there is no update or delete function here on purpose (snapshot immutability).
import { insertRow, isUuid, limitOf, query, first, table, type RepoCtx, type Row } from './base.repo.js';

const worksheets = table('lab.worksheets', 'id', ['id', 'tenant_id', 'centre_id', 'processing_centre_id', 'title', 'department_id', 'instrument_id', 'item_count', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by']);
const worksheetItems = table('lab.worksheet_items', 'id', ['id', 'tenant_id', 'centre_id', 'processing_centre_id', 'worksheet_id', 'position', 'order_test_id', 'specimen_id', 'snapshot', 'created_at', 'created_by']);

/** One joined order-test row (specimen barcode, order registration_no / patient / registered_at, result counts). */
const JOINED = `SELECT ot.id, ot.tenant_id, ot.order_id, ot.specimen_id, s.barcode, o.registration_no, o.patient_id, o.registered_at, ot.test_id, ot.test_code, ot.catalog_revision,
    ot.priority, ot.status, ot.received_at, ot.ordered_at, ot.tat_target_seconds, ot.centre_id, ot.processing_centre_id, ot.department_id,
    (SELECT count(*)::int FROM lab.results r WHERE r.tenant_id = ot.tenant_id AND r.order_test_id = ot.id) AS result_total,
    (SELECT count(*)::int FROM lab.results r WHERE r.tenant_id = ot.tenant_id AND r.order_test_id = ot.id AND r.status IN ('resulted','verified','approved')) AS result_resulted,
    (SELECT count(*)::int FROM lab.results r WHERE r.tenant_id = ot.tenant_id AND r.order_test_id = ot.id AND r.status IN ('verified','approved')) AS result_verified
  FROM lab.order_tests ot JOIN lab.orders o ON o.tenant_id = ot.tenant_id AND o.id = ot.order_id LEFT JOIN lab.specimens s ON s.tenant_id = ot.tenant_id AND s.id = ot.specimen_id`;

interface Filter { departmentId?: string; priority?: string; statuses: readonly string[]; scopeCentreIds?: readonly string[]; limit: number; after?: { key: string; id: string } }

/** Shared WHERE pieces; $1 = tenant. Returns the clause list and the values appended after $1. */
function where(f: Filter & { processingCentreId?: string; centreId?: string }): { sql: string[]; v: unknown[] } {
  const sql = ['ot.tenant_id = $1', 'ot.is_active = true'], v: unknown[] = [];
  const bind = (x: unknown) => { v.push(x); return `$${v.length + 1}`; };
  sql.push(`ot.status = ANY(${bind(f.statuses)}::text[])`);
  if (f.departmentId !== undefined) sql.push(`ot.department_id = ${bind(f.departmentId)}`);
  if (f.priority !== undefined) sql.push(`ot.priority = ${bind(f.priority)}`);
  if (f.processingCentreId !== undefined) sql.push(`ot.processing_centre_id = ${bind(f.processingCentreId)}`);
  if (f.centreId !== undefined) sql.push(`ot.centre_id = ${bind(f.centreId)}`);
  if (f.scopeCentreIds) { const p = bind(f.scopeCentreIds); sql.push(`(ot.centre_id = ANY(${p}::uuid[]) OR ot.processing_centre_id = ANY(${p}::uuid[]))`); }   // REQ-SEC-017
  return { sql, v };
}

/** #18. sort = priority_received (urgent first, then received_at, id) | received_at. Keyset `after.key` = "<rank>|<iso>" for the first, "0|<iso>" for the second. */
export async function listWorklistRows(rc: RepoCtx, a: Filter & { processingCentreId?: string; sort: 'priority_received' | 'received_at' }): Promise<Row[]> {
  const limit = limitOf(a.limit);
  const { sql, v } = where(a);
  const at = 'COALESCE(ot.received_at, ot.ordered_at)';
  const rank = a.sort === 'priority_received' ? `(CASE WHEN ot.priority = 'urgent' THEN 0 ELSE 1 END)` : '0';
  if (a.after) {
    const [r, iso] = a.after.key.split('|');
    if (!isUuid(a.after.id) || !iso || (r !== '0' && r !== '1')) return [];
    v.push(Number(r), iso, a.after.id);
    sql.push(`(${rank}, ${at}, ot.id) > ($${v.length - 1}::int, $${v.length}::timestamptz, $${v.length + 1}::uuid)`);
  }
  v.push(limit);
  return query(rc, `${JOINED} WHERE ${sql.join(' AND ')} ORDER BY ${rank}, ${at}, ot.id LIMIT $${v.length + 1}`, v);
}

/** #19. Oldest ordered first; overTarget = age beyond tat_target_seconds (age anchor: registered for awaiting_*, received otherwise — same rule as the handler). */
export async function listPendingRows(rc: RepoCtx, a: Filter & { centreId?: string; overTarget?: true; now: Date }): Promise<Row[]> {
  const limit = limitOf(a.limit);
  const { sql, v } = where(a);
  if (a.overTarget) {
    v.push(a.now.toISOString());
    sql.push(`ot.tat_target_seconds IS NOT NULL AND EXTRACT(EPOCH FROM ($${v.length + 1}::timestamptz - CASE WHEN ot.status LIKE 'awaiting%' THEN o.registered_at ELSE ot.received_at END)) > ot.tat_target_seconds`);
  }
  if (a.after) {
    if (!isUuid(a.after.id)) return [];
    v.push(a.after.key, a.after.id);
    sql.push(`(ot.ordered_at, ot.id) > ($${v.length}::timestamptz, $${v.length + 1}::uuid)`);
  }
  v.push(limit);
  return query(rc, `${JOINED} WHERE ${sql.join(' AND ')} ORDER BY ot.ordered_at, ot.id LIMIT $${v.length + 1}`, v);
}

/** #20: the selected order tests (unknown / other-tenant ids simply do not come back). */
export const getOrderTestsForWorksheet = async (rc: RepoCtx, ids: readonly string[]): Promise<Row[]> =>
  (ids.length === 0 || !ids.every(isUuid) ? [] : query(rc, `${JOINED} WHERE ot.tenant_id = $1 AND ot.id = ANY($2::uuid[])`, [ids]));

/** #20: header + items in the caller's transaction (all or nothing). Items are append-only. */
export async function insertWorksheet(rc: RepoCtx, a: { worksheet: Row; items: Row[] }): Promise<{ worksheet: Row; items: Row[] }> {
  const { created_by: _h, ...head } = a.worksheet;      // created_by / tenant_id come from the ctx (insertRow), never from the argument
  const worksheet = await insertRow(rc, worksheets, head);
  const items: Row[] = [];
  for (const { created_by: _i, ...item } of a.items) items.push(await insertRow(rc, worksheetItems, item));
  return { worksheet, items };
}

/** #21: newest first; keyset on (created_at, id) descending. */
export async function listWorksheets(rc: RepoCtx, a: { createdAtFrom?: string; createdAtTo?: string; departmentId?: string; scopeCentreIds?: readonly string[]; limit: number; after?: { key: string; id: string } }): Promise<Row[]> {
  const limit = limitOf(a.limit);
  const sql = ['w.tenant_id = $1', 'w.is_active = true'], v: unknown[] = [];
  const bind = (x: unknown) => { v.push(x); return `$${v.length + 1}`; };
  if (a.createdAtFrom) sql.push(`w.created_at >= ${bind(a.createdAtFrom)}::timestamptz`);
  if (a.createdAtTo) sql.push(`w.created_at <= ${bind(a.createdAtTo)}::timestamptz`);
  if (a.departmentId) sql.push(`w.department_id = ${bind(a.departmentId)}`);
  if (a.scopeCentreIds) { const p = bind(a.scopeCentreIds); sql.push(`(w.centre_id = ANY(${p}::uuid[]) OR w.processing_centre_id = ANY(${p}::uuid[]))`); }
  if (a.after) {
    if (!isUuid(a.after.id)) return [];
    const k = bind(a.after.key), i = bind(a.after.id);
    sql.push(`(w.created_at, w.id) < (${k}::timestamptz, ${i}::uuid)`);
  }
  const l = bind(limit);
  return query(rc, `SELECT w.* FROM lab.worksheets w WHERE ${sql.join(' AND ')} ORDER BY w.created_at DESC, w.id DESC LIMIT ${l}`, v);
}

/** #22: the header and its stored items (the snapshot), never the live order tests. */
export async function getWorksheet(rc: RepoCtx, id: string): Promise<{ worksheet: Row; items: Row[] } | undefined> {
  if (!isUuid(id)) return undefined;
  const worksheet = await first(rc, 'SELECT * FROM lab.worksheets WHERE tenant_id = $1 AND id = $2', [id]);
  if (!worksheet) return undefined;
  return { worksheet, items: await query(rc, 'SELECT * FROM lab.worksheet_items WHERE tenant_id = $1 AND worksheet_id = $2 ORDER BY position', [id]) };
}
