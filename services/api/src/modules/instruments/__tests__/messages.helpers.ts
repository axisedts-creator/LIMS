// C7 API-T12 test helpers (not a test file). Synthetic data only. SEAMS the spec leaves open — the writer must match them or raise a dispute:
//
//   ../repo/messages.repo.ts          exports `MessagesRepo` (below) + `createMessagesRepo(): MessagesRepo` (SQL on the request tx, explicit tenant predicate on every statement; staff RLS hides other centres' rows).
//                                     READ-ONLY: no insert/update/delete method exists (E35 preview parse "no writes").
//   ../service/messages.service.ts    `createMessagesService(deps?: { repo?: MessagesRepo; getDriver?: (code) => InstrumentDriver|undefined (default drivers/registry) })` -> async (ctx, input) => { status: 200, body }:
//        listInstrumentMessages  {receivedAtFrom, receivedAtTo, instrumentId?, agentId?, centreId?, messageKind?: string[], latestOutcome?: string[], hasUnmapped?: boolean, hasQc?: boolean, sort?, cursor?, limit?}   E33
//        searchInstrumentMessages {body}  (body = SNAKE_CASE request body)                                                                                                                                 E34
//        getInstrumentMessage     {instrumentMessageId, previewParse?: boolean}                                                                                                                            E35
//        getInstrumentMessageRaw  {instrumentMessageId}                                                                                                                                                    E36
//        listMessageRejections    {receivedAtFrom, receivedAtTo, agentId?, reason?, cursor?, limit?}                                                                                                       E42
//        Validation failures throw LimsError common.validation_failed / common.invalid_cursor; unknown or invalid-uuid id -> common.not_found. Authorisation: ctx.ports.IdentityPort.assertRole(ctx, { permission:
//        'instruments.message.read', centreId? }) — lists: centreId = the centre_id filter (undefined = tenant level); E35/E36: the MESSAGE's centre, AFTER the row was loaded (404 before 403).
//   ../handlers/messages.handlers.ts  exports `messagesHandlers` = { listInstrumentMessages, searchInstrumentMessages, getInstrumentMessage, getInstrumentMessageRaw, listMessageRejections } (replace the 5 stubs in
//                                     handlers/index.ts); the core has already coerced query (csv -> arrays, booleans, numbers). E36 result carries headers { 'cache-control': 'no-store' }.
//   Row shapes the fake repo returns (snake_case, plus planted extras the DTO must NOT leak):
//        summary row  = { id, tenant_id, instrument_id, instrument_code, agent_id, centre_id, protocol, message_kind, received_at, captured_at?|null, size_bytes, latest_run: {run_no, kind, outcome, patient_records,
//                         qc_records, calibrator_records, unmapped_records, emitted_events} }
//        findMessage  = summary row + { message_control_id?|null, message_key_kind, warnings, driver_code, timezone, parser_options, qc_sample_id_patterns }   (NO raw bytes)
//        getMessageRawBytes = { id, tenant_id, centre_id, raw_bytes: Buffer, raw_sha256, size_bytes }   (called only AFTER assertRole passed)
//        listRuns     = rows of 05-SCHEMA processing_runs + { actor_display? } ordered by run_no; listRecords(tx, t, messageId, runNo) = message_records of that run + { run_no };
//        findAttachmentByMessage = attachments row (same seam as API-T11); listRejections rows = message_rejections cols (id, received_at, agent_id, claimed_instrument_id, agent_message_id, reason_code, size_bytes, raw_sha256) + extras.
//   records_expired = message received_at older than 90 days [CONV, D-11] relative to ctx.now(); then listRecords returns [] and ONLY `previewParse: true` parses the raw (in memory, nothing written).
//   raw_text_escaped = the raw text with every C0 control char / DEL rendered as visible text (no raw control character in the string); printable content kept.
import { LimsError } from '../../../core/errors.js';
import { ASTM_PATIENT, PLANT, bytes, sha256hex } from './ingest.helpers.js';
import { AGENT_A1, INS, idN, insRow, CENTRE_A1, CENTRE_A2, NOW, TENANT_A, TENANT_B, USER, forbidden, rejection, type Row } from './instruments.helpers.js';
import { makeCtx as baseCtx, MEM, REQ_ID } from './agents.helpers.js';

