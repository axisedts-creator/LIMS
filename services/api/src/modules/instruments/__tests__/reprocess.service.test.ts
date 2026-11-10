// C7 API-T13 — E38 reprocessInstrumentMessage / E39 rematchInstrumentRecord (02-TRD §6.7; 01-PRD AC-19.1..19.5; 07-SECURITY AB11, REQ-SEC-096/097, 02-CV §9.2). Seams: reprocess.helpers.ts header.
import { beforeAll, describe, expect, it } from 'vitest';
import { eventValidators } from '../../../core/events/publish.js';
import { localToUtc } from '../domain/instrumentTime.js';
import {
  ASTM_PATIENT, GLU, NA, QC, PLANT, PERM, REASON_TEXT_PLANT, CENTRE_A1, CENTRE_A2, TENANT_A, TENANT_B, USER, INS, AGENT_A1, idN, msgId, recId, msgRow, recordRow, rec1, failure, snakeToCamel,
  makeReprocessWorld, makeLabPort, makeRctx, spyDriver, readOnly, onlyCentre, RAW, type Row, type PortAnswer,
} from './reprocess.helpers.js';

const load = () => import('../service/reprocess.service.js');
beforeAll(() => { eventValidators(); }, 120_000);   // first-call event schema compile is slow (ruling §3)
const MSG = msgId(1), REC = recId(1);
const BODY = { reason_code: 'driver_fixed', reason_text: REASON_TEXT_PLANT };
const NEW_BC = 'E2600000099';
const REMATCH = { sample_barcode: NEW_BC, reason_code: 'barcode_keypad_error' };
const rt = localToUtc('2026-11-07T09:45:00', 'Asia/Kathmandu');
const RESULT = 'instruments.result.received.v1', QCE = 'instruments.qc.received.v1';

async function setup(o: { msg?: Row; records?: Row[]; recs?: Row[]; driver?: ReturnType<typeof spyDriver> | null; program?: (i: Row, n: number) => PortAnswer | Promise<PortAnswer>; roles?: (r: any) => void; failAudit?: boolean; tenantId?: string } = {}) {
  const { createReprocessService } = await load();
  const w = makeReprocessWorld({ messages: [msgRow(1, o.msg)], records: o.records ?? [] });
  const port = makeLabPort(w, o.program);
  const c = makeRctx(w, { port, ...(o.roles ? { roles: o.roles } : {}), ...(o.failAudit ? { failAudit: true } : {}), ...(o.tenantId ? { tenantId: o.tenantId } : {}) });
  const driver = o.driver === undefined ? spyDriver(o.recs ?? [GLU, NA, QC]) : o.driver;
  const svc = createReprocessService({ repo: w.repo, ...(driver ? { getDriver: driver.getDriver } : {}) });
  // an explicit `undefined` id must reach the service (rest args, not default params)
  const reprocess = (body: unknown = BODY, ...rest: unknown[]) => svc.reprocessInstrumentMessage(c.ctx, { instrumentMessageId: rest.length ? rest[0] : MSG, body } as any);
  const rematch = (body: unknown = REMATCH, ...rest: unknown[]) => svc.rematchInstrumentRecord(c.ctx, { recordId: rest.length ? rest[0] : REC, body } as any);
  return { w, c, port, driver, svc, reprocess, rematch };
}
const untouched = (s: Awaited<ReturnType<typeof setup>>) => {
  expect(s.w.writes()).toEqual([]); expect(s.port.calls).toEqual([]); expect(s.w.events).toEqual([]); expect(s.w.accessRows()).toEqual([]);
};

