// C12 quantity parsing (02-TRD §3.1, §4.1; AC-02.4). Pure. Exact decimals as bigint; never floats.
import { LimsError } from '../../../core/errors.js';

// JS `$` (no /m flag) matches only at the very end, so a trailing "\n" is rejected; [0-9] keeps non-ASCII digits out.
const BASE = /^[0-9]{1,12}(\.[0-9]{1,6})?$/;
const PACK = /^[0-9]{1,9}(\.[0-9]{1,3})?$/;

const fail = (what: string): never => {
  throw new LimsError('common.validation_failed', `${what} is not a valid positive quantity`);
};
const check = (input: unknown, re: RegExp, what: string): string =>
  typeof input === 'string' && re.test(input) && /[1-9]/.test(input) ? input : fail(what);

/** DecimalStringPositive: ≤12 integer digits, ≤6 decimals, > 0. */
export const parseBaseQty = (input: unknown): string => check(input, BASE, 'base quantity');
/** DecimalStringPacks: ≤9 integer digits, ≤3 decimals, > 0 (numeric(12,3)). */
export const parsePackQty = (input: unknown): string => check(input, PACK, 'pack quantity');

/** Number of fraction digits of a validated decimal string. */
export const fracDigits = (s: string): number => (s.split('.')[1] ?? '').length;

/** Validated decimal string × 10^scale as bigint (scale ≥ fracDigits). */
export function scaled(s: string, scale: number): bigint {
  const [i = '', f = ''] = s.split('.');
  return BigInt(i + f.padEnd(scale, '0'));
}

export function formatScaled(v: bigint, scale: number): string {
  const t = v.toString().padStart(scale + 1, '0');
  return scale === 0 ? t : `${t.slice(0, -scale)}.${t.slice(-scale)}`;
}

/** round_half_up(qtyPacks × qtyInBase, 6) as a decimal string (§4.1). */
export function packToBase(qtyPacks: string, qtyInBase: string): string {
  parsePackQty(qtyPacks);
  parseBaseQty(qtyInBase);
  const sa = fracDigits(qtyPacks);
  const sb = fracDigits(qtyInBase);
  const prod = scaled(qtyPacks, sa) * scaled(qtyInBase, sb); // × 10^(sa+sb)
  const drop = sa + sb - 6;
  const q = drop <= 0 ? prod * 10n ** BigInt(-drop) : (prod + 5n * 10n ** BigInt(drop - 1)) / 10n ** BigInt(drop);
  return formatScaled(q, 6);
}
