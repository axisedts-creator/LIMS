// C5 T-22 — instrument apply pipeline of ../ingest.service.ts against a fake store, no database (02-TRD §4.5 steps 1-12 + attachment rule; 03-IC §3.14, §4.5 `ingestInstrumentResult`;
// PRD AC-14.1, AC-14.2, AC-14.3, AC-14.4, AC-14.7, AC-14.8; 07-SECURITY P-08, S-07, S-08, REQ-SEC-024, REQ-SEC-098, REQ-SEC-121; 08 A13 D-10, A17.1, CR-C5-008, CR-C7-011, CR-C9-004).
// The pure decision table has its own cases in ../../domain/__tests__/matching.test.ts; here: orchestration, log/exception writes, tenant, hook, failure behaviour.
//
// SEAM (spec fixes behaviour, not names) — ../ingest.service.ts must export (all run in ctx.tx, every store call is (tx, tenantId, ...), tenant from ctx only):
//   ingestInstrumentResult(ctx, input: InstrumentResultInput)        port path, caller actor, first_source 'port'    -> { outcome, resultId?, specimenId?, reasonCode? }
//   applyInstrumentResultEvent(ctx, envelope)                        bulk path, system actor, first_source 'event'; envelope = { event_id, tenant_id, payload (03-IC §3.14, snake_case) }; same steps and result.
//                                                                    envelope.tenant_id !== ctx.tenantId -> LimsError common.internal BEFORE any store/port call (REQ-SEC-024, P-08).
//   ctx = { tenantId, actor{type,id,membershipId?}, tx, now(): Date, store: IngestStore, config: { autoverifyHookEnabled }, events.publish, audit.access, log?,
//           ports: { CatalogPort{ mapInstrumentCode, referenceRangeFor, criticalLimitsFor }, QualityPort?{ canAutoVerify }, IdentityPort? } }
//   IngestStore (plus the T-16 VerifyStore members lockForVerify/verify that autoVerifyAfterInstrumentSave (result.service) uses on the same ctx.store):
//     claimKey(tx, tenantId, { resultKey, centreId, firstSource: 'event'|'port', firstEventId?, occurredAt })
//         -> { inserted, logId, lastOutcome, resultId?, specimenId?, openExceptionId? }   step 1 = INSERT ... ON CONFLICT DO NOTHING, else the stored outcome (+ the open C5 exception of the key, if any)
//     findSpecimen(tx, tenantId, barcode) -> { specimenId, status, isActive, centreId, processingCentreId? } | undefined
//     getIngestAutoReceive(tx, tenantId) -> boolean                                       lab_settings.ingest_auto_receive
//     lockSpecimenResults(tx, tenantId, specimenId) -> EntryRow[] (T-14 row shape + status, non-cancelled only)
//     receiveSpecimen(tx, tenantId, { specimenId, processingCentreId, occurredAt })       S4 as system, processing_centre_id = event centre_id
//     isOnQcHold(tx, tenantId, { instrumentId, analyteId, at }) -> boolean
//     deltaInputs(tx, tenantId, row)                                                      as T-14 EntryStore
//     saveInstrumentResult(tx, tenantId, { resultId, expectedRowVersion, transition: 'R2'|'R3', origin: 'instrument', instrumentId, value: { numeric }, unitCode?, unitMismatch, onHold,
//                          instrumentFlags (mapped through flagMap, unmapped raw kept), rawInstrumentFlags, valueRaw?, unitRaw?, evaluation?, instrumentResultTime?, receivedAt, isRerun, instrumentMessageId })
//         -> ResultRow     R2/R3 UPDATE ... WHERE version + lab.result_observations row. `evaluation` ABSENT when unit_mismatch (flag evaluation skipped).
//     insertAttachment(tx, tenantId, { resultId, bucket, objectPath, sha256, mimeType })
//     upsertOpenException(tx, tenantId, { resultKey, reason, centreId, processingCentreId?, instrumentId, instrumentMessageId, sampleBarcode, recordKind, instrumentAnalyteCode, analyteId?, specimenId?, resultId?, ...record fields, occurredAt }) -> { exceptionId }
//     closeOpenExceptions(tx, tenantId, { resultKey, resolution: 'applied', resolverMembershipId?, occurredAt })
//     finishLog(tx, tenantId, logId, { lastOutcome, resultId?, specimenId?, processingCentreId?, exceptionId?, occurredAt })
//     rollupSpecimen(tx, tenantId, specimenId)
// ASSUMED (spec silent): only quantitative/numeric values are exercised (value_numeric -> value.numeric); an `attachment` record attaches the file to the matched result and saves no value.
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { applyInstrumentResultEvent, ingestInstrumentResult } from '../ingest.service.js';

const TENANT = '01a1a98a-ac40-7000-8000-00000000a001', OTHER = '01a1a98a-ac40-7000-8000-00000000b001';
const ACTOR = '01a1b34e-1000-7eee-9d29-d7ca59a102b5', MEMBERSHIP = '01a1b34e-2000-7eee-9d29-d7ca59a102b6', SYS = '01a1b34e-1000-7eee-9d29-d7ca59a10000';
const INSTR = '01a1a98a-ac40-7000-8000-0000000d00f1', AGENT = '01a1a98a-ac40-7000-8000-0000000d00a1', MSG = '01a1a98a-ac40-7000-8000-0000000d00c1', EVENT = '01a1a98a-ac40-7000-8000-0000000d00e1';
const CENTRE = '01a1a98a-ac40-7000-8000-00000000a201', PROC_CENTRE = '01a1a98a-ac40-7000-8000-00000000a202';
const SPEC = '01a1a98a-ac40-7000-8000-0000000e0001', ORDER = '01a1a98a-ac40-7000-8000-0000000c0001', ITEM = '01a1a98a-ac40-7000-8000-0000000b0001', PATIENT = '01a1a98a-ac40-7000-8000-0000000d0001';
const HGB = '01a1a98a-ac40-7000-8000-0000000a0001', WBC = '01a1a98a-ac40-7000-8000-0000000a0002', TEST = '01a1a98a-ac40-7000-8000-0000000f0001';
const R_HGB = '01a1a98a-ac40-7000-8000-0000000a1001', LOG_ID = '01a1a98a-ac40-7000-8000-0000000a2001', EXC_ID = '01a1a98a-ac40-7000-8000-0000000a3001';
const NOW = new Date('2026-06-15T05:00:00Z');
const BARCODE = 'SN2606150042', VALUE_RAW = '13.4';
const RESULT_TIME = '2026-06-15T04:55:00.000Z';
const KEY = `${INSTR}:${BARCODE}:HGB:${RESULT_TIME}`;
const WRITES = ['saveInstrumentResult', 'insertAttachment', 'upsertOpenException', 'closeOpenExceptions', 'receiveSpecimen', 'rollupSpecimen', 'verify'];

