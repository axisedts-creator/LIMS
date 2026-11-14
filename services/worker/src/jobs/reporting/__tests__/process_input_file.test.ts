// C6-T10 — task `reporting.process_input_file` (02-TRD §9 row, 03-APP-FLOW §1.4/§2.4; 01-PRD AC-04.2/.3/.6/.7; 07-SECURITY T9, A12).
// pending_scan -> scanning -> (quarantined | sanitizing) -> (ready | rejected). Uses the fakes of the API-side T10 helpers (no live DB / ClamAV / qpdf).
// ASSUMED contract (spec gives none): ../tasks/process_input_file.ts exports
//   createProcessInputFile({ sandbox:{ sanitize(bytes): Promise<{ok:true,page_count,sha256,pdf_base64} | {ok:false,reason}> }, timeoutMs? }) -> TaskHandler
//   (the 02-TRD §5.2 /internal/sanitize contract; the sandbox client itself is C6-T12). payload = { tenant_id, input_file_id }.
// The worker has no ctx.uploads (services/worker/src/core/uploads): it reads the object with ctx.storage.read and scans with ctx.files.scan (08 A17 P-19);
// the "alert metric" is ctx.metrics.inc(<lims_reporting_*>). The manifest must register the task as `reporting.process_input_file`.
import { describe, expect, it } from 'vitest';
import { validateManifests } from '../../../core/manifest.js';
import {
  BUCKET, EICAR, ITEM_1, SANITIZED, SENTINEL_NAME, TENANT_A, TENANT_B, eicarPdf, fakeScan, fileRow, idN, makeDb, makeJobCtx, makeStorage, pdfBytes, sha256, world, type Row,
} from '../../../../../api/src/modules/reporting/__tests__/outsourced.helpers.js';

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const okReply = (bytes: Uint8Array = SANITIZED, pages = 3) => ({ ok: true as const, page_count: pages, sha256: sha256(bytes), pdf_base64: b64(bytes) });

async function build(sandbox: { sanitize: (b: Uint8Array) => Promise<any> }, o: { timeoutMs?: number } = {}) {
  const mod: any = await import('../tasks/process_input_file.js');
  return mod.createProcessInputFile({ sandbox, ...o }) as (payload: any, ctx: any) => Promise<void>;
}
function setup(row: Row = fileRow(), bytes: Uint8Array = pdfBytes(2 * 1024 * 1024), jobOver: Record<string, unknown> = {}, extraRows: Row[] = []) {
  const db = makeDb({ ...world(), input_files: [row, ...extraRows] }); const storage = makeStorage();
  storage.objects.set(`${BUCKET}::${row['quarantine_object_path']}`, bytes);
  const j = makeJobCtx(db, storage, jobOver); const calls: Uint8Array[] = [];
  const sandbox = (reply: any | ((b: Uint8Array) => Promise<any>)) => ({ sanitize: async (b: Uint8Array) => { calls.push(b); return typeof reply === 'function' ? reply(b) : reply; } });
  return { db, storage, ...j, row, calls, sandbox };
}
const run = async (h: (p: any, c: any) => Promise<void>, ctx: any, row: Row) => { await h({ tenant_id: ctx.tenantId, input_file_id: row['id'] }, ctx); };
const settle = (p: Promise<unknown>) => p.then(() => 'ok', (e) => e);
const REJECTED = 'reporting.outsourced_pdf_rejected';

describe('manifest registration', () => {
  it('worker manifest declares reporting.process_input_file and still validates', async () => {
    const { manifest }: any = await import('../index.js');
    expect(typeof manifest.tasks['reporting.process_input_file']).toBe('function'); expect(() => validateManifests([manifest])).not.toThrow();
    expect(manifest.maxAttempts?.['reporting.process_input_file'] ?? 5).toBe(5);
  });
});

