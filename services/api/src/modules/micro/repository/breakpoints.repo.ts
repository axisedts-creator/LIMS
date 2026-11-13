// micro.breakpoint_sets / breakpoint_rows / breakpoint_bands / breakpoint_import_issues (05-SCHEMA §8). Read + insert side of T-11 only
// (status transitions belong to T-12 / T-13). REQ-SEC-024: every statement binds tenant_id explicitly in addition to RLS. Static SQL only;
// values are always parameters. File content is never a parameter: only its sha256 and size.
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;
type Row = Record<string, any>;

export interface NewSet {
  id: string; tenantId: string; userId: string;
  standard: string; standardVersion: string; title: string; licence: string;
  bucket: string; objectPath: string; sha256: string; bytes: number; intendedEffectiveFrom: string | null;
}

/** One INSERT; status starts at `uploaded`. A violation of the partial unique index (tenant, standard, sha256) surfaces as SQLSTATE 23505. */
export async function insertSet(tx: Q, a: NewSet): Promise<Row> {
  const { rows } = await tx.query(
    `INSERT INTO micro.breakpoint_sets (id, tenant_id, standard, standard_version, title, licence_attestation_text, file_bucket, file_object_path,
       file_sha256, file_bytes, status, intended_effective_from, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'uploaded', $11::timestamptz, $12, $12) RETURNING *`,
    [a.id, a.tenantId, a.standard, a.standardVersion, a.title, a.licence, a.bucket, a.objectPath, a.sha256, a.bytes, a.intendedEffectiveFrom, a.userId]);
  return rows[0]!;
}

/** AC-12.3: a live (not invalid / discarded) set of the same standard with the same file hash. */
export async function findLiveBySha(tx: Q, a: { tenantId: string; standard: string; sha256: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `SELECT id, file_sha256 FROM micro.breakpoint_sets WHERE tenant_id = $1 AND standard = $2 AND file_sha256 = $3 AND status NOT IN ('invalid', 'discarded') LIMIT 1`,
    [a.tenantId, a.standard, a.sha256]);
  return rows[0];
}

export async function getSet(tx: Q, a: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query('SELECT * FROM micro.breakpoint_sets WHERE tenant_id = $1 AND id = $2', [a.tenantId, a.id]);
  return rows.find((r: Row) => r['id'] === a.id); // belt and braces on top of the WHERE: never hand back another row
}

export interface SetCursor { ms: string; id: string }

/** Sort -created_at (millisecond precision, as on the wire), id as the tie-break. Fetches limit + 1 rows. */
export async function listSets(tx: Q, a: { tenantId: string; standard?: string | undefined; statuses?: readonly string[] | undefined; cursor?: SetCursor | undefined; limit: number }): Promise<Row[]> {
  const { rows } = await tx.query(
    `SELECT * FROM micro.breakpoint_sets WHERE tenant_id = $1
       AND ($2::text IS NULL OR standard = $2::text)
       AND ($3::text[] IS NULL OR status = ANY($3::text[]))
       AND ($4::timestamptz IS NULL OR (date_trunc('milliseconds', created_at), id) < ($4::timestamptz, $5::uuid))
     ORDER BY date_trunc('milliseconds', created_at) DESC, id DESC LIMIT $6`,
    [a.tenantId, a.standard ?? null, a.statuses ?? null, a.cursor?.ms ?? null, a.cursor?.id ?? null, a.limit + 1]);
  return rows;
}

export async function listIssues(tx: Q, a: { tenantId: string; setId: string; severity?: string | undefined; cursor?: { lineNo: number; id: string } | undefined; limit: number }): Promise<Row[]> {
  const { rows } = await tx.query(
    `SELECT id, line_no, severity, code, field, message FROM micro.breakpoint_import_issues WHERE tenant_id = $1 AND set_id = $2
       AND ($3::text IS NULL OR severity = $3::text)
       AND ($4::integer IS NULL OR (coalesce(line_no, 0), id) > ($4::integer, $5::uuid))
     ORDER BY coalesce(line_no, 0), id LIMIT $6`,
    [a.tenantId, a.setId, a.severity ?? null, a.cursor?.lineNo ?? null, a.cursor?.id ?? null, a.limit + 1]);
  return rows;
}

export async function listRows(tx: Q, a: { tenantId: string; setId: string; antibioticCode?: string | undefined; organismCode?: string | undefined; cursor?: { lineNo: number; id: string } | undefined; limit: number }): Promise<Row[]> {
  const { rows } = await tx.query(
    `SELECT id, line_no, organism_scope, organism_code, antibiotic_code, method, specimen_site_code, qualifier_code FROM micro.breakpoint_rows
     WHERE tenant_id = $1 AND set_id = $2
       AND ($3::text IS NULL OR antibiotic_code = $3::text)
       AND ($4::text IS NULL OR organism_code = $4::text)
       AND ($5::integer IS NULL OR (line_no, id) > ($5::integer, $6::uuid))
     ORDER BY line_no, id LIMIT $7`,
    [a.tenantId, a.setId, a.antibioticCode ?? null, a.organismCode ?? null, a.cursor?.lineNo ?? null, a.cursor?.id ?? null, a.limit + 1]);
  return rows;
}

export async function bandsOf(tx: Q, a: { tenantId: string; setId: string; rowIds: readonly string[] }): Promise<Row[]> {
  if (a.rowIds.length === 0) return [];
  const { rows } = await tx.query(
    `SELECT id, row_id, band_no, category_code, lower_value::text AS lower_value, lower_inclusive, upper_value::text AS upper_value, upper_inclusive, note
       FROM micro.breakpoint_bands WHERE tenant_id = $1 AND set_id = $2 AND row_id = ANY($3::uuid[]) ORDER BY row_id, band_no`,
    [a.tenantId, a.setId, a.rowIds]);
  return rows;
}
