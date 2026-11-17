// C7 API-T11 — E06 submitAttachment + E37 downloadInstrumentAttachment (02-TRD §6.8, §7.2; AC-12.3, AC-12.4 (API half), AC-12.5 (server dedupe), AC-12.6; 07-SECURITY S-08, S-11, AB8, REQ-SEC-083..085, A13 P-2).
// Seams: attachments.helpers.ts header. DB = T09 in-memory world; uploads/download/audit = the REAL core helpers over a fake storage (real bucket-owner + tenant-path rules) and a fake scanner.
// The worker half (scan -> clean/quarantine -> event) is services/worker/src/jobs/instruments/__tests__/scan-attachment.test.ts.
import { describe, expect, it } from 'vitest';
import { createAttachmentsService } from '../service/attachments.service.js';
import {
  BARCODE, BUCKET, EICAR, FILE_DROP_INS, GPS, INS, MiB, TENANT_A, TENANT_B, URL_SENTINEL, attId, attachmentRow, failure, idN, makeAttachmentsWorld, makeDeviceCtx, makeScanner, makeStaffCtx,
  makeStorage, metadata, pdfBytes, pngBytes, sha, upload, type AttWorld, type Row,
} from './attachments.helpers.js';

const URLISH = /https?:\/\/|:\/\/|token=|signed|SECRET-URL-SENTINEL/i;
async function submit(w: AttWorld, file: Uint8Array, over: { meta?: Row; filename?: string; mimeType?: string; ctx?: ReturnType<typeof makeDeviceCtx> } = {}) {
  const c = over.ctx ?? makeDeviceCtx(w);
  const svc = createAttachmentsService({ repo: w.repo });
  const meta = metadata(file, { file_name: over.filename ?? 'slide-0042.pdf', ...(over.meta ?? {}) });
  const r = await svc.submitAttachment(c.ctx, { metadata: meta, file: upload(file, { filename: over.filename, mimeType: over.mimeType }) });
  return { r, c, meta, body: r.body as Row };
}
const nothingPersisted = (w: AttWorld, c: { storage: ReturnType<typeof makeStorage> }) => {
  expect(w.messages).toEqual([]); expect(w.attachments).toEqual([]); expect(w.runs).toEqual([]); expect(w.records).toEqual([]);
  expect(w.jobs).toEqual([]); expect(w.events).toEqual([]); expect(c.storage.objects.size).toBe(0);
};