describe('E38 reprocess — AC-19.1', () => {
  it('quarantined message: a NEW run kind=reprocess (run_no+1, reason, user actor) parses the ARCHIVED bytes with the current driver; 200 { run, records }', async () => {
    const s = await setup({ msg: { latest_run: { run_no: 1, kind: 'live', outcome: 'quarantined' } } });
    const r = await s.reprocess();
    expect(r.status).toBe(200);
    expect(s.driver!.seen).toHaveLength(1); expect(s.driver!.seen[0]!.raw.equals(RAW)).toBe(true);
    expect(s.driver!.seen[0]!.ctx).toMatchObject({ instrumentTimezone: 'Asia/Kathmandu', receivedAt: '2026-11-07T04:05:00.000Z' });
    const run = s.w.callsOf('insertRun'); expect(run).toHaveLength(1);
    expect(run[0]!.args[0]).toMatchObject({ message_id: MSG, centre_id: CENTRE_A1, run_no: 2, kind: 'reprocess', driver_code: 'astm_generic_e1394', driver_version: '9.9.9', outcome: 'parsed',
      reason_code: 'driver_fixed', reason_text: REASON_TEXT_PLANT, actor_type: 'user', patient_records: 2, qc_records: 1, calibrator_records: 0, unmapped_records: 1, emitted_events: 3 });
    expect(run[0]!.tx).toBe(s.w.tx);
    expect(r.body.run).toMatchObject({ run_no: 2, kind: 'reprocess', outcome: 'parsed', reason_code: 'driver_fixed', actor_type: 'user' });
    expect(r.body.preview).toBe(false);                                           // live instrument: openapi E38 requires `preview`
    expect(r.body.records).toHaveLength(3);
    expect(r.body.records.map((x: Row) => x['record_class'])).toEqual(['patient', 'patient', 'qc']);
    expect(s.w.callsOf('insertRecords')).toHaveLength(1);                         // class A: one batched insert, no update anywhere
    expect(s.w.calls.map((x) => x.op).filter((op) => !/^(find|get|insert)/.test(op))).toEqual([]);
  });

  it.each(['quarantined', 'shadow', 'parsed'])('latest outcome %s is eligible', async (outcome) => {
    const s = await setup({ msg: { latest_run: { run_no: 3, kind: 'live', outcome } } });
    const r = await s.reprocess(); expect(r.status).toBe(200); expect(r.body.run.run_no).toBe(4);
  });

  it('each patient record -> LabPort.ingestInstrumentResult once, in the USER context; outcome stored on the record row and shown in the response', async () => {
    const s = await setup({ program: (i, n) => (i['instrumentAnalyteCode'] === 'GLU' ? { outcome: 'applied', resultId: idN(0xc100 + n), specimenId: idN(0xc200 + n) } : { outcome: 'unmatched', reasonCode: 'mapping_missing' }) });
    const r = await s.reprocess();
    expect(s.port.calls).toHaveLength(2);                                          // two patient records, the QC record never reaches the port
    for (const c of s.port.calls) expect(c.ctx).toMatchObject({ tenantId: TENANT_A, actor: { type: 'user', id: USER } });
    const glu = r.body.records.find((x: Row) => x['instrument_analyte_code'] === 'GLU'); const na = r.body.records.find((x: Row) => x['instrument_analyte_code'] === 'NA');
    expect(glu).toMatchObject({ port_outcome: 'applied', port_result_id: idN(0xc101), emit_status: 'emitted' });
    expect(na).toMatchObject({ port_outcome: 'unmatched', port_reason_code: 'mapping_missing', mapping_status: 'unmapped' });
    const rows = s.w.callsOf('insertRecords')[0]!.args[0] as Row[];
    expect(rows.find((x) => x['instrument_analyte_code'] === 'GLU')).toMatchObject({ port_outcome: 'applied', port_result_id: idN(0xc101), run_id: expect.anything() });
    expect(rows.find((x) => x['instrument_analyte_code'] === 'NA')).toMatchObject({ port_outcome: 'unmatched', port_reason_code: 'mapping_missing' });
  });

  it.each(['applied', 'duplicate', 'unmatched', 'rejected_state', 'held'] as const)('port outcome %s is stored verbatim (a 200, never an error)', async (outcome) => {
    const s = await setup({ recs: [GLU], program: () => ({ outcome, resultId: idN(0xc111) }) });
    const r = await s.reprocess(); expect(r.status).toBe(200);
    expect(r.body.records[0]).toMatchObject({ port_outcome: outcome });
    expect((s.w.callsOf('insertRecords')[0]!.args[0] as Row[])[0]).toMatchObject({ port_outcome: outcome, port_result_id: idN(0xc111) });
  });

  it('InstrumentResultInput is the event payload camelCased field for field (08 A13 D-10): unitRaw, processingKind reprocess, no sourceRecordId, no unitCode', async () => {
    const s = await setup({ recs: [GLU] });
    await s.reprocess();
    const input = s.port.calls[0]!.input; const ev = s.w.eventsOf(RESULT); expect(ev).toHaveLength(1);
    expect(input).toEqual(snakeToCamel(ev[0]!['payload'] as Row));
    expect(input).toMatchObject({ instrumentMessageId: MSG, instrumentId: INS(1), agentId: AGENT_A1, centreId: CENTRE_A1, protocol: 'astm', sampleBarcode: PLANT.barcode, recordKind: 'quantitative',
      instrumentAnalyteCode: 'GLU', mappingStatus: 'mapped', valueRaw: '5.4', valueNumeric: '5.4', unitRaw: 'mmol/L', instrumentFlags: ['N'], instrumentResultTime: rt, isRerun: true,
      receivedAt: '2026-11-07T04:05:00.000Z', capturedAt: '2026-11-07T04:00:00.000Z', processingKind: 'reprocess' });
    expect(input).not.toHaveProperty('sourceRecordId'); expect(input).not.toHaveProperty('unitCode');
  });

  it('events: instruments.result.received.v1 per patient record, processing_kind=reprocess, ORIGINAL message id + received_at, user actor, result-level idempotency key; QC -> instruments.qc.received.v1 only', async () => {
    const s = await setup();
    await s.reprocess();
    const ev = s.w.eventsOf(RESULT); expect(ev).toHaveLength(2);
    for (const e of ev) {
      expect(e['actor']).toMatchObject({ type: 'user', id: USER });
      expect(e['aggregate']).toEqual({ type: 'instrument_message', id: MSG, seq: 1 });
      expect(e['payload']).toMatchObject({ processing_kind: 'reprocess', instrument_message_id: MSG, received_at: '2026-11-07T04:05:00.000Z', sample_barcode: PLANT.barcode });
      expect(e['payload']).not.toHaveProperty('source_record_id');
    }
    expect(ev.map((e) => e['idempotency_key']).sort()).toEqual([`${INS(1)}:${PLANT.barcode}:GLU:${rt}`, `${INS(1)}:${PLANT.barcode}:NA:${rt}`]);
    const qc = s.w.eventsOf(QCE); expect(qc).toHaveLength(1);
    expect(qc[0]!['payload']).toMatchObject({ processing_kind: 'reprocess', control_id_raw: 'QC-L1-0007', instrument_analyte_code: 'GLU' });
    expect(s.port.calls.map((c) => c.input['valueRaw'])).toEqual(['5.4', '141']);          // the QC value (5.0) never reaches the port
  });

  it('order inside the transaction: for each patient record the port call comes first, then its event (C5 sees `duplicate` for the same key)', async () => {
    const s = await setup({ recs: [GLU, NA] });
    await s.reprocess();
    const seq = s.w.order.filter((x) => x === 'port' || x === 'event');
    expect(seq).toEqual(['port', 'event', 'port', 'event']);
  });

  it('a key the live run already emitted: the port is asked again, the event is NOT re-published (duplicate_event, not counted as emitted)', async () => {
    const s = await setup({ recs: [GLU], program: (_i, n) => ({ outcome: n === 1 ? 'applied' : 'duplicate' }) });
    await s.reprocess(); const before = s.w.events.length;
    const r2 = await s.reprocess();
    expect(s.w.events.length).toBe(before); expect(s.port.calls).toHaveLength(2);
    expect(r2.body.run.run_no).toBe(3);
    expect(r2.body.records[0]).toMatchObject({ emit_status: 'duplicate_event', port_outcome: 'duplicate' });
    expect(s.w.callsOf('insertRun')[1]!.args[0]).toMatchObject({ emitted_events: 0 });
  });

  it.each(['commissioning', 'suspended'])('instrument %s (not live): runs as a SHADOW preview — no port calls, no events, run.outcome=shadow — and the access_log row is still written', async (state) => {
    const s = await setup({ msg: { instrument_state: state, latest_run: { run_no: 1, kind: 'live', outcome: 'shadow' } } });
    const r = await s.reprocess();
    expect(r.status).toBe(200); expect(r.body.run).toMatchObject({ kind: 'reprocess', outcome: 'shadow', run_no: 2 });
    expect(r.body.preview).toBe(true);                                            // not live, nothing sent: says so in the response
    expect(s.port.calls).toEqual([]); expect(s.w.events).toEqual([]);
    for (const x of r.body.records) { expect(x['emit_status']).not.toBe('emitted'); expect(x['port_outcome'] ?? null).toBeNull(); }
    expect(s.w.accessRows()).toHaveLength(1);
  });

  it('the current driver still cannot parse it: run outcome quarantined (instruments.message_malformed), no port call, no event, 200 and an access_log row', async () => {
    const d = spyDriver([], { result: { ok: false, errorCode: 'instruments.message_malformed', reason: 'bad frame' } });
    const s = await setup({ driver: d });
    const r = await s.reprocess();
    expect(r.status).toBe(200); expect(r.body.run).toMatchObject({ outcome: 'quarantined', error_code: 'instruments.message_malformed', kind: 'reprocess' });
    expect(r.body.records).toEqual([]); expect(s.port.calls).toEqual([]); expect(s.w.events).toEqual([]); expect(s.w.accessRows()).toHaveLength(1);
  });

  it('a driver that throws on hostile bytes is a quarantine, never a 5xx', async () => {
    const d = spyDriver([GLU]); d.driver.parse = () => { throw new Error('boom ' + PLANT.barcode); };
    const s = await setup({ driver: d });
    const r = await s.reprocess(); expect(r.body.run.outcome).toBe('quarantined'); expect(s.c.logText()).not.toContain(PLANT.barcode);
  });

  it('no barcode -> skipped_no_barcode; an over-long barcode -> skipped_invalid; neither reaches the port or publishes an event', async () => {
    const s = await setup({ recs: [rec1({ recordSeq: 1, instrumentAnalyteCode: 'GLU', valueRaw: '5.4', recordKind: 'quantitative' }), rec1({ recordSeq: 2, sampleBarcode: 'B'.repeat(41), instrumentAnalyteCode: 'GLU', valueRaw: '5.4', recordKind: 'quantitative' })] });
    const r = await s.reprocess();
    expect(r.body.records.map((x: Row) => x['emit_status'])).toEqual(['skipped_no_barcode', 'skipped_invalid']);
    expect(s.port.calls).toEqual([]); expect(s.w.events).toEqual([]);
  });

  it('calibrator and host_query records: archived as not_applicable, no port call, no event (calibration capability off)', async () => {
    const s = await setup({ recs: [rec1({ recordSeq: 1, recordClass: 'calibrator', instrumentAnalyteCode: 'GLU', valueRaw: '1', calibratorIdRaw: 'CAL1' }), rec1({ recordSeq: 2, recordClass: 'host_query', sampleBarcode: PLANT.barcode })] });
    const r = await s.reprocess();
    expect(r.body.records.map((x: Row) => x['emit_status'])).toEqual(['not_applicable', 'not_applicable']);
    expect(s.port.calls).toEqual([]); expect(s.w.events).toEqual([]);
  });

  it('a LimsError from the port rolls back THAT record only (its event too) and is shown on the record; the other records are processed', async () => {
    const { LimsError } = await import('../../../core/errors.js');
    const s = await setup({ recs: [GLU, NA], program: (i) => { if (i['instrumentAnalyteCode'] === 'GLU') throw new LimsError('lab.specimen_not_found'); return { outcome: 'applied', resultId: idN(0xc190) }; } });
    const r = await s.reprocess();
    expect(r.status).toBe(200); expect(s.w.tx.rollbacks).toBe(1);
    expect(s.w.eventsOf(RESULT).map((e) => e['payload'].instrument_analyte_code)).toEqual(['NA']);
    const glu = r.body.records.find((x: Row) => x['instrument_analyte_code'] === 'GLU'); const na = r.body.records.find((x: Row) => x['instrument_analyte_code'] === 'NA');
    expect(glu).toMatchObject({ port_reason_code: 'lab.specimen_not_found' }); expect(glu.event_id ?? null).toBeNull(); expect(glu.emit_status).not.toBe('emitted');
    expect(na).toMatchObject({ port_outcome: 'applied', emit_status: 'emitted' });
  });

  it('integration with the REAL generic ASTM driver and registry: the archived patient message reprocessed -> 2 port calls for the archived barcode, 2 events', async () => {
    const s = await setup({ driver: null });
    const r = await s.reprocess(); expect(r.status).toBe(200);
    expect(ASTM_PATIENT).toContain(PLANT.barcode);
    expect(s.port.calls.map((c) => [c.input['sampleBarcode'], c.input['instrumentAnalyteCode']]).sort()).toEqual([[PLANT.barcode, 'GLU'], [PLANT.barcode, 'NA']]);
    expect(s.w.eventsOf(RESULT)).toHaveLength(2);
  });
});

