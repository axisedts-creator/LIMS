// FD-T10 F20 uploadTrf (US-FD-09.1, 09.2, 09.3, 09.5; 07-SECURITY F20 row, REQ-SEC-083..085, T-class upload threats). Real PG17 tx under RLS, REAL core createUploads over a fake object store + fake scanner.
// done_when: EICAR quarantined; 16MB 413; html 415; EXIF GPS stripped; no Storage URL in responses. Synthetic data only.
import { describe, expect, it } from 'vitest';
import { BUCKET, CENTRE, CENTRE_A2, EICAR, GPS, MAX, NAME_SENTINEL, READ, T, TENANT_A, TENANT_B, UPLOAD, URL_SENTINEL, file, jpegBytes, makeWorld, pdfBytes, pdfOfSize, pngBytes, schemaErrors, seedOrderFor,
  sha, trfCount, trfRow, upload, uploadFails, uid } from './helpers.js';

const body = (f: any, extra: Record<string, unknown> = {}) => ({ file: f, centre_id: CENTRE.a, ...extra });
const noSideEffects = async (w: ReturnType<typeof makeWorld>, before: number) => {
  expect(await trfCount(TENANT_A), 'no row').toBe(before);
  expect(w.storage.paths(), 'no object left in the store').toEqual([]);
  expect(w.jobs, 'no scan job').toEqual([]);
};

describe('F20 happy path (US-FD-09.1)', () => {
  it('stores a PDF under {tenant_id}/…, scan_state pending, returns a schema-valid TrfAttachment, enqueues frontdesk.trf_scan keyed by the attachment', async () => {
    const w = makeWorld(); const bytes = pdfBytes('happy');
    const r = await upload(body(file(bytes, `${NAME_SENTINEL}.pdf`)), { w });
    expect(r.status).toBe(201);
    expect(schemaErrors('TrfAttachment', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ mime_type: 'application/pdf', size_bytes: bytes.length, scan_state: 'pending' });
    expect(r.body.uploaded_by.membership_id).toBe(r.probe.membershipId);
    expect(r.body.original_filename).toBeTypeOf('string');
    const row = await trfRow(r.body.id);
    expect(row).toMatchObject({ tenant_id: TENANT_A, centre_id: CENTRE.a, bucket: BUCKET, scan_state: 'pending', mime_type: 'application/pdf' });
    expect(Number(row.size_bytes), 'bigint column: node-pg returns a string').toBe(bytes.length);
    expect(row.order_id).toBeNull();
    expect(row.object_path.startsWith(`${TENANT_A}/`), 'tenant is the first path segment').toBe(true);
    expect(row.object_path, 'server-generated name: the client file name never reaches the key').not.toContain(NAME_SENTINEL);
    expect(w.storage.paths()).toEqual([row.object_path]);
    expect(row.sha256).toBe(sha(w.storage.get(row.object_path)!));
    expect(w.jobsOf('frontdesk.trf_scan')).toEqual([{ identifier: 'frontdesk.trf_scan', payload: { tenant_id: TENANT_A, attachment_id: r.body.id }, jobKey: r.body.id }]);
  }, T);

  it('a file of exactly 15 MiB (15728640 bytes) is accepted', async () => {
    const r = await upload(body(file(pdfOfSize(MAX))), { w: makeWorld() });
    expect(r.status).toBe(201);
    expect(r.body.size_bytes).toBe(MAX);
  }, T);

  it('order_id links the TRF to a tenant order; omitted = a draft (order_id NULL, purge candidate)', async () => {
    const order = await seedOrderFor('a');
    const linked = await upload(body(file(pdfBytes('l')), { order_id: order.id }), { w: makeWorld() });
    expect(linked.status).toBe(201);
    expect(linked.body.order_id).toBe(order.id);
    expect((await trfRow(linked.body.id)).order_id).toBe(order.id);
    const draft = await upload(body(file(pdfBytes('d'))), { w: makeWorld() });
    expect(draft.body.order_id).toBeUndefined();
    expect((await trfRow(draft.body.id)).order_id).toBeNull();
  }, T);

  it('a JPEG goes to ctx.uploads.accept with the TRD §2 options: allow jpeg/png/pdf, 15 MiB, bucket frontdesk-trf, images {reencode, stripMetadata}, scan required, tenant-prefixed path (core cannot re-encode JPEG yet: spy)', async () => {
    const w = makeWorld(); const bytes = jpegBytes(); const seen: any[] = [];
    const uploads = {
      async accept(f: any, opts: any) {
        seen.push({ f, opts });
        await w.storage.adapter.put(opts.bucket, opts.objectPath, bytes, { contentType: 'image/jpeg', ifAbsent: true });
        return { objectId: uid(), bucket: opts.bucket, objectPath: opts.objectPath, sha256: sha(bytes), byteSize: bytes.length, mime: 'image/jpeg', scanState: 'unavailable' };
      },
    };
    const r = await upload(body(file(bytes, 'phone-photo.jpg', 'image/jpeg')), { w, uploads });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ mime_type: 'image/jpeg', scan_state: 'pending', size_bytes: bytes.length });
    expect(seen).toHaveLength(1);
    const o = seen[0].opts;
    expect([...o.allow].sort()).toEqual(['application/pdf', 'image/jpeg', 'image/png']);
    expect(o.maxBytes).toBe(MAX);
    expect(o.bucket).toBe(BUCKET);
    expect(o.images).toMatchObject({ reencode: true, stripMetadata: true });
    expect(o.scan).toBe('required');
    expect(o.objectPath.startsWith(`${TENANT_A}/`)).toBe(true);
    expect((await trfRow(r.body.id)).object_path).toBe(o.objectPath);
    expect(w.jobsOf('frontdesk.trf_scan')).toHaveLength(1);
  }, T);
});

