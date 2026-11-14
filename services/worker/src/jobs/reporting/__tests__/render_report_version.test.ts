// C6-T09 — task `reporting.render_report_version` (02-TRD §9; 03-APP-FLOW §3.8 "Render", E9/E10/E11; AC-03.9, AC-03.10; LD-27 council).
// done_when: "object at D15 path, sha256 recorded; 5 failures -> render_failed". ASSUMED API: see render.helpers.ts header
// (createRenderReportVersion({renderer:{render}, sandbox:{assemble}}); payload {tenant_id, report_id, report_version_id}; ctx.attempt / ctx.maxAttempts = 5).
// Failure contract assumed: a retryable failure on a non-final attempt THROWS (queue retry, version stays `rendering`); on the final attempt (ctx.attempt === maxAttempts)
// the task COMMITS `render_failed` + code and RESOLVES (a throw would roll the transaction back). template_invalid (422) is permanent: render_failed at once.
import { describe, expect, it } from 'vitest';
import {
  FINAL_PDF, FOOTER, HEADER, INST_BYTES, INST_SHA, LAB, LOGO, LOGO_ID, MAIN_PDF, NARR, OUT_BYTES, OUT_BUCKET, OUT_PATH, OUT_SHA, FULL_NAME, HEADER_ID, FOOTER_ID,
  SIG1_IMG, TENANT_A, VID, I, b64, baseStore, enc, idN, makeStore, partBytes, renderSetup, settle, sha256, snapshot, templateInvalid,
  unavailable, TEMPLATE_VERSION, type RS,
} from './render.helpers.js';

const RELEASE = 'reporting.release_if_eligible';
const lastCall = (s: RS) => s.renderer.calls[s.renderer.calls.length - 1];
const allRows = (s: RS) => JSON.stringify([s.db.all('reporting.report_versions')]);

