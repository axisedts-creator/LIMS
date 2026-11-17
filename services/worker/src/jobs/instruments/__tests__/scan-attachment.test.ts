// C7 API-T11 worker — `instruments.scan_attachment` (02-TRD §6.8 step 3, §10; AC-12.4 (scan half); 07-SECURITY AB8, S-11, REQ-SEC-083..085; 08 R12b). Seams: scan-attachment.helpers.ts header.
// DB = in-memory ScanRepo; storage/scanner = fakes (storage enforces the REAL core bucket-owner + tenant-path rules); events = the REAL core createEvents (envelope + payload are schema-validated).
import { describe, expect, it } from 'vitest';
import { setup } from '../../../core/__tests__/helpers.js';
import { manifest } from '../index.js';
import { createScanAttachment } from '../scanAttachment.js';
import { ATT, BARCODE, BUCKET, CENTRE, EICAR, GPS, INSTR, MSG, REC, RUN1, T_A, T_B, AGENT, failure, finalPath, makeCtx, makeScanner, makeStorage, makeWorld, payload, pdfBytes, pngBytes, quarantinePath, sha, uid, type World } from './scan-attachment.helpers.js';

const EVENT = 'instruments.result.received.v1';
const METRIC = 'lims_instruments_attachment_scans_total';
const URLISH = /https?:\/\/|:\/\/|token=|SECRET-URL-SENTINEL/i;
const go = (w: World, c: ReturnType<typeof makeCtx>, p: Record<string, unknown> = payload()) => createScanAttachment({ repo: w.repo })(p as any, c.ctx);
const newRecord = (w: World) => w.records.find((r) => r['id'] !== REC)!;
const newRun = (w: World) => w.runs.find((r) => r['kind'] === 'attachment_scan')!;
const quietly = (p: Promise<unknown>) => p.catch(() => undefined);

describe('registration (TRD §10)', () => {
  it('the manifest declares instruments.scan_attachment: per-tenant task, 5 attempts, enqueued by E06 (not cron-driven)', async () => {
    expect(Object.keys(manifest.tasks ?? {})).toContain('instruments.scan_attachment');
    expect((manifest.crontab ?? []).some((c) => c.identifier === 'instruments.scan_attachment')).toBe(false);
    const s = await setup([manifest]); expect(s.entry('instruments.scan_attachment')).toMatchObject({ module: 'instruments', scope: 'per_tenant', maxAttempts: 5 });
  });
});

