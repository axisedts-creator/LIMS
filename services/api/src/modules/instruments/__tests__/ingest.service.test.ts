// C7 API-T09 — E04 submitMessageBatch pipeline (02-TRD §6.4/§6.5; AC-09.1–09.11, AC-11.1/1.1a/1.2, AC-14.2/14.3, S-02, S-08). Seams: ingest.helpers.ts header.
// DB = in-memory world with REAL savepoint semantics (rollback restores rows AND core.event_log); events = the REAL core createEvents (validates against contracts/events/*.schema.json);
// parsing = the REAL generic drivers (golden fixtures) unless a synthetic driver is needed. Real RLS / unique indexes / concurrent races are DB tests (db/tests), not here.
import { describe, expect, it } from 'vitest';
import { createIngestService } from '../service/ingest.service.js';
import { ASTM_PATIENT, ASTM_QC, HL7_ORU, INS, AGENT_A1, AGENT_A1B, AGENT_A2, MiB, NOW, REQ_ID, TENANT_A, batch, bytes, fakeDriver, idN, makeCatalog, makeIngestCtx, makeWorld, message, msgId, rec1, sha256hex, spyRegistry, type Row, type World } from './ingest.helpers.js';

const RESULT = 'instruments.result.received.v1', QC = 'instruments.qc.received.v1';
const T_RESULT = '2026-11-07T04:27:00.000Z';                       // R.13 10:12 local, Asia/Kathmandu (+05:45)
const KEY_GLU = `${INS(1)}:E2600000042:GLU:${T_RESULT}`;
const patient = (i: number) => ASTM_PATIENT.replace(/E2600000042/g, `E26000001${String(i).padStart(2, '0')}`);   // distinct barcode => distinct raw, message key and result keys

async function run(w: World, messages: Row[], deps: Record<string, unknown> = {}, o: Parameters<typeof makeIngestCtx>[1] = {}, body: Row = {}) {
  const c = makeIngestCtx(w, o);
  const svc = createIngestService({ repo: w.repo, ...deps } as any);
  const r = await svc.submitMessageBatch(c.ctx, { body: batch(messages, body) });
  return { r, c, res: r.body.results as Row[] };
}
const err = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection'); };

describe('envelope (AC-09.1)', () => {
  it('101 messages -> 413 instruments.batch_too_large and NOTHING is read or stored', async () => {
    const w = makeWorld(); const c = makeIngestCtx(w);
    const e = await err(createIngestService({ repo: w.repo } as any).submitMessageBatch(c.ctx, { body: batch(Array.from({ length: 101 }, (_, i) => message({ n: i + 1 })) ) }));
    expect(e.code).toBe('instruments.batch_too_large'); expect(w.calls).toEqual([]); expect(w.events).toEqual([]);
  });
  it('100 messages are accepted for processing; results come back in request order with server_time', async () => {
    const w = makeWorld(); const ms = Array.from({ length: 100 }, (_, i) => message({ n: i + 1, raw: patient(i) }));
    const { r, res } = await run(w, ms);
    expect(r.status).toBe(200); expect(typeof r.body.server_time).toBe('string');
    expect(res.map((x) => x['agent_message_id'])).toEqual(ms.map((m) => m['agent_message_id'])); expect(res.every((x) => x['outcome'] === 'accepted')).toBe(true);
  });
});

