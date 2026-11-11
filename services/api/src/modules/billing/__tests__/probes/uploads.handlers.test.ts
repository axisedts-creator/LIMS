// BL-T22 / 07-SECURITY §6.6 upload probes (REQ-SEC-083/084/085) through the F21 uploadTrf HANDLER with the REAL core ctx.uploads.accept (fake clamd-style scanner, recording storage),
// plus the P-2 sweep: no response body/header of any C4 operation contains a Storage URL.
// Given tenant A uploads a hostile file, Then it is refused with the 413/415/422 code the spec names, or sanitised, and no unsafe byte is ever stored.
// The handler checks role and centre scope before ctx.uploads.accept (07-SECURITY REQ-SEC-017, A11; BL-T22-ruling), so the ctx here grants both; the body has no order_id, so no order lookup runs.
// Clean-file happy path, F21a/B29a response HEADERS and the real-clamd run belong to FD-T10 / BL-T19 (integration with scanner); the header contract itself is pinned in securityContracts.static.test.ts.
import { describe, expect, it } from 'vitest';
import { createUploads } from '../../../../core/uploads/index.js';
import { PDF, png } from '../../../../core/storage/__tests__/helpers.js';
import { ALL_OPS, CENTRE_A1, ctxFor, notFoundPorts, run, requestFor, spyTx, TENANT_A, safeJson } from './probe.kit.js';

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
const uploadOp = ALL_OPS.find((o) => o.id === 'uploadTrf')!;
const pad = (head: Buffer, n = 64) => Buffer.concat([head, Buffer.alloc(n, 0x20)]);

const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const JPEG_HTML = pad(Buffer.concat([JPEG_HEAD, Buffer.from('<html><script>alert(document.cookie)</script></html>')]));
const JPEG_GPS = pad(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), Buffer.from('Exif\0\0SYNTH-GPS-LAT-27.7172-LON-85.3240'), Buffer.from([0xff, 0xd9])]));
const PDF_JS = Buffer.from('%PDF-1.7\n1 0 obj<</Type/Catalog/OpenAction<</S/JavaScript/JS(app.alert(1))>>>>endobj\ntrailer<<>>\n%%EOF\n', 'latin1');
const MB16 = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(16 * 1024 * 1024, 0x20)]);

async function upload(file: { filename: string; mimeType: string; bytes: Uint8Array }) {
  const stored: Buffer[] = [];
  const storage = { put: async (_b: string, _p: string, bytes: Uint8Array) => { stored.push(Buffer.from(bytes)); return { sha256: 'a'.repeat(64), byteSize: bytes.length }; } };
  const files = { scan: async (b: Uint8Array) => (Buffer.from(b).includes(EICAR) ? ('infected' as const) : ('clean' as const)) };
  const uploads = createUploads({ files, storage: storage as never, module: 'frontdesk', tenantId: TENANT_A });
  // clean-path (201) cases reach insertTrfAttachment, which reads the inserted row back: answer INSERTs with a synthetic row; every other statement stays empty.
  const { tx } = spyTx((text) => (/^\s*INSERT/i.test(text)
    ? [{ id: 'r1', order_id: null, mime_type: 'application/pdf', size_bytes: 1, scan_state: 'pending', created_at: new Date('2026-11-08T06:00:00.000Z'), created_by: 'm1', original_filename: 'trf.pdf' }]
    : []));
  // BL-T22-ruling: the handler checks role + centre scope (REQ-SEC-017, A11) before ctx.uploads.accept, so the ctx carries an allowed IdentityPort, an actor scoped to CENTRE_A1,
  // download/storage.delete (trf.service.ts:35), and a Date clock (the service builds the quarantine key from ctx.now()).
  const identity = { assertRole: async () => undefined, getActor: async () => ({ displayName: 'Synthetic Tester', centreScope: { centreIds: [CENTRE_A1] } }) };
  const base = await notFoundPorts();
  const ports = new Proxy({}, { get: (_t, k) => (k === 'IdentityPort' ? identity : (base as any)[k]) });
  const ctx = await ctxFor(TENANT_A, tx, {
    uploads, files, ports, now: () => new Date('2026-11-08T06:00:00.000Z'),
    storage: { ...storage, delete: async () => undefined }, download: { stream: async () => undefined },
  });
  const req = { ...requestFor(uploadOp), body: { file, centre_id: CENTRE_A1 } };
  const { result, error } = await run(uploadOp, ctx, req as never);
  return { result, error, stored };
}