describe('E06 happy path (AC-12.4 API half; TRD §6.8 step 2)', () => {
  it('clean PDF: 202 accepted/pending; object in quarantine path via ctx.uploads.accept; message/attachment/run/record rows; ONE scan job; NO event yet', async () => {
    const w = makeAttachmentsWorld(); const file = pdfBytes();
    const { r, c, meta, body } = await submit(w, file);
    expect(r.status).toBe(202);
    expect(body).toEqual({ outcome: 'accepted', instrument_message_id: w.messages[0]!['id'], attachment_id: w.attachments[0]!['id'], scan_state: 'pending' });
    const a = w.attachments[0]!;
    expect(a).toMatchObject({ tenant_id: TENANT_A, bucket: BUCKET, mime_type: 'application/pdf', size_bytes: file.length, original_file_name: 'slide-0042.pdf', scan_state: 'pending', instrument_id: FILE_DROP_INS, message_id: w.messages[0]!['id'] });
    expect(a['object_path']).toBe(`${TENANT_A}/q/2026/11/${a['id']}.pdf`);               // tenant is the first segment; quarantine prefix until the worker has scanned
    expect(a['sha256']).toBe(sha(c.storage.get(a['object_path'] as string)!));             // = hash of the STORED object
    expect(c.storage.paths()).toEqual([a['object_path']]); expect(c.storage.callsOf('put')).toHaveLength(1);
    const m = w.messages[0]!;
    expect(m).toMatchObject({ protocol: 'file_drop', message_kind: 'attachment', message_key: meta['file_sha256'], message_key_kind: 'sha256', agent_message_id: meta['agent_message_id'], instrument_id: FILE_DROP_INS });
    const raw = Buffer.from(m['raw_bytes'] as Buffer); expect(m['raw_sha256']).toBe(sha(raw));
    expect(raw.includes(file.subarray(0, 40))).toBe(false);                                // raw = canonical JSON of the capture metadata, never the file bytes
    expect(JSON.parse(raw.toString('utf8'))).toMatchObject({ file_name: 'slide-0042.pdf', file_sha256: meta['file_sha256'] });
    expect(w.runs).toHaveLength(1); expect(w.runs[0]).toMatchObject({ kind: 'live', outcome: 'parsed', message_id: m['id'] });
    expect(w.records).toHaveLength(1); expect(w.records[0]).toMatchObject({ record_kind: 'attachment', emit_status: 'pending_scan', sample_barcode: BARCODE, message_id: m['id'] });
    expect(w.jobs).toEqual([{ identifier: 'instruments.scan_attachment', payload: { tenant_id: TENANT_A, attachment_id: a['id'] }, jobKey: a['id'] }]);
    expect(w.eventsOf('instruments.result.received.v1')).toEqual([]);                    // AC-12.4: the event is the WORKER's, after a clean scan
  });
  it('accept() is the only writer: no ctx.storage.put/move/signedUrl call by the service (review #36)', async () => {
    const w = makeAttachmentsWorld(); const { c } = await submit(w, pdfBytes());
    expect(c.storage.calls.map((x) => x.op)).toEqual(['put']);                            // the single put is accept()'s own
  });
  it('scanner unavailable at accept time fails closed to the worker: still 202 pending + one job (never clean, never lost)', async () => {
    const w = makeAttachmentsWorld(); const sc = makeScanner(); sc.mode = 'unavailable';
    const { body } = await submit(w, pdfBytes(), { ctx: makeDeviceCtx(w, { scanner: sc }) });
    expect(body['scan_state']).toBe('pending'); expect(w.jobsOf('instruments.scan_attachment')).toHaveLength(1);
  });
  it('scanner says clean at accept: the row is STILL pending (the worker scans + sanitises; only it may set clean)', async () => {
    const w = makeAttachmentsWorld(); const sc = makeScanner(); sc.mode = 'clean';
    const { body } = await submit(w, pdfBytes(), { ctx: makeDeviceCtx(w, { scanner: sc }) });
    expect(body['scan_state']).toBe('pending'); expect(w.attachments[0]!['scan_state']).toBe('pending');
  });
  it('commissioning instrument: accepted and archived but the record is emitted as pending_scan too (event gating happens in the worker by instrument state)', async () => {
    const w = makeAttachmentsWorld(); const f = pdfBytes('commissioning');
    const { body } = await submit(w, f, { meta: { instrument_id: INS(10) } });
    expect(body['outcome']).toBe('accepted'); expect(w.events).toEqual([]);
  });
});

describe('E06 PNG re-encode (REQ-SEC-085; S-11 "PNG/JPEG stored without EXIF/GPS")', () => {
  it('stored object carries no metadata chunk (tEXt/eXIf GPS sentinel gone); attachments.sha256 = hash of the STORED bytes; message_key stays the agent file_sha256', async () => {
    const w = makeAttachmentsWorld(); const png = pngBytes({ meta: true }); expect(png.includes(GPS)).toBe(true);
    const { c, meta } = await submit(w, png, { filename: 'micrograph.png', mimeType: 'image/png' });
    const a = w.attachments[0]!; const stored = c.storage.get(a['object_path'] as string)!;
    expect(stored.includes(GPS)).toBe(false); expect(stored.includes('eXIf')).toBe(false); expect(stored.includes('tEXt')).toBe(false);
    expect(a).toMatchObject({ mime_type: 'image/png', sha256: sha(stored), size_bytes: stored.length }); expect(a['sha256']).not.toBe(sha(png));
    expect(a['object_path']).toMatch(new RegExp(`^${TENANT_A}/q/2026/11/[0-9a-f-]{36}\\.png$`)); expect(w.messages[0]!['message_key']).toBe(meta['file_sha256']);
  });
});

