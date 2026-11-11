// C6-T16 — R10 createReportPrint, R11 getReportPrint, R12 downloadReportPrintPdf, R13 createBulkPrint, T5 previewReportTemplate
// (02-TRD §6.2/§6.4; 05-SCHEMA §2.8 + §2.14; 01-PRD AC-12.1-12.4, AC-13.1; 07-SECURITY A15, REQ-SEC-100, P-10; 08 A13 D-37, review fix #5, #36).
// These five operationIds leave the 501 list. Helpers + ASSUMED shapes: print.helpers.ts. The worker half (render_print / build_bulk_print / purge) is in services/worker.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../core/module.js';
import {
  CENTRE_A, CENTRE_B, EXPIRES, NOW, PDF, PID, PRINT_PDF, PRINTS_BUCKET, REPORTS_BUCKET, SENTINEL_NAME, TEMPLATE, TEMPLATE_VER_DRAFT, TEMPLATE_VER_PUB, TENANT_A, TENANT_B, USER, VID,
  draft, hasNull, idN, lower, printRow, printSetup, rejection, released, reportRow, req, versionRow, withPdf, type PrintOpts, type PrintSetup, type Row,
} from './print.helpers.js';

const R10 = 'createReportPrint'; const R11 = 'getReportPrint'; const R12 = 'downloadReportPrintPdf'; const R13 = 'createBulkPrint'; const T5 = 'previewReportTemplate';
let manifest: any;
beforeAll(async () => {
  const k = join(mkdtempSync(join(tmpdir(), 'c6-t16-')), 'otp.key'); writeFileSync(k, Buffer.alloc(32, 7));
  process.env.LIMS_CORE_ENV = 'dev'; delete process.env.NODE_ENV; delete process.env.LIMS_REPORTING_ALLOW_REAL_PROVIDERS; process.env.LIMS_REPORTING_OTP_HMAC_KEY_FILE = k;
  manifest = (await import('../index.js')).manifest;
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const call = (op: string, s: PrintSetup, r: ReturnType<typeof req>, ctx: Row = s.ctx({ operationId: op })) => manifest.handlers[op](r, ctx);
const print = (s: PrintSetup, body: unknown, vid: string = VID(1, 1), ctx?: Row) => call(R10, s, req(body, { report_version_id: vid }), ctx);
const bulk = (s: PrintSetup, body: unknown, ctx?: Row) => call(R13, s, req(body), ctx);
const preview = (s: PrintSetup, body: unknown, tid: string = TEMPLATE, ctx?: Row) => call(T5, s, req(body, { template_id: tid }), ctx);
const one = (o: PrintOpts = {}) => printSetup({ versions: [released()], ...o });
const PRINT_KEYS = ['id', 'state', 'variant', 'copies', 'expires_at', 'excluded_ids', 'error_code'];
const noWrites = (s: PrintSetup) => { expect(s.db.writes()).toHaveLength(0); expect(s.db.jobs).toHaveLength(0); expect(s.access).toHaveLength(0); };

describe('contract', () => {
  const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/reporting.yaml'));
  const find = (op: string) => Object.values(spec.paths).flatMap((p: any) => Object.values(p) as any[]).find((x: any) => x?.operationId === op);
  it.each([[R10, 'reporting.report.print', 'required', '201'], [R11, 'reporting.report.print', 'none', '200'], [R12, 'reporting.report.print', 'none', '200'],
    [R13, 'reporting.report.bulk_download', 'required', '202'], [T5, 'reporting.template.manage', 'required', '202']])('%s: permission %s, idempotency %s, success %s documented', (op, perm, idem, ok) => {
    const o = find(op); expect(o['x-permission']).toBe(perm); expect(o['x-idempotency']).toBe(idem); expect(Object.keys(o.responses)).toContain(ok);
  });
  it.each([R10, R11, R12, R13, T5])('%s is no longer a 501 stub: without a request context it fails closed (auth.unauthenticated), echoing no input', async (op) => {
    const planted = 'PLANTED-TOKEN-7d2e';
    const e = await rejection(manifest.handlers[op]({ params: { report_version_id: planted, print_id: planted, template_id: planted }, query: {}, headers: { authorization: planted }, body: { ids: [planted] } },
      { operationId: op, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } }));
    expect(e?.code).toBe('auth.unauthenticated'); expect(JSON.stringify({ c: e?.code, m: e?.message, d: e?.details })).not.toContain(planted);
  });
});

describe('R10 letterhead print of a released version (AC-12.1, review fix #5, #36)', () => {
  it('201 PrintJob ready at once: allowlisted keys, no null, expires in 24 h', async () => {
    const s = one(); const r = await print(s, { variant: 'letterhead', copies: 3 });
    expect(r.status).toBe(201);
    expect(Object.keys(r.body).filter((k) => !PRINT_KEYS.includes(k))).toEqual([]); expect(hasNull(r.body)).toBe(false);
    expect(r.body).toMatchObject({ state: 'ready', variant: 'letterhead', copies: 3, expires_at: EXPIRES }); expect(r.body.id).toMatch(UUID);
  });
  it('print_jobs row: kind single, the version\'s own centre (not the working centre), its template version, NO file, not a draft', async () => {
    const s = one({ versions: [released(1, 1, { centre_id: CENTRE_B })], workingCentre: CENTRE_A }); const r = await print(s, { variant: 'letterhead', copies: 3 });
    expect(s.prints()).toHaveLength(1);
    expect(s.prints()[0]).toMatchObject({ id: r.body.id, tenant_id: TENANT_A, kind: 'single', centre_id: CENTRE_B, report_version_ids: [VID(1, 1)], variant: 'letterhead', copies: 3,
      draft_watermark: false, state: 'ready', expires_at: EXPIRES, created_by: USER, template_version_id: idN(0x902) });
    expect(s.prints()[0]!['object_path'] ?? null).toBeNull();
  });
  it('stores no file and enqueues no job: R12 will stream the canonical version PDF', async () => {
    const s = one(); await print(s, { variant: 'letterhead', copies: 1 });
    expect(s.storage.calls.filter((c) => c.op === 'put')).toEqual([]); expect(s.printJobs()).toHaveLength(0); expect(s.db.jobs).toHaveLength(0);
  });
  it('records a print delivery: channel print, purpose report_ready, no message template, status sent, key <print_job_id>:print, no destination', async () => {
    const s = one(); const r = await print(s, { variant: 'letterhead', copies: 1 });
    expect(s.deliveries()).toHaveLength(1);
    const d = s.deliveries()[0]!;
    expect(d).toMatchObject({ tenant_id: TENANT_A, channel: 'print', purpose: 'report_ready', recipient_kind: 'patient', status: 'sent', idempotency_key: `${r.body.id}:print`,
      report_id: expect.any(String), report_version_no: 1 });
    expect(d['template_code'] ?? null).toBeNull(); expect(d['sent_at']).toBeTruthy();
    for (const k of ['destination_e164', 'destination_sha256', 'destination_masked']) expect(d[k] ?? null).toBeNull();
    expect(d['report_id']).toBe(versionRow(1, 1)['report_id']);
  });
  it('access log report.print on the report_version (centre of the version), outcome allowed; no patient data in it, in logs or in the print row', async () => {
    const s = one(); await print(s, { variant: 'letterhead', copies: 1 });
    expect(s.access).toHaveLength(1);
    expect(s.access[0]).toMatchObject({ action: 'report.print', entityType: 'report_version', entityId: VID(1, 1), outcome: 'allowed' });
    expect(s.allText({ p: s.prints() })).not.toContain(SENTINEL_NAME);
  });
  it('a released version needs no release permission: the draft gate (assertRole reporting.report.release) is not consulted, even for a caller who lacks it', async () => {
    const s = one({ denied: ['reporting.report.release'] }); const r = await print(s, { variant: 'letterhead', copies: 1 });
    expect(r.status).toBe(201); expect(s.roleCalls.filter((c) => c.permission === 'reporting.report.release')).toEqual([]);
  });
  it('two prints of one version are two jobs with two distinct delivery keys', async () => {
    const s = one(); const a = await print(s, { variant: 'letterhead', copies: 1 }); const b = await print(s, { variant: 'letterhead', copies: 1 });
    expect(a.body.id).not.toBe(b.body.id); expect(new Set(s.deliveries().map((d) => d['idempotency_key'])).size).toBe(2);
  });
});

describe('R10 plain print of a released version (AC-12.2)', () => {
  it('201 PrintJob in state rendering; a render_print job (5 attempts) with tenant + print ids is enqueued; no file yet', async () => {
    const s = one(); const r = await print(s, { variant: 'plain', copies: 2 });
    expect(r.status).toBe(201); expect(r.body).toMatchObject({ state: 'rendering', variant: 'plain', copies: 2, expires_at: EXPIRES });
    expect(s.prints()[0]).toMatchObject({ id: r.body.id, kind: 'single', variant: 'plain', copies: 2, state: 'rendering', draft_watermark: false, report_version_ids: [VID(1, 1)], expires_at: EXPIRES });
    expect(s.prints()[0]!['object_path'] ?? null).toBeNull();
    expect(s.db.jobs).toHaveLength(1);
    expect(s.db.jobs[0]).toMatchObject({ identifier: 'reporting.render_print', maxAttempts: 5 });
    expect(s.db.jobs[0]!.payload).toMatchObject({ tenant_id: TENANT_A, print_job_id: r.body.id });
  });
  it('also records the print delivery (key <print_job_id>:print) and the report.print access log', async () => {
    const s = one(); const r = await print(s, { variant: 'plain', copies: 1 });
    expect(s.deliveries().map((d) => [d['channel'], d['purpose'], d['status'], d['idempotency_key']])).toEqual([['print', 'report_ready', 'sent', `${r.body.id}:print`]]);
    expect(s.access).toEqual([expect.objectContaining({ action: 'report.print', entityType: 'report_version', entityId: VID(1, 1) })]);
  });
});

describe('R10 draft print: only with print + release (AC-12.3, D-37)', () => {
  it('unreleased version, caller lacks reporting.report.release -> reporting.report_not_released; nothing written, no job, no delivery, no access log', async () => {
    const s = printSetup({ versions: [draft()], denied: ['reporting.report.release'] });
    for (const variant of ['letterhead', 'plain']) {
      const e = await rejection(print(s, { variant, copies: 1 })); expect(e?.code).toBe('reporting.report_not_released');
    }
    noWrites(s); expect(s.prints()).toHaveLength(0); expect(s.deliveries()).toHaveLength(0);
  });
  it.each(['letterhead', 'plain'])('unreleased version, caller holds print + release: 201 rendering with draft_watermark (variant %s) — even letterhead renders a file (no canonical draft PDF to stream)', async (variant) => {
    const s = printSetup({ versions: [draft()] }); const r = await print(s, { variant, copies: 1 });
    expect(r.status).toBe(201); expect(r.body).toMatchObject({ state: 'rendering', variant });
    expect(s.roleCalls.map((c) => c.permission)).toContain('reporting.report.release');
    expect(s.prints()[0]).toMatchObject({ kind: 'single', variant, state: 'rendering', draft_watermark: true, report_version_ids: [VID(1, 1)] });
    expect(s.db.jobs.map((j) => j.identifier)).toEqual(['reporting.render_print']); expect(s.db.jobs[0]!.payload).toMatchObject({ tenant_id: TENANT_A, print_job_id: r.body.id });
    expect(s.access[0]).toMatchObject({ action: 'report.print', entityType: 'report_version', entityId: VID(1, 1) });
  });
  it('a failure of the role check other than auth.forbidden is not turned into report_not_released', async () => {
    const s = printSetup({ versions: [draft()] });
    s.ports.IdentityPort.assertRole = async () => { throw Object.assign(new Error('identity down'), { code: 'common.unavailable' }); };
    const e = await rejection(print(s, { variant: 'plain', copies: 1 })); expect(e?.code).toBe('common.unavailable'); noWrites(s);
  });
  it('no IdentityPort for the draft gate -> fails closed (common.internal), nothing written', async () => {
    const s = printSetup({ versions: [draft()] }); delete s.ports.IdentityPort;
    const e = await rejection(print(s, { variant: 'plain', copies: 1 })); expect(e?.code).toBe('common.internal'); noWrites(s);
  });
});

describe('R10 input, tenancy and centre scope', () => {
  it.each([[{ variant: 'plain' }], [{ copies: 1 }], [{ variant: 'sepia', copies: 1 }], [{ variant: 'plain', copies: 0 }], [{ variant: 'plain', copies: 6 }], [{ variant: 'plain', copies: 1.5 }],
    [{ variant: 'plain', copies: '2' }], [{ variant: 'plain', copies: 1, extra: true }], [null], ['x']])('invalid body %j -> common.validation_failed, nothing written', async (body) => {
    const s = one(); const e = await rejection(print(s, body)); expect(e?.code).toBe('common.validation_failed'); noWrites(s);
  });
  it.each([1, 5])('copies %i is accepted', async (copies) => {
    const s = one(); expect((await print(s, { variant: 'plain', copies })).body.copies).toBe(copies);
  });
  it('unknown version id -> common.not_found, nothing written', async () => {
    const s = one(); const e = await rejection(print(s, { variant: 'plain', copies: 1 }, idN(0xdead))); expect(e?.code).toBe('common.not_found'); noWrites(s);
  });
  it('non-uuid id -> rejected without touching the database', async () => {
    const s = one(); const e = await rejection(print(s, { variant: 'plain', copies: 1 }, "x'; DROP TABLE reporting.print_jobs;--")); expect(['common.validation_failed', 'common.not_found']).toContain(e?.code);
    expect(s.db.writes()).toHaveLength(0);
  });
  it('another tenant\'s version -> the same common.not_found; even with RLS off every statement names tenant_id', async () => {
    const s = printSetup({ versions: [released(1, 1, { tenant_id: TENANT_B })], rls: false }); const e = await rejection(print(s, { variant: 'plain', copies: 1 }));
    expect(e?.code).toBe('common.not_found'); noWrites(s);
    expect(s.db.reportingStmts().length).toBeGreaterThan(0); expect(s.db.reportingStmts().every((x) => /\btenant_id\b/i.test(x.text))).toBe(true);
  });
  it('a version in a centre outside the caller\'s scope (RLS hides it) -> common.not_found', async () => {
    const s = printSetup({ versions: [released(1, 1, { centre_id: CENTRE_B })], centres: [CENTRE_A] });
    const e = await rejection(print(s, { variant: 'plain', copies: 1 })); expect(e?.code).toBe('common.not_found'); noWrites(s);
  });
  it('device / portal actors are refused (staff endpoint)', async () => {
    const s = one(); const c = s.ctx(); c.actor = { type: 'device', id: USER };
    const e = await rejection(print(s, { variant: 'plain', copies: 1 }, VID(1, 1), c)); expect(e?.code).toBe('auth.forbidden'); noWrites(s);
  });
  it('errors never echo the id', async () => {
    const s = one(); const planted = 'PLANTED-9c1b'; const e = await rejection(print(s, { variant: 'plain', copies: 1 }, planted));
    expect(JSON.stringify({ c: e?.code, m: e?.message, d: e?.details })).not.toContain(planted);
  });
  it('a failing enqueue is surfaced (the request fails so the pipeline rolls the transaction back); it is never swallowed into a 201 with a job that will not run', async () => {
    const s = one({ failOn: [{ match: /enqueue_job/i, error: () => new Error('queue down') }] });
    const e = await rejection(print(s, { variant: 'plain', copies: 1 })); expect(e).toBeInstanceOf(Error); expect(JSON.stringify({ m: e.message, d: e.details })).not.toContain(SENTINEL_NAME);
  });
});

describe('R11 getReportPrint', () => {
  const states: Array<[string, Row]> = [['ready', {}], ['rendering', { state: 'rendering', object_path: null, sha256: null, page_count: null }],
    ['failed', { state: 'failed', object_path: null, error_code: 'reporting.template_invalid' }]];
  it.each(states)('200 PrintJob in state %s: allowlisted keys only (no object_path / sha256 / ids of creators), no null', async (st, over) => {
    const s = printSetup({ prints: [printRow(1, over)] }); const r = await call(R11, s, req(undefined, { print_id: PID(1) }));
    expect(r.status).toBe(200); expect(Object.keys(r.body).filter((k) => !PRINT_KEYS.includes(k))).toEqual([]); expect(hasNull(r.body)).toBe(false);
    expect(r.body).toMatchObject({ id: PID(1), state: st, variant: 'plain', copies: 1, expires_at: EXPIRES });
    if (st === 'failed') expect(r.body.error_code).toBe('reporting.template_invalid');
    expect(JSON.stringify(r.body)).not.toContain('/prints/');
  });
  it('a bulk print lists its excluded ids', async () => {
    const s = printSetup({ prints: [printRow(2, { kind: 'bulk', excluded_ids: [idN(0xe1), idN(0xe2)] })] }); const r = await call(R11, s, req(undefined, { print_id: PID(2) }));
    expect(r.body.excluded_ids).toEqual([idN(0xe1), idN(0xe2)]);
  });
  it('unknown / other tenant / other centre -> common.not_found (no existence leak); non-uuid -> not_found or validation_failed', async () => {
    const s = printSetup({ prints: [printRow(1)] }); expect((await rejection(call(R11, s, req(undefined, { print_id: PID(9) }))))?.code).toBe('common.not_found');
    const t = printSetup({ prints: [printRow(1, { tenant_id: TENANT_B })], rls: false }); expect((await rejection(call(R11, t, req(undefined, { print_id: PID(1) }))))?.code).toBe('common.not_found');
    expect(t.db.reportingStmts().every((x) => /\btenant_id\b/i.test(x.text))).toBe(true);
    const c = printSetup({ prints: [printRow(1, { centre_id: CENTRE_B })], centres: [CENTRE_A] }); expect((await rejection(call(R11, c, req(undefined, { print_id: PID(1) }))))?.code).toBe('common.not_found');
    expect(['common.not_found', 'common.validation_failed']).toContain((await rejection(call(R11, s, req(undefined, { print_id: 'zzz' }))))?.code);
  });
  it('is read-only: no write, no access log', async () => {
    const s = printSetup({ prints: [printRow(1)] }); await call(R11, s, req(undefined, { print_id: PID(1) })); expect(s.db.writes()).toHaveLength(0); expect(s.access).toHaveLength(0);
  });
});

describe('R12 downloadReportPrintPdf', () => {
  const v = released(); const canon = withPdf(v);
  const ok = (over: Row = {}, o: PrintOpts = {}) => printSetup({ versions: [v], prints: [printRow(1, over)], objects: { ...canon, [`${PRINTS_BUCKET}::${TENANT_A}/prints/${PID(1)}.pdf`]: PRINT_PDF }, ...o });
  const get = (s: PrintSetup, id: string = PID(1), ctx?: Row) => call(R12, s, req(undefined, { print_id: id }), ctx);
  it('a letterhead print of a released version streams the CANONICAL version PDF from bucket reports (no print file exists)', async () => {
    const s = ok({ variant: 'letterhead', object_path: null, sha256: null, page_count: null }); const r = await get(s);
    expect(r.status).toBe(200); expect(Buffer.from(r.body).equals(Buffer.from(PDF))).toBe(true);
    expect(s.storage.calls.filter((c) => c.op === 'read')).toEqual([expect.objectContaining({ bucket: REPORTS_BUCKET, path: v['pdf_object_path'] })]);
  });
  it('a plain print streams its own file from bucket reporting-prints', async () => {
    const s = ok(); const r = await get(s); expect(Buffer.from(r.body).equals(Buffer.from(PRINT_PDF))).toBe(true);
    expect(s.storage.calls.filter((c) => c.op === 'read')).toEqual([expect.objectContaining({ bucket: PRINTS_BUCKET, path: `${TENANT_A}/prints/${PID(1)}.pdf` })]);
  });
  it('a draft letterhead print has a file (draft_watermark) and streams that, not a canonical PDF', async () => {
    const s = ok({ variant: 'letterhead', draft_watermark: true }); const r = await get(s); expect(Buffer.from(r.body).equals(Buffer.from(PRINT_PDF))).toBe(true);
  });
  it('response headers: attachment with a neutral filename, application/pdf, nosniff, no-store; access log report.download on the print_job', async () => {
    const s = ok(); const r = await get(s); const h = lower(r.headers);
    expect(h['content-type']).toBe('application/pdf'); expect(h['x-content-type-options']).toBe('nosniff'); expect(h['cache-control']).toContain('no-store');
    expect(h['content-disposition']).toMatch(/^attachment; filename="[A-Za-z0-9._-]+\.pdf"$/); expect(h['content-disposition']).not.toContain(SENTINEL_NAME);
    expect(s.access).toEqual([expect.objectContaining({ action: 'report.download', entityType: 'print_job', entityId: PID(1), outcome: 'allowed' })]);
  });
  it.each([['rendering', { state: 'rendering', object_path: null }], ['failed', { state: 'failed', object_path: null, error_code: 'reporting.render_unavailable' }]])(
    'state %s -> reporting.print_not_ready; nothing read, no access log', async (_n, over) => {
      const s = ok(over); const e = await rejection(get(s)); expect(e?.code).toBe('reporting.print_not_ready');
      expect(s.storage.calls.filter((c) => c.op === 'read')).toEqual([]); expect(s.access).toEqual([]);
    });
  it('an expired print (state expired, or past expires_at) is not served', async () => {
    for (const over of [{ state: 'expired' }, { expires_at: '2026-11-07T11:00:00.000Z' }]) {
      const s = ok(over); const e = await rejection(get(s)); expect(['reporting.print_not_ready', 'common.not_found']).toContain(e?.code); expect(s.access).toEqual([]);
    }
  });
  it('an object_path outside the caller\'s tenant prefix is never read (common.internal)', async () => {
    const s = ok({ object_path: `${TENANT_B}/prints/${PID(1)}.pdf` }); const e = await rejection(get(s)); expect(e?.code).toBe('common.internal');
    expect(s.storage.calls.filter((c) => c.op === 'read')).toEqual([]);
  });
  it('unknown / other tenant / other centre -> common.not_found, nothing read', async () => {
    for (const o of [{ prints: [printRow(2)] }, { prints: [printRow(1, { tenant_id: TENANT_B })], rls: false }, { prints: [printRow(1, { centre_id: CENTRE_B })], centres: [CENTRE_A] }]) {
      const s = printSetup({ versions: [v], objects: canon, ...o }); const e = await rejection(get(s)); expect(e?.code).toBe('common.not_found'); expect(s.storage.calls.filter((c) => c.op === 'read')).toEqual([]);
    }
  });
  it('a letterhead print whose version is gone/unreadable fails closed (not_found or internal), never serves another file', async () => {
    const s = printSetup({ versions: [], prints: [printRow(1, { variant: 'letterhead', object_path: null })], objects: canon });
    const e = await rejection(get(s)); expect(['common.not_found', 'common.internal']).toContain(e?.code); expect(s.access).toEqual([]);
  });
  it('device / portal actors are refused', async () => {
    const s = ok(); const c = s.ctx(); c.actor = { type: 'portal', id: USER }; expect((await rejection(get(s, PID(1), c)))?.code).toBe('auth.forbidden');
  });
});

describe('R13 createBulkPrint (AC-12.4, REQ-SEC-100, A15)', () => {
  const N = (n: number): Row[] => Array.from({ length: n }, (_, k) => released(k + 1, 1));
  const ids = (n: number) => Array.from({ length: n }, (_, k) => VID(k + 1, 1));
  it('202 PrintJob rendering; print row kind bulk with the ids IN REQUEST ORDER, the working centre, 24 h expiry; build_bulk_print job (5 attempts)', async () => {
    const s = printSetup({ versions: N(5), workingCentre: CENTRE_A }); const order = [3, 1, 5, 2, 4].map((i) => VID(i, 1));
    const r = await bulk(s, { ids: order, variant: 'letterhead' });
    expect(r.status).toBe(202); expect(r.body).toMatchObject({ state: 'rendering', variant: 'letterhead', copies: 1, expires_at: EXPIRES }); expect(r.body.id).toMatch(UUID);
    expect(r.body.excluded_ids ?? []).toEqual([]); expect(Object.keys(r.body).filter((k) => !PRINT_KEYS.includes(k))).toEqual([]);
    expect(s.prints()).toHaveLength(1);
    expect(s.prints()[0]).toMatchObject({ id: r.body.id, tenant_id: TENANT_A, kind: 'bulk', centre_id: CENTRE_A, report_version_ids: order, variant: 'letterhead', state: 'rendering', draft_watermark: false, expires_at: EXPIRES, created_by: USER });
    expect(s.db.jobs).toHaveLength(1); expect(s.db.jobs[0]).toMatchObject({ identifier: 'reporting.build_bulk_print', maxAttempts: 5 });
    expect(s.db.jobs[0]!.payload).toMatchObject({ tenant_id: TENANT_A, print_job_id: r.body.id });
  });
  it('access log report.bulk_download on the print_job with the count; requires IdentityPort.assertRole reporting.report.bulk_download', async () => {
    const s = printSetup({ versions: N(50) }); const r = await bulk(s, { ids: ids(50), variant: 'letterhead' });
    expect(s.access).toEqual([expect.objectContaining({ action: 'report.bulk_download', entityType: 'print_job', entityId: r.body.id, outcome: 'allowed', detail: expect.objectContaining({ count: 50 }) })]);
    expect(s.roleCalls.map((c) => c.permission)).toContain('reporting.report.bulk_download');
  });
  it('aal1 -> auth.mfa_required and without the permission -> auth.forbidden: both propagate unchanged, nothing written', async () => {
    const m = printSetup({ versions: N(2), mfaRequired: ['reporting.report.bulk_download'] }); expect((await rejection(bulk(m, { ids: ids(2), variant: 'plain' })))?.code).toBe('auth.mfa_required'); noWrites(m);
    const f = printSetup({ versions: N(2), denied: ['reporting.report.bulk_download'] }); expect((await rejection(bulk(f, { ids: ids(2), variant: 'plain' })))?.code).toBe('auth.forbidden'); noWrites(f);
  });
  it('fails closed without an IdentityPort, and for a non-user actor', async () => {
    const s = printSetup({ versions: N(2) }); delete s.ports.IdentityPort; expect((await rejection(bulk(s, { ids: ids(2), variant: 'plain' })))?.code).toBe('common.internal'); noWrites(s);
    const t = printSetup({ versions: N(2) }); const c = t.ctx(); c.actor = { type: 'device', id: USER }; expect((await rejection(bulk(t, { ids: ids(2), variant: 'plain' }, c)))?.code).toBe('auth.forbidden'); noWrites(t);
  });
  it('excludes (and lists) unreleased, unknown, other-tenant and out-of-centre ids; only released in-scope ids are printed', async () => {
    const good = [released(1, 1), released(2, 1)]; const unreleased = draft(3, 1); const foreign = released(4, 1, { tenant_id: TENANT_B }); const away = released(5, 1, { centre_id: CENTRE_B });
    const s = printSetup({ versions: [...good, unreleased, foreign, away], centres: [CENTRE_A] }); const unknown = idN(0xdead);
    const req13 = [VID(1, 1), VID(3, 1), unknown, VID(2, 1), VID(4, 1), VID(5, 1)];
    const r = await bulk(s, { ids: req13, variant: 'letterhead' });
    expect(r.status).toBe(202);
    expect([...r.body.excluded_ids].sort()).toEqual([VID(3, 1), unknown, VID(4, 1), VID(5, 1)].sort());
    expect(s.prints()[0]!['report_version_ids']).toEqual([VID(1, 1), VID(2, 1)]);
    expect([...(s.prints()[0]!['excluded_ids'] as string[])].sort()).toEqual([...r.body.excluded_ids].sort());
    expect(s.access[0]).toMatchObject({ action: 'report.bulk_download', detail: expect.objectContaining({ count: 2 }) });
  });
  it('ASSUMED: nothing printable (every id excluded) -> reporting.report_not_released, no print row, no job', async () => {
    const s = printSetup({ versions: [draft(1, 1), draft(2, 1)] }); const e = await rejection(bulk(s, { ids: [VID(1, 1), VID(2, 1)], variant: 'letterhead' }));
    expect(e?.code).toBe('reporting.report_not_released'); noWrites(s); expect(s.prints()).toHaveLength(0);
  });
  it('a bulk print creates no patient delivery rows (it is not a send)', async () => {
    const s = printSetup({ versions: N(3) }); await bulk(s, { ids: ids(3), variant: 'letterhead' }); expect(s.deliveries()).toHaveLength(0);
  });
  it('200 ids are accepted', async () => {
    const s = printSetup({ versions: N(200) }); const r = await bulk(s, { ids: ids(200), variant: 'letterhead' }); expect(r.status).toBe(202); expect(s.prints()[0]!['report_version_ids']).toHaveLength(200);
  });
  it.each([[{ ids: [], variant: 'plain' }], [{ variant: 'plain' }], [{ ids: [VID(1, 1)] }], [{ ids: [VID(1, 1)], variant: 'sepia' }], [{ ids: [VID(1, 1), VID(1, 1)], variant: 'plain' }],
    [{ ids: ['nope'], variant: 'plain' }], [{ ids: [VID(1, 1)], variant: 'plain', extra: 1 }], [{ ids: 'x', variant: 'plain' }], [null]])('invalid body %j -> common.validation_failed, nothing written', async (body) => {
    const s = printSetup({ versions: N(2) }); const e = await rejection(bulk(s, body)); expect(e?.code).toBe('common.validation_failed'); noWrites(s);
  });
  it('201 ids -> common.validation_failed (cap 200, REQ-SEC-100) before any database work', async () => {
    const s = printSetup({ versions: N(2) }); const many = Array.from({ length: 201 }, (_, k) => idN(0x90000 + k));
    const e = await rejection(bulk(s, { ids: many, variant: 'plain' })); expect(e?.code).toBe('common.validation_failed'); noWrites(s); expect(s.db.stmts).toHaveLength(0);
  });
  it('the print row and logs carry only ids and counts, never patient data; every statement names tenant_id', async () => {
    const s = printSetup({ versions: N(2), rls: false }); await bulk(s, { ids: ids(2), variant: 'letterhead' });
    expect(s.allText({ p: s.prints() })).not.toContain(SENTINEL_NAME); expect(s.db.reportingStmts().every((x) => /\btenant_id\b/i.test(x.text))).toBe(true);
  });
});

describe('T5 previewReportTemplate (AC-13.1)', () => {
  it('202 PrintJob rendering of the DRAFT version: kind template_preview, no report versions, the working centre, 24 h expiry, render_print job', async () => {
    const s = printSetup({ workingCentre: CENTRE_B }); const r = await preview(s, { variant: 'plain' });
    expect(r.status).toBe(202); expect(r.body).toMatchObject({ state: 'rendering', variant: 'plain', copies: 1, expires_at: EXPIRES }); expect(Object.keys(r.body).filter((k) => !PRINT_KEYS.includes(k))).toEqual([]);
    expect(s.prints()).toHaveLength(1);
    expect(s.prints()[0]).toMatchObject({ id: r.body.id, tenant_id: TENANT_A, kind: 'template_preview', centre_id: CENTRE_B, report_version_ids: [], variant: 'plain', copies: 1, state: 'rendering',
      template_version_id: TEMPLATE_VER_DRAFT, expires_at: EXPIRES, created_by: USER });
    expect(s.db.jobs).toHaveLength(1); expect(s.db.jobs[0]).toMatchObject({ identifier: 'reporting.render_print', maxAttempts: 5 });
    expect(s.db.jobs[0]!.payload).toMatchObject({ tenant_id: TENANT_A, print_job_id: r.body.id });
  });
  it('without a draft the preview uses the template\'s current published version', async () => {
    const { templates, templateVersions } = { templates: [{ tenant_id: TENANT_A, id: TEMPLATE, family: 'laboratory', name: 'Default', current_version_id: TEMPLATE_VER_PUB, is_default: true }],
      templateVersions: [{ tenant_id: TENANT_A, id: TEMPLATE_VER_PUB, template_id: TEMPLATE, version_no: 1, status: 'published', config: {}, config_sha256: 'a'.repeat(64) }] };
    const s = printSetup({ templates, templateVersions }); await preview(s, { variant: 'letterhead' });
    expect(s.prints()[0]).toMatchObject({ kind: 'template_preview', variant: 'letterhead', template_version_id: TEMPLATE_VER_PUB });
  });
  it('uses synthetic data only: never reads reports / report_versions / patient data, writes only the print job, no delivery, no report.print access log', async () => {
    const s = printSetup({ versions: [released()], reports: [reportRow(1)] }); await preview(s, { variant: 'plain' });
    expect(s.stmtText()).not.toMatch(/reporting\.(reports|report_versions|report_order_items)/);
    expect(s.db.writes().every((w) => /reporting\.print_jobs/.test(w.text))).toBe(true); expect(s.deliveries()).toHaveLength(0);
    expect(s.access.filter((a) => a.action === 'report.print')).toEqual([]); expect(s.allText({ p: s.prints() })).not.toContain(SENTINEL_NAME);
  });
  it('the template itself is untouched (no write to report_templates / report_template_versions)', async () => {
    const s = printSetup(); await preview(s, { variant: 'plain' }); expect(s.db.writes().some((w) => /report_template/.test(w.text))).toBe(false);
  });
  it('unknown template / another tenant\'s template -> common.not_found; nothing written', async () => {
    const s = printSetup(); expect((await rejection(preview(s, { variant: 'plain' }, idN(0xdead))))?.code).toBe('common.not_found'); noWrites(s);
    const { templates, templateVersions } = { templates: [{ tenant_id: TENANT_B, id: TEMPLATE, family: 'laboratory', name: 'X', current_version_id: TEMPLATE_VER_PUB }],
      templateVersions: [{ tenant_id: TENANT_B, id: TEMPLATE_VER_PUB, template_id: TEMPLATE, version_no: 1, status: 'published', config: {}, config_sha256: 'a'.repeat(64) }] };
    const t = printSetup({ templates, templateVersions, rls: false }); expect((await rejection(preview(t, { variant: 'plain' })))?.code).toBe('common.not_found'); noWrites(t);
    expect(t.db.reportingStmts().every((x) => /\btenant_id\b/i.test(x.text))).toBe(true);
  });
  it.each([[{}], [{ variant: 'sepia' }], [{ variant: 'plain', copies: 2 }], [null]])('invalid body %j -> common.validation_failed', async (body) => {
    const s = printSetup(); expect((await rejection(preview(s, body)))?.code).toBe('common.validation_failed'); noWrites(s);
  });
  it('non-uuid template id -> not_found / validation_failed, no database write', async () => {
    const s = printSetup(); expect(['common.not_found', 'common.validation_failed']).toContain((await rejection(preview(s, { variant: 'plain' }, 'zzz')))?.code); expect(s.db.writes()).toHaveLength(0);
  });
});
