// C7 API-T16 — AC-11.3 (calibration event, B2 gating) and AC-11.4 (two-isolate session, CR-C10-007) through the REAL E04 pipeline (02-TRD 6.4 step 11, 6.5).
// Same world / seams as ingest.service.test.ts (ingest.helpers.ts). Drivers are synthetic (no verified driver exists yet); the micro rule is the REAL drivers/micro-code.ts.
import { describe, expect, it } from 'vitest';
import { createIngestService } from '../service/ingest.service.js';
import { applyMicroCode } from '../drivers/micro-code.js';
import { getDriver as registryGetDriver } from '../drivers/registry.js';
import { GLU_MAP, INS, batch, fakeDriver, makeIngestCtx, makeWorld, message, rec1, sha256hex, type Row, type World } from './ingest.helpers.js';

const CAL = 'instruments.calibration.received.v1', RESULT = 'instruments.result.received.v1', QC = 'instruments.qc.received.v1';
const T = '2026-11-07T04:27:00.000Z';                                  // 10:12 local, Asia/Kathmandu (+05:45)
const calRec = (o: Record<string, unknown> = {}) => rec1({ recordSeq: 1, recordClass: 'calibrator', recordKind: 'quantitative', instrumentAnalyteCode: 'GLU', valueRaw: '1.02', unitRaw: 'mmol/L',
  calibratorIdRaw: 'CAL-SYN-1', calibratorLotRaw: 'LOT-SYN-07', instrumentResultTimeLocal: '2026-11-07T10:12:00', ...o } as any);
async function run(w: World, messages: Row[], deps: Record<string, unknown> = {}) {
  const c = makeIngestCtx(w); const r = await createIngestService({ repo: w.repo, ...deps } as any).submitMessageBatch(c.ctx, { body: batch(messages) });
  return { r, c, res: r.body.results as Row[] };
}
const withCal = (records: ReturnType<typeof rec1>[], o: { calibration?: boolean } = {}) => fakeDriver(records, { calibration: o.calibration ?? true }).getDriver;

