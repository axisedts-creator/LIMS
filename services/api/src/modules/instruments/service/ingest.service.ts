// E04 submitMessageBatch — the ingest pipeline (02-TRD §6.4 steps 1-13, §6.5 keys; 01-PRD AC-09.*, AC-11.1/1.1a/1.2, AC-14.2/14.3; 07-SECURITY S-02/S-08).
// Per message, inside ONE savepoint: an unexpected error rolls back that message's rows AND events and answers `retry` / common.internal.
// processing_runs and message_records are class A (INSERT only): outcomes, counters and emit_status are computed in memory, events are
// published first, then the run and its records are inserted once with final values (step 12).
// Logs, metrics and persisted warnings carry codes, ids and field NAMES only: never a barcode, value, raw byte or result key (02-CV §9.2).
import { createHash } from 'node:crypto';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../core/errors.js';
import type { IncomingFile } from '../../../core/uploads/index.js';
import { eventValidators } from '../../../core/events/publish.js';
import { loadInstrumentsConfig, type InstrumentsConfig } from '../config.js';
import { toDecimalString } from '../domain/decimal.js';
import { capturedAt as correctedTime, instrumentClockOffsetSeconds, localToUtc } from '../domain/instrumentTime.js';
import { getDriver as registryGetDriver } from '../drivers/registry.js';
import type { DriverContext, InstrumentDriver, ParsedRecord, ParseOk } from '../drivers/types.js';
import { calibrationIdempotencyKey, createInstrumentEvents, qcIdempotencyKey, resultIdempotencyKey, type EventsPort, type InstrumentEvents } from '../events/publish.js';
import { createIngestRepo, type IngestRepo } from '../repo/ingest.repo.js';
import { isUuid } from './agents.service.js';
import { deviceScope, type DeviceCtx, type DeviceResult } from './enrolment.service.js';

type Row = Record<string, any>;
export interface IngestCtx extends DeviceCtx {
  readonly events: EventsPort;
  readonly ports?: { readonly CatalogPort?: { mapInstrumentCode(ctx: unknown, input: { instrumentId: string; direction: 'inbound'; instrumentCode: string }): Promise<Row> } };
  readonly log?: { error(o: Record<string, unknown>, msg: string): void };
  /** CR-C7-015: same port as attachments.service (§6.8 step 2); `storage` is only used to drop an object that will not be referenced. */
  readonly uploads?: { accept(file: IncomingFile, opts: Row): Promise<{ sha256: string; mime: string; objectPath: string; bucket: string; scanState: string }> };
  readonly storage?: { delete(bucket: any, path: string): Promise<void> };
  readonly metrics?: { inc(name: string, labels?: Record<string, string>): void };
}
export interface IngestDeps {
  repo?: IngestRepo; getDriver?: (code: string) => InstrumentDriver | undefined; monotonicMs?: () => number; budgetMs?: number; maxMessageBytes?: number;
}
interface Mapping { status: 'mapped' | 'unmapped'; analyteId?: string; testId?: string }
interface Batch { ctx: IngestCtx; tx: any; tenantId: string; agentId: string; events: InstrumentEvents; mappings: Map<string, Mapping>; maxBytes: number }

const MAX_MESSAGES = 100;
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
const SAFE_WARNING = /^[a-z0-9_.:-]{1,64}$/i;       // driver warnings are persisted only when they look like codes
const REUSED_PREFIX = 16;
const ATT_BUCKET = 'instruments-attachments' as const;
const ATT_ALLOW = ['image/jpeg', 'image/png'] as const;          // LD-139 / CR-C7-015: the inline picture is never a PDF
const ATT_EXT: Readonly<Record<string, string>> = { 'image/jpeg': 'jpg', 'image/png': 'png' };
const ATT_MAX_BYTES = 15 * 1024 * 1024;                             // core uploads hard cap (02-CV §10.2); the ingest cap below is the tighter one
const ATT_REJECT = ['common.unsupported_media_type', 'common.payload_too_large', 'common.upload_quarantined'];
const META_INTS =['frames', 'retransmits', 'naks_sent', 'mllp_discarded_bytes'];
const META_REASONS = ['frame_timeout', 'new_enq', 'new_start_block', 'msh_unparseable', 'process_restart'];
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const iso = (v: unknown) => new Date(v as string).toISOString();
export const within = (v: unknown, min: number, max: number): v is string => typeof v === 'string' && v.length >= min && v.length <= max;
export const fit = (v: string | undefined, max: number) => (typeof v === 'string' && v.length <= max ? v : undefined);   // never store a value that breaks a column CHECK
const obj = (v: unknown): Row => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Row) : {});

