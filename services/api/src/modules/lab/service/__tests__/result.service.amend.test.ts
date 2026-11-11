// C5 T-17 — amendResult (R7) + listResultVersions in result.service (02-TRD §3.3 R7, §4.3 ("R7 outputs only in the new result_versions row"), §4.4 cascade, §5.4 #32-#33, §5.5; 03-IC §3.11, §10.2; PRD AC-09.5, AC-17.1–AC-17.4).
// ACs: AC-17.1 (pathologist amends: v2 approved at creation, previous superseded (store), lab.result.amended.v1 previous 1 / new 2, readiness re-evaluated with contains_amendment),
//      AC-17.2 (no lab.result.amend -> lab.amend_requires_pathologist), AC-17.3 (no reason -> 422 lab.amendment_reason_required), AC-17.4 (read back through the store/view: versions list), AC-09.5 (cascade to formulas, same tx, same reason, event for both).
// Security (07-SECURITY): S-04 (technologist amend), S-01 (aal1 -> auth.mfa_required passthrough), S-19 (no value / reason text in events or errors), P-01/P-02, REQ-SEC-024 (tenant from ctx), finding C5 #10 (evaluation only in the new result_versions row).
// SEAM: see ./approve.fixtures.ts header. ../result.service.ts must export
//   amendResult(ctx, { resultId, version, value?: { numeric?: string; text?: string; ordinalCode?: string }, commentCodes?, commentText?, reasonCode, reasonText? }) -> ResultRow   (store.amendResult's row)
//   listResultVersions(ctx, { resultId }) -> rows (store order, version_no ascending); role lab.result.read at the result centre (P-02 -> common.not_found); unknown id -> common.not_found.
// Order (ASSUMED): not found -> role lab.result.amend at the centre (auth.forbidden -> lab.amend_requires_pathologist, auth.mfa_required untouched) -> version -> status approved (else lab.result_invalid_transition)
//   -> reason (missing/blank -> lab.amendment_reason_required; inactive in lab.v_amendment_reasons -> common.validation_failed /amendment_reason_code) -> value (lab.result_value_invalid) -> evaluate -> store.amendResult -> cascade.
// ASSUMED (spec silent): amending to the value the current version already has -> lab.result_value_invalid ("value differs from current version", 02-TRD §3.3 R7); an amendment with neither value nor comment -> lab.result_value_invalid.
import { describe, expect, it } from 'vitest';
import { amendResult, listResultVersions } from '../result.service.js';
import { amendRow, APPROVER, CENTRE, fail, forbidden, id, ITEM, make, mfaRequired, NOW, ORDER, TENANT } from './approve.fixtures.js';

const am = (resultId: string, over: Record<string, unknown> = {}) => ({ resultId, version: 9, value: { numeric: '13.8' }, reasonCode: 'TRANSCRIPTION_ERROR', reasonText: 'Synthetic reason', ...over });
const FRIEDEWALD = 'TC - HDL - TG / 5';
const lipidTarget = (over: Record<string, unknown> = {}) => ({
  resultId: id(0x70), analyteCode: 'LDL', expression: FRIEDEWALD, status: 'approved', versionNo: 1, rowVersion: 3, decimals: 0, testRevision: 3, catalogRevision: 17, sex: 'female', ageDays: 10950, ageYears: 30,
  orderId: ORDER, testId: 't-lipid', analyteId: 'a-LDL', ...over,
});
const lipidInputs = (tg = '200') => [
  { analyteCode: 'TC', resultId: id(0x71), versionNo: 1, status: 'approved', resultType: 'numeric', value: '200', unitCode: 'mg/dL' },
  { analyteCode: 'HDL', resultId: id(0x72), versionNo: 1, status: 'approved', resultType: 'numeric', value: '50', unitCode: 'mg/dL' },
  { analyteCode: 'TG', resultId: id(1), versionNo: 2, status: 'approved', resultType: 'numeric', value: tg, unitCode: 'mg/dL' },
];

