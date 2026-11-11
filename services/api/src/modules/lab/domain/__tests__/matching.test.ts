// C5 T-22 — pure decision table of the instrument apply pipeline (02-TRD §4.5 steps 2-10; PRD AC-14.1..14.4, AC-14.8; 07-SECURITY S-07, REQ-SEC-121; 08 A13 D-10, CR-C5-008).
// SEAM (spec fixes behaviour, not names) — ../matching.ts must export PURE functions (no I/O, no clock):
//   resultKey({ instrumentId, sampleBarcode, instrumentAnalyteCode, instrumentResultTime? }): string            04 N10: `instrument_id:sample_barcode:instrument_analyte_code:(time|'none')`
//   classifyRecord(recordKind): 'apply' | 'not_applicable'                                                      step 2
//   decideMatch({ specimen?, autoReceive, analyteId, testId?, results }): MatchDecision                         steps 4-9
//        specimen = { status, isActive } (absent = barcode not found in the tenant)
//        results  = the non-cancelled results ON THAT SPECIMEN: { resultId, analyteId, testId, status }[]  (the store never returns cancelled ones; a stray 'cancelled' row must still be ignored)
//        MatchDecision = { outcome: 'apply', resultId, receive: boolean } | { outcome: 'unmatched' | 'rejected_state', exception: IngestReason, reasonCode?: 'result_locked', receive?: boolean }
//        `receive: true` = the pipeline must perform S4 as system BEFORE continuing (step 6, collected/in_transit + ingest_auto_receive).
//   decideUnit({ unitRaw?, unitCode?, analyteUnitCode?, unitConversion? }): { valueFactor?: string; storedUnitCode?: string; unitMismatch: boolean }   step 10
//   attachmentTenantOk(objectPath, tenantId): boolean                                                           first path segment must equal tenantId (REQ-SEC-121)
import { describe, expect, it } from 'vitest';
import { attachmentTenantOk, classifyRecord, decideMatch, decideUnit, resultKey } from '../matching.js';

const TENANT = '01a1a98a-ac40-7000-8000-00000000a001', OTHER = '01a1a98a-ac40-7000-8000-00000000b001';
const INSTR = '01a1a98a-ac40-7000-8000-0000000d00f1';
const A1 = '01a1a98a-ac40-7000-8000-0000000a0001', A2 = '01a1a98a-ac40-7000-8000-0000000a0002';
const T1 = '01a1a98a-ac40-7000-8000-0000000f0001', T2 = '01a1a98a-ac40-7000-8000-0000000f0002';
const R1 = '01a1a98a-ac40-7000-8000-0000000b0001', R2 = '01a1a98a-ac40-7000-8000-0000000b0002';

const res = (resultId: string, analyteId: string, testId: string, status = 'pending') => ({ resultId, analyteId, testId, status });
const received = { status: 'received', isActive: true };
const base = (over: Record<string, unknown> = {}) => ({ specimen: received, autoReceive: false, analyteId: A1, testId: T1, results: [res(R1, A1, T1)], ...over }) as never;

describe('T-22 result-level key (04 N10; AC-14.1, AC-14.2)', () => {
  it('= instrument_id:sample_barcode:instrument_analyte_code:instrument_result_time', () => {
    expect(resultKey({ instrumentId: INSTR, sampleBarcode: 'A1B2', instrumentAnalyteCode: 'HGB', instrumentResultTime: '2026-06-15T04:00:00.000Z' }))
      .toBe(`${INSTR}:A1B2:HGB:2026-06-15T04:00:00.000Z`);
  });
  it("absent instrument_result_time -> the literal 'none'", () => {
    expect(resultKey({ instrumentId: INSTR, sampleBarcode: 'A1B2', instrumentAnalyteCode: 'HGB' })).toBe(`${INSTR}:A1B2:HGB:none`);
  });
  it('a rerun (other result time) and another analyte code are other keys; the same input is the same key', () => {
    const k = (over: Record<string, unknown> = {}) => resultKey({ instrumentId: INSTR, sampleBarcode: 'A1B2', instrumentAnalyteCode: 'HGB', instrumentResultTime: '2026-06-15T04:00:00.000Z', ...over } as never);
    expect(k()).toBe(k());
    expect(k({ instrumentResultTime: '2026-06-15T04:05:00.000Z' })).not.toBe(k());
    expect(k({ instrumentAnalyteCode: 'WBC' })).not.toBe(k());
    expect(k({ sampleBarcode: 'A1B3' })).not.toBe(k());
    expect(k({ instrumentId: '01a1a98a-ac40-7000-8000-0000000d00f2' })).not.toBe(k());
  });
});

