// E38 reprocessInstrumentMessage, E39 rematchInstrumentRecord (02-TRD §6.7; 01-PRD AC-19.1..AC-19.5; 07-SECURITY AB11, REQ-SEC-096/097/098, 02-CV §9.2).
// A reprocess / re-match is a NEW processing run (class A: INSERT only). Per patient record, inside ONE savepoint: LabPort.ingestInstrumentResult first, then the event
// (C5 then sees `duplicate`); a LimsError from the port rolls back that record only and is shown on it. One access_log row on ctx.tx (fails closed).
// Logs and metrics carry codes and ids only: never a barcode, value, reason text or raw byte.
import { createHash } from 'node:crypto';
import { LimsError } from '../../../core/errors.js';
import { toDecimalString } from '../domain/decimal.js';
import { instrumentClockOffsetSeconds, localToUtc } from '../domain/instrumentTime.js';
import { getDriver as registryGetDriver } from '../drivers/registry.js';
import type { DriverContext, InstrumentDriver } from '../drivers/types.js';
import { createInstrumentEvents, qcIdempotencyKey, resultIdempotencyKey, type EventsPort } from '../events/publish.js';
import { createReprocessRepo, type ReprocessRepo } from '../repo/reprocess.repo.js';
import { fail, isUuid, scope } from './agents.service.js';
import { fit, mapAst, mapOrganism, qcPatterns, within } from './ingest.service.js';
import { toRecord, toRun, type MessagesCtx } from './messages.service.js';

type Row = Record<string, any>;
export interface ReprocessCtx extends MessagesCtx {
  readonly events: EventsPort;
  readonly ports?: {
    readonly IdentityPort?: { assertRole(ctx: unknown, r: { permission: string; centreId?: string }): Promise<unknown> };
    readonly CatalogPort?: { mapInstrumentCode(ctx: unknown, input: { instrumentId: string; direction: 'inbound'; instrumentCode: string }): Promise<Row> };
    readonly LabPort?: { ingestInstrumentResult(ctx: unknown, input: Row): Promise<{ outcome: string; resultId?: string; reasonCode?: string }> };
  };
  readonly audit?: { access(e: { action: string; entityType: string; entityId?: string; centreId?: string; outcome: 'allowed' | 'denied'; detail?: Record<string, string | number | boolean> }): Promise<void> };
  readonly metrics?: { inc(name: string, labels?: Record<string, string>): void };
}
export interface ReprocessDeps { repo?: ReprocessRepo; getDriver?: (code: string) => InstrumentDriver | undefined }
type Kind = 'reprocess' | 'rematch';
/** one record of the new run: `send` = live, goes to the port (patient) / the event stream; the final emit_status is set by `execute` */
interface Item { row: Row; cls: string; send: boolean; payload?: Row; rawKey?: string }

const PERM = 'instruments.message.rematch';
const REASONS = ['driver_fixed', 'mapping_added', 'quarantine_reviewed', 'barcode_keypad_error', 'barcode_label_misread', 'instrument_resent_wrong_id', 'other'];
const BARCODE = /^[A-Z0-9]{1,40}$/;
const ELIGIBLE_LATEST = ['quarantined', 'shadow', 'parsed'];
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const iso = (v: unknown) => new Date(v as string).toISOString();
const plain = (v: unknown): Row | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Row) : undefined);
const camel = (p: Row): Row => Object.fromEntries(Object.entries(p).map(([k, v]) => [k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase()), v]));
const newCounters = (): Row => ({ patient_records: 0, qc_records: 0, calibrator_records: 0, host_query_records: 0, unmapped_records: 0, skipped_no_barcode_records: 0, emitted_events: 0, skipped_records: 0 });
const notAllowed = () => new LimsError('instruments.reprocess_not_allowed');

