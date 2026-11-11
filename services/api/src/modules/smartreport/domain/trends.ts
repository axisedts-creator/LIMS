// Trends: points + direction (02-TRD §4.8; AC-13.2 direction, AC-13.3 stable threshold, AC-13.4 unit mismatch, AC-13.5 no history).
// Pure: bigint micro-units (fixed.ts), no float, no I/O, inputs not mutated.
import type { DerangedSeverity } from './deranged.js';
import { toMicro } from './fixed.js';

const SEV_RANK: Readonly<Record<DerangedSeverity, number>> = { borderline: 0, out_of_range: 1, critical: 2 };
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const abs = (v: bigint) => (v < 0n ? -v : v);

export type TrendDirection = 'improved' | 'worsened' | 'stable';
export interface TrendCandidate {
  resultId: string;
  analyteId: string;
  analyteName: string;
  unitCode: string;
  valueNumeric?: string;
  approvedAt: string;
  trendEnabled: boolean;
  referenceRangeSnapshot: { low?: string; high?: string };
  derangedSeverity?: DerangedSeverity; // set = analyte has a deranged entry
  groupSortOrder: number;
  analyteSortOrder: number;
  trendStableBp?: number; // analyte_groups.trend_stable_bp override (05-SCHEMA §2.4)
}
export interface TrendHistoryPoint { source: string; resultId: string; approvedAt: string; valueNumeric?: string; unitCode?: string }
export interface TrendHistory { series: readonly { analyteId: string; points: readonly TrendHistoryPoint[] }[] }
export interface TrendPoint { resultId: string; approvedAt: string; valueNumeric: string }
export interface Trend {
  analyteId: string;
  analyteName: string;
  unitCode: string;
  direction: TrendDirection;
  pointResultIds: string[];
  points: TrendPoint[];
}

/** Distance outside [low, high]; a missing side is unbounded. */
function distance(v: bigint, low?: bigint, high?: bigint): bigint {
  if (low !== undefined && v < low) return low - v;
  if (high !== undefined && v > high) return v - high;
  return 0n;
}

/** §4.8 step 4: previous point p -> current c, both measured against the current result's range. */
function direction(p: bigint, c: bigint, low: bigint | undefined, high: bigint | undefined, stableBp: number): TrendDirection {
  if (abs(c - p) * 10000n <= abs(p) * BigInt(stableBp)) return 'stable'; // p = 0 -> only c = 0
  const dc = distance(c, low, high);
  const dp = distance(p, low, high);
  return dc < dp ? 'improved' : dc > dp ? 'worsened' : 'stable';
}

/** history undefined (method missing / threw) -> []. Order: deranged analytes first (§4.5 order), then catalog sortOrder; capped at trendsMax. */
export function buildTrends(a: {
  candidates: readonly TrendCandidate[];
  history: TrendHistory | undefined;
  trendMaxPoints: number;
  trendStableBp: number;
  trendsMax: number;
}): Trend[] {
  if (a.history === undefined) return [];
  const byAnalyte = new Map(a.history.series.map((s) => [s.analyteId, s.points]));
  const ordered = a.candidates
    .filter((c) => c.trendEnabled && c.valueNumeric !== undefined &&
      (c.referenceRangeSnapshot.low !== undefined || c.referenceRangeSnapshot.high !== undefined))
    .sort((x, y) =>
      (y.derangedSeverity === undefined ? -1 : SEV_RANK[y.derangedSeverity]) - (x.derangedSeverity === undefined ? -1 : SEV_RANK[x.derangedSeverity]) ||
      x.groupSortOrder - y.groupSortOrder || x.analyteSortOrder - y.analyteSortOrder || cmp(x.resultId, y.resultId));

  const out: Trend[] = [];
  for (const c of ordered) {
    if (out.length >= a.trendsMax) break;
    const earlier = (byAnalyte.get(c.analyteId) ?? [])
      .filter((p) => p.source === 'lis' && p.unitCode === c.unitCode && p.valueNumeric !== undefined)
      .sort((x, y) => Date.parse(y.approvedAt) - Date.parse(x.approvedAt) || cmp(y.resultId, x.resultId)) // newest first
      .slice(0, Math.max(0, a.trendMaxPoints - 1))
      .reverse(); // oldest -> newest
    if (earlier.length === 0) continue; // fewer than 2 points -> no trend
    const points: TrendPoint[] = [
      ...earlier.map((p) => ({ resultId: p.resultId, approvedAt: p.approvedAt, valueNumeric: p.valueNumeric! })),
      { resultId: c.resultId, approvedAt: c.approvedAt, valueNumeric: c.valueNumeric! },
    ];
    const { low, high } = c.referenceRangeSnapshot;
    out.push({
      analyteId: c.analyteId,
      analyteName: c.analyteName,
      unitCode: c.unitCode,
      direction: direction(toMicro(points[points.length - 2]!.valueNumeric), toMicro(c.valueNumeric!),
        low === undefined ? undefined : toMicro(low), high === undefined ? undefined : toMicro(high), c.trendStableBp ?? a.trendStableBp),
      pointResultIds: points.map((p) => p.resultId),
      points,
    });
  }
  return out;
}