describe('AC-11.3 — calibrator record from a calibration-capable driver on a live instrument', () => {
  it('publishes exactly one instruments.calibration.received.v1 (key <instrument>:cal:<code>:<time>) and no result / qc event', async () => {
    const w = makeWorld(); const { res } = await run(w, [message({ n: 1 })], { getDriver: withCal([calRec()]) });
    expect(res[0]!['outcome']).toBe('accepted');
    expect(w.eventsOf(CAL)).toHaveLength(1); expect(w.eventsOf(RESULT)).toEqual([]); expect(w.eventsOf(QC)).toEqual([]); expect(w.events).toHaveLength(1);
    const e = w.eventsOf(CAL)[0]!; expect(e['idempotency_key']).toBe(`${INS(1)}:cal:GLU:${T}`);
    expect(e['aggregate']).toMatchObject({ type: 'instrument_message', id: w.messages[0]!['id'], seq: 1 }); expect(e['producer']).toBe('instruments');
  });
  it('payload = 03-IC 3.26 fields only, mapped codes carry analyte_id/test_id, calibrator ids come from calibratorIdRaw/calibratorLotRaw; no barcode / value / unit leaks', async () => {
    const w = makeWorld(); await run(w, [message({ n: 1 })], { getDriver: withCal([calRec()]) });
    const p = w.eventsOf(CAL)[0]!['payload'];
    expect(p).toEqual({ instrument_message_id: w.messages[0]!['id'], instrument_id: INS(1), centre_id: w.messages[0]!['centre_id'], instrument_analyte_code: 'GLU', mapping_status: 'mapped', analyte_id: GLU_MAP.analyteId, test_id: GLU_MAP.testId,
      calibrator_id_raw: 'CAL-SYN-1', calibrator_lot_raw: 'LOT-SYN-07', instrument_result_time: T, received_at: new Date(w.messages[0]!['received_at']).toISOString() });
  });
  it('unmapped code: event is still published with mapping_status unmapped and no analyte_id / test_id', async () => {
    const w = makeWorld(); await run(w, [message({ n: 1 })], { getDriver: withCal([calRec({ instrumentAnalyteCode: 'UN9' })]) });
    const p = w.eventsOf(CAL)[0]!['payload']; expect(p).toMatchObject({ instrument_analyte_code: 'UN9', mapping_status: 'unmapped' }); expect(p).not.toHaveProperty('analyte_id'); expect(p).not.toHaveProperty('test_id');
  });
  it('no sample_barcode needed (no barcode rule for calibrators) and calibrator ids are optional', async () => {
    const w = makeWorld(); await run(w, [message({ n: 1 })], { getDriver: withCal([calRec({ sampleBarcode: undefined, calibratorIdRaw: undefined, calibratorLotRaw: undefined })]) });
    const p = w.eventsOf(CAL)[0]!['payload']; expect(p).not.toHaveProperty('calibrator_id_raw'); expect(p).not.toHaveProperty('calibrator_lot_raw'); expect(p).not.toHaveProperty('sample_barcode');
  });
  it('no instrument result time -> the key ends in sha256(raw) of the message', async () => {
    const w = makeWorld(); const m = message({ n: 1 }); await run(w, [m], { getDriver: withCal([calRec({ instrumentResultTimeLocal: undefined })]) });
    expect(w.eventsOf(CAL)[0]!['idempotency_key']).toBe(`${INS(1)}:cal:GLU:${sha256hex(Buffer.from(m['raw_base64'] as string, 'base64'))}`); expect(w.eventsOf(CAL)[0]!['payload']).not.toHaveProperty('instrument_result_time');
  });
  it('counters + record row: calibrator_records 1, emitted_events 1, emit_status emitted, event_id set, record_class calibrator; patient/qc counters stay 0', async () => {
    const w = makeWorld(); await run(w, [message({ n: 1 })], { getDriver: withCal([calRec()]) });
    expect(w.runs[0]).toMatchObject({ outcome: 'parsed', calibrator_records: 1, emitted_events: 1, patient_records: 0, qc_records: 0, skipped_records: 0 });
    expect(w.records[0]).toMatchObject({ record_class: 'calibrator', emit_status: 'emitted', instrument_analyte_code: 'GLU' }); expect(w.records[0]!['event_id']).toBe(w.eventsOf(CAL)[0]!['event_id']);
  });
  it('mixed message: patient -> result event, qc -> qc event, calibrator -> calibration event, one each', async () => {
    const w = makeWorld(); await run(w, [message({ n: 1 })], { getDriver: withCal([rec1({ recordSeq: 1, sampleBarcode: 'E2600000042', instrumentAnalyteCode: 'GLU', valueRaw: '5.4' }),
      rec1({ recordSeq: 2, recordClass: 'qc', controlIdRaw: 'QC-1', instrumentAnalyteCode: 'GLU', valueRaw: '5.0' }), calRec({ recordSeq: 3 })]) });
    expect([w.eventsOf(RESULT).length, w.eventsOf(QC).length, w.eventsOf(CAL).length]).toEqual([1, 1, 1]); expect(w.runs[0]).toMatchObject({ patient_records: 1, qc_records: 1, calibrator_records: 1, emitted_events: 3 });
  });
  it('same code + time in a later message -> duplicate_event: no second event, counter not incremented (idempotent key)', async () => {
    const w = makeWorld(); const d = withCal([calRec()]);
    await run(w, [message({ n: 1, raw: 'one' })], { getDriver: d }); await run(w, [message({ n: 2, raw: 'two' })], { getDriver: d });
    expect(w.eventsOf(CAL)).toHaveLength(1); expect(w.records.map((r) => r['emit_status'])).toEqual(['emitted', 'duplicate_event']); expect(w.runs[1]).toMatchObject({ calibrator_records: 1, emitted_events: 0 });
  });
  it('two calibrators of one message with different codes -> two events', async () => {
    const w = makeWorld(); await run(w, [message({ n: 1 })], { getDriver: withCal([calRec(), calRec({ recordSeq: 2, instrumentAnalyteCode: 'NA' })]) });
    expect(w.eventsOf(CAL).map((e) => e['idempotency_key']).sort()).toEqual([`${INS(1)}:cal:GLU:${T}`, `${INS(1)}:cal:NA:${T}`]);
  });
  it('instrument not live (commissioning / suspended): archived as shadow, NO event', async () => {
    for (const n of [6, 7]) { const w = makeWorld(); await run(w, [message({ n: 1, instrument: INS(n) })], { getDriver: withCal([calRec()]) });
      expect(w.events).toEqual([]); expect(w.records[0]).toMatchObject({ record_class: 'calibrator', emit_status: 'shadow' }); expect(w.runs[0]).toMatchObject({ outcome: 'shadow', calibrator_records: 1, emitted_events: 0 }); }
  });
  it.each([['calibrator_id_raw 65 chars', { calibratorIdRaw: 'c'.repeat(65) }], ['calibrator_lot_raw 65 chars', { calibratorLotRaw: 'l'.repeat(65) }], ['instrument_analyte_code 65 chars', { instrumentAnalyteCode: 'x'.repeat(65) }],
    ['missing instrument_analyte_code', { instrumentAnalyteCode: undefined }]])('a field that breaks the IC limit (%s) -> record skipped_invalid, no event, message still accepted', async (_n, bad) => {
    const w = makeWorld(); const { res } = await run(w, [message({ n: 1 })], { getDriver: withCal([calRec(bad)]) });
    expect(res[0]!['outcome']).toBe('accepted'); expect(w.events).toEqual([]); expect(w.records[0]).toMatchObject({ emit_status: 'skipped_invalid' }); expect(w.runs[0]).toMatchObject({ calibrator_records: 1, skipped_records: 1, emitted_events: 0 });
    expect(JSON.stringify(w.records[0]!['warnings'])).not.toMatch(/c{65}|l{65}|x{65}/);
  });
  it('a failure AFTER the calibration event was published (run insert) rolls the message back with its event (savepoint) and reports retry — nothing stored', async () => {
    const w = makeWorld(); w.failOn('insertRun'); const { res } = await run(w, [message({ n: 1 })], { getDriver: withCal([calRec()]) });
    expect(res[0]).toMatchObject({ outcome: 'retry' }); expect(w.events).toEqual([]); expect(w.messages).toEqual([]);
  });
});