/** snake_case request body: only the allowed keys, coded reason, reason_text <= 300, re-match barcode ^[A-Z0-9]{1,40}$. Errors name the field, never echo a value. */
function parseBody(raw: unknown, rematch: boolean): Row {
  const b = plain(raw) ?? fail('/');
  const keys = rematch ? ['sample_barcode', 'reason_code', 'reason_text'] : ['reason_code', 'reason_text'];
  if (Object.keys(b).some((k) => !keys.includes(k))) fail('/');
  if (typeof b['reason_code'] !== 'string' || !REASONS.includes(b['reason_code'])) fail('/reason_code');
  if (b['reason_text'] !== undefined && (typeof b['reason_text'] !== 'string' || b['reason_text'].length > 300)) fail('/reason_text');
  if (rematch && (typeof b['sample_barcode'] !== 'string' || !BARCODE.test(b['sample_barcode']))) fail('/sample_barcode');
  return b;
}

export function createReprocessService(deps: ReprocessDeps = {}) {
  const repo = deps.repo ?? createReprocessRepo();
  const getDriver = deps.getDriver ?? registryGetDriver;

  /** BOLA: RLS-visible row of the caller's tenant, else 404; then assertRole at the MESSAGE's centre (404 before 403). */
  async function loadMessage(s: ReturnType<typeof scope>, id: unknown): Promise<Row> {
    if (!isUuid(id)) throw new LimsError('common.not_found');
    const msg = await repo.findMessage(s.tx, s.tenantId, id);
    if (!msg || msg['tenant_id'] !== s.tenantId) throw new LimsError('common.not_found');
    await s.assert(PERM, msg['centre_id']);
    return msg;
  }
  const driverOf = (msg: Row): InstrumentDriver => getDriver(String(msg['driver_code'])) ?? ((): never => { throw new LimsError('instruments.driver_not_available'); })();
  const sinkOf = (ctx: ReprocessCtx) => { if (typeof ctx.audit?.access !== 'function') throw new LimsError('common.internal'); };   // fail closed: no audit sink, no work

  async function mapCode(ctx: ReprocessCtx, cache: Map<string, Row>, instrumentId: string, code: string): Promise<Row> {
    const hit = cache.get(code);
    if (hit) return hit;
    const port = ctx.ports?.CatalogPort;
    if (!port) throw new LimsError('common.internal');
    let m: Row;
    try {
      const r = await port.mapInstrumentCode(ctx, { instrumentId, direction: 'inbound', instrumentCode: code });
      m = { status: 'mapped', ...(isUuid(r['analyteId']) ? { analyteId: r['analyteId'] } : {}), ...(isUuid(r['testId']) ? { testId: r['testId'] } : {}) };
    } catch (e) {
      if ((e as { code?: unknown })?.code !== 'catalog.instrument_code_unmapped') throw e;
      m = { status: 'unmapped' };
    }
    cache.set(code, m);
    return m;
  }

  /** E38: the archived bytes parsed with the CURRENT driver -> items. */
  async function itemsFromParse(ctx: ReprocessCtx, msg: Row, driver: InstrumentDriver, raw: Buffer, rawSha: string, live: boolean, actorId: string) {
    const counters = newCounters(); const items: Item[] = [];
    const captured = iso(msg['captured_at'] ?? msg['received_at']);
    const tz = msg['timezone'];
    const dctx: DriverContext = { receivedAt: iso(msg['received_at']) as DriverContext['receivedAt'], capturedAt: captured as DriverContext['capturedAt'], instrumentTimezone: tz,
      qcSampleIdPatterns: qcPatterns(msg['qc_sample_id_patterns']), options: plain(msg['parser_options']) ?? {} };
    let parsed;
    try { const pr = driver.parse(raw, dctx); parsed = pr.ok ? pr : undefined; } catch { parsed = undefined; }       // a driver bug on hostile bytes is a quarantine, never a 5xx
    if (!parsed) return { items, counters, quarantined: true };
    const utc = (local: string | undefined) => { if (!local) return undefined; try { return localToUtc(local, tz); } catch { return undefined; } };
    const messageUtc = utc(parsed.messageTimeLocal);
    const cache = new Map<string, Row>();
    for (const r of parsed.records) {
      const cls = r.recordClass;
      const row: Row = { centre_id: msg['centre_id'], message_id: msg['id'], instrument_id: msg['instrument_id'], record_seq: r.recordSeq, record_class: cls, created_by: actorId, warnings: [] as string[] };
      const it: Item = { row, cls, send: false }; items.push(it);
      if (cls === 'host_query') { counters['host_query_records']++; row['emit_status'] = 'not_applicable'; continue; }
      if (cls === 'calibrator') { counters['calibrator_records']++; row['emit_status'] = 'not_applicable'; continue; }   // ponytail: calibration event is API-T16
      if (cls !== 'patient' && cls !== 'qc') { row['emit_status'] = 'not_applicable'; continue; }
      counters[cls === 'patient' ? 'patient_records' : 'qc_records']++;

      const bad: string[] = [];
      const code = r.instrumentAnalyteCode; const codeOk = within(code, 1, 64);
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
      const mapping = codeOk ? await mapCode(ctx, cache, msg['instrument_id'], code) : undefined;
      if (mapping?.['status'] === 'unmapped') counters['unmapped_records']++;
      const resultUtc = utc(r.instrumentResultTimeLocal);
      if (r.instrumentResultTimeLocal && !resultUtc) bad.push('instrument_result_time');
      const refUtc = resultUtc ?? messageUtc;
      const offset = refUtc ? instrumentClockOffsetSeconds(refUtc, captured) : undefined;
      const numeric = r.valueRaw !== undefined ? toDecimalString(r.valueRaw) : undefined;

      let status: string;
      if (bad.length) status = 'skipped_invalid';
      else if (cls === 'patient' && !barcode) status = 'skipped_no_barcode';
      else status = live ? 'emit' : 'shadow';
      if (status === 'skipped_invalid') counters['skipped_records']++;
      else if (status === 'skipped_no_barcode' && mapping?.['status'] === 'mapped') counters['skipped_no_barcode_records']++;

      let resultKey: string | undefined;
      if (status === 'emit' || status === 'shadow') {
        const common: Row = { instrument_message_id: msg['id'], instrument_id: msg['instrument_id'], centre_id: msg['centre_id'], instrument_analyte_code: code, mapping_status: mapping!['status'],
          ...(mapping!['analyteId'] ? { analyte_id: mapping!['analyteId'] } : {}), ...(r.valueRaw !== undefined ? { value_raw: r.valueRaw } : {}), ...(numeric ? { value_numeric: numeric } : {}),
          ...(r.unitRaw !== undefined ? { unit_raw: r.unitRaw } : {}), instrument_flags: [...flags], ...(resultUtc ? { instrument_result_time: resultUtc } : {}),
          received_at: iso(msg['received_at']), captured_at: captured, processing_kind: 'reprocess' };
        let payload: Row;
        if (cls === 'patient') {
          payload = { ...common, agent_id: msg['agent_id'], protocol: msg['protocol'], sample_barcode: barcode, record_kind: r.recordKind,
            ...(mapping!['testId'] ? { test_id: mapping!['testId'] } : {}), ...(offset !== undefined ? { instrument_clock_offset_seconds: offset } : {}), is_rerun: r.isRerun ?? false,
            ...(r.organism ? { organism: mapOrganism(r.organism) } : {}), ...(r.ast ? { ast: mapAst(r.ast) } : {}) };
          resultKey = resultIdempotencyKey(payload);
        } else {
          payload = { ...common, control_id_raw: controlId, ...(r.controlLotRaw !== undefined ? { control_lot_raw: r.controlLotRaw } : {}), ...(r.controlLevel !== undefined ? { control_level: r.controlLevel } : {}) };
          resultKey = qcIdempotencyKey(payload, rawSha);
        }
        if (status === 'emit') { it.send = true; it.payload = payload; }
      }
      Object.assign(row, { sample_barcode: fit(r.sampleBarcode, 40) ?? null, control_id_raw: cls === 'qc' ? fit(controlId, 64) ?? null : null, control_lot_raw: fit(r.controlLotRaw, 64) ?? null,
        control_level: fit(r.controlLevel, 16) ?? null, record_kind: r.recordKind ?? null, instrument_analyte_code: codeOk ? code : null, mapping_status: mapping?.['status'] ?? null,
        analyte_id: mapping?.['analyteId'] ?? null, test_id: mapping?.['testId'] ?? null, value_raw: fit(r.valueRaw, 200) ?? null, value_numeric: numeric ?? null, unit_raw: fit(r.unitRaw, 32) ?? null,
        instrument_flags: flagsOk ? [...flags] : [], instrument_result_time: resultUtc ?? null, instrument_clock_offset_seconds: offset ?? null, is_rerun: cls === 'patient' ? (r.isRerun ?? false) : null,
        organism: r.organism ? mapOrganism(r.organism) : undefined, ast: r.ast ? mapAst(r.ast) : undefined, result_key_sha256: resultKey ? sha256(resultKey) : null, emit_status: status,
        warnings: [...bad.map((f) => `invalid_field:${f}`), ...r.warnings.filter((w) => /^[a-z0-9_.:-]{1,64}$/i.test(w))].slice(0, 20) });
    }
    return { items, counters, quarantined: false };
  }

  /** E39: ONE derived record (new barcode, mapping and values copied from the stored record, source_record_id set). */
  function itemFromRecord(msg: Row, src: Row, barcode: string, live: boolean, actorId: string) {
    const counters = newCounters(); counters['patient_records'] = 1;
    if (src['mapping_status'] === 'unmapped') counters['unmapped_records'] = 1;
    const resultUtc = src['instrument_result_time'] ? iso(src['instrument_result_time']) : undefined;
    const flags: string[] = src['instrument_flags'] ?? [];
    const offset = src['instrument_clock_offset_seconds'] ?? undefined;
    const payload: Row = { instrument_message_id: msg['id'], instrument_id: msg['instrument_id'], centre_id: msg['centre_id'], instrument_analyte_code: src['instrument_analyte_code'], mapping_status: src['mapping_status'],
      ...(src['analyte_id'] ? { analyte_id: src['analyte_id'] } : {}), ...(src['value_raw'] != null ? { value_raw: src['value_raw'] } : {}), ...(src['value_numeric'] != null ? { value_numeric: src['value_numeric'] } : {}),
      ...(src['unit_raw'] != null ? { unit_raw: src['unit_raw'] } : {}), instrument_flags: [...flags], ...(resultUtc ? { instrument_result_time: resultUtc } : {}), received_at: iso(msg['received_at']),
      captured_at: iso(msg['captured_at'] ?? msg['received_at']), agent_id: msg['agent_id'], protocol: msg['protocol'], sample_barcode: barcode, record_kind: src['record_kind'],
      ...(src['test_id'] ? { test_id: src['test_id'] } : {}), ...(offset !== undefined ? { instrument_clock_offset_seconds: offset } : {}), is_rerun: src['is_rerun'] ?? false,
      ...(src['organism'] ? { organism: src['organism'] } : {}), ...(src['ast'] ? { ast: src['ast'] } : {}), processing_kind: 'rematch', source_record_id: src['id'] };
    const row: Row = { centre_id: msg['centre_id'], message_id: msg['id'], instrument_id: msg['instrument_id'], record_seq: src['record_seq'], record_class: 'patient', sample_barcode: barcode, control_id_raw: null,
      control_lot_raw: null, control_level: null, record_kind: src['record_kind'], instrument_analyte_code: src['instrument_analyte_code'], mapping_status: src['mapping_status'], analyte_id: src['analyte_id'] ?? null,
      test_id: src['test_id'] ?? null, value_raw: src['value_raw'] ?? null, value_numeric: src['value_numeric'] ?? null, unit_raw: src['unit_raw'] ?? null, instrument_flags: [...flags],
      instrument_result_time: resultUtc ?? null, instrument_clock_offset_seconds: offset ?? null, is_rerun: src['is_rerun'] ?? false, organism: src['organism'] ?? undefined, ast: src['ast'] ?? undefined,
      result_key_sha256: sha256(resultIdempotencyKey(payload)), emit_status: live ? 'emit' : 'shadow', source_record_id: src['id'], warnings: [], created_by: actorId };
    return { items: [{ row, cls: 'patient', send: live, ...(live ? { payload } : {}) } as Item], counters };
  }

  /** port + event per record, then the run and its records (final values), then the access_log row. All on ctx.tx. */
  async function execute(ctx: ReprocessCtx, s: ReturnType<typeof scope>, msg: Row, o: { kind: Kind; runNo: number; body: Row; driver: { code: string; version: string }; outcome: string; errorCode?: string;
    items: Item[]; counters: Row; rawSha?: string; detail?: Record<string, string> }) {
    const events = createInstrumentEvents(ctx.events);
    const tx = ctx.tx as { savepoint<T>(fn: (t: unknown) => Promise<T>): Promise<T> };
    const lab = ctx.ports?.LabPort;
    for (const it of o.items) {
      if (!it.send) continue;
      if (it.cls === 'qc') {
        const out = await events.qcReceived(ctx, it.payload!, { rawSha256: o.rawSha ?? '' });
        it.row['event_id'] = out.eventId; it.row['emit_status'] = out.duplicate ? 'duplicate_event' : 'emitted';
        if (!out.duplicate) o.counters['emitted_events']++;
        continue;
      }
      if (!lab) throw new LimsError('common.internal');
      let portError: LimsError | undefined;
      try {
        const done = await tx.savepoint(async () => {
          let pr: Awaited<ReturnType<typeof lab.ingestInstrumentResult>>;
          try { pr = await lab.ingestInstrumentResult(ctx, camel(it.payload!)); } catch (e) { if (e instanceof LimsError) portError = e; throw e; }
          return { pr, out: await events.resultReceived(ctx, it.payload!) };
        });
        Object.assign(it.row, { port_outcome: done.pr.outcome, port_reason_code: done.pr.reasonCode ?? null, port_result_id: done.pr.resultId ?? null, event_id: done.out.eventId,
          emit_status: done.out.duplicate ? 'duplicate_event' : 'emitted' });
        if (!done.out.duplicate) o.counters['emitted_events']++;
        ctx.metrics?.inc('lims_instruments_reprocess_total', { kind: o.kind, port_outcome: done.pr.outcome });
      } catch (e) {
        if (!portError || e !== portError) throw e;                                        // anything but the port's own LimsError fails the request
        Object.assign(it.row, { port_reason_code: portError.code.slice(0, 64), emit_status: 'not_applicable' });   // [CONV] no value reached C5 and no event: nothing was applied
        ctx.metrics?.inc('lims_instruments_reprocess_total', { kind: o.kind, port_outcome: 'error' });
      }
    }
    const runRow: Row = { centre_id: msg['centre_id'], message_id: msg['id'], run_no: o.runNo, kind: o.kind, driver_code: o.driver.code, driver_version: o.driver.version.slice(0, 32), outcome: o.outcome,
      error_code: o.errorCode ?? null, error_reason: null, ...o.counters, reason_code: o.body['reason_code'], ...(o.body['reason_text'] !== undefined ? { reason_text: o.body['reason_text'] } : {}),
      actor_type: 'user', created_by: s.actorId };
    const run = await repo.insertRun(s.tx, s.tenantId, runRow);
    const stored = o.items.length ? await repo.insertRecords(s.tx, s.tenantId, o.items.map((i) => ({ ...i.row, run_id: run.id }))) : [];
    await ctx.audit!.access({ action: `instrument_message.${o.kind}`, entityType: 'instrument_message', entityId: msg['id'], centreId: msg['centre_id'], outcome: 'allowed', ...(o.detail ? { detail: o.detail } : {}) });
    return {
      run: toRun({ ...runRow, id: run.id, created_at: new Date(ctx.now?.() ?? new Date()).toISOString() }),
      records: stored.map((r, i) => toRecord({ ...o.items[i]!.row, ...r, run_no: o.runNo })),
    };
  }

  return {
    /** E38 — AC-19.1, AC-19.3, AC-19.4 */
    async reprocessInstrumentMessage(ctx: ReprocessCtx, input: { instrumentMessageId?: unknown; body?: unknown } = {}) {
      const s = scope(ctx); sinkOf(ctx);
      const msg = await loadMessage(s, input?.instrumentMessageId);
      const latest = plain(msg['latest_run']) ?? {};
      if (msg['message_kind'] === 'host_query' || msg['instrument_state'] === 'retired' || !ELIGIBLE_LATEST.includes(latest['outcome'])) throw notAllowed();
      const body = parseBody(input?.body, false);
      const driver = driverOf(msg);
      const raw = await repo.getMessageRawBytes(s.tx, s.tenantId, msg['id']);
      if (!raw || raw['tenant_id'] !== s.tenantId) throw new LimsError('common.not_found');
      const live = msg['instrument_state'] === 'live';
      const r = await itemsFromParse(ctx, msg, driver, Buffer.from(raw['raw_bytes']), raw['raw_sha256'], live, s.actorId);
      const res = await execute(ctx, s, msg, { kind: 'reprocess', runNo: Number(latest['run_no']) + 1, body, driver, outcome: r.quarantined ? 'quarantined' : live ? 'parsed' : 'shadow',
        ...(r.quarantined ? { errorCode: 'instruments.message_malformed' } : {}), items: r.items, counters: r.counters, rawSha: raw['raw_sha256'] });
      return { status: 200, body: { ...res, preview: !live } };                      // TRD E38: true when not live and nothing was sent
    },

    /** E39 — AC-19.2, AC-19.3, AC-19.5 */
    async rematchInstrumentRecord(ctx: ReprocessCtx, input: { recordId?: unknown; body?: unknown } = {}) {
      const s = scope(ctx); sinkOf(ctx);
      if (!isUuid(input?.recordId)) throw new LimsError('common.not_found');
      const src = await repo.findRecord(s.tx, s.tenantId, input.recordId);
      if (!src || src['tenant_id'] !== s.tenantId) throw new LimsError('common.not_found');
      const msg = await loadMessage(s, src['message_id']);
      const latest = plain(msg['latest_run']) ?? {};
      if (msg['message_kind'] === 'host_query' || msg['instrument_state'] === 'retired' || src['record_class'] !== 'patient' || Number(src['run_no']) !== Number(latest['run_no'])
        || !src['instrument_analyte_code'] || !src['record_kind']) throw notAllowed();          // ponytail: attachment-record re-match needs the attachments repo, 409 until then
      const body = parseBody(input?.body, true);
      if (body['sample_barcode'] === src['sample_barcode']) fail('/sample_barcode');           // AC-19.5: must differ (the error never echoes it)
      const driver = { code: String(src['run_driver_code']), version: String(src['run_driver_version']) };   // re-match parses nothing: the source run's driver
      const live = msg['instrument_state'] === 'live';
      const r = itemFromRecord(msg, src, body['sample_barcode'], live, s.actorId);
      const res = await execute(ctx, s, msg, { kind: 'rematch', runNo: Number(latest['run_no']) + 1, body, driver, outcome: live ? 'parsed' : 'shadow', items: r.items, counters: r.counters,
        detail: { record_id: src['id'] } });
      return { status: 200, body: { run: res.run, record: res.records[0] } };
    },
  };
}
export type ReprocessService = ReturnType<typeof createReprocessService>;
