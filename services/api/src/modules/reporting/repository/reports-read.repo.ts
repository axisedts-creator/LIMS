// C6-T15 — SQL for the staff read endpoints R1-R5 (02-TRD §6.1/§6.2). Parameters only; every statement binds tenant_id (REQ-SEC-024); centre scoping is the
// `__tenant_centre` RLS policy on the connection. Explicit column lists: content_snapshot (P3), hashes and patient_id are never selected for responses.
// `{token}`s are replaced from CLOSED constant maps below (column / operator names), never from request data; values are $n parameters.
type Tx = { query(sql: string, values: unknown[]): Promise<{ rows: any[] }> };

const REPORT_COLS = `id, order_id, family, centre_id, state, registration_no, patient_display_name, centre_code, referrer_name, latest_version_no, released_version_no,
  billing_balance_due_paisa, registered_at, first_released_at, updated_at, version, needs_assembly, review_flag`;
const VERSION_COLS = `id, version_no, status, report_kind, completeness, page_count, pdf_bytes, rendered_at, released_at, release_basis, audiences,
  supersedes_version_no, superseded_at, held_basis, held_checked_at, last_render_error_code, version`;
const cols = (sql: string) => sql.replaceAll('{rc}', REPORT_COLS).replaceAll('{vc}', VERSION_COLS);

/** Sort -> [column, keyset comparison (inclusive, strict), direction]. Keyset `(c, id) < (k, i)` is written `c <= k AND (c < k OR id < i)`: same predicate, plain atoms. */
const SORT = {
  updated_at: { c: 'updated_at', le: '<=', lt: '<', dir: 'DESC', nn: '' },
  registered_at: { c: 'registered_at', le: '>=', lt: '>', dir: 'ASC', nn: '' },
  first_released_at: { c: 'first_released_at', le: '<=', lt: '<', dir: 'DESC', nn: 'AND first_released_at IS NOT NULL' },
} as const;
const PAGE = `SELECT {rc}, to_char({c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_key FROM reporting.reports WHERE tenant_id = $1
  AND ($2::text IS NULL OR family = $2::text)
  AND ($3::uuid IS NULL OR centre_id = $3::uuid)
  AND ($4::timestamptz IS NULL OR registered_at >= $4::timestamptz)
  AND ($5::timestamptz IS NULL OR registered_at < $5::timestamptz)
  AND ($6::timestamptz IS NULL OR first_released_at >= $6::timestamptz)
  AND ($7::timestamptz IS NULL OR first_released_at < $7::timestamptz)
  AND ($8::boolean IS NULL OR review_flag IS NOT NULL)
  AND ($9::boolean IS NULL OR review_flag IS NULL)
  AND ($10::timestamptz IS NULL OR {c} {le} $10::timestamptz)
  AND ($10::timestamptz IS NULL OR {c} {lt} $10::timestamptz OR id {lt} $11::uuid)
  {nn}
  ORDER BY {c} {dir}, id {dir} LIMIT $12`;

export interface ReportFilter {
  family?: string; centreId?: string; registeredFrom?: string; registeredTo?: string; releasedFrom?: string; releasedTo?: string; reviewFlag?: boolean;
  sortCol: keyof typeof SORT; after?: { k: string; i: string };
}

/** One keyset page of reports (R1). */
export async function selectReportPage(tx: Tx, tenantId: string, f: ReportFilter, limit: number): Promise<any[]> {
  const s = SORT[f.sortCol];
  const sql = cols(PAGE).replaceAll('{c}', s.c).replaceAll('{le}', s.le).replaceAll('{lt}', s.lt).replaceAll('{dir}', s.dir).replaceAll('{nn}', s.nn);
  return (await tx.query(sql, [tenantId, f.family ?? null, f.centreId ?? null, f.registeredFrom ?? null, f.registeredTo ?? null, f.releasedFrom ?? null, f.releasedTo ?? null,
    f.reviewFlag === true ? true : null, f.reviewFlag === false ? true : null, f.after?.k ?? null, f.after?.i ?? null, limit])).rows;
}

const BY = { registration_no: 'registration_no = $2', order_id: 'order_id = $2', patient_id: 'patient_id = $2', order_ids: 'order_id = ANY($2::uuid[])' } as const;
/** R2: one lookup key (registration_no | order_id | patient_id | order_ids from a barcode), newest first, at most `limit` rows. */
export async function selectReportsBy(tx: Tx, tenantId: string, key: keyof typeof BY, value: unknown, limit: number): Promise<any[]> {
  return (await tx.query(cols('SELECT {rc} FROM reporting.reports WHERE tenant_id = $1 AND {w} ORDER BY updated_at DESC LIMIT $3').replace('{w}', BY[key]), [tenantId, value, limit])).rows;
}

export async function selectReportById(tx: Tx, tenantId: string, id: string): Promise<any | undefined> {
  return (await tx.query(cols('SELECT {rc} FROM reporting.reports WHERE tenant_id = $1 AND id = $2'), [tenantId, id])).rows[0];
}

/** Minimal version columns to derive display_status for a set of reports (no snapshot, no hashes). */
export async function selectVersionStates(tx: Tx, tenantId: string, reportIds: string[]): Promise<any[]> {
  return (await tx.query(`SELECT report_id, version_no, status, held_basis FROM reporting.report_versions
    WHERE tenant_id = $1 AND report_id = ANY($2::uuid[]) AND status <> 'discarded'`, [tenantId, reportIds])).rows;
}

export async function selectItemFlags(tx: Tx, tenantId: string, reportIds: string[]): Promise<any[]> {
  return (await tx.query(`SELECT report_id, order_item_id, orderable_kind, item_status, requires_lab, requires_narrative, requires_outsourced, lab_ready, narrative_ready, outsourced_ready
    FROM reporting.report_order_items WHERE tenant_id = $1 AND report_id = ANY($2::uuid[])`, [tenantId, reportIds])).rows;
}

export async function selectVersionsOfReport(tx: Tx, tenantId: string, reportId: string): Promise<any[]> {
  return (await tx.query(cols(`SELECT {vc} FROM reporting.report_versions
    WHERE tenant_id = $1 AND report_id = $2 AND status <> 'discarded' ORDER BY version_no DESC`), [tenantId, reportId])).rows;
}

export async function selectDeliveryStatuses(tx: Tx, tenantId: string, reportId: string): Promise<any[]> {
  return (await tx.query('SELECT status FROM reporting.deliveries WHERE tenant_id = $1 AND report_id = $2', [tenantId, reportId])).rows;   // ponytail: counted in memory (one row per delivery attempt of ONE report); GROUP BY when a report has hundreds
}

/** R4 / R5: the version, never discarded. pdf_object_path is read for R5 only and never mapped. */
export async function selectVersionById(tx: Tx, tenantId: string, id: string): Promise<any | undefined> {
  return (await tx.query(cols(`SELECT {vc}, centre_id, pdf_object_path FROM reporting.report_versions WHERE tenant_id = $1 AND id = $2 AND status <> 'discarded'`), [tenantId, id])).rows[0];
}
