// C10 T-04 — pure domain: breakpoint suggestion (02-TRD §4.5), AC-07.2, AC-07.3. Synthetic data only (NOT CLINICAL).
// Seam expected from the writer (spec does not fix signatures):
//   ../breakpoint-eval.ts
//     export function evaluateBreakpoint(i: {
//       now: Date; standard: string;                                   // settings.manual_ast_standard
//       sets: SynSet[]; rows: SynRow[]; bands: SynBand[];              // shapes = see ./synthetic_bands.ts (DB column names)
//       request: { antibiotic_code: string; method: 'mic'|'zone_diameter'|'other'; qualifier_code?: string|null;
//                  parsed: AstValue /* from parseAstValue */; organism_code: string; organism_group_code: string|null; specimen_site_code: string|null };
//     }): { suggestion: { category_code; standard; standard_version; breakpoint_set_id; breakpoint_band_id } }
//       | { suggestion: 'none'; reason: 'no_active_set'|'no_row'|'indeterminate'|'value_invalid' };
//   Pure, exact decimals (no IEEE floats). `disabled` is a service concern, not tested here.
import { describe, expect, it } from 'vitest';
import { evaluateBreakpoint } from '../breakpoint-eval.js';
import { parseAstValue, type AstMethod } from '../ast-value.js';
import { NOW, band, gapBands, row, set, threeBands, type SynBand, type SynRow, type SynSet } from './synthetic_bands.js';

const parsed = (s: string, method: AstMethod = 'mic') => {
  const r = parseAstValue(s, method);
  if (!r.ok) throw new Error(`fixture value invalid: ${s}`);
  return r.value;
};

interface Over { sets?: SynSet[]; rows?: SynRow[]; bands?: SynBand[]; value?: string; method?: AstMethod; qualifier_code?: string | null;
  organism_code?: string; organism_group_code?: string | null; site?: string | null; standard?: string; now?: Date }
const run = (o: Over = {}) => {
  const rows = o.rows ?? [row('r1')];
  return evaluateBreakpoint({
    now: o.now ?? NOW, standard: o.standard ?? 'CLSI',
    sets: o.sets ?? [set()], rows, bands: o.bands ?? rows.flatMap((r) => threeBands(r.id)),
    request: {
      antibiotic_code: 'synthetic_abx_1', method: o.method ?? 'mic', qualifier_code: o.qualifier_code ?? null,
      parsed: parsed(o.value ?? '3', o.method ?? 'mic'),
      organism_code: o.organism_code ?? 'synthetic_org_a', organism_group_code: 'organism_group_code' in o ? o.organism_group_code : 'synthetic_grp_x',
      specimen_site_code: o.site ?? null,
    },
  });
};
const cat = (r: ReturnType<typeof run>) => (typeof r.suggestion === 'object' ? r.suggestion.category_code : r);

describe('golden table: exact values on S (-inf,2] | I (2,4] | R (4,+inf)', () => {
  it.each([
    ['0.5', 'synthetic_s'], ['2', 'synthetic_s'], // upper inclusive
    ['2.000001', 'synthetic_i'], ['3', 'synthetic_i'], ['4', 'synthetic_i'], // lower exclusive / upper inclusive
    ['4.000001', 'synthetic_r'], ['64', 'synthetic_r'], // open upper band
    ['0', 'synthetic_s'], // open lower band
  ])('mic = %s -> %s', (v, c) => expect(cat(run({ value: v }))).toBe(c));

  it('output carries standard, set version, set id and band id', () => {
    expect(run({ value: '3' })).toEqual({ suggestion: {
      category_code: 'synthetic_i', standard: 'CLSI', standard_version: 'synthetic_v1', breakpoint_set_id: 'set_1', breakpoint_band_id: 'r1_i' } });
  });
  it('zone_diameter uses the zone rows, not the mic rows', () => {
    const rows = [row('r1'), row('rz', { method: 'zone_diameter' })];
    const bands = [...threeBands('r1'), band('rz_a', 'rz', 'synthetic_z', '10', null)];
    expect(cat(run({ rows, bands, method: 'zone_diameter', value: '12' }))).toBe('synthetic_z');
  });
  it('compares exactly: 6-decimal difference is not lost (no IEEE floats)', () => {
    const bands = [band('b1', 'r1', 'synthetic_s', '0', '0.3', true, true), band('b2', 'r1', 'synthetic_r', '0.3', null, false, true)];
    expect(cat(run({ bands, value: '0.3' }))).toBe('synthetic_s');
    expect(cat(run({ bands, value: '0.300001' }))).toBe('synthetic_r');
  });
});

describe('inclusive / exclusive edges', () => {
  it('exclusive upper bound excludes the boundary value, inclusive lower of next includes it', () => {
    const bands = [band('b1', 'r1', 'synthetic_s', null, '2', true, false), band('b2', 'r1', 'synthetic_r', '2', null, true, true)];
    expect(cat(run({ bands, value: '2' }))).toBe('synthetic_r');
    expect(cat(run({ bands, value: '1.999999' }))).toBe('synthetic_s');
  });
  it('both bounds exclusive on the touching point -> indeterminate (value in no band)', () => {
    const bands = [band('b1', 'r1', 'synthetic_s', null, '2', true, false), band('b2', 'r1', 'synthetic_r', '2', null, false, true)];
    expect(run({ bands, value: '2' })).toEqual({ suggestion: 'none', reason: 'indeterminate' });
  });
});

