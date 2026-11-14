// T-29 (C3) — REAL CatalogPort, the CR-C3-001 OPTIONAL FIELDS on the existing methods.
// Spec: 02-TRD §6.1 (RangeQuery.birthOn, ReferenceRangeMatch.kind / normalCodes, CriticalLimitsMatch.abnormalCodes, TestDefinition.tatTargetSegment), §7.3, §14 contract cases (19) (20) (21) (22);
//       01-PRD AC-05.2 (exact age by birthOn when supplied), AC-05.5 (text band: text only, kind text, no low/high), AC-05.6 (ordinal band: text + normalCodes), AC-10.1 (tatTargetSeconds + tatTargetSegment);
//       08 A17.1 (birthOn is used ONLY together with ageDays; with ageDays absent it is ignored — newer than the shared fixture's case (20), which sends birthOn alone).
// World: helpers/t28a.ts (+ extra rows below, all on the RNG host test of tenant A). The domain functions already implement the matching (domain/rangeMatch.ts); what T-29 must wire is
// `birthOn` from the port input into the matcher — cases (19) (21) (22) and the TAT segment are regression guards that may already pass.
import { describe, expect, it } from 'vitest';
import { av, B_ADU2, B_NEO2, B_UNK_ADU, B_UNR, CB_AGED, CBC, M1, NOW, RAGED, RHB, RNG, RUNK, T, TENANT_A as A, codeOf, inB, one, setup28a } from '../helpers/t28a.js';
import { ana, cband, cset, rband, rset, tat } from '../helpers/testsDb.js';

const host = (n: number, code: string) => ana(n, A, RNG.test.id, { code, name: `T29 analyte ${code}` });
const MENT = host(90, 'MENT'), NIT = host(91, 'NIT'), URO = host(92, 'URO'), UMIS = host(93, 'UMIS'), MMIS = host(94, 'MMIS');
const MENT_TEXT = '<13.0 - Thalassemia trait / >13.0 - Iron deficiency';
const SMENT = rset(90, A, MENT.id as string, { unit_code: null }), SNIT = rset(91, A, NIT.id as string, { unit_code: null });
const SUMIS = rset(93, A, UMIS.id as string, { unit_code: 'g_l' }), SMMIS = rset(94, A, MMIS.id as string, { method_id: M1.id });
const CSURO = cset(92, A, URO.id as string, { unit_code: null });
const extra = {
  analytes: [MENT, NIT, URO, UMIS, MMIS],
  analyte_versions: [
    av(90, A, MENT.id as string, { result_type: 'text', unit_code: null, decimals: null }), av(91, A, NIT.id as string, { result_type: 'ordinal', unit_code: null, decimals: null, value_set_code: 'LAB_SEMIQ' }),
    av(92, A, URO.id as string, { result_type: 'ordinal', unit_code: null, decimals: null, value_set_code: 'LAB_SEMIQ' }), av(93, A, UMIS.id as string), av(94, A, MMIS.id as string),
  ],
  reference_range_sets: [SMENT, SNIT, SUMIS, SMMIS],
  reference_ranges: [
    rband(90, A, SMENT.id as string, { kind: 'text', display_text: MENT_TEXT }),
    rband(91, A, SNIT.id as string, { kind: 'ordinal', normal_codes: ['NEG'], display_text: 'Negative' }),
    rband(93, A, SUMIS.id as string, { low: '3.5', high: '5.0' }), rband(94, A, SMMIS.id as string, { low: '3.5', high: '5.0' }),
  ],
  critical_limit_sets: [CSURO],
  critical_limits: [cband(92, A, CSURO.id as string, { abnormal_codes: ['2+'] })],
  tat_targets: [tat(90, A, CBC.test.id, { priority: 'routine', segment: 'within_lab', target_seconds: 14400 }), tat(91, A, CBC.test.id, { priority: 'urgent', segment: 'within_lab', target_seconds: 3600 })],
};
const env = () => setup28a({ extra: extra as never });
const rq = (analyteId: unknown, o: Record<string, unknown> = {}) => ({ analyteId, sex: 'male', ageDays: 400, at: NOW, ...o });

