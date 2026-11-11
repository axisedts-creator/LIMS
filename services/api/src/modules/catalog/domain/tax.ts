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

// ---- getTaxRate (02-TRD §7.6a). Any failure is `catalog.tax_config_missing` (no rate can exist for such input).
const TAX_CODE = /^[A-Z0-9_]{1,16}$/;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const NPT_OFFSET_MS = (5 * 60 + 45) * 60_000;       // Asia/Kathmandu, UTC+05:45, no DST (08 A13 P-15) [CONV]

export const isTaxCode = (v: unknown): v is string => typeof v === 'string' && TAX_CODE.test(v);

/** Instant of 00:00 of the ISO date `on` in the tenant timezone (v1: Asia/Kathmandu only); undefined if `on` is not a real YYYY-MM-DD date. */
export function localMidnight(on: unknown): Date | undefined {
  const m = typeof on === 'string' ? ISO_DAY.exec(on) : null;
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const utc = new Date(Date.UTC(y, mo - 1, d));
  if (utc.getUTCFullYear() !== y || utc.getUTCMonth() !== mo - 1 || utc.getUTCDate() !== d) return undefined;
  return new Date(+utc - NPT_OFFSET_MS);
}

/** taxable -> the global VAT row's rate; exempt -> undefined. */
export function vatRateBp(treatment: 'exempt' | 'taxable', globalVatRateBp: number): number | undefined {
  if (treatment === 'taxable') return globalVatRateBp;
  if (treatment === 'exempt') return undefined;
  throw new RangeError('unknown vat_treatment');
}
