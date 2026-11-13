// AST category / standard / restriction validation (02-TRD §4.4). Pure: the catalog is an argument,
// no code list is hard-coded, so new codes and restrictions are data-only (AC-06.7).
export interface InterpretationCatalog {
  interpretations: readonly { standard: string; code: string; is_active: boolean }[];
  restrictions: readonly { standard: string; antibiotic_code: string; allowed_codes: readonly string[]; is_active: boolean }[];
}
export interface InterpretationEntry {
  category_code?: string | null;
  standard?: string | null;
  standard_version?: string | null;
  antibiotic_code: string;
  raw_value?: string | null;
}
export type InterpretationResult =
  | { ok: true }
  | { ok: false; code: 'micro.ast_standard_required' | 'micro.ast_category_not_allowed' | 'micro.ast_value_invalid' };

const fail = (code: Extract<InterpretationResult, { ok: false }>['code']): InterpretationResult => ({ ok: false, code });
const blank = (v: string | null | undefined) => v == null || v.trim() === '';

export function validateInterpretation(entry: InterpretationEntry, catalog: InterpretationCatalog): InterpretationResult {
  const { category_code: cat, standard, standard_version: version } = entry;
  // No category (null/undefined only): nothing to validate. '' is not a category and fails closed below.
  if (cat == null) return { ok: true };

  if (blank(entry.raw_value)) return fail('micro.ast_value_invalid'); // §4.4 step 0
  // standard ∈ {CLSI, EUCAST, ECOFF} — fixed enum (05-SCHEMA.md:186/302), not catalog data; 'unknown' is refused here.
  // standard_version is a string, char_length 1..32 (05-SCHEMA.md:187/898).
  if (!(standard === 'CLSI' || standard === 'EUCAST' || standard === 'ECOFF') || typeof version !== 'string' || [...version].length < 1 || [...version].length > 32) return fail('micro.ast_standard_required');

  const known = catalog.interpretations.some((r) => r.is_active && r.standard === standard && r.code === cat);
  if (!known) return fail('micro.ast_category_not_allowed');

  const restricted = catalog.restrictions.some(
    (r) => r.is_active && r.standard === standard && r.antibiotic_code === entry.antibiotic_code && !r.allowed_codes.includes(cat),
  );
  return restricted ? fail('micro.ast_category_not_allowed') : { ok: true };
}
