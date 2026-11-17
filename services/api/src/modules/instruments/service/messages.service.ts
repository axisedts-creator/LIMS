// E33 listInstrumentMessages, E34 searchInstrumentMessages, E35 getInstrumentMessage (+ preview parse), E36 getInstrumentMessageRaw, E42 listMessageRejections
// (02-TRD §6.8, §7.3; 01-PRD AC-18.1..AC-18.3, CR-C7-008; 07-SECURITY S-01/S-02/S-06/S-12, AB10, AB13, REQ-SEC-098).
// Barcode: only in the E34 POST body, never in a URL, a log line or a list DTO. Raw: only E36, after assertRole at the message's centre, with one access_log row
// on ctx.tx (fails closed). Logs: this module logs nothing (codes and ids only would be allowed; barcodes, raw and file names never).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../core/errors.js';
import { localToUtc } from '../domain/instrumentTime.js';
import { getDriver as registryDriver } from '../drivers/registry.js';
import type { DriverContext, InstrumentDriver } from '../drivers/types.js';
import { createMessagesRepo, type MessagesRepo } from '../repo/messages.repo.js';
import { cursorOf, enumList, fail, isUuid, limitOf, page, scope, type AgentsCtx, type Result } from './agents.service.js';

type Row = Record<string, any>;
export interface MessagesCtx extends AgentsCtx {
  readonly audit?: { access(e: { action: string; entityType: string; entityId?: string; centreId?: string; outcome: 'allowed' | 'denied' }): Promise<void> };
  readonly now?: () => string | Date;
}
export interface MessagesDeps { repo?: MessagesRepo; getDriver?: (code: string) => InstrumentDriver | undefined }
export type MessagesResult = Result & { headers?: Record<string, string> };

const READ = 'instruments.message.read';
const ISO_UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const BARCODE = /^[A-Z0-9]{1,40}$/;
const DAY_MS = 86_400_000;
const MAX_SPAN_MS = 31 * DAY_MS;
const RETENTION_MS = 90 * DAY_MS;                    // [CONV, D-11] message_records are purged after 90 days; the raw archive is not
const SEARCH_LIMIT = 50;
const KINDS = ['data', 'incomplete', 'host_query', 'attachment'];
const OUTCOMES = ['parsed', 'shadow', 'quarantined', 'rejected_capability'];
const REJECT_REASONS = ['instruments.instrument_unknown', 'instruments.device_mismatch', 'instruments.message_too_large'];
const SEARCH_KEYS = ['sample_barcode', 'received_at_from', 'received_at_to', 'instrument_id'];
const COUNTERS = ['patient_records', 'qc_records', 'calibrator_records', 'unmapped_records', 'emitted_events'];
const RUN_COUNTERS = ['patient_records', 'qc_records', 'calibrator_records', 'host_query_records', 'unmapped_records', 'skipped_no_barcode_records', 'emitted_events', 'skipped_records'];
const CTRL = /[\u0000-\u001f\u007f]|[\u0080-\u009f]/g;

const iso = (v: unknown) => new Date(v as string).toISOString();
const given = (v: unknown) => v !== undefined && v !== null;
/** keep only the listed keys that carry a value: no nulls on the wire */
const pick = (r: Row, keys: string[]): Row => Object.fromEntries(keys.filter((k) => given(r[k])).map((k) => [k, r[k]]));
const sameTenant = (r: Row | undefined, t: string): r is Row => !!r && r['tenant_id'] === t;
const instant = (v: unknown, path: string): number => { if (typeof v !== 'string' || !ISO_UTC.test(v) || Number.isNaN(Date.parse(v))) fail(path); return Date.parse(v as string); };
/** the ≤ 31 day received_at window (both ends required unless `optional`) */
function window(from: unknown, to: unknown, optional = false): void {
  if (optional && from === undefined && to === undefined) return;
  const f = from === undefined && optional ? undefined : instant(from, '/received_at_from');
  const t = to === undefined && optional ? undefined : instant(to, '/received_at_to');
  if (f !== undefined && t !== undefined && (f > t || t - f > MAX_SPAN_MS)) fail('/received_at_to');
}
const optUuid = (v: unknown, path: string) => { if (v !== undefined && !isUuid(v)) fail(path); };
const optBool = (v: unknown, path: string) => { if (v !== undefined && typeof v !== 'boolean') fail(path); };
const plain = (v: unknown): Row | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Row) : undefined);

