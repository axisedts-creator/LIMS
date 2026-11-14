import { canReadCost, forbidden, isCostKey, type Row } from './_dto.js';

/** #92. cost_per_test is money-only (PRD AC-21.9): auth.forbidden without inventory.cost.read. Every other report loses its † columns
 *  (is_cost, or a cost-named key) and those keys in rows and totals. ponytail: rows are stripped, not allowlisted per report; the report service owns the row shape. */
export function toReportResultDto(result: Row, permissions: readonly string[]): Row {
  if (canReadCost(permissions)) return result;
  if (result['report_code'] === 'cost_per_test') return forbidden();
  const columns = ((result['columns'] ?? []) as Row[]).filter((c) => c['is_cost'] !== true && !isCostKey(c['key']));
  const dropped = new Set(((result['columns'] ?? []) as Row[]).filter((c) => c['is_cost'] === true || isCostKey(c['key'])).map((c) => c['key'] as string));
  const strip = (v: any): any => {
    if (Array.isArray(v)) return v.map(strip);
    if (v === null || typeof v !== 'object') return v;
    return Object.fromEntries(Object.entries(v).filter(([k]) => !isCostKey(k) && !dropped.has(k)).map(([k, x]) => [k, strip(x)]));
  };
  return { ...result, columns, rows: strip(result['rows'] ?? []), totals: strip(result['totals'] ?? {}) };
}