const hgbRow = (over: Record<string, unknown> = {}) => ({
  resultId: R_HGB, rowVersion: 3, status: 'pending', orderId: ORDER, orderItemId: ITEM, specimenId: SPEC, patientId: PATIENT, testId: TEST, analyteId: HGB, centreId: CENTRE,
  currentVersionNo: 1, sex: 'female', patientAgeDays: 12000, specimenTypeCode: 'EDTA', unitCode: 'g/dL', departmentId: 'd-1',
  analyte: { id: HGB, code: 'HGB', resultType: 'numeric', decimals: 1 }, ...over,
});
const mapping = (over: Record<string, unknown> = {}) => ({ mappingId: 'm-1', instrumentId: INSTR, instrumentCode: 'HGB', analyteId: HGB, testId: TEST, ...over });
const input = (over: Record<string, unknown> = {}) => ({
  instrumentMessageId: MSG, instrumentId: INSTR, agentId: AGENT, centreId: CENTRE, protocol: 'astm', sampleBarcode: BARCODE, recordKind: 'quantitative', instrumentAnalyteCode: 'HGB',
  mappingStatus: 'mapped', analyteId: HGB, testId: TEST, valueRaw: VALUE_RAW, valueNumeric: VALUE_RAW, unitRaw: 'g/dL', unitCode: 'g/dL', instrumentResultTime: RESULT_TIME, receivedAt: '2026-06-15T04:56:00.000Z', ...over,
}) as any;
const toSnake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const payload = (over: Record<string, unknown> = {}) => Object.fromEntries(Object.entries(input(over)).map(([k, v]) => [toSnake(k), v]));
const envelope = (over: Record<string, unknown> = {}, tenant = TENANT) => ({ event_id: EVENT, event_type: 'instruments.result.received.v1', tenant_id: tenant, producer: 'instruments', payload: payload(over) }) as any;

interface Opt {
  specimen?: Record<string, unknown> | null; rows?: any[]; autoReceive?: boolean; hold?: boolean; claim?: Record<string, unknown>; map?: any; mapThrows?: Error;
  hookEnabled?: boolean; decision?: any; canAutoVerifyThrows?: Error; saveThrows?: Error; rangeThrows?: Error; actor?: any;
}
function make(opt: Opt = {}) {
  const tx = { id: 'tx-1', query: async () => ({ rows: [], rowCount: 0 }) };
  const log: { fn: string; tenantId: unknown; tx: unknown; arg: any }[] = [];
  const events: any[] = [], logged: unknown[][] = [], asked: any[] = [], portCalls: string[] = [];
  const rec = (fn: string, t: unknown, tenantId: unknown, arg?: any) => log.push({ fn, tenantId, tx: t, arg });
  const spec = opt.specimen === null ? undefined : { specimenId: SPEC, status: 'received', isActive: true, centreId: CENTRE, processingCentreId: PROC_CENTRE, ...(opt.specimen ?? {}) };
  let lastSave: any;
  const store = {
    async claimKey(t: unknown, tenantId: unknown, a: any) { rec('claimKey', t, tenantId, a); return { inserted: true, logId: LOG_ID, lastOutcome: 'applied', ...(opt.claim ?? {}) }; },
    async findSpecimen(t: unknown, tenantId: unknown, b: string) { rec('findSpecimen', t, tenantId, b); return b === BARCODE ? spec : undefined; },
    async getIngestAutoReceive(t: unknown, tenantId: unknown) { rec('getIngestAutoReceive', t, tenantId); return opt.autoReceive ?? false; },
    async lockSpecimenResults(t: unknown, tenantId: unknown, s: string) { rec('lockSpecimenResults', t, tenantId, s); return opt.rows ?? [hgbRow()]; },
    async receiveSpecimen(t: unknown, tenantId: unknown, a: any) { rec('receiveSpecimen', t, tenantId, a); },
    async isOnQcHold(t: unknown, tenantId: unknown, a: any) { rec('isOnQcHold', t, tenantId, a); return opt.hold ?? false; },
    async deltaInputs(t: unknown, tenantId: unknown, r: any) { rec('deltaInputs', t, tenantId, r); return { candidates: [] }; },
    async saveInstrumentResult(t: unknown, tenantId: unknown, a: any) {
      rec('saveInstrumentResult', t, tenantId, a);
      if (opt.saveThrows) throw opt.saveThrows;
      lastSave = a;
      return { id: a.resultId, version: a.expectedRowVersion + 1, status: 'resulted', origin: 'instrument', on_hold: a.onHold, unit_mismatch: a.unitMismatch, specimen_id: SPEC };
    },
    async insertAttachment(t: unknown, tenantId: unknown, a: any) { rec('insertAttachment', t, tenantId, a); },
    async upsertOpenException(t: unknown, tenantId: unknown, a: any) { rec('upsertOpenException', t, tenantId, a); return { exceptionId: EXC_ID }; },
    async closeOpenExceptions(t: unknown, tenantId: unknown, a: any) { rec('closeOpenExceptions', t, tenantId, a); },
    async finishLog(t: unknown, tenantId: unknown, id: string, a: any) { rec('finishLog', t, tenantId, { logId: id, ...a }); },
    async rollupSpecimen(t: unknown, tenantId: unknown, s: string) { rec('rollupSpecimen', t, tenantId, s); },
    // T-16 VerifyStore members used by autoVerifyAfterInstrumentSave
    async lockForVerify(t: unknown, tenantId: unknown, ids: string[]) {
      rec('lockForVerify', t, tenantId, ids);
      if (!lastSave) return [];
      return [{
        resultId: lastSave.resultId, rowVersion: lastSave.expectedRowVersion + 1, status: 'resulted', onHold: lastSave.onHold, unitMismatch: lastSave.unitMismatch, deltaStatus: 'pass', isCritical: false,
        instrumentFlags: lastSave.instrumentFlags ?? [], origin: 'instrument', rangeUnavailableAgeUnknown: lastSave.evaluation?.rangeUnavailableAgeUnknown ?? false, orderId: ORDER, orderItemId: ITEM, specimenId: SPEC,
        testId: TEST, analyteId: HGB, departmentId: 'd-1', instrumentId: INSTR, centreId: CENTRE, currentVersionNo: 1, flag: 'N', valueNumeric: lastSave.value?.numeric, resultedAt: NOW,
      }];
    },
    async verify(t: unknown, tenantId: unknown, a: any) { rec('verify', t, tenantId, a); return { id: a.resultId, version: 5, status: 'verified', origin: 'instrument' }; },
    async listCriticalLog() { return []; }, async insertCriticalLog() { return { criticalEventId: 'ce-1' }; }, async markCriticalValueChanged() {},
  };
  const ctx = {
    tenantId: TENANT, actor: opt.actor ?? { type: 'user', id: ACTOR, membershipId: MEMBERSHIP }, tx, now: () => NOW, store, config: { autoverifyHookEnabled: opt.hookEnabled ?? false },
    events: { async publish(...a: unknown[]) { events.push(a); return { eventId: 'ev', duplicate: false }; } },
    audit: { async access() {} },
    log: { info: (...a: unknown[]) => logged.push(a), warn: (...a: unknown[]) => logged.push(a), error: (...a: unknown[]) => logged.push(a), debug: (...a: unknown[]) => logged.push(a), child() { return this; } },
    ports: {
      CatalogPort: {
        async mapInstrumentCode(_c: unknown, q: any) { portCalls.push('mapInstrumentCode'); asked.push(q); if (opt.mapThrows) throw opt.mapThrows; return opt.map ?? mapping(); },
        async referenceRangeFor() { portCalls.push('referenceRangeFor'); if (opt.rangeThrows) throw opt.rangeThrows; return { referenceRangeId: 'rr-1', version: 1, low: '12.0', high: '17.0', unitCode: 'g/dL' }; },
        async criticalLimitsFor() { portCalls.push('criticalLimitsFor'); return undefined; },
      },
      QualityPort: {
        async canAutoVerify(c: unknown, rc: any) {
          portCalls.push('canAutoVerify'); asked.push(rc);
          if (opt.canAutoVerifyThrows) throw opt.canAutoVerifyThrows;
          return opt.decision ?? { decision: 'deny', reasons: ['feature_disabled'] };
        },
      },
      IdentityPort: { async assertRole() {}, async getTenantSettings() { return { autoVerificationEnabled: false }; } },
    },
  };
  return {
    ctx: ctx as never, tx, log, events, logged, asked, portCalls,
    calls: (fn: string) => log.filter((l) => l.fn === fn),
    wrote: () => log.filter((l) => WRITES.includes(l.fn)).map((l) => l.fn),
    finish: () => log.filter((l) => l.fn === 'finishLog').map((l) => l.arg),
    saved: () => log.filter((l) => l.fn === 'saveInstrumentResult').map((l) => l.arg),
    exceptions: () => log.filter((l) => l.fn === 'upsertOpenException').map((l) => l.arg),
  };
}
const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } throw new Error('expected rejection'); };

