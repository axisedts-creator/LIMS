// C7 API-T13 test helpers (not a test file). Synthetic data only. SEAMS the spec leaves open — the writer must match them or raise a dispute:
//
//   ../repo/reprocess.repo.ts          exports `ReprocessRepo` (interface below) + `createReprocessRepo(): ReprocessRepo` (SQL on the request tx, explicit tenant predicate on every statement; staff RLS hides other centres' rows).
//                                      No update/delete method exists: processing_runs and message_records are class A (INSERT only), the original record of a re-match stays untouched.
//   ../service/reprocess.service.ts    `createReprocessService(deps?: { repo?: ReprocessRepo; getDriver?: (code) => InstrumentDriver|undefined (default drivers/registry) })` -> async (ctx, input) => { status: 200, body }:
//        reprocessInstrumentMessage  { instrumentMessageId, body: { reason_code, reason_text? } }                         E38 -> body { run, records }
//        rematchInstrumentRecord     { recordId, body: { sample_barcode, reason_code, reason_text? } }                    E39 -> body { run, record }
//        `body` = SNAKE_CASE request body as in the OpenAPI schema. run/records are snake_case DTOs as in E35 (run: id, run_no, kind, driver_code, driver_version, outcome, error_code?, the 8 counters, reason_code,
//        reason_text?, actor_type, created_at; record: id, run_no, record_seq, record_class, sample_barcode, instrument_analyte_code, mapping_status, value_raw, unit_raw, emit_status, event_id?, port_outcome?,
//        port_reason_code?, port_result_id?, source_record_id?, …). Order: 404 (unknown / other tenant / invalid uuid) BEFORE assertRole at the MESSAGE's centre (permission `instruments.message.rematch`),
//        then eligibility (409 instruments.reprocess_not_allowed), validation (400 common.validation_failed), driver (422 instruments.driver_not_available), then the work.
//        ctx (user) = { tenantId, actor:{type:'user',id,membershipId}, requestId, tx, events (REAL core createEvents), now, ports:{ IdentityPort.assertRole, CatalogPort.mapInstrumentCode,
//        LabPort.ingestInstrumentResult }, audit.access (REAL core access() on ctx.tx), log, metrics }. Per patient record the service runs `ctx.tx.savepoint(fn)`; a LimsError from the port rolls that record back (its event too).
//   ../handlers/reprocess.handlers.ts  exports `reprocessHandlers` = { reprocessInstrumentMessage, rematchInstrumentRecord } (merged into handlers/index.ts); path params `instrument_message_id` / `record_id`, body passed through.
//
//   Row shapes the fake repo returns (snake_case):
//     findMessage(tx,t,id)   = { id, tenant_id, instrument_id, centre_id, agent_id, protocol, message_kind, received_at, captured_at, driver_code, timezone, parser_options, qc_sample_id_patterns,
//                                 instrument_state, latest_run: { run_no, kind, outcome } }                                  (NO raw bytes)
//     getMessageRawBytes     = { id, tenant_id, centre_id, raw_bytes: Buffer, raw_sha256, size_bytes }                         (called only AFTER assertRole passed; reprocess only)
//     findRecord(tx,t,id)    = message_records row of 05-SCHEMA §2.12 incl. message_id, run_no (value_numeric as decimal STRING)
//     insertRun(tx,t,row)    -> { id }   row = processing_runs cols: centre_id, message_id, run_no (= latest + 1), kind, driver_code, driver_version, outcome, error_code?, the 8 counters, reason_code, reason_text?, actor_type:'user', created_by
//     insertRecords(tx,t,rows) -> inserted rows incl. `id` (one batched insert per run, final emit_status / event_id / port_* values)
import { access } from '../../../core/audit/access.js';
import { createEvents } from '../../../core/events/publish.js';
import type { InstrumentDriver, ParsedRecord, ParseOk, ParseResult } from '../drivers/types.js';
import { makeCatalog, rec1, sha256hex, ASTM_PATIENT, GLU_MAP, PLANT, bytes } from './ingest.helpers.js';
import { AGENT_A1, INS, idN, insRow, CENTRE_A1, CENTRE_A2, NOW, TENANT_A, TENANT_B, USER, MEM, REQ_ID, forbidden, type Row } from './messages.helpers.js';