describe('E06 rejects (AC-12.3; S-11 .pdf.exe / 16 MB / wrong magic / EICAR) — nothing is stored, archived, enqueued or emitted', () => {
  it('16 MB file -> 413 common.payload_too_large', async () => {
    const w = makeAttachmentsWorld(); const c = makeDeviceCtx(w); const big = Buffer.concat([pdfBytes(), Buffer.alloc(16 * MiB, 0x41)]);
    const e = await failure(submit(w, big, { ctx: c })); expect(e.code).toBe('common.payload_too_large'); nothingPersisted(w, c);
  });
  it('exactly 15 MB is accepted (boundary)', async () => {
    const w = makeAttachmentsWorld(); const f = Buffer.concat([pdfBytes(), Buffer.alloc(15 * MiB - pdfBytes().length, 0x41)]); expect(f.length).toBe(15 * MiB);
    const { body } = await submit(w, f); expect(body['outcome']).toBe('accepted');
  });
  it.each([
    ['PNG bytes named .pdf (magic != extension)', pngBytes(), 'slide.pdf', 'application/pdf'],
    ['plain text named .pdf', Buffer.from('not a pdf at all'), 'slide.pdf', 'application/pdf'],
    ['.pdf.exe double extension', pdfBytes(), 'slide.pdf.exe', 'application/pdf'],
    ['.exe with MZ header', Buffer.from('MZ\x90\x00\x03'), 'tool.exe', 'application/octet-stream'],
    ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'x.svg', 'image/svg+xml'],
    ['declared mime differs from the extension', pdfBytes(), 'slide.pdf', 'image/png'],
    ['empty file', Buffer.alloc(0), 'slide.pdf', 'application/pdf'],
  ])('%s -> 415 common.unsupported_media_type', async (_n, bytes, filename, mimeType) => {
    const w = makeAttachmentsWorld(); const c = makeDeviceCtx(w);
    const e = await failure(submit(w, bytes, { ctx: c, filename, mimeType })); expect(e.code).toBe('common.unsupported_media_type'); nothingPersisted(w, c);
  });
  it('EICAR inside a PDF -> rejected by ctx.uploads.accept as 422 common.upload_quarantined: no object, no rows, no job, NO event (AB8); the core logs the alert without the file', async () => {
    const w = makeAttachmentsWorld(); const c = makeDeviceCtx(w); const f = pdfBytes(EICAR);
    const e = await failure(submit(w, f, { ctx: c })); expect(e.code).toBe('common.upload_quarantined'); nothingPersisted(w, c);
    expect(c.logText()).toContain('upload_quarantined'); expect(c.logText()).not.toContain('EICAR-STANDARD');
  });
  it('declared file_sha256 that does not match the received bytes -> 422 common.validation_failed, nothing stored', async () => {
    const w = makeAttachmentsWorld(); const c = makeDeviceCtx(w); const f = pdfBytes();
    const e = await failure(submit(w, f, { ctx: c, meta: { file_sha256: sha('other bytes') } })); expect(e.code).toBe('common.validation_failed'); nothingPersisted(w, c);
  });
  // (metadata SHAPE — hex64 sha, name <= 255, barcode <= 40, unknown fields — is the core ajv pipeline's job; pinned at spec level in unit/attachments.contract.test.ts)
});

describe('E06 instrument checks (TRD §6.4 steps 2-3 reused; AC-09.9 device binding)', () => {
  const rejected = async (meta: Row, code: string, ctxOpts: Parameters<typeof makeDeviceCtx>[1] = {}) => {
    const w = makeAttachmentsWorld(); const c = makeDeviceCtx(w, ctxOpts); const f = pdfBytes();
    const e = await failure(submit(w, f, { ctx: c, meta })); expect(e.code).toBe(code); nothingPersisted(w, c); return { w, c };
  };
  it('unknown instrument -> 404 instruments.instrument_unknown', () => rejected({ instrument_id: idN(0xdead) }, 'instruments.instrument_unknown'));
  it('instrument of another centre (RLS-invisible to this device) -> instrument_unknown', () => rejected({ instrument_id: INS(3) }, 'instruments.instrument_unknown'));
  it('instrument of ANOTHER TENANT -> instrument_unknown; every repo call carried the caller tenant', async () => {
    const { w } = await rejected({ instrument_id: INS(8) }, 'instruments.instrument_unknown');
    expect(w.calls.length).toBeGreaterThan(0); expect(w.calls.every((x) => x.tenantId === TENANT_A)).toBe(true);
  });
  it('instrument bound to a different agent of the same centre -> 403 instruments.device_mismatch', () => rejected({ instrument_id: INS(4) }, 'instruments.device_mismatch'));
  it('instrument without file drop configured -> 422 instruments.capability_not_supported', () => rejected({ instrument_id: INS(1) }, 'instruments.capability_not_supported'));
});

