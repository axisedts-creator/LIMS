// T-08 (C3) — domain/rangeMatch.ts: reference-range / critical-limit band selection, unit tests ("boundary matrix").
// Spec: 02-TRD §7.3 steps 1–7 (08 A17.1 age unknown), PRD AC-05.1–05.6, AC-05.8, AC-05.10, AC-05.11, AC-06.1–06.3, AC-06.5; 03-IC §4.2 contract tests 3, 9, 10, 32–33.
// SEAM (spec silent on function names; pure functions, no I/O; see .orchestra/notes/C3.T-08-tests.md). Rows are the DB columns (05-SCHEMA reference_ranges /
// critical_limits / *_sets); dates may be Date or ISO strings; low/high are decimal STRINGS (scale preserved):
//   ageOf(q)                      q = { ageDays?, birthOn?, at, timezone? }  -> { days, weeks, months, years } | undefined  (undefined = age unknown: ageDays absent)
//   selectSet(sets, at)           sets = [{ status, effective_from, effective_to }]  -> the set effective at `at` (published/superseded/retired only) | undefined   (step 1)
//   selectBand(bands, q)          bands = reference_ranges / critical_limits rows; q = { sex, ageDays?, birthOn?, specimenTypeId?, at, timezone? } -> the winning row | undefined  (steps 3–5)
//   findOverlaps(bands)           -> [i, j][] (i < j, ascending) pairs of equal (sex, specimen_type_id) whose age intervals overlap  (step 6; day = 1, week = 7, month = 30.4375, year = 365.25)
//   resolveReferenceRange({ sets, versions, query })  sets = [{ id, version_no, status, unit_code, method_id, effective_from, effective_to, bands }]; versions = the analyte's
//       versions [{ status, unit_code, method_id, effective_from, effective_to }]  -> { referenceRangeId, version, low?, high?, text?, unitCode?, kind, normalCodes? } | undefined   (steps 1–7)
//   resolveCriticalLimits({ sets, versions, query })  -> { criticalLimitId, version, low?, high?, abnormalCodes? } | undefined
// Default timezone is Asia/Kathmandu (UTC+05:45, 08 A13 P-15). Synthetic data only.
import { describe, expect, it } from 'vitest';
import { ageOf, findOverlaps, resolveCriticalLimits, resolveReferenceRange, selectBand, selectSet } from '../rangeMatch.js';

