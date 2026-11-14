// Urgent-surcharge domain rules (02-TRD §7.5; PRD AC-14.1–14.4; 02-CV §4.9 integer paisa, no floats).
// Rank = specificity (orderable 3 > department 2 > all 1), then list-scoped (price_list_id = winning list) over unscoped. Windows are half-open [from, to) (same as §7.6a).
type D = Date | string;
export interface SurchargeAmount { amount_kind: string; amount_paisa?: number | string | null; percent_bp?: number | null }
export interface Window { effective_from: D; effective_to?: D | null }
interface PickRule extends Window {
  scope: string; department_id?: string | null; orderable_id?: string | null; price_list_id?: string | null; is_active?: boolean;
}

const t = (v: D): number => new Date(v).getTime();
const SPECIFICITY: Record<string, number> = { orderable: 3, department: 2, all: 1 };

/** flat -> amount_paisa; percent -> round_half_up(unit x bp / 10000), BigInt-exact. Invalid input throws (never NaN / a silent 0). */
export function surchargeAmountPaisa(rule: SurchargeAmount, unitPricePaisa: number): number {
  if (!Number.isSafeInteger(unitPricePaisa) || unitPricePaisa < 0) throw new RangeError('unit price must be a non-negative integer');
  if (rule.amount_kind === 'flat') {
    const n = Number(rule.amount_paisa);
    if (rule.amount_paisa == null || !Number.isSafeInteger(n) || n < 1) throw new RangeError('flat surcharge needs amount_paisa >= 1');
    return n;
  }
  if (rule.amount_kind === 'percent') {
    const bp = rule.percent_bp;
    if (typeof bp !== 'number' || !Number.isInteger(bp) || bp < 1 || bp > 100_000) throw new RangeError('percent surcharge needs percent_bp 1..100000');
    return Number((BigInt(unitPricePaisa) * BigInt(bp) + 5000n) / 10000n);
  }
  throw new RangeError('unknown amount_kind');
}

/** The most specific effective, active rule; undefined when none applies (AC-14.4). Pure: does not mutate `rules`. */
export function pickSurchargeRule<R extends PickRule>(rules: readonly R[], q: { orderableId: string; departmentId?: string | null; priceListId?: string | null; at: D }): R | undefined {
  const at = t(q.at);
  let best: R | undefined; let bestRank = -1;
  for (const r of rules) {
    if (r.is_active === false || t(r.effective_from) > at || (r.effective_to != null && at >= t(r.effective_to))) continue;
    if (r.scope === 'orderable' ? r.orderable_id !== q.orderableId : r.scope === 'department' ? q.departmentId == null || r.department_id !== q.departmentId : r.scope !== 'all') continue;
    if (r.price_list_id != null && r.price_list_id !== q.priceListId) continue;
    const rank = (SPECIFICITY[r.scope] ?? 0) * 2 + (r.price_list_id != null ? 1 : 0);
    if (rank > bestRank) { best = r; bestRank = rank; }
  }
  return best;
}

/** Half-open [from, to) windows overlap; a null `effective_to` is open-ended. */
export function windowsOverlap(a: Window, b: Window): boolean {
  const aEnd = a.effective_to == null ? Infinity : t(a.effective_to);
  const bEnd = b.effective_to == null ? Infinity : t(b.effective_to);
  return t(a.effective_from) < bEnd && t(b.effective_from) < aEnd;
}
