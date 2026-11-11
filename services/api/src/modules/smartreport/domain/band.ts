// Band status + direction per eligible result (02-TRD §4.2; AC-08.7, AC-10.2, AC-10.3, AC-10.5).
// The C5 flag is the authority; it is never recomputed from the value. Borderline is the only value-derived band.
import { divHalfUp, toMicro } from './fixed.js';

export type BandStatus = 'in_range' | 'borderline' | 'out_of_range' | 'critical';
export type BandDirection = 'low' | 'high' | 'abnormal';
export interface Band { status: BandStatus; direction?: BandDirection }
export interface BandInput {
  flag?: string;
  /** DecimalString */
  valueNumeric?: string;
  referenceRangeSnapshot?: { low?: string; high?: string; text?: string };
  /** Already-resolved b (mapping override else library); 0 / undefined = off. */
  borderlineFractionBp?: number;
}

const FLAG_BAND: Readonly<Record<string, Band>> = {
  HH: { status: 'critical', direction: 'high' },
  LL: { status: 'critical', direction: 'low' },
  H: { status: 'out_of_range', direction: 'high' },
  L: { status: 'out_of_range', direction: 'low' },
  A: { status: 'out_of_range', direction: 'abnormal' },
};

/** A missing or malformed limit counts as "no limit" (never throws into report generation). */
function micro(s: string | undefined): bigint | undefined {
  if (s === undefined) return undefined;
  try { return toMicro(s); } catch { return undefined; }
}

function borderline(i: BandInput): 'low' | 'high' | undefined {
  const b = i.borderlineFractionBp;
  const snap = i.referenceRangeSnapshot;
  if (b === undefined || !Number.isInteger(b) || b <= 0 || snap === undefined) return undefined;
  const v = micro(i.valueNumeric);
  const low = micro(snap.low);
  const high = micro(snap.high);
  if (v === undefined || (low === undefined && high === undefined)) return undefined;
  const bp = BigInt(b);
  if (low !== undefined && high !== undefined) {
    if (low >= high) return undefined; // zero/inverted width: no margin
    const m = divHalfUp((high - low) * bp, 10_000n);
    if (v < low + m) return 'low';
    return v > high - m ? 'high' : undefined;
  }
  if (high !== undefined) return v > high - divHalfUp((high < 0n ? -high : high) * bp, 10_000n) ? 'high' : undefined;
  const l = low as bigint;
  return v < l + divHalfUp((l < 0n ? -l : l) * bp, 10_000n) ? 'low' : undefined;
}

/** null = not eligible (no usable flag AND no range snapshot, AC-08.7). */
export function bandOf(i: BandInput): Band | null {
  const flagged = i.flag === undefined ? undefined : FLAG_BAND[i.flag];
  if (flagged !== undefined) return { ...flagged };
  if (i.flag !== 'N' && i.referenceRangeSnapshot === undefined) return null;
  const direction = borderline(i);
  return direction === undefined ? { status: 'in_range' } : { status: 'borderline', direction };
}
