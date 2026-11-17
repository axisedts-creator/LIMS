// Delta check (02-TRD §4.3 step 5; AC-12.1, AC-12.2). Exact decimal arithmetic via bigint; no float.
import { DECIMAL_RE, fractionDigits, scaleDecimal } from './flags.js';

export interface DeltaRule { ruleId: string; ruleVersion: number; windowSeconds: number; absThreshold?: string; pctThreshold?: string }
export interface DeltaCandidate { resultId: string; value: string; unitCode?: string; approvedAt: Date }
export interface DeltaOutcome {
  status: 'no_rule' | 'no_previous' | 'pass' | 'fail';
  ruleId?: string; ruleVersion?: number;
  previousResultId?: string; previousValue?: string; previousApprovedAt?: Date; abs?: string; pct?: string;
}

const PCT_SCALE = 6;
function fmt(n: bigint, scale: number): string {
  const s = (n < 0n ? -n : n).toString().padStart(scale + 1, '0');
  return (n < 0n ? '-' : '') + (scale ? `${s.slice(0, -scale)}.${s.slice(-scale)}` : s);
}

export function evaluateDelta(i: { value: string; unitCode?: string | undefined; at: Date; rule?: DeltaRule | undefined; candidates: readonly DeltaCandidate[] }): DeltaOutcome {
  const { rule } = i;
  if (!rule) return { status: 'no_rule' };
  const echo = { ruleId: rule.ruleId, ruleVersion: rule.ruleVersion };
  const from = i.at.getTime() - rule.windowSeconds * 1000, to = i.at.getTime();
  let prev: DeltaCandidate | undefined;
  for (const c of i.candidates) {
    const t = c.approvedAt.getTime();
    if (c.unitCode !== i.unitCode || t < from || t > to || !DECIMAL_RE.test(c.value)) continue;
    if (!prev || t > prev.approvedAt.getTime()) prev = c;
  }
  if (!prev) return { status: 'no_previous', ...echo };

  const scale = Math.max(fractionDigits(i.value), fractionDigits(prev.value));
  const diff = scaleDecimal(i.value, scale) - scaleDecimal(prev.value, scale);
  const abs = diff < 0n ? -diff : diff;
  const base = scaleDecimal(prev.value, scale);
  const prevAbs = base < 0n ? -base : base;
  // prev = 0 -> pct undefined, pct threshold not applied.
  const pct = prevAbs === 0n ? undefined : (abs * 100n * 10n ** BigInt(PCT_SCALE)) / prevAbs;

  let fail = false;
  if (rule.absThreshold !== undefined) {
    const ts = Math.max(scale, fractionDigits(rule.absThreshold));
    fail ||= abs * 10n ** BigInt(ts - scale) > scaleDecimal(rule.absThreshold, ts);
  }
  if (rule.pctThreshold !== undefined && prevAbs !== 0n) {
    const ts = fractionDigits(rule.pctThreshold);
    fail ||= abs * 100n * 10n ** BigInt(ts) > scaleDecimal(rule.pctThreshold, ts) * prevAbs; // abs/|prev|*100 > T, cross-multiplied
  }
  return {
    status: fail ? 'fail' : 'pass', ...echo,
    previousResultId: prev.resultId, previousValue: prev.value, previousApprovedAt: prev.approvedAt,
    abs: fmt(abs, scale), ...(pct === undefined ? {} : { pct: fmt(pct, PCT_SCALE) }),
  };
}