function toSummary(r: Row): Row {
  const lr = r['latest_run'] ?? {};
  return { ...pick(r, ['id', 'instrument_id', 'instrument_code', 'agent_id', 'centre_id', 'protocol', 'message_kind']), received_at: iso(r['received_at']),
    ...(given(r['captured_at']) ? { captured_at: iso(r['captured_at']) } : {}), size_bytes: r['size_bytes'], latest_run: pick(lr, ['run_no', 'kind', 'outcome', ...COUNTERS]) };
}
export function toRun(r: Row): Row {
  return { ...pick(r, ['id', 'run_no', 'kind', 'driver_code', 'driver_version', 'outcome', 'error_code', 'error_reason', ...RUN_COUNTERS, 'reason_code', 'reason_text', 'actor_type', 'actor_display']), created_at: iso(r['created_at']) };
}
export function toRecord(r: Row): Row {
  return { ...pick(r, ['id', 'run_no', 'record_seq', 'record_class', 'sample_barcode', 'control_id_raw', 'record_kind', 'instrument_analyte_code', 'mapping_status', 'analyte_id', 'test_id',
    'value_raw', 'unit_raw', 'is_rerun', 'emit_status', 'event_id', 'port_outcome', 'port_reason_code', 'port_result_id', 'source_record_id']),
    ...(given(r['instrument_result_time']) ? { instrument_result_time: iso(r['instrument_result_time']) } : {}), instrument_flags: r['instrument_flags'] ?? [], warnings: r['warnings'] ?? [] };
}
const toRejection = (r: Row): Row => ({ ...pick(r, ['id', 'agent_id', 'claimed_instrument_id', 'agent_message_id', 'reason_code', 'size_bytes', 'raw_sha256']), received_at: iso(r['received_at']) });

/** raw bytes as visible text: C0/C1 controls and DEL become U+24xx control pictures / \xNN, so no control character ever reaches a terminal or the DOM */
function escapeRaw(raw: Uint8Array): string {
  return new TextDecoder('utf-8').decode(raw).replace(CTRL, (c) => { const n = c.charCodeAt(0); return n <= 0x1f ? String.fromCharCode(0x2400 + n) : n === 0x7f ? '␡' : `\\x${n.toString(16)}`; });
}

