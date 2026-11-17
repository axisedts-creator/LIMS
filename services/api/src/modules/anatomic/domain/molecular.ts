// C11 molecular result validation against the assay definition — 02-TRD §4.5.3 / §5.5, AC-11.2, AC-11.3. Pure.
// Paths are JSON Pointers into the result object; all errors are collected. Handler maps ok:false -> 400 common.validation_failed.
export interface AssayTarget {
  code: string;
  is_active: boolean;
  allows_quantitative: boolean;
  unit_code?: string;
  decimals?: number;
  result_values: { code: string; display: string; is_abnormal: boolean; is_active: boolean }[];
}
export interface AssayDefinition {
  code: string;
  is_active: boolean;
  targets: AssayTarget[];
}
export interface MolecularResultInput {
  assay_code: string;
  target_code: string;
  result_code: string;
  value_decimal?: string;
  unit_code?: string;
}
export type MolecularCheck = { ok: true } | { ok: false; errors: { path: string; message: string }[] };

const DECIMAL = /^-?[0-9]{1,12}(\.[0-9]{1,6})?$/;

export function validateMolecularResult(assay: AssayDefinition, r: MolecularResultInput): MolecularCheck {
  const errors: { path: string; message: string }[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });

  if (r.assay_code !== assay.code) err('/assay_code', 'does not match the assay');
  else if (!assay.is_active) err('/assay_code', 'assay is not active');

  const target = assay.targets.find((t) => t.code === r.target_code);
  if (!target) err('/target_code', 'unknown target for this assay');
  else if (!target.is_active) err('/target_code', 'target is not active');

  if (target?.is_active) {
    if (!target.result_values.some((v) => v.is_active && v.code === r.result_code)) {
      err('/result_code', 'not an active result value of this target');
    }
    if (r.value_decimal !== undefined) {
      if (!target.allows_quantitative) err('/value_decimal', 'target does not allow a quantitative value');
      else if (typeof r.value_decimal !== 'string' || !DECIMAL.test(r.value_decimal)) err('/value_decimal', 'must be a decimal string');
      else if (target.decimals !== undefined && (r.value_decimal.split('.')[1]?.length ?? 0) > target.decimals) {
        err('/value_decimal', `at most ${target.decimals} fraction digits`);
      }
    }
    if (r.unit_code !== undefined) {
      if (!target.allows_quantitative) err('/unit_code', 'target does not allow a quantitative value');
      else if (typeof r.unit_code !== 'string' || (target.unit_code !== undefined && r.unit_code !== target.unit_code)) {
        err('/unit_code', 'does not match the target unit');
      }
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}