describe('(19) AC-05.5 a text-kind band returns text only', () => {
  it('kind text, the display text verbatim, no low / high, no normalCodes (C5 must not compute an H/L flag)', { timeout: T }, async () => {
    const r = await one(env(), 'referenceRangeFor', rq(MENT.id));
    expect(r.kind).toBe('text');
    expect(r.text).toBe(MENT_TEXT);
    expect(r.low).toBeUndefined();
    expect(r.high).toBeUndefined();
    expect(r).not.toHaveProperty('low');
    expect(r).not.toHaveProperty('high');
    expect(r).not.toHaveProperty('normalCodes');
  });
});

describe('AC-05.6 an ordinal band returns text + normalCodes', () => {
  it('kind ordinal, text "Negative", normalCodes ["NEG"], no low / high', { timeout: T }, async () => {
    const r = await one(env(), 'referenceRangeFor', rq(NIT.id));
    expect([r.kind, r.text, r.normalCodes]).toEqual(['ordinal', 'Negative', ['NEG']]);
    expect(r).not.toHaveProperty('low');
    expect(r).not.toHaveProperty('high');
  });
  it('a numeric band is kind "numeric" without normalCodes (the optional fields are omitted, never null)', { timeout: T }, async () => {
    const r = await one(env(), 'referenceRangeFor', rq(RHB.id, { ageDays: 5 }));
    expect(r.kind).toBe('numeric');
    expect(r).not.toHaveProperty('normalCodes');
  });
});

describe('(20) AC-05.2 birthOn = exact calendar age, used together with ageDays', () => {
  // NOW = 2026-11-07 (17:45 in Asia/Kathmandu). RHB: neonate [0 d, 30 d) / adult [30 d, inf) in the set effective since 2026-10-01.
  it('exactly 30 days old by birthOn -> adult band, even though the supplied ageDays says 29; 29 days by birthOn -> neonate band even though ageDays says 400', { timeout: T }, async () => {
    const e = env();
    expect((await one(e, 'referenceRangeFor', rq(RHB.id, { ageDays: 29, birthOn: '2026-10-08' }))).referenceRangeId).toBe(B_ADU2.id);
    expect((await one(e, 'referenceRangeFor', rq(RHB.id, { ageDays: 400, birthOn: '2026-10-09' }))).referenceRangeId).toBe(B_NEO2.id);
  });
  it('without birthOn the ageDays approximation decides (control)', { timeout: T }, async () => {
    const e = env();
    expect((await one(e, 'referenceRangeFor', rq(RHB.id, { ageDays: 29 }))).referenceRangeId).toBe(B_NEO2.id);
    expect((await one(e, 'referenceRangeFor', rq(RHB.id, { ageDays: 30 }))).referenceRangeId).toBe(B_ADU2.id);
  });
  it('the 18th birthday: birthOn 2008-11-07 is exactly 18 y on 2026-11-07 -> the "18 y - inf" band; one day younger -> not that band', { timeout: T }, async () => {
    const e = env();
    expect((await one(e, 'referenceRangeFor', { analyteId: RUNK.id, sex: 'male', ageDays: 6573, birthOn: '2008-11-07', at: NOW })).referenceRangeId).toBe(B_UNK_ADU.id);
    expect((await one(e, 'referenceRangeFor', { analyteId: RUNK.id, sex: 'male', ageDays: 6574, birthOn: '2008-11-08', at: NOW })).referenceRangeId).toBe(B_UNR.id);
  });
  it('birthOn is ignored when ageDays is absent (08 A17.1): the age-unrestricted band, as without birthOn', { timeout: T }, async () => {
    expect((await one(env(), 'referenceRangeFor', { analyteId: RUNK.id, sex: 'male', birthOn: '2008-11-07', at: NOW })).referenceRangeId).toBe(B_UNR.id);
  });
  it('criticalLimitsFor honours birthOn too: ageDays 400 but born 2025-11-08 (11 months 30 days) -> below the "1 y - inf" critical band -> undefined; born 2025-11-07 -> the band', { timeout: T }, async () => {
    const e = env();
    expect(await one(e, 'criticalLimitsFor', { analyteId: RAGED.id, sex: 'male', ageDays: 400, birthOn: '2025-11-08', at: NOW })).toBeUndefined();
    expect((await one(e, 'criticalLimitsFor', { analyteId: RAGED.id, sex: 'male', ageDays: 300, birthOn: '2025-11-07', at: NOW })).criticalLimitId).toBe(CB_AGED.id);
    expect((await one(e, 'criticalLimitsFor', { analyteId: RAGED.id, sex: 'male', ageDays: 400, at: NOW })).criticalLimitId).toBe(CB_AGED.id);       // control: ageDays alone
  });
  it('a malformed birthOn -> common.validation_failed', { timeout: T }, async () => {
    for (const birthOn of ['2008-13-01', '08-11-2008', 'yesterday', 20081107]) expect(await codeOf(one(env(), 'referenceRangeFor', rq(RHB.id, { birthOn }))), String(birthOn)).toBe('common.validation_failed');
  });
  it('birthOn in the future of `at` is not a negative age: validation_failed or no match, never a crash', { timeout: T }, async () => {
    const out = await one(env(), 'referenceRangeFor', rq(RHB.id, { birthOn: '2030-01-01' })).then(() => 'ok', (e: any) => e?.code);
    expect(['ok', 'common.validation_failed', 'catalog.no_reference_range']).toContain(out);
  });
});