describe('AC-07.3 gaps and qualifier spanning -> suggestion none / indeterminate', () => {
  const none = { suggestion: 'none', reason: 'indeterminate' };
  it('value inside a gap between bands', () => {
    expect(run({ bands: gapBands('r1'), value: '1.5' })).toEqual(none);
    expect(run({ bands: gapBands('r1'), value: '2' })).toEqual(none); // lower bound exclusive
  });
  it('value above/below every bounded band', () => {
    const bands = [band('b1', 'r1', 'synthetic_s', '1', '4')];
    expect(run({ bands, value: '0.5' })).toEqual(none);
    expect(run({ bands, value: '8' })).toEqual(none);
  });
  it('"<=4" when the lowest band has a lower bound (interval [0,4] not contained)', () => {
    const bands = [band('b1', 'r1', 'synthetic_s', '0.5', '4'), band('b2', 'r1', 'synthetic_r', '4', null, false, true)];
    expect(run({ bands, value: '<=4' })).toEqual(none);
  });
  it.each(['<=4', '>=3'])('qualifier %s spans bands on S|I|R', (v) => expect(run({ value: v })).toEqual(none));
  it('"<=2" fits S only', () => expect(cat(run({ value: '<=2' }))).toBe('synthetic_s'));
  it('qualifier fully inside one band is a suggestion; boundary inclusivity decides', () => {
    expect(cat(run({ value: '<2' }))).toBe('synthetic_s'); // [0,2) in (-inf,2]
    expect(cat(run({ value: '>4' }))).toBe('synthetic_r'); // (4,inf) in (4,inf)
    expect(run({ value: '>=4' })).toEqual(none); // [4,inf) spans I and R
    expect(cat(run({ value: '>=5' }))).toBe('synthetic_r');
    expect(cat(run({ value: '=3' }))).toBe('synthetic_i');
  });
  it('"<=value" on a band whose lower bound is 0 inclusive is contained', () => {
    const bands = [band('b1', 'r1', 'synthetic_s', '0', '4'), band('b2', 'r1', 'synthetic_r', '4', null, false, true)];
    expect(cat(run({ bands, value: '<=4' }))).toBe('synthetic_s');
  });
  it('a row with no bands at all -> indeterminate', () => {
    expect(run({ bands: [], value: '3' })).toEqual(none);
  });
});

describe('reasons: no_active_set / no_row / value_invalid', () => {
  it('no set for the standard (other standard only)', () => {
    expect(run({ sets: [set({ standard: 'EUCAST' })] })).toEqual({ suggestion: 'none', reason: 'no_active_set' });
  });
  it('no sets at all', () => expect(run({ sets: [] })).toEqual({ suggestion: 'none', reason: 'no_active_set' }));
  it.each(['uploaded', 'validating', 'validated', 'invalid', 'discarded'])('status %s is never used', (status) => {
    expect(run({ sets: [set({ status })] })).toEqual({ suggestion: 'none', reason: 'no_active_set' });
  });
  it('retired set still answers inside its effective period (AC-07.6 lookup)', () => {
    const s = set({ status: 'retired', effective_to: new Date('2030-12-31T00:00:00Z') });
    expect(cat(run({ sets: [s] }))).toBe('synthetic_i');
  });
  it('effective_from inclusive, effective_to exclusive, future set unused', () => {
    expect(cat(run({ sets: [set({ effective_from: NOW })] }))).toBe('synthetic_i');
    expect(run({ sets: [set({ effective_to: NOW })] })).toEqual({ suggestion: 'none', reason: 'no_active_set' });
    expect(run({ sets: [set({ effective_from: new Date(NOW.getTime() + 1) })] })).toEqual({ suggestion: 'none', reason: 'no_active_set' });
  });
  it('rows of another set / antibiotic / method -> no_row', () => {
    expect(run({ rows: [row('r1', { set_id: 'other_set' })] })).toEqual({ suggestion: 'none', reason: 'no_row' });
    expect(run({ rows: [row('r1', { antibiotic_code: 'synthetic_abx_2' })] })).toEqual({ suggestion: 'none', reason: 'no_row' });
    expect(run({ rows: [row('r1', { method: 'zone_diameter' })] })).toEqual({ suggestion: 'none', reason: 'no_row' });
  });
  it('organism-scope row for another organism / group row for another group -> no_row', () => {
    expect(run({ rows: [row('r1', { organism_scope: 'organism', organism_code: 'synthetic_org_z' })] })).toEqual({ suggestion: 'none', reason: 'no_row' });
    expect(run({ rows: [row('r1', { organism_scope: 'group', organism_code: 'synthetic_grp_z' })] })).toEqual({ suggestion: 'none', reason: 'no_row' });
  });
  it('request without a numeric (method other) -> value_invalid', () => {
    const r = evaluateBreakpoint({
      now: NOW, standard: 'CLSI', sets: [set()], rows: [row('r1')], bands: threeBands('r1'),
      request: { antibiotic_code: 'synthetic_abx_1', method: 'other', parsed: parsed('pos', 'other'), organism_code: 'synthetic_org_a',
        organism_group_code: null, specimen_site_code: null },
    });
    expect(r).toEqual({ suggestion: 'none', reason: 'value_invalid' });
  });
});

