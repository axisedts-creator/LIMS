// Import API service (02-TRD §5.2 #96–#101, #103; §8.1 createImport flow; 03-APP-FLOW §2.2). The API never opens the archive
// (REQ-SEC-087): it checks size, extension, declared type and the ZIP magic, stores the bytes and enqueues validation.
// Per-kind permission (08 A13 P-10) is asserted here through IdentityPort.assertRole; row-based calls assert after the
// tenant-scoped row load, so an unknown or foreign id is 404 for everyone. Every statement binds tenant_id (not RLS alone).
// [CONV] relative import until @lims/shared-ts is a services/api dependency (same as core/errors.ts).
import { createHash } from 'node:crypto';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { isLimsError, LimsError } from '../../../core/errors.js';
import { loadCatalogConfig, type CatalogConfig } from '../config.js';
import { buildTemplate, IMPORT_KINDS, type ImportKind } from './importTemplates.js';

interface Tx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }
export interface ImportsCtx {
  readonly tenantId: string; readonly actor: { readonly id: string }; readonly tx: unknown; now(): string;
  readonly audit?: { access(entry: Record<string, unknown>): Promise<unknown> };   // 02-TRD §5.2 access log (#96, #101)
}
interface Identity { assertRole(ctx: unknown, requirement: { permission: string }): Promise<void> }
type Row = Record<string, any>;

