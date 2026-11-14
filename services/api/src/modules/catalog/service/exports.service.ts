// Export API service (02-TRD §5.2 #104–#107; §8.7; 03-APP-FLOW export states). createExport inserts exports(status 'queued') and enqueues
// catalog.export_build in the same transaction. Per-kind permission (08 A13 P-10) is asserted through IdentityPort.assertRole; row-based calls
// assert after the tenant-scoped row load, so an unknown or foreign id is 404 for everyone. Every statement binds tenant_id (not RLS alone).
// [CONV] relative import until @lims/shared-ts is a services/api dependency (same as imports.service.ts).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { isLimsError, LimsError } from '../../../core/errors.js';
import type { CatalogConfig } from '../config.js';

interface Tx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }
export interface ExportsCtx {
  readonly tenantId: string; readonly actor: { readonly id: string }; readonly tx: unknown; now(): string;
  readonly audit?: { access(entry: Record<string, unknown>): Promise<unknown> };   // 02-TRD §5.2 access log (#106)
}
interface Identity { assertRole(ctx: unknown, requirement: { permission: string }): Promise<void> }
type Row = Record<string, any>;
type ExportKind = 'price_list' | 'catalog_master' | 'referrers';

export const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const KINDS: readonly ExportKind[] = ['price_list', 'catalog_master', 'referrers'];
const STATUSES = ['queued', 'building', 'ready', 'failed', 'expired'];
const KIND_PERM: Record<ExportKind, string> = {                       // 08 A13 P-10, D-22
  price_list: 'catalog.price_list.manage', catalog_master: 'catalog.test.manage', referrers: 'catalog.referrer.export',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bad = (): never => { throw new LimsError('common.validation_failed'); };
const isKind = (k: unknown): k is ExportKind => typeof k === 'string' && (KINDS as readonly string[]).includes(k);
const iso = (v: unknown) => new Date(v as string).toISOString();

function scope(ctx: ExportsCtx) {
  if (typeof ctx?.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  return { tx: ctx.tx as Tx, tenantId: ctx.tenantId, actorId: ctx.actor.id };
}
function limitOf(v: unknown): number {
  if (v === undefined || v === null || v === '') return 50;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 200 ? n : bad();
}
const encCursor = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
function decCursor(c: unknown): string | undefined {
  if (c === undefined || c === null || c === '') return undefined;
  const s = typeof c === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(c) ? Buffer.from(c, 'base64url').toString('utf8') : '';
  if (!UUID.test(s)) throw new LimsError('common.invalid_cursor');
  return s;
}

/** Row (+ its file row when ready) -> Export schema. Internal columns (params, file_id, created_by, content, sha) never leave. */
function toExport(r: Row, f?: Row): Row {
  const expires = r.expires_at ?? f?.expires_at;
  return {
    id: r.id, kind: r.kind, status: r.status,
    ...(f ? { file_name: f.file_name, byte_size: Number(f.byte_size) } : {}),
    ...(f && expires != null ? { expires_at: iso(expires) } : {}),
    version: Number(r.version),
  };
}

export function createExportsService(deps: { identity: Identity; config?: CatalogConfig }) {
  const assert = (ctx: unknown, permission: string) => deps.identity.assertRole(ctx, { permission });

  /** Tenant-scoped load, then the permission of the row's kind (P-10). Unknown/foreign/malformed id -> 404. */
  async function loadOwned(ctx: ExportsCtx, exportId: unknown): Promise<Row> {
    const { tx, tenantId } = scope(ctx);
    if (typeof exportId !== 'string' || !UUID.test(exportId)) throw new LimsError('common.not_found');
    const { rows } = await tx.query('SELECT * FROM catalog.exports WHERE tenant_id = $1 AND id = $2', [tenantId, exportId]);
    const row = rows[0];
    if (!row) throw new LimsError('common.not_found');
    await assert(ctx, KIND_PERM[row.kind as ExportKind] ?? 'catalog.test.manage');
    return row;
  }

  /** Export-purpose file rows of this tenant, metadata only (no content). */
  async function fileMeta(tx: Tx, tenantId: string, ids: string[]): Promise<Map<string, Row>> {
    if (ids.length === 0) return new Map();
    const { rows } = await tx.query(
      "SELECT id, file_name, byte_size, expires_at FROM catalog.files WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND purpose = 'export'", [tenantId, ids]);
    return new Map(rows.map((f) => [f.id, f]));
  }

  return {
    /** #104 (02-TRD §8.7). Client-supplied status/tenant/creator/file/version fields are never read. */
    async createExport(ctx: ExportsCtx, input: { kind?: unknown; priceListVersionId?: unknown }) {
      const { tx, tenantId, actorId } = scope(ctx);
      const kind = input?.kind;
      const versionId = input?.priceListVersionId ?? null;
      if (!isKind(kind)) bad();
      if ((kind === 'price_list') !== (versionId !== null)) bad();
      if (versionId !== null && (typeof versionId !== 'string' || !UUID.test(versionId))) bad();
      await assert(ctx, KIND_PERM[kind as ExportKind]);

      if (versionId !== null) {
        const v = await tx.query('SELECT id FROM catalog.price_list_versions WHERE tenant_id = $1 AND id = $2', [tenantId, versionId]);
        if (!v.rows[0]) throw new LimsError('common.not_found');
      }
      const now = ctx.now();
      const params = versionId !== null ? { price_list_version_id: versionId } : {};
      const ins = await tx.query(
        "INSERT INTO catalog.exports (id, tenant_id, kind, params, status, created_at, created_by, updated_at, updated_by) VALUES ($1, $2, $3, $4::jsonb, 'queued', $5::timestamptz, $6, $5::timestamptz, $6) RETURNING *",
        [uuidv7(), tenantId, kind, JSON.stringify(params), now, actorId]);
      const row = ins.rows[0];
      await tx.query("SELECT app.enqueue_job('catalog.export_build', $1::jsonb, $2)", [JSON.stringify({ tenant_id: tenantId, export_id: row.id }), row.id]);
      return { status: 202, body: toExport(row) };
    },

    /** #105 */
    async getExport(ctx: ExportsCtx, exportId: unknown) {
      const row = await loadOwned(ctx, exportId);
      const { tx, tenantId } = scope(ctx);
      const f = row.status === 'ready' && row.file_id != null ? (await fileMeta(tx, tenantId, [row.file_id])).get(row.file_id) : undefined;
      return toExport(row, f);
    },

    /** #106: only a `ready` export with a live purpose-export file downloads; every download is access-logged (AC-17.6 for referrers). */
    async downloadExportFile(ctx: ExportsCtx, exportId: unknown) {
      const row = await loadOwned(ctx, exportId);
      const { tx, tenantId } = scope(ctx);
      if (row.status !== 'ready') throw new LimsError('common.version_conflict', 'file_not_ready');   // D-20
      if (row.file_id == null) throw new LimsError('common.not_found');                              // purged (05-SCHEMA §10.1)
      const { rows } = await tx.query(
        "SELECT file_name, content FROM catalog.files WHERE tenant_id = $1 AND id = $2 AND purpose = 'export'", [tenantId, row.file_id]);
      if (!rows[0]) throw new LimsError('common.not_found');
      // 02-TRD §5.2 access-log table. [CONV] skipped when the core supplies no audit port (same as imports.service).
      await ctx.audit?.access({ action: 'data.export', entityType: row.kind === 'referrers' ? 'referrer_export' : 'catalog_file', entityId: row.file_id, outcome: 'allowed' });
      return { fileName: rows[0].file_name as string, contentType: XLSX, bytes: new Uint8Array(rows[0].content) };
    },

    /** #107: only kinds the caller may export (aal1 drops privileged kinds); ?kind= of another kind -> 403/mfa. Keyset on id (UUIDv7). */
    async listExports(ctx: ExportsCtx, q: { kind?: unknown; status?: unknown; cursor?: unknown; limit?: unknown } = {}) {
      const { tx, tenantId } = scope(ctx);
      if (q.kind !== undefined && !isKind(q.kind)) bad();
      if (q.status !== undefined && !(typeof q.status === 'string' && STATUSES.includes(q.status))) bad();
      const limit = limitOf(q.limit);
      const after = decCursor(q.cursor);
      const wanted = q.kind !== undefined ? [q.kind as ExportKind] : [...KINDS];
      const allowed: ExportKind[] = [];
      const verdict = new Map<string, boolean>();
      for (const k of wanted) {
        const p = KIND_PERM[k];
        if (!verdict.has(p)) {
          try { await assert(ctx, p); verdict.set(p, true); } catch (e) {
            if (q.kind !== undefined || !isLimsError(e) || !['auth.forbidden', 'auth.mfa_required'].includes(e.code)) throw e;
            verdict.set(p, false);
          }
        }
        if (verdict.get(p)) allowed.push(k);
      }
      if (allowed.length === 0) return { data: [], page: { limit } };
      const values: unknown[] = [tenantId, allowed];
      let sql = 'SELECT * FROM catalog.exports WHERE tenant_id = $1 AND kind = ANY($2::text[])';
      if (q.status !== undefined) { values.push(q.status); sql += ` AND status = $${values.length}`; }
      if (after) { values.push(after); sql += ` AND id < $${values.length}::uuid`; }
      values.push(limit + 1);
      sql += ` ORDER BY id DESC LIMIT $${values.length}`;
      const { rows } = await tx.query(sql, values);
      const page = rows.slice(0, limit);
      const files = await fileMeta(tx, tenantId, page.filter((r) => r.status === 'ready' && r.file_id != null).map((r) => r.file_id));
      return {
        data: page.map((r) => toExport(r, r.status === 'ready' ? files.get(r.file_id) : undefined)),
        page: { limit, ...(rows.length > limit ? { next_cursor: encCursor(page.at(-1)!.id) } : {}) },
      };
    },
  };
}
