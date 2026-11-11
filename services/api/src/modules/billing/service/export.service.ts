// B28 createBillingExport, B29 getBillingExport, B29a getBillingExportContent (02-TRD §5, §9, §11.1; PRD US-BL-12.4, 12.5; 07-SECURITY exports row + abuse case A20; 08 A13 P-2).
// B28: validate -> privileged (IdentityPort billing.data.export, behind the pipeline aal2 check) -> row cap (422 billing.export_too_large) -> job row + billing.export_render in ONE tx ->
// access_log data.export (stage create). B29a streams the stored bytes (the handler uses the core download helper) and writes an access_log row on EVERY call BEFORE it reads storage
// (fail closed); no Storage URL exists anywhere: ExportJob carries status only.
// [CONV] filters.from/to are IsoDate in the contract (a Kathmandu calendar day) and UTC instants are accepted too; both are stored as UTC instants (date -> start / end of that day).
// [CONV] A ready job past expires_at is 404 even before the purge task has run.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../core/errors.js';
import { loadBillingConfig, type BillingConfig } from '../config.js';
import { billingRepo, type BillingRepo } from '../repository/index.js';
import type { BalanceCtx } from './balance.service.js';
import { bad, isRec, iso, present, UTC_INSTANT, uuid } from './invoiceRead.service.js';

type ExportRepo = Pick<BillingRepo, 'countExportRows' | 'insertExportJob' | 'enqueueExportRender' | 'getExportJob' | 'insertActivity'>;
type Row = Record<string, any>;
export const EXPORT_BUCKET = 'billing-exports';
const PERMISSION = 'billing.data.export';
const KINDS = ['sales_register', 'cancelled_invoices', 'credit_notes', 'audit_trail', 'daily_cash', 'invoice_documents'];
const FORMATS = ['xlsx', 'xml', 'pdf'];
const FILTER_KEYS = ['fiscal_year_bs', 'from', 'to', 'centre_id', 'actor_membership_id'];
const FY = /^[0-9]{4}\/[0-9]{2}$/;
const TYPES: Record<string, string> = { xml: 'application/xml', pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };

function dayBound(v: string, end: boolean): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return undefined;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  if (d.getUTCFullYear() !== +m[1]! || d.getUTCMonth() !== +m[2]! - 1 || d.getUTCDate() !== +m[3]!) return undefined;
  return new Date(`${v}T${end ? '23:59:59.999' : '00:00:00.000'}+05:45`).toISOString();
}
function instantOf(v: unknown, path: string, end: boolean): string {
  if (typeof v !== 'string') throw bad(path);
  if (UTC_INSTANT.test(v) && !Number.isNaN(Date.parse(v))) return v;
  const b = dayBound(v, end);
  if (b === undefined) throw bad(path);
  return b;
}
function filtersOf(raw: unknown): Record<string, string> {
  if (!isRec(raw)) throw bad('/filters');
  for (const k of Object.keys(raw)) if (!FILTER_KEYS.includes(k)) throw bad(`/filters/${k}`);
  const f: Record<string, string> = {};
  if (raw['fiscal_year_bs'] !== undefined) { if (typeof raw['fiscal_year_bs'] !== 'string' || !FY.test(raw['fiscal_year_bs'])) throw bad('/filters/fiscal_year_bs'); f['fiscal_year_bs'] = raw['fiscal_year_bs']; }
  if (raw['from'] !== undefined) f['from'] = instantOf(raw['from'], '/filters/from', false);
  if (raw['to'] !== undefined) f['to'] = instantOf(raw['to'], '/filters/to', true);
  if (f['from'] !== undefined && f['to'] !== undefined && Date.parse(f['from']) > Date.parse(f['to'])) throw bad('/filters/from');
  if (raw['centre_id'] !== undefined) f['centre_id'] = uuid(raw['centre_id'], '/filters/centre_id');
  if (raw['actor_membership_id'] !== undefined) f['actor_membership_id'] = uuid(raw['actor_membership_id'], '/filters/actor_membership_id');
  return f;
}

