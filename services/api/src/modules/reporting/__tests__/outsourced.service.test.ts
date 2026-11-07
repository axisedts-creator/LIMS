// C6-T10 — outsourced intake, API side: O1 upload, O2 list, O3 confirm, O4 withdraw, O5 download (02-TRD §6.4; 01-PRD AC-04.1/.3/.4/.6;
// 07-SECURITY T9, A12, REQ-SEC-083/084/085). Real core createUploads over a fake storage; fake tx (see outsourced.helpers.ts).
// ASSUMED contract (spec gives none): ../service/outsourced.service.ts exports createOutsourcedService({ newId? }) with
//   upload(ctx, {orderItemId, file:{filename,mimeType,bytes}, externalLabName}) -> InputFile body (snake_case, OpenAPI InputFile only)
//   list(ctx, {orderItemId}) -> {data: InputFile[]}
//   confirm(ctx, {fileId, expectedVersion, body:{patient_match_confirmed}}) -> InputFile
//   withdraw(ctx, {fileId, expectedVersion, body:{reason_code, reason_text?}}) -> InputFile
//   download(ctx, {fileId}) -> {bytes, filename, contentType}
// ctx = {tenantId, actor, requestId, tx, now, uploads, storage, audit.access, log, metrics}. Errors are LimsError codes. Enqueue = SELECT app.enqueue_job(id, payload, job_key, ...).
import { describe, expect, it } from 'vitest';
import {
  BUCKET, CENTRE_1, ITEM_1, ITEM_2, ITEM_B, ITEM_LAB, ITEM_REMOVED, MEM, REPORT_1, REPORT_B, SANITIZED, SENTINEL_NAME, TENANT_A, TENANT_B, USER,
  eicarPdf, fileRow, idN, incoming, makeApiCtx, makeDb, makeStorage, pdfBytes, rejection, sanitizedPath, sha256, world,
  type Row,
} from './outsourced.helpers.js';

const INPUT_FILE_KEYS = ['id', 'kind', 'order_item_id', 'state', 'original_filename', 'size_bytes', 'page_count', 'external_lab_name', 'caption', 'last_error_code', 'confirmed_at', 'version'];
const LAB = 'Synthetic Reference Lab';

async function svc() {
  const mod: any = await import('../service/outsourced.service.js');
  return mod.createOutsourcedService({}) as any;
}
function env(seed: Record<string, Row[]> = {}, over: Record<string, unknown> = {}) {
  const db = makeDb({ ...world(), ...seed }); const storage = makeStorage(); const c = makeApiCtx(db, storage, over);
  return { db, storage, ...c };
}
const upload = (s: any, ctx: any, o: Record<string, unknown> = {}) =>
  s.upload(ctx, { orderItemId: ITEM_1, file: incoming(pdfBytes()), externalLabName: LAB, ...o });
const code = (e: any) => e?.code;