function cleanMeta(v: unknown): Row {
  const m = obj(v); const out: Row = {};
  for (const k of META_INTS) if (Number.isSafeInteger(m[k]) && m[k] >= 0) out[k] = m[k];
  if (META_REASONS.includes(m['incomplete_reason'])) out['incomplete_reason'] = m['incomplete_reason'];
  return out;
}
export function qcPatterns(v: unknown): RegExp[] {
  const out: RegExp[] = [];
  for (const p of Array.isArray(v) ? v : []) { try { out.push(new RegExp(String(p))); } catch { /* a stored bad pattern never matches */ } }
  return out;
}
export const mapOrganism = (o: NonNullable<ParsedRecord['organism']>) => ({ organism_code_raw: o.organismCodeRaw, ...(o.isolateSeq === undefined ? {} : { isolate_seq: o.isolateSeq }) });
export const mapAst = (a: NonNullable<ParsedRecord['ast']>) => ({ antibiotic_code_raw: a.antibioticCodeRaw, ...(a.isolateSeq === undefined ? {} : { isolate_seq: a.isolateSeq }), method: a.method, raw_value: a.rawValue,
  ...(a.interpretationRaw === undefined ? {} : { interpretation_raw: a.interpretationRaw }), ...(a.standard === undefined ? {} : { standard: a.standard }), ...(a.standardVersion === undefined ? {} : { standard_version: a.standardVersion }) });