describe('F20 EXIF/GPS stripped (US-FD-09.5, 08 R12b)', () => {
  it('a PNG carrying tEXt + eXIf GPS chunks is stored re-encoded without them; the row hash is that of the STORED bytes', async () => {
    const w = makeWorld(); const original = pngBytes({ meta: true });
    expect(original.includes(GPS), 'fixture really carries the GPS sentinel').toBe(true);
    const r = await upload(body(file(original, 'phone.png', 'image/png')), { w });
    expect(r.status).toBe(201);
    const row = await trfRow(r.body.id); const stored = w.storage.get(row.object_path)!;
    expect(stored.includes(GPS), 'GPS sentinel survived in the stored object').toBe(false);
    for (const chunk of ['tEXt', 'eXIf', 'iTXt', 'zTXt']) expect(stored.includes(chunk), chunk).toBe(false);
    expect(row.sha256).toBe(sha(stored));
    expect(row.sha256).not.toBe(sha(original));
    expect(stored.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
  }, T);
});

describe('F20 malware and polyglots (US-FD-09.2, REQ-SEC-084)', () => {
  const infected = [
    ['EICAR test file as a PDF', () => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from(EICAR, 'latin1'), Buffer.from('\n%%EOF\n')])],
    ['polyglot: PDF header + EICAR payload after a valid-looking body', () => Buffer.concat([pdfBytes('poly'), Buffer.from(`\n<script>${EICAR}</script>`, 'latin1')])],
  ] as const;
  it.each(infected)('%s: 422 common.upload_quarantined, nothing stored, no row, no scan job', async (_n, make) => {
    const w = makeWorld(); const before = await trfCount(TENANT_A);
    const e = await uploadFails(body(file(make(), `${NAME_SENTINEL}.pdf`)), { w });
    expect(e.code).toBe('common.upload_quarantined');
    expect(w.scanner.calls).toBeGreaterThan(0);
    await noSideEffects(w, before);
  }, T);

  it('scanner down at upload time: the upload is NOT blocked (registration never waits): 201 pending + job; the worker decides later (plan risk row "scanner unavailable")', async () => {
    const w = makeWorld(); w.scanner.mode = 'unavailable';
    const r = await upload(body(file(pdfBytes('down'))), { w });
    expect(r.status).toBe(201);
    expect(r.body.scan_state).toBe('pending');
    expect((await trfRow(r.body.id)).scan_state).toBe('pending');
    expect(w.jobsOf('frontdesk.trf_scan')).toHaveLength(1);
  }, T);

  it('scanner that throws behaves like unavailable: never "clean", never a 500', async () => {
    const w = makeWorld(); w.scanner.mode = 'throw';
    const r = await upload(body(file(pdfBytes('throw'))), { w });
    expect(r.status).toBe(201);
    expect((await trfRow(r.body.id)).scan_state).toBe('pending');
  }, T);

  it('a clean file is never marked clean by F20 itself: only the worker may set clean (scan_state stays pending)', async () => {
    const w = makeWorld(); w.scanner.mode = 'clean';
    const r = await upload(body(file(pdfBytes('c'))), { w });
    expect(r.body.scan_state).toBe('pending');
    expect((await trfRow(r.body.id)).scan_state).toBe('pending');
  }, T);
});