export { idN, INS, AGENT_A1, CENTRE_A1, CENTRE_A2, NOW, TENANT_A, TENANT_B, USER, MEM, REQ_ID, PLANT, ASTM_PATIENT, bytes, sha256hex, forbidden, rejection, insRow };
export type { Row };
export const AGENT_A2 = idN(0x1001);
export const msgId = (n: number) => idN(0xf000 + n);
export const READ = 'instruments.message.read';
export const FROM = '2026-11-07T00:00:00.000Z';
export const TO = '2026-11-08T00:00:00.000Z';
export const DAY = 86_400_000;
export const ago = (days: number) => new Date(Date.parse(NOW) - days * DAY).toISOString();
export const failure = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, got success'); };

// ---------------------------------------------------------------------------------------------------- the repo seam
export interface MessagesRepo {
  listMessages(tx: any, tenantId: string, q: { receivedAtFrom: string; receivedAtTo: string; instrumentId?: string; agentId?: string; centreId?: string; messageKind?: string[]; latestOutcome?: string[]; hasUnmapped?: boolean; hasQc?: boolean; cursor?: string; limit: number }): Promise<{ rows: Row[]; nextCursor?: string }>;
  searchMessages(tx: any, tenantId: string, q: { sampleBarcode: string; receivedAtFrom?: string; receivedAtTo?: string; instrumentId?: string; limit: number }): Promise<Row[]>;
  findMessage(tx: any, tenantId: string, messageId: string): Promise<Row | undefined>;
  getMessageRawBytes(tx: any, tenantId: string, messageId: string): Promise<Row | undefined>;
  listRuns(tx: any, tenantId: string, messageId: string): Promise<Row[]>;
  listRecords(tx: any, tenantId: string, messageId: string, runNo: number): Promise<Row[]>;
  findAttachmentByMessage(tx: any, tenantId: string, messageId: string): Promise<Row | undefined>;
  listRejections(tx: any, tenantId: string, q: { receivedAtFrom: string; receivedAtTo: string; agentId?: string; reason?: string; cursor?: string; limit: number }): Promise<{ rows: Row[]; nextCursor?: string }>;
}