describe('E06 dedupe (AC-12.5 server half; TRD §6.5 key = file_sha256)', () => {
  it('same file re-dropped (new agent_message_id, different mtime) -> 202 duplicate pointing at the FIRST message/attachment; no second object/row/job/event', async () => {
    const w = makeAttachmentsWorld(); const c = makeDeviceCtx(w); const f = pdfBytes('dup');
    const first = await submit(w, f, { ctx: c });
    const again = await submit(w, f, { ctx: c, meta: { file_mtime_agent: '2026-11-08T01:00:00.000Z' } });
    expect(again.r.status).toBe(202);
    expect(again.body).toEqual({ outcome: 'duplicate', instrument_message_id: first.body['instrument_message_id'], attachment_id: first.body['attachment_id'], scan_state: 'pending' });
    expect(w.messages).toHaveLength(1); expect(w.attachments).toHaveLength(1); expect(w.jobs).toHaveLength(1); expect(c.storage.objects.size).toBe(1); expect(w.events).toEqual([]);
    expect(w.duplicates).toHaveLength(1); expect(w.duplicates[0]).toMatchObject({ original_message_id: first.body['instrument_message_id'], reason: 'message_key' });
  });
  it('the duplicate answer reports the CURRENT scan_state of the original (clean)', async () => {
    const w = makeAttachmentsWorld(); const c = makeDeviceCtx(w); const f = pdfBytes('dup2');
    const first = await submit(w, f, { ctx: c }); w.attachments[0]!['scan_state'] = 'clean';
    const again = await submit(w, f, { ctx: c }); expect(again.body).toMatchObject({ outcome: 'duplicate', attachment_id: first.body['attachment_id'], scan_state: 'clean' });
  });
  it('a retried request (same agent_message_id) is a duplicate by agent key, not a second archive row', async () => {
    const w = makeAttachmentsWorld(); const c = makeDeviceCtx(w); const f = pdfBytes('retry');
    const first = await submit(w, f, { ctx: c }); const again = await submit(w, f, { ctx: c, meta: { agent_message_id: first.meta['agent_message_id'] } });
    expect(again.body).toMatchObject({ outcome: 'duplicate', instrument_message_id: first.body['instrument_message_id'] }); expect(w.messages).toHaveLength(1);
    expect(w.duplicates[0]).toMatchObject({ reason: 'agent_message_id' });
  });
  it('two concurrent uploads of the same file: exactly one accepted + one duplicate, one attachment row, one job (unique-key race is mapped, not a 500)', async () => {
    const w = makeAttachmentsWorld(); const f = pdfBytes('race');
    const [a, b] = await Promise.all([submit(w, f, { ctx: makeDeviceCtx(w) }), submit(w, f, { ctx: makeDeviceCtx(w) })]);
    expect([a.body['outcome'], b.body['outcome']].sort()).toEqual(['accepted', 'duplicate']);
    expect(w.attachments).toHaveLength(1); expect(w.messages).toHaveLength(1); expect(w.jobsOf('instruments.scan_attachment')).toHaveLength(1);
    expect([a.body, b.body].find((x) => x['outcome'] === 'duplicate')!['instrument_message_id']).toBe(w.messages[0]!['id']);   // (attachment_id of the loser is not asserted: the winner's attachment insert may not have run yet in a no-lock fake)
  });
});

describe('E06 no Storage URL anywhere (AC-12.6 / A13 P-2; S-11)', () => {
  it('response body, rows, job payload and log lines contain no URL; ctx.storage.signedUrl is never called', async () => {
    const w = makeAttachmentsWorld(); const { r, c } = await submit(w, pdfBytes());
    expect(JSON.stringify(r)).not.toMatch(URLISH); expect(JSON.stringify(w.attachments)).not.toMatch(URLISH); expect(JSON.stringify(w.jobs)).not.toMatch(URLISH);
    expect(c.logText()).not.toMatch(URLISH); expect(c.storage.callsOf('signedUrl')).toEqual([]); expect(Object.keys(r.body).sort()).toEqual(['attachment_id', 'instrument_message_id', 'outcome', 'scan_state']);
  });
  it('log lines and metrics hold no barcode, file name or file content (PHI)', async () => {
    const w = makeAttachmentsWorld(); const { c } = await submit(w, pdfBytes('Testpatient'), { filename: 'Testpatient-E2600000042.pdf' });
    expect(c.logText()).not.toContain(BARCODE); expect(c.logText()).not.toContain('Testpatient');
  });
  it('the T11 sources never reference signedUrl (C7 does not use it, TRD §6.8 downloads)', async () => {
    const { existsSync, readFileSync, readdirSync } = await import('node:fs'); const { fileURLToPath } = await import('node:url');
    const dir = fileURLToPath(new URL('../', import.meta.url));
    const files = [`${dir}service/attachments.service.ts`, `${dir}handlers/attachments.handlers.ts`, ...(existsSync(`${dir}attachments/adapters`) ? readdirSync(`${dir}attachments/adapters`).map((f) => `${dir}attachments/adapters/${f}`) : [])];
    for (const f of files.slice(0, 2)) expect(existsSync(f), f).toBe(true);
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/signedUrl|createSignedUrl|\/object\/sign\//);
  });
});

