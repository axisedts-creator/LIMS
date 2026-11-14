// C7 API-T11 worker fixtures (not a test file). Synthetic data only. SEAMS the spec leaves open — the writer must match them or raise a dispute:
//   ../scanAttachment.ts   exports `createScanAttachment(deps?: { repo?: ScanRepo })` -> TaskHandler `(payload: { tenant_id, attachment_id }, ctx) => Promise<void>` and `scanAttachment = createScanAttachment()`
//                          (registered in ../index.ts as task `instruments.scan_attachment`, maxAttempts 5, not cron). Also exports the `ScanRepo` type (below) and `createScanRepo(): ScanRepo` (SQL on ctx.tx).
//                          Everything is read through `ctx.tx` / `ctx.storage` / `ctx.files.scan` / `ctx.events` / `ctx.metrics` / `ctx.now()` / `ctx.attempt` / `ctx.maxAttempts` (the worker JobContext).
//   ScanRepo               loadForScan(tx, tenantId, attachmentId) -> { attachment, instrument, message, record } | undefined
//                            attachment = `attachments` row; instrument = `instruments` row (state, centre_id, agent_id, ...); message = `messages` row (id, received_at, ...);
//                            record = the ORIGINAL message_records row of the capture (emit_status 'pending_scan', sample_barcode?, instrument_analyte_code, mapping_status, ...).
//                          setScanState(tx, tenantId, attachmentId, { scanState: 'clean'|'quarantined'|'failed', scanAttempts, actorId, objectPath?, sha256? })
//                          nextRunNo(tx, tenantId, messageId) -> number          insertRun(tx, tenantId, row) -> { id }      insertRecords(tx, tenantId, rows)   (same row shapes as the API T09 IngestRepo)
//   ctx                    { tenantId, actor:{type:'system',id}, requestId, tx, events (REAL core createEvents: every event is schema-validated), storage {read,put,move,delete}, files {scan(bytes)},
//                            log, metrics {inc(name, labels, by?)}, now(), attempt, maxAttempts }.   ctx.files.scan returns 'clean' | 'infected' | 'unavailable' (or throws).
import { createHash } from 'node:crypto';
import { createEvents } from '../../../../../api/src/core/events/publish.js';
import { assertBucket, assertOwned, assertTenantPath } from '../../../../../api/src/core/storage/index.js';
import { pdfBytes, pngBytes, EICAR, sha, GPS } from '../../../../../api/src/modules/instruments/__tests__/attachments.helpers.js';