describe('qualifier_code on rows (02-TRD §4.5 step 2)', () => {
  it('row with a qualifier never matches a request without one', () => {
    expect(run({ rows: [row('r1', { qualifier_code: 'synthetic_q' })] })).toEqual({ suggestion: 'none', reason: 'no_row' });
  });
  it('request qualifier must equal the row qualifier; plain row does not match a qualified request', () => {
    expect(cat(run({ rows: [row('r1', { qualifier_code: 'synthetic_q' })], qualifier_code: 'synthetic_q' }))).toBe('synthetic_i');
    expect(run({ rows: [row('r1')], qualifier_code: 'synthetic_q' })).toEqual({ suggestion: 'none', reason: 'no_row' });
    expect(run({ rows: [row('r1', { qualifier_code: 'synthetic_q' })], qualifier_code: 'synthetic_other' })).toEqual({ suggestion: 'none', reason: 'no_row' });
  });
});

describe('AC-07.2 precedence: organism > group > any; then site-specific > site-less', () => {
  // each candidate row has a distinct single band whose category names the row, so the winner is visible.
  const cand = (id: string, over: Partial<SynRow>) => ({ row: row(id, over), band: band(`${id}_b`, id, `synthetic_${id}`, '0', null) });
  const pick = (cs: ReturnType<typeof cand>[], o: Over = {}) =>
    cat(run({ rows: cs.map((c) => c.row), bands: cs.map((c) => c.band), value: '1', ...o }));
  const org = { organism_scope: 'organism', organism_code: 'synthetic_org_a' } as const;
  const grp = { organism_scope: 'group', organism_code: 'synthetic_grp_x' } as const;

  it('level 1: organism row beats group and any', () => {
    expect(pick([cand('any', {}), cand('grp', grp), cand('org', org)])).toBe('synthetic_org');
  });
  it('level 2: group row beats any', () => {
    expect(pick([cand('any', {}), cand('grp', grp)])).toBe('synthetic_grp');
  });
  it('level 3: any row used when nothing more specific matches', () => {
    expect(pick([cand('any', {}), cand('orgz', { organism_scope: 'organism', organism_code: 'synthetic_org_z' })])).toBe('synthetic_any');
  });
  it('site-specific beats site-less within the same rank (each rank)', () => {
    const site = { specimen_site_code: 'synthetic_site_1' };
    expect(pick([cand('org0', org), cand('org1', { ...org, ...site })], { site: 'synthetic_site_1' })).toBe('synthetic_org1');
    expect(pick([cand('grp0', grp), cand('grp1', { ...grp, ...site })], { site: 'synthetic_site_1' })).toBe('synthetic_grp1');
    expect(pick([cand('any0', {}), cand('any1', site)], { site: 'synthetic_site_1' })).toBe('synthetic_any1');
  });
  it('rank outranks site: organism site-less beats group site-specific', () => {
    expect(pick([cand('org0', org), cand('grp1', { ...grp, specimen_site_code: 'synthetic_site_1' })], { site: 'synthetic_site_1' })).toBe('synthetic_org0');
  });
  it('row with a different non-NULL site is excluded; site-less row still matches', () => {
    const other = { specimen_site_code: 'synthetic_site_2' };
    expect(pick([cand('org2', { ...org, ...other })], { site: 'synthetic_site_1' })).toEqual({ suggestion: 'none', reason: 'no_row' });
    expect(pick([cand('org2', { ...org, ...other }), cand('any0', {})], { site: 'synthetic_site_1' })).toBe('synthetic_any0');
  });
  it('culture without a site never matches a site-specific row', () => {
    expect(pick([cand('org1', { ...org, specimen_site_code: 'synthetic_site_1' }), cand('any0', {})], { site: null })).toBe('synthetic_any0');
  });
  it('request organism_group_code null never matches a group row', () => {
    expect(pick([cand('grp', grp), cand('any', {})], { organism_group_code: null })).toBe('synthetic_any');
  });
  it('winning row decides: a more specific row with a gap is NOT skipped for a less specific row', () => {
    const bands = [...gapBands('ro'), ...threeBands('ra')];
    const rows = [row('ro', org), row('ra')];
    expect(run({ rows, bands, value: '1.5' })).toEqual({ suggestion: 'none', reason: 'indeterminate' });
  });
});

describe('purity', () => {
  it('does not mutate its inputs', () => {
    const rows = [row('r1')]; const bands = threeBands('r1'); const sets = [set()];
    const snap = JSON.stringify({ rows, bands, sets });
    run({ rows, bands, sets });
    expect(JSON.stringify({ rows, bands, sets })).toBe(snap);
  });
});
