// H80-T04 — inline chromatogram attachment through the ingest pipeline (CR-C7-015; LD-139; 08-ADDENDUM-TRUTH-H80E §3 "Chromatogram", §8, §10; 02-TRD §6.8 step 2; 07-SECURITY AB8, REQ-SEC-083..085).
// Synthetic data only. Written BEFORE the implementation (tests-first): they must fail now because ingest ignores `ParsedRecord.inlineAttachment`.
//
// SEAMS the spec leaves open — the writer must match them or raise a dispute (tester notes: .orchestra/notes/H80-T04-tests.md):
//  S1  record shape: a record with recordKind 'attachment' AND inlineAttachment { mimeType, base64 } is the trigger. Anything else (inline on a quantitative record, bad base64) never reaches ctx.uploads.accept.
//  S2  accept() call: file { filename: '<x>.jpg|.jpeg|.png' (no path), mimeType, bytes: decoded base64 }, opts { allow ⊆ [image/jpeg, image/png] containing the mime, maxBytes ≤ the ingest message cap (deps.maxMessageBytes),
//      bucket 'instruments-attachments', objectPath '<tenant_id>/…', images { reencode: true, stripMetadata: true }, scan: 'required' } — exactly as §6.8 step 2 (the file_drop path).
//  S3  event: the EXISTING instruments.result.received.v1 only; payload.record_kind 'attachment', payload.attachment { bucket, object_path, sha256, mime_type } taken from the AcceptedUpload (the STORED object's sha256).
//      Published only for a live instrument, a barcode and scanState 'clean' (fail closed). Shadow -> emit_status 'shadow'; no barcode -> 'skipped_no_barcode'; no event in either case.
//  S4  rejection: the message stays 'accepted' (a retry can never succeed); the attachment record row gets emit_status 'skipped_invalid' (or 'quarantined_attachment' for an infected hit), NO event,
//      and row.warnings contains the existing core error code verbatim: common.unsupported_media_type (wrong/disallowed/mismatched mime), common.payload_too_large (over the cap),
//      common.upload_quarantined (infected). Nothing new is invented.
//  S5  scanner unavailable (accept returns scanState 'unavailable'): fail closed — never an attachment event (result 'retry' or an unemitted record are both fine).
//  S6  NOT covered here: the driver filling inlineAttachment from OBX-5 (drivers/truth_h80e is outside T04's file list; its golden expected.json has no inlineAttachment). The golden test below wraps the REAL driver and adds it.
//  S7  KNOWN GAP the writer must surface (dispute/CR, not silently drop `images`): core createUploads re-encodes PNG only; with images.reencode a JPEG ends in common.upload_quarantined. The JPEG cases here use a spy for accept().
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createUploads } from '../../../core/uploads/index.js';
import { truthH80e } from '../drivers/truth_h80e/index.js';
import type { InstrumentDriver, ParsedRecord } from '../drivers/types.js';
import { createIngestService } from '../service/ingest.service.js';
import { BUCKET, GPS, makeScanner, makeStorage, pdfBytes, pngBytes, sha } from './attachments.helpers.js';
import { AGENT_A1, INS, MiB, TENANT_A, batch, fakeDriver, makeIngestCtx, makeWorld, message, rec1, type Row, type World } from './ingest.helpers.js';
import { insRow } from './instruments.helpers.js';

const RESULT = 'instruments.result.received.v1';
const BARCODE = 'E2600000042';
const GOLDEN = readFileSync(new URL('../drivers/truth_h80e/testdata/oru-chromatogram.raw', import.meta.url));
const LIVE = INS(2), SHADOW = INS(6);
const world = () => makeWorld({ instruments: [
  insRow(2, { state: 'live', agent_id: AGENT_A1, protocol: 'hl7v2', driver_code: 'truth_h80e' }),
  insRow(6, { state: 'commissioning', agent_id: AGENT_A1, protocol: 'hl7v2', driver_code: 'truth_h80e' })] });