describe('O1 uploadOutsourcedReport — AC-04.1', () => {
  it('2 MB PDF + lab name -> pending_scan, quarantine object, DB row, process task queued', async () => {
    const s = await svc(); const { db, storage, ctx } = env(); const bytes = pdfBytes(2 * 1024 * 1024);
    const body = await s.upload(ctx, { orderItemId: ITEM_1, file: incoming(bytes), externalLabName: LAB });
    expect(body).toMatchObject({ kind: 'outsourced_pdf', order_item_id: ITEM_1, state: 'pending_scan', external_lab_name: LAB, size_bytes: bytes.length, version: 1 });
    const row = db.file(body.id)!;
    expect(row).toMatchObject({ tenant_id: TENANT_A, centre_id: CENTRE_1, kind: 'outsourced_pdf', state: 'pending_scan', external_lab_name: LAB, sha256_original: sha256(bytes), size_bytes: bytes.length, declared_mime: 'application/pdf' });
    expect(row.quarantine_object_path).toMatch(new RegExp(`^${TENANT_A}/quarantine/\\d{4}/\\d{2}/${body.id}\\.bin$`));
    expect(row.sanitized_object_path ?? null).toBeNull();
    expect(storage.has(BUCKET, row.quarantine_object_path)).toBe(true);
    expect(storage.paths()).toEqual([row.quarantine_object_path]);                                  // nothing outside quarantine yet
    const jobs = db.jobsOf('reporting.process_input_file'); expect(jobs).toHaveLength(1);
    expect(JSON.stringify(jobs[0]!.payload)).toContain(body.id); expect(String(jobs[0]!.jobKey)).toContain(body.id);
  });
  it('response is exactly the OpenAPI InputFile (no object path, no hash, no tenant)', async () => {
    const s = await svc(); const { ctx } = env(); const body = await upload(s, ctx);
    for (const k of Object.keys(body)) expect(INPUT_FILE_KEYS).toContain(k);
    expect(JSON.stringify(body)).not.toMatch(/quarantine|sanitized|sha256|tenant_id|reporting-inputs/i);
  });
  it('staff cannot preview a file that is still pending_scan (O5 -> reporting.input_file_not_ready, nothing read)', async () => {
    const s = await svc(); const { storage, ctx } = env(); const body = await upload(s, ctx);
    expect(code(await rejection(s.download(ctx, { fileId: body.id })))).toBe('reporting.input_file_not_ready');
    expect(storage.reads()).toHaveLength(0);
  });
  it('scanner unavailable -> still pending_scan (fail closed, never ready)', async () => {
    const s = await svc(); const { db, ctx } = env({}, { scan: async () => 'unavailable' });
    const body = await upload(s, ctx); expect(body.state).toBe('pending_scan'); expect(db.file(body.id)!.state).toBe('pending_scan');
  });
  it('hostile client filename never reaches the storage key; stored name has no path separators', async () => {
    const s = await svc(); const { db, storage, ctx } = env();
    const body = await upload(s, ctx, { file: incoming(pdfBytes(4096), '../../etc/pass wd.pdf') });
    const row = db.file(body.id)!;
    expect(storage.paths().join('|')).not.toMatch(/\.\.|etc|pass/); expect(row.original_filename).not.toMatch(/[\\/]|\.\./); expect(body.original_filename).not.toMatch(/[\\/]|\.\./);
  });
  it('lab name of 120 chars is accepted', async () => {
    const s = await svc(); const { ctx } = env(); const body = await upload(s, ctx, { externalLabName: 'L'.repeat(120) });
    expect(body.external_lab_name).toHaveLength(120);
  });
});

describe('O1 rejections never store, never persist, never queue — AC-04.2 (inline hit), AC-04.6', () => {
  const none = (db: ReturnType<typeof makeDb>, storage: ReturnType<typeof makeStorage>) => {
    expect(db.files()).toHaveLength(0); expect(storage.objects.size).toBe(0); expect(db.jobs).toHaveLength(0);
  };
  it('scanner hit at upload (EICAR) -> reporting.outsourced_pdf_rejected, nothing stored', async () => {
    const s = await svc(); const { db, storage, ctx, metrics } = env();
    expect(code(await rejection(upload(s, ctx, { file: incoming(eicarPdf()) })))).toBe('reporting.outsourced_pdf_rejected'); none(db, storage);
    // AC-04.2: alert metric increments on the inline path too (same name + label as the worker)
    expect(metrics.filter((m) => m.name === 'lims_reporting_sandbox_rejections_total' && m.labels?.reason === 'infected')).toHaveLength(1);
  });
  it('> 15 MB -> common.payload_too_large', async () => {
    const s = await svc(); const { db, storage, ctx } = env();
    expect(code(await rejection(upload(s, ctx, { file: incoming(pdfBytes(15 * 1024 * 1024 + 1)) })))).toBe('common.payload_too_large'); none(db, storage);
  });
  it.each([
    ['HTML polyglot named .pdf', incoming(new TextEncoder().encode('<html><script>alert(1)</script></html>'))],
    ['PDF bytes named .html', incoming(pdfBytes(4096), 'report.html', 'text/html')],
    ['PDF bytes declared image/png', incoming(pdfBytes(4096), 'report.pdf', 'image/png')],
    ['PNG bytes named .pdf', incoming(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))],
    ['empty file', incoming(new Uint8Array(0))],
  ])('%s -> common.unsupported_media_type', async (_n, file) => {
    const s = await svc(); const { db, storage, ctx } = env();
    expect(code(await rejection(upload(s, ctx, { file })))).toBe('common.unsupported_media_type'); none(db, storage);
  });
  it.each([['empty', ''], ['121 chars', 'L'.repeat(121)], ['not a string', 42], ['missing', undefined], ['object', { a: 1 }]])('external_lab_name %s -> common.validation_failed', async (_n, v) => {
    const s = await svc(); const { db, storage, ctx } = env();
    expect(code(await rejection(upload(s, ctx, { externalLabName: v })))).toBe('common.validation_failed'); none(db, storage);
  });
  it.each([['unknown item', idN(0xdead)], ['lab (not outsourced) item', ITEM_LAB], ['removed item', ITEM_REMOVED], ['tenant B item (BOLA)', ITEM_B], ['not a uuid', 'x']])('%s -> common.not_found or validation_failed, nothing stored', async (_n, orderItemId) => {
    const s = await svc(); const { db, storage, ctx } = env();
    expect(['common.not_found', 'common.validation_failed']).toContain(code(await rejection(upload(s, ctx, { orderItemId })))); none(db, storage);
  });
  it('no ctx.uploads -> fails closed (no row, no object)', async () => {
    const s = await svc(); const { db, storage, ctx } = env({}, { uploads: undefined });
    await rejection(upload(s, ctx)); none(db, storage);
  });
});