export { pdfBytes, pngBytes, EICAR, sha, GPS };
export const NOW = '2026-11-07T12:00:30.000Z';
export const T_A = '0190a000-0000-7000-8000-00000000aaaa';
export const T_B = '0190a000-0000-7000-8000-00000000bbbb';
export const uid = (n: number) => `0190a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
export const CENTRE = uid(0xc001), AGENT = uid(0x1000), INSTR = uid(0x2009), MSG = uid(0xf001), ATT = uid(0xe001), REC = uid(0xd001), RUN1 = uid(0xd101), SYSTEM = uid(0xa008), REQ = uid(0xf0f1);
export const BARCODE = 'E2600000042';
export const BUCKET = 'instruments-attachments';
export type Row = Record<string, any>;
export const quarantinePath = (tenant = T_A, id = ATT, ext = 'pdf') => `${tenant}/q/2026/11/${id}.${ext}`;
export const finalPath = (tenant = T_A, id = ATT, ext = 'pdf') => `${tenant}/2026/11/${id}.${ext}`;

export interface ScanRepo {
  loadForScan(tx: any, tenantId: string, attachmentId: string): Promise<{ attachment: Row; instrument: Row; message: Row; record: Row } | undefined>;
  setScanState(tx: any, tenantId: string, attachmentId: string, o: { scanState: 'clean' | 'quarantined' | 'failed'; scanAttempts: number; actorId: string; objectPath?: string; sha256?: string }): Promise<void>;
  nextRunNo(tx: any, tenantId: string, messageId: string): Promise<number>;
  insertRun(tx: any, tenantId: string, row: Row): Promise<{ id: string }>;
  insertRecords(tx: any, tenantId: string, rows: Row[]): Promise<void>;
}

export interface Seed { instrumentState?: string; barcode?: string | null; bytes?: Buffer; ext?: string; mime?: string; attachment?: Row; tenant?: string; priorRuns?: number }
export function makeWorld(seed: Seed = {}) {
  const tenant = seed.tenant ?? T_A; const bytes = seed.bytes ?? pdfBytes(); const ext = seed.ext ?? 'pdf';
  const s = {
    attachments: [{ id: ATT, tenant_id: tenant, centre_id: CENTRE, message_id: MSG, instrument_id: INSTR, bucket: BUCKET, object_path: quarantinePath(tenant, ATT, ext), sha256: sha(bytes), mime_type: seed.mime ?? 'application/pdf',
      size_bytes: bytes.length, original_file_name: 'slide-0042.pdf', scan_state: 'pending', scan_attempts: 0, scanned_at: null, version: 1, ...(seed.attachment ?? {}) }] as Row[],
    instruments: [{ id: INSTR, tenant_id: tenant, centre_id: CENTRE, agent_id: AGENT, state: seed.instrumentState ?? 'live', protocol: 'file_drop', driver_code: 'file_drop_generic', file_drop: { enabled: true } }] as Row[],
    messages: [{ id: MSG, tenant_id: tenant, centre_id: CENTRE, instrument_id: INSTR, agent_id: AGENT, protocol: 'file_drop', message_kind: 'attachment', received_at: '2026-11-07T12:00:00.000Z' }] as Row[],
    records: [{ id: REC, tenant_id: tenant, centre_id: CENTRE, message_id: MSG, run_id: RUN1, instrument_id: INSTR, record_seq: 1, record_class: 'patient', record_kind: 'attachment', instrument_analyte_code: 'HISTO-IMG', mapping_status: 'unmapped',
      sample_barcode: seed.barcode === undefined ? BARCODE : seed.barcode, emit_status: 'pending_scan', event_id: null, instrument_flags: [], warnings: [] }] as Row[],
    runs: [{ id: RUN1, tenant_id: tenant, message_id: MSG, run_no: 1, kind: 'live', outcome: 'parsed' }, ...Array.from({ length: seed.priorRuns ?? 0 }, (_v, i) => ({ id: uid(0xd200 + i), tenant_id: tenant, message_id: MSG, run_no: i + 2, kind: 'reprocess', outcome: 'parsed' }))] as Row[],
    events: [] as Row[], jobs: [] as Row[], calls: [] as Array<{ op: string; tenantId: string }>,
  };
  const mine = (t: string, rows: Row[]) => rows.filter((r) => r['tenant_id'] === t);
  let n = 0; const id = () => uid(0xa000 + ++n);
  const rec = <T>(op: string, tenantId: string, fn: () => T): T => { s.calls.push({ op, tenantId }); return fn(); };
  const repo: ScanRepo = {
    async loadForScan(_tx, t, attId) {
      return rec('loadForScan', t, () => {
        const attachment = mine(t, s.attachments).find((a) => a['id'] === attId); if (!attachment) return undefined;
        const instrument = mine(t, s.instruments).find((i) => i['id'] === attachment['instrument_id']); const message = mine(t, s.messages).find((m) => m['id'] === attachment['message_id']);
        const record = mine(t, s.records).find((r) => r['message_id'] === attachment['message_id'] && r['emit_status'] === 'pending_scan'); if (!instrument || !message || !record) return undefined;
        return structuredClone({ attachment, instrument, message, record });
      });
    },
    async setScanState(_tx, t, attId, o) {
      return rec('setScanState', t, () => {
        const a = mine(t, s.attachments).find((x) => x['id'] === attId); if (!a) throw new Error('no such attachment');
        Object.assign(a, { scan_state: o.scanState, scan_attempts: o.scanAttempts, scanned_at: NOW, version: a['version'] + 1, ...(o.objectPath ? { object_path: o.objectPath } : {}), ...(o.sha256 ? { sha256: o.sha256 } : {}) });
      });
    },
    async nextRunNo(_tx, t, messageId) { return rec('nextRunNo', t, () => Math.max(0, ...mine(t, s.runs).filter((r) => r['message_id'] === messageId).map((r) => r['run_no'])) + 1); },
    async insertRun(_tx, t, row) { return rec('insertRun', t, () => { const r = { id: id(), tenant_id: t, ...structuredClone(row) }; s.runs.push(r); return { id: r['id'] }; }); },
    async insertRecords(_tx, t, rows) { return rec('insertRecords', t, () => { for (const r of rows) s.records.push({ id: id(), tenant_id: t, ...structuredClone(r) }); }); },
  };
  return Object.assign(s, { repo, tenant, bytes, ext, att: () => s.attachments[0]!, eventsOf: (type: string) => s.events.filter((e) => e['event_type'] === type) });
}
export type World = ReturnType<typeof makeWorld>;

/** storage fake with the REAL core bucket-owner + tenant-path rules; `calls` = accesses that passed them. */
export function makeStorage(tenant = T_A) {
  const objects = new Map<string, Buffer>(); const calls: Array<{ op: string; path: string }> = [];
  const k = (p: string) => p;
  const adapter = {
    async read(bucket: any, path: string) { assertBucket(bucket); assertTenantPath(tenant, path); calls.push({ op: 'read', path }); const v = objects.get(k(path)); if (!v) throw new Error('storage: missing'); return new Uint8Array(v); },
    async put(bucket: any, path: string, b: Uint8Array, o: { contentType: string; ifAbsent?: boolean }) {
      assertOwned('instruments', bucket); assertTenantPath(tenant, path); calls.push({ op: 'put', path }); if (o?.ifAbsent && objects.has(k(path))) throw new Error('exists'); objects.set(k(path), Buffer.from(b));
      return { sha256: createHash('sha256').update(b).digest('hex'), byteSize: b.length };
    },
    async move(bucket: any, from: string, to: string) { assertOwned('instruments', bucket); assertTenantPath(tenant, from); assertTenantPath(tenant, to); calls.push({ op: 'move', path: `${from} -> ${to}` }); const v = objects.get(k(from)); if (!v) throw new Error('storage: missing'); objects.delete(k(from)); objects.set(k(to), v); },
    async delete(bucket: any, path: string) { assertOwned('instruments', bucket); assertTenantPath(tenant, path); calls.push({ op: 'delete', path }); objects.delete(k(path)); },
    async signedUrl() { calls.push({ op: 'signedUrl', path: '' }); return 'https://storage.invalid/sign?token=SECRET-URL-SENTINEL'; },
  };
  return { adapter, objects, calls, has: (p: string) => objects.has(p), get: (p: string) => objects.get(p), seed: (p: string, b: Uint8Array) => { objects.set(p, Buffer.from(b)); }, callsOf: (op: string) => calls.filter((c) => c.op === op) };
}

export function makeScanner() {
  const s = { mode: 'auto' as 'auto' | 'clean' | 'infected' | 'unavailable' | 'throw', calls: 0, last: undefined as Buffer | undefined };
  const scan = async (b: Uint8Array) => { s.calls++; s.last = Buffer.from(b); if (s.mode === 'throw') throw new Error('clamd down'); if (s.mode !== 'auto') return s.mode; return Buffer.from(b).includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE') ? 'infected' : 'clean'; };
  return Object.assign(s, { scan });
}

/** a worker ctx over the world. `attempt`/`maxAttempts` as graphile gives them. */
export function makeCtx(w: World, o: { tenantId?: string; storage?: ReturnType<typeof makeStorage>; scanner?: ReturnType<typeof makeScanner>; attempt?: number; maxAttempts?: number; seedObject?: boolean } = {}) {
  const tenantId = o.tenantId ?? w.tenant; const storage = o.storage ?? makeStorage(tenantId); const scanner = o.scanner ?? makeScanner();
  if (o.seedObject !== false) storage.seed(w.att()['object_path'] as string, w.bytes);
  const lines: string[] = []; const metricCalls: Array<{ name: string; labels: Row; by?: number }> = [];
  const lg = (level: string) => (...a: unknown[]) => { lines.push(JSON.stringify({ level, a }, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message } : typeof v === 'bigint' ? String(v) : v))); };
  const tx: any = {
    startedAt: new Date(NOW), claims: { tenant_id: tenantId, actor_type: 'system' },
    async query(text: string, values: unknown[] = []) {
      if (/INSERT\s+INTO\s+core\.event_log/i.test(text)) {
        const env = values.find((v) => v && typeof v === 'object' && !(v instanceof Date) && 'event_id' in (v as object)) as Row;
        if (w.events.some((e) => e['tenant_id'] === env['tenant_id'] && e['event_type'] === env['event_type'] && e['idempotency_key'] === env['idempotency_key'])) return { rows: [] };
        w.events.push(env); return { rows: [{ event_id: env['event_id'] }] };
      }
      if (/FROM\s+core\.event_log/i.test(text)) { const hit = w.events.find((e) => values.includes(e['event_type']) && values.includes(e['idempotency_key'])); return { rows: hit ? [{ event_id: hit['event_id'] }] : [] }; }
      if (/app\.enqueue_job/i.test(text)) { w.jobs.push({ text, values }); return { rows: [{ enqueue_job: null }] }; }
      return { rows: [] };
    },
  };
  const ctx: any = {
    tenantId, actor: { type: 'system', id: SYSTEM }, requestId: REQ, tx, now: () => NOW, attempt: o.attempt ?? 1, maxAttempts: o.maxAttempts ?? 5, jobId: '1',
    events: createEvents({ producer: 'instruments', log: { warn: lg('warn') as any, error: lg('error') as any } as any }),
    storage: storage.adapter, files: { scan: scanner.scan }, db: { tx: async (fn: (c: unknown) => unknown) => fn(ctx) },
    log: { info: lg('info'), warn: lg('warn'), error: lg('error'), debug: lg('debug') }, metrics: { inc: (name: string, labels: Row = {}, by?: number) => { metricCalls.push({ name, labels, ...(by === undefined ? {} : { by }) }); }, set: () => undefined },
    ports: {}, core: {}, audit: { access: async () => undefined },
  };
  return { ctx, storage, scanner, lines, metricCalls, logText: () => lines.join('\n') + '\n' + JSON.stringify(metricCalls) };
}
export const payload = (o: Row = {}) => ({ tenant_id: T_A, attachment_id: ATT, ...o });
export const failure = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, got success'); };