const REFUSALS: Array<[string, { filename: string; mimeType: string; bytes: Uint8Array }, string]> = [
  ['EICAR in a PDF', { filename: 'trf.pdf', mimeType: 'application/pdf', bytes: Buffer.concat([PDF, Buffer.from(EICAR)]) }, 'common.upload_quarantined'],
  ['double extension .pdf.exe', { filename: 'trf.pdf.exe', mimeType: 'application/pdf', bytes: PDF }, 'common.unsupported_media_type'],
  ['SVG', { filename: 'trf.svg', mimeType: 'image/svg+xml', bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') }, 'common.unsupported_media_type'],
  ['0-byte file', { filename: 'trf.pdf', mimeType: 'application/pdf', bytes: Buffer.alloc(0) }, 'common.unsupported_media_type'],
  ['16 MB file (limit 15 MB)', { filename: 'trf.pdf', mimeType: 'application/pdf', bytes: MB16 }, 'common.payload_too_large'],
  ['HTML named .pdf', { filename: 'trf.pdf', mimeType: 'application/pdf', bytes: Buffer.from('<html><script>1</script></html>') }, 'common.unsupported_media_type'],
  ['PNG bytes declared as PDF', { filename: 'trf.pdf', mimeType: 'application/pdf', bytes: png() }, 'common.unsupported_media_type'],
];

describe('F21 uploadTrf: hostile files are refused and nothing unsafe is stored', () => {
  for (const [name, file, code] of REFUSALS) {
    it(`${name} => ${code}`, async () => {
      const { result, error, stored } = await upload(file);
      expect(result, `answered ${result?.status}`).toBeUndefined();
      expect(error?.code).toBe(code);
      expect(stored).toHaveLength(0);
    });
  }
});

describe('F21 uploadTrf: files that pass the type check must leave nothing active in the stored object', () => {
  it('polyglot JPEG-HTML: refused (415/422) or stored without the script', async () => {
    const { error, stored } = await upload({ filename: 'trf.jpg', mimeType: 'image/jpeg', bytes: JPEG_HTML });
    expect(error?.code, 'stub or crash').not.toBe('common.service_unavailable');
    if (!error) expect(stored.every((b) => !b.includes('<script'))).toBe(true);
    else expect(['common.unsupported_media_type', 'common.upload_quarantined']).toContain(error.code);
    expect(stored.every((b) => !b.includes('<script'))).toBe(true);
  });
  it.todo('qpdf sanitise runs in frontdesk.trf_scan - release gate RG-5');
  it('JPEG with EXIF GPS: the stored object carries no GPS/EXIF payload (or the file is refused)', async () => {
    const { error, stored } = await upload({ filename: 'trf.jpg', mimeType: 'image/jpeg', bytes: JPEG_GPS });
    expect(error?.code, 'stub or crash').not.toBe('common.service_unavailable');
    if (error) expect(['common.upload_quarantined', 'common.unsupported_media_type']).toContain(error.code);
    for (const b of stored) { expect(b.includes('SYNTH-GPS'), 'GPS text survived').toBe(false); expect(b.includes('Exif'), 'EXIF segment survived').toBe(false); }
  });
});

describe('P-2: no Storage URL in any C4 response body or header', () => {
  const STORAGE_URL = /https?:\/\/[^\s"']*(storage|supabase|s3\.|amazonaws|minio|blob\.core|googleapis)[^\s"']*|[?&](X-Amz-Signature|token|sig)=/i;
  for (const o of ALL_OPS) it(`${o.mod}:${o.id}`, async () => {
    const { tx } = spyTx();
    const { result, error } = await run(o, await ctxFor(TENANT_A, tx));
    expect(safeJson({ b: result?.body, h: result?.headers, e: error?.detail })).not.toMatch(STORAGE_URL);
  });
});
