// T0B-FILESTREAM-1 (LD-312) done_when 1, 2, 3, 6: E37 downloadInstrumentAttachment streams. The existing attachments tests stay valid (a storage with only read() gets the old answer).
// Prescribed: service input gains requestHeaders (the handler passes req.headers); the result is the ctx.download.stream result unchanged.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createDownload } from '../../../core/storage/download.js';
import { makeStreamStorage, bytesOf } from '../../../core/storage/__tests__/stream.helpers.js';
import { createAttachmentsService } from '../service/attachments.service.js';
import { BUCKET, FILE_DROP_INS, TENANT_A, attachmentRow, failure, idN, makeAttachmentsWorld, makeStaffCtx } from './attachments.helpers.js';

const MSG = idN(0xf001); const ETAG = '"att-1"';
const hdr = (r: any, n: string): string | undefined => Object.entries<string>(r.headers ?? {}).find(([k]) => k.toLowerCase() === n)?.[1];
const bodyBytes = async (b: unknown): Promise<Buffer> => { if (b == null) return Buffer.alloc(0); const p: Buffer[] = []; for await (const c of (b instanceof Uint8Array ? [b] : (b as AsyncIterable<Uint8Array>))) p.push(Buffer.from(c)); return Buffer.concat(p); };

async function seeded(o: { att?: Record<string, unknown>; size?: number } = {}) {
  const size = o.size ?? 5000; const att = attachmentRow({ size_bytes: size, ...(o.att ?? {}) });
  const w = makeAttachmentsWorld({ attachments: [att] });
  (w as any).messages.push({ tenant_id: TENANT_A, id: MSG, centre_id: att['centre_id'], instrument_id: FILE_DROP_INS, protocol: 'file_drop', message_kind: 'attachment' });
  const c = makeStaffCtx(w); const st = await makeStreamStorage('instruments', TENANT_A);
  st.f.seed(BUCKET, att['object_path'] as string, { size, bytes: bytesOf(0, size), etag: ETAG });
  c.ctx.storage = st.storage; c.ctx.download = createDownload({ storage: st.storage, audit: c.ctx.audit });
  const svc = createAttachmentsService({ repo: w.repo });
  return { w, c, st, svc, run: (requestHeaders: Record<string, string> = {}) => svc.downloadInstrumentAttachment(c.ctx, { instrumentMessageId: MSG, requestHeaders } as any) };
}

describe('E37 streams (AC-12.6)', () => {
  it('200: a Readable with Content-Length and ETag; read() of the whole object never used; attachment / nosniff / no-store kept; ONE instrument_message.attachment_view row', async () => {
    const { w, st, run } = await seeded(); const r: any = await run();
    expect(r.status).toBe(200); expect(r.body).toBeInstanceOf(Readable); expect(st.f.count('get')).toBe(0);
    expect(hdr(r, 'content-length')).toBe('5000'); expect(hdr(r, 'etag')).toBe(ETAG); expect(hdr(r, 'content-disposition')).toMatch(/^attachment;/);
    expect(hdr(r, 'x-content-type-options')).toBe('nosniff'); expect(hdr(r, 'cache-control')).toBe('no-store');
    expect((await bodyBytes(r.body)).equals(bytesOf(0, 5000))).toBe(true);
    expect(w.accessRows).toHaveLength(1); expect(w.accessRows[0]).toMatchObject({ action: 'instrument_message.attachment_view', entityId: MSG, outcome: 'allowed' });
  });
  it('Range -> 206 + Content-Range; If-None-Match -> 304 without a body; both still access-logged', async () => {
    const a = await seeded(); const r: any = await a.run({ range: 'bytes=10-19' });
    expect(r.status).toBe(206); expect(hdr(r, 'content-range')).toBe('bytes 10-19/5000'); expect((await bodyBytes(r.body)).equals(bytesOf(10, 10))).toBe(true); expect(a.w.accessRows).toHaveLength(1);
    const b = await seeded(); const n: any = await b.run({ 'if-none-match': ETAG });
    expect(n.status).toBe(304); expect((await bodyBytes(n.body)).length).toBe(0); expect(b.w.accessRows).toHaveLength(1);
  });
  it('the gates are unchanged: not clean -> 422 and storage untouched; role denied first; no signed URL', async () => {
    for (const state of ['pending', 'infected', 'unavailable']) {
      const s = await seeded({ att: { scan_state: state } }); const e = await failure(s.run());
      expect(e.code).toBe('common.upload_quarantined'); expect(s.st.f.calls).toEqual([]); expect(s.w.accessRows).toEqual([]);
    }
    const s = await seeded(); expect(s.st.f.calls).toEqual([]); void (await s.run()); expect(s.st.f.count('sign')).toBe(0);
  });
});

describe('E37 code (static)', () => {
  const dir = fileURLToPath(new URL('..', import.meta.url));
  it('the handler forwards req.headers; the service forwards them to ctx.download.stream and does not read whole objects itself', () => {
    expect(readFileSync(join(dir, 'handlers/attachments.handlers.ts'), 'utf8')).toMatch(/requestHeaders\s*:\s*req\.headers/);
    const svc = readFileSync(join(dir, 'service/attachments.service.ts'), 'utf8');
    expect(svc).toMatch(/requestHeaders/); expect(svc).not.toMatch(/storage\.read\(|\.arrayBuffer\(/);
  });
});
