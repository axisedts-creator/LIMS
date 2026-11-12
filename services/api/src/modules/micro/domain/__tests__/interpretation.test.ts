// C10 T-03 — pure domain: AST category/standard/restriction validation (02-TRD §4.4), AC-06.3, 06.4, 06.5, 06.7.
// Interface expected from the writer (SEAMS):
//   ../domain/interpretation.ts
//     export interface InterpretationCatalog {
//       interpretations: readonly { standard: string; code: string; is_active: boolean }[];                  // micro.g_cs_ast_interpretations
//       restrictions: readonly { standard: string; antibiotic_code: string; allowed_codes: readonly string[]; is_active: boolean }[]; // micro.g_ast_category_restrictions
//     }
//     export function validateInterpretation(
//       entry: { category_code?: string | null; standard?: string | null; standard_version?: string | null; antibiotic_code: string; raw_value?: string | null },
//       catalog: InterpretationCatalog,
//     ): { ok: true } | { ok: false, code: 'micro.ast_standard_required' | 'micro.ast_category_not_allowed' | 'micro.ast_value_invalid' };
//   Pure: the catalog is an argument (no DB, no hard-coded code list) so a new synthetic code works without a code change (AC-06.7).
import { describe, expect, it } from 'vitest';
import { validateInterpretation, type InterpretationCatalog } from '../interpretation.js';

// Seed per 05-SCHEMA §3 (04 D14).
const SEEDED: InterpretationCatalog['interpretations'] = [
  ...['S', 'SDD', 'I', 'I^', 'R', 'NS'].map((code) => ({ standard: 'CLSI', code, is_active: true })),
  ...['S', 'I', 'R'].map((code) => ({ standard: 'EUCAST', code, is_active: true })),
  ...['WT', 'NWT'].map((code) => ({ standard: 'ECOFF', code, is_active: true })),
];
const RESTRICTIONS: InterpretationCatalog['restrictions'] = [
  { standard: 'CLSI', antibiotic_code: 'colistin', allowed_codes: ['I', 'R'], is_active: true },
  { standard: 'CLSI', antibiotic_code: 'polymyxin_b', allowed_codes: ['I', 'R'], is_active: true },
];
const CAT: InterpretationCatalog = { interpretations: SEEDED, restrictions: RESTRICTIONS };
const entry = (o: Record<string, unknown>) => ({ antibiotic_code: 'ampicillin', raw_value: '<=0.25', standard: 'CLSI', standard_version: '2024', category_code: 'S', ...o }) as Parameters<typeof validateInterpretation>[0];
const NOT_ALLOWED = { ok: false, code: 'micro.ast_category_not_allowed' };

describe('AC-06.7 — every seeded code accepted (never a 3-value enum)', () => {
  it.each(SEEDED.map((r) => [r.standard, r.code] as const))('%s %s accepted', (standard, category_code) => {
    expect(validateInterpretation(entry({ standard, category_code }), CAT)).toEqual({ ok: true });
  });

  it('a newly seeded synthetic code is accepted with no code change', () => {
    const cat: InterpretationCatalog = { ...CAT, interpretations: [...SEEDED, { standard: 'CLSI', code: 'ZZ', is_active: true }, { standard: 'ECOFF', code: 'XQ^', is_active: true }] };
    expect(validateInterpretation(entry({ category_code: 'ZZ' }), cat)).toEqual({ ok: true });
    expect(validateInterpretation(entry({ standard: 'ECOFF', category_code: 'XQ^' }), cat)).toEqual({ ok: true });
    expect(validateInterpretation(entry({ category_code: 'ZZ' }), CAT)).toEqual(NOT_ALLOWED); // same code absent from the seed
  });

  it('an inactive code is refused', () => {
    const cat = { ...CAT, interpretations: SEEDED.map((r) => (r.standard === 'CLSI' && r.code === 'NS' ? { ...r, is_active: false } : r)) };
    expect(validateInterpretation(entry({ category_code: 'NS' }), cat)).toEqual(NOT_ALLOWED);
  });
});

describe('AC-06.3 — standard and standard_version required with a category', () => {
  it.each([
    ['no standard', { standard: undefined }],
    ['null standard', { standard: null }],
    ['empty standard', { standard: '' }],
    ['no version', { standard_version: undefined }],
    ['null version', { standard_version: null }],
    ['empty version', { standard_version: '' }],
  ])('%s → micro.ast_standard_required', (_n, o) => {
    expect(validateInterpretation(entry(o), CAT)).toEqual({ ok: false, code: 'micro.ast_standard_required' });
  });

  it.each(['', 'x'.repeat(33), 34])('standard_version %j (not a string of length 1..32) is refused', (v) => {
    expect(validateInterpretation(entry({ standard_version: v }), CAT)).toMatchObject({ ok: false });
  });
  it.each(['1', 'x'.repeat(32)])('standard_version %j (length bounds) accepted', (v) => {
    expect(validateInterpretation(entry({ standard_version: v }), CAT)).toEqual({ ok: true });
  });

  it.each(['WHO', 'clsi', 'unknown'])('standard %j is outside {CLSI,EUCAST,ECOFF} → micro.ast_standard_required', (standard) => {
    expect(validateInterpretation(entry({ standard }), CAT)).toEqual({ ok: false, code: 'micro.ast_standard_required' });
  });
});

