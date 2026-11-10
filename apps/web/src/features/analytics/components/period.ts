// Period presets resolved to A.D. calendar dates in Nepal time (UTC+05:45). B.S. month / fiscal-year presets are NOT offered:
// the API names no current B.S. month / fiscal year and the UI must not convert B.S.<->A.D. (CR: .orchestra/cr/AN-T19.md).
import type { PeriodPreset } from '@lims/ui/components/PeriodPicker';

export const PRESETS: readonly PeriodPreset[] = ['today', 'yesterday', 'this_ad_month', 'last_ad_month', 'custom'];

const NP_OFFSET_MS = (5 * 60 + 45) * 60_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
export const nepalToday = (now = Date.now()) => ymd(new Date(now + NP_OFFSET_MS));
export const addDays = (s: string, n: number) => {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
};
const month = (s: string, delta: number) => {
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  return { from: ymd(new Date(Date.UTC(y, m - 1 + delta, 1))), to: ymd(new Date(Date.UTC(y, m + delta, 0))) };
};

/** Inclusive from/to as shown in the picker. API periods are half-open [from, to) (01-PRD:246): callers send to + 1 day. */
export function presetRange(p: PeriodPreset, today: string): { from: string; to: string } | undefined {
  if (p === 'today') return { from: today, to: today };
  if (p === 'yesterday') return { from: addDays(today, -1), to: addDays(today, -1) };
  if (p === 'this_ad_month') return month(today, 0);
  if (p === 'last_ad_month') return month(today, -1);
  return undefined;
}

export function presetOf(from: string | undefined, to: string | undefined, today: string): PeriodPreset {
  if (!from || !to) return 'custom';
  const hit = PRESETS.find((p) => { const r = presetRange(p, today); return r?.from === from && r.to === to; });
  return hit ?? 'custom';
}