describe('E38 eligibility — AC-19.4 and the 422', () => {
  it.each([
    ['host_query message', { message_kind: 'host_query' }],
    ['retired instrument', { instrument_state: 'retired' }],
    ['latest outcome rejected_capability', { latest_run: { run_no: 1, kind: 'live', outcome: 'rejected_capability' } }],
  ])('%s -> 409 instruments.reprocess_not_allowed; no run, no record, no port call, no event', async (_n, msg) => {
    const s = await setup({ msg: msg as Row });
    const e = await failure(s.reprocess()); expect(e.code).toBe('instruments.reprocess_not_allowed');
    expect(s.w.writes()).toEqual([]); expect(s.port.calls).toEqual([]); expect(s.w.events).toEqual([]);
  });
  it('driver not available for the instrument -> 422 instruments.driver_not_available, nothing written', async () => {
    const d = spyDriver([GLU]); d.getDriver = () => undefined;
    const s = await setup({ driver: d });
    const e = await failure(s.reprocess()); expect(e.code).toBe('instruments.driver_not_available');
    expect(s.w.writes()).toEqual([]); expect(s.port.calls).toEqual([]); expect(s.w.events).toEqual([]);
  });
  it.each([
    ['missing reason_code', {}], ['unknown reason_code', { reason_code: 'because' }], ['reason_text over 300', { reason_code: 'other', reason_text: 'x'.repeat(301) }], ['body not an object', null],
  ])('%s -> 400 common.validation_failed before any work', async (_n, body) => {
    const s = await setup(); const e = await failure(s.reprocess(body));
    expect(e.code).toBe('common.validation_failed'); expect(s.w.writes()).toEqual([]); expect(s.port.calls).toEqual([]); expect(s.w.events).toEqual([]);
  });
});