describe('happy path (AC-09.5, AC-14.2, AC-14.3) — live instrument, parsed ASTM message', () => {
  const go = async () => { const w = makeWorld(); const m = message({ n: 1 }); const x = await run(w, [m]); return { w, m, ...x }; };
  it('result accepted with instrument_message_id; archive row keeps raw bytes, sha256, key and corrected times', async () => {
    const { w, m, res } = await go();
    expect(res).toEqual([{ agent_message_id: m['agent_message_id'], outcome: 'accepted', instrument_message_id: w.messages[0]!['id'] }]);
    const row = w.messages[0]!;
    expect(Buffer.from(row['raw_bytes']).equals(bytes(ASTM_PATIENT))).toBe(true);
    expect(row).toMatchObject({ instrument_id: INS(1), agent_id: AGENT_A1, agent_message_id: m['agent_message_id'], protocol: 'astm', message_kind: 'data', raw_sha256: sha256hex(bytes(ASTM_PATIENT)), size_bytes: bytes(ASTM_PATIENT).length,
      message_key: sha256hex(bytes(ASTM_PATIENT)), message_key_kind: 'sha256', centre_id: w.deviceCentre, created_by: AGENT_A1 });
    expect(new Date(row['received_at']).toISOString()).toBe(NOW);
  });
  it('AC-14.2: captured_at = captured_at_agent + the MESSAGE clock_offset_ms (not the batch one); agent time and offset are stored as sent', async () => {
    const { w } = await go(); const row = w.messages[0]!;
    expect(new Date(row['captured_at_agent']).toISOString()).toBe('2026-11-07T04:26:50.000Z'); expect(row['agent_clock_offset_ms']).toBe(8000);
    expect(new Date(row['captured_at']).toISOString()).toBe('2026-11-07T04:26:58.000Z');
  });
  it('one live run (run_no 1, driver code/version) with FINAL counters, inserted ONCE after the events (class A: no later update)', async () => {
    const { w } = await go();
    expect(w.runs).toHaveLength(1);
    expect(w.runs[0]).toMatchObject({ message_id: w.messages[0]!['id'], run_no: 1, kind: 'live', outcome: 'parsed', driver_code: 'astm_generic_e1394', patient_records: 2, qc_records: 0, calibrator_records: 0, host_query_records: 0, unmapped_records: 1, skipped_no_barcode_records: 0, emitted_events: 2, skipped_records: 0 });
    expect(w.callsOf('insertRun')).toHaveLength(1); expect(w.callsOf('insertRecords')).toHaveLength(1);
    const o = w.order; expect(o.indexOf('insertMessage')).toBeLessThan(o.indexOf('event')); expect(o.lastIndexOf('event')).toBeLessThan(o.indexOf('insertRun')); expect(o.indexOf('insertRun')).toBeLessThan(o.indexOf('insertRecords'));
  });
  it('one message_records row per result record, final emit_status + event_id; result_key_sha256 instead of the key', async () => {
    const { w } = await go();
    expect(w.records).toHaveLength(2);
    const glu = w.records.find((r) => r['instrument_analyte_code'] === 'GLU')!;
    expect(glu).toMatchObject({ run_id: w.runs[0]!['id'], message_id: w.messages[0]!['id'], instrument_id: INS(1), record_class: 'patient', sample_barcode: 'E2600000042', value_raw: '5.4', value_numeric: '5.4', unit_raw: 'mmol/L', emit_status: 'emitted', mapping_status: 'mapped', result_key_sha256: sha256hex(KEY_GLU) });
    expect(glu['event_id']).toBe(w.eventsOf(RESULT).find((e) => e['payload'].instrument_analyte_code === 'GLU')!['event_id']);
    expect(w.records.map((r) => r['instrument_result_time'] && new Date(r['instrument_result_time']).toISOString())).toEqual([T_RESULT, T_RESULT]);
    expect(JSON.stringify(w.records)).not.toContain(KEY_GLU);
  });
  it('one instruments.result.received.v1 per record: key <instrument>:<barcode>:<code>:<time>, aggregate instrument_message/messages.id/1, device actor, payload per §6.5 (no unit_code in Phase 1)', async () => {
    const { w } = await go(); const evs = w.eventsOf(RESULT);
    expect(evs).toHaveLength(2); expect(w.eventsOf(QC)).toHaveLength(0);
    const e = evs.find((x) => x['payload'].instrument_analyte_code === 'GLU')!;
    expect(e).toMatchObject({ producer: 'instruments', tenant_id: TENANT_A, idempotency_key: KEY_GLU, request_id: REQ_ID, actor: { type: 'device', id: AGENT_A1 }, aggregate: { type: 'instrument_message', id: w.messages[0]!['id'], seq: 1 } });
    expect(e['payload']).toMatchObject({ instrument_message_id: w.messages[0]!['id'], instrument_id: INS(1), agent_id: AGENT_A1, centre_id: w.deviceCentre, protocol: 'astm', sample_barcode: 'E2600000042', record_kind: 'quantitative',
      instrument_analyte_code: 'GLU', mapping_status: 'mapped', value_raw: '5.4', value_numeric: '5.4', unit_raw: 'mmol/L', instrument_flags: ['N'], instrument_result_time: T_RESULT, received_at: NOW, is_rerun: false });
    expect(e['payload']).not.toHaveProperty('unit_code');
  });
  it('AC-14.3: instrument_clock_offset_seconds = instrument time − captured_at (rounded) goes into the event, the record row and instrument_status', async () => {
    const w = makeWorld(); await run(w, [message({ n: 1, raw: ASTM_PATIENT.replace('20261107101500', '20261107101200') })]);   // message time == result time == 04:27:00Z; captured_at 04:26:58Z
    expect(w.eventsOf(RESULT).every((e) => e['payload'].instrument_clock_offset_seconds === 2)).toBe(true);
    expect(w.records.every((r) => r['instrument_clock_offset_seconds'] === 2)).toBe(true);
    expect(w.status).toHaveLength(1); expect(w.status[0]).toMatchObject({ instrument_id: INS(1), instrumentClockOffsetSeconds: 2, lastMessageAt: NOW });
  });
  it('observed_codes are upserted per (class, code) with the mapping status', async () => {
    const { w } = await go(); const rows = w.observed;
    expect(rows.map((r) => `${r['record_class']}:${r['instrument_analyte_code']}:${r['mapping_status']}`).sort()).toEqual(['patient:GLU:mapped', 'patient:NA:unmapped']);
    expect(rows.find((r) => r['instrument_analyte_code'] === 'GLU')!['analyte_id']).toBeTruthy();
  });
});