describe('AC-03.10 — rendered version: object at the D15 path, sha256 + page_count recorded, write-once', () => {
  it('stores the merged PDF at {tenant}/{yyyy}/{mm}/{report_id}-v{n}.pdf in bucket `reports` with put-if-absent, and records sha256 / bytes / page_count', async () => {
    const s = renderSetup({ assembler: { pageCount: 5 } }); await s.run();
    expect(s.store.puts).toHaveLength(1);
    const p = s.store.puts[0]!;
    expect(p.bucket).toBe('reports'); expect(p.path).toBe(`${TENANT_A}/2026/11/${LAB}-v1.pdf`);
    expect(Buffer.from(p.bytes).equals(Buffer.from(FINAL_PDF))).toBe(true);          // the sandbox-assembled (stamped) file, not Chromium's raw output
    expect(p.opts).toMatchObject({ ifAbsent: true, contentType: 'application/pdf' });
    const v = s.version();
    expect(v).toMatchObject({ status: 'rendered', pdf_object_path: p.path, pdf_sha256: sha256(FINAL_PDF), pdf_bytes: FINAL_PDF.length, page_count: 5, last_render_error_code: null });
    expect(v['rendered_at']).toBeTruthy();
  });
  it('the path month/year is the version created_at in UTC (not the run date, not Asia/Kathmandu): 2026-10-31T19:00Z is already 1 Nov in Kathmandu but stays 2026/10', async () => {
    const s = renderSetup({ versionOver: { created_at: '2026-10-31T19:00:00.000Z' } }); await s.run();
    expect(s.store.puts[0]!.path).toBe(`${TENANT_A}/2026/10/${LAB}-v1.pdf`);
    expect(s.version()['pdf_object_path']).toBe(`${TENANT_A}/2026/10/${LAB}-v1.pdf`);
  });
  it('the path carries the version number: version_no 3 -> ...-v3.pdf', async () => {
    const s = renderSetup({ versionOver: { version_no: 3, id: idN(0xc003) } }); await s.run(1, { tenant_id: TENANT_A, report_id: LAB, report_version_id: idN(0xc003) });
    expect(s.store.puts[0]!.path).toBe(`${TENANT_A}/2026/11/${LAB}-v3.pdf`);
  });
  it('the page count comes from the merged document (sandbox), not from the Chromium pages: main 2 pages + outsourced 3 = 5', async () => {
    const s = renderSetup({ assembler: { pageCount: 5 } }); await s.run(); expect(s.version()['page_count']).toBe(5);
  });
  it('enqueues release_if_eligible for this version (after storing), and nothing else', async () => {
    const s = renderSetup(); await s.run();
    const jobs = s.db.jobs.filter((j) => j.identifier === RELEASE);
    expect(jobs).toHaveLength(1); expect(JSON.stringify(jobs[0]!.payload)).toContain(VID); expect(jobs[0]!.payload).toMatchObject({ tenant_id: TENANT_A });
    expect(s.db.jobs.filter((j) => j.identifier !== RELEASE)).toHaveLength(0);
  });
  it('the PDF is never written again: a second run (retry after a lost ack, or a duplicate job) calls neither renderer nor storage and writes no row', async () => {
    const s = renderSetup(); await s.run(); const before = allRows(s); const writes = s.db.writes().length;
    await s.run();
    expect(s.renderer.calls).toHaveLength(1); expect(s.assembler.calls).toHaveLength(1); expect(s.store.puts).toHaveLength(1);
    expect(s.db.writes()).toHaveLength(writes); expect(allRows(s)).toBe(before);
    expect(s.db.jobs.filter((j) => j.identifier === RELEASE)).toHaveLength(1);
  });
  it('crash window: the object was stored by an earlier attempt (same bytes) but the row was not updated -> success, not a write-once failure', async () => {
    const store = baseStore(); store.objects.set(`reports::${TENANT_A}/2026/11/${LAB}-v1.pdf`, new Uint8Array(FINAL_PDF));
    const s = renderSetup({ store }); await s.run();
    expect(s.version()).toMatchObject({ status: 'rendered', pdf_sha256: sha256(FINAL_PDF) }); expect(s.db.jobs.filter((j) => j.identifier === RELEASE)).toHaveLength(1);
  });
  it('E11: an object already at the path with a DIFFERENT sha256 -> render_failed (+ failures metric, error-level alert), the foreign object is left untouched, no release job', async () => {
    const store = baseStore(); const foreign = enc('%PDF-1.7 somebody else wrote here'); store.objects.set(`reports::${TENANT_A}/2026/11/${LAB}-v1.pdf`, foreign);
    const s = renderSetup({ store }); const errs: unknown[][] = []; const orig = s.logs.log.error; s.logs.log.error = (...a: unknown[]) => { errs.push(a); orig(...a); };
    await s.run();
    expect(s.version()).toMatchObject({ status: 'render_failed', pdf_object_path: null, pdf_sha256: null }); expect(typeof s.version()['last_render_error_code']).toBe('string');
    expect(Buffer.from(store.objects.get(`reports::${TENANT_A}/2026/11/${LAB}-v1.pdf`)!).equals(Buffer.from(foreign))).toBe(true);
    expect(s.metrics.some((m) => m.name === 'lims_reporting_render_failures_total')).toBe(true);
    expect(errs.length).toBeGreaterThan(0);                                   // critical alert = an error-level log line
    expect(s.db.jobs.filter((j) => j.identifier === RELEASE)).toHaveLength(0);
  });
  it('the stored row never gets the snapshot rewritten: content_snapshot / content_sha256 / template_version_id are untouched', async () => {
    const s = renderSetup(); const before = JSON.stringify([s.version()['content_snapshot'], s.version()['content_sha256'], s.version()['template_version_id']]); await s.run();
    expect(JSON.stringify([s.version()['content_snapshot'], s.version()['content_sha256'], s.version()['template_version_id']])).toBe(before);
  });
});

