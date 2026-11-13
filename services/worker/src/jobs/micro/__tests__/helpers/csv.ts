// C10 T-12 shared fixtures (synthetic only: codes `syn_*`, every band note "NOT CLINICAL" — 07-SECURITY S-14). No real breakpoint data.
export const HEADER = 'organism_scope,organism_code,antibiotic_code,method,specimen_site_code,qualifier_code,category_code,lower_value,lower_inclusive,upper_value,upper_inclusive,note';
export const NOTE = 'NOT CLINICAL';
/** Every issue code of 02-TRD §9.1 (the done_when: each has a fixture). */
export const ALL_CODES = [
  'file.encoding_invalid', 'file.header_mismatch', 'file.empty', 'file.too_many_rows', 'file.parse_timeout', 'file.quote_unbalanced', 'file.processing_failed',
  'row.column_count', 'row.scope_invalid', 'row.organism_unknown', 'row.group_unknown', 'row.antibiotic_unknown', 'row.method_invalid', 'row.site_unknown',
  'row.qualifier_invalid', 'row.category_invalid', 'row.category_restricted', 'row.value_invalid', 'row.bounds_missing', 'row.bounds_order', 'row.bands_overlap',
  'row.too_many_bands', 'row.note_too_long', 'row.code_inactive', 'row.gap_between_bands', 'row.key_split',
] as const;
export const WARNING_CODES: readonly string[] = ['row.code_inactive', 'row.gap_between_bands', 'row.key_split'];
/** Need the tenant dictionaries / the set's standard / the job lifecycle -> covered by the job integration test; the rest by the pure file parser. */
export const JOB_CODES = ['file.processing_failed', 'row.organism_unknown', 'row.group_unknown', 'row.antibiotic_unknown', 'row.site_unknown', 'row.category_invalid', 'row.category_restricted', 'row.code_inactive'] as const;
export const PARSER_CODES = ALL_CODES.filter((c) => !(JOB_CODES as readonly string[]).includes(c));

type K = 'scope' | 'org' | 'abx' | 'method' | 'site' | 'qual' | 'cat' | 'lo' | 'loInc' | 'hi' | 'hiInc' | 'note';
/** One band line. Defaults: any-organism key for syn_abx_a/mic, category S, unbounded below, upper 2 inclusive. */
export function band(o: Partial<Record<K, string>> = {}): string {
  const v = { scope: 'any', org: '', abx: 'syn_abx_a', method: 'mic', site: '', qual: '', cat: 'S', lo: '', loInc: '', hi: '2', hiInc: 'true', note: NOTE, ...o };
  return [v.scope, v.org, v.abx, v.method, v.site, v.qual, v.cat, v.lo, v.loInc, v.hi, v.hiInc, v.note].join(',');
}
export const file = (...lines: string[]): string => HEADER + '\n' + lines.join('\n') + '\n';
export const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
/** `keys` distinct keys (qualifier q0..), 2 contiguous bands each -> 2*keys data lines, no issue possible. */
export function bigFile(keys: number): string {
  const out: string[] = [HEADER];
  for (let i = 0; i < keys; i++) {
    const q = 'q' + i;
    out.push(band({ qual: q, cat: 'S', hi: '2', hiInc: 'true' }), band({ qual: q, cat: 'R', lo: '2', loInc: 'false', hi: '', hiInc: '' }));
  }
  return out.join('\n') + '\n';
}