describe('AC-06.5 — category must exist for the given standard; no cross-standard comparison', () => {
  it.each([
    ['EUCAST', 'SDD'], ['EUCAST', 'NS'], ['EUCAST', 'I^'], ['EUCAST', 'WT'],
    ['CLSI', 'WT'], ['CLSI', 'NWT'], ['ECOFF', 'S'], ['ECOFF', 'R'], ['CLSI', 'X'], ['CLSI', 's'], ['CLSI', ''],
  ])('%s %j → micro.ast_category_not_allowed', (standard, category_code) => {
    expect(validateInterpretation(entry({ standard, category_code }), CAT)).toEqual(NOT_ALLOWED);
  });

  it('same letter is checked against its own standard only', () => {
    // CLSI I is an active row; if only EUCAST I were seeded, CLSI I must not pass on EUCAST's row.
    const cat: InterpretationCatalog = { interpretations: [{ standard: 'EUCAST', code: 'I', is_active: true }], restrictions: [] };
    expect(validateInterpretation(entry({ standard: 'CLSI', category_code: 'I' }), cat)).toEqual(NOT_ALLOWED);
    expect(validateInterpretation(entry({ standard: 'EUCAST', category_code: 'I' }), cat)).toEqual({ ok: true });
  });
});

describe('AC-06.4 — seeded restriction: CLSI colistin / polymyxin B are I/R only', () => {
  it.each(['colistin', 'polymyxin_b'])('CLSI %s: S → micro.ast_category_not_allowed', (antibiotic_code) => {
    expect(validateInterpretation(entry({ antibiotic_code, category_code: 'S' }), CAT)).toEqual(NOT_ALLOWED);
  });
  it.each(['colistin', 'polymyxin_b'])('CLSI %s: SDD / NS / I^ refused (valid CLSI codes, not allowed)', (antibiotic_code) => {
    for (const category_code of ['SDD', 'NS', 'I^']) {
      expect(validateInterpretation(entry({ antibiotic_code, category_code }), CAT)).toEqual(NOT_ALLOWED);
    }
  });
  it.each(['colistin', 'polymyxin_b'])('CLSI %s: I and R accepted', (antibiotic_code) => {
    for (const category_code of ['I', 'R']) {
      expect(validateInterpretation(entry({ antibiotic_code, category_code }), CAT)).toEqual({ ok: true });
    }
  });
  it('restriction is per standard: EUCAST colistin S is not restricted by the CLSI row', () => {
    expect(validateInterpretation(entry({ standard: 'EUCAST', antibiotic_code: 'colistin', category_code: 'S' }), CAT)).toEqual({ ok: true });
  });
  it('other antibiotics are unrestricted', () => {
    expect(validateInterpretation(entry({ antibiotic_code: 'gentamicin', category_code: 'SDD' }), CAT)).toEqual({ ok: true });
  });
  it('an inactive restriction row is ignored', () => {
    const cat = { ...CAT, restrictions: RESTRICTIONS.map((r) => ({ ...r, is_active: false })) };
    expect(validateInterpretation(entry({ antibiotic_code: 'colistin', category_code: 'S' }), cat)).toEqual({ ok: true });
  });
  it('a restriction added as data applies without a code change', () => {
    const cat = { ...CAT, restrictions: [...RESTRICTIONS, { standard: 'CLSI', antibiotic_code: 'ampicillin', allowed_codes: ['R'], is_active: true }] };
    expect(validateInterpretation(entry({ category_code: 'S' }), cat)).toEqual(NOT_ALLOWED);
  });
});

describe('TRD §4.4 step 0 / AC-06.3a — a category requires a raw value', () => {
  it.each([undefined, null, '', '   '])('raw_value %j → micro.ast_value_invalid', (raw_value) => {
    expect(validateInterpretation(entry({ raw_value }), CAT)).toEqual({ ok: false, code: 'micro.ast_value_invalid' });
  });
});

describe('entries without a category', () => {
  it.each([undefined, null])('category %j: nothing to validate, even without standard/value', (category_code) => {
    expect(validateInterpretation(entry({ category_code, standard: undefined, standard_version: undefined, raw_value: undefined }), CAT)).toEqual({ ok: true });
  });
});

describe('purity', () => {
  it('does not mutate the catalog or the entry', () => {
    const cat = structuredClone(CAT);
    const e = entry({ antibiotic_code: 'colistin', category_code: 'S' });
    const before = structuredClone(e);
    validateInterpretation(e, cat);
    expect(cat).toEqual(CAT);
    expect(e).toEqual(before);
  });
});