describe('renderer request (02-TRD §5.1) and asset collection (03-APP-FLOW §3.8)', () => {
  it('POSTs template_id lab-report (laboratory family), variant letterhead, the template version config, the stored snapshot, and no watermark override', async () => {
    const s = renderSetup(); await s.run(); const r = lastCall(s);
    expect(s.renderer.calls).toHaveLength(1);
    expect(r).toMatchObject({ template_id: 'lab-report', variant: 'letterhead' });
    expect(r.template_version_config).toEqual({ signatoryMode: 'approvers', maxSignatories: 2, disclaimers: ['Synthetic disclaimer line 1.'] });
    expect(r.watermark_override).toBeUndefined();
    expect(r.document.header.patientName).toBe(FULL_NAME); expect(r.document.lab.displayName).toBe('Synthetic Lab'); expect(r.document.qr).toEqual(snapshot()['qr']);
  });
  it('a narrative-family report uses template_id narrative-report', async () => {
    const s = renderSetup({ versionOver: { report_id: NARR }, snap: snapshot({ family: 'narrative' }) });
    await s.run(1, { tenant_id: TENANT_A, report_id: NARR, report_version_id: VID });
    expect(lastCall(s).template_id).toBe('narrative-report');
  });
  it('branding assets come from IdentityPort.readBrandingAsset(assetId) for logo / letterhead header / footer, keyed by sha256 as {mime_type, base64}', async () => {
    const s = renderSetup(); await s.run(); const a = lastCall(s).assets;
    expect([...s.identity.calls.branding].sort()).toEqual([LOGO_ID, HEADER_ID, FOOTER_ID].sort());
    expect(a[sha256(LOGO)]).toEqual({ mime_type: 'image/png', base64: b64(LOGO) });
    expect(a[sha256(HEADER)]).toEqual({ mime_type: 'image/png', base64: b64(HEADER) }); expect(a[sha256(FOOTER)]).toEqual({ mime_type: 'image/png', base64: b64(FOOTER) });
  });
  it('signature images come from IdentityPort.readSignatureImage({membershipId}) for signatories that carry a signature ref', async () => {
    const s = renderSetup(); await s.run();
    expect(s.identity.calls.signature).toEqual([I.m1]);
    expect(lastCall(s).assets[sha256(SIG1_IMG)]).toEqual({ mime_type: 'image/png', base64: b64(SIG1_IMG) });
  });
  it('asset bundle is exactly the referenced assets: no extra keys, and every key is the sha256 of its bytes', async () => {
    const s = renderSetup(); await s.run(); const a = lastCall(s).assets;
    expect(Object.keys(a).sort()).toEqual([sha256(LOGO), sha256(HEADER), sha256(FOOTER), sha256(SIG1_IMG)].sort());
    for (const [k, v] of Object.entries<any>(a)) expect(sha256(Buffer.from(v.base64, 'base64'))).toBe(k);
  });
  it('E9: a signature image missing on file (common.not_found) -> render proceeds without it, `asset_missing` is logged, the version still renders', async () => {
    const s = renderSetup({ identity: { sigImageMissing: true } }); await s.run();
    expect(s.version()['status']).toBe('rendered'); expect(lastCall(s).assets[sha256(SIG1_IMG)]).toBeUndefined(); expect(s.logs.text()).toContain('asset_missing');
  });
  it('E9: a missing branding asset never blocks the render either', async () => {
    const s = renderSetup({ identity: { brandingMissing: [LOGO_ID, FOOTER_ID] } }); await s.run();
    expect(s.version()['status']).toBe('rendered'); expect(lastCall(s).assets[sha256(LOGO)]).toBeUndefined(); expect(lastCall(s).assets[sha256(HEADER)]).toBeDefined(); expect(s.logs.text()).toContain('asset_missing');
  });
  it('a snapshot without any asset refs makes no identity asset call', async () => {
    const s = renderSetup({ snap: snapshot({ lab: { displayName: 'L', legalName: 'L', contactStrip: [] }, signatories: [] }) }); await s.run();
    expect(s.identity.calls.branding).toHaveLength(0); expect(s.identity.calls.signature).toHaveLength(0); expect(lastCall(s).assets).toEqual({});
  });
  it('LD-27: the signatory council from IdentityPort.getSignatories is passed to the renderer document (NMC for the doctor, NHPC for the laboratory professional); registration_no kept', async () => {
    const s = renderSetup(); await s.run(); const sig = lastCall(s).document.signatories;
    expect(s.identity.calls.signatories.flat().sort()).toEqual([I.m1, I.m2].sort());
    expect(sig).toHaveLength(2);
    expect(sig[0]).toMatchObject({ membershipId: I.m1, council: 'NMC', registrationNo: 'NMC-SYN-0001', displayName: 'Dr. Synthetic Signatory A' });
    expect(sig[1]).toMatchObject({ membershipId: I.m2, council: 'NHPC', registrationNo: 'NHPC-SYN-0002' });
  });
  it('LD-27: a profile without council -> no `council` key (name + title only); an unknown council value is dropped, never forwarded', async () => {
    const a = renderSetup({ identity: { noCouncil: true } }); await a.run();
    for (const sg of lastCall(a).document.signatories) expect('council' in sg && sg.council !== undefined).toBe(false);
    const b = renderSetup({ identity: { badCouncil: true } }); await b.run();
    expect(lastCall(b).document.signatories[0].council).toBeUndefined(); expect(lastCall(b).document.signatories[1].council).toBe('NHPC');
  });
  it('the stored snapshot is not mutated by the council overlay', async () => {
    const s = renderSetup(); await s.run(); expect(JSON.stringify(s.version()['content_snapshot'])).not.toContain('"council"');
  });
});