describe('T-17 AC-17.1 amend (R7)', () => {
  it('approved result + value + reason -> store.amendResult with version n+1, previous n, the value, the caller membership, the server clock and the reason (code + text)', async () => {
    const m = make({ amendRows: [amendRow(id(1))] });
    const r = await amendResult(m.ctx, am(id(1)));
    expect(r).toMatchObject({ id: id(1), status: 'approved', current_version_no: 2 });
    expect(m.stored('amendResult')).toHaveLength(1);
    expect(m.stored('amendResult')[0]).toMatchObject({
      resultId: id(1), expectedRowVersion: 9, previousVersionNo: 1, newVersionNo: 2, value: { numeric: '13.8' }, reasonCode: 'TRANSCRIPTION_ERROR', reasonText: 'Synthetic reason', membershipId: APPROVER, occurredAt: NOW.toISOString(),
    });
    for (const l of m.log) expect(l.tenantId, l.fn).toBe(TENANT);
  });
  it('version numbering follows the current version: an already amended result (current 3) gets 4', async () => {
    const m = make({ amendRows: [amendRow(id(1), { currentVersionNo: 3 })] });
    await amendResult(m.ctx, am(id(1)));
    expect(m.stored('amendResult')[0]).toMatchObject({ previousVersionNo: 3, newVersionNo: 4 });
  });
  it('finding C5 #10: the evaluation (flag / range snapshot / critical / delta) is computed for the NEW value and handed to the new-version insert only; the locked results row is never written', async () => {
    const m = make({ amendRows: [amendRow(id(1))] });
    await amendResult(m.ctx, am(id(1), { value: { numeric: '10.5' } }));        // below the 12.0 – 16.0 range, above critical 7.0
    const call = m.stored('amendResult')[0];
    expect(call.evaluation).toMatchObject({ flag: 'L', critical: { isCritical: false }, rangeSnapshot: { low: '12.0', high: '16.0', version: 3 }, delta: { status: expect.any(String) } });
    expect(m.of('saveEntry')).toHaveLength(0);       // saveEntry (R2/R3 UPDATE lab.results) would throw in the fake
    expect(m.of('applyComputed')).toHaveLength(0);
  });
  it('the amended value is evaluated against the catalog like any manual value: a non-numeric / over-precise value -> lab.result_value_invalid (422), nothing stored', async () => {
    for (const numeric of ['abc', '13.85']) {
      const m = make({ amendRows: [amendRow(id(1))] });
      const e = await fail(amendResult(m.ctx, am(id(1), { value: { numeric } })));
      expect([e.code, e.statusCode], numeric).toEqual(['lab.result_value_invalid', 422]);
      expect(m.of('amendResult'), numeric).toHaveLength(0); expect(m.emitted).toHaveLength(0);
    }
  });
  it('lab.result.amended.v1: previous 1 -> new 2, key <id>:amended:2, payload per 03-IC §3.11, no value and no reason text (P3)', async () => {
    const m = make({ amendRows: [amendRow(id(1))] });
    await amendResult(m.ctx, am(id(1)));
    const [e] = m.amendedEvents();
    expect(m.amendedEvents()).toHaveLength(1);
    expect(e!.input.aggregate).toMatchObject({ type: 'result', id: id(1) });
    expect(e!.input.idempotencyKey).toBe(`${id(1)}:amended:2`);
    expect(e!.input.payload).toEqual({
      result_id: id(1), previous_version_no: 1, new_version_no: 2, order_id: ORDER, order_item_id: ITEM, test_id: 't-cbc', analyte_id: 'a-HB', amendment_reason_code: 'TRANSCRIPTION_ERROR',
      amended_at: NOW.toISOString(), amended_by_membership_id: APPROVER,
    });
    expect(JSON.stringify(e!.input.payload)).not.toMatch(/13\.8|Synthetic reason/);
  });
  it('AC-17.1: readiness is re-evaluated after the amendment (new ready_for_report with the amended set is the order.service test)', async () => {
    const m = make({ amendRows: [amendRow(id(1))] });
    await amendResult(m.ctx, am(id(1)));
    expect(m.stored('lockReadiness')).toEqual([ORDER]);
    expect(m.log.findIndex((l) => l.fn === 'lockReadiness')).toBeGreaterThan(m.log.findIndex((l) => l.fn === 'amendResult'));
  });
  it('an amendment keeps the specimen as it is: no specimen roll-up (a reported specimen never rolls down)', async () => {
    const m = make({ amendRows: [amendRow(id(1))] });
    await amendResult(m.ctx, am(id(1)));
    expect(m.of('rollupSpecimen')).toHaveLength(0);
  });
  it('a critical amended value creates a NEW critical log row for the new version and lab.critical_value.detected.v1 (02-TRD §5.5)', async () => {
    const m = make({ amendRows: [amendRow(id(1))] });
    await amendResult(m.ctx, am(id(1), { value: { numeric: '6.5' } }));         // below critical low 7.0
    expect(m.stored('insertCriticalLog')).toHaveLength(1);
    expect(m.stored('insertCriticalLog')[0]).toMatchObject({ resultId: id(1), resultVersionNo: 2, direction: 'low' });
    const ev = m.events('lab.critical_value.detected.v1');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.input.payload).toMatchObject({ result_id: id(1), result_version_no: 2 });
    expect(JSON.stringify(ev[0]!.input.payload)).not.toContain('6.5');
  });
});