describe('T-22 §4.5 step 2: record_kind', () => {
  it.each(['organism_id', 'ast'])('%s -> not_applicable (C10 consumes it)', (k) => expect(classifyRecord(k as never)).toBe('not_applicable'));
  it.each(['quantitative', 'qualitative', 'ordinal', 'text', 'attachment'])('%s -> apply', (k) => expect(classifyRecord(k as never)).toBe('apply'));
});

describe('T-22 §4.5 steps 4-9 decision table (AC-14.1, AC-14.4)', () => {
  it('step 4: barcode not found in the tenant -> unmatched / unknown_barcode', () => {
    expect(decideMatch(base({ specimen: undefined }))).toMatchObject({ outcome: 'unmatched', exception: 'unknown_barcode' });
  });

  it.each(['rejected', 'recollection_ordered', 'discarded'])('step 5: specimen %s -> rejected_state / specimen_rejected', (status) => {
    expect(decideMatch(base({ specimen: { status, isActive: true } }))).toMatchObject({ outcome: 'rejected_state', exception: 'specimen_rejected' });
  });
  it('step 5: an inactive specimen (is_active = false) -> rejected_state / specimen_rejected, whatever its status', () => {
    expect(decideMatch(base({ specimen: { status: 'received', isActive: false } }))).toMatchObject({ outcome: 'rejected_state', exception: 'specimen_rejected' });
  });
  it('step 5 comes before step 7: a rejected specimen with an un-ordered analyte reports specimen_rejected', () => {
    expect(decideMatch(base({ specimen: { status: 'rejected', isActive: true }, results: [] }))).toMatchObject({ exception: 'specimen_rejected' });
  });

  it.each([true, false])('step 6: specimen ordered -> ALWAYS unmatched / specimen_not_received, no S4 (ingest_auto_receive = %s)', (autoReceive) => {
    const d = decideMatch(base({ specimen: { status: 'ordered', isActive: true }, autoReceive })) as any;
    expect(d).toMatchObject({ outcome: 'unmatched', exception: 'specimen_not_received' });
    expect(d.receive).not.toBe(true);
  });
  it.each(['collected', 'in_transit'])('step 6: specimen %s + ingest_auto_receive = false -> unmatched / specimen_not_received, no S4', (status) => {
    const d = decideMatch(base({ specimen: { status, isActive: true }, autoReceive: false })) as any;
    expect(d).toMatchObject({ outcome: 'unmatched', exception: 'specimen_not_received' });
    expect(d.receive).not.toBe(true);
  });
  it.each(['collected', 'in_transit'])('step 6: specimen %s + ingest_auto_receive = true -> S4 as system, then the pipeline continues and applies', (status) => {
    expect(decideMatch(base({ specimen: { status, isActive: true }, autoReceive: true }))).toEqual({ outcome: 'apply', resultId: R1, receive: true });
  });
  it('step 6 + 7: after the auto-receive the analyte can still be un-ordered -> unmatched / analyte_not_ordered, receive stays true (S4 was performed)', () => {
    expect(decideMatch(base({ specimen: { status: 'collected', isActive: true }, autoReceive: true, results: [] }))).toMatchObject({ outcome: 'unmatched', exception: 'analyte_not_ordered', receive: true });
  });

  it.each(['received', 'aliquoted', 'in_process', 'resulted', 'stored'])('a %s specimen needs no S4 (receive is not requested)', (status) => {
    const d = decideMatch(base({ specimen: { status, isActive: true }, autoReceive: true })) as any;
    expect(d).toMatchObject({ outcome: 'apply', resultId: R1 });
    expect(d.receive).not.toBe(true);
  });

  it('step 7: no result with the mapped analyte on the specimen -> unmatched / analyte_not_ordered', () => {
    expect(decideMatch(base({ analyteId: A2 }))).toMatchObject({ outcome: 'unmatched', exception: 'analyte_not_ordered' });
  });
  it('step 7: a cancelled result of the analyte does not count', () => {
    expect(decideMatch(base({ results: [res(R1, A1, T1, 'cancelled')] }))).toMatchObject({ outcome: 'unmatched', exception: 'analyte_not_ordered' });
  });
  it('step 7: a cancelled result is skipped in favour of a live one with the same analyte', () => {
    expect(decideMatch(base({ results: [res(R1, A1, T1, 'cancelled'), res(R2, A1, T2)] }))).toMatchObject({ outcome: 'apply', resultId: R2 });
  });
  it('step 7: prefers the mapped test_id when the analyte is ordered under two tests', () => {
    const results = [res(R1, A1, T1), res(R2, A1, T2)];
    expect(decideMatch(base({ results, testId: T2 }))).toMatchObject({ outcome: 'apply', resultId: R2 });
    expect(decideMatch(base({ results, testId: T1 }))).toMatchObject({ outcome: 'apply', resultId: R1 });
  });
  it('step 7: when the mapped test_id is not ordered but the analyte is (other test) -> falls back to the analyte', () => {
    expect(decideMatch(base({ results: [res(R2, A1, T2)], testId: T1 }))).toMatchObject({ outcome: 'apply', resultId: R2 });
  });
  it('step 7: without a mapped test_id any non-cancelled result of the analyte is a target (deterministic: the same inputs give the same target)', () => {
    const results = [res(R1, A1, T1), res(R2, A1, T2)];
    const a = decideMatch(base({ results, testId: undefined })) as any, b = decideMatch(base({ results, testId: undefined })) as any;
    expect(a.outcome).toBe('apply');
    expect(a.resultId).toBe(b.resultId);
  });

  it('step 8: approved target -> rejected_state with reasonCode result_locked, exception result_locked (never an error)', () => {
    expect(decideMatch(base({ results: [res(R1, A1, T1, 'approved')] }))).toMatchObject({ outcome: 'rejected_state', exception: 'result_locked', reasonCode: 'result_locked' });
  });
  it('step 9: verified target -> unmatched / result_already_verified', () => {
    expect(decideMatch(base({ results: [res(R1, A1, T1, 'verified')] }))).toMatchObject({ outcome: 'unmatched', exception: 'result_already_verified' });
  });
  it.each(['pending', 'resulted'])('a %s target is applied (R2 / R3 re-run)', (status) => {
    expect(decideMatch(base({ results: [res(R1, A1, T1, status)] }))).toEqual({ outcome: 'apply', resultId: R1, receive: false });
  });
  it('an approved result of the analyte under another test does not block a pending one under the mapped test', () => {
    expect(decideMatch(base({ results: [res(R1, A1, T1, 'approved'), res(R2, A1, T2)], testId: T2 }))).toMatchObject({ outcome: 'apply', resultId: R2 });
  });
});