describe('sandbox assemble (02-TRD §5.2): main + sanitised outside + instrument PDFs, page labels stamped', () => {
  it('sends the renderer PDF first as `main`, then the sanitised outsourced file (read from its sanitized_object_path) and the sanitised instrument PDF', async () => {
    const s = renderSetup(); await s.run();
    expect(s.assembler.calls).toHaveLength(1); const parts = s.assembler.calls[0].parts;
    expect(parts[0].kind).toBe('main'); expect(Buffer.from(partBytes(parts[0])).equals(Buffer.from(MAIN_PDF))).toBe(true);
    const out = parts.find((p: any) => p.kind === 'outsourced'); const inst = parts.find((p: any) => p.kind === 'instrument_pdf');
    expect(parts).toHaveLength(3);
    expect(Buffer.from(partBytes(out)).equals(Buffer.from(OUT_BYTES))).toBe(true); expect(out.sha256).toBe(OUT_SHA);
    expect(Buffer.from(partBytes(inst)).equals(Buffer.from(INST_BYTES))).toBe(true); expect(inst.sha256).toBe(INST_SHA);
    expect(s.store.reads).toEqual(expect.arrayContaining([[OUT_BUCKET, OUT_PATH]]));
  });
  it('stamp: "Page {n} Of {m}" footer_right, 8 pt, not plain, not "NOT RELEASED"', async () => {
    const s = renderSetup(); await s.run();
    expect(s.assembler.calls[0].stamp).toMatchObject({ page_label_format: 'Page {n} Of {m}', position: 'footer_right', font_size_pt: 8, markers: { plain: false, not_released: false } });
  });
  it('no outside files -> still one assemble call (the stamp is applied there), with the main part only', async () => {
    const s = renderSetup({ snap: snapshot({ outsourcedAttachments: [], instrumentPdfAttachments: [] }) }); await s.run();
    expect(s.assembler.calls).toHaveLength(1); expect(s.assembler.calls[0].parts.map((p: any) => p.kind)).toEqual(['main']);
  });
  it('integrity: outsourced bytes whose sha256 differs from the recorded sanitised sha never reach the sandbox merge', async () => {
    const store = baseStore(); const evil = enc('%PDF-1.7 /JavaScript (this.print()) tampered'); store.objects.set(`${OUT_BUCKET}::${OUT_PATH}`, evil);
    const s = renderSetup({ store }); await settle(s.run(1)); await settle(s.run(5));
    for (const c of s.assembler.calls) for (const p of c.parts) expect(Buffer.from(partBytes(p)).equals(Buffer.from(evil))).toBe(false);
    expect(s.version()['status']).not.toBe('rendered');
  });
  it('the renderer is called before the outside files are merged (the sandbox never calls Chromium and receives only sanitised parts)', async () => {
    const order: string[] = []; const s = renderSetup();
    const r = s.renderer.render.bind(s.renderer); s.renderer.render = async (q: any) => { order.push('render'); return r(q); };
    const a = s.assembler.assemble.bind(s.assembler); s.assembler.assemble = async (q: any) => { order.push('assemble'); return a(q); };
    await s.run(); expect(order).toEqual(['render', 'assemble']);
  });
});