// ------------------------------------------------------------------------------------------------------------------------------------------ AC-14.1
describe('T-22 AC-14.1 applied: mapped record, received specimen, pending result', () => {
  for (const [path, run] of [['port', (m: any, o?: any) => ingestInstrumentResult(m.ctx, input(o))], ['event', (m: any, o?: any) => applyInstrumentResultEvent(m.ctx, envelope(o))]] as const) {
    it(`[${path}] outcome applied with result and specimen id; the result is saved as origin instrument by R2 with the raw value, instrument and result time`, async () => {
      const m = make();
      const r = await run(m);
      expect(r).toMatchObject({ outcome: 'applied', resultId: R_HGB, specimenId: SPEC });
      expect(m.saved()).toHaveLength(1);
      expect(m.saved()[0]).toMatchObject({
        resultId: R_HGB, expectedRowVersion: 3, transition: 'R2', origin: 'instrument', instrumentId: INSTR, value: { numeric: VALUE_RAW }, valueRaw: VALUE_RAW,
        unitMismatch: false, onHold: false, instrumentResultTime: RESULT_TIME, instrumentMessageId: MSG,
      });
    });
    it(`[${path}] the ingest_log row is claimed under the result-level key FIRST and finished as applied with the result, specimen and the specimen's processing centre (08 R3)`, async () => {
      const m = make();
      await run(m);
      expect(m.log[0]!.fn).toBe('claimKey');
      expect(m.calls('claimKey')[0]!.arg).toMatchObject({ resultKey: KEY, centreId: CENTRE, firstSource: path });
      expect(m.finish()).toHaveLength(1);
      expect(m.finish()[0]).toMatchObject({ logId: LOG_ID, lastOutcome: 'applied', resultId: R_HGB, specimenId: SPEC, processingCentreId: PROC_CENTRE });
    });
    it(`[${path}] every store call carries ctx.tx and ctx.tenantId (REQ-SEC-024)`, async () => {
      const m = make();
      await run(m);
      expect(m.log.length).toBeGreaterThan(3);
      for (const l of m.log) { expect(l.tenantId, l.fn).toBe(TENANT); expect(l.tx, l.fn).toBe(m.tx); }
    });
    it(`[${path}] the specimen is rolled up once after the save; a re-run of an already resulted row is R3`, async () => {
      const m = make({ rows: [hgbRow({ status: 'resulted' })] });
      await run(m);
      expect(m.saved()[0]).toMatchObject({ transition: 'R3' });
      expect(m.calls('rollupSpecimen').map((c) => c.arg)).toEqual([SPEC]);
    });
  }

  it('event path: first_source event + first_event_id = the envelope event id; port path has no event id', async () => {
    const e = make(); await applyInstrumentResultEvent(e.ctx, envelope());
    expect(e.calls('claimKey')[0]!.arg).toMatchObject({ firstSource: 'event', firstEventId: EVENT });
    const p = make(); await ingestInstrumentResult(p.ctx, input());
    expect(p.calls('claimKey')[0]!.arg.firstSource).toBe('port');
    expect(p.calls('claimKey')[0]!.arg.firstEventId).toBeUndefined();
  });

  it('the value is evaluated against the catalog (reference range) and the evaluation travels with the save (§4.3)', async () => {
    const m = make();
    await ingestInstrumentResult(m.ctx, input());
    expect(m.portCalls).toContain('referenceRangeFor');
    expect(m.saved()[0]!.evaluation).toBeDefined();
    expect(m.saved()[0]!.evaluation.valueSha256Prefix16).toMatch(/^[0-9a-f]{16}$/);
  });

  it('raw instrument flags are mapped through the mapping flagMap (unmapped raw flags are kept) and the raw flags are kept for the observation', async () => {
    const m = make({ map: mapping({ flagMap: { H: 'HIGH' } }) });
    await ingestInstrumentResult(m.ctx, input({ instrumentFlags: ['H', 'Z9'] }));
    expect(m.saved()[0]).toMatchObject({ instrumentFlags: ['HIGH', 'Z9'], rawInstrumentFlags: ['H', 'Z9'] });
  });
  it('instrumentFlags absent = [] and isRerun absent = false (08 A13 D-10)', async () => {
    const m = make();
    await ingestInstrumentResult(m.ctx, input());
    expect(m.saved()[0]).toMatchObject({ instrumentFlags: [], isRerun: false });
  });

  it('unit conversion runs on both paths: unit_raw matches fromUnitRaw -> value x factor, stored unit = toUnitCode, no mismatch (45 g/L x 0.1 = 4.5 g/dL)', async () => {
    const conv = { fromUnitRaw: 'g/L', toUnitCode: 'g/dL', factor: '0.1' };
    for (const run of [(m: any) => ingestInstrumentResult(m.ctx, input({ valueRaw: '45', valueNumeric: '45', unitRaw: 'g/L', unitCode: undefined })),
                       (m: any) => applyInstrumentResultEvent(m.ctx, envelope({ valueRaw: '45', valueNumeric: '45', unitRaw: 'g/L', unitCode: undefined }))]) {
      const m = make({ map: mapping({ unitConversion: conv }) });
      expect(await run(m)).toMatchObject({ outcome: 'applied' });
      expect(Number(m.saved()[0]!.value.numeric)).toBeCloseTo(4.5, 10);
      expect(m.saved()[0]).toMatchObject({ unitCode: 'g/dL', unitMismatch: false });
      expect(m.saved()[0]!.valueRaw).toBe('45');   // raw as received stays in the observation
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------ step 1 / AC-14.2
describe('T-22 AC-14.2 duplicate result-level key (step 1)', () => {
  it.each(['applied', 'held', 'not_applicable'])('stored outcome %s -> duplicate, nothing is written, no port is called', async (lastOutcome) => {
    const m = make({ claim: { inserted: false, lastOutcome, resultId: R_HGB, specimenId: SPEC } });
    const r = await ingestInstrumentResult(m.ctx, input());
    expect(r).toMatchObject({ outcome: 'duplicate' });
    expect(m.wrote()).toEqual([]);
    expect(m.portCalls).toEqual([]);
    expect(m.events).toEqual([]);
  });
  it.each(['unmatched', 'rejected_state'])('stored outcome %s WITHOUT an open exception -> duplicate (nothing to re-evaluate)', async (lastOutcome) => {
    const m = make({ claim: { inserted: false, lastOutcome } });
    expect(await ingestInstrumentResult(m.ctx, input())).toMatchObject({ outcome: 'duplicate' });
    expect(m.wrote()).toEqual([]);
  });
  it('same event delivered twice: the second delivery is a duplicate and saves nothing (event path)', async () => {
    const m = make({ claim: { inserted: false, lastOutcome: 'applied', resultId: R_HGB } });
    expect(await applyInstrumentResultEvent(m.ctx, envelope())).toMatchObject({ outcome: 'duplicate' });
    expect(m.saved()).toEqual([]);
  });
  it('a rerun (other instrument_result_time) is another result-level key, claimed and applied separately', async () => {
    const m = make({ rows: [hgbRow({ status: 'resulted' })] });
    await ingestInstrumentResult(m.ctx, input({ instrumentResultTime: '2026-06-15T05:10:00.000Z', isRerun: true }));
    expect(m.calls('claimKey')[0]!.arg.resultKey).toBe(`${INSTR}:${BARCODE}:HGB:2026-06-15T05:10:00.000Z`);
    expect(m.saved()[0]).toMatchObject({ transition: 'R3', isRerun: true });
  });
  it("no instrument_result_time -> the key ends in ':none'", async () => {
    const m = make();
    await ingestInstrumentResult(m.ctx, input({ instrumentResultTime: undefined }));
    expect(m.calls('claimKey')[0]!.arg.resultKey).toBe(`${INSTR}:${BARCODE}:HGB:none`);
  });

  describe('replay after a fix (CR-C7-011): stored unmatched/rejected_state + an open C5 exception -> re-evaluated from step 2', () => {
    it.each(['unmatched', 'rejected_state'])('%s + open exception + now applicable -> applied, log outcome updated, the exception closed (resolution applied)', async (lastOutcome) => {
      const m = make({ claim: { inserted: false, lastOutcome, openExceptionId: EXC_ID } });
      const r = await ingestInstrumentResult(m.ctx, input());
      expect(r).toMatchObject({ outcome: 'applied', resultId: R_HGB });
      expect(m.saved()).toHaveLength(1);
      expect(m.finish()[0]).toMatchObject({ logId: LOG_ID, lastOutcome: 'applied', resultId: R_HGB });
      expect(m.calls('closeOpenExceptions').map((c) => c.arg)).toEqual([expect.objectContaining({ resultKey: KEY, resolution: 'applied' })]);
    });
    it('still not applicable on replay -> stays unmatched with the open exception kept (no second exception row is a store concern: upsert on the open key)', async () => {
      const m = make({ claim: { inserted: false, lastOutcome: 'unmatched', openExceptionId: EXC_ID }, specimen: null });
      const r = await ingestInstrumentResult(m.ctx, input());
      expect(r).toMatchObject({ outcome: 'unmatched' });
      expect(m.calls('closeOpenExceptions')).toEqual([]);
      expect(m.exceptions()).toHaveLength(1);
    });
  });

  it('port path closes the open exceptions of the same result key when the record applies (step 12)', async () => {
    const m = make();
    await ingestInstrumentResult(m.ctx, input());
    expect(m.calls('closeOpenExceptions').map((c) => c.arg)).toEqual([expect.objectContaining({ resultKey: KEY, resolution: 'applied' })]);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------ step 2
describe('T-22 §4.5 step 2: organism_id / ast', () => {
  it.each(['organism_id', 'ast'])('%s -> not_applicable in the log, no exception, no catalog call, no specimen lookup, nothing saved (C10 consumes it)', async (recordKind) => {
    const m = make();
    const r = await applyInstrumentResultEvent(m.ctx, envelope({ recordKind, instrumentAnalyteCode: recordKind === 'ast' ? 'AST:1:AMP:mic' : 'ORG:1', mappingStatus: 'unmapped', analyteId: undefined, testId: undefined }));
    expect(r.outcome).not.toBe('applied');
    expect(m.finish()).toEqual([expect.objectContaining({ lastOutcome: 'not_applicable' })]);
    expect(m.exceptions()).toEqual([]);
    expect(m.portCalls).toEqual([]);
    expect(m.calls('findSpecimen')).toEqual([]);
    expect(m.saved()).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------ step 3 / AC-14.3
describe('T-22 AC-14.3 unmapped code (step 3)', () => {
  const unmapped = { mappingStatus: 'unmapped', analyteId: undefined, testId: undefined };
  it('mapping_status unmapped -> CatalogPort.mapInstrumentCode(inbound, instrument + code); still unmapped (catalog.instrument_code_unmapped) -> unmatched + exception unmapped_code', async () => {
    const m = make({ mapThrows: new LimsError('catalog.instrument_code_unmapped') });
    const r = await applyInstrumentResultEvent(m.ctx, envelope(unmapped));
    expect(r).toMatchObject({ outcome: 'unmatched' });
    expect(m.asked[0]).toMatchObject({ instrumentId: INSTR, direction: 'inbound', instrumentCode: 'HGB' });
    expect(m.exceptions()).toEqual([expect.objectContaining({ reason: 'unmapped_code', resultKey: KEY, sampleBarcode: BARCODE, instrumentId: INSTR, instrumentAnalyteCode: 'HGB' })]);
    expect(m.finish()[0]).toMatchObject({ lastOutcome: 'unmatched', exceptionId: EXC_ID });
    expect(m.calls('findSpecimen')).toEqual([]);   // step 3 ends the pipeline
    expect(m.saved()).toEqual([]);
  });
  it('a record without analyte_id is treated as unmapped even when mapping_status says mapped', async () => {
    const m = make({ mapThrows: new LimsError('catalog.instrument_code_unmapped') });
    const r = await ingestInstrumentResult(m.ctx, input({ analyteId: undefined, testId: undefined }));
    expect(r).toMatchObject({ outcome: 'unmatched' });
    expect(m.exceptions()[0]).toMatchObject({ reason: 'unmapped_code' });
  });
  it('the mapping was fixed in the meantime: mapInstrumentCode resolves -> the record continues with the mapped analyte and applies', async () => {
    const m = make();
    const r = await applyInstrumentResultEvent(m.ctx, envelope(unmapped));
    expect(r).toMatchObject({ outcome: 'applied', resultId: R_HGB });
    expect(m.exceptions()).toEqual([]);
  });
  it('any other catalog failure is not an unmatched outcome: it propagates (the job retries; fail closed) and the log is not finished', async () => {
    const m = make({ mapThrows: new Error('catalog down') });
    const err = await fail(applyInstrumentResultEvent(m.ctx, envelope(unmapped)));
    expect(err.message).toBe('catalog down');
    expect(m.exceptions()).toEqual([]);
    expect(m.finish()).toEqual([]);
  });
  it('the exception carries the raw record (value, unit, flags, times) for the technologist and the instrument centre', async () => {
    const m = make({ mapThrows: new LimsError('catalog.instrument_code_unmapped') });
    await applyInstrumentResultEvent(m.ctx, envelope({ ...unmapped, instrumentFlags: ['H'], isRerun: true }));
    expect(m.exceptions()[0]).toMatchObject({
      centreId: CENTRE, instrumentMessageId: MSG, recordKind: 'quantitative', valueRaw: VALUE_RAW, unitRaw: 'g/dL', instrumentFlags: ['H'], instrumentResultTime: RESULT_TIME, isRerun: true,
    });
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------ steps 4-9 / AC-14.4
describe('T-22 AC-14.4 / §4.5 steps 4-9: every unmatched / rejected_state row is logged with its exception and nothing is saved', () => {
  const cases: [string, Opt, Record<string, unknown>, string, string, string?][] = [
    ['step 4 unknown barcode', { specimen: null }, {}, 'unmatched', 'unknown_barcode'],
    ['step 5 specimen rejected', { specimen: { status: 'rejected' } }, {}, 'rejected_state', 'specimen_rejected'],
    ['step 5 specimen recollection_ordered', { specimen: { status: 'recollection_ordered' } }, {}, 'rejected_state', 'specimen_rejected'],
    ['step 5 specimen discarded', { specimen: { status: 'discarded' } }, {}, 'rejected_state', 'specimen_rejected'],
    ['step 5 specimen inactive', { specimen: { isActive: false } }, {}, 'rejected_state', 'specimen_rejected'],
    ['step 6 specimen ordered, auto-receive off', { specimen: { status: 'ordered' }, autoReceive: false }, {}, 'unmatched', 'specimen_not_received'],
    ['step 6 specimen ordered, auto-receive ON (S4 from ordered is forbidden)', { specimen: { status: 'ordered' }, autoReceive: true }, {}, 'unmatched', 'specimen_not_received'],
    ['step 6 specimen collected, auto-receive off', { specimen: { status: 'collected' }, autoReceive: false }, {}, 'unmatched', 'specimen_not_received'],
    ['step 6 specimen in_transit, auto-receive off', { specimen: { status: 'in_transit' }, autoReceive: false }, {}, 'unmatched', 'specimen_not_received'],
    ['step 7 analyte not ordered on the specimen', { rows: [hgbRow({ analyteId: WBC, analyte: { id: WBC, code: 'WBC', resultType: 'numeric', decimals: 1 } })] }, {}, 'unmatched', 'analyte_not_ordered'],
    ['step 7 only a cancelled result of the analyte', { rows: [] }, {}, 'unmatched', 'analyte_not_ordered'],
    ['step 8 target approved', { rows: [hgbRow({ status: 'approved' })] }, {}, 'rejected_state', 'result_locked', 'result_locked'],
    ['step 9 target verified', { rows: [hgbRow({ status: 'verified' })] }, {}, 'unmatched', 'result_already_verified'],
  ];
  for (const [name, opt, over, outcome, reason, reasonCode] of cases) {
    it(`${name} -> ${outcome} / ${reason}`, async () => {
      const m = make(opt);
      const r = await ingestInstrumentResult(m.ctx, input(over));
      expect(r.outcome).toBe(outcome);
      if (reasonCode) expect(r.reasonCode).toBe(reasonCode);
      expect(m.exceptions()).toEqual([expect.objectContaining({ reason, resultKey: KEY, sampleBarcode: BARCODE, instrumentId: INSTR, centreId: CENTRE })]);
      expect(m.finish()).toEqual([expect.objectContaining({ lastOutcome: outcome, exceptionId: EXC_ID })]);
      expect(m.saved()).toEqual([]);          // the value is never written
      expect(m.calls('insertAttachment')).toEqual([]);
      expect(m.calls('receiveSpecimen')).toEqual([]);
    });
  }

  it('approved target never throws lab.result_locked: the port RETURNS rejected_state with reasonCode result_locked (CR-C5-008)', async () => {
    const m = make({ rows: [hgbRow({ status: 'approved' })] });
    await expect(ingestInstrumentResult(m.ctx, input())).resolves.toMatchObject({ outcome: 'rejected_state', reasonCode: 'result_locked' });
  });

  it('the exception of an unknown barcode has no specimen; one of a found specimen carries specimen_id and the processing centre; one of an existing result carries result_id', async () => {
    const a = make({ specimen: null }); await ingestInstrumentResult(a.ctx, input());
    expect(a.exceptions()[0]!.specimenId).toBeUndefined();
    const b = make({ specimen: { status: 'rejected' } }); await ingestInstrumentResult(b.ctx, input());
    expect(b.exceptions()[0]).toMatchObject({ specimenId: SPEC, processingCentreId: PROC_CENTRE });
    const c = make({ rows: [hgbRow({ status: 'verified' })] }); await ingestInstrumentResult(c.ctx, input());
    expect(c.exceptions()[0]).toMatchObject({ specimenId: SPEC, resultId: R_HGB });
  });
  it('unknown barcode: ingest_log processing_centre_id stays unset (set only once a specimen is found, 08 R3)', async () => {
    const m = make({ specimen: null });
    await ingestInstrumentResult(m.ctx, input());
    expect(m.finish()[0]!.processingCentreId).toBeUndefined();
  });

  it('a specimen of another tenant is never visible: the lookup is the store\'s (tenant, barcode) pair and the barcode alone decides nothing (P-08)', async () => {
    const m = make({ specimen: null });
    await ingestInstrumentResult(m.ctx, input());
    expect(m.calls('findSpecimen')[0]).toMatchObject({ tenantId: TENANT, arg: BARCODE });
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------ step 6 auto-receive
describe('T-22 §4.5 step 6: ingest_auto_receive = true on a collected / in_transit specimen', () => {
  it.each(['collected', 'in_transit'])('%s -> S4 as system with processing_centre_id = the event centre_id, then the record applies', async (status) => {
    const m = make({ specimen: { status }, autoReceive: true });
    const r = await applyInstrumentResultEvent(m.ctx, envelope());
    expect(r).toMatchObject({ outcome: 'applied', resultId: R_HGB });
    expect(m.calls('receiveSpecimen').map((c) => c.arg)).toEqual([expect.objectContaining({ specimenId: SPEC, processingCentreId: CENTRE })]);
    const order = m.log.map((l) => l.fn);
    expect(order.indexOf('receiveSpecimen')).toBeLessThan(order.indexOf('saveInstrumentResult'));
  });
  it('the setting is read from lab_settings only when it matters (a received specimen needs no S4)', async () => {
    const m = make({ specimen: { status: 'received' }, autoReceive: true });
    await applyInstrumentResultEvent(m.ctx, envelope());
    expect(m.calls('receiveSpecimen')).toEqual([]);
  });
  it('after S4 the analyte may still be un-ordered: unmatched / analyte_not_ordered, and S4 stays done (it happened in the same transaction)', async () => {
    const m = make({ specimen: { status: 'collected' }, autoReceive: true, rows: [] });
    const r = await applyInstrumentResultEvent(m.ctx, envelope());
    expect(r.outcome).toBe('unmatched');
    expect(m.exceptions()[0]).toMatchObject({ reason: 'analyte_not_ordered' });
    expect(m.calls('receiveSpecimen')).toHaveLength(1);
  });
  // T-23 review CHANGES 1 (03-APP-FLOW S4 "ingest auto-receive" side effect; 02-TRD §8; AC-04.5): the auto-receive is an S4 receive, so it enqueues the reapply job in the same tx.
  it.each(['collected', 'in_transit'])('T-23 AC-04.5: auto-receive of a %s specimen enqueues exactly one lab.reapply_exceptions_for_specimen (job_key = specimen_id) on the request tx', async (status) => {
    const m = make({ specimen: { status }, autoReceive: true });
    const queries: { sql: string; params: unknown[] }[] = [];
    (m.tx as any).query = async (sql: string, params: unknown[]) => { queries.push({ sql, params }); return { rows: [], rowCount: 0 }; };
    await applyInstrumentResultEvent(m.ctx, envelope());
    const jobs = queries.filter((q) => /app\.enqueue_job/.test(q.sql));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.params[0]).toBe('lab.reapply_exceptions_for_specimen');
    expect(JSON.parse(jobs[0]!.params[1] as string)).toEqual({ tenant_id: TENANT, specimen_id: SPEC });
    expect(jobs[0]!.params[2]).toBe(SPEC);
  });
  it('T-23 AC-04.5: no S4 (already received, or auto-receive off) -> no reapply job from the ingest path', async () => {
    for (const o of [{ specimen: { status: 'received' }, autoReceive: true }, { specimen: { status: 'collected' }, autoReceive: false }]) {
      const m = make(o);
      const queries: string[] = [];
      (m.tx as any).query = async (sql: string) => { queries.push(sql); return { rows: [], rowCount: 0 }; };
      await applyInstrumentResultEvent(m.ctx, envelope());
      expect(queries.filter((q) => /app\.enqueue_job/.test(q))).toEqual([]);
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------ step 10
describe('T-22 §4.5 step 10: unit mismatch applies the value and opens an exception', () => {
  const mismatch = { valueRaw: '134', valueNumeric: '134', unitRaw: 'g/L', unitCode: 'g/L' };
  it('unit_code differs from the analyte unit, no conversion -> outcome applied, value stored as received, unit_mismatch = true, flag evaluation skipped (no range lookup, no evaluation)', async () => {
    const m = make();
    const r = await ingestInstrumentResult(m.ctx, input(mismatch));
    expect(r).toMatchObject({ outcome: 'applied', resultId: R_HGB });
    expect(m.saved()[0]).toMatchObject({ unitMismatch: true, unitCode: 'g/L', value: { numeric: '134' } });
    expect(m.saved()[0]!.evaluation).toBeUndefined();
    expect(m.portCalls).not.toContain('referenceRangeFor');
    expect(m.portCalls).not.toContain('criticalLimitsFor');
  });
  it('an open exception unit_mismatch is recorded for the result while the log says applied', async () => {
    const m = make();
    await ingestInstrumentResult(m.ctx, input(mismatch));
    expect(m.exceptions()).toEqual([expect.objectContaining({ reason: 'unit_mismatch', resultKey: KEY, resultId: R_HGB, specimenId: SPEC })]);
    expect(m.finish()[0]).toMatchObject({ lastOutcome: 'applied', resultId: R_HGB });
  });
  it('on the event path as well', async () => {
    const m = make();
    await applyInstrumentResultEvent(m.ctx, envelope(mismatch));
    expect(m.exceptions()[0]).toMatchObject({ reason: 'unit_mismatch' });
    expect(m.saved()[0]).toMatchObject({ unitMismatch: true });
  });
  it('a matching unit opens no exception', async () => {
    const m = make();
    await ingestInstrumentResult(m.ctx, input());
    expect(m.exceptions()).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------ step 11 / AC-14.7
describe('T-22 AC-14.7 QC hold', () => {
  it('an active QC hold for (instrument, analyte) -> applied with on_hold = true and outcome held (log held too)', async () => {
    const m = make({ hold: true });
    const r = await ingestInstrumentResult(m.ctx, input());
    expect(r).toMatchObject({ outcome: 'held', resultId: R_HGB });
    expect(m.saved()[0]).toMatchObject({ onHold: true });
    expect(m.finish()[0]).toMatchObject({ lastOutcome: 'held', resultId: R_HGB });
    expect(m.calls('isOnQcHold')[0]!.arg).toMatchObject({ instrumentId: INSTR, analyteId: HGB });
  });
  it('no hold -> applied with on_hold = false', async () => {
    const m = make({ hold: false });
    expect(await ingestInstrumentResult(m.ctx, input())).toMatchObject({ outcome: 'applied' });
    expect(m.saved()[0]).toMatchObject({ onHold: false });
  });
  it('a duplicate of a held record stays duplicate', async () => {
    const m = make({ claim: { inserted: false, lastOutcome: 'held', resultId: R_HGB } });
    expect(await ingestInstrumentResult(m.ctx, input())).toMatchObject({ outcome: 'duplicate' });
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------ AC-14.8 / step 11 hook
describe('T-22 AC-14.8 no auto-verification in Phase 1; step 11 hook (CR-C9-004, 08 A17.1)', () => {
  const allow = { decision: 'allow', ruleSetVersion: 7 };
  it('default config (LIMS_LAB_AUTOVERIFY_HOOK_ENABLED unset/false): QualityPort.canAutoVerify is never called, nothing is verified, the result stops at resulted', async () => {
    const m = make({ decision: allow });
    const r = await applyInstrumentResultEvent(m.ctx, envelope());
    expect(r.outcome).toBe('applied');
    expect(m.portCalls).not.toContain('canAutoVerify');
    expect(m.calls('verify')).toEqual([]);
  });
  it('hook enabled + allow -> verified in the same transaction by R4 mode auto (outcome stays applied)', async () => {
    const m = make({ hookEnabled: true, decision: allow });
    const r = await applyInstrumentResultEvent(m.ctx, envelope());
    expect(r.outcome).toBe('applied');
    expect(m.portCalls.filter((c) => c === 'canAutoVerify')).toHaveLength(1);
    expect(m.calls('verify').map((c) => c.arg)).toEqual([expect.objectContaining({ resultId: R_HGB, mode: 'auto', ruleSetVersion: 7 })]);
  });
  it('hook enabled + deny (also the C9 "feature_disabled" answer) -> stays resulted, no verify', async () => {
    const m = make({ hookEnabled: true, decision: { decision: 'deny', reasons: ['feature_disabled'] } });
    expect((await applyInstrumentResultEvent(m.ctx, envelope())).outcome).toBe('applied');
    expect(m.portCalls).toContain('canAutoVerify');
    expect(m.calls('verify')).toEqual([]);
  });
  it('hook enabled: canAutoVerify is asked for EVERY instrument save, independent of the tenant autoVerificationEnabled switch (false here, CR-C9-004)', async () => {
    const m = make({ hookEnabled: true });
    await ingestInstrumentResult(m.ctx, input());
    expect(m.portCalls).toContain('canAutoVerify');
  });
  it('a failing canAutoVerify never fails or undoes the ingest: the result stays applied / resulted', async () => {
    const m = make({ hookEnabled: true, canAutoVerifyThrows: new Error('quality down') });
    expect((await ingestInstrumentResult(m.ctx, input())).outcome).toBe('applied');
    expect(m.calls('verify')).toEqual([]);
  });
  it('a held result is never offered to canAutoVerify', async () => {
    const m = make({ hookEnabled: true, hold: true, decision: allow });
    expect((await ingestInstrumentResult(m.ctx, input())).outcome).toBe('held');
    expect(m.portCalls).not.toContain('canAutoVerify');
    expect(m.calls('verify')).toEqual([]);
  });
  it('a unit-mismatch result is never offered to canAutoVerify', async () => {
    const m = make({ hookEnabled: true, decision: allow });
    await ingestInstrumentResult(m.ctx, input({ valueRaw: '134', valueNumeric: '134', unitRaw: 'g/L', unitCode: 'g/L' }));
    expect(m.portCalls).not.toContain('canAutoVerify');
    expect(m.calls('verify')).toEqual([]);
  });
  it('range_unavailable_age_unknown (unknown patient age, no age-free band) is never offered to canAutoVerify (08 A17.1)', async () => {
    const m = make({ hookEnabled: true, decision: allow, rows: [hgbRow({ patientAgeDays: null })], rangeThrows: new LimsError('catalog.no_reference_range') });
    expect((await ingestInstrumentResult(m.ctx, input())).outcome).toBe('applied');
    expect(m.saved()[0]!.evaluation.rangeUnavailableAgeUnknown).toBe(true);
    expect(m.portCalls).not.toContain('canAutoVerify');
    expect(m.calls('verify')).toEqual([]);
  });
  it('unmatched / rejected records are never offered to canAutoVerify', async () => {
    const m = make({ hookEnabled: true, specimen: { status: 'rejected' }, decision: allow });
    await ingestInstrumentResult(m.ctx, input());
    expect(m.portCalls).not.toContain('canAutoVerify');
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------ attachments
describe('T-22 attachment tenant check (REQ-SEC-121, 07-SECURITY S-07, abuse case 7)', () => {
  const att = (path: string) => ({ recordKind: 'attachment', instrumentAnalyteCode: 'HGB', valueRaw: undefined, valueNumeric: undefined, unitRaw: undefined, unitCode: undefined,
    attachment: { bucket: 'lims-instrument-files', objectPath: path, sha256: 'a'.repeat(64), mimeType: 'application/pdf' } });
  it('object path under ctx.tenantId -> attached to the matched result (bucket, path, sha256, mime), outcome applied', async () => {
    const m = make();
    const r = await ingestInstrumentResult(m.ctx, input(att(`${TENANT}/instruments/${MSG}/report.pdf`)));
    expect(r).toMatchObject({ outcome: 'applied', resultId: R_HGB });
    expect(m.calls('insertAttachment').map((c) => c.arg)).toEqual([{ resultId: R_HGB, bucket: 'lims-instrument-files', objectPath: `${TENANT}/instruments/${MSG}/report.pdf`, sha256: 'a'.repeat(64), mimeType: 'application/pdf' }]);
    expect(m.exceptions()).toEqual([]);
  });
  it('object path under ANOTHER tenant -> unmatched with reasonCode attachment_tenant_mismatch, exception attachment_tenant_mismatch, NOTHING attached or saved', async () => {
    const m = make();
    const r = await ingestInstrumentResult(m.ctx, input(att(`${OTHER}/instruments/${MSG}/report.pdf`)));
    expect(r).toMatchObject({ outcome: 'unmatched', reasonCode: 'attachment_tenant_mismatch' });
    expect(m.calls('insertAttachment')).toEqual([]);
    expect(m.saved()).toEqual([]);
    expect(m.exceptions()).toEqual([expect.objectContaining({ reason: 'attachment_tenant_mismatch', resultKey: KEY })]);
    expect(m.finish()[0]).toMatchObject({ lastOutcome: 'unmatched' });
  });
  it.each(['report.pdf', `/${TENANT}/report.pdf`, `${TENANT}-x/report.pdf`, `${TENANT}/../${OTHER}/report.pdf`, ''])('malformed or traversal path %j -> refused the same way', async (path) => {
    const m = make();
    const r = await ingestInstrumentResult(m.ctx, input(att(path)));
    expect(r).toMatchObject({ outcome: 'unmatched', reasonCode: 'attachment_tenant_mismatch' });
    expect(m.calls('insertAttachment')).toEqual([]);
  });
  it('the tenant is ctx.tenantId, never a value of the payload (REQ-SEC-024)', async () => {
    const m = make();
    const r = await ingestInstrumentResult(m.ctx, { ...input(att(`${OTHER}/x.pdf`)), tenantId: OTHER, tenant_id: OTHER });
    expect(r).toMatchObject({ outcome: 'unmatched', reasonCode: 'attachment_tenant_mismatch' });
    expect(m.calls('insertAttachment')).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------ security / failure
describe('T-22 tenant guard, untrusted input, fail-closed, no PHI in logs (REQ-SEC-024, REQ-SEC-098, REQ-SEC-121, P-08, S-08)', () => {
  it('event of another tenant than the job -> common.internal before any store call, port call or event', async () => {
    const m = make();
    const err = await fail(applyInstrumentResultEvent(m.ctx, envelope({}, OTHER)));
    expect(err).toBeInstanceOf(LimsError);
    expect(err.code).toBe('common.internal');
    expect(m.log).toEqual([]);
    expect(m.portCalls).toEqual([]);
    expect(m.events).toEqual([]);
  });
  it('a barcode that is not a plain label barcode (quote/semicolon, 41 chars, empty, whitespace) never applies a result', async () => {
    for (const sampleBarcode of ["X'; DROP TABLE lab.results;--", 'A'.repeat(41), '', ' SN1 ', 'SN1\n']) {
      const m = make();
      const r = await ingestInstrumentResult(m.ctx, input({ sampleBarcode })).then((x) => x, (e) => e);
      if (r instanceof Error) expect(r).toBeInstanceOf(LimsError); else expect(r.outcome).not.toBe('applied');
      expect(m.saved(), JSON.stringify(sampleBarcode)).toEqual([]);
    }
  });
  it('a value_raw above the 200 character cap never applies a result', async () => {
    const m = make();
    const r = await ingestInstrumentResult(m.ctx, input({ valueRaw: '9'.repeat(201), valueNumeric: '9' })).then((x) => x, (e) => e);
    if (r instanceof Error) expect(r).toBeInstanceOf(LimsError); else expect(r.outcome).not.toBe('applied');
    expect(m.saved()).toEqual([]);
  });
  it('a non-numeric value for a numeric analyte never writes a value (no NaN / text into a numeric result)', async () => {
    const m = make();
    const r = await ingestInstrumentResult(m.ctx, input({ valueRaw: 'abc', valueNumeric: 'abc' })).then((x) => x, (e) => e);
    if (r instanceof Error) expect(r).toBeInstanceOf(LimsError); else expect(r.outcome).not.toBe('applied');
    expect(m.saved()).toEqual([]);
  });
  it('a failing save rejects the call (caller rolls back): the log is not finished as applied, no auto-verify, no silent ack', async () => {
    const m = make({ saveThrows: new Error('db down'), hookEnabled: true, decision: { decision: 'allow' } });
    const err = await fail(applyInstrumentResultEvent(m.ctx, envelope()));
    expect(err.message).toBe('db down');
    expect(m.finish().filter((f) => f.lastOutcome === 'applied')).toEqual([]);
    expect(m.calls('verify')).toEqual([]);
  });
  it('a lost optimistic race on the result (common.version_conflict from the store) propagates so the job retries; it is not turned into an outcome', async () => {
    const m = make({ saveThrows: new LimsError('common.version_conflict') });
    const err = await fail(applyInstrumentResultEvent(m.ctx, envelope()));
    expect(err.code).toBe('common.version_conflict');
  });
  it('logs carry no barcode and no raw value (REQ-SEC-098; the result key contains the barcode)', async () => {
    for (const opt of [{}, { specimen: null }, { rows: [hgbRow({ status: 'approved' })] }]) {
      const m = make(opt as Opt);
      await ingestInstrumentResult(m.ctx, input());
      const text = JSON.stringify(m.logged);
      expect(text).not.toContain(BARCODE);
      expect(text).not.toContain(VALUE_RAW);
    }
  });
  it('the system actor of the event path may be a plain system actor without membership (no role is asked for an event)', async () => {
    const m = make({ actor: { type: 'system', id: SYS } });
    const r = await applyInstrumentResultEvent(m.ctx, envelope());
    expect(r.outcome).toBe('applied');
  });
});