// ---- the golden: REAL driver + the one thing T04 adds on the driver side (S6): OBX-5 of the ED segment becomes inlineAttachment
const edBase64 = (raw: Uint8Array) => Buffer.from(raw).toString('latin1').split(/\r\n|\r|\n/).find((l) => l.startsWith('OBX|') && l.split('|')[2] === 'ED')!.split('|')[5]!;
const goldenDriver: InstrumentDriver = { ...truthH80e, parse(raw, ctx) {
  const r = truthH80e.parse(raw, ctx); if (!r.ok) return r;
  const base64 = edBase64(raw);
  return { ...r, records: r.records.map((x): ParsedRecord => (x.recordKind === 'attachment' ? { ...x, inlineAttachment: { mimeType: 'image/jpeg', base64 } } : x)) };
} };

// ---- accept() doubles
type Call = { file: { filename: string; mimeType: string; bytes: Uint8Array }; opts: Row };
function spyUploads(o: { scanState?: string; throws?: unknown } = {}) {
  const calls: Call[] = []; const STORED = Buffer.from('stored-after-reencode');
  return { calls, STORED, accept: async (file: any, opts: any) => {
    calls.push({ file, opts }); if (o.throws) throw o.throws;
    return { objectId: 'o1', bucket: opts.bucket, objectPath: opts.objectPath, sha256: sha(STORED), byteSize: STORED.length, mime: file.mimeType, scanState: o.scanState ?? 'clean' };
  } };
}
function realUploads() {
  const storage = makeStorage(TENANT_A); const scanner = makeScanner(); const calls: Call[] = [];
  const core = createUploads({ files: { scan: scanner.scan }, storage: storage.adapter as any, module: 'instruments', tenantId: TENANT_A });
  return { storage, scanner, calls, accept: (file: any, opts: any) => { calls.push({ file, opts }); return core.accept(file, opts); } };
}

async function send(w: World, messages: Row[], o: { uploads?: unknown; driver?: InstrumentDriver; records?: ParsedRecord[]; maxMessageBytes?: number } = {}) {
  const c = makeIngestCtx(w); (c.ctx as any).uploads = o.uploads;
  const getDriver = o.driver ? () => o.driver : fakeDriver(o.records ?? []).getDriver;
  const svc = createIngestService({ repo: w.repo, getDriver, maxMessageBytes: o.maxMessageBytes ?? MiB } as any);
  const r = await svc.submitMessageBatch(c.ctx, { body: batch(messages) });
  return { c, res: r.body.results as Row[] };
}
const sendGolden = (w: World, uploads: unknown, o: { n?: number; instrument?: string; raw?: Buffer } = {}) =>
  send(w, [message({ n: o.n ?? 1, instrument: o.instrument ?? LIVE, protocol: 'hl7v2', raw: o.raw ?? GOLDEN })], { uploads, driver: goldenDriver });
const att = (o: Partial<ParsedRecord> = {}): ParsedRecord => rec1({ recordSeq: 1, recordKind: 'attachment', sampleBarcode: BARCODE, instrumentAnalyteCode: 'Chromatogram', instrumentResultTimeLocal: '2026-11-05T17:37:23',
  inlineAttachment: { mimeType: 'image/png', base64: pngBytes().toString('base64') }, ...o });
const sendRecord = (w: World, r: ParsedRecord, uploads: unknown, o: { instrument?: string; maxMessageBytes?: number } = {}) =>
  send(w, [message({ n: 1, instrument: o.instrument ?? LIVE, protocol: 'hl7v2' })], { uploads, records: [r], ...(o.maxMessageBytes ? { maxMessageBytes: o.maxMessageBytes } : {}) });
const attEvents = (w: World) => w.eventsOf(RESULT).filter((e) => e['payload']['record_kind'] === 'attachment');
const row = (w: World, seq = 1) => w.records.find((r) => r['record_seq'] === seq)!;

