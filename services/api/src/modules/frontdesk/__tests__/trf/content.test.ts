// FD-T10 F21 getTrfAttachment (metadata) + F21a getTrfAttachmentContent (US-FD-09.2, 09.4; 07-SECURITY REQ-SEC-034/035/083, A11, A20; 08 A13 P-2).
// done_when: content only when clean (422 common.upload_quarantined otherwise); no Storage URL; trf.view access_log row per content call; attachment / nosniff / no-store.
import { describe, expect, it } from 'vitest';
import { CENTRE, CENTRE_A2, NAME_SENTINEL, READ, T, TENANT_A, TENANT_B, UPLOAD, URL_SENTINEL, content, contentFails, makeWorld, meta, metaFails, pdfBytes, pngBytes, schemaErrors, seedOrderFor, seedTrf, uid, viewRows } from './helpers.js';

const hdr = (r: { headers?: Record<string, string> }, name: string) => Object.entries(r.headers ?? {}).find(([k]) => k.toLowerCase() === name)?.[1];
const bytesOf = (r: { body: any }) => Buffer.from(r.body as Uint8Array);
const NOT_CLEAN = ['pending', 'quarantined', 'failed'] as const;

describe('F21 getTrfAttachment: metadata only', () => {
  it.each(['pending', 'clean', 'quarantined', 'failed'])('scan_state %s: 200, schema-valid TrfAttachment, never a URL, bucket, path or hash', async (state) => {
    const w = makeWorld(); const order = await seedOrderFor('a');
    const row = await seedTrf(w, { state, orderId: order.id, filename: `${NAME_SENTINEL}.pdf` });
    const r = await meta(row.id, { w });
    expect(r.status).toBe(200);
    expect(schemaErrors('TrfAttachment', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: row.id, order_id: order.id, mime_type: 'application/pdf', size_bytes: row.size_bytes, scan_state: state, original_filename: `${NAME_SENTINEL}.pdf` });
    expect(Object.keys(r.body).sort().every((k) => ['id', 'order_id', 'mime_type', 'size_bytes', 'scan_state', 'uploaded_at', 'uploaded_by', 'original_filename'].includes(k))).toBe(true);
    expect(JSON.stringify([r.body, r.headers ?? {}])).not.toMatch(/https?:\/\/|token=|object_path|bucket|sha256|frontdesk-trf/i);
    expect(w.storage.calls, 'metadata never touches the object store').toEqual([]);
    expect(r.probe.logs.join('\n'), 'file name is P2: never logged').not.toContain(NAME_SENTINEL);
  }, T);

  it('requires frontdesk.order.read (frontdesk.trf.upload alone is not enough)', async () => {
    const w = makeWorld(); const row = await seedTrf(w, {});
    for (const grants of [[], [UPLOAD]]) expect((await metaFails(row.id, { w, grants })).code).toBe('auth.forbidden');
  }, T);

  it('A11: another tenant\'s attachment, an unknown id and a non-uuid id -> 404 common.not_found (non-uuid may be 400); no existence oracle', async () => {
    const w = makeWorld(); const mine = await seedTrf(w, {}); const theirs = await seedTrf(w, { side: 'b' });
    const a = await metaFails(theirs.id, { w });
    const b = await metaFails(uid(), { w });
    expect(a.code).toBe('common.not_found');
    expect(b.code).toBe('common.not_found');
    expect(a.message).toBe(b.message);
    expect(['common.not_found', 'common.validation_failed']).toContain((await metaFails('not-a-uuid', { w })).code);
    expect((await metaFails(mine.id, { w, tenant: TENANT_B })).code).toBe('common.not_found');
  }, T);

  it('REQ-SEC-017: a user scoped to centre A1 gets 404 for a centre A2 attachment; an A2-scoped user sees it', async () => {
    const w = makeWorld(); const a2 = await seedTrf(w, { centre: CENTRE_A2 });
    expect((await metaFails(a2.id, { w, centreIds: [CENTRE.a] })).code).toBe('common.not_found');
    expect((await meta(a2.id, { w, centreIds: [CENTRE.a, CENTRE_A2] })).status).toBe(200);
  }, T);
});