function scope(ctx: BalanceCtx): { tx: never; tenantId: string; actorId: string } {
  if (typeof ctx?.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  return { tx: ctx.tx as never, tenantId: ctx.tenantId, actorId: ctx.actor.id };
}
/** ExportJob (contract): status only. bucket, object_path, sha256, error_code, filters and the requester never leave. */
const jobDto = (r: Row) => present({
  id: r['id'], kind: r['kind'], format: r['format'], status: r['status'], row_count: r['row_count'] == null ? undefined : Number(r['row_count']),
  created_at: iso(r['created_at']), completed_at: r['completed_at'] == null ? undefined : iso(r['completed_at']), expires_at: r['expires_at'] == null ? undefined : iso(r['expires_at']),
});

export function createExportService(deps: { repo?: ExportRepo; config?: Pick<BillingConfig, 'exportMaxRows' | 'exportPdfMaxRows' | 'exportTtlHours'> } = {}) {
  const db = deps.repo ?? billingRepo;
  const config = () => deps.config ?? loadBillingConfig();

  /** The access_log row is mandatory: no ctx.audit.access -> common.internal; a failing write propagates (the tx rolls back). */
  const auditOf = (ctx: BalanceCtx) => {
    const audit = (ctx as any).audit;
    if (typeof audit?.access !== 'function') throw new LimsError('common.internal');
    return audit.access as (e: Record<string, unknown>) => Promise<void>;
  };
  async function requirePrivileged(ctx: BalanceCtx): Promise<void> {
    const idp = ctx.ports?.IdentityPort as { assertRole?: (c: unknown, r: unknown) => Promise<void> } | undefined;
    if (typeof idp?.assertRole !== 'function') throw new LimsError('common.internal');
    await idp.assertRole(ctx, { permission: PERMISSION });
  }
  const activity = (ctx: BalanceCtx, tenantId: string, actorId: string, action: string, jobId: string, details: Record<string, unknown>) => db.insertActivity(ctx.tx as never, {
    id: uuidv7(), tenant_id: tenantId, centre_id: null, action, document_kind: 'billing_export', document_id: jobId, document_no: null,
    actor_id: actorId, actor_membership_id: ctx.actor.membershipId ?? null, actor_type: ctx.actor.type, occurred_at: ctx.now(), request_id: ctx.requestId ?? null, details, created_by: actorId,
  });

  async function create(ctx: BalanceCtx, raw: unknown) {
    const { tx, tenantId, actorId } = scope(ctx);
    if (!isRec(raw)) throw bad('/');
    for (const k of Object.keys(raw)) if (!['kind', 'format', 'filters'].includes(k)) throw bad(`/${k}`);
    const kind = raw['kind'], format = raw['format'];
    if (typeof kind !== 'string' || !KINDS.includes(kind)) throw bad('/kind');
    if (typeof format !== 'string' || !FORMATS.includes(format)) throw bad('/format');
    const filters = filtersOf(raw['filters']);
    await requirePrivileged(ctx);
    const access = auditOf(ctx);
    if (typeof ctx.actor.membershipId !== 'string') throw new LimsError('auth.forbidden');

    const cfg = config();
    const rows = await db.countExportRows(tx, { tenantId, kind, filters });
    if (rows > (format === 'pdf' ? cfg.exportPdfMaxRows : cfg.exportMaxRows)) throw new LimsError('billing.export_too_large');

    const now = ctx.now();
    const job = await db.insertExportJob(tx, {
      id: uuidv7(), tenant_id: tenantId, kind, format, filters, status: 'queued', requested_by_membership_id: ctx.actor.membershipId, created_at: now, updated_at: now, created_by: actorId, updated_by: actorId,
    });
    if (!job) throw new LimsError('common.internal'); // fail closed like every other insert (RETURNING gave no row): no enqueue, no audit on a job that was not stored
    const id = String(job['id']);
    await db.enqueueExportRender(tx, { tenantId, exportId: id });
    await access({ action: 'data.export', entityType: 'billing_export', entityId: id, outcome: 'allowed', detail: { stage: 'create' } });
    await activity(ctx, tenantId, actorId, 'export_created', id, { kind, format });
    return jobDto(job);
  }

  async function load(ctx: BalanceCtx, raw: unknown): Promise<{ tx: never; tenantId: string; actorId: string; job: Row }> {
    const s = scope(ctx);
    const exportId = uuid(isRec(raw) ? raw['exportId'] : undefined, '/export_id');
    const job = await db.getExportJob(s.tx, { tenantId: s.tenantId, jobId: exportId });
    if (!job) throw new LimsError('common.not_found');
    return { ...s, job };
  }

  async function get(ctx: BalanceCtx, raw: unknown) {
    return jobDto((await load(ctx, raw)).job);
  }

  /** Privileged + state + tenant-prefix checks shared by content() and prepareDownload(); reads no byte and writes nothing. */
  async function locate(ctx: BalanceCtx, raw: unknown) {
    await requirePrivileged(ctx);
    const access = auditOf(ctx);
    const { tenantId, actorId, job } = await load(ctx, raw);
    const status = job['status'];
    if (status === 'expired') throw new LimsError('common.not_found');
    if (status !== 'ready') throw new LimsError('common.version_conflict', 'file_not_ready');
    const path = job['object_path'];
    if (job['expires_at'] != null && Date.parse(iso(job['expires_at'])) <= Date.parse(ctx.now())) throw new LimsError('common.not_found');
    // defence in depth next to export_jobs__path__ck: a path outside the caller's tenant prefix (or another bucket) is never read
    if (typeof path !== 'string' || job['bucket'] !== EXPORT_BUCKET || path.split('/')[0] !== tenantId) throw new LimsError('common.not_found');
    const id = String(job['id']);
    const accessEntry = { action: 'data.export', entityType: 'billing_export', entityId: id, outcome: 'allowed', detail: { stage: 'download' } } as const;
    const fileName = `${String(job['kind']).replace(/_/g, '-')}-${id}.${String(job['format'])}`;
    const contentType = TYPES[String(job['format'])] ?? 'application/octet-stream';
    const downloaded = () => activity(ctx, tenantId, actorId, 'export_downloaded', id, { kind: job['kind'], format: job['format'] });
    return { path, fileName, contentType, access, accessEntry, downloaded };
  }

  async function content(ctx: BalanceCtx, raw: unknown): Promise<{ fileName: string; contentType: string; bytes: Uint8Array }> {
    const l = await locate(ctx, raw);
    await l.access(l.accessEntry);
    await l.downloaded();
    const bytes = await (ctx as any).storage.get(EXPORT_BUCKET, l.path) as Uint8Array;
    return { fileName: l.fileName, contentType: l.contentType, bytes };
  }

  /** B29a handler path: same checks + the activity row, then the input for the core ctx.download.stream (which reads the bytes and writes the access_log row; P-2). */
  async function prepareDownload(ctx: BalanceCtx, raw: unknown) {
    const l = await locate(ctx, raw);
    await l.downloaded();
    return { bucket: EXPORT_BUCKET, objectPath: l.path, filename: l.fileName, contentType: l.contentType, scanState: 'clean', access: l.accessEntry };
  }
  return { create, get, content, prepareDownload };
}
export type ExportService = ReturnType<typeof createExportService>;
