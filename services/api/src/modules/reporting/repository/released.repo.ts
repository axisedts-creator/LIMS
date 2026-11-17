// Read-only SQL for ReportingPort.getReleasedReports / openReleasedReportFile (03-IC §4.7). Single-table, parameterised, tenant_id on every statement.
// Partner / patient / centre scoping is RLS (05-SCHEMA §4 `__partner`, `__patient`), never an app-side filter. No joins: panel names come from a second keyed read.
type Row = Record<string, any>;
type Tx = { query(sql: string, values?: unknown[]): Promise<{ rows: Row[] }> };

export type ScopeColumn = 'order_id' | 'patient_id' | 'partner_id' | 'centre_id';
export interface ListQuery {
  column: ScopeColumn; value: string; includeSuperseded: boolean; from?: string; to?: string;
  after?: { releasedAt: string; id: string }; limit: number;
}

const LIST = `SELECT id, report_id, version_no, order_id, patient_id, report_kind, status, released_at, smart_summary_id
  FROM reporting.report_versions WHERE tenant_id = $1 AND status IN ($2, $3)`;

/** Keyset order (released_at, id) matches report_versions__tenant_id_released_at__p_idx. Column names come from the ScopeColumn union only. */
export async function listVersions(tx: Tx, tenantId: string, q: ListQuery): Promise<Row[]> {
  const values: unknown[] = [tenantId, 'released', q.includeSuperseded ? 'superseded' : 'released', q.value];
  let sql = `${LIST} AND ${q.column} = $4`;
  if (q.from) sql += ` AND released_at >= $${values.push(q.from)}::timestamptz`;
  if (q.to) sql += ` AND released_at <= $${values.push(q.to)}::timestamptz`;
  if (q.after) sql += ` AND (released_at, id) > ($${values.push(q.after.releasedAt)}::timestamptz, $${values.push(q.after.id)}::uuid)`;
  sql += ` ORDER BY released_at, id LIMIT $${values.push(q.limit)}`;
  return (await tx.query(sql, values)).rows;
}

export async function panelNamesByVersion(tx: Tx, tenantId: string, versionIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (versionIds.length === 0) return out;
  const rows = (await tx.query(`SELECT report_version_id, panel_names_snapshot FROM reporting.qr_tokens WHERE tenant_id = $1 AND report_version_id = ANY($2::uuid[])`,
    [tenantId, versionIds])).rows;
  for (const r of rows) if (!out.has(r['report_version_id'])) out.set(r['report_version_id'], Array.isArray(r['panel_names_snapshot']) ? r['panel_names_snapshot'] : []);
  return out;
}

export async function findReleasedVersionFile(tx: Tx, tenantId: string, reportId: string, versionNo: number): Promise<Row | undefined> {
  return (await tx.query(`SELECT id, report_id, version_no, status, pdf_object_path, pdf_sha256, pdf_bytes, smart_summary_json FROM reporting.report_versions
    WHERE tenant_id = $1 AND report_id = $2 AND version_no = $3 AND status IN ('released', 'superseded')`, [tenantId, reportId, versionNo])).rows[0];
}