describe('AC-03.9 — failures: retry up to 5 attempts, then render_failed with reporting.render_unavailable', () => {
  it('attempts 1..4: a renderer failure throws (queue retry), the version stays `rendering`, nothing stored, no release job', async () => {
    const s = renderSetup({ rendererReply: unavailable() });
    for (let n = 1; n <= 4; n++) { const r = await settle(s.run(n)); expect(r).toBeInstanceOf(Error); expect(s.version()['status']).toBe('rendering'); }
    expect(s.store.puts).toHaveLength(0); expect(s.db.jobs.filter((j) => j.identifier === RELEASE)).toHaveLength(0);
  });
  it('attempt 5 (final): the task commits render_failed + last_render_error_code reporting.render_unavailable + render_attempts 5 and resolves', async () => {
    const s = renderSetup({ rendererReply: unavailable() });
    for (let n = 1; n <= 4; n++) await settle(s.run(n));
    expect(await settle(s.run(5))).toBe('ok');
    expect(s.version()).toMatchObject({ status: 'render_failed', last_render_error_code: 'reporting.render_unavailable', render_attempts: 5, pdf_object_path: null, pdf_sha256: null });
    expect(s.metrics).toContainEqual({ name: 'lims_reporting_render_failures_total', labels: { error_code: 'reporting.render_unavailable' } });
    expect(s.store.puts).toHaveLength(0); expect(s.db.jobs.filter((j) => j.identifier === RELEASE)).toHaveLength(0);
  });
  it('a failure on attempt 3 does not count as final: no failures metric before the last attempt', async () => {
    const s = renderSetup({ rendererReply: unavailable() }); await settle(s.run(3)); expect(s.metrics.filter((m) => m.name === 'lims_reporting_render_failures_total')).toHaveLength(0);
  });
  it('a browser crash / timeout surfaced as a plain Error (no code) is treated as render_unavailable', async () => {
    const s = renderSetup({ rendererReply: new Error('Target page, context or browser has been closed') });
    expect(await settle(s.run(2))).toBeInstanceOf(Error); expect(await settle(s.run(5))).toBe('ok');
    expect(s.version()).toMatchObject({ status: 'render_failed', last_render_error_code: 'reporting.render_unavailable' });
  });
  it('a sandbox assemble failure follows the same retry rules (final attempt -> render_failed / render_unavailable)', async () => {
    const s = renderSetup({ assembler: { error: unavailable('sandbox down') } });
    expect(await settle(s.run(1))).toBeInstanceOf(Error); expect(s.version()['status']).toBe('rendering');
    expect(await settle(s.run(5))).toBe('ok'); expect(s.version()).toMatchObject({ status: 'render_failed', last_render_error_code: 'reporting.render_unavailable' }); expect(s.store.puts).toHaveLength(0);
  });
  it('page limit / template error (422, reporting.template_invalid) is permanent: render_failed on the FIRST attempt, no retry throw', async () => {
    const s = renderSetup({ rendererReply: templateInvalid() });
    expect(await settle(s.run(1))).toBe('ok');
    expect(s.version()).toMatchObject({ status: 'render_failed', last_render_error_code: 'reporting.template_invalid' }); expect(s.renderer.calls).toHaveLength(1);
    expect(s.metrics).toContainEqual({ name: 'lims_reporting_render_failures_total', labels: { error_code: 'reporting.template_invalid' } });
  });
  it('a failed attempt followed by a successful one renders normally (transient 503 is recoverable)', async () => {
    let n = 0; const s = renderSetup({ rendererReply: (_r, i) => { n = i; if (i === 1) throw unavailable('503'); return { pdf: MAIN_PDF, pageCount: 2 }; } });
    expect(await settle(s.run(1))).toBeInstanceOf(Error); await s.run(2);
    expect(n).toBe(2); expect(s.version()['status']).toBe('rendered');
  });
  it('last_render_error_code is a stable code, never the error message (which may carry HTML / names): planted sentinel stays out of rows, metrics and logs', async () => {
    const SENT = 'SENTINEL-PATIENT-HTML-77';
    const s = renderSetup({ rendererReply: new Error(`render failed for <p>${SENT}</p>`) }); await settle(s.run(5));
    expect(String(s.version()['last_render_error_code'])).toMatch(/^[a-z_]+\.[a-z_]+$/);
    expect(JSON.stringify(s.db.all('reporting.report_versions'))).not.toContain(SENT); expect(JSON.stringify(s.metrics)).not.toContain(SENT); expect(s.logs.text()).not.toContain(SENT);
  });
});