export function createMessagesService(deps: MessagesDeps = {}) {
  const repo = deps.repo ?? createMessagesRepo();
  const getDriver = deps.getDriver ?? registryDriver;

  /** D-11: parse the stored raw NOW, in memory. Nothing is written; hostile bytes or a driver bug give no records, never a 5xx. */
  function previewRecords(msg: Row, raw: Uint8Array, runNo: number): Row[] {
    try {
      const driver = getDriver(String(msg['driver_code']));
      if (!driver) return [];
      const pats: RegExp[] = [];
      for (const p of Array.isArray(msg['qc_sample_id_patterns']) ? msg['qc_sample_id_patterns'] : []) { try { pats.push(new RegExp(String(p))); } catch { /* a bad stored pattern never matches */ } }
      const ctx: DriverContext = { receivedAt: iso(msg['received_at']) as DriverContext['receivedAt'], capturedAt: iso(msg['captured_at'] ?? msg['received_at']) as DriverContext['capturedAt'],
        instrumentTimezone: msg['timezone'], qcSampleIdPatterns: pats, options: plain(msg['parser_options']) ?? {} };
      const pr = driver.parse(raw, ctx);
      if (!pr.ok) return [];
      const utc = (l: string | undefined) => { if (!l) return undefined; try { return localToUtc(l, msg['timezone']); } catch { return undefined; } };
      return pr.records.map((r) => toRecord({ id: uuidv7(), run_no: runNo, record_seq: r.recordSeq, record_class: r.recordClass, sample_barcode: r.sampleBarcode, control_id_raw: r.controlIdRaw,
        record_kind: r.recordKind, instrument_analyte_code: r.instrumentAnalyteCode, value_raw: r.valueRaw, unit_raw: r.unitRaw, instrument_flags: [...r.instrumentFlags],
        instrument_result_time: utc(r.instrumentResultTimeLocal), is_rerun: r.isRerun, emit_status: 'not_applicable', warnings: r.warnings.filter((w) => typeof w === 'string' && w.length <= 64).slice(0, 50) }));
    } catch { return []; }
  }

  /** BOLA: RLS-visible row of the caller's tenant, else 404; then assertRole at the MESSAGE's centre (404 before 403). */
  async function load(s: ReturnType<typeof scope>, id: unknown): Promise<Row> {
    if (!isUuid(id)) throw new LimsError('common.not_found');
    const row = await repo.findMessage(s.tx, s.tenantId, id);
    if (!sameTenant(row, s.tenantId)) throw new LimsError('common.not_found');
    await s.assert(READ, row['centre_id']);
    return row;
  }

  return {
    /** E33 — AC-18.1 */
    async listInstrumentMessages(ctx: MessagesCtx, q: Row = {}): Promise<MessagesResult> {
      const s = scope(ctx);
      window(q['receivedAtFrom'], q['receivedAtTo']);
      optUuid(q['centreId'], '/centre_id'); optUuid(q['instrumentId'], '/instrument_id'); optUuid(q['agentId'], '/agent_id');
      const messageKind = enumList(q['messageKind'], KINDS, '/message_kind');
      const latestOutcome = enumList(q['latestOutcome'], OUTCOMES, '/latest_outcome');
      optBool(q['hasUnmapped'], '/has_unmapped'); optBool(q['hasQc'], '/has_qc');
      if (q['sort'] !== undefined && q['sort'] !== '-received_at') fail('/sort');
      const limit = limitOf(q['limit']); const cursor = cursorOf(q['cursor']);
      await s.assert(READ, q['centreId'] as string | undefined);
      const res = await repo.listMessages(s.tx, s.tenantId, { receivedAtFrom: q['receivedAtFrom'], receivedAtTo: q['receivedAtTo'], ...(q['instrumentId'] !== undefined ? { instrumentId: q['instrumentId'] } : {}),
        ...(q['agentId'] !== undefined ? { agentId: q['agentId'] } : {}), ...(q['centreId'] !== undefined ? { centreId: q['centreId'] } : {}), ...(messageKind ? { messageKind } : {}), ...(latestOutcome ? { latestOutcome } : {}),
        ...(q['hasUnmapped'] !== undefined ? { hasUnmapped: q['hasUnmapped'] } : {}), ...(q['hasQc'] !== undefined ? { hasQc: q['hasQc'] } : {}), ...(cursor ? { cursor } : {}), limit } as Parameters<MessagesRepo['listMessages']>[2]);
      return { status: 200, body: { data: res.rows.filter((r) => r['tenant_id'] === s.tenantId).map(toSummary), page: page(limit, res.nextCursor) } };
    },

    /** E34 — AC-18.1, AB10, REQ-SEC-098: the barcode arrives in the POST body only; validation errors name the field, never echo the value. */
    async searchInstrumentMessages(ctx: MessagesCtx, input: { body?: unknown }): Promise<MessagesResult> {
      const s = scope(ctx);
      const b = plain(input?.body) ?? fail('/');
      if (Object.keys(b).some((k) => !SEARCH_KEYS.includes(k))) fail('/');
      if (typeof b['sample_barcode'] !== 'string' || !BARCODE.test(b['sample_barcode'])) fail('/sample_barcode');
      window(b['received_at_from'], b['received_at_to'], true);
      optUuid(b['instrument_id'], '/instrument_id');
      await s.assert(READ);
      const rows = await repo.searchMessages(s.tx, s.tenantId, { sampleBarcode: b['sample_barcode'], ...(b['received_at_from'] !== undefined ? { receivedAtFrom: b['received_at_from'] } : {}),
        ...(b['received_at_to'] !== undefined ? { receivedAtTo: b['received_at_to'] } : {}), ...(b['instrument_id'] !== undefined ? { instrumentId: b['instrument_id'] } : {}), limit: SEARCH_LIMIT } as Parameters<MessagesRepo['searchMessages']>[2]);
      return { status: 200, body: { data: rows.filter((r) => r['tenant_id'] === s.tenantId).slice(0, SEARCH_LIMIT).map(toSummary) } };
    },

    /** E35 — AC-18.2. Records of the latest run; past 90 days they are gone (records_expired) and only `previewParse` re-parses the raw, in memory. */
    async getInstrumentMessage(ctx: MessagesCtx, input: { instrumentMessageId?: unknown; previewParse?: unknown } = {}): Promise<MessagesResult> {
      const s = scope(ctx);
      const msg = await load(s, input?.instrumentMessageId);
      if (input.previewParse !== undefined && typeof input.previewParse !== 'boolean') fail('/preview_parse');
      const id = msg['id'] as string;
      const runs = await repo.listRuns(s.tx, s.tenantId, id);
      const runNo = Number(msg['latest_run']?.['run_no'] ?? runs.reduce((m, r) => Math.max(m, r['run_no']), 1));
      const expired = Date.parse(iso(msg['received_at'])) < new Date(ctx.now?.() ?? new Date()).getTime() - RETENTION_MS;
      let records: Row[] = [];
      if (!expired) records = (await repo.listRecords(s.tx, s.tenantId, id, runNo)).filter((r) => r['tenant_id'] === undefined || r['tenant_id'] === s.tenantId).map(toRecord);
      else if (input.previewParse === true) {
        const raw = await repo.getMessageRawBytes(s.tx, s.tenantId, id);
        if (!sameTenant(raw, s.tenantId)) throw new LimsError('common.not_found');
        records = previewRecords(msg, raw['raw_bytes'], runNo);
      }
      const att = await repo.findAttachmentByMessage(s.tx, s.tenantId, id);
      return { status: 200, body: { ...toSummary(msg), ...pick(msg, ['message_control_id', 'message_key_kind']), warnings: msg['warnings'] ?? [], runs: runs.filter((r) => r['tenant_id'] === s.tenantId).map(toRun), records,
        ...(att ? { attachment: { attachment_id: att['id'], ...pick(att, ['scan_state', 'mime_type', 'size_bytes', 'original_file_name']) } } : {}), records_expired: expired } };
    },

    /** E36 — AC-18.3, CR-C7-008, AB13: assertRole at the message's centre, THEN the raw is read, THEN exactly one access_log row on ctx.tx (a failed write = no raw). */
    async getInstrumentMessageRaw(ctx: MessagesCtx, input: { instrumentMessageId?: unknown } = {}): Promise<MessagesResult> {
      const s = scope(ctx);
      if (typeof ctx.audit?.access !== 'function') throw new LimsError('common.internal');      // fail closed: no audit sink, no raw
      const msg = await load(s, input?.instrumentMessageId);
      const raw = await repo.getMessageRawBytes(s.tx, s.tenantId, msg['id']);
      if (!sameTenant(raw, s.tenantId)) throw new LimsError('common.not_found');
      await ctx.audit.access({ action: 'instrument_message.raw_view', entityType: 'instrument_message', entityId: msg['id'], centreId: msg['centre_id'], outcome: 'allowed' });
      const bytes: Buffer = Buffer.from(raw['raw_bytes']);
      return { status: 200, body: { raw_base64: bytes.toString('base64'), raw_text_escaped: escapeRaw(bytes), raw_sha256: raw['raw_sha256'], size_bytes: raw['size_bytes'] } };
    },

    /** E42 — rejected messages: metadata and hash only, never raw_bytes. */
    async listMessageRejections(ctx: MessagesCtx, q: Row = {}): Promise<MessagesResult> {
      const s = scope(ctx);
      window(q['receivedAtFrom'], q['receivedAtTo']);
      optUuid(q['agentId'], '/agent_id');
      if (q['reason'] !== undefined && !REJECT_REASONS.includes(q['reason'])) fail('/reason');
      const limit = limitOf(q['limit']); const cursor = cursorOf(q['cursor']);
      await s.assert(READ);
      const res = await repo.listRejections(s.tx, s.tenantId, { receivedAtFrom: q['receivedAtFrom'], receivedAtTo: q['receivedAtTo'], ...(q['agentId'] !== undefined ? { agentId: q['agentId'] } : {}),
        ...(q['reason'] !== undefined ? { reason: q['reason'] } : {}), ...(cursor ? { cursor } : {}), limit } as Parameters<MessagesRepo['listRejections']>[2]);
      return { status: 200, body: { data: res.rows.filter((r) => r['tenant_id'] === s.tenantId).map(toRejection), page: page(limit, res.nextCursor) } };
    },
  };
}
export type MessagesService = ReturnType<typeof createMessagesService>;