describe('B2 — generic drivers never emit calibration', () => {
  it('calibrator record from a driver WITHOUT capabilities.calibration: no event, archived not_applicable, counted as calibrator_records', async () => {
    const w = makeWorld(); await run(w, [message({ n: 1 })], { getDriver: withCal([calRec()], { calibration: false }) });
    expect(w.events).toEqual([]); expect(w.records[0]).toMatchObject({ record_class: 'calibrator', emit_status: 'not_applicable' }); expect(w.runs[0]).toMatchObject({ calibrator_records: 1, emitted_events: 0 });
  });
  it('every registered non-verified driver declares calibration:false, and none is verified yet (CHECK cap_calibration = false OR status = verified)', () => {
    for (const code of ['astm_generic_e1394', 'hl7v2_generic_oru', 'file_drop_generic', 'mindray_bc5380_sketch', 'mindray_bs200_sketch']) {
      const d = registryGetDriver(code)!; expect(d.status).not.toBe('verified'); expect(d.capabilities.calibration).toBe(false);
    }
  });
  it('with the REAL generic drivers a calibration-looking message never yields a calibration event', async () => {
    const w = makeWorld(); const cal = 'H|\\^&|||SYN|||||||P|1\rP|1\rO|1|CAL-SYN-1||^^^GLU|R||||||C\rR|1|^^^GLU|1.02|mmol/L||N||F||||20261107101200\rL|1|N\r';
    await run(w, [message({ n: 1, raw: cal })]); expect(w.eventsOf(CAL)).toEqual([]);
  });
});