describe('T-17 AC-17.2 / AC-17.3 / guards', () => {
  it('AC-17.2 / S-04: a caller without lab.result.amend -> lab.amend_requires_pathologist (403) or auth.forbidden at this layer, never not_found; nothing stored', async () => {
    const m = make({ amendRows: [amendRow(id(1))], assertRole: forbidden });
    const e = await fail(amendResult(m.ctx, am(id(1))));
    expect(['lab.amend_requires_pathologist', 'auth.forbidden']).toContain(e.code);
    expect(e.statusCode).toBe(403);
    expect(m.of('amendResult')).toHaveLength(0); expect(m.emitted).toHaveLength(0);
    expect(m.asked).toEqual([{ permission: 'lab.result.amend', centreId: CENTRE }]);
  });
  it('S-01: aal1 -> auth.mfa_required passes through unchanged; nothing stored', async () => {
    const m = make({ amendRows: [amendRow(id(1))], assertRole: mfaRequired });
    expect((await fail(amendResult(m.ctx, am(id(1))))).code).toBe('auth.mfa_required');
    expect(m.of('amendResult')).toHaveLength(0);
  });
  it('P-01: unknown / other tenant / invisible id -> common.not_found, the role is never asked', async () => {
    const m = make({ amendRows: [] });
    expect((await fail(amendResult(m.ctx, am(id(9))))).code).toBe('common.not_found');
    expect(m.asked).toHaveLength(0);
  });
  it('AC-17.3: no reason (absent, empty, blank) -> 422 lab.amendment_reason_required; nothing stored', async () => {
    for (const reasonCode of [undefined, '', '   ']) {
      const m = make({ amendRows: [amendRow(id(1))] });
      const e = await fail(amendResult(m.ctx, am(id(1), { reasonCode })));
      expect([e.code, e.statusCode], String(reasonCode)).toEqual(['lab.amendment_reason_required', 422]);
      expect(m.of('amendResult')).toHaveLength(0); expect(m.emitted).toHaveLength(0);
    }
  });
  it('a reason code that is not active in lab.amendment_reasons -> common.validation_failed at /amendment_reason_code', async () => {
    const m = make({ amendRows: [amendRow(id(1))], amendReasonOk: false });
    const e = await fail(amendResult(m.ctx, am(id(1))));
    expect(e.code).toBe('common.validation_failed');
    expect(JSON.stringify(e.fieldErrors ?? e.detail ?? [])).toContain('/amendment_reason_code');
    expect(m.of('amendResult')).toHaveLength(0);
  });
  it.each(['pending', 'resulted', 'verified', 'cancelled'])('status %s (not approved) -> 409 lab.result_invalid_transition (a value change there is R3, not an amendment)', async (status) => {
    const m = make({ amendRows: [amendRow(id(1), { status })] });
    expect((await fail(amendResult(m.ctx, am(id(1))))).code).toBe('lab.result_invalid_transition');
    expect(m.of('amendResult')).toHaveLength(0);
  });
  it('a stale If-Match version -> common.version_conflict; nothing stored', async () => {
    const m = make({ amendRows: [amendRow(id(1))] });
    expect((await fail(amendResult(m.ctx, am(id(1), { version: 8 })))).code).toBe('common.version_conflict');
    expect(m.of('amendResult')).toHaveLength(0);
  });
  it('no value and no comment, or the value the current version already has -> lab.result_value_invalid', async () => {
    const a = make({ amendRows: [amendRow(id(1))] });
    expect((await fail(amendResult(a.ctx, am(id(1), { value: undefined })))).code).toBe('lab.result_value_invalid');
    const b = make({ amendRows: [amendRow(id(1))] });
    expect((await fail(amendResult(b.ctx, am(id(1), { value: { numeric: '13.4' } })))).code).toBe('lab.result_value_invalid');
    expect(b.of('amendResult')).toHaveLength(0);
  });
  it('AC-09.7: a calculated analyte (has a formula) cannot be amended by hand -> lab.result_value_invalid', async () => {
    const m = make({ amendRows: [amendRow(id(1), { analyte: { id: 'a-LDL', code: 'LDL', resultType: 'numeric', decimals: 0, formula: { expression: FRIEDEWALD } } })] });
    expect((await fail(amendResult(m.ctx, am(id(1))))).code).toBe('lab.result_value_invalid');
    expect(m.of('amendResult')).toHaveLength(0);
  });
  it('S-19: no error carries the amended value or the reason text', async () => {
    const m = make({ amendRows: [amendRow(id(1))], amendReasonOk: false });
    const e = await fail(amendResult(m.ctx, am(id(1), { value: { numeric: '13.8' }, reasonText: 'Synthetic secret reason' })));
    expect(JSON.stringify({ message: e.message, detail: e.detail, fieldErrors: e.fieldErrors })).not.toMatch(/13\.8|Synthetic secret reason/);
  });
});