describe('CR-C7-015 type: ParsedRecord.inlineAttachment is optional { mimeType: image/jpeg | image/png, base64 }', () => {
  it('compiles for both mime types and may be omitted', () => {
    const a: ParsedRecord = rec1({ recordSeq: 1, inlineAttachment: { mimeType: 'image/jpeg', base64: 'AAAA' } });
    const b: ParsedRecord = rec1({ recordSeq: 2, inlineAttachment: { mimeType: 'image/png', base64: 'AAAA' } });
    const c: ParsedRecord = rec1({ recordSeq: 3 });
    expect([a.inlineAttachment?.mimeType, b.inlineAttachment?.mimeType, c.inlineAttachment]).toEqual(['image/jpeg', 'image/png', undefined]);
  });
});

describe('oru-chromatogram golden -> accept -> the existing result event (live instrument)', () => {
  it('sends the decoded picture through ctx.uploads.accept exactly as §6.8 step 2 (S2)', async () => {
    const w = world(); const u = spyUploads(); const { res } = await sendGolden(w, u);
    expect(res[0]).toMatchObject({ outcome: 'accepted' }); expect(u.calls).toHaveLength(1);
    const { file, opts } = u.calls[0]!;
    expect(file.mimeType).toBe('image/jpeg'); expect(Buffer.from(file.bytes).equals(Buffer.from(edBase64(GOLDEN), 'base64'))).toBe(true);
    expect(file.filename).toMatch(/^[^/\\]+\.(jpg|jpeg)$/i);
    expect(opts['allow']).toContain('image/jpeg'); for (const m of opts['allow']) expect(['image/jpeg', 'image/png']).toContain(m);
    expect(opts['bucket']).toBe(BUCKET); expect(opts['objectPath']).toMatch(new RegExp(`^${TENANT_A}/.+\\.(jpg|jpeg)$`));
    expect(opts['images']).toEqual({ reencode: true, stripMetadata: true }); expect(opts['scan']).toBe('required');
    expect(Number.isInteger(opts['maxBytes']) && opts['maxBytes'] > 0 && opts['maxBytes'] <= MiB).toBe(true);
  });

  it('publishes the EXISTING result event with record_kind attachment + attachment {bucket, object_path, sha256 of the STORED object, mime_type}; no other event type (S3)', async () => {
    const w = world(); const u = spyUploads(); await sendGolden(w, u);
    expect([...new Set(w.events.map((e) => e['event_type']))]).toEqual([RESULT]);                 // no new event
    expect(w.eventsOf(RESULT)).toHaveLength(2);                                                    // HbA1c value + chromatogram
    const [e] = attEvents(w); expect(e).toBeDefined();
    expect(e!['payload']).toMatchObject({ record_kind: 'attachment', protocol: 'hl7v2', sample_barcode: BARCODE, instrument_analyte_code: 'Chromatogram', instrument_id: LIVE, agent_id: AGENT_A1,
      attachment: { bucket: BUCKET, object_path: u.calls[0]!.opts['objectPath'], sha256: sha(u.STORED), mime_type: 'image/jpeg' } });
    expect(Object.keys(e!['payload']['attachment']).sort()).toEqual(['bucket', 'mime_type', 'object_path', 'sha256']);
    expect(e!['aggregate']).toMatchObject({ type: 'instrument_message', id: w.messages[0]!['id'] });
    expect(e!['idempotency_key']).toMatch(new RegExp(`^${LIVE}:${BARCODE}:Chromatogram:`));
  });

  it('the numeric HbA1c record is unaffected and carries no attachment field', async () => {
    const w = world(); await sendGolden(w, spyUploads());
    const num = w.eventsOf(RESULT).find((e) => e['payload']['record_kind'] === 'quantitative')!;
    expect(num['payload']).toMatchObject({ instrument_analyte_code: 'HbA1c_NGSP', value_raw: '5.63' }); expect(num['payload']['attachment']).toBeUndefined();
  });

  it('records: attachment row emitted with its event id, run counts both events', async () => {
    const w = world(); await sendGolden(w, spyUploads());
    const r = row(w, 2); expect(r).toMatchObject({ record_kind: 'attachment', instrument_analyte_code: 'Chromatogram', sample_barcode: BARCODE, emit_status: 'emitted' });
    expect(r['event_id']).toBe(attEvents(w)[0]!['event_id']); expect(w.runs[0]).toMatchObject({ emitted_events: 2, outcome: 'parsed' });
  });

  it('PHI / bytes never reach logs, metrics, event payloads or persisted record rows (02-CV §9.2)', async () => {
    const w = world(); const { c } = await sendGolden(w, spyUploads()); const b64 = edBase64(GOLDEN);
    expect(c.logText()).not.toContain(b64); expect(c.logText()).not.toContain(BARCODE);
    expect(JSON.stringify(w.events)).not.toContain(b64); expect(JSON.stringify(w.records)).not.toContain(b64);
  });

  it('the same message again is a duplicate: accept() is NOT called a second time, no second event', async () => {
    const w = world(); const u = spyUploads(); await sendGolden(w, u);
    const { res } = await sendGolden(w, u, { n: 2 });
    expect(res[0]).toMatchObject({ outcome: 'duplicate' }); expect(u.calls).toHaveLength(1); expect(w.eventsOf(RESULT)).toHaveLength(2);
  });

  it('a new message (new MSH-10) for the same barcode/code/time: the event key de-duplicates -> duplicate_event on both records, no new events', async () => {
    const w = world(); const u = spyUploads(); await sendGolden(w, u);
    const raw2 = Buffer.from(GOLDEN.toString('latin1').replace('|ORU^R01|2|P|', '|ORU^R01|3|P|'), 'latin1'); expect(raw2.equals(GOLDEN)).toBe(false);
    const { res } = await sendGolden(w, u, { n: 2, raw: raw2 });
    expect(res[0]).toMatchObject({ outcome: 'accepted' }); expect(w.eventsOf(RESULT)).toHaveLength(2);
    const second = w.records.filter((r) => r['message_id'] === w.messages[1]!['id']); expect(second.map((r) => r['emit_status'])).toEqual(['duplicate_event', 'duplicate_event']);
  });

  it('commissioning (shadow) instrument: no event, record is shadow, message accepted', async () => {
    const w = world(); const { res } = await sendGolden(w, spyUploads(), { instrument: SHADOW });
    expect(res[0]).toMatchObject({ outcome: 'accepted' }); expect(w.events).toEqual([]); expect(row(w, 2)['emit_status']).toBe('shadow');
  });
});