// ------------------------------------------------------------------------------------------------------------------------ E37
const MSG = idN(0xf001);
function seeded(o: { att?: Row; bytes?: Buffer; centreRoleDenied?: boolean } = {}) {
  const f = o.bytes ?? pdfBytes(); const att = attachmentRow({ sha256: sha(f), size_bytes: f.length, ...(o.att ?? {}) });
  const w = makeAttachmentsWorld({ attachments: [att] }); w.messages.push({ tenant_id: TENANT_A, id: MSG, centre_id: att['centre_id'], instrument_id: FILE_DROP_INS, protocol: 'file_drop', message_kind: 'attachment' });
  const c = makeStaffCtx(w, { roleDenied: o.centreRoleDenied }); c.storage.seed(att['object_path'] as string, f);
  return { w, c, att, f, svc: createAttachmentsService({ repo: w.repo }) };
}
describe('E37 downloadInstrumentAttachment (AC-12.6; REQ-SEC-034/035/085; S-11 headers)', () => {
  it('clean attachment: 200, stored bytes, content-type, Content-Disposition: attachment, nosniff, no-store, Content-Length; ONE access_log instrument_message.attachment_view', async () => {
    const { w, c, svc, f, att } = seeded(); const r: any = await svc.downloadInstrumentAttachment(c.ctx, { instrumentMessageId: MSG });
    expect(r.status).toBe(200); expect(Buffer.from(r.body).equals(f)).toBe(true);
    const h = Object.fromEntries(Object.entries(r.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    expect(h['content-type']).toBe('application/pdf'); expect(h['content-disposition']).toMatch(/^attachment;/); expect(h['content-disposition']).toContain('slide-0042.pdf');
    expect(h['x-content-type-options']).toBe('nosniff'); expect(h['cache-control']).toBe('no-store'); expect(h['content-length']).toBe(String(f.length));
    expect(w.accessRows).toEqual([{ action: 'instrument_message.attachment_view', entityType: 'instrument_message', entityId: MSG, centreId: att['centre_id'], outcome: 'allowed', detail: {}, actorId: c.ctx.actor.id }]);
  });
  it('the role/centre check runs first: instruments.message.read for the attachment\'s centre', async () => {
    const { c, svc, att } = seeded(); await svc.downloadInstrumentAttachment(c.ctx, { instrumentMessageId: MSG });
    expect(c.roleCalls).toEqual([expect.objectContaining({ permission: 'instruments.message.read', centreId: att['centre_id'] })]);
  });
  it('a user without the permission for that centre -> auth.forbidden; no storage read, no bytes, no access_log', async () => {
    const { w, c, svc } = seeded({ centreRoleDenied: true }); const e = await failure(svc.downloadInstrumentAttachment(c.ctx, { instrumentMessageId: MSG }));
    expect(e.code).toBe('auth.forbidden'); expect(c.storage.callsOf('read')).toEqual([]); expect(w.accessRows).toEqual([]);
  });
  it.each(['pending', 'quarantined', 'failed'])('scan_state %s -> 422 common.upload_quarantined; the object is never read, no access_log', async (state) => {
    const { w, c, svc } = seeded({ att: { scan_state: state } }); const e = await failure(svc.downloadInstrumentAttachment(c.ctx, { instrumentMessageId: MSG }));
    expect(e.code).toBe('common.upload_quarantined'); expect(c.storage.callsOf('read')).toEqual([]); expect(w.accessRows).toEqual([]);
  });
  it('no Storage URL in the response (headers + body), the log, or any storage call (A13 P-2)', async () => {
    const { c, svc } = seeded(); const r: any = await svc.downloadInstrumentAttachment(c.ctx, { instrumentMessageId: MSG });
    expect(JSON.stringify(r.headers)).not.toMatch(URLISH); expect(r.headers['location'] ?? r.headers['Location']).toBeUndefined(); expect(c.logText()).not.toMatch(URLISH);
    expect(c.storage.callsOf('signedUrl')).toEqual([]); expect(JSON.stringify(c.storage.calls)).not.toContain(URL_SENTINEL);
  });
  it('hostile original_file_name (quotes, CR/LF header injection, non-ASCII) cannot break the Content-Disposition header', async () => {
    const { c, svc } = seeded({ att: { original_file_name: 'a"b\r\nSet-Cookie: x=1;é.pdf' } }); const r: any = await svc.downloadInstrumentAttachment(c.ctx, { instrumentMessageId: MSG });
    const cd = r.headers['content-disposition'] ?? r.headers['Content-Disposition'];
    expect(cd).not.toMatch(/[\r\n]/); expect(cd).toMatch(/^attachment;/); expect(Object.keys(r.headers).some((k) => /^set-cookie$/i.test(k))).toBe(false);
  });
  it('a 255-char original_file_name still yields a Content-Disposition within the contract maxLength 255 (instruments.yaml E37 200 headers)', async () => {
    const { c, svc } = seeded({ att: { original_file_name: `${'n'.repeat(251)}.pdf` } }); const r: any = await svc.downloadInstrumentAttachment(c.ctx, { instrumentMessageId: MSG });
    expect(String(r.headers['content-disposition'] ?? r.headers['Content-Disposition']).length).toBeLessThanOrEqual(255);
  });
  it('unknown message id -> 404 common.not_found', async () => {
    const { c, svc } = seeded(); const e = await failure(svc.downloadInstrumentAttachment(c.ctx, { instrumentMessageId: idN(0xbeef) })); expect(e.code).toBe('common.not_found'); expect(c.storage.callsOf('read')).toEqual([]);
  });
  it('a message without attachment (an E04 message) -> 404 common.not_found', async () => {
    const { w, c, svc } = seeded(); w.messages.push({ tenant_id: TENANT_A, id: idN(0xf002), protocol: 'astm' });
    const e = await failure(svc.downloadInstrumentAttachment(c.ctx, { instrumentMessageId: idN(0xf002) })); expect(e.code).toBe('common.not_found');
  });
  it('another tenant cannot read it: tenant B context -> 404 and the tenant-B repo call is tenant-scoped', async () => {
    const { w, svc } = seeded(); const cB = makeStaffCtx(w, { tenantId: TENANT_B }); cB.storage.seed(`${TENANT_A}/2026/11/${attId(1)}.pdf`, pdfBytes());
    const e = await failure(svc.downloadInstrumentAttachment(cB.ctx, { instrumentMessageId: MSG })); expect(e.code).toBe('common.not_found');
    expect(w.callsOf('findAttachmentByMessage').every((x) => x.tenantId === TENANT_B)).toBe(true); expect(cB.storage.callsOf('read')).toEqual([]); expect(w.accessRows).toEqual([]);
  });
  it.each([
    ['another tenant\'s first segment', `${TENANT_B}/2026/11/${attId(1)}.pdf`],
    ['path traversal', `${TENANT_A}/../${TENANT_B}/2026/11/x.pdf`],
    ['missing tenant segment', `2026/11/${attId(1)}.pdf`],
  ])('corrupt object_path (%s) is refused (path tenant check): no bytes returned, nothing read outside the caller tenant', async (_n, path) => {
    const { w, c, svc } = seeded({ att: { object_path: path } }); c.storage.seed(path, Buffer.from('FOREIGN-TENANT-BYTES'));
    const e = await failure(svc.downloadInstrumentAttachment(c.ctx, { instrumentMessageId: MSG })); expect(e).toBeTruthy();
    expect(JSON.stringify(e)).not.toContain('FOREIGN-TENANT-BYTES'); expect(c.storage.callsOf('read')).toEqual([]); expect(w.accessRows).toEqual([]);   // storage.calls = accesses that passed the core tenant rule
  });
});