describe('E39 re-match — AC-19.2, AC-19.5', () => {
  const rows = () => [recordRow(1, MSG), recordRow(2, MSG, { instrument_analyte_code: 'NA', value_raw: '141', value_numeric: '141' })];
  it('re-match parses nothing: no registered driver is needed (200); the run carries the SOURCE run\'s driver_code/driver_version', async () => {
    const d = spyDriver([GLU]); d.getDriver = () => undefined;
    const s = await setup({ records: rows(), driver: d });
    const r = await s.rematch();
    expect(r.status).toBe(200);
    expect(r.body.run).toMatchObject({ kind: 'rematch', driver_code: 'astm_generic_e1394', driver_version: '1.0.0' });
    expect(s.w.callsOf('insertRun')[0]!.args[0]).toMatchObject({ driver_code: 'astm_generic_e1394', driver_version: '1.0.0' });
  });
  it('a derived record (source_record_id, new barcode) in a rematch run; port + event carry processing_kind=rematch and source_record_id; original record unchanged; 200 { run, record }', async () => {
    const s = await setup({ records: rows() });
    const before = structuredClone(s.w.records);
    const r = await s.rematch();
    expect(r.status).toBe(200);
    expect(s.w.callsOf('insertRun')[0]!.args[0]).toMatchObject({ message_id: MSG, run_no: 2, kind: 'rematch', reason_code: 'barcode_keypad_error', actor_type: 'user', patient_records: 1, emitted_events: 1 });
    const ins = s.w.callsOf('insertRecords')[0]!.args[0] as Row[]; expect(ins).toHaveLength(1);
    expect(ins[0]).toMatchObject({ source_record_id: REC, sample_barcode: NEW_BC, instrument_analyte_code: 'GLU', value_raw: '5.4', unit_raw: 'mmol/L', record_class: 'patient', message_id: MSG, port_outcome: 'applied' });
    expect(s.w.records.slice(0, before.length)).toEqual(before);                    // the original is untouched
    expect(s.port.calls).toHaveLength(1);
    expect(s.port.calls[0]!.input).toMatchObject({ sampleBarcode: NEW_BC, processingKind: 'rematch', sourceRecordId: REC, instrumentMessageId: MSG, instrumentAnalyteCode: 'GLU', unitRaw: 'mmol/L' });
    expect(s.port.calls[0]!.ctx.actor).toMatchObject({ type: 'user', id: USER });
    const ev = s.w.eventsOf(RESULT); expect(ev).toHaveLength(1);
    expect(ev[0]!['payload']).toMatchObject({ processing_kind: 'rematch', source_record_id: REC, sample_barcode: NEW_BC, instrument_message_id: MSG });
    expect(ev[0]!['idempotency_key']).toBe(`${INS(1)}:${NEW_BC}:GLU:2026-11-07T04:00:00.000Z`);   // recomputed with the NEW barcode
    expect(ev[0]!['idempotency_key']).not.toContain(PLANT.barcode);
    expect(r.body.run).toMatchObject({ kind: 'rematch', run_no: 2 });
    expect(r.body.record).toMatchObject({ source_record_id: REC, sample_barcode: NEW_BC, port_outcome: 'applied' });
    expect(s.w.order.filter((x) => x === 'port' || x === 'event')).toEqual(['port', 'event']);
  });
  it('AC-19.5 corrected barcode equal to the original -> 400 common.validation_failed; nothing written, the error never echoes the barcode', async () => {
    const s = await setup({ records: rows() });
    const e = await failure(s.rematch({ ...REMATCH, sample_barcode: PLANT.barcode }));
    expect(e.code).toBe('common.validation_failed'); expect(JSON.stringify({ m: e.message, d: e.detail, e: e.errors })).not.toContain(PLANT.barcode);
    expect(s.w.writes()).toEqual([]); expect(s.port.calls).toEqual([]); expect(s.w.events).toEqual([]);
  });
  it.each([['lower case', 'e26abc'], ['41 chars', 'A'.repeat(41)], ['empty', ''], ['punctuation', 'AB-12'], ['not a string', 42]])('barcode %s -> 400 common.validation_failed', async (_n, bc) => {
    const s = await setup({ records: rows() }); const e = await failure(s.rematch({ ...REMATCH, sample_barcode: bc }));
    expect(e.code).toBe('common.validation_failed'); expect(s.w.writes()).toEqual([]); expect(s.port.calls).toEqual([]);
  });
  it('reason_code outside g_cs_reprocess_reasons / reason_text over 300 -> 400', async () => {
    const s = await setup({ records: rows() });
    expect((await failure(s.rematch({ ...REMATCH, reason_code: 'nope' }))).code).toBe('common.validation_failed');
    expect((await failure(s.rematch({ ...REMATCH, reason_text: 'x'.repeat(301) }))).code).toBe('common.validation_failed');
    expect(s.w.writes()).toEqual([]);
  });
  it.each([
    ['a QC record', [recordRow(1, MSG, { record_class: 'qc', control_id_raw: 'QC-1', sample_barcode: null })], {}],
    ['a record of an older run (latest run is 2)', [recordRow(1, MSG, { run_no: 1 })], { latest_run: { run_no: 2, kind: 'reprocess', outcome: 'parsed' } }],
    ['a host_query message', [recordRow(1, MSG)], { message_kind: 'host_query' }],
    ['a retired instrument', [recordRow(1, MSG)], { instrument_state: 'retired' }],
  ])('%s -> 409 instruments.reprocess_not_allowed; nothing written', async (_n, records, msg) => {
    const s = await setup({ records: records as Row[], msg: msg as Row });
    const e = await failure(s.rematch()); expect(e.code).toBe('instruments.reprocess_not_allowed');
    expect(s.w.writes()).toEqual([]); expect(s.port.calls).toEqual([]); expect(s.w.events).toEqual([]);
  });
  it('unknown record id / not a uuid / expired record -> 404 common.not_found; assertRole never reached', async () => {
    const s = await setup({ records: rows() });
    for (const id of [recId(99), 'not-a-uuid', undefined]) expect((await failure(s.rematch(REMATCH, id))).code).toBe('common.not_found');
    expect(s.c.asserted).toEqual([]);
  });
});