describe('T-17 AC-09.5 amendment cascade to formulas (E13)', () => {
  it('amending a formula input amends the approved dependent in the SAME transaction: same reason, new version, lab.result.amended.v1 for both, written after the input amendment', async () => {
    const m = make({
      amendRows: [amendRow(id(1), { analyte: { id: 'a-TG', code: 'TG', resultType: 'numeric', decimals: 0, formula: null }, unitCode: 'mg/dL', currentValue: { numeric: '150' } })],
      targets: [lipidTarget()], inputs: lipidInputs('200'), units: { TC: 'mg/dL', HDL: 'mg/dL', TG: 'mg/dL' },
    });
    await amendResult(m.ctx, am(id(1), { value: { numeric: '200' }, reasonCode: 'TRANSCRIPTION_ERROR', reasonText: 'Synthetic reason' }));
    const dep = m.stored('amendCalculated');
    expect(dep).toHaveLength(1);
    expect(dep[0]).toMatchObject({ resultId: id(0x70), newVersionNo: 2, origin: 'calculated', reasonCode: 'TRANSCRIPTION_ERROR', reasonText: 'Synthetic reason' });
    expect(dep[0].outcome).toMatchObject({ calcStatus: 'computed', value: '110' });      // 200 - 50 - 200/5
    expect(m.amendedEvents().map((e) => e.input.idempotencyKey).sort()).toEqual([`${id(1)}:amended:2`, `${id(0x70)}:amended:2`].sort());
    for (const e of m.amendedEvents()) expect(e.input.payload.amendment_reason_code).toBe('TRANSCRIPTION_ERROR');
    expect(m.log.findIndex((l) => l.fn === 'amendCalculated')).toBeGreaterThan(m.log.findIndex((l) => l.fn === 'amendResult'));
    for (const l of m.log) expect(l.tx, l.fn).toBe(m.tx);                                  // one transaction
  });
  it('a non-approved dependent (verified) is NOT amended: it is recomputed and returned to resulted by the system (R5, input_changed)', async () => {
    const m = make({
      amendRows: [amendRow(id(1), { analyte: { id: 'a-TG', code: 'TG', resultType: 'numeric', decimals: 0, formula: null }, unitCode: 'mg/dL', currentValue: { numeric: '150' } })],
      targets: [lipidTarget({ status: 'verified' })], inputs: lipidInputs('200'), units: { TC: 'mg/dL', HDL: 'mg/dL', TG: 'mg/dL' },
    });
    await amendResult(m.ctx, am(id(1), { value: { numeric: '200' } }));
    expect(m.of('amendCalculated')).toHaveLength(0);
    expect(m.stored('applyComputed')[0]).toMatchObject({ resultId: id(0x70), transition: { to: 'resulted', rule: 'R5', actorType: 'system', reasonCode: 'input_changed' } });
  });
  it('an amendment of a result nothing depends on writes no dependent', async () => {
    const m = make({ amendRows: [amendRow(id(1))], targets: [] });
    await amendResult(m.ctx, am(id(1)));
    expect(m.of('amendCalculated')).toHaveLength(0);
    expect(m.amendedEvents()).toHaveLength(1);
  });
});

describe('T-17 AC-17.4 / #33 listResultVersions', () => {
  const versions = [
    { result_id: id(1), version_no: 1, value_numeric: '13.4', flag: 'N', recorded_at: '2026-06-15T04:00:00.000Z', superseded: true },
    { result_id: id(1), version_no: 2, value_numeric: '13.8', flag: 'N', recorded_at: '2026-06-15T05:00:00.000Z', superseded: false, amendment_reason_code: 'TRANSCRIPTION_ERROR' },
  ];
  it('returns the store rows (v1 superseded, v2 current) after checking lab.result.read at the result centre; tenant from ctx', async () => {
    const m = make({ versions });
    const out = await listResultVersions(m.ctx, { resultId: id(1) });
    expect(out).toEqual(versions);
    expect(m.asked).toEqual([{ permission: 'lab.result.read', centreId: CENTRE }]);
    expect(m.of('listResultVersions')[0]!.tenantId).toBe(TENANT);
  });
  it('P-01 / P-02: unknown id and a caller without lab.result.read at the centre are both common.not_found', async () => {
    expect((await fail(listResultVersions(make({}).ctx, { resultId: id(9) }))).code).toBe('common.not_found');
    const m = make({ versions, assertRole: forbidden });
    expect((await fail(listResultVersions(m.ctx, { resultId: id(1) }))).code).toBe('common.not_found');
  });
});