describe('clean attachment on a live instrument (AC-12.4; TRD §6.8 step 3)', () => {
  const clean = async (seed: Parameters<typeof makeWorld>[0] = {}) => { const w = makeWorld(seed); const c = makeCtx(w); await go(w, c); return { w, c }; };
  it('scans the STORED object once, moves it to {tenant}/{yyyy}/{mm}/{attachment_id}.{ext} (quarantine copy gone), marks the attachment clean with the final path and the stored sha256', async () => {
    const { w, c } = await clean();
    expect(c.scanner.calls).toBe(1); expect(c.scanner.last!.equals(w.bytes)).toBe(true);
    expect(c.storage.has(finalPath())).toBe(true); expect(c.storage.has(quarantinePath())).toBe(false); expect(c.storage.objects.size).toBe(1); expect(c.storage.get(finalPath())!.equals(w.bytes)).toBe(true);
    expect(w.att()).toMatchObject({ scan_state: 'clean', object_path: finalPath(), sha256: sha(c.storage.get(finalPath())!), bucket: BUCKET });
    expect(w.att()['scan_attempts']).toBeGreaterThanOrEqual(1);
  });
  it('appends run kind attachment_scan / outcome parsed (run_no = next) and inserts ONE NEW message_records row (a copy, emit_status emitted + event_id); the original row and run are untouched (append-only, review #21)', async () => {
    const { w } = await clean();
    expect(w.runs).toHaveLength(2); expect(w.runs[0]).toMatchObject({ id: RUN1, kind: 'live', outcome: 'parsed', run_no: 1 });
    expect(newRun(w)).toMatchObject({ kind: 'attachment_scan', outcome: 'parsed', run_no: 2, message_id: MSG, actor_type: 'system' });
    expect(w.records).toHaveLength(2); expect(w.records[0]).toMatchObject({ id: REC, emit_status: 'pending_scan', event_id: null, run_id: RUN1 });
    expect(newRecord(w)).toMatchObject({ message_id: MSG, run_id: newRun(w)['id'], source_record_id: REC, record_kind: 'attachment', sample_barcode: BARCODE, instrument_analyte_code: 'HISTO-IMG', instrument_id: INSTR, centre_id: CENTRE, emit_status: 'emitted', event_id: w.events[0]!['event_id'] });
  });
  it('run_no continues after earlier runs (reprocess history): 1 live + 2 reprocess -> the scan run is 4', async () => {
    const { w } = await clean({ priorRuns: 2 }); expect(newRun(w)['run_no']).toBe(4);
  });
  it('publishes exactly ONE instruments.result.received.v1: record_kind attachment, protocol file_drop, attachment {bucket, object_path (final), sha256 (stored object), mime_type}; aggregate instrument_message/<message id>', async () => {
    const { w, c } = await clean();
    expect(w.eventsOf(EVENT)).toHaveLength(1); expect(w.events).toHaveLength(1);
    const e = w.events[0]!;
    expect(e['aggregate']).toMatchObject({ type: 'instrument_message', id: MSG }); expect(e['tenant_id']).toBe(T_A); expect(e['producer']).toBe('instruments');
    expect(e['payload']).toMatchObject({ instrument_message_id: MSG, instrument_id: INSTR, agent_id: AGENT, centre_id: CENTRE, protocol: 'file_drop', sample_barcode: BARCODE, record_kind: 'attachment', instrument_analyte_code: 'HISTO-IMG',
      received_at: '2026-11-07T12:00:00.000Z', attachment: { bucket: BUCKET, object_path: finalPath(), sha256: sha(c.storage.get(finalPath())!), mime_type: 'application/pdf' } });
    expect((e['payload'].attachment.object_path as string).split('/')[0]).toBe(T_A);               // tenant is the first path segment (C5 rejects otherwise)
  });
  it('counts the scan: lims_instruments_attachment_scans_total{outcome="clean"} once', async () => {
    const { c } = await clean(); expect(c.metricCalls.filter((m) => m.name === METRIC)).toEqual([expect.objectContaining({ labels: { outcome: 'clean' } })]);
  });
  it('no Storage URL anywhere: event, rows, logs, metrics; ctx.storage.signedUrl never used', async () => {
    const { w, c } = await clean();
    expect(JSON.stringify(w.events)).not.toMatch(URLISH); expect(JSON.stringify([w.attachments, w.records, w.runs])).not.toMatch(URLISH); expect(c.logText()).not.toMatch(URLISH); expect(c.storage.callsOf('signedUrl')).toEqual([]);
  });
  it('log lines and metric labels hold no barcode, file name or file content (PHI)', async () => {
    const { c } = await clean(); expect(c.logText()).not.toContain(BARCODE); expect(c.logText()).not.toContain('slide-0042'); expect(c.logText()).not.toContain('synthetic histology');
  });
  it('PNG: stored under .png, sha256 of the stored bytes is what the event carries', async () => {
    const png = pngBytes(); const { w, c } = await clean({ bytes: png, ext: 'png', mime: 'image/png' });
    expect(c.storage.has(finalPath(T_A, ATT, 'png'))).toBe(true); expect(w.events[0]!['payload'].attachment).toMatchObject({ mime_type: 'image/png', object_path: finalPath(T_A, ATT, 'png'), sha256: sha(c.storage.get(finalPath(T_A, ATT, 'png'))!) });
    expect(c.storage.get(finalPath(T_A, ATT, 'png'))!.includes(GPS)).toBe(false);
  });
});

describe('emit gating (live + barcode only; mirrors TRD §6.5)', () => {
  it('commissioning instrument: attachment becomes clean, record row is `shadow`, NO event', async () => {
    const w = makeWorld({ instrumentState: 'commissioning' }); const c = makeCtx(w); await go(w, c);
    expect(w.att()['scan_state']).toBe('clean'); expect(newRecord(w)['emit_status']).toBe('shadow'); expect(w.events).toEqual([]); expect(newRecord(w)['event_id'] ?? null).toBeNull();
  });
  it('no barcode: clean, record row `skipped_no_barcode`, NO event', async () => {
    const w = makeWorld({ barcode: null }); const c = makeCtx(w); await go(w, c);
    expect(w.att()['scan_state']).toBe('clean'); expect(newRecord(w)['emit_status']).toBe('skipped_no_barcode'); expect(w.events).toEqual([]);
  });
  it('the same result key already emitted (e.g. a re-dropped file with a new capture): record row `duplicate_event` pointing at the earlier event, no second event', async () => {
    const w = makeWorld(); const c = makeCtx(w); const prior = uid(0xee01);
    w.events.push({ event_id: prior, tenant_id: T_A, event_type: EVENT, idempotency_key: `${INSTR}:${BARCODE}:HISTO-IMG:none` });
    await go(w, c); expect(newRecord(w)).toMatchObject({ emit_status: 'duplicate_event', event_id: prior }); expect(w.events).toHaveLength(1); expect(w.att()['scan_state']).toBe('clean');
  });
});