describe('(21) a critical ordinal limit returns abnormalCodes', () => {
  it('abnormalCodes ["2+"], no low / high', { timeout: T }, async () => {
    const r = await one(env(), 'criticalLimitsFor', rq(URO.id));
    expect(r.abnormalCodes).toEqual(['2+']);
    expect(r.low).toBeUndefined();
    expect(r.high).toBeUndefined();
    expect(r).not.toHaveProperty('low');
  });
  it('a numeric critical band has no abnormalCodes key', { timeout: T }, async () => {
    const r = await one(env(), 'criticalLimitsFor', rq(RHB.id));
    expect([r.low, r.high]).toEqual(['5.0', '22.0']);
    expect(r).not.toHaveProperty('abnormalCodes');
  });
  it('another tenant cannot read it (common.not_found for the analyte)', { timeout: T }, async () => {
    expect(await codeOf(one(env(), 'criticalLimitsFor', rq(URO.id), inB))).toBe('common.not_found');
  });
});

describe('(22) unit / method snapshot mismatch -> catalog.no_reference_range', () => {
  it('range set unit g_l vs analyte version unit g_dl', { timeout: T }, async () => {
    expect(await codeOf(one(env(), 'referenceRangeFor', rq(UMIS.id)))).toBe('catalog.no_reference_range');
  });
  it('range set method differs from the analyte version method (none)', { timeout: T }, async () => {
    expect(await codeOf(one(env(), 'referenceRangeFor', rq(MMIS.id)))).toBe('catalog.no_reference_range');
  });
  it('control: a set whose unit and method equal the analyte version\'s answers', { timeout: T }, async () => {
    expect((await one(env(), 'referenceRangeFor', rq(RHB.id))).low).toBe('12.0');
  });
});

describe('AC-10.1 getTest: tatTargetSeconds + tatTargetSegment', () => {
  it('routine 4 h / urgent 1 h within_lab -> { routine: 14400, urgent: 3600 }, segment "within_lab"', { timeout: T }, async () => {
    const t = await one(env(), 'getTest', { testId: CBC.test.id });
    expect(t.tatTargetSeconds).toEqual({ routine: 14400, urgent: 3600 });
    expect(t.tatTargetSegment).toBe('within_lab');
  });
  it('a test without TAT targets has neither key', { timeout: T }, async () => {
    const t = await one(setup28a(), 'getTest', { testId: CBC.test.id });
    expect(t).not.toHaveProperty('tatTargetSeconds');
    expect(t).not.toHaveProperty('tatTargetSegment');
  });
});