describe('who gets uploaded (S1)', () => {
  it('attachment record without a barcode: skipped_no_barcode, no event', async () => {
    const w = world(); const { res } = await sendRecord(w, att({ sampleBarcode: undefined }), spyUploads());
    expect(res[0]).toMatchObject({ outcome: 'accepted' }); expect(w.events).toEqual([]); expect(row(w)['emit_status']).toBe('skipped_no_barcode');
  });
  it('inlineAttachment on a non-attachment record is ignored: accept() not called, normal event without an attachment field', async () => {
    const w = world(); const u = spyUploads();
    await sendRecord(w, rec1({ recordSeq: 1, recordKind: 'quantitative', sampleBarcode: BARCODE, instrumentAnalyteCode: 'HbA1c_NGSP', valueRaw: '5.63', inlineAttachment: { mimeType: 'image/png', base64: pngBytes().toString('base64') } }), u);
    expect(u.calls).toEqual([]); expect(w.eventsOf(RESULT)).toHaveLength(1); expect(w.eventsOf(RESULT)[0]!['payload']['attachment']).toBeUndefined();
  });
  it.each([['empty', ''], ['not base64', '!!not*base64!!'], ['length not a multiple of 4', 'abc'], ['whitespace inside', 'AAAA AAAA']])(
    'bad base64 (%s): record skipped_invalid, accept() not called, no event, message accepted', async (_n, base64) => {
      const w = world(); const u = spyUploads(); const { res } = await sendRecord(w, att({ inlineAttachment: { mimeType: 'image/png', base64 } }), u);
      expect(res[0]).toMatchObject({ outcome: 'accepted' }); expect(u.calls).toEqual([]); expect(w.events).toEqual([]); expect(row(w)['emit_status']).toBe('skipped_invalid');
    });
});