// ---------------------------------------------------------------------------------------------------- fixtures
export const RAW_ASTM = bytes(ASTM_PATIENT);
/** binary-safe raw: STX .. ETX framing, a CR, a NUL and a high byte; contains the planted barcode. */
export const RAW_CTRL = Buffer.concat([Buffer.from([0x02]), Buffer.from(`1H|\\^&|||SYN\r2P|1||${PLANT.barcode}\r`, 'latin1'), Buffer.from([0x00, 0xff, 0x03, 0x0d, 0x0a])]);
export const latestRun = (o: Row = {}): Row => ({ run_no: 1, kind: 'live', outcome: 'parsed', patient_records: 2, qc_records: 0, calibrator_records: 0, unmapped_records: 0, emitted_events: 2, ...o });
/** summary row + planted leaks (tenant_id, message_key, agent_message_id, link_meta, created_by, sample_barcode) that no DTO may carry. */
export const summaryRow = (n: number, o: Row = {}): Row => ({
  id: msgId(n), tenant_id: TENANT_A, instrument_id: INS(1), instrument_code: 'SIM-CHEM-1', agent_id: AGENT_A1, centre_id: CENTRE_A1, protocol: 'astm', message_kind: 'data',
  received_at: '2026-11-07T04:05:00.000Z', captured_at: '2026-11-07T04:00:00.000Z', size_bytes: RAW_ASTM.length, latest_run: latestRun(),
  message_key: 'LEAK-message-key', agent_message_id: idN(0x9999), link_meta: { frames: 3 }, created_by: AGENT_A1, sample_barcode: PLANT.barcode, ...o,
});
export const detailRow = (n: number, o: Row = {}): Row => ({
  ...summaryRow(n), message_control_id: null, message_key_kind: 'sha256', warnings: [], driver_code: 'astm_generic_e1394', timezone: 'Asia/Kathmandu', parser_options: {}, qc_sample_id_patterns: [], ...o,
});
export const runRow = (messageId: string, runNo: number, o: Row = {}): Row => ({
  id: idN(0xe200 + runNo), tenant_id: TENANT_A, centre_id: CENTRE_A1, message_id: messageId, run_no: runNo, kind: 'live', driver_code: 'astm_generic_e1394', driver_version: '1.0.0', outcome: 'parsed',
  error_code: null, error_reason: null, patient_records: 2, qc_records: 0, calibrator_records: 0, host_query_records: 0, unmapped_records: 0, skipped_no_barcode_records: 0, emitted_events: 2, skipped_records: 0,
  reason_code: null, reason_text: null, actor_type: 'device', actor_display: null, actor_id: AGENT_A1, created_at: '2026-11-07T04:05:00.000Z', ...o,
});
export const recordRow = (messageId: string, seq: number, o: Row = {}): Row => ({
  id: idN(0xe100 + seq), tenant_id: TENANT_A, centre_id: CENTRE_A1, message_id: messageId, run_id: idN(0xe201), run_no: 1, record_seq: seq, record_class: 'patient', sample_barcode: PLANT.barcode, control_id_raw: null,
  record_kind: 'quantitative', instrument_analyte_code: seq === 1 ? 'GLU' : 'NA', mapping_status: 'mapped', analyte_id: idN(0xb001), test_id: idN(0xb002), value_raw: seq === 1 ? '5.4' : '141', unit_raw: 'mmol/L',
  instrument_flags: ['N'], instrument_result_time: '2026-11-07T04:00:00.000Z', is_rerun: false, emit_status: 'emitted', event_id: idN(0xe300 + seq), port_outcome: null, port_reason_code: null, port_result_id: null,
  source_record_id: null, warnings: [], value_numeric: 5.4, created_by: AGENT_A1, ...o,
});
export const rejectionRow = (n: number, o: Row = {}): Row => ({
  id: idN(0xd100 + n), tenant_id: TENANT_A, centre_id: CENTRE_A1, received_at: '2026-11-07T05:00:00.000Z', agent_id: AGENT_A1, claimed_instrument_id: INS(77), agent_message_id: idN(0x9100 + n),
  reason_code: 'instruments.instrument_unknown', size_bytes: 412, raw_sha256: sha256hex(`rej-${n}`), raw_bytes: RAW_ASTM, ...o,
});
export const attachmentRow = (messageId: string, o: Row = {}): Row => ({
  id: idN(0xe001), tenant_id: TENANT_A, centre_id: CENTRE_A1, message_id: messageId, instrument_id: INS(9), bucket: 'instruments-attachments', object_path: `${TENANT_A}/2026/11/${idN(0xe001)}.pdf`,
  sha256: sha256hex('pdf'), mime_type: 'application/pdf', size_bytes: 321, original_file_name: 'slide-0042.pdf', scan_state: 'clean', scan_attempts: 1, version: 2, ...o,
});

