// BL-T15 exports: B28 createBillingExport, B29 getBillingExport, B29a getBillingExportContent (export.service.ts). Spec: PRD US-BL-12.4 (limits 100,000 / PDF 5,000 -> 422 billing.export_too_large),
// US-BL-12.5 (access_log data.export at creation and on EVERY download; content only by streaming B29a, never a Storage URL - 08 A13 P-2; privileged), 02-TRD §5 (B28-B29a, ExportJob, access-log table
// entityType billing_export detail.stage create|download), §10 (billing.export_render), §11.1 (LIMS_BILLING_EXPORT_MAX_ROWS / _PDF_MAX_ROWS / _TTL_HOURS), 05-SCHEMA billing.export_jobs, 07-SECURITY abuse case A20.
// Fails now: service/export.service.ts does not exist. Seams ASSUMED, see t15.helpers.ts header (writer: dispute if wrong). B28 body is the TRD body verbatim (snake_case).
// xlsx: BL-T19 removed the `common.feature_disabled` branch; the former 'xlsx -> feature_disabled' test is replaced on purpose by the xlsx cases below (that branch removal is BL-T19 done_when).
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { loadBillingConfig } from '../../config.js';
import { BUCKET, CENTRE, code, exportRow, id, makeWorld, MEMBERSHIP, SECRET_URL, TENANT_A, TENANT_B, USER, type World } from './t15.helpers.js';
import { createExportService } from '../export.service.js';

