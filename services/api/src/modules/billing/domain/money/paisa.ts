// bigint columns arrive from node-postgres as strings; events and DTOs carry integer paisa numbers. Never a rounded value:
// anything outside the safe-integer range (or not an integer at all) is common.internal. Pure.
import { LimsError } from '../../../../core/errors.js';

const INT = /^-?[0-9]{1,19}$/;
const MAX = BigInt(Number.MAX_SAFE_INTEGER);

export function toPaisa(v: unknown): number {
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new LimsError('common.internal');
    return v;
  }
  if (typeof v === 'string' && INT.test(v)) {
    const b = BigInt(v);
    if (b > MAX || b < -MAX) throw new LimsError('common.internal');
    return Number(b);
  }
  throw new LimsError('common.internal');
}
export const moneyOf = (paisa: number) => ({ amount_paisa: paisa, currency: 'NPR' as const });