// ---------------------------------------------------------------------------------------------------- the world: in-memory read-only repo that records calls and filters by tenant only (RLS/centre scoping is the DB's; the service must still cope)
export interface Seed { messages?: Row[]; runs?: Row[]; records?: Row[]; rejections?: Row[]; attachments?: Row[]; raw?: Record<string, Buffer>; search?: Row[]; nextCursor?: string }
export function makeMessagesWorld(seed: Seed = {}) {
  const calls: Array<{ op: string; tenantId: string; args: unknown[] }> = [];
  const rawOf = (m: Row) => seed.raw?.[m['id']] ?? RAW_ASTM;
  const rec = async <T>(op: string, tenantId: string, args: unknown[], fn: () => T): Promise<T> => { calls.push({ op, tenantId, args }); await Promise.resolve(); return fn(); };
  const mine = (t: string, rows: Row[] = []) => rows.filter((r) => r['tenant_id'] === t);
  const repo: MessagesRepo = {
    listMessages: (_tx, t, q) => rec('listMessages', t, [q], () => ({ rows: mine(t, seed.messages).map((r) => structuredClone(r)), ...(seed.nextCursor ? { nextCursor: seed.nextCursor } : {}) })),
    searchMessages: (_tx, t, q) => rec('searchMessages', t, [q], () => (seed.search ?? mine(t, seed.messages)).map((r) => structuredClone(r))),
    findMessage: (_tx, t, id) => rec('findMessage', t, [id], () => { const m = mine(t, seed.messages).find((x) => x['id'] === id); return m ? structuredClone(m) : undefined; }),
    getMessageRawBytes: (_tx, t, id) => rec('getMessageRawBytes', t, [id], () => {
      const m = mine(t, seed.messages).find((x) => x['id'] === id); if (!m) return undefined; const b = rawOf(m);
      return { id, tenant_id: t, centre_id: m['centre_id'], raw_bytes: Buffer.from(b), raw_sha256: sha256hex(b), size_bytes: b.length };
    }),
    listRuns: (_tx, t, id) => rec('listRuns', t, [id], () => mine(t, seed.runs).filter((r) => r['message_id'] === id).sort((a, b) => a['run_no'] - b['run_no']).map((r) => structuredClone(r))),
    listRecords: (_tx, t, id, runNo) => rec('listRecords', t, [id, runNo], () => mine(t, seed.records).filter((r) => r['message_id'] === id && r['run_no'] === runNo).sort((a, b) => a['record_seq'] - b['record_seq']).map((r) => structuredClone(r))),
    findAttachmentByMessage: (_tx, t, id) => rec('findAttachmentByMessage', t, [id], () => { const a = mine(t, seed.attachments).find((x) => x['message_id'] === id); return a ? structuredClone(a) : undefined; }),
    listRejections: (_tx, t, q) => rec('listRejections', t, [q], () => ({ rows: mine(t, seed.rejections).map((r) => structuredClone(r)), ...(seed.nextCursor ? { nextCursor: seed.nextCursor } : {}) })),
  };
  return { repo, calls, callsOf: (op: string) => calls.filter((c) => c.op === op) };
}
export type MsgWorld = ReturnType<typeof makeMessagesWorld>;

// ---------------------------------------------------------------------------------------------------- ctx (real core access() writes audit.access_log on ctx.tx) + log capture
export function makeCtx(o: { tenantId?: string; roles?: (c: { permission: string; centreId?: string }) => void; failAudit?: boolean } = {}) {
  const c = baseCtx({ ...(o.tenantId ? { tenantId: o.tenantId } : {}), ...(o.roles ? { roles: o.roles } : {}) });
  const lines: string[] = [];
  const rec = (level: string) => (...a: unknown[]) => { lines.push(JSON.stringify({ level, a }, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : typeof v === 'bigint' ? String(v) : v))); };
  c.ctx.log = { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') };
  c.ctx.metrics = { inc: (...a: unknown[]) => { lines.push(JSON.stringify(a)); } };
  if (o.failAudit) { const q = c.ctx.tx.query.bind(c.ctx.tx); c.ctx.tx.query = async (text: string, v: unknown[]) => { if (/audit\.access_log/.test(text)) throw new LimsError('common.internal'); return q(text, v); }; }
  const writes = () => c.inserts.filter((i) => /\b(INSERT|UPDATE|DELETE)\b/i.test(i.text));
  return { ...c, lines, logText: () => lines.join('\n'), writes };
}