export { idN, INS, AGENT_A1, CENTRE_A1, CENTRE_A2, NOW, TENANT_A, TENANT_B, USER, MEM, REQ_ID, PLANT, ASTM_PATIENT, GLU_MAP, rec1, bytes, sha256hex, forbidden, insRow };
export type { Row };
export const msgId = (n: number) => idN(0xf400 + n);
export const recId = (n: number) => idN(0xf500 + n);
export const failure = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, got success'); };
export const PERM = 'instruments.message.rematch';
export const REASON_TEXT_PLANT = 'free text with Testpatient-Reason-Sentinel';
export const RAW = bytes(ASTM_PATIENT);
export const snakeToCamel = (o: Row): Row => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase()), v]));

// ---------------------------------------------------------------------------------------------------- the repo seam
export interface ReprocessRepo {
  findMessage(tx: any, tenantId: string, messageId: string): Promise<Row | undefined>;
  getMessageRawBytes(tx: any, tenantId: string, messageId: string): Promise<Row | undefined>;
  findRecord(tx: any, tenantId: string, recordId: string): Promise<Row | undefined>;
  insertRun(tx: any, tenantId: string, row: Row): Promise<{ id: string }>;
  insertRecords(tx: any, tenantId: string, rows: Row[]): Promise<Row[]>;
}

// ---------------------------------------------------------------------------------------------------- fixtures
export const msgRow = (n: number, o: Row = {}): Row => ({
  id: msgId(n), tenant_id: TENANT_A, instrument_id: INS(1), centre_id: CENTRE_A1, agent_id: AGENT_A1, protocol: 'astm', message_kind: 'data', received_at: '2026-11-07T04:05:00.000Z',
  captured_at: '2026-11-07T04:00:00.000Z', driver_code: 'astm_generic_e1394', timezone: 'Asia/Kathmandu', parser_options: {}, qc_sample_id_patterns: ['^QC-'], instrument_state: 'live',
  latest_run: { run_no: 1, kind: 'live', outcome: 'parsed' }, ...o,
});
/** a stored patient record of run 1 (what the live run archived). value_numeric is a decimal STRING (numeric column). */
export const recordRow = (n: number, messageId: string, o: Row = {}): Row => ({
  id: recId(n), tenant_id: TENANT_A, centre_id: CENTRE_A1, message_id: messageId, run_id: idN(0xe201), run_no: 1, run_driver_code: 'astm_generic_e1394', run_driver_version: '1.0.0', record_seq: n, record_class: 'patient', sample_barcode: PLANT.barcode, control_id_raw: null,
  record_kind: 'quantitative', instrument_analyte_code: 'GLU', mapping_status: 'mapped', analyte_id: GLU_MAP.analyteId, test_id: GLU_MAP.testId, value_raw: '5.4', value_numeric: '5.4', unit_raw: 'mmol/L',
  instrument_flags: ['N'], instrument_result_time: '2026-11-07T04:00:00.000Z', instrument_clock_offset_seconds: 0, is_rerun: false, emit_status: 'emitted', event_id: idN(0xe300 + n), port_outcome: null,
  port_reason_code: null, port_result_id: null, source_record_id: null, warnings: [], created_by: AGENT_A1, ...o,
});
/** the three records the synthetic driver "currently" parses: GLU (mapped), NA (unmapped by the fake catalog), a QC record. */
export const GLU = rec1({ recordSeq: 1, sampleBarcode: PLANT.barcode, recordKind: 'quantitative', instrumentAnalyteCode: 'GLU', valueRaw: '5.4', unitRaw: 'mmol/L', instrumentFlags: ['N'], instrumentResultTimeLocal: '2026-11-07T09:45:00', isRerun: true });
export const NA = rec1({ recordSeq: 2, sampleBarcode: PLANT.barcode, recordKind: 'quantitative', instrumentAnalyteCode: 'NA', valueRaw: '141', unitRaw: 'mmol/L', instrumentResultTimeLocal: '2026-11-07T09:45:00' });
export const QC = rec1({ recordSeq: 3, recordClass: 'qc', controlIdRaw: 'QC-L1-0007', instrumentAnalyteCode: 'GLU', valueRaw: '5.0', unitRaw: 'mmol/L', instrumentResultTimeLocal: '2026-11-07T09:46:00' });