describe('real core uploads (PNG: the only type core can re-encode today, S7) — security: metadata stripped, stored hash, tenant path', () => {
  it('stores the re-encoded object without the planted GPS/EXIF metadata; the event hash is the STORED object hash; path is under the tenant', async () => {
    const w = world(); const u = realUploads();
    const { res } = await sendRecord(w, att({ inlineAttachment: { mimeType: 'image/png', base64: pngBytes({ meta: true }).toString('base64') } }), u);
    expect(res[0]).toMatchObject({ outcome: 'accepted' }); expect(u.storage.paths()).toHaveLength(1);
    const path = u.storage.paths()[0]!; const stored = u.storage.get(path)!;
    expect(path.startsWith(`${TENANT_A}/`)).toBe(true); expect(stored.includes(Buffer.from(GPS))).toBe(false);
    const [e] = attEvents(w); expect(e!['payload']['attachment']).toEqual({ bucket: BUCKET, object_path: path, sha256: sha(stored), mime_type: 'image/png' });
    expect(row(w)).toMatchObject({ emit_status: 'emitted' });
  });
});

describe('rejections use the existing core error codes (S4) — real core uploads, no event, message accepted', () => {
  const bad = (w: World, code: string, status = 'skipped_invalid') => {
    expect(w.events).toEqual([]); expect(row(w)['emit_status']).toBe(status); expect(row(w)['warnings']).toContain(code);
  };
  it.each([
    ['image/gif', Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1')],
    ['application/pdf', pdfBytes()],
    ['text/plain', Buffer.from('hello')],
    ['image/jpeg declared, PNG bytes (mismatch)', pngBytes()],
  ])('wrong mime type (%s) -> common.unsupported_media_type', async (mime, bytes) => {
    const w = world(); const u = realUploads();
    const declared = mime.startsWith('image/jpeg') ? 'image/jpeg' : mime;
    const { res } = await sendRecord(w, att({ inlineAttachment: { mimeType: declared as any, base64: bytes.toString('base64') } }), u);
    expect(res[0]).toMatchObject({ outcome: 'accepted' }); bad(w, 'common.unsupported_media_type'); expect(u.storage.paths()).toEqual([]);
  });
  it('oversize (decoded > the ingest cap of 1 MiB) -> common.payload_too_large; nothing stored', async () => {
    const w = world(); const u = realUploads(); const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(MiB)]);
    const { res } = await sendRecord(w, att({ inlineAttachment: { mimeType: 'image/jpeg', base64: big.toString('base64') } }), u, { maxMessageBytes: MiB });
    expect(res[0]).toMatchObject({ outcome: 'accepted' }); bad(w, 'common.payload_too_large'); expect(u.storage.paths()).toEqual([]);
  });
  it('infected picture -> common.upload_quarantined, record quarantined_attachment, nothing stored, no event', async () => {
    const w = world(); const u = realUploads(); u.scanner.mode = 'infected';
    const { res } = await sendRecord(w, att(), u);
    expect(res[0]).toMatchObject({ outcome: 'accepted' }); bad(w, 'common.upload_quarantined', 'quarantined_attachment'); expect(u.storage.paths()).toEqual([]);
  });
  it.each(['unavailable', 'throw'] as const)('scanner %s: fail closed — never an attachment event (S5)', async (mode) => {
    const w = world(); const u = realUploads(); u.scanner.mode = mode;
    await sendRecord(w, att(), u);
    expect(attEvents(w)).toEqual([]);
  });
  it('accept() throwing an unexpected error is a retry (savepoint rolled back), never a silent drop or a 5xx for the batch', async () => {
    const w = world(); const u = spyUploads({ throws: new Error('storage down') });
    const { res } = await sendRecord(w, att(), u);
    expect(res[0]).toMatchObject({ outcome: 'retry', error_code: 'common.internal' }); expect(w.events).toEqual([]); expect(w.messages).toEqual([]);
  });
});