describe('AC-19.3 locked target — AB11', () => {
  it('reprocess: approved target -> port says rejected_state/result_locked -> stored and shown, request is still 200, the service makes no other port call (no value changes)', async () => {
    const s = await setup({ recs: [GLU], program: () => ({ outcome: 'rejected_state', reasonCode: 'result_locked', resultId: idN(0xc120) }) });
    const r = await s.reprocess(); expect(r.status).toBe(200);
    expect(r.body.records[0]).toMatchObject({ port_outcome: 'rejected_state', port_reason_code: 'result_locked' });
    expect((s.w.callsOf('insertRecords')[0]!.args[0] as Row[])[0]).toMatchObject({ port_outcome: 'rejected_state', port_reason_code: 'result_locked' });
    expect(s.port.calls).toHaveLength(1);
  });
  it('re-match: same', async () => {
    const s = await setup({ records: [recordRow(1, MSG)], program: () => ({ outcome: 'rejected_state', reasonCode: 'result_locked' }) });
    const r = await s.rematch(); expect(r.status).toBe(200);
    expect(r.body.record).toMatchObject({ port_outcome: 'rejected_state', port_reason_code: 'result_locked', source_record_id: REC });
    expect(s.port.calls).toHaveLength(1);
  });
});

describe('access_log — REQ-SEC-096/097 (same transaction, fails closed)', () => {
  it('reprocess: exactly one instrument_message.reprocess row (entity = the message, the message centre), written on ctx.tx', async () => {
    const s = await setup(); await s.reprocess();
    expect(s.w.accessRows()).toEqual([expect.objectContaining({ tenantId: TENANT_A, centreId: CENTRE_A1, actorId: USER, action: 'instrument_message.reprocess', entityType: 'instrument_message', entityId: MSG, outcome: 'allowed' })]);
    expect(s.w.auditInserts).toHaveLength(1);                                       // written through ctx.tx (the same transaction as the run / records / events)
  });
  it('re-match: exactly one instrument_message.rematch row, entity = the message, detail.record_id = the source record, no barcode in the row', async () => {
    const s = await setup({ records: [recordRow(1, MSG)] }); await s.rematch();
    const rows = s.w.accessRows(); expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'instrument_message.rematch', entityType: 'instrument_message', entityId: MSG, centreId: CENTRE_A1, outcome: 'allowed' });
    expect(rows[0]!.detail).toMatchObject({ record_id: REC });
    expect(JSON.stringify(rows[0])).not.toContain(PLANT.barcode); expect(JSON.stringify(rows[0])).not.toContain(NEW_BC);
  });
  it('the audit write failing fails the request (no response)', async () => {
    expect((await failure((await setup({ failAudit: true })).reprocess())).code).toBe('common.internal');
    expect((await failure((await setup({ failAudit: true, records: [recordRow(1, MSG)] })).rematch())).code).toBe('common.internal');
  });
});