describe('mapping (AC-09.6)', () => {
  it('unmapped code: event still emitted, mapping_status unmapped, no analyte_id/test_id; mapped: both ids', async () => {
    const w = makeWorld(); await run(w, [message({ n: 1 })]);
    const by = (c: string) => w.eventsOf(RESULT).find((e) => e['payload'].instrument_analyte_code === c)!['payload'];
    expect(by('NA')).toMatchObject({ mapping_status: 'unmapped' }); expect(by('NA')).not.toHaveProperty('analyte_id'); expect(by('NA')).not.toHaveProperty('test_id');
    expect(by('GLU')).toMatchObject({ mapping_status: 'mapped', analyte_id: idN(0xb001), test_id: idN(0xb002) });
  });
  it('CatalogPort.mapInstrumentCode({ instrumentId, direction: "inbound", instrumentCode }) is memoised per batch', async () => {
    const w = makeWorld(); const catalog = makeCatalog();
    await run(w, [message({ n: 1 }), message({ n: 2, raw: patient(2) }), message({ n: 3, raw: patient(3) })], {}, { catalog });
    expect(catalog.calls.map((c) => c.input).sort((a, b) => a['instrumentCode'].localeCompare(b['instrumentCode']))).toEqual([
      { instrumentId: INS(1), direction: 'inbound', instrumentCode: 'GLU' }, { instrumentId: INS(1), direction: 'inbound', instrumentCode: 'NA' }]);
  });
});

describe('dedupe, three levels (AC-09.2, AC-09.3, AC-09.4, 04 N10)', () => {
  it('L1 agent key: the same (agent_id, agent_message_id) again -> duplicate, NO new archive row, message_duplicates reason agent_message_id; no new event/run', async () => {
    const w = makeWorld(); const m = message({ n: 1 });
    await run(w, [m]); const { res } = await run(w, [m]);
    expect(res[0]).toMatchObject({ agent_message_id: m['agent_message_id'], outcome: 'duplicate' });
    expect(w.messages).toHaveLength(1); expect(w.runs).toHaveLength(1); expect(w.events).toHaveLength(2);
    expect(w.duplicates).toHaveLength(1); expect(w.duplicates[0]).toMatchObject({ reason: 'agent_message_id', original_message_id: w.messages[0]!['id'], agent_message_id: m['agent_message_id'], agent_id: AGENT_A1, instrument_id: INS(1), centre_id: w.deviceCentre });
  });
  it('L1 is checked before the integrity check: a retried upload with a changed sha is still a duplicate', async () => {
    const w = makeWorld(); const m = message({ n: 1 }); await run(w, [m]);
    const { res } = await run(w, [{ ...m, raw_sha256: 'f'.repeat(64) }]); expect(res[0]!['outcome']).toBe('duplicate'); expect(w.runs).toHaveLength(1);
  });
  it('L2 ASTM: same sha256(raw) under a NEW agent_message_id -> duplicate, reason message_key', async () => {
    const w = makeWorld(); await run(w, [message({ n: 1 })]); const { res } = await run(w, [message({ n: 2 })]);
    expect(res[0]!['outcome']).toBe('duplicate'); expect(w.messages).toHaveLength(1); expect(w.duplicates[0]).toMatchObject({ reason: 'message_key', original_message_id: w.messages[0]!['id'], agent_message_id: msgId(2) });
  });
  it('L2 HL7: same (instrument, MSH-10) and same raw_sha256 -> duplicate (reason message_key); key = MSH-10', async () => {
    const w = makeWorld(); await run(w, [message({ n: 1, instrument: INS(2), protocol: 'hl7v2', raw: HL7_ORU })]);
    expect(w.messages[0]).toMatchObject({ message_key: 'MSG00001', message_key_kind: 'msh10', message_control_id: 'MSG00001' });
    const { res } = await run(w, [message({ n: 2, instrument: INS(2), protocol: 'hl7v2', raw: HL7_ORU })]);
    expect(res[0]!['outcome']).toBe('duplicate'); expect(w.messages).toHaveLength(1); expect(w.duplicates[0]!['reason']).toBe('message_key');
  });
  it('L2 HL7 control id reused with a DIFFERENT raw_sha256 (D-12): archived as new, key MSH-10:<first 16 hex of sha>, kind msh10_reused, warning control_id_reused', async () => {
    const w = makeWorld(); await run(w, [message({ n: 1, instrument: INS(2), protocol: 'hl7v2', raw: HL7_ORU })]);
    const raw2 = HL7_ORU.replace('||5.4|', '||5.9|').replace('20261107101200', '20261107101300'); const sha2 = sha256hex(bytes(raw2));
    const { res } = await run(w, [message({ n: 2, instrument: INS(2), protocol: 'hl7v2', raw: raw2 })]);
    expect(res[0]!['outcome']).toBe('accepted'); expect(w.messages).toHaveLength(2);
    expect(w.messages[1]).toMatchObject({ message_key: `MSG00001:${sha2.slice(0, 16)}`, message_key_kind: 'msh10_reused', message_control_id: 'MSG00001' });
    expect(w.messages[1]!['warnings']).toContain('control_id_reused'); expect(w.duplicates).toHaveLength(0);
  });
  it('L3 result level: a DIFFERENT message carrying the same barcode+code+time -> records duplicate_event (event_log uniqueness), no second event, emitted_events 0', async () => {
    const w = makeWorld(); await run(w, [message({ n: 1 })]); const { res } = await run(w, [message({ n: 2, raw: ASTM_PATIENT.replace('|5.4|', '|5.5|') })]);
    expect(res[0]!['outcome']).toBe('accepted'); expect(w.messages).toHaveLength(2); expect(w.eventsOf(RESULT)).toHaveLength(2);
    expect(w.records.filter((r) => r['message_id'] === w.messages[1]!['id']).map((r) => r['emit_status'])).toEqual(['duplicate_event', 'duplicate_event']);
    expect(w.runs[1]).toMatchObject({ emitted_events: 0, patient_records: 2 });
  });
  it('duplicates inside ONE batch: the second identical message is a duplicate of the first', async () => {
    const w = makeWorld(); const { res } = await run(w, [message({ n: 1 }), message({ n: 2 })]);
    expect(res.map((x) => x['outcome'])).toEqual(['accepted', 'duplicate']); expect(w.messages).toHaveLength(1);
  });
});

