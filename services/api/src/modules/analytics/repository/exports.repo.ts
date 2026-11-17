// analytics.exports / analytics.export_files (05-SCHEMA §exports; 02-TRD §10). Every statement is parameterised and tenant-filtered.
// API side: user transaction (RLS: own rows only). Worker side: system actor (RLS tenant-wide; the explicit predicates are the enforcement).
// The worker only INSERTs export_files and UPDATEs exports; nothing here deletes (purge is AN-T06).

export interface ExportsTx { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> }

export interface ExportRecord {
  id: string; tenant_id: string; requested_by_membership_id: string; report_code: string; format: 'xlsx' | 'csv' | 'pdf'; params: Record<string, unknown>;
  scope_all_centres: boolean; scope_centre_ids: string[]; scope_effective_centre_ids: string[] | null;
  status: 'queued' | 'building' | 'ready' | 'failed' | 'expired'; requested_at: Date | string; building_started_at: Date | string | null;
  ready_at: Date | string | null; expires_at: Date | string | null; row_count: string | number | null; size_bytes: string | number | null; sha256: string | null;
  downloads_allowed: number; downloads_used: number; failure_code: string | null; version: number;
}
export interface ExportFileRecord { content: Uint8Array; content_type: string; sha256: string }

const COLS = `id, tenant_id, requested_by_membership_id, report_code, format, params, scope_all_centres, scope_centre_ids, scope_effective_centre_ids, status,
  requested_at, building_started_at, ready_at, expires_at, row_count, size_bytes, sha256, downloads_allowed, downloads_used, failure_code, version`;

// ------------------------------------------------------------------ request side
/** Serialises quota check + insert per tenant until commit (X16): without it two parallel requests both see 9 and both insert. */
export const lockQuota = (tx: ExportsTx, tenantId: string) =>
  tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`analytics.exports:${tenantId}`]);

export interface QuotaCount { count: number; oldest: Date | null }
const quota = (r: any): QuotaCount => ({ count: Number(r?.count ?? 0), oldest: r?.oldest == null ? null : new Date(r.oldest) });

export async function countUserHour(tx: ExportsTx, a: { tenantId: string; membershipId: string }): Promise<QuotaCount> {
  const { rows } = await tx.query(
    `SELECT count(*) AS count, min(requested_at) AS oldest FROM analytics.exports
      WHERE tenant_id = $1 AND requested_by_membership_id = $2 AND requested_at > now() - interval '1 hour'`, [a.tenantId, a.membershipId]);
  return quota(rows[0]);
}

export async function countTenantDay(tx: ExportsTx, a: { tenantId: string; day: string }): Promise<QuotaCount> {
  const { rows } = await tx.query(
    'SELECT count(*) AS count, min(requested_at) AS oldest FROM analytics.exports WHERE tenant_id = $1 AND requested_on = $2', [a.tenantId, a.day]);
  return quota(rows[0]);
}

export async function insertExport(tx: ExportsTx, a: {
  id: string; tenantId: string; membershipId: string; reportCode: string; format: string; params: unknown; scopeAll: boolean; scopeCentreIds: readonly string[];
  downloadsAllowed: number; actorId: string;
}): Promise<ExportRecord> {
  const { rows } = await tx.query(
    `INSERT INTO analytics.exports (id, tenant_id, requested_by_membership_id, report_code, format, params, scope_all_centres, scope_centre_ids, status, downloads_allowed, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::uuid[], 'queued', $9, $10, $10) RETURNING ${COLS}`,
    [a.id, a.tenantId, a.membershipId, a.reportCode, a.format, JSON.stringify(a.params), a.scopeAll, [...a.scopeCentreIds], a.downloadsAllowed, a.actorId]);
  return rows[0];
}

/** Own exports only: RLS plus the explicit requester predicate (defence in depth). */
export async function getOwn(tx: ExportsTx, a: { tenantId: string; membershipId: string; id: string }): Promise<ExportRecord | undefined> {
  const { rows } = await tx.query(
    `SELECT ${COLS} FROM analytics.exports WHERE tenant_id = $1 AND id = $2 AND requested_by_membership_id = $3`, [a.tenantId, a.id, a.membershipId]);
  return rows[0];
}