/** synthetic driver that records the bytes + context it was asked to parse (default: ok with `records`). */
export function spyDriver(records: ParsedRecord[], o: { result?: ParseResult; calibration?: boolean; code?: string } = {}) {
  const seen: Array<{ raw: Buffer; ctx: any }> = [];
  const ok: ParseOk = { ok: true, messageKind: 'results', records, warnings: [] };
  const driver: InstrumentDriver = {
    code: o.code ?? 'astm_generic_e1394', version: '9.9.9', protocol: 'astm', status: 'generic', optionsSchema: {},
    capabilities: { resultUpload: true, hostQuery: false, worklistDownload: false, qc: true, attachments: false, calibration: o.calibration ?? false },
    parse: (raw, ctx) => { seen.push({ raw: Buffer.from(raw), ctx }); return o.result ?? ok; },
  };
  return { driver, getDriver: (_c: string) => driver as InstrumentDriver | undefined, seen };
}

// ---------------------------------------------------------------------------------------------------- the world: in-memory DB with savepoint semantics + core event_log + audit.access_log capture
export interface Seed { messages?: Row[]; records?: Row[]; raw?: Record<string, Buffer> }
export function makeReprocessWorld(seed: Seed = {}) {
  let s = { messages: (seed.messages ?? []).map((r) => structuredClone(r)), records: (seed.records ?? []).map((r) => structuredClone(r)), runs: [] as Row[], events: [] as Row[] };
  const order: string[] = [];
  const calls: Array<{ op: string; tenantId: string; tx: unknown; args: unknown[] }> = [];
  const auditInserts: Array<{ text: string; values: unknown[] }> = [];
  let n = 0; const uid = () => idN(0xa400 + ++n);
  const rec = async <T>(op: string, tx: unknown, tenantId: string, args: unknown[], fn: () => T): Promise<T> => { calls.push({ op, tenantId, tx, args }); await Promise.resolve(); order.push(op); return fn(); };
  const tx: any = {
    startedAt: new Date(NOW), operation: { module: 'instruments', operationId: 'reprocessInstrumentMessage' }, savepoints: 0, rollbacks: 0,
    async query(text: string, values: unknown[] = []) {
      if (/audit\.access_log/.test(text)) { auditInserts.push({ text, values }); order.push('audit'); return { rows: [] }; }
      if (/INSERT\s+INTO\s+core\.event_log/i.test(text)) {
        const env = values.find((v) => v && typeof v === 'object' && !(v instanceof Date) && 'event_id' in (v as object)) as Row;
        if (s.events.some((e) => e['event_type'] === env['event_type'] && e['idempotency_key'] === env['idempotency_key'])) return { rows: [] };
        s.events.push(env); order.push('event'); return { rows: [{ event_id: env['event_id'] }] };
      }
      if (/FROM\s+core\.event_log/i.test(text)) { const hit = s.events.find((e) => values.includes(e['event_type']) && values.includes(e['idempotency_key'])); return { rows: hit ? [{ event_id: hit['event_id'] }] : [] }; }
      if (/app\.enqueue_job/i.test(text)) return { rows: [{ enqueue_job: null }] };
      return { rows: [] };
    },
    async savepoint<T>(fn: (t: unknown) => Promise<T>): Promise<T> { tx.savepoints++; const snap = structuredClone(s); try { return await fn(tx); } catch (e) { s = snap; tx.rollbacks++; throw e; } },
  };
  const mine = (t: string, rows: Row[]) => rows.filter((r) => r['tenant_id'] === t);
  const repo: ReprocessRepo = {
    findMessage: (x, t, id) => rec('findMessage', x, t, [id], () => { const m = mine(t, s.messages).find((r) => r['id'] === id); return m ? structuredClone(m) : undefined; }),
    getMessageRawBytes: (x, t, id) => rec('getMessageRawBytes', x, t, [id], () => {
      const m = mine(t, s.messages).find((r) => r['id'] === id); if (!m) return undefined; const b = seed.raw?.[id] ?? RAW;
      return { id, tenant_id: t, centre_id: m['centre_id'], raw_bytes: Buffer.from(b), raw_sha256: sha256hex(b), size_bytes: b.length };
    }),
    findRecord: (x, t, id) => rec('findRecord', x, t, [id], () => { const r = mine(t, s.records).find((q) => q['id'] === id); return r ? structuredClone(r) : undefined; }),
    insertRun: (x, t, row) => rec('insertRun', x, t, [row], () => {
      const r = { tenant_id: t, id: uid(), created_at: NOW, ...structuredClone(row) }; s.runs.push(r);
      const m = s.messages.find((q) => q['id'] === row['message_id']); if (m) m['latest_run'] = { run_no: row['run_no'], kind: row['kind'], outcome: row['outcome'] };
      return { id: r['id'] };
    }),
    insertRecords: (x, t, rows) => rec('insertRecords', x, t, [rows], () => rows.map((r) => { const q = { tenant_id: t, id: uid(), ...structuredClone(r) }; s.records.push(q); return structuredClone(q); })),
  };
  return {
    repo, tx, calls, order, auditInserts,
    get messages() { return s.messages; }, get records() { return s.records; }, get runs() { return s.runs; }, get events() { return s.events; },
    callsOf: (op: string) => calls.filter((c) => c.op === op),
    eventsOf: (type: string) => s.events.filter((e) => e['event_type'] === type),
    writes: () => calls.filter((c) => /^insert/.test(c.op)),
    accessRows: () => auditInserts.map((i) => ({ tenantId: i.values[1], centreId: i.values[2], actorId: i.values[3], action: i.values[7], entityType: i.values[8], entityId: i.values[9], outcome: i.values[11], detail: i.values[12] as Row })),
  };
}
export type RWorld = ReturnType<typeof makeReprocessWorld>;