describe('EICAR / scan hit (AC-12.4 "Given a scan hit"; AB8; S-11)', () => {
  const hit = async (seed: Parameters<typeof makeWorld>[0] = {}) => { const bytes = pdfBytes(EICAR); const w = makeWorld({ bytes, ...seed }); const c = makeCtx(w); await go(w, c); return { w, c }; };
  it('attachment -> quarantined; the infected object is NEVER written to the final path; NO event', async () => {
    const { w, c } = await hit();
    expect(c.scanner.calls).toBe(1); expect(w.att()['scan_state']).toBe('quarantined'); expect(w.att()['object_path']).not.toBe(finalPath());
    expect(c.storage.has(finalPath())).toBe(false); expect(c.storage.calls.filter((x) => (x.op === 'move' || x.op === 'put') && x.path.includes(finalPath()))).toEqual([]);
    expect(w.events).toEqual([]);
  });
  it('appends run attachment_scan / outcome quarantined and a NEW record row `quarantined_attachment` (no event_id); the original row is untouched', async () => {
    const { w } = await hit(); expect(newRun(w)).toMatchObject({ kind: 'attachment_scan', outcome: 'quarantined', run_no: 2, message_id: MSG });
    expect(newRecord(w)).toMatchObject({ emit_status: 'quarantined_attachment', source_record_id: REC, run_id: newRun(w)['id'] }); expect(newRecord(w)['event_id'] ?? null).toBeNull(); expect(w.records[0]).toMatchObject({ id: REC, emit_status: 'pending_scan' });
  });
  it('raises the security signal: lims_instruments_attachment_scans_total{outcome="quarantined"} (drives InstrumentsAttachmentQuarantined) and a warn/error log WITHOUT the file, file name or barcode', async () => {
    const { c } = await hit(); expect(c.metricCalls.filter((m) => m.name === METRIC)).toEqual([expect.objectContaining({ labels: { outcome: 'quarantined' } })]);
    expect(c.lines.some((l) => /"level":"(warn|error)"/.test(l))).toBe(true); expect(c.logText()).not.toContain('EICAR-STANDARD'); expect(c.logText()).not.toContain(BARCODE); expect(c.logText()).not.toContain('slide-0042');
  });
  it('quarantine holds on a commissioning instrument too (a hit is never "shadow")', async () => {
    const { w } = await hit({ instrumentState: 'commissioning' }); expect(w.att()['scan_state']).toBe('quarantined'); expect(newRecord(w)['emit_status']).toBe('quarantined_attachment');
  });
  it('a quarantined attachment is final: a redelivered job does not rescan, flip it to clean or emit anything', async () => {
    const { w, c } = await hit(); const before = JSON.stringify([w.attachments, w.runs, w.records]);
    await go(w, c); expect(c.scanner.calls).toBe(1); expect(JSON.stringify([w.attachments, w.runs, w.records])).toBe(before); expect(w.events).toEqual([]);
  });
});

describe('scanner unavailable — fail closed, retry 5 times, then failed (TRD §6.8)', () => {
  it.each(['unavailable', 'throw'] as const)('scanner %s on attempt 1/5: the job throws (graphile retries); attachment stays pending; nothing moved, no run/record/event', async (mode) => {
    const w = makeWorld(); const sc = makeScanner(); sc.mode = mode; const c = makeCtx(w, { scanner: sc, attempt: 1, maxAttempts: 5 });
    await failure(go(w, c)); expect(w.att()['scan_state']).toBe('pending'); expect(c.storage.has(quarantinePath())).toBe(true); expect(c.storage.has(finalPath())).toBe(false);
    expect(w.runs).toHaveLength(1); expect(w.records).toHaveLength(1); expect(w.events).toEqual([]);
  });
  it('on the LAST attempt (5/5) the attachment becomes `failed` (never clean): no event, nothing at the final path, metric outcome failed', async () => {
    const w = makeWorld(); const sc = makeScanner(); sc.mode = 'unavailable'; const c = makeCtx(w, { scanner: sc, attempt: 5, maxAttempts: 5 });
    await quietly(go(w, c)); expect(w.att()['scan_state']).toBe('failed'); expect(c.storage.has(finalPath())).toBe(false); expect(w.events).toEqual([]);
    expect(c.metricCalls.filter((m) => m.name === METRIC).map((m) => m.labels['outcome'])).toEqual(['failed']);
  });
  it('a `failed` attachment is not downloadable and emits nothing: it never reached clean (state stays failed, record stays pending_scan)', async () => {
    const w = makeWorld(); const sc = makeScanner(); sc.mode = 'throw'; const c = makeCtx(w, { scanner: sc, attempt: 5, maxAttempts: 5 }); await quietly(go(w, c));
    expect(w.att()['scan_state']).not.toBe('clean'); expect(w.records.every((r) => r['emit_status'] !== 'emitted')).toBe(true);
  });
});