// Review C6-T09 #2: a failing SQL statement aborts the Postgres transaction; render_failed must be written after ROLLBACK TO SAVEPOINT or it never commits (AC-03.9, E11).
describe('AC-03.9 — a SQL error inside the attempt must not block the render_failed write (savepoint)', () => {
  const dbErr = () => Object.assign(new Error('check violation report_versions__hashes__ck'), { code: '23514' });
  const idx = (s: RS, re: RegExp) => s.db.stmts.findIndex((x) => re.test(x.text));
  it('final attempt, the `rendered` UPDATE rejects: SAVEPOINT render_attempt precedes it, ROLLBACK TO SAVEPOINT render_attempt precedes the render_failed UPDATE', async () => {
    const s = renderSetup({ dbOpts: { failOn: [{ match: /set status = 'rendered'/i, error: dbErr }] } });
    expect(await settle(s.run(5))).toBe('ok');
    const sp = idx(s, /^savepoint render_attempt\b/i), upd = idx(s, /set status = 'rendered'/i), rb = idx(s, /^rollback to savepoint render_attempt\b/i), failed = idx(s, /set status = 'render_failed'/i);
    expect(sp).toBeGreaterThanOrEqual(0); expect(sp).toBeLessThan(upd); expect(upd).toBeLessThan(rb); expect(rb).toBeLessThan(failed);
    expect(s.version()).toMatchObject({ status: 'render_failed', render_attempts: 5 });
    expect(s.metrics).toContainEqual({ name: 'lims_reporting_render_failures_total', labels: { error_code: 'reporting.render_unavailable' } });
  });
  it('final attempt, the release enqueue rejects: same order, render_failed committed, no release job recorded', async () => {
    const s = renderSetup({ dbOpts: { failOn: [{ match: /app\.enqueue_job/i, error: dbErr }] } });
    expect(await settle(s.run(5))).toBe('ok');
    expect(idx(s, /^rollback to savepoint render_attempt\b/i)).toBeLessThan(idx(s, /set status = 'render_failed'/i)); expect(idx(s, /^rollback to savepoint render_attempt\b/i)).toBeGreaterThanOrEqual(0);
    expect(s.version()['status']).toBe('render_failed'); expect(s.db.jobs.filter((j) => j.identifier === RELEASE)).toHaveLength(0);
  });
  it('a permanent failure (template_invalid) on attempt 1 also rolls back to the savepoint before render_failed', async () => {
    const s = renderSetup({ rendererReply: templateInvalid() }); expect(await settle(s.run(1))).toBe('ok');
    expect(idx(s, /^rollback to savepoint render_attempt\b/i)).toBeGreaterThanOrEqual(0); expect(idx(s, /^rollback to savepoint render_attempt\b/i)).toBeLessThan(idx(s, /set status = 'render_failed'/i));
  });
});

// Review C6-T09 #1: app.enqueue_job raises EP0001:unknown_task_identifier for a task missing from core.g_task_registry (built from manifest.tasks).
describe('manifest registers every task identifier the render task enqueues', () => {
  it.each(['reporting.render_report_version', RELEASE])('%s is in manifest.tasks with maxAttempts', async (id) => {
    const { manifest } = await import('../index.js');
    expect(typeof (manifest.tasks as Record<string, unknown>)[id]).toBe('function'); expect((manifest.maxAttempts as Record<string, number>)[id]).toBeGreaterThan(0);
  });
  it('release_if_eligible has maxAttempts 10 (02-TRD §9) and the render task enqueues it with that value', async () => {
    const { manifest } = await import('../index.js'); expect((manifest.maxAttempts as Record<string, number>)[RELEASE]).toBe(10);
    const s = renderSetup(); await s.run(1); expect(s.db.jobs.find((j) => j.identifier === RELEASE)?.maxAttempts).toBe(10);
  });
});