describe('quarantine and run outcomes (AC-09.7, steps 5 and 9)', () => {
  it('AC-09.7: unparseable HL7 -> quarantined instruments.message_malformed, raw archived, key = raw_sha256, run quarantined, no records, NO event', async () => {
    const w = makeWorld(); const junk = 'this is not HL7 at all'; const m = message({ n: 1, instrument: INS(2), protocol: 'hl7v2', raw: junk });
    const { res } = await run(w, [m]);
    expect(res[0]).toMatchObject({ outcome: 'quarantined', error_code: 'instruments.message_malformed', instrument_message_id: w.messages[0]!['id'] });
    expect(Buffer.from(w.messages[0]!['raw_bytes']).toString('latin1')).toBe(junk); expect(w.messages[0]).toMatchObject({ message_key: sha256hex(bytes(junk)), message_key_kind: 'sha256' });
    expect(w.runs[0]).toMatchObject({ kind: 'live', run_no: 1, outcome: 'quarantined', error_code: 'instruments.message_malformed' }); expect(w.records).toEqual([]); expect(w.events).toEqual([]);
  });
  it('step 5: sha256 mismatch -> archived, run quarantined with error integrity_mismatch, no records, no event', async () => {
    const w = makeWorld(); const { res } = await run(w, [message({ n: 1, sha: 'a'.repeat(64) })]);
    expect(res[0]!['outcome']).toBe('quarantined'); expect(w.messages).toHaveLength(1); expect(w.runs[0]).toMatchObject({ outcome: 'quarantined', error_code: 'integrity_mismatch' }); expect(w.records).toEqual([]); expect(w.events).toEqual([]);
  });
  it('step 9: kind=incomplete from the agent -> quarantined incomplete_transfer, no event', async () => {
    const w = makeWorld(); const { res } = await run(w, [message({ n: 1, kind: 'incomplete', link_meta: { incomplete_reason: 'frame_timeout' } })]);
    expect(res[0]!['outcome']).toBe('quarantined'); expect(w.runs[0]).toMatchObject({ outcome: 'quarantined', error_code: 'incomplete_transfer' }); expect(w.events).toEqual([]);
  });
  it.each([[6, 'commissioning'], [7, 'suspended']])('step 9: %s (%s) -> accepted with run outcome shadow: archive + records (emit_status shadow), NO event', async (n) => {
    const w = makeWorld(); const { res } = await run(w, [message({ n: 1, instrument: INS(n as number) })]);
    expect(res[0]!['outcome']).toBe('accepted'); expect(w.runs[0]).toMatchObject({ outcome: 'shadow', patient_records: 2, emitted_events: 0 });
    expect(w.records.map((r) => r['emit_status'])).toEqual(['shadow', 'shadow']); expect(w.events).toEqual([]);
  });
  it('step 9: a host_query uploaded as data -> parsed, records class host_query (emit_status not_applicable), no events', async () => {
    const w = makeWorld(); const f = fakeDriver([rec1({ recordSeq: 1, recordClass: 'host_query', sampleBarcode: 'E2600000042' })], { messageKind: 'host_query' });
    const { res } = await run(w, [message({ n: 1, kind: 'host_query' })], { getDriver: f.getDriver });
    expect(res[0]!['outcome']).toBe('accepted'); expect(w.runs[0]).toMatchObject({ outcome: 'parsed', host_query_records: 1, patient_records: 0, emitted_events: 0 });
    expect(w.records.map((r) => r['emit_status'])).toEqual(['not_applicable']); expect(w.events).toEqual([]);
  });
});