describe('idempotence, tenancy and bad input (S-08; path tenant check)', () => {
  it('a redelivered job for an already-clean attachment is a no-op: one event, one scan run, two records, one object', async () => {
    const w = makeWorld(); const c = makeCtx(w); await go(w, c); await go(w, c);
    expect(w.eventsOf(EVENT)).toHaveLength(1); expect(w.runs.filter((r) => r['kind'] === 'attachment_scan')).toHaveLength(1); expect(w.records).toHaveLength(2); expect(c.storage.objects.size).toBe(1); expect(c.scanner.calls).toBe(1);
  });
  it('an attachment of ANOTHER tenant is invisible: no storage access, no scan, no event; every repo call carries the context tenant', async () => {
    const w = makeWorld({ tenant: T_B }); const c = makeCtx(w, { tenantId: T_A, seedObject: false }); await quietly(go(w, c, payload({ tenant_id: T_A })));
    expect(c.storage.calls).toEqual([]); expect(c.scanner.calls).toBe(0); expect(w.events).toEqual([]); expect(w.att()['scan_state']).toBe('pending'); expect(w.calls.every((x) => x.tenantId === T_A)).toBe(true);
  });
  it('payload.tenant_id differing from the job tenant is refused: nothing read, scanned or written', async () => {
    const w = makeWorld(); const c = makeCtx(w); await quietly(go(w, c, payload({ tenant_id: T_B })));
    expect(c.scanner.calls).toBe(0); expect(c.storage.callsOf('read')).toEqual([]); expect(w.att()['scan_state']).toBe('pending'); expect(w.events).toEqual([]);
  });
  it.each([['missing attachment_id', { attachment_id: undefined }], ['non-uuid attachment_id', { attachment_id: 'not-a-uuid' }], ['SQL-ish attachment_id', { attachment_id: `${ATT}'; DROP TABLE instruments.attachments;--` }]])('bad payload (%s): no repo call, no scan, no write', async (_n, over) => {
    const w = makeWorld(); const c = makeCtx(w); await quietly(go(w, c, payload(over)));
    expect(w.calls).toEqual([]); expect(c.scanner.calls).toBe(0); expect(c.storage.calls).toEqual([]);
  });
  it.each([
    ['another tenant\'s first segment', `${T_B}/q/2026/11/${ATT}.pdf`],
    ['path traversal', `${T_A}/../${T_B}/q/${ATT}.pdf`],
    ['no tenant segment', `q/2026/11/${ATT}.pdf`],
  ])('corrupt object_path (%s): never read, never scanned, never marked clean, nothing emitted', async (_n, path) => {
    const w = makeWorld({ attachment: { object_path: path } }); const c = makeCtx(w, { seedObject: false }); c.storage.seed(path, Buffer.from('FOREIGN-TENANT-BYTES'));
    await quietly(go(w, c)); expect(c.storage.callsOf('read')).toEqual([]); expect(c.scanner.calls).toBe(0); expect(w.att()['scan_state']).not.toBe('clean'); expect(w.events).toEqual([]); expect(c.logText()).not.toContain('FOREIGN-TENANT-BYTES');
  });
  it('a scan that finds the quarantine object missing fails (retry), it does not mark clean or emit', async () => {
    const w = makeWorld(); const c = makeCtx(w, { seedObject: false }); await quietly(go(w, c));
    expect(w.att()['scan_state']).not.toBe('clean'); expect(w.events).toEqual([]); expect(w.records).toHaveLength(1);
  });
});