export const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const STATUSES = ['uploaded', 'scanning', 'validating', 'validated', 'invalid', 'quarantined', 'committing', 'committed', 'commit_failed', 'discarded', 'expired', 'failed'];
const ACTIVE = ['uploaded', 'scanning', 'validating', 'committing'];                                 // REQ-SEC-100
const NOT_REUSED = ['invalid', 'quarantined', 'commit_failed', 'discarded', 'expired', 'failed'];    // 02-TRD §8.1 dedupe
const KIND_PERM: Record<ImportKind, string> = {
  price_list: 'catalog.price_list.manage', credit_parties: 'catalog.price_list.manage',
  catalog_master: 'catalog.test.manage', referrers: 'catalog.referrer.manage',
};
const TEMPLATE_PERM: Record<ImportKind, string | undefined> = {
  price_list: 'catalog.price_list.read', credit_parties: 'catalog.price_list.read', referrers: 'catalog.referrer.read', catalog_master: undefined,
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RETRY_AFTER_SECONDS = 30;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$/;
const COMMIT_KEYS = ['change_reason', 'effective_from', 'accept_stale_base', 'publish', 'replace_draft'];

const bad = (): never => { throw new LimsError('common.validation_failed'); };
const isKind = (k: unknown): k is ImportKind => typeof k === 'string' && (IMPORT_KINDS as readonly string[]).includes(k);
const iso = (v: unknown) => new Date(v as string).toISOString();
const plusMs = (isoNow: string, ms: number) => new Date(Date.parse(isoNow) + ms).toISOString();

function scope(ctx: ImportsCtx) {
  if (typeof ctx?.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  return { tx: ctx.tx as Tx, tenantId: ctx.tenantId, actorId: ctx.actor.id };
}

/** Basename only, no control characters, <= 200 chars keeping the extension. */
function cleanName(raw: unknown): string {
  const base = String(raw ?? '').split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (base.length <= 200) return base;
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 && base.length - dot <= 10 ? base.slice(dot) : '';
  return base.slice(0, 200 - ext.length) + ext;
}

function limitOf(v: unknown): number {
  if (v === undefined || v === null || v === '') return 50;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 200 ? n : bad();
}
const encCursor = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
function decCursor(c: unknown, shape: RegExp): string | undefined {
  if (c === undefined || c === null || c === '') return undefined;
  const s = typeof c === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(c) ? Buffer.from(c, 'base64url').toString('utf8') : '';
  if (!shape.test(s)) throw new LimsError('common.invalid_cursor');
  return s;
}

const SUMMARY_KEYS = ['rows', 'added', 'changed', 'removed', 'unchanged', 'errors', 'warnings'] as const;
const CLINICAL_KEYS = ['analyte_versions', 'range_sets', 'critical_sets'] as const;
/** Row -> Import schema (internal columns never leave; null optionals omitted). */
function toImport(r: Row, deduplicated?: boolean): Row {
  const s = (r.summary ?? {}) as Row;
  return {
    id: r.id, kind: r.kind,
    ...(r.target_price_list_id != null ? { target_price_list_id: r.target_price_list_id } : {}),
    ...(r.base_version_no != null ? { base_version_no: Number(r.base_version_no) } : {}),
    status: r.status, file_name: r.file_name, file_sha256: r.file_sha256,
    summary: Object.fromEntries(SUMMARY_KEYS.map((k) => [k, Number.isInteger(s[k]) ? s[k] : 0])),
    ...(deduplicated === undefined ? {} : { deduplicated }),
    ...(r.result_price_list_version_id != null ? { result_price_list_version_id: r.result_price_list_version_id } : {}),
    expires_at: iso(r.expires_at), created_at: iso(r.created_at), created_by: r.created_by, version: Number(r.version),
  };
}
function toIssue(r: Row): Row {
  return {
    seq: Number(r.seq), severity: r.severity, sheet: r.sheet,
    ...(r.row_no != null ? { row_no: Number(r.row_no) } : {}),
    ...(r.column_key != null ? { column: r.column_key } : {}),
    issue_code: r.issue_code, message: r.message,
  };
}

export function createImportsService(deps: { identity: Identity; config?: CatalogConfig }) {
  const cfg = deps.config ?? loadCatalogConfig({});
  const assert = (ctx: unknown, permission: string) => deps.identity.assertRole(ctx, { permission });

  /** Tenant-scoped load, then the permission of the row's kind (P-10). Unknown/foreign/malformed id -> 404. */
  async function loadOwned(ctx: ImportsCtx, importId: unknown): Promise<Row> {
    const { tx, tenantId } = scope(ctx);
    if (typeof importId !== 'string' || !UUID.test(importId)) throw new LimsError('common.not_found');
    const { rows } = await tx.query('SELECT * FROM catalog.imports WHERE tenant_id = $1 AND id = $2', [tenantId, importId]);
    const row = rows[0];
    if (!row) throw new LimsError('common.not_found');
    await assert(ctx, KIND_PERM[row.kind as ImportKind] ?? 'catalog.test.manage');
    return row;
  }

  /** 02-TRD §5.2 access-log table (:361-362): data.export on catalog_file. [CONV] skipped when the core supplies no audit port. */
  async function accessLog(ctx: ImportsCtx, extra: Record<string, unknown>) {
    await ctx.audit?.access({ action: 'data.export', entityType: 'catalog_file', ...extra, outcome: 'allowed' });
  }

  return {
    /** #96. catalog_master needs only the floor (asserted by the core from x-permission). */
    async downloadTemplate(ctx: ImportsCtx, kind: unknown) {
      if (!isKind(kind)) bad();
      const perm = TEMPLATE_PERM[kind as ImportKind];
      if (perm) await assert(ctx, perm);
      const t = buildTemplate(kind as ImportKind, ctx.now());
      await accessLog(ctx, { detail: { kind } });
      return { fileName: t.fileName, contentType: XLSX, bytes: t.bytes };
    },

    /** #97 (02-TRD §8.1). Client-supplied status/tenant/creator/version fields are never read. */
    async createImport(ctx: ImportsCtx, input: { kind?: unknown; targetPriceListId?: unknown; file?: { filename?: unknown; mimeType?: unknown; bytes?: unknown } }) {
      const { tx, tenantId, actorId } = scope(ctx);
      const kind = input?.kind;
      const target = input?.targetPriceListId ?? null;
      if (!isKind(kind)) bad();
      if ((kind === 'price_list') !== (target !== null)) bad();
      if (target !== null && (typeof target !== 'string' || !UUID.test(target))) bad();
      const file = input?.file;
      if (!file || !(file.bytes instanceof Uint8Array)) bad();
      await assert(ctx, KIND_PERM[kind as ImportKind]);                     // before the file is looked at

      const bytes = file!.bytes as Uint8Array;
      if (bytes.length > cfg.importMaxBytes) throw new LimsError('common.payload_too_large');
      const fileName = cleanName(file!.filename);
      const isZip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
      if (!/^.+\.xlsx$/i.test(fileName) || file!.mimeType !== XLSX || !isZip) throw new LimsError('common.unsupported_media_type');

      if (target !== null) {
        const pl = await tx.query('SELECT id FROM catalog.price_lists WHERE tenant_id = $1 AND id = $2', [tenantId, target]);
        if (!pl.rows[0]) throw new LimsError('common.not_found');
      }
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const now = ctx.now();

      // Serialises dedupe + the active-import count per tenant (E5 double click, REQ-SEC-100 many users at once).
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`catalog.import:${tenantId}`]);
      const dup = await tx.query(
        'SELECT * FROM catalog.imports WHERE tenant_id = $1 AND kind = $2 AND target_price_list_id IS NOT DISTINCT FROM $3::uuid AND file_sha256 = $4 AND status <> ALL($5::text[]) AND expires_at > $6::timestamptz ORDER BY created_at DESC LIMIT 1',
        [tenantId, kind, target, sha256, NOT_REUSED, now]);
      if (dup.rows[0]) return { status: 200, body: toImport(dup.rows[0], true) };

      const active = await tx.query('SELECT count(*) AS n FROM catalog.imports WHERE tenant_id = $1 AND status = ANY($2::text[])', [tenantId, ACTIVE]);
      if (Number(active.rows[0]?.n ?? 0) >= cfg.maxActiveImportsPerTenant) {
        const e = new LimsError('common.rate_limited');
        e.retryAfterSeconds = RETRY_AFTER_SECONDS;
        throw e;
      }

      const ttlMs = cfg.importTtlHours * 3_600_000;
      const fileId = uuidv7();
      await tx.query(
        'INSERT INTO catalog.files (id, tenant_id, purpose, file_name, content_type, byte_size, sha256, content, expires_at, created_at, created_by) VALUES ($1, $2, \'import_upload\', $3, $4, $5, $6, $7::bytea, $8::timestamptz, $9::timestamptz, $10)',
        [fileId, tenantId, fileName, XLSX, bytes.length, sha256, bytes, plusMs(now, ttlMs + cfg.fileRetentionDays * 86_400_000), now, actorId]);
      const ins = await tx.query(
        'INSERT INTO catalog.imports (id, tenant_id, kind, target_price_list_id, status, upload_file_id, file_name, file_sha256, summary, expires_at, created_at, created_by, updated_at, updated_by) VALUES ($1, $2, $3, $4::uuid, \'uploaded\', $5, $6, $7, $8::jsonb, $9::timestamptz, $10::timestamptz, $11, $10::timestamptz, $11) RETURNING *',
        [uuidv7(), tenantId, kind, target, fileId, fileName, sha256, JSON.stringify({}), plusMs(now, ttlMs), now, actorId]);
      const row = ins.rows[0];
      await tx.query("SELECT app.enqueue_job('catalog.import_validate', $1::jsonb, $2)", [JSON.stringify({ tenant_id: tenantId, import_id: row.id }), row.id]);
      return { status: 201, body: toImport(row, false) };
    },

    /** #98: only kinds the caller may manage; ?kind= of another kind -> 403. Keyset on id (UUIDv7, time-ordered). */
    async listImports(ctx: ImportsCtx, q: { kind?: unknown; status?: unknown; cursor?: unknown; limit?: unknown } = {}) {
      const { tx, tenantId } = scope(ctx);
      if (q.kind !== undefined && !isKind(q.kind)) bad();
      if (q.status !== undefined && !(typeof q.status === 'string' && STATUSES.includes(q.status))) bad();
      const limit = limitOf(q.limit);
      const after = decCursor(q.cursor, UUID);
      const wanted = q.kind !== undefined ? [q.kind as ImportKind] : [...IMPORT_KINDS];
      const allowed: ImportKind[] = [];
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
      let sql = 'SELECT * FROM catalog.imports WHERE tenant_id = $1 AND kind = ANY($2::text[])';
      if (q.status !== undefined) { values.push(q.status); sql += ` AND status = $${values.length}`; }
      if (after) { values.push(after); sql += ` AND id < $${values.length}::uuid`; }
      values.push(limit + 1);
      sql += ` ORDER BY id DESC LIMIT $${values.length}`;
      const { rows } = await tx.query(sql, values);
      const page = rows.slice(0, limit);
      return { data: page.map((r) => toImport(r)), page: { limit, ...(rows.length > limit ? { next_cursor: encCursor(page.at(-1)!.id) } : {}) } };
    },

    /** #99 */
    async getImport(ctx: ImportsCtx, importId: unknown) {
      return toImport(await loadOwned(ctx, importId));
    },

    /** #100: ordered by seq; cursor = last seq, always scoped to this import. */
    async listImportIssues(ctx: ImportsCtx, importId: unknown, q: { severity?: unknown; cursor?: unknown; limit?: unknown } = {}) {
      const row = await loadOwned(ctx, importId);
      const { tx, tenantId } = scope(ctx);
      if (q.severity !== undefined && q.severity !== 'error' && q.severity !== 'warning') bad();
      const limit = limitOf(q.limit);
      const after = decCursor(q.cursor, /^[1-9]\d{0,9}$/);
      const values: unknown[] = [tenantId, row.id];
      let sql = 'SELECT * FROM catalog.import_issues WHERE tenant_id = $1 AND import_id = $2';
      if (q.severity !== undefined) { values.push(q.severity); sql += ` AND severity = $${values.length}`; }
      if (after) { values.push(Number(after)); sql += ` AND seq > $${values.length}`; }
      values.push(limit + 1);
      sql += ` ORDER BY seq ASC LIMIT $${values.length}`;
      const { rows } = await tx.query(sql, values);
      const page = rows.slice(0, limit);
      return { data: page.map(toIssue), page: { limit, ...(rows.length > limit ? { next_cursor: encCursor(String(page.at(-1)!.seq)) } : {}) } };
    },

    /** #101: only a file of purpose import_report is served; never the upload. */
    async downloadImportReport(ctx: ImportsCtx, importId: unknown) {
      const row = await loadOwned(ctx, importId);
      const { tx, tenantId } = scope(ctx);
      const notReady = () => new LimsError('common.version_conflict', 'file_not_ready');
      if (row.report_file_id == null) throw notReady();
      const { rows } = await tx.query("SELECT content FROM catalog.files WHERE tenant_id = $1 AND id = $2 AND purpose = 'import_report'", [tenantId, row.report_file_id]);
      if (!rows[0]) throw notReady();
      await accessLog(ctx, { entityId: row.report_file_id });
      return { fileName: `import-report-${row.id}.xlsx`, contentType: XLSX, bytes: new Uint8Array(rows[0].content) };
    },

    /** #102 (02-TRD §8.5 API half): validated -> committing + enqueue, one transaction. The guarded UPDATE decides races (AB-16). */
    async commitImport(ctx: ImportsCtx, importId: unknown, expectedVersion: number | undefined, body: unknown) {
      const row = await loadOwned(ctx, importId);
      const { tx, tenantId, actorId } = scope(ctx);
      if (typeof body !== 'object' || body === null || Array.isArray(body)) bad();
      const b = body as Row;
      if (Object.keys(b).some((k) => !COMMIT_KEYS.includes(k))) bad();            // mass assignment: unknown fields are refused
      const reason = typeof b['change_reason'] === 'string' ? b['change_reason'].trim() : '';
      if (reason.length < 1 || reason.length > 500) bad();
      let effectiveFrom: string | null = null;
      if (b['effective_from'] !== undefined) {
        const e = b['effective_from'];
        if (typeof e !== 'string' || !ISO.test(e) || Number.isNaN(Date.parse(e))) bad();
        effectiveFrom = new Date(e as string).toISOString();
      }
      for (const k of ['accept_stale_base', 'publish', 'replace_draft']) if (b[k] !== undefined && typeof b[k] !== 'boolean') bad();
      const acceptStale = b['accept_stale_base'] === true, publish = b['publish'] !== false, replaceDraft = b['replace_draft'] === true;

      if (expectedVersion !== undefined && expectedVersion !== Number(row.version)) throw new LimsError('common.version_conflict');
      const now = ctx.now();
      if (row.status !== 'validated' || !isKind(row.kind) || !(Date.parse(iso(row.expires_at)) > Date.parse(now))) throw new LimsError('catalog.import_not_committable');

      if (row.kind === 'price_list') {                                          // the stale-base rule is a price_list notion (02-TRD §8.5)
        const latest = (await tx.query(
          "SELECT version_no FROM catalog.price_list_versions WHERE tenant_id = $1 AND price_list_id = $2 AND status IN ('published', 'superseded') ORDER BY version_no DESC LIMIT 1",
          [tenantId, row.target_price_list_id])).rows[0];
        if (!acceptStale && Number(row.base_version_no ?? 0) !== Number(latest?.version_no ?? 0)) throw new LimsError('catalog.import_stale_base');
      }
      // 08 A13 D-18 / AC-17.5: clinical versions or sets in a catalog_master commit also need the privileged publish permission.
      // [CONV] the validation job stores the counts as summary.analyte_versions / range_sets / critical_sets.
      const s = (row.summary ?? {}) as Row;
      if (row.kind === 'catalog_master' && CLINICAL_KEYS.some((k) => Number(s[k] ?? 0) > 0)) await assert(ctx, 'catalog.reference_range.publish');

      const { rows } = await tx.query(
        "UPDATE catalog.imports SET status = 'committing', commit_effective_from = $3::timestamptz, commit_change_reason = $4, commit_publish = $5, commit_accept_stale_base = $6, committed_by = $7, version = version + 1, updated_at = $8::timestamptz, updated_by = $7 WHERE tenant_id = $1 AND id = $2 AND status = 'validated' RETURNING *",
        [tenantId, row.id, effectiveFrom, reason, publish, acceptStale, actorId, now]);
      if (!rows[0]) throw new LimsError('catalog.import_not_committable');
      await tx.query("SELECT app.enqueue_job('catalog.import_commit', $1::jsonb, $2)", [JSON.stringify({ tenant_id: tenantId, import_id: row.id, replace_draft: replaceDraft }), row.id]);
      return toImport(rows[0]);
    },

    /** #103: validated | invalid -> discarded (03-APP-FLOW §2.2). The guarded UPDATE decides races. */
    async discardImport(ctx: ImportsCtx, importId: unknown, expectedVersion?: number) {
      const row = await loadOwned(ctx, importId);
      const { tx, tenantId, actorId } = scope(ctx);
      if (expectedVersion !== undefined && expectedVersion !== Number(row.version)) throw new LimsError('common.version_conflict');
      const { rows } = await tx.query(
        "UPDATE catalog.imports SET status = 'discarded', version = version + 1, updated_at = $3::timestamptz, updated_by = $4 WHERE tenant_id = $1 AND id = $2 AND status IN ('validated', 'invalid') RETURNING *",
        [tenantId, row.id, ctx.now(), actorId]);
      if (!rows[0]) throw new LimsError('catalog.import_not_committable');
      return toImport(rows[0]);
    },
  };
}