describe('device binding, size and state gates (AC-09.9, AC-09.10, S-02, REQ-SEC-121)', () => {
  const gate = async (instrument: string, o: Parameters<typeof makeIngestCtx>[1] = {}, w = makeWorld()) => {
    const spy = await spyRegistry(); const m = message({ n: 1, instrument }); const x = await run(w, [m], { getDriver: spy.getDriver }, o); return { w, m, spy, ...x };
  };
  it('AC-09.9: instrument bound to ANOTHER agent of the SAME centre -> rejected instruments.device_mismatch; rejection row with raw in the device centre; nothing parsed or archived', async () => {
    const { w, m, res, spy } = await gate(INS(4));
    expect(res).toEqual([{ agent_message_id: m['agent_message_id'], outcome: 'rejected', error_code: 'instruments.device_mismatch' }]);
    expect(w.rejections).toHaveLength(1);
    expect(w.rejections[0]).toMatchObject({ agent_id: AGENT_A1, centre_id: w.deviceCentre, claimed_instrument_id: INS(4), agent_message_id: m['agent_message_id'], reason_code: 'instruments.device_mismatch', raw_sha256: sha256hex(bytes(ASTM_PATIENT)), size_bytes: bytes(ASTM_PATIENT).length });
    expect(Buffer.from(w.rejections[0]!['raw_bytes']).equals(bytes(ASTM_PATIENT))).toBe(true);
    expect(spy.parses()).toBe(0); expect(w.messages).toEqual([]); expect(w.runs).toEqual([]); expect(w.events).toEqual([]);
  });
  it.each([['another centre of the tenant', INS(3)], ['another tenant', INS(8)], ['a random id', idN(0xdead)]])('AC-09.9/S-02: instrument of %s is invisible under device RLS -> rejected instruments.instrument_unknown (same answer for all three), rejection row in the DEVICE centre, nothing parsed', async (_n, id) => {
    const { w, res, spy } = await gate(id as string);
    expect(res[0]).toMatchObject({ outcome: 'rejected', error_code: 'instruments.instrument_unknown' });
    expect(w.rejections).toHaveLength(1); expect(w.rejections[0]).toMatchObject({ agent_id: AGENT_A1, centre_id: w.deviceCentre, claimed_instrument_id: id, reason_code: 'instruments.instrument_unknown' });
    expect(Buffer.from(w.rejections[0]!['raw_bytes']).equals(bytes(ASTM_PATIENT))).toBe(true); expect(spy.parses()).toBe(0); expect(w.messages).toEqual([]);
  });
  it('S-02: an A2 device sending to an A2 instrument is fine, while the same A1 instrument id is unknown to it', async () => {
    const w = makeWorld({ deviceAgent: AGENT_A2 }); const ok = await run(w, [message({ n: 1, instrument: INS(3) })]); expect(ok.res[0]!['outcome']).toBe('accepted');
    const bad = await run(w, [message({ n: 2, instrument: INS(1) })]); expect(bad.res[0]).toMatchObject({ outcome: 'rejected', error_code: 'instruments.instrument_unknown' }); expect(w.rejections[0]!['centre_id']).toBe(w.deviceCentre);
  });
  it('step 3: an instrument in state draft is rejected instruments.instrument_unknown, nothing parsed or archived', async () => {
    const { res, w, spy } = await gate(INS(5)); expect(res[0]).toMatchObject({ outcome: 'rejected', error_code: 'instruments.instrument_unknown' }); expect(w.messages).toEqual([]); expect(spy.parses()).toBe(0);
  });
  it('AC-09.10: > 1 MiB raw -> rejected instruments.message_too_large; rejection row has sha256 + size and NO raw; no archive row; nothing parsed', async () => {
    const w = makeWorld(); const spy = await spyRegistry(); const big = Buffer.alloc(MiB + 1, 0x41);
    const { res } = await run(w, [message({ n: 1, raw: big })], { getDriver: spy.getDriver });
    expect(res[0]).toMatchObject({ outcome: 'rejected', error_code: 'instruments.message_too_large' });
    expect(w.rejections).toHaveLength(1); expect(w.rejections[0]).toMatchObject({ reason_code: 'instruments.message_too_large', raw_sha256: sha256hex(big), size_bytes: MiB + 1, agent_id: AGENT_A1 }); expect(w.rejections[0]!['raw_bytes'] ?? null).toBeNull();
    expect(w.messages).toEqual([]); expect(spy.parses()).toBe(0);
  });
  it('AC-09.10 boundary: exactly 1 MiB is NOT too large (here: garbage -> quarantined, archived)', async () => {
    const w = makeWorld(); const { res } = await run(w, [message({ n: 1, raw: Buffer.alloc(MiB, 0x41) })]);
    expect(res[0]!['outcome']).toBe('quarantined'); expect(w.messages).toHaveLength(1); expect(w.rejections).toEqual([]);
  });
});

