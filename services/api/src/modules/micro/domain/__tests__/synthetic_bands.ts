// C10 T-04 — SYNTHETIC breakpoint fixtures. NOT CLINICAL. Made-up codes/values only (07-SECURITY S-14, AC-07.7).
// Filename starts with `synthetic_` so it sits inside the CI allowlist `**/__tests__/**/synthetic_*`.
export const NOTE = 'NOT CLINICAL';

export const NOW = new Date('2030-06-01T00:00:00Z');

export interface SynSet { id: string; standard: string; standard_version: string; status: string; effective_from: Date; effective_to: Date | null }
export interface SynRow {
  id: string; set_id: string; organism_scope: 'organism' | 'group' | 'any'; organism_code: string | null;
  antibiotic_code: string; method: 'mic' | 'zone_diameter'; specimen_site_code: string | null; qualifier_code: string | null;
}
export interface SynBand {
  id: string; row_id: string; category_code: string; note: string;
  lower_value: string | null; lower_inclusive: boolean; upper_value: string | null; upper_inclusive: boolean;
}

export const set = (over: Partial<SynSet> = {}): SynSet => ({
  id: 'set_1', standard: 'CLSI', standard_version: 'synthetic_v1', status: 'active',
  effective_from: new Date('2030-01-01T00:00:00Z'), effective_to: null, ...over,
});

export const row = (id: string, over: Partial<SynRow> = {}): SynRow => ({
  id, set_id: 'set_1', organism_scope: 'any', organism_code: null, antibiotic_code: 'synthetic_abx_1',
  method: 'mic', specimen_site_code: null, qualifier_code: null, ...over,
});

// band(id,row,category, lower, upper, flags). Bound strings; null = unbounded.
export const band = (
  id: string, row_id: string, category_code: string,
  lower: string | null, upper: string | null, lower_inclusive = true, upper_inclusive = true,
): SynBand => ({ id, row_id, category_code, note: NOTE, lower_value: lower, lower_inclusive, upper_value: upper, upper_inclusive });

// Standard three-band layout on row `r`: S (-inf,2] | I (2,4] | R (4,+inf)   [synthetic]
export const threeBands = (r: string): SynBand[] => [
  band(`${r}_s`, r, 'synthetic_s', null, '2'),
  band(`${r}_i`, r, 'synthetic_i', '2', '4', false, true),
  band(`${r}_r`, r, 'synthetic_r', '4', null, false, true),
];

// Gap layout: S [0,1] | R (2,+inf)  — values in (1,2] are in no band.   [synthetic]
export const gapBands = (r: string): SynBand[] => [
  band(`${r}_s`, r, 'synthetic_s', '0', '1'),
  band(`${r}_r`, r, 'synthetic_r', '2', null, false, true),
];