describe('authorisation and tenancy — BOLA', () => {
  it('assertRole(instruments.message.rematch) at the MESSAGE centre, after the row was loaded (reprocess and re-match)', async () => {
    const s = await setup({ records: [recordRow(1, MSG)], msg: { centre_id: CENTRE_A2 } });
    await s.rematch(); await s.reprocess();      // rematch first: after a reprocess the record is of an older run (409)
    expect(s.c.asserted).toEqual([{ permission: PERM, centreId: CENTRE_A2 }, { permission: PERM, centreId: CENTRE_A2 }]);
    expect(s.w.order.indexOf('findMessage')).toBeLessThan(s.w.order.indexOf('assertRole'));
  });
  it('only instruments.message.read -> auth.forbidden; no raw read, no run, no port call, no event, no access_log row', async () => {
    const s = await setup({ records: [recordRow(1, MSG)], roles: readOnly });
    for (const call of [() => s.reprocess(), () => s.rematch()]) { const e = await failure(call()); expect(e.code).toBe('auth.forbidden'); }
    untouched(s); expect(s.w.callsOf('getMessageRawBytes')).toEqual([]);
  });
  it('a principal scoped to centre A1 cannot reprocess / re-match a message of centre A2', async () => {
    const s = await setup({ records: [recordRow(1, MSG, { centre_id: CENTRE_A2 })], msg: { centre_id: CENTRE_A2 }, roles: onlyCentre(CENTRE_A1) });
    expect((await failure(s.reprocess())).code).toBe('auth.forbidden'); expect((await failure(s.rematch())).code).toBe('auth.forbidden'); untouched(s);
  });
  it('unknown / invalid-uuid message -> 404 and assertRole is never reached (404 before 403)', async () => {
    const s = await setup();
    for (const id of [msgId(99), 'nope', undefined, 42]) expect((await failure(s.reprocess(BODY, id))).code).toBe('common.not_found');
    expect(s.c.asserted).toEqual([]); untouched(s);
  });
  it('another tenant\'s message / record -> 404; every repo call carries the caller\'s tenant', async () => {
    const s = await setup({ records: [recordRow(1, MSG)], tenantId: TENANT_B });
    expect((await failure(s.reprocess())).code).toBe('common.not_found'); expect((await failure(s.rematch())).code).toBe('common.not_found');
    expect(s.w.calls.every((c) => c.tenantId === TENANT_B)).toBe(true); untouched(s);
  });
});

