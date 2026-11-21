// Fiscal year of an instant (02-TRD §12 "FY derivation"; US-BL-01.3; 04 L16: FY starts 1 Shrawan). Pure.
import { adToBs, instantToBs, type IsoDate, type IsoUtc } from '../../../../../../packages/shared-ts/src/bsdate/index.js';
import { LimsError } from '../../../core/errors.js';

export interface FiscalYear { readonly short: string; readonly long: string }
export type FyCheck = { ok: true } | { ok: false; code: 'billing.counter_busy'; detail: 'fiscal_year_rollover' };

// [CONV] UTC instants only ('Z'): an offset-less string would be parsed in the server time zone.
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;

/** Calendar date of `instant` in the tenant `timezone`, then B.S.: month >= 4 (Shrawan) -> y/(y+1), else (y-1)/y. */
export function fiscalYearOf(instant: IsoUtc, timezone = 'Asia/Kathmandu'): FiscalYear {
  if (typeof instant !== 'string' || !UTC.test(instant)) throw new LimsError('common.validation_failed', 'instant must be ISO-8601 UTC');
  let b;
  try {
    b = instantToBs(instant, timezone);
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    throw new LimsError(code === 'common.date_out_of_range' ? code : 'common.validation_failed', 'cannot derive fiscal year');
  }
  const y = b.month >= 4 ? b.year : b.year - 1;
  const long = `${y}/${String((y + 1) % 100).padStart(2, '0')}`;
  return { short: long.slice(1), long };
}

/** T0B-FINCTRL-1 (LD-321): fiscal year start of a tenant, B.S. month / day. Default Shrawan 1 until the lab accountant confirms (notes: T0B-FINCTRL-1-impl.md). */
export interface FyStart { readonly month: number; readonly day: number }
export const SHRAWAN_1: FyStart = Object.freeze({ month: 4, day: 1 });
/** A setting value as a start, or the default when absent / malformed (fail safe to the statutory Shrawan 1). */
export function fyStartOf(v: unknown): FyStart {
  const o = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
  const m = o?.['month'], d = o?.['day'];
  return Number.isInteger(m) && Number.isInteger(d) && (m as number) >= 1 && (m as number) <= 12 && (d as number) >= 1 && (d as number) <= 32 ? { month: m as number, day: d as number } : SHRAWAN_1;
}
/** fiscal_year_label of a calendar date: '<BS year the FY began>/<next year, 2 digits>' (e.g. 2026-11-17 -> 2083/84 with the Shrawan 1 start). Throws BsDateError out of range. */
export function fiscalYearLabel(date: IsoDate, start: FyStart = SHRAWAN_1): string {
  const b = adToBs(date);
  const y = b.month > start.month || (b.month === start.month && b.day >= start.day) ? b.year : b.year - 1;
  return `${y}/${String((y + 1) % 100).padStart(2, '0')}`;
}

/** TRD §12 step 3: the counter row's FY must still be the FY of allocated_at. */
export function checkFiscalYear(allocatedAt: IsoUtc, timezone: string, expectedLong: string): FyCheck {
  return fiscalYearOf(allocatedAt, timezone).long === expectedLong
    ? { ok: true }
    : { ok: false, code: 'billing.counter_busy', detail: 'fiscal_year_rollover' };
}