describe('AC-04.2 — scanner hit (EICAR) -> quarantined', () => {
  it('state quarantined, error code set, alert metric incremented, sandbox never called, no sanitised object', async () => {
    const t = setup(fileRow(), eicarPdf()); const h = await build(t.sandbox(okReply()));
    await run(h, t.ctx, t.row);
    expect(t.db.file(t.row['id'])).toMatchObject({ state: 'quarantined', last_error_code: REJECTED });
    expect(t.db.file(t.row['id'])!.sanitized_object_path ?? null).toBeNull(); expect(t.db.file(t.row['id'])!.sanitized_sha256 ?? null).toBeNull();
    expect(t.calls).toHaveLength(0); expect(t.storage.paths().some((p) => p.includes('/outsourced/'))).toBe(false);
    const m = t.metrics.filter((x) => /^lims_reporting_/.test(x.name)); expect(m.length).toBeGreaterThanOrEqual(1);
  });
  it('the metric/log lines never carry the filename, the signature or the object path', async () => {
    const t = setup(fileRow({ original_filename: SENTINEL_NAME }), eicarPdf()); const h = await build(t.sandbox(okReply()));
    await run(h, t.ctx, t.row);
    const blob = JSON.stringify({ l: t.logs, m: t.metrics }); expect(blob).not.toContain('Sita-Karki'); expect(blob).not.toContain(EICAR); expect(blob).not.toContain(t.row['quarantine_object_path']);
  });
  it('a clean file does not increment the alert metric', async () => {
    const t = setup(); const h = await build(t.sandbox(okReply())); await run(h, t.ctx, t.row);
    expect(t.metrics.filter((x) => /quarantin|reject|infect|malware/i.test(x.name))).toHaveLength(0);
  });
  it('terminal: re-running a quarantined file changes nothing', async () => {
    const t = setup(fileRow({ state: 'quarantined', last_error_code: REJECTED, version: 3 }), eicarPdf()); const h = await build(t.sandbox(okReply()));
    await run(h, t.ctx, t.row); expect(t.db.file(t.row['id'])).toMatchObject({ state: 'quarantined', version: 3 }); expect(t.calls).toHaveLength(0);
  });
});

describe('AC-04.3 — clean -> sandbox sanitise -> ready', () => {
  it('stores the SANITISED file, sha + page_count, state ready; sandbox gets the original bytes once', async () => {
    const original = pdfBytes(2 * 1024 * 1024); const t = setup(fileRow(), original); const h = await build(t.sandbox(okReply(SANITIZED, 3)));
    await run(h, t.ctx, t.row);
    const f = t.db.file(t.row['id'])!;
    expect(f).toMatchObject({ state: 'ready', page_count: 3, sanitized_sha256: sha256(SANITIZED), detected_mime: 'application/pdf' }); expect(f.last_error_code ?? null).toBeNull();
    expect(f.sanitized_object_path).toMatch(new RegExp(`^${TENANT_A}/outsourced/\\d{4}/\\d{2}/${t.row['id']}\\.pdf$`));
    expect(Buffer.from(t.storage.get(BUCKET, f.sanitized_object_path)!).equals(Buffer.from(SANITIZED))).toBe(true);
    expect(t.calls).toHaveLength(1); expect(Buffer.from(t.calls[0]!).equals(Buffer.from(original))).toBe(true);
    expect(f.version).toBeGreaterThan(1);
  });
  it('the quarantine object is never exposed as the sanitised path', async () => {
    const t = setup(); const h = await build(t.sandbox(okReply())); await run(h, t.ctx, t.row);
    expect(t.db.file(t.row['id'])!.sanitized_object_path).not.toBe(t.row['quarantine_object_path']);
  });
  it('a crash between steps is recoverable: a row left in scanning / sanitizing is processed to ready', async () => {
    for (const state of ['scanning', 'sanitizing']) {
      const t = setup(fileRow({ state })); const h = await build(t.sandbox(okReply())); await run(h, t.ctx, t.row);
      expect(t.db.file(t.row['id'])!.state).toBe('ready');
    }
  });
  it('idempotent: re-running on ready / confirmed does not call the sandbox or rewrite the object', async () => {
    for (const state of ['ready', 'confirmed', 'withdrawn', 'rejected']) {
      const t = setup(fileRow({ state, version: 6 })); const h = await build(t.sandbox(okReply())); await run(h, t.ctx, t.row);
      expect(t.db.file(t.row['id'])).toMatchObject({ state, version: 6 }); expect(t.calls).toHaveLength(0); expect(t.storage.calls.filter((c) => c.op === 'put')).toHaveLength(0);
    }
  });
  it('never reaches ready in a retry that finds the sanitised object already stored (write-once) — either completes or fails closed, never loses the file', async () => {
    const t = setup(); const h = await build(t.sandbox(okReply())); await run(h, t.ctx, t.row);
    const f = t.db.file(t.row['id'])!; f.state = 'sanitizing';                                  // simulate: object stored, DB step lost
    const r = await settle(run(h, t.ctx, t.row));
    expect(['ready', 'sanitizing', 'rejected']).toContain(t.db.file(t.row['id'])!.state); if (r !== 'ok') expect(r).toBeInstanceOf(Error);
  });
});