describe('hygiene — 02-CV §9.2 / REQ-SEC-098', () => {
  it('logs and metrics carry no barcode, value, reason text or raw byte; the reprocess counter is labelled kind + port_outcome', async () => {
    const s = await setup({ records: [recordRow(1, MSG)] });
    await s.rematch(); await s.reprocess();      // rematch first: after a reprocess the record is of an older run (409)
    const text = s.c.logText();
    for (const secret of [PLANT.barcode, NEW_BC, PLANT.value, 'Testpatient', REASON_TEXT_PLANT]) expect(text).not.toContain(secret);
    expect(s.c.metricCalls).toContainEqual(['lims_instruments_reprocess_total', { kind: 'reprocess', port_outcome: 'applied' }]);
    expect(s.c.metricCalls).toContainEqual(['lims_instruments_reprocess_total', { kind: 'rematch', port_outcome: 'applied' }]);
  });
  it('response DTOs expose no tenant_id / created_by / result_key_sha256 / raw bytes', async () => {
    const s = await setup({ records: [recordRow(1, MSG)] });
    const b = JSON.stringify((await s.rematch()).body); const a = JSON.stringify((await s.reprocess()).body);   // rematch first (older-run rule)
    for (const t of [a, b]) { expect(t).not.toMatch(/tenant_id|created_by|result_key_sha256|raw_bytes|raw_base64/); expect(t).not.toContain(TENANT_A); }
  });
});
