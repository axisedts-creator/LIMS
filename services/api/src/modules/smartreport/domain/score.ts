// Health score, formula hs-1 (02-TRD §4.4; AC-04.4, AC-09.1..AC-09.4). Pure; integer math only.
import { divHalfUp } from './fixed.js';
import type { BandStatus } from './band.js';

export interface ScoreMember { groupCode: string; status: BandStatus; includeInScore: boolean }
export interface ScoreGroup { groupCode: string; scoreWeight: number; isShown: boolean }
export interface ScoreParams {
  scoreEnabled: boolean;
  creditInRangeBp: number;
  creditBorderlineBp: number;
  creditOutOfRangeBp: number;
  creditCriticalBp: number;
  minGroupsScored: number;
  bandGoodMin: number;
  bandFairMin: number;
  criticalForcesNeedsAttention: boolean;
}
export interface HealthScore {
  value: number;
  band: 'good' | 'fair' | 'needs_attention';
  formulaVersion: 'hs-1';
  panelsScored: number;
}

/** undefined = healthScore omitted (never 0, never 100). */
export function computeHealthScore(i: { members: readonly ScoreMember[]; groups: readonly ScoreGroup[]; params: ScoreParams }): HealthScore | undefined {
  const p = i.params;
  if (!p.scoreEnabled) return undefined;
  const credit: Readonly<Record<BandStatus, number>> = {
    in_range: p.creditInRangeBp,
    borderline: p.creditBorderlineBp,
    out_of_range: p.creditOutOfRangeBp,
    critical: p.creditCriticalBp,
  };
  const weight = new Map<string, number>();
  for (const g of i.groups) if (g.isShown && g.scoreWeight > 0) weight.set(g.groupCode, g.scoreWeight);

  const sum = new Map<string, { credits: bigint; n: bigint }>();
  let anyCritical = false;
  for (const m of i.members) {
    if (!m.includeInScore || !weight.has(m.groupCode)) continue;
    const a = sum.get(m.groupCode) ?? { credits: 0n, n: 0n };
    a.credits += BigInt(credit[m.status]);
    a.n += 1n;
    sum.set(m.groupCode, a);
    if (m.status === 'critical') anyCritical = true;
  }
  if (sum.size < p.minGroupsScored || sum.size === 0) return undefined;

  let num = 0n;
  let wSum = 0n;
  for (const [code, a] of sum) {
    const w = BigInt(weight.get(code) as number);
    num += w * divHalfUp(a.credits, a.n);
    wSum += w;
  }
  const value = Number(divHalfUp(num, 100n * wSum));
  const band = p.criticalForcesNeedsAttention && anyCritical ? 'needs_attention'
    : value >= p.bandGoodMin ? 'good'
    : value >= p.bandFairMin ? 'fair'
    : 'needs_attention';
  return { value, band, formulaVersion: 'hs-1', panelsScored: sum.size };
}