describe('per-message savepoint (AC-09.8) and time budget', () => {
  it('AC-09.8: an unexpected error in message 2 (after its events were published) -> only message 2 is retry/common.internal and ALL its writes + events roll back; 1 and 3 commit', async () => {
    const w = makeWorld(); let k = 0; w.failOn('insertRun', () => ++k === 2, () => new Error('connection reset while writing E26000000077'));
    const ms = [message({ n: 1, raw: patient(1) }), message({ n: 2, raw: patient(2) }), message({ n: 3, raw: patient(3) })];
    const { res } = await run(w, ms);
    expect(res).toEqual([
      { agent_message_id: ms[0]!['agent_message_id'], outcome: 'accepted', instrument_message_id: expect.any(String) },
      { agent_message_id: ms[1]!['agent_message_id'], outcome: 'retry', error_code: 'common.internal' },
      { agent_message_id: ms[2]!['agent_message_id'], outcome: 'accepted', instrument_message_id: expect.any(String) }]);
    expect(w.messages.map((m) => m['agent_message_id'])).toEqual([msgId(1), msgId(3)]); expect(w.events).toHaveLength(4);   // 2 messages x 2 records, none of message 2's
    expect(w.tx.rollbacks).toBe(1); expect(w.tx.savepoints).toBeGreaterThanOrEqual(3);
    const again = await run(w, [ms[1]!]); expect(again.res[0]!['outcome']).toBe('accepted');   // the retry succeeds: nothing of the failed attempt is left behind
  });
  it('time budget: messages not STARTED when the budget is used get outcome retry and are not touched; the started one completes', async () => {
    const w = makeWorld(); let t = 0; const repo = { ...w.repo, insertMessage: async (...a: Parameters<typeof w.repo.insertMessage>) => { t += 9000; return w.repo.insertMessage(...a); } };
    const { res } = await run(w, [message({ n: 1, raw: patient(1) }), message({ n: 2, raw: patient(2) }), message({ n: 3, raw: patient(3) })], { repo, budgetMs: 8000, monotonicMs: () => t });
    expect(res.map((x) => x['outcome'])).toEqual(['accepted', 'retry', 'retry']); expect(w.messages).toHaveLength(1); expect(w.callsOf('findInstrument')).toHaveLength(1);
  });
});

describe('QC records (AC-11.1, AC-11.1a, AC-11.2)', () => {
  it('AC-11.1: a record whose sample id matches qc_sample_id_patterns -> ONE instruments.qc.received.v1 (control id = matched sample id) and NO result.received', async () => {
    const w = makeWorld(); const { res } = await run(w, [message({ n: 1, raw: ASTM_QC })]);
    expect(res[0]!['outcome']).toBe('accepted'); expect(w.eventsOf(RESULT)).toHaveLength(0); expect(w.eventsOf(QC)).toHaveLength(1);
    const e = w.eventsOf(QC)[0]!;
    expect(e['payload']).toMatchObject({ instrument_message_id: w.messages[0]!['id'], instrument_id: INS(1), centre_id: w.deviceCentre, control_id_raw: 'QC-L1-0007', instrument_analyte_code: 'GLU', mapping_status: 'mapped', value_raw: '5.0', unit_raw: 'mmol/L', received_at: NOW });
    expect(e['payload']).not.toHaveProperty('sample_barcode'); expect(e['aggregate']).toMatchObject({ type: 'instrument_message', id: w.messages[0]!['id'], seq: 1 });
    expect(w.runs[0]).toMatchObject({ qc_records: 1, patient_records: 0, emitted_events: 1 }); expect(w.records[0]).toMatchObject({ record_class: 'qc', control_id_raw: 'QC-L1-0007', emit_status: 'emitted' });
    expect(w.observed.map((r) => r['record_class'])).toEqual(['qc']);
  });
  it('AC-11.2: key = <instrument>:qc:<control_id_raw>:<code>:<instrument_result_time> — or raw_sha256 when the record has no time', async () => {
    const w = makeWorld(); await run(w, [message({ n: 1, raw: ASTM_QC })]);
    expect(w.eventsOf(QC)[0]!['idempotency_key']).toBe(`${INS(1)}:qc:QC-L1-0007:GLU:${T_RESULT}`);
    const w2 = makeWorld(); const f = fakeDriver([rec1({ recordSeq: 1, recordClass: 'qc', controlIdRaw: 'QC-9', instrumentAnalyteCode: 'GLU', valueRaw: '5.0' })]); const m = message({ n: 1 });
    await run(w2, [m], { getDriver: f.getDriver }); expect(w2.eventsOf(QC)[0]!['idempotency_key']).toBe(`${INS(1)}:qc:QC-9:GLU:${m['raw_sha256']}`);
  });
  const qc = (o: Partial<Parameters<typeof rec1>[0]>) => rec1({ recordSeq: 1, recordClass: 'qc', controlIdRaw: 'QC-1', instrumentAnalyteCode: 'GLU', valueRaw: '5.0', instrumentResultTimeLocal: '2026-11-07T10:12:00', ...o });
  const X = (n: number) => 'x'.repeat(n);
  it.each([
    ['control id 65 chars', qc({ controlIdRaw: X(65) }), 'skipped_invalid'], ['value_raw 65 chars', qc({ valueRaw: X(65) }), 'skipped_invalid'],
    ['no control id and no sample id', qc({ controlIdRaw: undefined }), 'skipped_invalid'], ['empty value_raw', qc({ valueRaw: '' }), 'skipped_invalid'],
    ['control id exactly 64', qc({ controlIdRaw: X(64) }), 'emitted'], ['value_raw exactly 64', qc({ valueRaw: X(64) }), 'emitted'],
  ])('AC-11.1a: QC with %s -> %s', async (_n, record, status) => {
    const w = makeWorld(); const f = fakeDriver([record]); await run(w, [message({ n: 1 })], { getDriver: f.getDriver });
    expect(w.records[0]!['emit_status']).toBe(status); expect(w.eventsOf(QC)).toHaveLength(status === 'emitted' ? 1 : 0);
    expect(w.runs[0]).toMatchObject(status === 'emitted' ? { emitted_events: 1, skipped_records: 0 } : { emitted_events: 0, skipped_records: 1 });
    if (status !== 'emitted') expect(JSON.stringify(w.records[0]!['warnings'])).not.toContain('xxxxx');   // names the field, never the value
  });
});

