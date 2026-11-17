// FD-T16 / 07-SECURITY §6.6 upload probes that FD-T10 (../trf/*) does not already pin, plus the P-2 sweep over EVERY operation.
// FD-T10 already covers: EICAR, EICAR polyglot, .pdf.exe, SVG, HTML-as-PDF/JPEG, 0-byte, 15 MiB / 16 MB, PNG EXIF/GPS strip, F21a headers (attachment / nosniff / no-store), scan gate, tenant + centre 404.
// Here: (1) a JPEG that is also HTML (polyglot) and a JPEG with EXIF GPS through the REAL core uploads: never stored with the script / GPS intact; (2) a PDF with JavaScript: accepted only as
// `pending` and never served before the worker marks it clean; (3) "a scan of every F response body and header for Storage URL strings (must be none — P-2)" over all 29 operations.
import { beforeAll, describe, expect, it } from 'vitest';
import { GPS, URL_SENTINEL, jpegBytes, makeWorld, pdfBytes } from '../trf/helpers.js';
import { FULL_A, OPS, T, TENANT_A, codeOf, fire, objs, requestFor, req, uid, type Objs } from './kit.js';

let A: Objs;
beforeAll(async () => { A = await objs('a'); }, T);
const stored = (w: ReturnType<typeof makeWorld>): string[] => [...w.storage.objects.values()].map((b) => b.toString('latin1'));
const upload = (w: ReturnType<typeof makeWorld>, file: { filename: string; mimeType: string; bytes: Uint8Array }) =>
  fire('uploadTrf', req({ headers: { 'idempotency-key': uid() }, body: { file, centre_id: A.centre } }), FULL_A, { trf: w });

describe('hostile images', () => {
  it('polyglot JPEG + HTML: refused, or stored without the script (never raw)', { timeout: T }, async () => {
    const poly = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0', 'latin1'), Buffer.from('<html><script>alert(document.cookie)</script></html>', 'latin1'), Buffer.from([0xff, 0xd9])]);
    const w = makeWorld(TENANT_A);
    const out = await upload(w, { filename: 'poly.jpg', mimeType: 'image/jpeg', bytes: poly });
    if (out.error) expect(['common.unsupported_media_type', 'common.upload_quarantined', 'common.validation_failed']).toContain(codeOf(out));
    else expect(out.reply?.status).toBe(201);
    for (const s of stored(w)) expect(s).not.toContain('<script>');
  });
  it('JPEG with EXIF GPS: refused, or stored without the GPS block', { timeout: T }, async () => {
    const w = makeWorld(TENANT_A);
    const out = await upload(w, { filename: 'gps.jpg', mimeType: 'image/jpeg', bytes: jpegBytes() });
    if (out.error) expect(['common.unsupported_media_type', 'common.upload_quarantined', 'common.validation_failed', 'common.dependency_unavailable']).toContain(codeOf(out));
    for (const s of stored(w)) expect(s).not.toContain(GPS);
  });
});

describe('PDF with JavaScript (qpdf sanitising is the worker\'s job: frontdesk.trf_scan)', () => {
  it('F20 stores it as pending only; F21a refuses to serve it until the worker has marked it clean', { timeout: T }, async () => {
    const js = Buffer.from('%PDF-1.4\n1 0 obj<< /Type /Catalog /OpenAction << /S /JavaScript /JS (app.alert\\(1\\)) >> >>endobj\ntrailer<< /Root 1 0 R >>\n%%EOF\n', 'latin1');
    const w = makeWorld(TENANT_A);
    const up = await upload(w, { filename: 'js.pdf', mimeType: 'application/pdf', bytes: js });
    expect(up.reply?.status, `${up.error?.message}`).toBe(201);
    expect(up.reply!.body.scan_state).toBe('pending');
    expect(up.probe.trf.jobs.filter((j) => j.identifier === 'frontdesk.trf_scan')).toHaveLength(1);
    const get = await fire('getTrfAttachmentContent', req({ params: { attachment_id: up.reply!.body.id } }), FULL_A, { trf: w });
    expect(get.reply, 'a pending PDF must never be streamed').toBeUndefined();
    expect(codeOf(get)).toBe('common.upload_quarantined');
  });
});

describe('P-2: no Storage URL / bucket path in ANY response body or header of ANY operation (success or error)', () => {
  const URLISH = /https?:\/\/|storage\.invalid|object\/sign|signedurl|supabase|frontdesk-trf\/|[?&]token=/i;
  it.each(OPS.map((o) => [o.id] as const))('%s', { timeout: T }, async (id) => {
    const out = await fire(id, requestFor(id, A), FULL_A, { trf: A.w });
    const text = JSON.stringify({ status: out.reply?.status, headers: out.reply?.headers, body: ArrayBuffer.isView(out.reply?.body) ? '<stream>' : out.reply?.body,
      error: out.error ? { code: out.error.code, message: out.error.message, detail: out.error.detail, errors: out.error.errors } : undefined });
    expect(text, id).not.toMatch(URLISH);
    expect(text, id).not.toContain(URL_SENTINEL);
    expect(text, `${id}: a tenant-prefixed object path`).not.toContain(`${TENANT_A}/20`);
    expect(out.probe.trf.storage.callsOf('signedUrl'), `${id}: signedUrl must never be requested`).toHaveLength(0);
  });
  it('F21a is the one operation that streams: attachment + nosniff + no-store on a clean file of the caller\'s tenant', { timeout: T }, async () => {
    const out = await fire('getTrfAttachmentContent', requestFor('getTrfAttachmentContent', A), FULL_A, { trf: A.w });
    expect(out.reply?.status, `${out.error?.message}`).toBe(200);
    const h = Object.fromEntries(Object.entries(out.reply!.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    expect(h['content-disposition']).toMatch(/^attachment/i);
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['cache-control']).toMatch(/no-store/i);
    expect(pdfBytes('seed').length).toBeGreaterThan(0);
  });
});