const cfg = { exportMaxRows: 10, exportPdfMaxRows: 5, exportTtlHours: 24 };
const setup = (o: Parameters<typeof makeWorld>[0] = {}, config: Record<string, number> = cfg) => { const w = makeWorld(o); return { w, svc: createExportService({ repo: w.repo as never, config: config as never }) as any }; };
const create = (w: World, svc: any, body: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => w.inTx((ctx) => svc.create(ctx, { kind: 'sales_register', format: 'xml', filters: {}, ...body }), over);
const nothingWritten = (w: World) => { expect(w.writes(), 'no repo write').toEqual([]); expect(w.s.access).toHaveLength(0); expect(w.s.exports).toHaveLength(0); expect(w.s.enqueued).toHaveLength(0); };
const FORBIDDEN_KEYS = ['bucket', 'object_path', 'sha256', 'error_code', 'url', 'signed_url', 'requested_by_membership_id', 'tenant_id', 'filters'];

describe('US-BL-12.5 B28 create: job row, render task, access_log at creation', () => {
  it('inserts a queued export_jobs row for the tenant/requester, enqueues billing.export_render in the same tx, returns an ExportJob without any URL or storage field', async () => {
    const { w, svc } = setup({ counts: 7 });
    const filters = { fiscal_year_bs: '2083/84', from: '2026-11-01T00:00:00.000Z', to: '2026-11-30T23:59:59.000Z', centre_id: CENTRE };
    const job = await create(w, svc, { filters });
    expect(w.s.exports).toHaveLength(1);
    expect(w.s.exports[0]).toMatchObject({ tenant_id: TENANT_A, kind: 'sales_register', format: 'xml', status: 'queued', requested_by_membership_id: MEMBERSHIP, created_by: USER, updated_by: USER, filters });
    expect(w.s.exports[0]!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(w.s.enqueued).toEqual([{ tenantId: TENANT_A, exportId: w.s.exports[0]!.id }]);
    expect(job).toMatchObject({ id: w.s.exports[0]!.id, kind: 'sales_register', format: 'xml', status: 'queued' });
    expect(typeof job.created_at).toBe('string');
    for (const k of FORBIDDEN_KEYS) expect(k in job, k).toBe(false);
    expect(Object.keys(job).every((k) => ['id', 'kind', 'format', 'status', 'row_count', 'created_at', 'completed_at', 'expires_at'].includes(k)), JSON.stringify(Object.keys(job))).toBe(true);
    expect(JSON.stringify(job)).not.toMatch(/https?:|billing-exports|signed/i);
  });
  it('access_log: exactly one data.export row, entityType billing_export, entityId = job id, outcome allowed, detail.stage = create; plus an export_created activity row (non-PHI details)', async () => {
    const { w, svc } = setup({ counts: 1 });
    const job = await create(w, svc, { kind: 'audit_trail', format: 'pdf', filters: { actor_membership_id: MEMBERSHIP } });
    expect(w.s.access).toHaveLength(1);
    expect(w.s.access[0]).toMatchObject({ action: 'data.export', entityType: 'billing_export', entityId: job.id, outcome: 'allowed', detail: { stage: 'create' } });
    expect(w.s.insertedActivity).toHaveLength(1);
    expect(w.s.insertedActivity[0]).toMatchObject({ tenant_id: TENANT_A, action: 'export_created', actor_id: USER, actor_membership_id: MEMBERSHIP });
    expect(JSON.stringify(w.s.insertedActivity[0].details ?? {})).not.toContain(MEMBERSHIP); // filters (who was audited) are not copied into the activity details
  });
  it('the access_log is mandatory: no ctx.audit -> common.internal and nothing written; a failing audit write rolls the job and the enqueue back (no export without a log row)', async () => {
    const a = setup({ counts: 1, noAudit: true }); expect((await code(create(a.w, a.svc))).code).toBe('common.internal'); expect(a.w.s.exports).toHaveLength(0); expect(a.w.s.enqueued).toHaveLength(0);
    const b = setup({ counts: 1 }); b.w.accessError = () => new Error('audit down');
    await expect(create(b.w, b.svc)).rejects.toThrow('audit down'); expect(b.w.s.exports).toHaveLength(0); expect(b.w.s.enqueued).toHaveLength(0); expect(b.w.s.insertedActivity).toHaveLength(0);
  });
  it('actor and tenant come from ctx; a tenantId / requestedBy / status / bucket in the body is ignored or rejected, never stored', async () => {
    const { w, svc } = setup({ counts: 1 });
    try { await create(w, svc, { tenant_id: TENANT_B, status: 'ready', bucket: 'x', object_path: `${TENANT_B}/x` }); } catch (e) { expect((e as { code: string }).code).toBe('common.validation_failed'); } // rejecting unknown body keys is as good as ignoring them
    expect(w.s.exports.every((e) => e.tenant_id === TENANT_A && e.status === 'queued' && e.bucket == null && e.object_path == null)).toBe(true);
  });
  it('B28 is privileged: the service also asks IdentityPort for billing.data.export (defence in depth behind the pipeline aal2 check)', async () => {
    const { w, svc } = setup({ counts: 1 });
    await create(w, svc);
    expect(w.roleCalls.some((r) => r?.permission === 'billing.data.export')).toBe(true);
    const d = setup({ counts: 1 });
    const deny = { ports: { IdentityPort: { async assertRole() { throw new LimsError('auth.forbidden'); } } } };
    expect((await code(create(d.w, d.svc, {}, deny))).code).toBe('auth.forbidden'); nothingWritten(d.w);
  });
});

describe('US-BL-12.4 export range limits', () => {
  it('rows == max is accepted, max+1 is 422 billing.export_too_large with nothing inserted, enqueued or logged', async () => {
    const ok = setup({ counts: 10 }); await create(ok.w, ok.svc); expect(ok.w.s.exports).toHaveLength(1);
    const big = setup({ counts: 11 });
    const e = await code(create(big.w, big.svc)); expect(e.code).toBe('billing.export_too_large');
    expect(big.w.s.exports).toHaveLength(0); expect(big.w.s.enqueued).toHaveLength(0); expect(big.w.s.access).toHaveLength(0); expect(big.w.s.insertedActivity).toHaveLength(0);
  });
  it('PDF has the lower cap: 5 rows ok, 6 rows -> too large; the same 6 rows as XML are fine', async () => {
    const a = setup({ counts: 5 }); await create(a.w, a.svc, { format: 'pdf' }); expect(a.w.s.exports).toHaveLength(1);
    const b = setup({ counts: 6 }); expect((await code(create(b.w, b.svc, { format: 'pdf' }))).code).toBe('billing.export_too_large'); expect(b.w.s.exports).toHaveLength(0);
    const c = setup({ counts: 6 }); await create(c.w, c.svc, { format: 'xml' }); expect(c.w.s.exports).toHaveLength(1);
  });
  it('defaults come from config: 100,000 rows for xml, 5,000 for pdf (LIMS_BILLING_EXPORT_MAX_ROWS / _PDF_MAX_ROWS)', async () => {
    const d = loadBillingConfig({} as never); expect([d.exportMaxRows, d.exportPdfMaxRows, d.exportTtlHours]).toEqual([100000, 5000, 24]);
    const cases: Array<[number, string, boolean]> = [[100000, 'xml', true], [100001, 'xml', false], [5000, 'pdf', true], [5001, 'pdf', false]];
    for (const [n, format, ok] of cases) {
      const { w, svc } = setup({ counts: n }, { exportMaxRows: d.exportMaxRows, exportPdfMaxRows: d.exportPdfMaxRows, exportTtlHours: d.exportTtlHours });
      if (ok) { await create(w, svc, { format }); expect(w.s.exports, `${n} ${format}`).toHaveLength(1); } else expect((await code(create(w, svc, { format }))).code, `${n} ${format}`).toBe('billing.export_too_large');
    }
  });
  it('the count is taken for the caller tenant and the same filters as the render will use', async () => {
    const { w, svc } = setup({ counts: 1 });
    await create(w, svc, { kind: 'credit_notes', filters: { from: '2026-11-01T00:00:00.000Z', to: '2026-11-30T00:00:00.000Z', centre_id: CENTRE } });
    expect(w.calls.find((c) => c.name === 'countExportRows')!.args).toMatchObject({ tenantId: TENANT_A, kind: 'credit_notes', filters: { from: '2026-11-01T00:00:00.000Z', to: '2026-11-30T00:00:00.000Z', centre_id: CENTRE } });
  });
  it('xlsx is accepted (BL-T19): queued xlsx job + render task + access_log create row, exactly like xml; no feature_disabled', async () => {
    const { w, svc } = setup({ counts: 1 }); const job = await create(w, svc, { format: 'xlsx' });
    expect(job).toMatchObject({ kind: 'sales_register', format: 'xlsx', status: 'queued' });
    expect(w.s.exports).toHaveLength(1); expect(w.s.exports[0]).toMatchObject({ tenant_id: TENANT_A, format: 'xlsx', status: 'queued' });
    expect(w.s.enqueued).toEqual([{ tenantId: TENANT_A, exportId: w.s.exports[0]!.id }]);
    expect(w.s.access).toHaveLength(1); expect(w.s.access[0]).toMatchObject({ action: 'data.export', entityType: 'billing_export', entityId: job.id, outcome: 'allowed', detail: { stage: 'create' } });
  });
  it.each(['sales_register', 'cancelled_invoices', 'credit_notes', 'audit_trail', 'daily_cash'])('xlsx %s is accepted', async (kind) => {
    const { w, svc } = setup({ counts: 1 }); expect((await create(w, svc, { kind, format: 'xlsx' })).format).toBe('xlsx'); expect(w.s.exports).toHaveLength(1);
  });
  it('xlsx is privileged too (IdentityPort billing.data.export) and uses the general cap, not the PDF cap: 10 ok, 11 -> billing.export_too_large (nothing written)', async () => {
    const a = setup({ counts: 1 }); await create(a.w, a.svc, { format: 'xlsx' }); expect(a.w.roleCalls.some((r) => r?.permission === 'billing.data.export')).toBe(true);
    const deny = { ports: { IdentityPort: { async assertRole() { throw new LimsError('auth.forbidden'); } } } };
    const d = setup({ counts: 1 }); expect((await code(create(d.w, d.svc, { format: 'xlsx' }, deny))).code).toBe('auth.forbidden'); nothingWritten(d.w);
    const ok = setup({ counts: 10 }); await create(ok.w, ok.svc, { format: 'xlsx' }); expect(ok.w.s.exports).toHaveLength(1);
    const big = setup({ counts: 11 }); expect((await code(create(big.w, big.svc, { format: 'xlsx' }))).code).toBe('billing.export_too_large'); nothingWritten(big.w);
  });
});

describe('B28 input validation', () => {
  it.each([
    [{ kind: 'patients' }], [{ kind: undefined }], [{ format: 'csv' }], [{ format: 'XML' }], [{ filters: { centre_id: 'x' } }], [{ filters: { from: '2026-12-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' } }],
    [{ filters: { fiscal_year_bs: '2083' } }], [{ filters: { actor_membership_id: "'; --" } }], [{ filters: { unknown_filter: 1 } }], [{ filters: [] }], [{ filters: 'x' }],
  ])('%j -> common.validation_failed, nothing counted or written', async (body) => {
    const { w, svc } = setup({ counts: 1 });
    expect((await code(create(w, svc, body as never))).code).toBe('common.validation_failed'); expect(w.writes()).toEqual([]); expect(w.s.access).toHaveLength(0);
  });
  it('every kind in the TRD enum x xml is accepted (sales_register, cancelled_invoices, credit_notes, audit_trail, daily_cash, invoice_documents)', async () => {
    for (const kind of ['sales_register', 'cancelled_invoices', 'credit_notes', 'audit_trail', 'daily_cash', 'invoice_documents']) {
      const { w, svc } = setup({ counts: 1 }); expect((await create(w, svc, { kind })).kind).toBe(kind);
    }
  });
});

describe('B29 getBillingExport: status only, never a URL; tenant-scoped', () => {
  it('returns the ExportJob of this tenant (status, row_count, expires_at) with no storage fields', async () => {
    const { w, svc } = setup({ exports: [exportRow(1)] });
    const job = await w.inTx((ctx) => svc.get(ctx, { exportId: id(4001) }));
    expect(job).toMatchObject({ id: id(4001), kind: 'sales_register', format: 'xml', status: 'ready', row_count: 2, expires_at: '2026-11-09T06:00:00.000Z' });
    for (const k of FORBIDDEN_KEYS) expect(k in job, k).toBe(false);
    expect(JSON.stringify(job)).not.toMatch(/billing-exports|https?:/i); expect(w.s.access).toHaveLength(0);
  });
  it('another tenant\'s id, an unknown id and a malformed id -> common.not_found / common.validation_failed; the other tenant\'s row is never read', async () => {
    const { w, svc } = setup({ exports: [exportRow(1, { tenant_id: TENANT_B })] });
    expect((await code(w.inTx((ctx) => svc.get(ctx, { exportId: id(4001) })))).code).toBe('common.not_found');
    expect((await code(w.inTx((ctx) => svc.get(ctx, { exportId: id(4999) })))).code).toBe('common.not_found');
    expect((await code(w.inTx((ctx) => svc.get(ctx, { exportId: '../etc/passwd' })))).code).toBe('common.validation_failed');
    expect(w.calls.every((c) => c.args.tenantId === TENANT_A)).toBe(true);
  });
  it('a failed job exposes status failed but not the internal error_code or stack', async () => {
    const { w, svc } = setup({ exports: [exportRow(1, { status: 'failed', error_code: 'reporting.render_unavailable', object_path: null, bucket: null, sha256: null })] });
    const job = await w.inTx((ctx) => svc.get(ctx, { exportId: id(4001) })); expect(job.status).toBe('failed'); expect('error_code' in job).toBe(false);
  });
});

describe('US-BL-12.5 B29a content: streamed bytes, access_log on EVERY download, never a URL', () => {
  const bytes = new TextEncoder().encode('<register/>');
  const ready = (over: Record<string, unknown> = {}, objs: Record<string, Uint8Array> | null = null) => {
    const row = exportRow(1, over as never);
    return setup({ exports: [row], objects: objs ?? { [`${BUCKET}/${row.object_path}`]: bytes } });
  };
  it('ready -> bytes read from billing-exports at the row object_path, file name from kind/format, content type from format', async () => {
    const { w, svc } = ready();
    const r = await w.inTx((ctx) => svc.content(ctx, { exportId: id(4001) }));
    expect(Buffer.from(r.bytes).toString()).toBe('<register/>');
    expect(r.contentType).toBe('application/xml'); expect(r.fileName).toMatch(/^[A-Za-z0-9._-]+\.xml$/);
    expect(w.getCalls).toEqual([{ bucket: BUCKET, path: `${TENANT_A}/2026/11/${id(4001)}.xml` }]);
    expect(Object.keys(r).sort()).toEqual(expect.arrayContaining(['bytes', 'contentType', 'fileName']));
    expect(JSON.stringify({ ...r, bytes: undefined })).not.toMatch(/https?:|billing-exports|object_path/i);
  });
  it('pdf -> application/pdf and .pdf', async () => {
    const row = exportRow(2, { format: 'pdf', object_path: `${TENANT_A}/2026/11/${id(4002)}.pdf` });
    const { w, svc } = setup({ exports: [row], objects: { [`${BUCKET}/${row.object_path}`]: new TextEncoder().encode('%PDF-1.7') } });
    const r = await w.inTx((ctx) => svc.content(ctx, { exportId: id(4002) })); expect(r.contentType).toBe('application/pdf'); expect(r.fileName).toMatch(/\.pdf$/);
  });
  it('xlsx -> the spreadsheetml content type and .xlsx (BL-T19)', async () => {
    const row = exportRow(3, { format: 'xlsx', object_path: `${TENANT_A}/2026/11/${id(4003)}.xlsx` });
    const { w, svc } = setup({ exports: [row], objects: { [`${BUCKET}/${row.object_path}`]: new TextEncoder().encode('PK') } });
    const r = await w.inTx((ctx) => svc.content(ctx, { exportId: id(4003) }));
    expect(r.contentType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); expect(r.fileName).toMatch(/^[A-Za-z0-9._-]+\.xlsx$/);
  });
  it('every call writes one access_log row (data.export, billing_export, entityId, detail.stage = download): 3 downloads -> 3 rows (+ a download activity row each)', async () => {
    const { w, svc } = ready();
    for (let i = 0; i < 3; i++) await w.inTx((ctx) => svc.content(ctx, { exportId: id(4001) }));
    expect(w.s.access).toHaveLength(3);
    for (const a of w.s.access) expect(a).toMatchObject({ action: 'data.export', entityType: 'billing_export', entityId: id(4001), outcome: 'allowed', detail: { stage: 'download' } });
    expect(w.s.insertedActivity.map((a: any) => a.action)).toEqual(['export_downloaded', 'export_downloaded', 'export_downloaded']);
  });
  it('fail closed: if the access_log write fails the bytes are not returned', async () => {
    const { w, svc } = ready(); w.accessError = () => new Error('audit down');
    await expect(w.inTx((ctx) => svc.content(ctx, { exportId: id(4001) }))).rejects.toThrow('audit down');
  });
  it('no signed URL is ever requested from storage, and none appears in any result (08 A13 P-2, abuse case A20)', async () => {
    const { w, svc } = ready();
    const r = await w.inTx((ctx) => svc.content(ctx, { exportId: id(4001) })); const j = await w.inTx((ctx) => svc.get(ctx, { exportId: id(4001) }));
    expect(w.signedUrlCalls).toBe(0); expect(JSON.stringify([{ ...r, bytes: '' }, j])).not.toContain(SECRET_URL);
  });
  it.each(['queued', 'running', 'failed'])('status %s -> 409 common.version_conflict with detail file_not_ready; storage untouched', async (status) => {
    const { w, svc } = ready({ status, object_path: null, bucket: null });
    const e = await code(w.inTx((ctx) => svc.content(ctx, { exportId: id(4001) }))); expect(e.code).toBe('common.version_conflict'); expect(e.detail).toBe('file_not_ready'); expect(w.getCalls).toEqual([]);
  });
  it('expired -> 404 common.not_found; a ready job whose expires_at has passed (purge not yet run) is not served either', async () => {
    const a = ready({ status: 'expired', object_path: null }); expect((await code(a.w.inTx((ctx) => a.svc.content(ctx, { exportId: id(4001) })))).code).toBe('common.not_found');
    const b = ready({ expires_at: '2026-11-08T05:59:59.000Z' }); expect((await code(b.w.inTx((ctx) => b.svc.content(ctx, { exportId: id(4001) })))).code).toBe('common.not_found'); expect(b.w.getCalls).toEqual([]);
  });
  it('other tenant\'s export -> common.not_found, no storage read, no access row (REQ-SEC tenant isolation, B29a)', async () => {
    const row = exportRow(1, { tenant_id: TENANT_B, object_path: `${TENANT_B}/2026/11/${id(4001)}.xml` });
    const { w, svc } = setup({ exports: [row], objects: { [`${BUCKET}/${row.object_path}`]: bytes } });
    expect((await code(w.inTx((ctx) => svc.content(ctx, { exportId: id(4001) })))).code).toBe('common.not_found'); expect(w.getCalls).toEqual([]); expect(w.s.access).toHaveLength(0);
  });
  it('defence in depth: a row whose object_path points into another tenant\'s prefix is refused before any storage read', async () => {
    const evil = `${TENANT_B}/2026/11/${id(4001)}.xml`;
    const { w, svc } = setup({ exports: [exportRow(1, { object_path: evil })], objects: { [`${BUCKET}/${evil}`]: bytes } });
    expect((await code(w.inTx((ctx) => svc.content(ctx, { exportId: id(4001) })))).code).toBe('common.not_found'); expect(w.getCalls).toEqual([]); expect(w.s.access).toHaveLength(0);
  });
});