describe('record validation, local time and run counters (§6.4 step 10, §6.5)', () => {
  const p = (o: Partial<Parameters<typeof rec1>[0]> = {}) => rec1({ recordSeq: 1, sampleBarcode: 'E2600000042', instrumentAnalyteCode: 'GLU', valueRaw: '5.4', unitRaw: 'mmol/L', instrumentResultTimeLocal: '2026-11-07T10:12:00', ...o });
  const X = (n: number) => 'x'.repeat(n);
  it.each([
    ['barcode 41', p({ sampleBarcode: X(41) })], ['code 65', p({ instrumentAnalyteCode: X(65) })], ['value 201', p({ valueRaw: X(201) })], ['unit 33', p({ unitRaw: X(33) })],
    ['21 flags', p({ instrumentFlags: Array.from({ length: 21 }, () => 'N') })], ['flag of 17 chars', p({ instrumentFlags: [X(17)] })], ['empty code', p({ instrumentAnalyteCode: '' })],
  ])('a patient record breaking a 03-IC limit (%s) -> skipped_invalid, no event, counted in skipped_records, the message is still accepted', async (_n, record) => {
    const w = makeWorld(); const f = fakeDriver([record]); const { res } = await run(w, [message({ n: 1 })], { getDriver: f.getDriver });
    expect(res[0]!['outcome']).toBe('accepted'); expect(w.records[0]!['emit_status']).toBe('skipped_invalid'); expect(w.events).toEqual([]); expect(w.runs[0]).toMatchObject({ skipped_records: 1, emitted_events: 0, patient_records: 1 });
  });
  it('limits are inclusive: barcode 40, code 64, value 200, unit 32, 20 flags of 16 -> emitted', async () => {
    const w = makeWorld(); const f = fakeDriver([p({ sampleBarcode: X(40), instrumentAnalyteCode: X(64), valueRaw: X(200), unitRaw: X(32), instrumentFlags: Array.from({ length: 20 }, () => X(16)) })]);
    await run(w, [message({ n: 1 })], { getDriver: f.getDriver }); expect(w.records[0]!['emit_status']).toBe('emitted'); expect(w.eventsOf(RESULT)).toHaveLength(1);
  });
  it.each([['5.4', '5.4'], ['-0.5', '-0.5'], ['123456789012.123456', '123456789012.123456'], ['Negative', undefined], ['1234567890123', undefined], ['5.1234567', undefined], ['1e3', undefined], [' 5.4 ', '5.4']])(
    'value_numeric for value_raw %j is %j (only when the trimmed value matches ^-?[0-9]{1,12}(\\.[0-9]{1,6})?$)', async (v, want) => {
      const w = makeWorld(); await run(w, [message({ n: 1 })], { getDriver: fakeDriver([p({ valueRaw: v as string })]).getDriver });
      const pl = w.eventsOf(RESULT)[0]!['payload']; expect(pl['value_raw']).toBe(v); want === undefined ? expect(pl).not.toHaveProperty('value_numeric') : expect(pl['value_numeric']).toBe(want);
    });
  it('result without an instrument time -> key suffix "none" and no instrument_result_time / clock offset in the event', async () => {
    const w = makeWorld(); await run(w, [message({ n: 1 })], { getDriver: fakeDriver([p({ instrumentResultTimeLocal: undefined })]).getDriver });
    const e = w.eventsOf(RESULT)[0]!; expect(e['idempotency_key']).toBe(`${INS(1)}:E2600000042:GLU:none`); expect(e['payload']).not.toHaveProperty('instrument_result_time'); expect(e['payload']).not.toHaveProperty('instrument_clock_offset_seconds');
  });
  it('local time is converted with the INSTRUMENT timezone (Asia/Kathmandu +05:45): 10:12 -> 04:27:00Z', async () => {
    const w = makeWorld(); await run(w, [message({ n: 1 })], { getDriver: fakeDriver([p()]).getDriver }); expect(w.eventsOf(RESULT)[0]!['payload']['instrument_result_time']).toBe(T_RESULT);
  });
  it('counters: patient/qc/host_query by class; unmapped = mapping unmapped; skipped_no_barcode = no barcode AND mapped (never double counted with unmapped); emitted_events; skipped_records', async () => {
    const w = makeWorld();
    const f = fakeDriver([
      p({ recordSeq: 1 }), p({ recordSeq: 2, instrumentAnalyteCode: 'UN1' }),                               // emitted mapped, emitted unmapped
      p({ recordSeq: 3, sampleBarcode: undefined }), p({ recordSeq: 4, sampleBarcode: undefined, instrumentAnalyteCode: 'UN2' }),   // no barcode: mapped -> skipped_no_barcode counter; unmapped -> unmapped counter only
      rec1({ recordSeq: 5, recordClass: 'qc', controlIdRaw: 'QC-1', instrumentAnalyteCode: 'GLU', valueRaw: '5.0' }), p({ recordSeq: 6, valueRaw: 'x'.repeat(201) }),
      rec1({ recordSeq: 7, recordClass: 'host_query' })]);
    await run(w, [message({ n: 1 })], { getDriver: f.getDriver });
    expect(w.runs[0]).toMatchObject({ patient_records: 5, qc_records: 1, calibrator_records: 0, host_query_records: 1, unmapped_records: 2, skipped_no_barcode_records: 1, emitted_events: 3, skipped_records: 1 });
    expect(w.records.map((r) => r['emit_status'])).toEqual(['emitted', 'emitted', 'skipped_no_barcode', 'skipped_no_barcode', 'emitted', 'skipped_invalid', 'not_applicable']);
  });
  it('a calibrator record from a driver WITHOUT capabilities.calibration never produces an event (generic drivers never emit calibration)', async () => {
    const w = makeWorld(); await run(w, [message({ n: 1 })], { getDriver: fakeDriver([rec1({ recordSeq: 1, recordClass: 'calibrator', instrumentAnalyteCode: 'GLU', valueRaw: '1' })], { calibration: false }).getDriver });
    expect(w.events).toEqual([]);
  });
});