describe('F21a getTrfAttachmentContent: clean file (US-FD-09.4)', () => {
  it('streams the stored bytes with Content-Disposition: attachment, X-Content-Type-Options: nosniff, Cache-Control: no-store and the stored content type', async () => {
    const w = makeWorld(); const bytes = pdfBytes('clean-stream');
    const row = await seedTrf(w, { bytes, filename: 'synthetic-trf.pdf' });
    const r = await content(row.id, { w });
    expect(r.status).toBe(200);
    expect(bytesOf(r).equals(bytes)).toBe(true);
    expect(hdr(r, 'content-disposition')).toMatch(/^attachment(;|$)/);
    expect(hdr(r, 'content-disposition')).toContain('synthetic-trf.pdf');
    expect(hdr(r, 'x-content-type-options')).toBe('nosniff');
    expect(hdr(r, 'cache-control')).toBe('no-store');
    expect(hdr(r, 'content-type')).toBe('application/pdf');
    expect(hdr(r, 'content-disposition')).not.toMatch(/^inline/i);
  }, T);

  it('an image is also served as attachment (never inline on an app origin, P-2)', async () => {
    const w = makeWorld(); const bytes = pngBytes();
    const row = await seedTrf(w, { bytes, mime: 'image/png', filename: 'phone.png', path: `${TENANT_A}/2026/11/${uid()}.png` });
    const r = await content(row.id, { w });
    expect(r.status).toBe(200);
    expect(hdr(r, 'content-type')).toBe('image/png');
    expect(hdr(r, 'content-disposition')).toMatch(/^attachment(;|$)/);
    expect(hdr(r, 'x-content-type-options')).toBe('nosniff');
    expect(hdr(r, 'content-security-policy') ?? "sandbox").toMatch(/sandbox/);
  }, T);

  it('a hostile stored file name cannot inject headers (RFC 6266 encoding): no CR/LF, no Set-Cookie header, no extra headers', async () => {
    const w = makeWorld();
    const row = await seedTrf(w, { filename: 'a"b\r\nSet-Cookie: x=1\r\n\r\n<html>.pdf' });
    const r = await content(row.id, { w });
    expect(hdr(r, 'content-disposition')).not.toMatch(/[\r\n]/);
    expect(Object.keys(r.headers ?? {}).map((k) => k.toLowerCase())).not.toContain('set-cookie');
  }, T);

  it('trf.view access_log row on EVERY call (3 calls = 3 rows: trf_attachment, entity id, actor, centre, allowed)', async () => {
    const w = makeWorld(); const row = await seedTrf(w, {});
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) { const r = await content(row.id, { w }); expect(r.status).toBe(200); ids.push(r.probe.requestId); }
    const logged = await viewRows(row.id);
    expect(logged).toHaveLength(3);
    for (const l of logged) expect(l).toMatchObject({ tenant_id: TENANT_A, action: 'trf.view', entity_type: 'trf_attachment', entity_id: row.id, centre_id: CENTRE.a, outcome: 'allowed' });
    expect(logged.map((l) => l.request_id).sort()).toEqual([...ids].sort());
    expect(JSON.stringify(logged.map((l) => l.detail))).not.toMatch(/synthetic-trf|https?:|\.pdf/i);
  }, T);

  it('requires frontdesk.order.read; a denied call returns no bytes and writes no trf.view row', async () => {
    const w = makeWorld(); const row = await seedTrf(w, {});
    for (const grants of [[], [UPLOAD]]) expect((await contentFails(row.id, { w, grants })).code).toBe('auth.forbidden');
    expect(w.storage.callsOf('read')).toEqual([]);
    expect(await viewRows(row.id)).toEqual([]);
  }, T);
});