describe('O2 listOutsourcedReports', () => {
  it('lists only the item\'s own files, newest data shape = InputFile; other items and tenants are invisible', async () => {
    const s = await svc();
    const mine = fileRow({ state: 'ready' }), other = fileRow({ order_item_id: ITEM_2 }), foreign = fileRow({ tenant_id: TENANT_B, order_item_id: ITEM_B });
    const { ctx } = env({ input_files: [mine, other, foreign] });
    const out = await s.list(ctx, { orderItemId: ITEM_1 });
    expect(out.data.map((f: any) => f.id)).toEqual([mine.id]);
    for (const f of out.data) { for (const k of Object.keys(f)) expect(INPUT_FILE_KEYS).toContain(k); }
    expect(JSON.stringify(out)).not.toMatch(/quarantine|sanitized|sha256|tenant_id/i);
  });
  it('another tenant\'s item id yields nothing (empty or not_found), never its files', async () => {
    const s = await svc(); const foreign = fileRow({ tenant_id: TENANT_B, order_item_id: ITEM_B });
    const { ctx } = env({ input_files: [foreign] });
    const r = await s.list(ctx, { orderItemId: ITEM_B }).catch((e: any) => ({ err: code(e) }));
    expect(r.err ? r.err : r.data).toEqual(r.err ? 'common.not_found' : []);
  });
});

