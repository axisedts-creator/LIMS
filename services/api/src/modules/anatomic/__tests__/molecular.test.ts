// C11 T-03 — molecular result validation against the assay definition (02-TRD §4.5.3 / §5.5 Q1 / 05-SCHEMA §6; AC-11.2, AC-11.3). Pure.
// SEAM: ../domain/molecular.ts exports
//   type AssayDefinition = { code; is_active; targets: { code; is_active; allows_quantitative: boolean; unit_code?: string; decimals?: number;
//                            result_values: { code; display; is_abnormal; is_active }[] }[] }      (AssayInput shape, TRD §5.5)
//   type MolecularResultInput = { assay_code; target_code; result_code; value_decimal?; unit_code? }
//   validateMolecularResult(assay: AssayDefinition, r: MolecularResultInput):
//       { ok: true } | { ok: false; errors: { path: string; message: string }[] }
//     paths are JSON Pointers into the result object: `/assay_code` `/target_code` `/result_code` `/value_decimal` `/unit_code`;
//     all errors collected. Handler maps ok:false → `400 common.validation_failed` (AC-11.2) — not this module's job.
//   Rules: assay_code must equal assay.code and assay active; target exists + active; result_code ∈ the target's ACTIVE result_values;
//     value_decimal / unit_code only when target.allows_quantitative; value_decimal = DecimalString `^-?[0-9]{1,12}(\.[0-9]{1,6})?$`
//     with ≤ target.decimals fraction digits (when decimals set); unit_code (when given) must equal target.unit_code (when target has one).
// Fails now: ../domain/molecular.js does not exist.
import { describe, expect, it } from 'vitest';
import { validateMolecularResult as v } from '../domain/molecular.js';

const ASSAY = {
  code: 'SYNTH_PCR',
  is_active: true,
  targets: [
    {
      code: 'GENE_A',
      is_active: true,
      allows_quantitative: false,
      result_values: [
        { code: 'detected', display: 'Detected', is_abnormal: true, is_active: true },
        { code: 'not_detected', display: 'Not detected', is_abnormal: false, is_active: true },
        { code: 'retired_val', display: 'Old', is_abnormal: false, is_active: false },
      ],
    },
    {
      code: 'VIRAL_LOAD',
      is_active: true,
      allows_quantitative: true,
      unit_code: 'copies_per_ml',
      decimals: 2,
      result_values: [{ code: 'quantified', display: 'Quantified', is_abnormal: false, is_active: true }],
    },
    { code: 'OLD_T', is_active: false, allows_quantitative: false, result_values: [{ code: 'detected', display: 'D', is_abnormal: true, is_active: true }] },
  ],
};
const base = { assay_code: 'SYNTH_PCR', target_code: 'GENE_A', result_code: 'detected' };
const paths = (r: ReturnType<typeof v>) => (r.ok ? [] : r.errors.map((e) => e.path));

describe('C11 molecular — result code (AC-11.2)', () => {
  it('accepts a code in the target result set', () => expect(v(ASSAY, base)).toEqual({ ok: true }));
  it('rejects a code not in the set → /result_code', () => {
    expect(paths(v(ASSAY, { ...base, result_code: 'positive' }))).toEqual(['/result_code']);
  });
  it('rejects a code from ANOTHER target of the same assay', () => {
    expect(paths(v(ASSAY, { ...base, result_code: 'quantified' }))).toEqual(['/result_code']);
  });
  it('rejects an inactive result value', () => {
    expect(paths(v(ASSAY, { ...base, result_code: 'retired_val' }))).toEqual(['/result_code']);
  });
  it('code match is exact (case / whitespace)', () => {
    expect(paths(v(ASSAY, { ...base, result_code: 'Detected' }))).toEqual(['/result_code']);
    expect(paths(v(ASSAY, { ...base, result_code: 'detected ' }))).toEqual(['/result_code']);
    expect(paths(v(ASSAY, { ...base, result_code: '' }))).toEqual(['/result_code']);
  });
});

describe('C11 molecular — assay / target binding', () => {
  it('unknown target → /target_code', () => {
    expect(paths(v(ASSAY, { ...base, target_code: 'NOPE' }))).toContain('/target_code');
  });
  it('inactive target → /target_code', () => {
    expect(paths(v(ASSAY, { ...base, target_code: 'OLD_T' }))).toEqual(['/target_code']);
  });
  it('assay code mismatch → /assay_code', () => {
    expect(paths(v(ASSAY, { ...base, assay_code: 'OTHER' }))).toEqual(['/assay_code']);
  });
  it('inactive assay → /assay_code', () => {
    expect(paths(v({ ...ASSAY, is_active: false }, base))).toEqual(['/assay_code']);
  });
  it('collects every error, not just the first', () => {
    expect(paths(v(ASSAY, { ...base, result_code: 'x', value_decimal: '1' }))).toEqual(['/result_code', '/value_decimal']);
  });
});

describe('C11 molecular — quantitative values (AC-11.3)', () => {
  const q = { assay_code: 'SYNTH_PCR', target_code: 'VIRAL_LOAD', result_code: 'quantified' };

  it('allows_quantitative target: "1250" + copies_per_ml is accepted', () => {
    expect(v(ASSAY, { ...q, value_decimal: '1250', unit_code: 'copies_per_ml' })).toEqual({ ok: true });
  });
  it('value is optional even on a quantitative target', () => expect(v(ASSAY, q)).toEqual({ ok: true }));

  it('non-decimal values are rejected → /value_decimal', () => {
    for (const bad of ['12a', '1,250', '', ' 1250', '1250 ', '1e3', '.5', '5.', '--1', '+1', 'NaN', 'Infinity', '1_000', '0x10', '١٢٣', '1234567890123', '1.1234567']) {
      expect(paths(v(ASSAY, { ...q, value_decimal: bad })), JSON.stringify(bad)).toEqual(['/value_decimal']);
    }
  });
  it('non-string value (number) is rejected — results travel as text decimals', () => {
    expect(paths(v(ASSAY, { ...q, value_decimal: 1250 as unknown as string }))).toEqual(['/value_decimal']);
  });
  it('accepts negative and zero DecimalStrings within decimals', () => {
    expect(v(ASSAY, { ...q, value_decimal: '0' })).toEqual({ ok: true });
    expect(v(ASSAY, { ...q, value_decimal: '-3.5' })).toEqual({ ok: true });
  });
  it('more fraction digits than target.decimals → /value_decimal', () => {
    expect(paths(v(ASSAY, { ...q, value_decimal: '12.345' }))).toEqual(['/value_decimal']);
    expect(v(ASSAY, { ...q, value_decimal: '12.34' })).toEqual({ ok: true });
    expect(v(ASSAY, { ...q, value_decimal: '12.3' })).toEqual({ ok: true });
  });
  it('unit_code differing from target.unit_code → /unit_code', () => {
    expect(paths(v(ASSAY, { ...q, value_decimal: '1', unit_code: 'iu_per_ml' }))).toEqual(['/unit_code']);
  });
  it('target without decimals set: any ≤6 fraction digits ok', () => {
    const a = { ...ASSAY, targets: [{ ...ASSAY.targets[1], decimals: undefined }] };
    expect(v(a, { ...q, value_decimal: '1.123456' })).toEqual({ ok: true });
  });

  it('non-quantitative target rejects value_decimal and unit_code', () => {
    expect(paths(v(ASSAY, { ...base, value_decimal: '1250' }))).toEqual(['/value_decimal']);
    expect(paths(v(ASSAY, { ...base, unit_code: 'copies_per_ml' }))).toEqual(['/unit_code']);
  });
});