describe('AC-04.6 / AC-04.7 — sandbox refusals and timeouts -> rejected, never ready', () => {
  it.each(['encrypted', 'malformed', 'too_many_pages', 'timeout', 'not_pdf'])('sandbox 422 reason=%s -> rejected + %s', async (reason) => {
    const t = setup(); const h = await build(t.sandbox({ ok: false, reason })); await run(h, t.ctx, t.row);
    const f = t.db.file(t.row['id'])!;
    expect(f).toMatchObject({ state: 'rejected', last_error_code: REJECTED }); expect(f.sanitized_object_path ?? null).toBeNull(); expect(f.sanitized_sha256 ?? null).toBeNull();
    expect(t.storage.paths().some((p) => p.includes('/outsourced/'))).toBe(false);
  });
  it('AC-04.7: a sandbox that never answers is cut off at the timeout -> rejected', async () => {
    const t = setup(); const h = await build(t.sandbox(() => new Promise(() => {})), { timeoutMs: 40 });
    await Promise.race([run(h, t.ctx, t.row), new Promise((_, rej) => setTimeout(() => rej(new Error('task hung past the timeout')), 3000))]);
    expect(t.db.file(t.row['id'])).toMatchObject({ state: 'rejected', last_error_code: REJECTED });
  });
  it('a sandbox call that aborts with a timeout error -> rejected', async () => {
    const t = setup(); const h = await build(t.sandbox(async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); }));
    await settle(run(h, t.ctx, t.row)); expect(t.db.file(t.row['id'])).toMatchObject({ state: 'rejected', last_error_code: REJECTED });
  });
  it('trust nothing from the sandbox: sha256 that does not match the bytes -> rejected', async () => {
    const t = setup(); const h = await build(t.sandbox({ ...okReply(), sha256: sha256('something else') })); await settle(run(h, t.ctx, t.row));
    expect(t.db.file(t.row['id'])!.state).toBe('rejected'); expect(t.storage.paths().some((p) => p.includes('/outsourced/'))).toBe(false);
  });
  it.each([
    ['not a PDF (HTML)', { ...okReply(new TextEncoder().encode('<html><script>x</script></html>')) }],
    ['empty output', { ...okReply(new Uint8Array(0)) }],
    ['page_count 0', { ...okReply(SANITIZED, 0) }],
    ['page_count missing', { ok: true, sha256: sha256(SANITIZED), pdf_base64: b64(SANITIZED) }],
    ['bad base64 / not a string', { ok: true, page_count: 1, sha256: sha256(SANITIZED), pdf_base64: 12345 }],
  ])('sandbox "ok" reply that is %s -> rejected', async (_n, reply) => {
    const t = setup(); const h = await build(t.sandbox(reply)); await settle(run(h, t.ctx, t.row));
    expect(t.db.file(t.row['id'])!.state).toBe('rejected'); expect(t.storage.paths().some((p) => p.includes('/outsourced/'))).toBe(false);
  });
  it('the sanitised bytes are not derived from the sandbox-supplied path: only ctx-built, tenant-first keys are written', async () => {
    const t = setup(); const h = await build(t.sandbox({ ...okReply(), object_path: '../../other-tenant/x.pdf' })); await run(h, t.ctx, t.row);
    for (const p of t.storage.paths()) expect(p.startsWith(`${TENANT_A}/`)).toBe(true); expect(t.storage.paths().join('|')).not.toContain('..');
  });
});