describe('idempotent replay (AC-09.11) — the stored response is replayed by the core before this code runs', () => {
  it('E04 is declared x-idempotency: required and the service returns a plain { status, body } (nothing the core cannot store)', async () => {
    const { readFileSync } = await import('node:fs'); const yaml = readFileSync(new URL('../../../../../../contracts/openapi/instruments.yaml', import.meta.url), 'utf8');
    expect(/operationId: submitMessageBatch[\s\S]*?x-idempotency: required/.test(yaml)).toBe(true);
    const w = makeWorld(); const { r } = await run(w, [message({ n: 1 })]); expect(Object.keys(r).sort()).toEqual(expect.arrayContaining(['body', 'status'])); expect(() => JSON.stringify(r)).not.toThrow(); expect(JSON.parse(JSON.stringify(r.body))).toEqual(r.body);
  });
  it('if the SAME batch does reach the service again (different key), every message is a duplicate — nothing is stored twice', async () => {
    const w = makeWorld(); const ms = [message({ n: 1, raw: patient(1) }), message({ n: 2, raw: patient(2) })]; await run(w, ms); const { res } = await run(w, ms);
    expect(res.map((x) => x['outcome'])).toEqual(['duplicate', 'duplicate']); expect(w.messages).toHaveLength(2); expect(w.events).toHaveLength(4); expect(w.duplicates).toHaveLength(2);
  });
});

describe('adversarial (S-08)', () => {
  it.each([['not base64 at all !!!'], ['====']])('malformed base64 %j never produces a 5xx: per-message outcome, no crash', async (b64) => {
    const w = makeWorld(); const c = makeIngestCtx(w); const m = { ...message({ n: 1 }), raw_base64: b64 };
    const r = await createIngestService({ repo: w.repo } as any).submitMessageBatch(c.ctx, { body: batch([m]) }).catch((e: any) => e);
    if (r instanceof Error) expect(['common.validation_failed']).toContain((r as any).code); else expect(['rejected', 'quarantined', 'retry']).toContain(r.body.results[0].outcome);
  });
  it('hostile bytes (invalid UTF-8, NULs, 1 MiB of delimiters) are archived or quarantined, never a crash; only per-message outcomes', async () => {
    const w = makeWorld(); const ms = [Buffer.from([0xff, 0xfe, 0x00, 0x7c, 0x5e, 0x26, 0x0d]), Buffer.alloc(MiB, 0x7c), bytes('MSH|^~\\&|' + '^'.repeat(5000))].map((b, i) => message({ n: i + 1, raw: b, instrument: INS(2), protocol: 'hl7v2' }));
    const { res } = await run(w, ms); expect(res).toHaveLength(3); for (const x of res) expect(['accepted', 'quarantined', 'rejected']).toContain(x['outcome']); expect(w.events).toEqual([]);
  });
});