describe('guards: only a `rendering` version of this tenant is rendered', () => {
  it.each(['rendered', 'released', 'superseded', 'discarded', 'render_failed'])('status %s -> no-op (render_failed needs the retry-render endpoint first)', async (st) => {
    const s = renderSetup({ versionOver: { status: st } }); const before = allRows(s);
    expect(await settle(s.run())).toBe('ok');
    expect(s.renderer.calls).toHaveLength(0); expect(s.store.puts).toHaveLength(0); expect(s.db.writes()).toHaveLength(0); expect(allRows(s)).toBe(before); expect(s.db.jobs).toHaveLength(0);
  });
  it('unknown version id / malformed payload -> resolves without work (no endless retry loop)', async () => {
    const s = renderSetup();
    expect(await settle(s.run(1, { tenant_id: TENANT_A, report_id: LAB, report_version_id: idN(0xdead) }))).toBe('ok');
    expect(await settle(s.run(1, { tenant_id: TENANT_A }))).toBe('ok'); expect(await settle(s.run(1, {} as any))).toBe('ok');
    expect(s.renderer.calls).toHaveLength(0); expect(s.db.writes()).toHaveLength(0);
  });
  it('another tenant\'s version is never rendered — even with RLS off the statements themselves name tenant_id', async () => {
    const s = renderSetup({ rls: false });
    await settle(s.run(1, { tenant_id: '0190a000-0000-7000-8000-00000000bbbb', report_id: LAB, report_version_id: VID }));
    expect(s.renderer.calls).toHaveLength(0); expect(s.store.puts).toHaveLength(0); expect(s.version()['status']).toBe('rendering');
    expect(s.db.reportingStmts().every((x) => /\btenant_id\b/i.test(x.text))).toBe(true);
  });
  it('every reporting statement of a normal run names tenant_id', async () => {
    const s = renderSetup({ rls: false }); await s.run(); expect(s.db.reportingStmts().length).toBeGreaterThan(0); expect(s.db.reportingStmts().every((x) => /\btenant_id\b/i.test(x.text))).toBe(true);
  });
  it('the config comes from the version row\'s template_version_id (not the template\'s current default)', async () => {
    const s = renderSetup(); await s.run(); expect(s.version()['template_version_id']).toBe(TEMPLATE_VERSION);
    expect(lastCall(s).template_version_config).toEqual(s.db.all('reporting.report_template_versions')[0]!['config']);
  });
});

describe('security / PHI hygiene (07-SECURITY: renderer and sandbox log job ids and durations only)', () => {
  it('logs contain no patient name, no asset base64, no PDF bytes, no renderer token; metrics labels carry codes only', async () => {
    const s = renderSetup(); await s.run();
    const text = s.logs.text() + JSON.stringify(s.metrics);
    for (const bad of [FULL_NAME, b64(LOGO), b64(SIG1_IMG), b64(FINAL_PDF), b64(MAIN_PDF), 'Synthetic Signatory', 'AAAAAAAAAAAAAAAAAAAAAA']) expect(text).not.toContain(bad);
  });
  it('a failing run logs no patient name or asset bytes either', async () => {
    const s = renderSetup({ rendererReply: unavailable() }); await settle(s.run(1)); await settle(s.run(5));
    const text = s.logs.text(); expect(text).not.toContain(FULL_NAME); expect(text).not.toContain(b64(LOGO));
  });
  it('no PDF bytes or HTML are written to the version row except through pdf_* columns (write-once columns hold path/sha/size only)', async () => {
    const s = renderSetup(); await s.run(); const v = s.version();
    for (const [k, val] of Object.entries(v)) if (typeof val === 'string' && k !== 'content_snapshot') expect(val).not.toContain('%PDF');
  });
  it('the render job of an unrelated tenant payload field cannot redirect storage: the path always starts with the job tenant', async () => {
    const s = renderSetup(); await s.run(1, { tenant_id: TENANT_A, report_id: LAB, report_version_id: VID, path: '../../other/evil.pdf', bucket: 'reporting-prints' } as any);
    expect(s.store.puts[0]!.bucket).toBe('reports'); expect(s.store.puts[0]!.path.startsWith(`${TENANT_A}/`)).toBe(true); expect(s.store.puts[0]!.path).not.toContain('evil');
  });
  it('store fixture self-check: put-if-absent rejects an existing object and returns sha256 + size (guards the harness)', async () => {
    const st = makeStore(); await st.put('reports', 'a/b.pdf', enc('x'), { ifAbsent: true }); expect(await settle(st.put('reports', 'a/b.pdf', enc('y'), { ifAbsent: true }))).toBeInstanceOf(Error);
    expect((await st.put('reports', 'a/c.pdf', enc('z'), { ifAbsent: true })).sha256).toBe(sha256('z'));
  });
});