describe('F20 media type and size (US-FD-09.3)', () => {
  const bad: Array<[string, any]> = [
    ['.pdf.exe', file(pdfBytes('x'), 'form.pdf.exe', 'application/pdf')],
    ['text/html (.html)', file(Buffer.from('<html><script>alert(1)</script></html>'), 'form.html', 'text/html')],
    ['HTML bytes disguised as .jpg / image/jpeg (magic mismatch)', file(Buffer.from('<html><script>alert(1)</script></html>'), 'form.jpg', 'image/jpeg')],
    ['HTML bytes disguised as .pdf', file(Buffer.from('<html>x</html>'), 'form.pdf', 'application/pdf')],
    ['PDF bytes declared text/html', file(pdfBytes('h'), 'form.pdf', 'text/html')],
    ['SVG', file(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'), 'form.svg', 'image/svg+xml')],
    ['no extension', file(pdfBytes('n'), 'form', 'application/pdf')],
    ['empty file', file(Buffer.alloc(0), 'empty.pdf', 'application/pdf')],
    ['csv (valid elsewhere, not a TRF type)', file(Buffer.from('a,b\n1,2\n'), 'x.csv', 'text/csv')],
  ];
  it.each(bad)('%s: 415 common.unsupported_media_type, nothing stored', async (_n, f) => {
    const w = makeWorld(); const before = await trfCount(TENANT_A);
    const e = await uploadFails(body(f), { w });
    expect(e.code).toBe('common.unsupported_media_type');
    await noSideEffects(w, before);
  }, T);

  it('16 MB (15728641 bytes): 413 common.payload_too_large, nothing stored', async () => {
    const w = makeWorld(); const before = await trfCount(TENANT_A);
    const e = await uploadFails(body(file(pdfOfSize(MAX + 1))), { w });
    expect(e.code).toBe('common.payload_too_large');
    await noSideEffects(w, before);
  }, T);

  it('no file part: 400 common.validation_failed; a non-uuid order_id / centre_id likewise', async () => {
    const w = makeWorld(); const before = await trfCount(TENANT_A);
    expect((await uploadFails({ centre_id: CENTRE.a }, { w })).code).toBe('common.validation_failed');
    expect((await uploadFails(body(file(pdfBytes('v')), { order_id: 'not-a-uuid' }), { w })).code).toBe('common.validation_failed');
    expect((await uploadFails({ file: file(pdfBytes('v')), centre_id: 'nope' }, { w })).code).toBe('common.validation_failed');
    await noSideEffects(w, before);
  }, T);
});

describe('F20 security probes (07-SECURITY F20 + A11/A20)', () => {
  it('permission: without frontdesk.trf.upload -> auth.forbidden, no side effect (order.read alone is not enough)', async () => {
    const w = makeWorld(); const before = await trfCount(TENANT_A);
    for (const grants of [[], [READ]]) expect((await uploadFails(body(file(pdfBytes('p'))), { w, grants })).code).toBe('auth.forbidden');
    await noSideEffects(w, before);
  }, T);

  it('A11: an order_id of another tenant, or an unknown one -> 404 common.not_found; the object written first is cleaned up (no orphan), no row', async () => {
    const other = await seedOrderFor('b');
    const w = makeWorld(); const before = await trfCount(TENANT_A);
    for (const order_id of [other.id, uid()]) expect((await uploadFails(body(file(pdfBytes('o')), { order_id }), { w })).code).toBe('common.not_found');
    await noSideEffects(w, before);
  }, T);

  it('centre scope (REQ-SEC-017): a user scoped to centre A1 cannot upload for centre A2, an A2 order, or another tenant\'s centre; no side effects', async () => {
    const a2order = await seedOrderFor('a', CENTRE_A2);
    const w = makeWorld(); const before = await trfCount(TENANT_A);
    const denied = ['auth.forbidden', 'common.not_found', 'common.validation_failed'];
    expect(denied).toContain((await uploadFails({ file: file(pdfBytes('c1')), centre_id: CENTRE_A2 }, { w })).code);
    expect(denied).toContain((await uploadFails(body(file(pdfBytes('c2')), { order_id: a2order.id }), { w })).code);
    expect(denied).toContain((await uploadFails({ file: file(pdfBytes('c3')), centre_id: CENTRE.b }, { w })).code);
    await noSideEffects(w, before);
  }, T);

  it('path traversal / hostile file names never reach the object key; the key stays {tenant}/… with plain segments', async () => {
    for (const name of ['../../../tenant-b/x.pdf', '..\\..\\x.pdf', `${NAME_SENTINEL}/../../x.pdf`, 'a%2f..%2fb.pdf', 'a\r\nSet-Cookie: x=1.pdf', 'x\u0000.pdf.exe.pdf']) {
      const w = makeWorld();
      const r = await upload(body(file(pdfBytes('t'), name)), { w }).then((x) => x, (e) => e);
      if (r instanceof Error || r?.code) { expect(['common.unsupported_media_type', 'common.validation_failed']).toContain((r as any).code); continue; }   // refusing the name is fine too
      const row = await trfRow(r.body.id);
      expect(row.object_path).toMatch(new RegExp(`^${TENANT_A}/[A-Za-z0-9_][A-Za-z0-9._/-]*$`));
      expect(row.object_path).not.toMatch(/\.\.|%|\\|\s|NAMESENTINEL/);
      expect(w.storage.paths()).toEqual([row.object_path]);
    }
  }, T);

  it('P-2 / A20: no Storage URL or path-like internals in the response, no signedUrl call, nothing sensitive in logs', async () => {
    const w = makeWorld();
    const r = await upload(body(file(pdfBytes('u'), `${NAME_SENTINEL}.pdf`)), { w });
    const all = JSON.stringify([r.body, r.headers ?? {}, r.probe.logs]);
    expect(w.storage.callsOf('signedUrl')).toEqual([]);
    expect(all).not.toContain(URL_SENTINEL);
    expect(all).not.toMatch(/https?:\/\/|token=|signature=|object_path|"bucket"|sha256/i);
    // P2 (02-CONVENTIONS §9.2) is barred from logs/headers, not from the response body (original_filename is required in TrfAttachment): FD-T10-ruling.
    expect(JSON.stringify([r.headers ?? {}, r.probe.logs]), 'file name is P2: never logged').not.toContain(NAME_SENTINEL);
    expect(r.probe.logs.join('\n')).not.toContain(TENANT_A + '/');
    expect(Object.keys(r.headers ?? {}).map((k) => k.toLowerCase())).not.toContain('location');
  }, T);

  it('failure logs (413 / 415 / quarantine) carry codes only: no file name, no bytes', async () => {
    const w = makeWorld();
    for (const f of [file(pdfOfSize(MAX + 1), `${NAME_SENTINEL}.pdf`), file(pdfBytes('x'), `${NAME_SENTINEL}.exe`), file(Buffer.from(`%PDF-1.4\n${EICAR}`, 'latin1'), `${NAME_SENTINEL}.pdf`)]) {
      const e: any = await uploadFails(body(f), { w });
      expect(JSON.stringify([e?.message ?? '', e?.details ?? {}, e?.code ?? ''])).not.toContain(NAME_SENTINEL);
    }
  }, T);

  it('many users at once: parallel uploads get distinct ids, distinct object keys, one job each; none overwrites another', async () => {
    const w = makeWorld(); const n = 6;
    const rs = await Promise.all(Array.from({ length: n }, (_, i) => upload(body(file(pdfBytes(`par${i}`), 'same-name.pdf')), { w })));
    expect(new Set(rs.map((r) => r.body.id)).size).toBe(n);
    const paths = await Promise.all(rs.map(async (r) => (await trfRow(r.body.id)).object_path));
    expect(new Set(paths).size).toBe(n);
    expect(w.storage.paths().sort()).toEqual([...paths].sort());
    expect(w.jobsOf('frontdesk.trf_scan')).toHaveLength(n);
  }, T);

  it('tenant B uploads land under B\'s prefix and B\'s claims only (A is untouched)', async () => {
    const wb = makeWorld(TENANT_B); const before = await trfCount(TENANT_A);
    const r = await upload({ file: file(pdfBytes('b')), centre_id: CENTRE.b }, { w: wb, tenant: TENANT_B });
    expect(r.status).toBe(201);
    const row = await trfRow(r.body.id);
    expect(row.tenant_id).toBe(TENANT_B);
    expect(row.object_path.startsWith(`${TENANT_B}/`)).toBe(true);
    expect(await trfCount(TENANT_A)).toBe(before);
  }, T);
});