describe('scanner failure is fail-closed (REQ-SEC-084)', () => {
  it.each([['unavailable', async () => 'unavailable' as const], ['throws', async () => { throw new Error('clamd down'); }]])('scanner %s -> not ready, sandbox not called', async (_n, scan) => {
    const t = setup(fileRow(), pdfBytes(4096), { scan }); const h = await build(t.sandbox(okReply())); const r = await settle(run(h, t.ctx, t.row));
    expect(['pending_scan', 'scanning']).toContain(t.db.file(t.row['id'])!.state); expect(t.calls).toHaveLength(0);
    if (r !== 'ok') expect(r).toBeInstanceOf(Error);                                           // retry via the queue is fine; silently succeeding is not
  });
  it('the object is re-scanned by the worker even though upload already scanned it (defence in depth)', async () => {
    let scans = 0; const t = setup(fileRow(), pdfBytes(4096), { scan: async (b: Uint8Array) => { scans++; return fakeScan(b); } });
    const h = await build(t.sandbox(okReply())); await run(h, t.ctx, t.row); expect(scans).toBe(1);
  });
});

describe('tenant isolation', () => {
  it('payload tenant_id different from ctx.tenantId -> nothing happens (or an error), no sandbox call', async () => {
    const t = setup(); const h = await build(t.sandbox(okReply()));
    const r = await settle(h({ tenant_id: TENANT_B, input_file_id: t.row['id'] }, t.ctx));
    expect(t.db.file(t.row['id'])).toMatchObject({ state: 'pending_scan', version: 1 }); expect(t.calls).toHaveLength(0); if (r !== 'ok') expect(r).toBeInstanceOf(Error);
  });
  it('a file id of another tenant is untouched under tenant A\'s ctx', async () => {
    const foreign = fileRow({ tenant_id: TENANT_B, order_item_id: idN(0x11b1) });
    const t = setup(fileRow(), pdfBytes(4096), {}, [foreign]); t.storage.objects.set(`${BUCKET}::${foreign['quarantine_object_path']}`, pdfBytes(4096));
    const h = await build(t.sandbox(okReply())); await settle(h({ tenant_id: TENANT_A, input_file_id: foreign['id'] }, t.ctx));
    expect(t.db.file(foreign['id'])).toMatchObject({ state: 'pending_scan', version: 1 }); expect(t.calls).toHaveLength(0);
  });
  it('unknown input_file_id -> no write, no sandbox call', async () => {
    const t = setup(); const h = await build(t.sandbox(okReply())); await settle(h({ tenant_id: TENANT_A, input_file_id: idN(0xdead) }, t.ctx));
    expect(t.db.writes()).toHaveLength(0); expect(t.calls).toHaveLength(0);
  });
  it.each([[{}], [{ tenant_id: TENANT_A }], [{ tenant_id: TENANT_A, input_file_id: 'x' }], [{ tenant_id: TENANT_A, input_file_id: 5 }]])('malformed payload %j -> no write', async (p) => {
    const t = setup(); const h = await build(t.sandbox(okReply())); await settle(h(p, t.ctx)); expect(t.db.writes()).toHaveLength(0); expect(t.calls).toHaveLength(0);
  });
  it('every reporting statement of a full run carries the tenant', async () => {
    const t = setup(); const h = await build(t.sandbox(okReply())); await run(h, t.ctx, t.row);
    const st = t.db.reporting(); expect(st.length).toBeGreaterThan(1);
    for (const s of st) { expect(s.text, s.text).toMatch(/tenant_id/); expect(s.values, s.text).toContain(TENANT_A); }
  });
});

describe('end-to-end of the intake (AC-04.3 -> AC-04.4 hand-off): the file a clean run leaves is confirmable', () => {
  it('ready row carries everything O3/O5 need (sanitised path + sha + page_count), item not yet ready', async () => {
    const t = setup(); const h = await build(t.sandbox(okReply())); await run(h, t.ctx, t.row);
    const f = t.db.file(t.row['id'])!;
    expect(f.state).toBe('ready'); expect(f.sanitized_object_path).toBeTruthy(); expect(f.sanitized_sha256).toMatch(/^[0-9a-f]{64}$/); expect(f.page_count).toBeGreaterThan(0);
    expect(t.db.item(ITEM_1)!.outsourced_ready).toBe(false);                                   // only O3 (staff confirmation) flips it
  });
});
