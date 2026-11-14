// Discounts (03-APP-FLOW §2.2 step 6; US-FD-06.1-06.3, 07.1). Integer paisa; bigint intermediates. Pure.
import { allocate as allocateMoney, money, percentOf } from '../../../../../../packages/shared-ts/src/money/index.js';
import { LimsError } from '../../../core/errors.js';

export type Discount =
  | { readonly scope?: 'bill' | 'line'; readonly lineId?: string; readonly kind: 'percent'; readonly percentBp: number; readonly reasonCode?: string }
  | { readonly scope?: 'bill' | 'line'; readonly lineId?: string; readonly kind: 'amount'; readonly amountPaisa: number; readonly reasonCode?: string };
export type LimitResult = 'within_limit' | 'approval_required' | 'exceeds_limit';

const invalid = (detail: string): LimsError => new LimsError('common.validation_failed', detail);
const exceeds = (): LimsError => new LimsError('frontdesk.discount_exceeds_limit');
const isPaisa = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;

/** Largest remainder over line gross; ties -> lowest index; never more than a line's gross. */
export function allocate(totalPaisa: number, lineGrossPaisa: readonly number[]): number[] {
  if (!isPaisa(totalPaisa) || !lineGrossPaisa.every(isPaisa)) throw invalid('amounts must be integer paisa >= 0');
  const gross = lineGrossPaisa.reduce((a, b) => a + BigInt(b), 0n);
  if (BigInt(totalPaisa) > gross) throw exceeds();
  if (totalPaisa === 0) return lineGrossPaisa.map(() => 0);
  return allocateMoney(money(totalPaisa), lineGrossPaisa).map((m) => m.amountPaisa);
}

/** Mirrors discounts__kind__ck: percent 1..10000 bp (half-up, 02-CV), amount > 0. */
export function computeDiscountPaisa(d: Discount, grossPaisa: number): number {
  if (!isPaisa(grossPaisa)) throw invalid('gross must be integer paisa >= 0');
  if (d.kind === 'percent') {
    if (!Number.isInteger(d.percentBp) || d.percentBp < 1 || d.percentBp > 10000) throw invalid('percentBp must be 1..10000');
    return percentOf(money(grossPaisa), d.percentBp).amountPaisa;
  }
  if (d.kind === 'amount' && Number.isSafeInteger(d.amountPaisa) && d.amountPaisa > 0) return d.amountPaisa;
  throw invalid('invalid discount');
}

export function evaluateLimit(x: {
  grossPaisa: number; discountPaisa: number; selfLimitBp: number; selfLimitPaisa: number; absoluteMaxBp: number;
}): LimitResult {
  const g = BigInt(x.grossPaisa), d = BigInt(x.discountPaisa);
  if (d === 0n) return 'within_limit';
  if (d > g || d * 10000n > BigInt(x.absoluteMaxBp) * g) return 'exceeds_limit';
  const withinBp = d * 10000n <= BigInt(x.selfLimitBp) * g;
  const withinPaisa = x.selfLimitPaisa === 0 || d <= BigInt(x.selfLimitPaisa);
  return withinBp && withinPaisa ? 'within_limit' : 'approval_required';
}

/**
 * computed[i] = paisa of discounts[i]; perLine = total discount per line.
 * [CONV] bill percent is of total gross; it is capped by and allocated over what line discounts leave.
 */
export function resolveDiscounts(lines: ReadonlyArray<{ id: string; grossPaisa: number }>, discounts: readonly Discount[]): {
  computed: number[]; perLine: Record<string, number>;
} {
  const idx = new Map(lines.map((l, i) => [l.id, i]));
  const taken = lines.map(() => 0);
  const computed: number[] = [];
  const bills: Array<[number, number]> = []; // [discount index, paisa]
  const gross = lines.reduce((a, l) => a + l.grossPaisa, 0);
  discounts.forEach((d, k) => {
    if (d.scope === 'line') {
      const i = d.lineId === undefined ? undefined : idx.get(d.lineId);
      if (i === undefined) throw invalid('unknown lineId');
      const v = computeDiscountPaisa(d, lines[i]!.grossPaisa);
      if (taken[i]! + v > lines[i]!.grossPaisa) throw exceeds();
      taken[i]! += v;
      computed[k] = v;
    } else {
      const v = computeDiscountPaisa(d, gross);
      computed[k] = v;
      bills.push([k, v]);
    }
  });
  for (const [, v] of bills) {
    const left = lines.map((l, i) => l.grossPaisa - taken[i]!);
    allocate(v, left).forEach((p, i) => { taken[i]! += p; });
  }
  return { computed, perLine: Object.fromEntries(lines.map((l, i) => [l.id, taken[i]!])) };
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** Same discounts JSON, object key order ignored (approval binding, US-FD-07.5). */
export const sameDiscounts = (a: readonly Discount[], b: readonly Discount[]): boolean => canonical(a) === canonical(b);
