// Fiscal year of an instant (02-TRD §12 "FY derivation"; US-BL-01.3; 04 L16: FY starts 1 Shrawan). Pure.
import { instantToBs, type IsoUtc } from '../../../../../../packages/shared-ts/src/bsdate/index.js';
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

/** TRD §12 step 3: the counter row's FY must still be the FY of allocated_at. */
export function checkFiscalYear(allocatedAt: IsoUtc, timezone: string, expectedLong: string): FyCheck {
  return fiscalYearOf(allocatedAt, timezone).long === expectedLong
    ? { ok: true }
    : { ok: false, code: 'billing.counter_busy', detail: 'fiscal_year_rollover' };
}