describe('AC-11.4 — two isolates of one specimen with the same antibiotic through E04 (CR-C10-007)', () => {
  const ast = (seq: number | undefined, extra: Record<string, unknown> = {}) => applyMicroCode(rec1({ recordSeq: seq ?? 9, sampleBarcode: 'E2600000042', recordKind: 'ast', valueRaw: '<=2', instrumentResultTimeLocal: '2026-11-07T10:12:00',
    ast: { antibioticCodeRaw: 'AMP', ...(seq === undefined ? {} : { isolateSeq: seq }), method: 'mic', rawValue: '<=2', interpretationRaw: 'S' }, ...extra } as any));
  it('two ast records -> codes AST:1:AMP:mic / AST:2:AMP:mic and two DISTINCT result keys, two events, both emitted', async () => {
    const w = makeWorld(); await run(w, [message({ n: 1 })], { getDriver: fakeDriver([ast(1), ast(2)]).getDriver });
    const ev = w.eventsOf(RESULT); expect(ev.map((e) => e['payload']['instrument_analyte_code'])).toEqual(['AST:1:AMP:mic', 'AST:2:AMP:mic']);
    expect(ev.map((e) => e['idempotency_key'])).toEqual([`${INS(1)}:E2600000042:AST:1:AMP:mic:${T}`, `${INS(1)}:E2600000042:AST:2:AMP:mic:${T}`]); expect(new Set(ev.map((e) => e['idempotency_key'])).size).toBe(2);
    expect(w.records.map((r) => r['emit_status'])).toEqual(['emitted', 'emitted']); expect(w.runs[0]).toMatchObject({ patient_records: 2, emitted_events: 2 });
    expect(ev.map((e) => e['payload']['ast']['isolate_seq'])).toEqual([1, 2]);
  });
  it('organism records: ORG:1 / ORG:2 are two distinct keys as well', async () => {
    const w = makeWorld(); const org = (seq: number) => applyMicroCode(rec1({ recordSeq: seq, sampleBarcode: 'E2600000042', recordKind: 'organism_id', valueRaw: 'ECOL', instrumentResultTimeLocal: '2026-11-07T10:12:00', organism: { organismCodeRaw: 'ECOL', isolateSeq: seq } }));
    await run(w, [message({ n: 1 })], { getDriver: fakeDriver([org(1), org(2)]).getDriver });
    expect(w.eventsOf(RESULT).map((e) => e['payload']['instrument_analyte_code'])).toEqual(['ORG:1', 'ORG:2']);
  });
  it('a composite code > 64 chars -> that record skipped_invalid (never truncated), the warning code is stored, no event for it; the other record is unaffected', async () => {
    const w = makeWorld(); const long = applyMicroCode(rec1({ recordSeq: 2, sampleBarcode: 'E2600000042', recordKind: 'ast', valueRaw: '1', instrumentResultTimeLocal: '2026-11-07T10:12:00',
      ast: { antibioticCodeRaw: 'A'.repeat(55), isolateSeq: 1, method: 'mic', rawValue: '1' } }));
    const { res } = await run(w, [message({ n: 1 })], { getDriver: fakeDriver([ast(1), long]).getDriver });
    expect(res[0]!['outcome']).toBe('accepted'); expect(w.eventsOf(RESULT)).toHaveLength(1);
    expect(w.records.map((r) => r['emit_status'])).toEqual(['emitted', 'skipped_invalid']); expect(w.records[1]!['warnings']).toContain('instrument_analyte_code_too_long'); expect(w.records[1]!['instrument_analyte_code']).toBeNull();
    expect(w.runs[0]).toMatchObject({ skipped_records: 1, emitted_events: 1 });
  });
  it('replaying the two-isolate message under a new message id is all duplicate_event (both keys already published)', async () => {
    const w = makeWorld(); const d = fakeDriver([ast(1), ast(2)]).getDriver; await run(w, [message({ n: 1, raw: 'a' })], { getDriver: d }); await run(w, [message({ n: 2, raw: 'b' })], { getDriver: d });
    expect(w.eventsOf(RESULT)).toHaveLength(2); expect(w.records.map((r) => r['emit_status'])).toEqual(['emitted', 'emitted', 'duplicate_event', 'duplicate_event']);
  });
});