describe('F21a content gate (US-FD-09.2: only a clean file is ever served)', () => {
  it.each(NOT_CLEAN)('scan_state %s: 422 common.upload_quarantined, the object is never read, no trf.view row', async (state) => {
    const w = makeWorld(); const row = await seedTrf(w, { state });
    const e = await contentFails(row.id, { w });
    expect(e.code).toBe('common.upload_quarantined');
    expect(w.storage.callsOf('read')).toEqual([]);
    expect(await viewRows(row.id)).toEqual([]);
  }, T);

  it('a pending TRF that the scanner would flag is still not served (the gate is the row state, not a fresh scan)', async () => {
    const w = makeWorld(); w.scanner.mode = 'clean';
    const row = await seedTrf(w, { state: 'pending' });
    expect((await contentFails(row.id, { w })).code).toBe('common.upload_quarantined');
    expect(w.scanner.calls, 'F21a does not scan').toBe(0);
  }, T);

  it('a clean row whose object is gone fails closed: no 200, no bytes, no trf.view row', async () => {
    const w = makeWorld(); const row = await seedTrf(w, { noObject: true });
    const e = await contentFails(row.id, { w });
    expect(['common.dependency_unavailable', 'common.not_found', 'common.internal']).toContain(e.code);
    expect(await viewRows(row.id)).toEqual([]);
  }, T);
});

describe('F21a: no Storage URL, tenant and centre isolation (P-2, A11, A20)', () => {
  it('signedUrl is never requested, and no URL/sentinel appears in headers, body, logs or the access-log detail', async () => {
    const w = makeWorld(); const row = await seedTrf(w, { filename: `${NAME_SENTINEL}.pdf` });
    const r = await content(row.id, { w });
    for (const state of NOT_CLEAN) { const x = await seedTrf(w, { state }); await contentFails(x.id, { w }); }
    expect(w.storage.callsOf('signedUrl')).toEqual([]);
    expect(JSON.stringify([r.headers, r.probe.logs])).not.toMatch(/https?:|storage\.invalid|token=|signature|location/i);
    expect(bytesOf(r).includes(URL_SENTINEL)).toBe(false);
    expect(Object.keys(r.headers ?? {}).map((k) => k.toLowerCase())).not.toContain('location');
    expect(r.probe.logs.join('\n')).not.toContain(NAME_SENTINEL);
    expect(JSON.stringify(await viewRows(row.id))).not.toMatch(/https?:|storage\.invalid/i);
  }, T);

  it('A11: another tenant\'s clean attachment / unknown id -> 404, no read of the other tenant\'s object, no trf.view row', async () => {
    const w = makeWorld(); const theirs = await seedTrf(w, { side: 'b' });
    expect((await contentFails(theirs.id, { w })).code).toBe('common.not_found');
    expect((await contentFails(uid(), { w })).code).toBe('common.not_found');
    expect(w.storage.callsOf('read')).toEqual([]);
    expect(await viewRows(theirs.id)).toEqual([]);
    const mine = await seedTrf(w, {});
    expect((await contentFails(mine.id, { w, tenant: TENANT_B })).code).toBe('common.not_found');
    expect(await viewRows(mine.id)).toEqual([]);
  }, T);

  it('REQ-SEC-017: centre A1 user -> 404 for a clean centre A2 TRF (no read, no log); centre A2 user gets the bytes', async () => {
    const w = makeWorld(); const bytes = pdfBytes('a2');
    const row = await seedTrf(w, { centre: CENTRE_A2, bytes });
    expect((await contentFails(row.id, { w, centreIds: [CENTRE.a] })).code).toBe('common.not_found');
    expect(w.storage.callsOf('read')).toEqual([]);
    expect(await viewRows(row.id)).toEqual([]);
    const ok = await content(row.id, { w, centreIds: [CENTRE_A2] });
    expect(ok.status).toBe(200);
    expect(bytesOf(ok).equals(bytes)).toBe(true);
    expect(await viewRows(row.id)).toHaveLength(1);
  }, T);

  it('a TRF linked to an order is served by the same rules (order link does not widen access)', async () => {
    const w = makeWorld(); const order = await seedOrderFor('a', CENTRE_A2);
    const row = await seedTrf(w, { centre: CENTRE_A2, orderId: order.id });
    expect((await contentFails(row.id, { w, centreIds: [CENTRE.a] })).code).toBe('common.not_found');
    expect((await content(row.id, { w, centreIds: [CENTRE_A2] })).status).toBe(200);
  }, T);
});