// ---------------------------------------------------------------------------------------------------- LabPort fake (programmable outcomes) + user ctx
export type PortAnswer = { outcome: 'applied' | 'duplicate' | 'unmatched' | 'rejected_state' | 'held'; resultId?: string; specimenId?: string; reasonCode?: string };
export function makeLabPort(world: RWorld, program: (input: Row, n: number) => PortAnswer | Promise<PortAnswer> = (_i, n) => ({ outcome: 'applied', resultId: idN(0xc100 + n), specimenId: idN(0xc200 + n) })) {
  const calls: Array<{ ctx: any; input: Row }> = [];
  const ingestInstrumentResult = async (ctx: any, input: Row) => { calls.push({ ctx, input }); world.order.push('port'); return program(input, calls.length); };
  return { ingestInstrumentResult, calls };
}
export function makeRctx(world: RWorld, o: { tenantId?: string; roles?: (c: { permission: string; centreId?: string }) => void; failAudit?: boolean; port?: ReturnType<typeof makeLabPort>; catalog?: ReturnType<typeof makeCatalog> } = {}) {
  const tenantId = o.tenantId ?? TENANT_A;
  const lines: string[] = []; const asserted: Array<{ permission: string; centreId?: string }> = [];
  const rec = (level: string) => (...a: unknown[]) => { lines.push(JSON.stringify({ level, a }, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : typeof v === 'bigint' ? String(v) : v))); };
  const metricCalls: Array<[string, Row | undefined]> = [];
  const actor = { type: 'user', id: USER, membershipId: MEM };
  const port = o.port ?? makeLabPort(world); const catalog = o.catalog ?? makeCatalog();
  const events = createEvents({ producer: 'instruments', log: { warn: rec('warn') as any, error: rec('error') as any } as any });
  const ctx: any = {
    tenantId, actor, requestId: REQ_ID, tx: world.tx, events, now: () => NOW,
    ports: { IdentityPort: { assertRole: async (_c: unknown, r: { permission: string; centreId?: string }) => { asserted.push(r); world.order.push('assertRole'); o.roles?.(r); } },
      CatalogPort: { mapInstrumentCode: catalog.mapInstrumentCode }, LabPort: { ingestInstrumentResult: port.ingestInstrumentResult } },
    audit: { access: async (e: any) => {
      if (o.failAudit) throw Object.assign(new Error('audit down'), { code: 'common.internal' });
      await access({ tenantId, requestId: REQ_ID, actor, tx: world.tx } as any, e);
    } },
    log: { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') },
    metrics: { inc: (name: string, labels?: Row) => { metricCalls.push([name, labels]); lines.push(JSON.stringify([name, labels])); } },
  };
  return { ctx, asserted, port, catalog, lines, metricCalls, logText: () => lines.join('\n') };
}
/** principal holding only `instruments.message.read` */
export const readOnly = (r: { permission: string }) => { if (r.permission !== 'instruments.message.read') throw forbidden(); };
export const onlyCentre = (c: string) => (r: { centreId?: string }) => { if (r.centreId !== undefined && r.centreId !== c) throw forbidden(); };