describe('T-22 §4.5 step 10 unit handling (08 A13 D-10; both paths)', () => {
  const conv = { fromUnitRaw: 'g/L', toUnitCode: 'g/dL', factor: '0.1' };
  it('unit_raw matches fromUnitRaw -> factor to apply, stored in the target unit, no mismatch', () => {
    expect(decideUnit({ unitRaw: 'g/L', analyteUnitCode: 'g/dL', unitConversion: conv })).toMatchObject({ valueFactor: '0.1', storedUnitCode: 'g/dL', unitMismatch: false });
  });
  it('unit_code equal to the analyte unit -> no factor, no mismatch', () => {
    const d = decideUnit({ unitRaw: 'g/dL', unitCode: 'g/dL', analyteUnitCode: 'g/dL' });
    expect(d.unitMismatch).toBe(false);
    expect(d.valueFactor).toBeUndefined();
  });
  it('unit_code differs from the analyte unit and no conversion matches -> unit_mismatch, value stored as received (unit kept)', () => {
    const d = decideUnit({ unitRaw: 'mmol/L', unitCode: 'mmol/L', analyteUnitCode: 'g/dL' });
    expect(d).toMatchObject({ unitMismatch: true, storedUnitCode: 'mmol/L' });
    expect(d.valueFactor).toBeUndefined();
  });
  it('a conversion whose fromUnitRaw does not match unit_raw is not applied (mismatch when the unit differs)', () => {
    const d = decideUnit({ unitRaw: 'mg/dL', unitCode: 'mg/dL', analyteUnitCode: 'g/dL', unitConversion: conv });
    expect(d.unitMismatch).toBe(true);
    expect(d.valueFactor).toBeUndefined();
  });
  it('the unit-less instrument (no unit_raw, no unit_code) is not a mismatch', () => {
    expect(decideUnit({ analyteUnitCode: 'g/dL' }).unitMismatch).toBe(false);
  });
});

describe('T-22 attachment tenant check (REQ-SEC-121, 07-SECURITY S-07, abuse case 7)', () => {
  it('first path segment = tenant id -> ok', () => expect(attachmentTenantOk(`${TENANT}/instruments/x/report.pdf`, TENANT)).toBe(true));
  it('another tenant prefix -> refused', () => expect(attachmentTenantOk(`${OTHER}/instruments/x/report.pdf`, TENANT)).toBe(false));
  it.each([
    ['no prefix', 'instruments/x/report.pdf'],
    ['leading slash', `/${TENANT}/x.pdf`],
    ['tenant id only as a later segment', `x/${TENANT}/y.pdf`],
    ['prefix match is not enough', `${TENANT}-evil/x.pdf`],
    ['dot-dot back to another tenant', `${TENANT}/../${OTHER}/x.pdf`],
    ['upper-cased id is not the tenant id string', `${TENANT.toUpperCase()}/x.pdf`],
    ['empty', ''],
  ])('%s -> refused', (_n, path) => expect(attachmentTenantOk(path, TENANT)).toBe(false));
  it('no tenant -> refused', () => expect(attachmentTenantOk(`${TENANT}/x.pdf`, '')).toBe(false));
});
