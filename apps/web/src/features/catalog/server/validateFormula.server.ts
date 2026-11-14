import 'server-only';
// #36 validateFormula: a read-only POST (no Idempotency-Key, no If-Match). An invalid formula is a 200 valid:false, not an error.
import { serverFetch } from '@/core/api/server-fetch';
import { badRequest, json } from './guard';
import { UUID_RE, type FormulaInput, type FormulaValidation } from './types';

export async function validateFormula(input: FormulaInput): Promise<FormulaValidation> {
  const { analyte_id, expression, sample_inputs, sample_context } = input;
  if (typeof expression !== 'string' || expression.length < 1 || expression.length > 500) throw badRequest();
  if (analyte_id !== undefined && !UUID_RE.test(analyte_id)) throw badRequest();
  return serverFetch<FormulaValidation>('/v1/catalog/formulas/validate', {
    method: 'POST',
    headers: json(),
    body: JSON.stringify({ ...(analyte_id ? { analyte_id } : {}), expression, ...(sample_inputs ? { sample_inputs } : {}), ...(sample_context ? { sample_context } : {}) }),
  });
}