export function createIngestService(deps: IngestDeps = {}) {
  const repo = deps.repo ?? createIngestRepo();
  const getDriver = deps.getDriver ?? registryGetDriver;
  const monotonicMs = deps.monotonicMs ?? (() => performance.now());
  let cfg: InstrumentsConfig | undefined;
  const conf = () => (cfg ??= loadInstrumentsConfig());

  async function mapCode(B: Batch, instrumentId: string, code: string): Promise<Mapping> {
    const k = `${instrumentId}\u0000${code}`;
    const hit = B.mappings.get(k);
    if (hit) return hit;
    const port = B.ctx.ports?.CatalogPort;
    if (!port) throw new LimsError('common.internal');
    let m: Mapping;
    try {
      const r = await port.mapInstrumentCode(B.ctx, { instrumentId, direction: 'inbound', instrumentCode: code });
      m = { status: 'mapped', ...(isUuid(r['analyteId']) ? { analyteId: r['analyteId'] } : {}), ...(isUuid(r['testId']) ? { testId: r['testId'] } : {}) };
    } catch (e) {
      if ((e as { code?: unknown })?.code !== 'catalog.instrument_code_unmapped') throw e;
      m = { status: 'unmapped' };
    }
    B.mappings.set(k, m);
    return m;
  }

  /** Steps 1-13 for one message. Returns the per-message result; throws only on unexpected errors (the caller's savepoint rolls back). */
  async function processOne(B: Batch, m: Row): Promise<Row> {
    const { tx, tenantId, agentId, ctx } = B;
    const amid = String(m['agent_message_id']);
    const res = (outcome: string, extra: Row = {}): Row => ({ agent_message_id: amid, outcome, ...extra });
    const instrumentId = m['instrument_id'];
    const b64 = m['raw_base64'];
    // envelope-shaped garbage that the core schema should already have refused: a per-message answer, never a 5xx (S-08)
    if (!isUuid(m['agent_message_id']) || !isUuid(instrumentId) || typeof b64 !== 'string' || b64.length % 4 !== 0 || !B64.test(b64)) return res('rejected', { error_code: 'common.validation_failed' });
    const raw = Buffer.from(b64, 'base64');
    if (raw.length === 0) return res('rejected', { error_code: 'common.validation_failed' });
    const sha = sha256(raw);
    const reject = async (code: string, keepRaw: boolean) => {
      await repo.insertRejection(tx, tenantId, { agent_id: agentId, claimed_instrument_id: instrumentId, agent_message_id: amid, reason_code: code, raw_bytes: keepRaw ? raw : null, raw_sha256: sha, size_bytes: raw.length });
      return res('rejected', { error_code: code });
    };

    // 1 size
    if (raw.length > B.maxBytes) return reject('instruments.message_too_large', false);
    // 2-3 instrument visible to this device (RLS), bound to this agent, in a receivable state
    const ins = await repo.findInstrument(tx, tenantId, instrumentId);
    if (!ins || (ins['tenant_id'] !== undefined && ins['tenant_id'] !== tenantId)) return reject('instruments.instrument_unknown', true);
    if (ins['agent_id'] !== agentId) return reject('instruments.device_mismatch', true);
    if (!['commissioning', 'live', 'suspended'].includes(ins['state'])) return reject('instruments.instrument_unknown', true);
    const driver = getDriver(ins['driver_code']);
    if (!driver) throw new Error('driver unavailable');
    const dup = async (originalId: string, reason: 'agent_message_id' | 'message_key') => {
      await repo.insertDuplicate(tx, tenantId, { centre_id: ins['centre_id'], agent_id: agentId, instrument_id: ins['id'], original_message_id: originalId, agent_message_id: amid, reason });
      return res('duplicate');
    };
    // 4 L1 agent key (before the integrity check: a retried upload is a duplicate whatever its sha says)
    const l1 = await repo.findMessageByAgentKey(tx, tenantId, agentId, amid);
    if (l1) return dup(l1.id, 'agent_message_id');

    // 5-7 integrity, parse, message key
    const captured = correctedTime(String(m['captured_at_agent']), Number(m['clock_offset_ms']));
    const warnings: string[] = [];
    let parsed: ParseOk | undefined;
    let quarantine: { runCode: string; respCode?: string } | undefined;
    let key = sha; let keyKind = 'sha256'; let controlId: string | undefined;
    if (String(m['raw_sha256']).toLowerCase() !== sha) {
      quarantine = { runCode: 'integrity_mismatch' };
      key = `${sha}:${amid}`; keyKind = 'sha256_repeat';           // never collides with (and so never hides behind) a good copy of the same bytes
    } else {
      if (m['kind'] === 'incomplete') quarantine = { runCode: 'incomplete_transfer' };
      else {
        const dctx: DriverContext = { receivedAt: iso(tx.startedAt) as DriverContext['receivedAt'], capturedAt: captured as DriverContext['capturedAt'], instrumentTimezone: ins['timezone'],
          qcSampleIdPatterns: qcPatterns(ins['qc_sample_id_patterns']), options: obj(ins['parser_options']) };
        let pr: ReturnType<InstrumentDriver['parse']> | undefined;
        try { pr = driver.parse(raw, dctx); } catch { pr = undefined; }       // a driver bug on hostile bytes is a quarantine, not an endless retry
        if (!pr || !pr.ok) quarantine = { runCode: 'instruments.message_malformed', respCode: 'instruments.message_malformed' };
        else parsed = pr;
      }
      const cid = parsed?.messageControlId;
      if (ins['protocol'] === 'hl7v2' && parsed && typeof cid === 'string' && cid.length >= 1 && cid.length <= 199) {
        const first = await repo.findMessageByKey(tx, tenantId, ins['id'], cid);
        if (!first) { key = cid; keyKind = 'msh10'; }
        else if (first.raw_sha256 === sha) return dup(first.id, 'message_key');
        else {                                                    // D-12: control id reused with different bytes
          const reused = `${cid}:${sha.slice(0, REUSED_PREFIX)}`;
          const again = await repo.findMessageByKey(tx, tenantId, ins['id'], reused);
          if (again) return dup(again.id, 'message_key');
          key = reused; keyKind = 'msh10_reused'; warnings.push('control_id_reused');
        }
        controlId = cid;
      } else {
        const same = await repo.findMessageByKey(tx, tenantId, ins['id'], sha);
        if (same) return dup(same.id, 'message_key');
      }
    }

    // 8 archive
    const stored = await repo.insertMessage(tx, tenantId, { instrument_id: ins['id'], centre_id: ins['centre_id'], agent_id: agentId, agent_message_id: amid, protocol: ins['protocol'],
      message_kind: m['kind'], message_key: key, message_key_kind: keyKind, message_control_id: controlId ?? null, raw_bytes: raw, raw_sha256: sha, size_bytes: raw.length,
      captured_at_agent: m['captured_at_agent'], agent_clock_offset_ms: m['clock_offset_ms'], captured_at: captured, link_meta: cleanMeta(m['link_meta']), warnings, created_by: agentId });
    const messageId = stored.id; const receivedAt = iso(stored.received_at);

    // 9 run outcome
    const live = ins['state'] === 'live';
    const outcome: 'quarantined' | 'shadow' | 'parsed' = quarantine ? 'quarantined' : live ? 'parsed' : 'shadow';
    const counters = { patient_records: 0, qc_records: 0, calibrator_records: 0, host_query_records: 0, unmapped_records: 0, skipped_no_barcode_records: 0, emitted_events: 0, skipped_records: 0 };
    const records: Row[] = []; const observed = new Map<string, Row>();
    let statusOffset: number | undefined;

    // 10-11 records, keys, mapping, validation, events
    if (parsed && !quarantine) {
      const tz = ins['timezone'];
      const utc = (local: string | undefined) => { if (!local) return undefined; try { return localToUtc(local, tz); } catch { return undefined; } };
      const messageUtc = utc(parsed.messageTimeLocal);
      if (messageUtc) statusOffset = instrumentClockOffsetSeconds(messageUtc, captured);
      for (const r of parsed.records) {
        const cls = r.recordClass;
        const row: Row = { centre_id: ins['centre_id'], message_id: messageId, instrument_id: ins['id'], record_seq: r.recordSeq, record_class: cls, created_by: agentId, warnings: [] as string[] };
        records.push(row);
        const bad: string[] = [];
        if (cls === 'host_query') { counters.host_query_records++; row['emit_status'] = 'not_applicable'; continue; }
        if (cls === 'calibrator') {
          counters.calibrator_records++;
          if (!driver.capabilities.calibration) { row['emit_status'] = 'not_applicable'; continue; }   // B2: generic drivers never emit calibration
          const code = r.instrumentAnalyteCode; const codeOk = within(code, 1, 64);
          if (!codeOk) bad.push('instrument_analyte_code');
          if (r.calibratorIdRaw !== undefined && !within(r.calibratorIdRaw, 1, 64)) bad.push('calibrator_id_raw');
          if (r.calibratorLotRaw !== undefined && !within(r.calibratorLotRaw, 1, 64)) bad.push('calibrator_lot_raw');
          const resultUtc = utc(r.instrumentResultTimeLocal);
          if (r.instrumentResultTimeLocal && !resultUtc) bad.push('instrument_result_time');
          const mapping = codeOk ? await mapCode(B, ins['id'], code) : undefined;
          let status = bad.length ? 'skipped_invalid' : outcome === 'parsed' ? 'emit' : 'shadow'; let eventId: string | undefined; let resultKey: string | undefined;
          if (status !== 'skipped_invalid') {
            const payload: Row = { instrument_message_id: messageId, instrument_id: ins['id'], centre_id: ins['centre_id'], instrument_analyte_code: code, mapping_status: mapping!.status,
              ...(mapping!.analyteId ? { analyte_id: mapping!.analyteId } : {}), ...(mapping!.testId ? { test_id: mapping!.testId } : {}),
              ...(r.calibratorIdRaw !== undefined ? { calibrator_id_raw: r.calibratorIdRaw } : {}), ...(r.calibratorLotRaw !== undefined ? { calibrator_lot_raw: r.calibratorLotRaw } : {}),
              ...(resultUtc ? { instrument_result_time: resultUtc } : {}), received_at: receivedAt };
            resultKey = calibrationIdempotencyKey(payload, sha);
            if (status === 'emit') {
              const out = await B.events.calibrationReceived(ctx, payload, { rawSha256: sha });
              eventId = out.eventId; status = out.duplicate ? 'duplicate_event' : 'emitted';
              if (status === 'emitted') counters.emitted_events++;
            }
          } else counters.skipped_records++;
          Object.assign(row, { instrument_analyte_code: codeOk ? code : null, mapping_status: mapping?.status ?? null, analyte_id: mapping?.analyteId ?? null, test_id: mapping?.testId ?? null,
            instrument_result_time: resultUtc ?? null, result_key_sha256: resultKey ? sha256(resultKey) : null, emit_status: status, event_id: eventId ?? null,
            warnings: [...bad.map((f) => `invalid_field:${f}`), ...r.warnings.filter((w) => SAFE_WARNING.test(w))].slice(0, 20) });
          continue;
        }
        if (cls !== 'patient' && cls !== 'qc') { row['emit_status'] = 'not_applicable'; continue; }
        if (cls === 'patient') counters.patient_records++; else counters.qc_records++;

        const code = r.instrumentAnalyteCode;
        const codeOk = within(code, 1, 64);
        if (!codeOk) bad.push('instrument_analyte_code');
        const barcode = r.sampleBarcode ? r.sampleBarcode : undefined;
        const controlId = cls === 'qc' ? (r.controlIdRaw || r.sampleBarcode || undefined) : undefined;
        const flags = r.instrumentFlags ?? [];
        const flagsOk = flags.length <= 20 && flags.every((f) => typeof f === 'string' && f.length <= 16);
        if (cls === 'patient') {
          if (barcode !== undefined && barcode.length > 40) bad.push('sample_barcode');
          if (r.valueRaw !== undefined && r.valueRaw.length > 200) bad.push('value_raw');
          if (r.recordKind === undefined) bad.push('record_kind');
        } else {
          if (!within(controlId, 1, 64)) bad.push('control_id_raw');
          if (!within(r.valueRaw, 1, 64)) bad.push('value_raw');
          if (r.controlLotRaw !== undefined && r.controlLotRaw.length > 64) bad.push('control_lot_raw');
          if (r.controlLevel !== undefined && r.controlLevel.length > 16) bad.push('control_level');
        }
        if (r.unitRaw !== undefined && r.unitRaw.length > 32) bad.push('unit_raw');
        if (!flagsOk) bad.push('instrument_flags');
        const inline = cls === 'patient' && r.recordKind === 'attachment' ? r.inlineAttachment : undefined;      // CR-C7-015: ignored on any other record
        const inlineB64 = inline?.base64;
        if (inline && !(typeof inlineB64 === 'string' && inlineB64.length > 0 && inlineB64.length % 4 === 0 && B64.test(inlineB64))) bad.push('inline_attachment');

        const mapping = codeOk ? await mapCode(B, ins['id'], code) : undefined;
        if (mapping?.status === 'unmapped') counters.unmapped_records++;
        if (codeOk) {
          const ok = `${cls}\u0000${code}`; const o = observed.get(ok);
          if (o) o['count']++;
          else observed.set(ok, { centre_id: ins['centre_id'], instrument_id: ins['id'], record_class: cls, instrument_analyte_code: code, mapping_status: mapping!.status, analyte_id: mapping!.analyteId ?? null, count: 1, actor_id: agentId });
        }

        const resultUtc = utc(r.instrumentResultTimeLocal);
        if (r.instrumentResultTimeLocal && !resultUtc) bad.push('instrument_result_time');
        const refUtc = resultUtc ?? messageUtc;
        const offset = refUtc ? instrumentClockOffsetSeconds(refUtc, captured) : undefined;
        if (statusOffset === undefined && offset !== undefined) statusOffset = offset;
        const numeric = r.valueRaw !== undefined ? toDecimalString(r.valueRaw) : undefined;

        let status: string;
        if (bad.length) status = 'skipped_invalid';
        else if (cls === 'patient' && !barcode) status = 'skipped_no_barcode';
        else status = outcome === 'parsed' ? 'emit' : 'shadow';

        let eventId: string | undefined; let resultKey: string | undefined;
        let attachment: Row | undefined; const upWarnings: string[] = [];
        if (inline && status === 'emit') {                    // shadow instruments store nothing (no object without an event)
          if (!ctx.uploads) throw new LimsError('common.internal');                                  // fail closed: retry, never a silent drop
          const id = uuidv7(); const now = new Date(ctx.now?.() ?? new Date());
          const objectPath = `${tenantId}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${id}.${ATT_EXT[inline.mimeType] ?? 'bin'}`;   // [CONV] scanned clean here, so not under the q/ prefix of E06
          try {
            const up = await ctx.uploads.accept({ filename: `${id}.${ATT_EXT[inline.mimeType] ?? 'bin'}`, mimeType: inline.mimeType, bytes: Buffer.from(inlineB64!, 'base64') },
              { allow: ATT_ALLOW, maxBytes: Math.min(B.maxBytes, ATT_MAX_BYTES), bucket: ATT_BUCKET, objectPath, images: { reencode: true, stripMetadata: true }, scan: 'required' });
            if (up.scanState !== 'clean') {                                                          // scanner down: fail closed, retry the message
              await ctx.storage?.delete(ATT_BUCKET, up.objectPath).catch(() => undefined);
              throw new LimsError('common.internal');
            }
            attachment = { bucket: up.bucket, object_path: up.objectPath, sha256: up.sha256, mime_type: up.mime };
          } catch (e) {
            const code = e instanceof LimsError ? e.code : undefined;
            if (!code || !ATT_REJECT.includes(code)) throw e;
            status = code === 'common.upload_quarantined' ? 'quarantined_attachment' : 'skipped_invalid'; upWarnings.push(code);   // the message stays accepted: a retry cannot succeed
          }
        }
        if (status === 'emit' || status === 'shadow') {
          const common: Row = { instrument_message_id: messageId, instrument_id: ins['id'], centre_id: ins['centre_id'], instrument_analyte_code: code, mapping_status: mapping!.status,
            ...(mapping!.analyteId ? { analyte_id: mapping!.analyteId } : {}), ...(r.valueRaw !== undefined ? { value_raw: r.valueRaw } : {}), ...(numeric ? { value_numeric: numeric } : {}),
            ...(r.unitRaw !== undefined ? { unit_raw: r.unitRaw } : {}), instrument_flags: [...flags], ...(resultUtc ? { instrument_result_time: resultUtc } : {}), received_at: receivedAt, captured_at: captured };
          let payload: Row;
          if (cls === 'patient') {
            payload = { ...common, agent_id: agentId, protocol: ins['protocol'], sample_barcode: barcode, record_kind: r.recordKind,
              ...(mapping!.testId ? { test_id: mapping!.testId } : {}), ...(offset !== undefined ? { instrument_clock_offset_seconds: offset } : {}), is_rerun: r.isRerun ?? false,
              ...(r.organism ? { organism: mapOrganism(r.organism) } : {}), ...(r.ast ? { ast: mapAst(r.ast) } : {}), ...(attachment ? { attachment } : {}) };
            resultKey = resultIdempotencyKey(payload);
          } else {
            payload = { ...common, control_id_raw: controlId, ...(r.controlLotRaw !== undefined ? { control_lot_raw: r.controlLotRaw } : {}), ...(r.controlLevel !== undefined ? { control_level: r.controlLevel } : {}) };
            resultKey = qcIdempotencyKey(payload, sha);
          }
          if (status === 'emit') {
            const out = cls === 'patient' ? await B.events.resultReceived(ctx, payload) : await B.events.qcReceived(ctx, payload, { rawSha256: sha });
            eventId = out.eventId; status = out.duplicate ? 'duplicate_event' : 'emitted';
            if (status === 'emitted') counters.emitted_events++;
            else if (attachment) await ctx.storage?.delete(ATT_BUCKET, attachment['object_path']).catch(() => undefined);   // the first event keeps its own object
          }
        }
        if (status === 'skipped_invalid' || status === 'quarantined_attachment') counters.skipped_records++;
        else if (status === 'skipped_no_barcode' && mapping?.status === 'mapped') counters.skipped_no_barcode_records++;

        const rowWarnings = [...bad.map((f) => `invalid_field:${f}`), ...upWarnings, ...r.warnings.filter((w) => SAFE_WARNING.test(w))].slice(0, 20);
        Object.assign(row, { sample_barcode: fit(r.sampleBarcode, 40) ?? null, control_id_raw: cls === 'qc' ? fit(controlId, 64) ?? null : null, control_lot_raw: fit(r.controlLotRaw, 64) ?? null,
          control_level: fit(r.controlLevel, 16) ?? null, record_kind: r.recordKind ?? null, instrument_analyte_code: codeOk ? code : null, mapping_status: mapping?.status ?? null,
          analyte_id: mapping?.analyteId ?? null, test_id: mapping?.testId ?? null, value_raw: fit(r.valueRaw, 200) ?? null, value_numeric: numeric ?? null, unit_raw: fit(r.unitRaw, 32) ?? null,
          instrument_flags: flagsOk ? [...flags] : [], instrument_result_time: resultUtc ?? null, instrument_clock_offset_seconds: offset ?? null, is_rerun: cls === 'patient' ? (r.isRerun ?? false) : null,
          organism: r.organism ? mapOrganism(r.organism) : undefined, ast: r.ast ? mapAst(r.ast) : undefined, result_key_sha256: resultKey ? sha256(resultKey) : null,
          emit_status: status, event_id: eventId ?? null, warnings: rowWarnings });
      }
    }

    // 12 run + records (final values), observed codes, instrument status
    const run = await repo.insertRun(tx, tenantId, { centre_id: ins['centre_id'], message_id: messageId, run_no: 1, kind: 'live', driver_code: driver.code, driver_version: driver.version.slice(0, 32), outcome,
      error_code: quarantine?.runCode ?? null, error_reason: null, ...counters, actor_type: 'device', created_by: agentId });
    if (records.length) await repo.insertRecords(tx, tenantId, records.map((r) => ({ ...r, run_id: run.id })));
    if (observed.size) await repo.upsertObservedCodes(tx, tenantId, [...observed.values()]);
    await repo.recordInstrumentActivity(tx, tenantId, ins['id'], { lastMessageAt: receivedAt, lastMessageAtAgent: iso(m['captured_at_agent']), instrumentClockOffsetSeconds: statusOffset ?? null, actorId: agentId });

    // 13
    return quarantine
      ? res('quarantined', { instrument_message_id: messageId, ...(quarantine.respCode ? { error_code: quarantine.respCode } : {}) })
      : res('accepted', { instrument_message_id: messageId });
  }

  return {
    /** E04 — `body` is the snake_case request body. Envelope problems throw; everything per message is an outcome. */
    async submitMessageBatch(ctx: IngestCtx, input: { body?: unknown }): Promise<DeviceResult> {
      const sc = deviceScope(ctx, 'device_token');
      const messages = obj(input?.body)['messages'];
      if (!Array.isArray(messages) || messages.length < 1) throw new LimsError('common.validation_failed');
      if (messages.length > MAX_MESSAGES) throw new LimsError('instruments.batch_too_large');
      const budget = deps.budgetMs ?? conf().batchTimeBudgetMs;
      const B: Batch = { ctx, tx: ctx.tx, tenantId: sc.tenantId, agentId: sc.agentId, events: createInstrumentEvents(ctx.events), mappings: new Map(), maxBytes: deps.maxMessageBytes ?? conf().maxMessageBytes };
      eventValidators();                                   // first-call schema compile is slow: keep it out of the 8 s message budget
      const started = monotonicMs();
      const results: Row[] = [];
      for (const raw of messages) {
        const m = obj(raw);
        const amid = String(m['agent_message_id']);
        if (monotonicMs() - started >= budget) { results.push({ agent_message_id: amid, outcome: 'retry' }); continue; }
        try {
          results.push(await (ctx.tx as { savepoint<T>(fn: (t: unknown) => Promise<T>): Promise<T> }).savepoint((t) => processOne({ ...B, tx: t }, m)));
        } catch (e) {
          // request id + message id + error code only: the error text may carry PHI (a driver, a DB constraint)
          ctx.log?.error({ event: 'ingest_message_failed', request_id: ctx.requestId, agent_message_id: amid, error_code: e instanceof LimsError ? e.code : 'unexpected' }, 'ingest_message_failed');
          results.push({ agent_message_id: amid, outcome: 'retry', error_code: 'common.internal' });
        }
      }
      for (const r of results) ctx.metrics?.inc('lims_instruments_ingest_messages_total', { outcome: r['outcome'] });
      return { status: 200, body: { server_time: iso(ctx.now?.() ?? new Date()), results } };
    },
  };
}
export type IngestService = ReturnType<typeof createIngestService>;