const id = (n: number) => `0190c300-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const D = (s: string) => new Date(s);
const T0 = '2026-01-01T00:00:00.000Z', T1 = '2026-12-01T00:00:00.000Z';
const AT = '2026-11-07T06:00:00.000Z';                                // 2026-11-07 11:45 in Asia/Kathmandu
const URINE = id(0x201), EDTA = id(0x202);
const age = (value: number, unit: string) => ({ value, unit });

let seq = 0;
/** A band row; defaults: any sex, no age bound, numeric 1.0–2.0, no specimen. */
const band = (o: Record<string, unknown> = {}) => ({ id: id(0x7000 + ++seq), sex: 'any', age_low_value: null, age_low_unit: null, age_high_value: null, age_high_unit: null,
  specimen_type_id: null, kind: 'numeric', low: '1.0', high: '2.0', normal_codes: null, display_text: null, sort_order: 100, ...o });
const lo = (v: number, u: string) => ({ age_low_value: v, age_low_unit: u });
const hi = (v: number, u: string) => ({ age_high_value: v, age_high_unit: u });
const set = (o: Record<string, unknown> = {}, bands: unknown[] = []) => ({ id: id(0x6001), version_no: 1, status: 'published', unit_code: 'g_dl', method_id: null,
  effective_from: D(T0), effective_to: null, bands, ...o });
const ver = (o: Record<string, unknown> = {}) => ({ status: 'published', unit_code: 'g_dl', method_id: null, effective_from: D(T0), effective_to: null, ...o });
const q = (o: Record<string, unknown> = {}) => ({ sex: 'male', ageDays: 9000, at: AT, ...o });
const pick = (bands: unknown[], o: Record<string, unknown> = {}) => (selectBand as any)(bands, q(o));

// AC-05.1 fixture (SYNTHETIC values): {male 18y–∞ 13.0–17.0}, {female 18y–∞ 12.0–15.0}, {any 0d–18y 11.0–16.0}
const HB_M = band({ sex: 'male', ...lo(18, 'year'), low: '13.0', high: '17.0' });
const HB_F = band({ sex: 'female', ...lo(18, 'year'), low: '12.0', high: '15.0' });
const HB_C = band({ sex: 'any', ...lo(0, 'day'), ...hi(18, 'year'), low: '11.0', high: '16.0' });
const HB_SET = set({}, [HB_M, HB_F, HB_C]);

describe('ageOf — age unknown (08 A17.1) and the day-count approximation (TRD §7.3 step 3)', () => {
  it('ageDays absent -> undefined, also when birthOn is supplied (birthOn is ignored without ageDays)', () => {
    expect(ageOf({ at: AT })).toBeUndefined();
    expect(ageOf({ at: AT, birthOn: '2008-11-07' })).toBeUndefined();
  });

  it('day 0 is a valid known age (0 is not "unknown")', () => {
    expect(ageOf({ ageDays: 0, at: AT })).toEqual({ days: 0, weeks: 0, months: 0, years: 0 });
  });

  it.each([[6, 0], [7, 1], [13, 1], [14, 2]])('ageDays %i -> %i completed weeks (floor(ageDays/7))', (d, w) => {
    expect(ageOf({ ageDays: d, at: AT })!.weeks).toBe(w);
  });

  it.each([[30, 0], [31, 1], [60, 1], [61, 2]])('ageDays %i -> %i months (floor(ageDays/30.4375))', (d, m) => {
    expect(ageOf({ ageDays: d, at: AT })!.months).toBe(m);
  });

  it.each([[365, 0], [366, 1], [6574, 17], [6575, 18]])('ageDays %i -> %i years (floor(ageDays/365.25))', (d, y) => {
    expect(ageOf({ ageDays: d, at: AT })!.years).toBe(y);
  });

  it('days is the given ageDays', () => {
    expect(ageOf({ ageDays: 9000, at: AT })!.days).toBe(9000);
  });
});

describe('ageOf with birthOn — completed calendar units at the `at` date in the tenant timezone', () => {
  it('exactly 18 completed years on the birthday; one day earlier = 17', () => {
    expect(ageOf({ ageDays: 6574, birthOn: '2008-11-07', at: '2026-11-07T06:00:00.000Z' })!.years).toBe(18);
    expect(ageOf({ ageDays: 6573, birthOn: '2008-11-07', at: '2026-11-06T06:00:00.000Z' })!.years).toBe(17);
  });

  it('birthOn wins over the approximation: 6574 days is 17 by ageDays alone but 18 with the exact birthday (leap days 2012/16/20/24)', () => {
    expect(ageOf({ ageDays: 6574, at: AT })!.years).toBe(17);
    expect(ageOf({ ageDays: 6574, birthOn: '2008-11-07', at: AT })!.years).toBe(18);
  });

  it('the `at` date is taken in Asia/Kathmandu, not UTC: 2026-11-06T19:00Z is already 2026-11-07 there', () => {
    expect(ageOf({ ageDays: 6573, birthOn: '2008-11-07', at: '2026-11-06T19:00:00.000Z' })!.years).toBe(18);
    expect(ageOf({ ageDays: 6573, birthOn: '2008-11-07', at: '2026-11-06T17:00:00.000Z' })!.years).toBe(17);
  });

  it('completed calendar months and weeks', () => {
    expect(ageOf({ ageDays: 184, birthOn: '2026-05-08', at: '2026-11-08T03:00:00.000Z' })).toMatchObject({ months: 6, days: 184, weeks: 26 });
    expect(ageOf({ ageDays: 183, birthOn: '2026-05-08', at: '2026-11-07T03:00:00.000Z' })).toMatchObject({ months: 5, days: 183, weeks: 26 });
  });

  it('a newborn: birthOn = the at date -> all zero', () => {
    expect(ageOf({ ageDays: 0, birthOn: '2026-11-07', at: AT })).toEqual({ days: 0, weeks: 0, months: 0, years: 0 });
  });
});

describe('selectSet — step 1: effective_from <= at < coalesce(effective_to, +inf)', () => {
  const s1 = set({ id: id(1), version_no: 1, status: 'superseded', effective_from: D(T0), effective_to: D(T1) });
  const s2 = set({ id: id(2), version_no: 2, status: 'published', effective_from: D(T1), effective_to: null });
  const pickSet = (sets: unknown[], at: string) => (selectSet as any)(sets, at)?.id;

  it('lower bound inclusive, upper exclusive (AC-05.8: at < T1 -> v1, at >= T1 -> v2)', () => {
    expect(pickSet([s1, s2], '2026-11-30T23:59:59.999Z')).toBe(id(1));
    expect(pickSet([s1, s2], T1)).toBe(id(2));
    expect(pickSet([s1, s2], T0)).toBe(id(1));
  });

  it('before the first set -> undefined (AC-05.10)', () => {
    expect(pickSet([s1, s2], '2025-12-31T23:59:59.999Z')).toBeUndefined();
  });

  it('input order does not matter', () => {
    expect(pickSet([s2, s1], '2026-06-01T00:00:00.000Z')).toBe(id(1));
  });

  it('a retired set is effective until its effective_to (the retire instant), then nothing', () => {
    const r = set({ id: id(3), status: 'retired', effective_from: D(T0), effective_to: D('2026-06-01T00:00:00.000Z') });
    expect(pickSet([r], '2026-05-31T23:59:59.999Z')).toBe(id(3));
    expect(pickSet([r], '2026-06-01T00:00:00.000Z')).toBeUndefined();
  });

  it('drafts and discarded sets are never selected, whatever their dates (defence in depth)', () => {
    for (const status of ['draft', 'discarded']) expect(pickSet([set({ id: id(4), status })], AT), status).toBeUndefined();
  });

  it('a scheduled (future) published set is not selected before its effective_from', () => {
    expect(pickSet([set({ id: id(5), effective_from: D(T1) })], AT)).toBeUndefined();
  });

  it('ISO-string dates work like Date objects', () => {
    expect(pickSet([{ ...s1, effective_from: T0, effective_to: T1 }], AT)).toBe(id(1));
  });
});

describe('selectBand — boundaries (AC-05.2): lower inclusive, upper exclusive [CONV]', () => {
  const CHILD = band({ ...lo(0, 'day'), ...hi(18, 'year'), low: '11.0', high: '16.0' });
  const ADULT = band({ ...lo(18, 'year'), low: '13.0', high: '17.0' });

  it('day 0 matches the 0 d band (03-IC contract test 9)', () => {
    expect(pick([CHILD, ADULT], { ageDays: 0 })).toBe(CHILD);
  });

  it('18 years via the day-count approximation: 6574 d = 17 y -> child, 6575 d = 18 y -> adult', () => {
    expect(pick([CHILD, ADULT], { ageDays: 6574 })).toBe(CHILD);
    expect(pick([CHILD, ADULT], { ageDays: 6575 })).toBe(ADULT);
  });

  it('18 years via birthOn: on the 18th birthday -> adult (even if ageDays says 17), the day before -> child', () => {
    expect(pick([CHILD, ADULT], { ageDays: 6574, birthOn: '2008-11-07', at: '2026-11-07T06:00:00.000Z' })).toBe(ADULT);
    expect(pick([CHILD, ADULT], { ageDays: 6573, birthOn: '2008-11-07', at: '2026-11-06T06:00:00.000Z' })).toBe(CHILD);
  });

  it('week / month / year bounds each compare in their own unit', () => {
    const NEO = band({ ...lo(0, 'day'), ...hi(1, 'week') }), INF = band({ ...lo(1, 'week'), ...hi(1, 'month') }), BABY = band({ ...lo(1, 'month'), ...hi(2, 'year') });
    expect(pick([NEO, INF, BABY], { ageDays: 6 })).toBe(NEO);
    expect(pick([NEO, INF, BABY], { ageDays: 7 })).toBe(INF);
    expect(pick([NEO, INF, BABY], { ageDays: 30 })).toBe(INF);
    expect(pick([NEO, INF, BABY], { ageDays: 31 })).toBe(BABY);
    expect(pick([NEO, INF, BABY], { ageDays: 730 })).toBe(BABY);        // 730 / 365.25 = 1.998 y
    expect(pick([NEO, INF, BABY], { ageDays: 731 })).toBeUndefined();   // 2.001 y: past the upper bound, nothing else matches
  });

  it('open-ended bounds: only age_low (x..inf) and only age_high (0..x)', () => {
    const OLD = band({ ...lo(65, 'year') }), YOUNG = band({ ...hi(1, 'year') });
    expect(pick([OLD, YOUNG], { ageDays: 23_742 })).toBe(OLD);          // 65.0007 y
    expect(pick([OLD, YOUNG], { ageDays: 23_741 })).toBeUndefined();    // 64.998 y
    expect(pick([OLD, YOUNG], { ageDays: 365 })).toBe(YOUNG);
    expect(pick([OLD, YOUNG], { ageDays: 366 })).toBeUndefined();
  });

  it('a band whose age window is empty of the patient is skipped, not an error', () => {
    expect(pick([band({ ...lo(1, 'year'), ...hi(2, 'year') })], { ageDays: 10 })).toBeUndefined();
  });
});

describe('selectBand — age unknown (ageDays absent): only bands with BOTH age bounds absent (08 A17.1, AC-05.11)', () => {
  const OPEN = band({ sex: 'any', low: '11.0', high: '17.0' });
  const unknown = (bands: unknown[], o: Record<string, unknown> = {}) => (selectBand as any)(bands, { sex: 'male', at: AT, ...o });

  it('the age-unrestricted band is returned, with or without birthOn', () => {
    expect(unknown([HB_M, HB_F, HB_C, OPEN])).toBe(OPEN);
    expect(unknown([HB_M, HB_F, HB_C, OPEN], { birthOn: '1990-01-01' })).toBe(OPEN);
  });

  it('every band has an age bound, even the open-ended 18 y–inf ones -> undefined', () => {
    expect(unknown([HB_M, HB_F, HB_C])).toBeUndefined();
    expect(unknown([HB_M, HB_F, HB_C], { birthOn: '1990-01-01' })).toBeUndefined();
    expect(unknown([band({ ...lo(0, 'day') })])).toBeUndefined();     // age_low 0 d is still a bound
    expect(unknown([band({ ...hi(120, 'year') })])).toBeUndefined();  // so is an age_high only
  });

  it('sex and specimen rules still apply to age-unrestricted bands', () => {
    const F_OPEN = band({ sex: 'female' });
    expect(unknown([F_OPEN])).toBeUndefined();
    expect(unknown([F_OPEN], { sex: 'female' })).toBe(F_OPEN);
    expect(unknown([band({ specimen_type_id: URINE })])).toBeUndefined();
  });

  it('age known: the same age-unrestricted band still matches any age (day 0 and 100 y)', () => {
    expect(pick([OPEN], { ageDays: 0 })).toBe(OPEN);
    expect(pick([OPEN], { ageDays: 36_525 })).toBe(OPEN);
  });
});

describe('selectBand — sex (AC-05.4) and specificity (AC-05.3, step 5)', () => {
  const ANY = band({ sex: 'any', low: '1.0', high: '9.0' }), FEM = band({ sex: 'female', low: '2.0', high: '8.0' }), MAL = band({ sex: 'male', low: '3.0', high: '7.0' });

  it('male / female see their own sex band over any (AC-05.3: female wins over any)', () => {
    expect(pick([ANY, FEM, MAL], { sex: 'female' })).toBe(FEM);
    expect(pick([FEM, MAL, ANY], { sex: 'male' })).toBe(MAL);
  });

  it('a sex band of the other sex never matches', () => {
    expect(pick([FEM], { sex: 'male' })).toBeUndefined();
    expect(pick([ANY, FEM], { sex: 'male' })).toBe(ANY);
  });

  it.each(['other', 'unknown'])("sex '%s' matches only 'any' bands; none -> undefined", (sex) => {
    expect(pick([FEM, MAL, ANY], { sex })).toBe(ANY);
    expect(pick([FEM, MAL], { sex })).toBeUndefined();
  });

  it('specimen: the specimen-specific band wins when the query names that specimen (AC-05.3)', () => {
    const GEN = band({ low: '1.0', high: '9.0' }), URI = band({ specimen_type_id: URINE, low: '2.0', high: '8.0' });
    expect(pick([GEN, URI], { specimenTypeId: URINE })).toBe(URI);
    expect(pick([URI, GEN], { specimenTypeId: URINE })).toBe(URI);
  });

  it('a query WITHOUT a specimen matches only bands without one', () => {
    const GEN = band(), URI = band({ specimen_type_id: URINE });
    expect(pick([URI, GEN])).toBe(GEN);
    expect(pick([URI])).toBeUndefined();
  });

  it('a band for another specimen does not match; the unspecific band does', () => {
    const GEN = band(), BLOOD = band({ specimen_type_id: EDTA });
    expect(pick([BLOOD, GEN], { specimenTypeId: URINE })).toBe(GEN);
    expect(pick([BLOOD], { specimenTypeId: URINE })).toBeUndefined();
  });

  it('score = specimen 2 + sex 1: {any sex, specimen} (2) beats {female, no specimen} (1); {female, specimen} (3) beats both', () => {
    const SPEC_ANY = band({ specimen_type_id: URINE }), FEM_ONLY = band({ sex: 'female' }), BOTH = band({ sex: 'female', specimen_type_id: URINE });
    expect(pick([FEM_ONLY, SPEC_ANY], { sex: 'female', specimenTypeId: URINE })).toBe(SPEC_ANY);
    expect(pick([FEM_ONLY, SPEC_ANY, BOTH], { sex: 'female', specimenTypeId: URINE })).toBe(BOTH);
  });

  it('specificity ignores age-window width: a narrower age window does not beat a more specific sex', () => {
    const NARROW_ANY = band({ ...lo(0, 'day'), ...hi(100, 'year') }), FEM_WIDE = band({ sex: 'female' });
    expect(pick([NARROW_ANY, FEM_WIDE], { sex: 'female', ageDays: 100 })).toBe(FEM_WIDE);
  });

  it('equal score (impossible after publish validation) falls back to sort_order, then id — deterministic whatever the input order', () => {
    const A = band({ id: id(0x9001), sort_order: 20 }), B = band({ id: id(0x9002), sort_order: 10 }), C = band({ id: id(0x9003), sort_order: 10 });
    expect(pick([A, B, C])).toBe(B);
    expect(pick([C, B, A])).toBe(B);
  });
});

describe('findOverlaps — publish validation, step 6 (AC-05.7): equal (sex, specimen) whose age intervals overlap', () => {
  const ov = (bands: unknown[]) => (findOverlaps as any)(bands);

  it('no overlap for the AC-05.1 set (adjacent 0d–18y / 18y–inf touch but do not overlap; different sexes)', () => {
    expect(ov([HB_M, HB_F, HB_C])).toEqual([]);
  });

  it('two equal-sex bands that overlap in age -> the pair of indexes, i < j', () => {
    expect(ov([band({ ...lo(0, 'year'), ...hi(10, 'year') }), band({ ...lo(18, 'year') }), band({ ...lo(5, 'year'), ...hi(20, 'year') })])).toEqual([[0, 2], [1, 2]]);
  });

  it('a band with no age bound overlaps every other band of the same (sex, specimen)', () => {
    expect(ov([band(), band({ ...lo(0, 'day'), ...hi(18, 'year') })])).toEqual([[0, 1]]);
  });

  it('a different sex or a different specimen never overlaps (sex any vs female are separate keys)', () => {
    expect(ov([band({ sex: 'any' }), band({ sex: 'female' })])).toEqual([]);
    expect(ov([band(), band({ specimen_type_id: URINE })])).toEqual([]);
    expect(ov([band({ specimen_type_id: EDTA }), band({ specimen_type_id: URINE })])).toEqual([]);
  });

  it('bounds are compared in days after unit conversion: 12 months = 365.25 d = 1 year (touching), 13 months overlaps 1 year', () => {
    expect(ov([band({ ...lo(0, 'day'), ...hi(12, 'month') }), band({ ...lo(1, 'year') })])).toEqual([]);
    expect(ov([band({ ...lo(0, 'day'), ...hi(13, 'month') }), band({ ...lo(1, 'year') })])).toEqual([[0, 1]]);
    expect(ov([band({ ...lo(0, 'day'), ...hi(52, 'week') }), band({ ...lo(1, 'year') })])).toEqual([]);   // 364 d < 365.25 d
    expect(ov([band({ ...lo(0, 'day'), ...hi(53, 'week') }), band({ ...lo(1, 'year') })])).toEqual([[0, 1]]); // 371 d > 365.25 d
  });

  it('identical windows overlap (the duplicate-row case)', () => {
    expect(ov([band({ ...lo(1, 'year'), ...hi(2, 'year') }), band({ ...lo(1, 'year'), ...hi(2, 'year') })])).toEqual([[0, 1]]);
  });

  it('empty and single-band lists have no overlaps', () => {
    expect(ov([])).toEqual([]);
    expect(ov([band()])).toEqual([]);
  });
});

describe('resolveReferenceRange — AC-05.1 … 05.6, 05.8, 05.10, 05.11 (steps 1–7)', () => {
  const run = (sets: unknown[], query: Record<string, unknown> = {}, versions: unknown[] = [ver()]) => (resolveReferenceRange as any)({ sets, versions, query: q(query) });

  it('AC-05.1: male, ageDays 9000 -> the male band with low "13.0", high "17.0" (scale preserved), version 1, unitCode g_dl, numeric', () => {
    const r = run([HB_SET]);
    expect(r).toMatchObject({ referenceRangeId: HB_M.id, version: 1, low: '13.0', high: '17.0', unitCode: 'g_dl', kind: 'numeric' });
    expect(r.normalCodes).toBeUndefined();
  });

  it('AC-05.1: the female and the child band of the same set', () => {
    expect(run([HB_SET], { sex: 'female' })).toMatchObject({ referenceRangeId: HB_F.id, low: '12.0', high: '15.0' });
    expect(run([HB_SET], { ageDays: 1000 })).toMatchObject({ referenceRangeId: HB_C.id, low: '11.0', high: '16.0' });
  });

  it('AC-05.4: sex other / unknown -> only any-sex bands; none -> undefined', () => {
    expect(run([HB_SET], { sex: 'other', ageDays: 1000 })).toMatchObject({ referenceRangeId: HB_C.id });
    expect(run([HB_SET], { sex: 'unknown', ageDays: 1000 })).toMatchObject({ referenceRangeId: HB_C.id });
    expect(run([HB_SET], { sex: 'other', ageDays: 9000 })).toBeUndefined();          // the adult bands are sex-specific
    expect(run([set({}, [HB_M, HB_F])], { sex: 'unknown' })).toBeUndefined();
  });

  it('AC-05.5: a text band returns the display text, kind text, and no low/high (C5 must not compute a flag)', () => {
    const TXT = '<13.0 - Thalassemia trait / >13.0 - Iron deficiency';
    const r = run([set({}, [band({ kind: 'text', low: null, high: null, display_text: TXT })])]);
    expect(r).toMatchObject({ text: TXT, kind: 'text' });
    expect(r.low).toBeUndefined(); expect(r.high).toBeUndefined();
  });

  it('AC-05.6: an ordinal band returns text "Negative", kind ordinal and normalCodes ["NEG"]', () => {
    const r = run([set({ unit_code: null }, [band({ kind: 'ordinal', low: null, high: null, normal_codes: ['NEG'], display_text: 'Negative' })])], {}, [ver({ unit_code: null })]);
    expect(r).toMatchObject({ text: 'Negative', kind: 'ordinal', normalCodes: ['NEG'] });
    expect(r.low).toBeUndefined(); expect(r.high).toBeUndefined();
  });

  it('step 7 text: display_text wins; otherwise "<low> - <high>", "< <high>", "> <low>" with the stored scale', () => {
    const t = (b: Record<string, unknown>) => run([set({}, [band(b)])]).text;
    expect(t({ low: '13.0', high: '17.0' })).toBe('13.0 - 17.0');
    expect(t({ low: null, high: '5.50' })).toBe('< 5.50');
    expect(t({ low: '0.40', high: null })).toBe('> 0.40');
    expect(t({ low: '13.0', high: '17.0', display_text: 'Adult male' })).toBe('Adult male');
  });

  it('a one-sided numeric band keeps only the bound it has', () => {
    const r = run([set({}, [band({ low: null, high: '5.50' })])]);
    expect(r).toMatchObject({ high: '5.50' }); expect(r.low).toBeUndefined();
  });

  it('AC-05.3 through the whole pipeline: specimen-specific band wins (query specimen URINE), generic otherwise', () => {
    const GEN = band({ low: '1.0', high: '9.0' }), URI = band({ specimen_type_id: URINE, low: '2.0', high: '8.0' });
    expect(run([set({}, [GEN, URI])], { specimenTypeId: URINE })).toMatchObject({ referenceRangeId: URI.id });
    expect(run([set({}, [GEN, URI])])).toMatchObject({ referenceRangeId: GEN.id });
  });

  it('AC-05.8: v1 (superseded) before T1, v2 from T1 on; version is the set version_no', () => {
    const s1 = set({ id: id(1), version_no: 1, status: 'superseded', effective_to: D(T1) }, [band({ low: '13.0', high: '17.0' })]);
    const s2 = set({ id: id(2), version_no: 2, effective_from: D(T1) }, [band({ low: '13.5', high: '17.5' })]);
    expect(run([s1, s2], { at: '2026-11-30T23:59:59.999Z' })).toMatchObject({ version: 1, low: '13.0' });
    expect(run([s2, s1], { at: T1 })).toMatchObject({ version: 2, low: '13.5' });
  });

  it('AC-05.10: no set effective at `at` -> undefined (before the first, after a retire)', () => {
    expect(run([HB_SET], { at: '2025-06-01T00:00:00.000Z' })).toBeUndefined();
    expect(run([set({ status: 'retired', effective_to: D('2026-06-01T00:00:00.000Z') }, [band()])], { at: '2026-06-01T00:00:00.000Z' })).toBeUndefined();
    expect(run([])).toBeUndefined();
  });

  it('AC-05.10: the set snapshot must equal the analyte version effective at `at` — unit mismatch -> undefined', () => {
    expect(run([set({ unit_code: 'g_dl' }, [band()])], {}, [ver({ unit_code: 'mmol_l' })])).toBeUndefined();
  });

  it('AC-05.10: method mismatch -> undefined; null equals null; null does not equal a method', () => {
    const M = id(0x401);
    expect(run([set({ method_id: M }, [band()])], {}, [ver({ method_id: null })])).toBeUndefined();
    expect(run([set({ method_id: null }, [band()])], {}, [ver({ method_id: M })])).toBeUndefined();
    expect(run([set({ method_id: M }, [band()])], {}, [ver({ method_id: M })])).toBeDefined();
    expect(run([set({ method_id: null, unit_code: null }, [band()])], {}, [ver({ method_id: null, unit_code: null })])).toBeDefined();
  });

  it('the analyte version used is the one effective AT `at`: v1 [T0,T1) g_dl, v2 [T1,inf) mmol_l', () => {
    const versions = [ver({ status: 'superseded', effective_to: D(T1) }), ver({ unit_code: 'mmol_l', effective_from: D(T1) })];
    const s1 = set({ id: id(1), status: 'superseded', unit_code: 'g_dl', effective_to: D(T1) }, [band()]);
    const s2 = set({ id: id(2), version_no: 2, unit_code: 'mmol_l', effective_from: D(T1) }, [band()]);
    expect(run([s1, s2], { at: '2026-11-30T00:00:00.000Z' }, versions)).toMatchObject({ unitCode: 'g_dl' });
    expect(run([s1, s2], { at: '2026-12-02T00:00:00.000Z' }, versions)).toMatchObject({ unitCode: 'mmol_l' });
    // a g_dl set that was never closed, queried after the unit changed -> mismatch, never a stale range
    expect(run([set({ id: id(3), unit_code: 'g_dl' }, [band()])], { at: '2026-12-02T00:00:00.000Z' }, versions)).toBeUndefined();
  });

  it('no analyte version effective at `at` -> undefined (cannot confirm the snapshot)', () => {
    expect(run([HB_SET], {}, [])).toBeUndefined();
  });

  it('AC-05.11: HB set + an age-unrestricted any band; ageDays absent -> that band; the AC-05.1 set alone -> undefined (contract cases 32–33)', () => {
    const OPEN = band({ sex: 'any', low: '11.0', high: '17.0' });
    const withOpen = set({}, [HB_M, HB_F, HB_C, OPEN]);
    expect(run([withOpen], { ageDays: undefined })).toMatchObject({ referenceRangeId: OPEN.id, low: '11.0', high: '17.0' });
    expect(run([withOpen], { ageDays: undefined, birthOn: '1990-01-01' })).toMatchObject({ referenceRangeId: OPEN.id });
    expect(run([HB_SET], { ageDays: undefined })).toBeUndefined();
    expect(run([HB_SET], { ageDays: undefined, birthOn: '1990-01-01' })).toBeUndefined();
  });

  it('AC-05.2 end to end: exactly 18 y via birthOn -> adult male band; via ageDays 6574 -> still the child (any) band', () => {
    expect(run([HB_SET], { ageDays: 6574, birthOn: '2008-11-07', at: '2026-11-07T06:00:00.000Z' })).toMatchObject({ referenceRangeId: HB_M.id });
    expect(run([HB_SET], { ageDays: 6574 })).toMatchObject({ referenceRangeId: HB_C.id });
  });
});

describe('resolveCriticalLimits — AC-06.1, 06.2, 06.3, 06.5 (same selection rules, lighter output)', () => {
  const cb = (o: Record<string, unknown> = {}) => ({ id: id(0x7800 + ++seq), sex: 'any', age_low_value: null, age_low_unit: null, age_high_value: null, age_high_unit: null,
    specimen_type_id: null, low: null, high: null, abnormal_codes: null, sort_order: 100, ...o });
  const run = (sets: unknown[], query: Record<string, unknown> = {}, versions: unknown[] = [ver({ unit_code: 'mmol_l' })]) => (resolveCriticalLimits as any)({ sets, versions, query: q(query) });
  const K = cb({ low: '2.5', high: '6.5' });
  const K_SET = set({ id: id(0x6801), unit_code: 'mmol_l' }, [K]);

  it('AC-06.1: {any, all ages: 2.5 – 6.5} -> low "2.5", high "6.5", criticalLimitId, version', () => {
    expect(run([K_SET])).toMatchObject({ criticalLimitId: K.id, version: 1, low: '2.5', high: '6.5' });
    expect(run([K_SET], { ageDays: 0 })).toMatchObject({ criticalLimitId: K.id });
  });

  it('AC-06.2: no set -> undefined (never throws); before the first set; after a retire', () => {
    expect(run([])).toBeUndefined();
    expect(run([K_SET], { at: '2025-06-01T00:00:00.000Z' })).toBeUndefined();
    expect(run([set({ id: id(0x6802), status: 'retired', unit_code: 'mmol_l', effective_to: D('2026-06-01T00:00:00.000Z') }, [K])])).toBeUndefined();
  });

  it('AC-06.3: an ordinal analyte with abnormal_codes ["POS"] -> abnormalCodes ["POS"], no low/high', () => {
    const P = cb({ abnormal_codes: ['POS'] });
    const r = run([set({ unit_code: null }, [P])], {}, [ver({ unit_code: null })]);
    expect(r).toMatchObject({ criticalLimitId: P.id, abnormalCodes: ['POS'] });
    expect(r.low).toBeUndefined(); expect(r.high).toBeUndefined();
  });

  it('AC-06.5: ageDays absent -> the {any, all ages} band matches; a set whose bands all carry age bounds -> undefined', () => {
    expect(run([K_SET], { ageDays: undefined })).toMatchObject({ criticalLimitId: K.id });
    const bounded = set({ id: id(0x6803), unit_code: 'mmol_l' }, [cb({ low: '2.5', ...{ age_low_value: 18, age_low_unit: 'year' } }), cb({ low: '3.0', ...hi(18, 'year') })]);
    expect(run([bounded], { ageDays: undefined })).toBeUndefined();
    expect(run([bounded], { ageDays: undefined, birthOn: '1990-01-01' })).toBeUndefined();
  });

  it('the unit/method snapshot rule applies to critical sets too: mismatch -> undefined', () => {
    expect(run([set({ unit_code: 'g_dl' }, [K])], {}, [ver({ unit_code: 'mmol_l' })])).toBeUndefined();
  });

  it('sex / age / specimen specificity as for reference ranges', () => {
    const ANY = cb({ low: '2.0' }), FEM = cb({ sex: 'female', low: '2.2' }), ADULT = cb({ low: '1.0', ...{ age_low_value: 18, age_low_unit: 'year' } });
    expect(run([set({ unit_code: 'mmol_l' }, [ANY, FEM])], { sex: 'female' })).toMatchObject({ criticalLimitId: FEM.id });
    expect(run([set({ unit_code: 'mmol_l' }, [ANY, FEM])], { sex: 'other' })).toMatchObject({ criticalLimitId: ANY.id });
    expect(run([set({ unit_code: 'mmol_l' }, [ADULT])], { ageDays: 6574 })).toBeUndefined();
    expect(run([set({ unit_code: 'mmol_l' }, [ADULT])], { ageDays: 6575 })).toMatchObject({ criticalLimitId: ADULT.id });
  });
});