export async function listOwn(tx: ExportsTx, a: { tenantId: string; membershipId: string; statuses: readonly string[]; limit: number; after?: { requestedAt: string; id: string } | undefined }): Promise<ExportRecord[]> {
  const values: unknown[] = [a.tenantId, a.membershipId];
  let where = 'tenant_id = $1 AND requested_by_membership_id = $2';
  if (a.statuses.length) { values.push([...a.statuses]); where += ` AND status = ANY($${values.length}::text[])`; }
  if (a.after) { values.push(a.after.requestedAt, a.after.id); where += ` AND (requested_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`; }
  values.push(a.limit);
  const { rows } = await tx.query(`SELECT ${COLS} FROM analytics.exports WHERE ${where} ORDER BY requested_at DESC, id DESC LIMIT $${values.length}`, values);
  return rows;
}

/** Atomic download slot (TRD §10.3): every guard is in the statement, so two parallel requests with one download left cannot both win (X14). */
export async function claimDownload(tx: ExportsTx, a: { tenantId: string; id: string; actorId: string; membershipId: string }): Promise<ExportRecord | undefined> {
  const { rows } = await tx.query(
    `UPDATE analytics.exports SET downloads_used = downloads_used + 1, updated_at = now(), updated_by = $3
      WHERE tenant_id = $1 AND id = $2 AND requested_by_membership_id = $4 AND downloads_used < downloads_allowed AND status = 'ready' AND expires_at > now() RETURNING ${COLS}`,
    [a.tenantId, a.id, a.actorId, a.membershipId]);
  return rows[0];
}

export async function readFile(tx: ExportsTx, a: { tenantId: string; id: string }): Promise<ExportFileRecord | undefined> {
  const { rows } = await tx.query('SELECT content, content_type, sha256 FROM analytics.export_files WHERE tenant_id = $1 AND export_id = $2', [a.tenantId, a.id]);
  return rows[0];
}

// ------------------------------------------------------------------ worker side
/** TRD §10.2 step 1: the row is locked for the whole build. */
export async function loadForBuild(tx: ExportsTx, a: { tenantId: string; id: string }): Promise<ExportRecord | undefined> {
  const { rows } = await tx.query(`SELECT ${COLS} FROM analytics.exports WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [a.tenantId, a.id]);
  return rows[0];
}

const BUMP = 'updated_at = now(), updated_by = $3, version = version + 1';
/** Effective scope (snapshot ∩ current membership scope) is kept on the row for audit; NULL = all centres. */
export const markBuilding = (tx: ExportsTx, a: { tenantId: string; id: string; actorId: string; effectiveCentreIds: readonly string[] | null }) =>
  tx.query(
    `UPDATE analytics.exports SET status = 'building', building_started_at = now(), scope_effective_centre_ids = $4::uuid[], ${BUMP} WHERE tenant_id = $1 AND id = $2`,
    [a.tenantId, a.id, a.actorId, a.effectiveCentreIds === null ? null : [...a.effectiveCentreIds]]);

/** E6: an earlier attempt failed - back to queued (failure_code stays NULL: exports__failure__ck). */
export const markQueued = (tx: ExportsTx, a: { tenantId: string; id: string; actorId: string }) =>
  tx.query(`UPDATE analytics.exports SET status = 'queued', ${BUMP} WHERE tenant_id = $1 AND id = $2`, [a.tenantId, a.id, a.actorId]);

export const markFailed = (tx: ExportsTx, a: { tenantId: string; id: string; actorId: string; code: string }) =>
  tx.query(`UPDATE analytics.exports SET status = 'failed', failure_code = $4, ${BUMP} WHERE tenant_id = $1 AND id = $2`, [a.tenantId, a.id, a.actorId, a.code]);

export async function storeFile(tx: ExportsTx, a: {
  tenantId: string; id: string; actorId: string; content: Uint8Array; contentType: string; sha256: string; readyAt: Date; expiresAt: Date; rowCount: number;
}): Promise<void> {
  await tx.query(
    `INSERT INTO analytics.export_files (tenant_id, export_id, content, content_type, sha256, created_by, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [a.tenantId, a.id, Buffer.from(a.content), a.contentType, a.sha256, a.actorId, a.expiresAt]);
  await tx.query(
    `UPDATE analytics.exports SET status = 'ready', ready_at = $4, expires_at = $5, row_count = $6, size_bytes = $7, sha256 = $8, failure_code = NULL,
            updated_at = now(), updated_by = $3, version = version + 1 WHERE tenant_id = $1 AND id = $2`,
    [a.tenantId, a.id, a.actorId, a.readyAt, a.expiresAt, a.rowCount, a.content.length, a.sha256]);
}