describe('O3 confirmOutsourcedReport — AC-04.4', () => {
  const ready = () => fileRow({ state: 'ready', sanitized_object_path: 'x', sanitized_sha256: sha256('s'), page_count: 3, detected_mime: 'application/pdf' });
  it('ready + patient match + If-Match -> confirmed; item outsourced_ready; report needs_assembly; assembly queued', async () => {
    const s = await svc(); const f = ready(); const { db, ctx } = env({ input_files: [f] });
    const body = await s.confirm(ctx, { fileId: f.id, expectedVersion: 1, body: { patient_match_confirmed: true } });
    expect(body).toMatchObject({ id: f.id, state: 'confirmed', version: 2 }); expect(typeof body.confirmed_at).toBe('string');
    expect(db.file(f.id)).toMatchObject({ state: 'confirmed', version: 2 }); expect([USER, MEM]).toContain(db.file(f.id)!.confirmed_by);
    expect(db.item(ITEM_1)!.outsourced_ready).toBe(true); expect(db.item(ITEM_2)!.outsourced_ready).toBe(false);
    expect(db.report(REPORT_1)!.needs_assembly).toBe(true);
    const jobs = db.jobsOf('reporting.assemble_report'); expect(jobs.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(jobs[0]!.payload)).toContain(REPORT_1); expect(String(jobs[0]!.jobKey)).toBe(`assemble:${REPORT_1}`);
  });
  it.each([[false], [undefined], ['true'], [1], [null]])('patient_match_confirmed=%s -> common.validation_failed, no write', async (v) => {
    const s = await svc(); const f = ready(); const { db, ctx } = env({ input_files: [f] });
    expect(code(await rejection(s.confirm(ctx, { fileId: f.id, expectedVersion: 1, body: { patient_match_confirmed: v } })))).toBe('common.validation_failed');
    expect(db.writes()).toHaveLength(0); expect(db.file(f.id)!.state).toBe('ready');
  });
  it('no If-Match -> common.precondition_required; stale -> common.version_conflict; no write', async () => {
    const s = await svc(); const f = ready(); const { db, ctx } = env({ input_files: [f] });
    expect(code(await rejection(s.confirm(ctx, { fileId: f.id, expectedVersion: undefined, body: { patient_match_confirmed: true } })))).toBe('common.precondition_required');
    expect(code(await rejection(s.confirm(ctx, { fileId: f.id, expectedVersion: 7, body: { patient_match_confirmed: true } })))).toBe('common.version_conflict');
    expect(db.writes()).toHaveLength(0); expect(db.item(ITEM_1)!.outsourced_ready).toBe(false);
  });
  it.each([['pending_scan'], ['scanning'], ['sanitizing'], ['quarantined'], ['rejected'], ['withdrawn']])('state %s -> cannot confirm (input_file_not_ready / outsourced_pdf_rejected), item stays not ready', async (state) => {
    const s = await svc(); const f = fileRow({ state, last_error_code: state === 'quarantined' || state === 'rejected' ? 'reporting.outsourced_pdf_rejected' : null }); const { db, ctx } = env({ input_files: [f] });
    expect(['reporting.input_file_not_ready', 'reporting.outsourced_pdf_rejected']).toContain(code(await rejection(s.confirm(ctx, { fileId: f.id, expectedVersion: 1, body: { patient_match_confirmed: true } }))));
    expect(db.file(f.id)!.state).toBe(state); expect(db.item(ITEM_1)!.outsourced_ready).toBe(false); expect(db.jobsOf('reporting.assemble_report')).toHaveLength(0);
  });
  it('two concurrent confirms with the same If-Match: exactly one wins, the other is common.version_conflict', async () => {
    const s = await svc(); const f = ready(); const { db, ctx } = env({ input_files: [f] });
    const call = () => s.confirm(ctx, { fileId: f.id, expectedVersion: 1, body: { patient_match_confirmed: true } });
    const r = await Promise.allSettled([call(), call()]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const lost = r.find((x) => x.status === 'rejected') as PromiseRejectedResult; expect(code(lost.reason)).toBe('common.version_conflict');
    expect(db.file(f.id)).toMatchObject({ state: 'confirmed', version: 2 });
  });
  it('another tenant\'s file -> common.not_found and nothing changes (BOLA)', async () => {
    const s = await svc(); const f = fileRow({ tenant_id: TENANT_B, order_item_id: ITEM_B, state: 'ready' }); const { db, ctx } = env({ input_files: [f] });
    expect(code(await rejection(s.confirm(ctx, { fileId: f.id, expectedVersion: 1, body: { patient_match_confirmed: true } })))).toBe('common.not_found');
    expect(db.writes()).toHaveLength(0); expect(db.file(f.id)!.state).toBe('ready');
  });
  it('body with an extra key is refused (no mass assignment of state/tenant)', async () => {
    const s = await svc(); const f = ready(); const { db, ctx } = env({ input_files: [f] });
    expect(code(await rejection(s.confirm(ctx, { fileId: f.id, expectedVersion: 1, body: { patient_match_confirmed: true, state: 'ready', tenant_id: TENANT_B } })))).toBe('common.validation_failed');
    expect(db.writes()).toHaveLength(0);
  });
});

describe('O4 withdrawOutsourcedReport', () => {
  const confirmed = () => fileRow({ state: 'confirmed', version: 4, sanitized_object_path: 'x', confirmed_by: USER, confirmed_at: '2026-11-07T11:00:00.000Z' });
  const wd = (s: any, ctx: any, f: Row, body: Row = { reason_code: 'wrong_patient' }, v: number | null = f['version']) =>
    s.withdraw(ctx, { fileId: f['id'], expectedVersion: v === null ? undefined : v, body });
  it('confirmed -> withdrawn: item no longer outsourced_ready, assembly queued, reason stored', async () => {
    const s = await svc(); const f = confirmed(); const { db, ctx } = env({ input_files: [f] });
    db.item(ITEM_1)!.outsourced_ready = true;
    const body = await wd(s, ctx, f, { reason_code: 'wrong_patient', reason_text: 'synthetic note' });
    expect(body).toMatchObject({ state: 'withdrawn', version: 5 });
    expect(db.file(f.id)).toMatchObject({ state: 'withdrawn', withdrawn_reason_code: 'wrong_patient', withdrawn_reason_text: 'synthetic note' });
    expect(db.item(ITEM_1)!.outsourced_ready).toBe(false); expect(db.jobsOf('reporting.assemble_report').length).toBeGreaterThanOrEqual(1);
  });
  it('outsourced_ready means exactly ONE confirmed file (TRD §3): confirm A, confirm B -> false; withdraw A -> true again', async () => {
    const s = await svc(); const a = fileRow({ state: 'ready' }), b = fileRow({ state: 'ready' }); const { db, ctx } = env({ input_files: [a, b] });
    await s.confirm(ctx, { fileId: a.id, expectedVersion: 1, body: { patient_match_confirmed: true } });
    expect(db.item(ITEM_1)!.outsourced_ready).toBe(true);
    await s.confirm(ctx, { fileId: b.id, expectedVersion: 1, body: { patient_match_confirmed: true } });
    expect(db.item(ITEM_1)!.outsourced_ready).toBe(false);
    await s.withdraw(ctx, { fileId: a.id, expectedVersion: db.file(a.id)!.version, body: { reason_code: 'wrong_patient' } });
    expect(db.item(ITEM_1)!.outsourced_ready).toBe(true);
  });
  it('ready (never confirmed) -> withdrawn without touching readiness', async () => {
    const s = await svc(); const f = fileRow({ state: 'ready' }); const { db, ctx } = env({ input_files: [f] });
    expect((await wd(s, ctx, f)).state).toBe('withdrawn'); expect(db.item(ITEM_1)!.outsourced_ready).toBe(false);
  });
  it.each([[{ reason_code: 'not_in_set' }], [{}], [{ reason_code: 'wrong_patient', reason_text: 'x'.repeat(501) }], [{ reason_code: 'wrong_patient', extra: 1 }]])('invalid body %j -> common.validation_failed, no write', async (body) => {
    const s = await svc(); const f = confirmed(); const { db, ctx } = env({ input_files: [f] });
    expect(code(await rejection(wd(s, ctx, f, body as Row)))).toBe('common.validation_failed'); expect(db.writes()).toHaveLength(0);
  });
  describe('common.immutable_record — file attached to a released / superseded report version (02-TRD O4)', () => {
    const version = (f: Row, status: string, o: Row = {}) =>
      ({ id: idN(0x3000 + Math.floor(Math.random() * 0xfff)), tenant_id: TENANT_A, report_id: REPORT_1, status, content_snapshot: { outsourcedAttachments: [{ inputFileId: f['id'] }] }, ...o });
    it.each([['released'], ['superseded']])('confirmed file in a %s version -> rejected, file still confirmed, readiness unchanged, nothing queued', async (status) => {
      const s = await svc(); const f = confirmed(); const { db, ctx } = env({ input_files: [f], report_versions: [version(f, status)] });
      db.item(ITEM_1)!.outsourced_ready = true;
      expect(code(await rejection(wd(s, ctx, f)))).toBe('common.immutable_record');
      expect(db.file(f.id)).toMatchObject({ state: 'confirmed', version: 4 }); expect(db.item(ITEM_1)!.outsourced_ready).toBe(true);
      expect(db.writes()).toHaveLength(0); expect(db.jobsOf('reporting.assemble_report')).toHaveLength(0);
    });
    it('confirmed file only in a draft version -> withdraw succeeds', async () => {
      const s = await svc(); const f = confirmed(); const { db, ctx } = env({ input_files: [f], report_versions: [version(f, 'draft')] });
      db.item(ITEM_1)!.outsourced_ready = true;
      expect((await wd(s, ctx, f)).state).toBe('withdrawn'); expect(db.item(ITEM_1)!.outsourced_ready).toBe(false);
    });
    it('a released version that holds a DIFFERENT file, or another tenant\'s version holding this id, does not block', async () => {
      const s = await svc(); const f = confirmed(); const other = fileRow({ state: 'confirmed' });
      const { db, ctx } = env({ input_files: [f, other], report_versions: [version(other, 'released'), version(f, 'released', { tenant_id: TENANT_B, report_id: REPORT_B })] });
      expect((await wd(s, ctx, f)).state).toBe('withdrawn');
      const lookup = db.stmts.find((st) => /reporting\.report_versions/i.test(st.text))!; expect(lookup.values).toContain(TENANT_A);
    });
    it('a ready (never confirmed) file skips the released-version lookup entirely', async () => {
      const s = await svc(); const f = fileRow({ state: 'ready' }); const { db, ctx } = env({ input_files: [f], report_versions: [version(f, 'released')] });
      expect((await wd(s, ctx, f)).state).toBe('withdrawn');
      expect(db.stmts.filter((st) => /reporting\.report_versions/i.test(st.text))).toHaveLength(0);
    });
  });
  it('If-Match missing -> 428, stale -> 409; cross-tenant -> not_found', async () => {
    const s = await svc(); const f = confirmed(); const foreign = fileRow({ tenant_id: TENANT_B, order_item_id: ITEM_B, state: 'ready' }); const { db, ctx } = env({ input_files: [f, foreign] });
    expect(code(await rejection(wd(s, ctx, f, { reason_code: 'wrong_patient' }, null)))).toBe('common.precondition_required');
    expect(code(await rejection(wd(s, ctx, f, { reason_code: 'wrong_patient' }, 1)))).toBe('common.version_conflict');
    expect(code(await rejection(wd(s, ctx, foreign)))).toBe('common.not_found'); expect(db.writes()).toHaveLength(0);
  });
});

describe('O5 downloadOutsourcedReport — AC-04.3 (previewable only after sanitise)', () => {
  const sanitizedFile = (state: string, extra: Row = {}) => {
    const f = fileRow({ state, original_filename: SENTINEL_NAME, ...extra }); f['sanitized_object_path'] = sanitizedPath(TENANT_A, f['id']); f['sanitized_sha256'] = sha256(SANITIZED); f['page_count'] = 3; return f;
  };
  function withObjects(f: Row, over: Record<string, unknown> = {}) {
    const e = env({ input_files: [f] }, over);
    e.storage.objects.set(`${BUCKET}::${f['sanitized_object_path']}`, SANITIZED); e.storage.objects.set(`${BUCKET}::${f['quarantine_object_path']}`, pdfBytes(4096, 'UNSANITISED'));
    return e;
  }
  it.each([['ready'], ['confirmed']])('%s -> the SANITISED bytes (never the quarantine object) + access log report.outsourced_view', async (state) => {
    const s = await svc(); const f = sanitizedFile(state); const { storage, access, ctx } = withObjects(f);
    const out = await s.download(ctx, { fileId: f['id'] });
    expect(Buffer.from(out.bytes).equals(Buffer.from(SANITIZED))).toBe(true); expect(out.contentType).toBe('application/pdf');
    expect(storage.reads().map((r) => r.path)).toEqual([f['sanitized_object_path']]);
    expect(access).toHaveLength(1); expect(access[0]).toMatchObject({ action: 'report.outsourced_view', entityType: 'input_file', entityId: f['id'] });
  });
  it('download filename cannot inject headers (no CR/LF/quote/path from the client filename)', async () => {
    const s = await svc(); const f = sanitizedFile('ready', { original_filename: 'a";\r\nX-Evil: 1;/../b.pdf' }); const { ctx } = withObjects(f);
    const out = await s.download(ctx, { fileId: f['id'] }); expect(out.filename).not.toMatch(/[\r\n"\\/]/);
  });
  it.each([['pending_scan'], ['scanning'], ['sanitizing'], ['quarantined'], ['rejected'], ['withdrawn']])('state %s -> reporting.input_file_not_ready, nothing read, no success access log', async (state) => {
    const s = await svc(); const f = sanitizedFile(state); if (state !== 'withdrawn') { f['sanitized_object_path'] = null; } const { storage, access, ctx } = withObjects(f);
    expect(code(await rejection(s.download(ctx, { fileId: f['id'] })))).toBe('reporting.input_file_not_ready');
    expect(storage.reads()).toHaveLength(0); expect(access.filter((a) => a['outcome'] === 'success' || a['outcome'] === undefined)).toHaveLength(0);
  });
  it('another tenant\'s file -> common.not_found, nothing read', async () => {
    const s = await svc(); const f = sanitizedFile('ready', { tenant_id: TENANT_B, order_item_id: ITEM_B }); const { storage, ctx } = withObjects(f);
    expect(code(await rejection(s.download(ctx, { fileId: f['id'] })))).toBe('common.not_found'); expect(storage.reads()).toHaveLength(0);
  });
});

describe('REQ-SEC-024: every reporting statement of a full upload -> confirm flow carries the tenant', () => {
  it('tenant_id predicate + tenant value in every statement touching reporting.*', async () => {
    const s = await svc(); const { db, ctx } = env(); const up = await upload(s, ctx);
    const f = db.file(up.id)!; Object.assign(f, { state: 'ready', sanitized_object_path: 'p', page_count: 1 });
    await s.confirm(ctx, { fileId: up.id, expectedVersion: 1, body: { patient_match_confirmed: true } }); await s.list(ctx, { orderItemId: ITEM_1 });
    const stmts = db.reporting().filter((x) => !/g_cs_reasons/.test(x.text));
    expect(stmts.length).toBeGreaterThan(3);
    for (const st of stmts) { expect(st.text, st.text).toMatch(/tenant_id/); expect(st.values, st.text).toContain(TENANT_A); }
  });
});
