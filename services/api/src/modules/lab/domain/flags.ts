// Value flags, critical decision, ordinal validation, canonical value hash (02-TRD §4.3 steps 1, 3, 4; 02-TRD §5 [CONV]; 08 A13 D-9).
// Pure functions, exact decimal comparison on strings (no float). Equal-to-limit is never flagged.
import { createHash } from 'node:crypto';
import { LimsError } from '../../../core/errors.js';

export type Flag = 'N' | 'L' | 'H' | 'LL' | 'HH' | 'A';
export type ValueKind = 'numeric' | 'ordinal' | 'text';
export const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

/** Decimal string -> sign + digits scaled to `scale` fraction digits (exact). */
export function scaleDecimal(s: string, scale: number): bigint {
  if (!DECIMAL_RE.test(s)) throw new LimsError('lab.result_value_invalid');
  const neg = s.startsWith('-');
  const [i, f = ''] = (neg ? s.slice(1) : s).split('.');
  const n = BigInt(i + f.padEnd(scale, '0'));
  return neg ? -n : n;
}
export const fractionDigits = (s: string): number => s.split('.')[1]?.length ?? 0;

/** Exact decimal comparison, negatives allowed. */
export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const scale = Math.max(fractionDigits(a), fractionDigits(b));
  const x = scaleDecimal(a, scale), y = scaleDecimal(b, scale);
  return x < y ? -1 : x > y ? 1 : 0;
}

export interface FlagInput {
  kind: 'numeric' | 'code';
  value: string;
  range?: { low?: string | undefined; high?: string | undefined; normalCodes?: readonly string[] | undefined } | undefined;
  critical?: { low?: string | undefined; high?: string | undefined; abnormalCodes?: readonly string[] | undefined } | undefined;
  manualAbnormal?: boolean | undefined;
}

/** 02-TRD §4.3 step 3. undefined = no flag (no bound to compare against is never a guess). */
export function computeFlag(i: FlagInput): Flag | undefined {
  if (i.kind === 'numeric') {
    const { range: r, critical: c } = i;
    if (c?.low !== undefined && compareDecimal(i.value, c.low) < 0) return 'LL';
    if (c?.high !== undefined && compareDecimal(i.value, c.high) > 0) return 'HH';
    if (r?.low !== undefined && compareDecimal(i.value, r.low) < 0) return 'L';
    if (r?.high !== undefined && compareDecimal(i.value, r.high) > 0) return 'H';
    return r?.low !== undefined || r?.high !== undefined ? 'N' : undefined;
  }
  const normal = i.range?.normalCodes;
  if (i.critical?.abnormalCodes?.includes(i.value)) return 'A';
  if (normal && normal.length > 0 && !normal.includes(i.value)) return 'A';
  return i.manualAbnormal ? 'A' : undefined;
}

/** 02-TRD §4.3 step 4: critical iff LL / HH, or an abnormal code listed in critical.abnormalCodes. */
export function criticalDecision(i: { flag?: Flag | undefined; code?: string | undefined; abnormalCodes?: readonly string[] | undefined }): { critical: boolean; direction?: 'low' | 'high' | 'abnormal' } {
  if (i.flag === 'LL') return { critical: true, direction: 'low' };
  if (i.flag === 'HH') return { critical: true, direction: 'high' };
  if (i.flag === 'A' && i.code !== undefined && i.abnormalCodes?.includes(i.code)) return { critical: true, direction: 'abnormal' };
  return { critical: false };
}

/** Exact, case-sensitive membership in ordinalSetValues (D-9). Never echoes the value. */
export function validateOrdinalCode(code: string, ordinalSetValues?: readonly { code: string; display: string; sortOrder: number }[]): void {
  if (!ordinalSetValues?.some((v) => v.code === code)) throw new LimsError('lab.result_value_invalid');
}

const PREFIX: Record<ValueKind, string> = { numeric: 'n:', ordinal: 'o:', text: 't:' };
export const canonicalValueString = (kind: ValueKind, value: string): string => PREFIX[kind] + value;
/** critical_value_log idempotency key: first 16 hex chars of SHA-256 over the canonical string (02-TRD §5 [CONV]). */
export const valueSha256Prefix16 = (kind: ValueKind, value: string): string =>
  createHash('sha256').update(canonicalValueString(kind, value)).digest('hex').slice(0, 16);
