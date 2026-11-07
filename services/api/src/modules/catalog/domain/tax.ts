// Tax domain rules (02-TRD §7.6 / §7.6a; PRD AC-15.1–15.3; 08 R18). Rates come from rows (g_tax_types / cs_tax_types), never constants. Windows half-open [from, to).
type D = Date | string;
interface TaxRuleLike {
  scope: string; department_id?: string | null; orderable_id?: string | null; effective_from: D; effective_to?: D | null; is_active?: boolean;
}
const t = (v: D): number => new Date(v).getTime();
const effective = (r: { effective_from: D; effective_to?: D | null; is_active?: boolean }, at: number) =>
  r.is_active !== false && t(r.effective_from) <= at && (r.effective_to == null || at < t(r.effective_to));

/** orderable rule > department rule (only the orderable's own department; none for a panel without one) > tenant default; undefined = no answer (never an assumed "exempt"). */
export function pickTaxRule<R extends TaxRuleLike>(rules: readonly R[], q: { orderableId: string; departmentId?: string | null; at: D }): R | undefined {
  const at = t(q.at);
  const live = rules.filter((r) => effective(r, at));
  return live.find((r) => r.scope === 'orderable' && r.orderable_id === q.orderableId)
    ?? (q.departmentId == null ? undefined : live.find((r) => r.scope === 'department' && r.department_id === q.departmentId))
    ?? live.find((r) => r.scope === 'tenant_default');
}

/** The active version of `code` whose window contains `at` (exact code match). Its rate may be null (then not usable). */
export function taxTypeVersionAt<V extends { code: string; effective_from: D; effective_to?: D | null; is_active?: boolean }>(versions: readonly V[], code: string, at: D): V | undefined {
  const n = t(at);
  return versions.find((v) => v.code === code && effective(v, n));
}

/** AC-15.2: usable = exists, active, rate_bp not null (0 % is a configured rate). */
export function isTaxTypeUsable(v: { rate_bp?: number | null; is_active?: boolean } | undefined): boolean {
  return v !== undefined && v.is_active !== false && v.rate_bp != null;
}

/** taxable -> the global VAT row's rate; exempt -> undefined. */
export function vatRateBp(treatment: 'exempt' | 'taxable', globalVatRateBp: number): number | undefined {
  if (treatment === 'taxable') return globalVatRateBp;
  if (treatment === 'exempt') return undefined;
  throw new RangeError('unknown vat_treatment');
}
