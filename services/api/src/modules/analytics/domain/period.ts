// Period resolution (02-TRD §4 resolvePeriod; PRD US-02.1–7, §8.1). Pure: `today` and `maxDays` are injected.
// All B.S. conversion goes through shared-ts/bsdate (US-02.7); nothing is hard-coded here.
import {
  BS_SUPPORTED, BsDateError, adToBs, bsToAd, daysInBsMonth, fiscalYearBs, formatAd, formatBs,
  type IsoDate, type IsoUtc,
} from '../../../../../../packages/shared-ts/src/bsdate/index.js';
import { LimsError, type FieldError } from '../../../core/errors.js';

export interface PeriodQuery { business_date_from?: IsoDate | string; business_date_to?: IsoDate | string; bs_month?: string; fiscal_year_bs?: string }
export interface Period {
  readonly from: IsoDate;
  readonly to: IsoDate; // exclusive
  readonly days: number;
  readonly labelAd: string;
  readonly labelBs: string;
  readonly bsMonth?: string;
  readonly fiscalYearBs?: string;
}

const KATHMANDU_OFFSET_MS = (5 * 60 + 45) * 60_000; // fixed since 1986; midnight there = 18:15 UTC (US-02.6)

const fieldError = (path: string): FieldError => ({ path, code: 'common.field_invalid', message: 'Field invalid' });
const invalid = (detail: string, ...paths: string[]): LimsError => new LimsError('common.validation_failed', detail, paths.map(fieldError));

/** bsdate throws BsDateError (not a LimsError); map it to the registered code so callers never see a 500. */
function viaBs<T>(fn: () => T): T {
  try { return fn(); } catch (e) {
    if (e instanceof BsDateError) throw new LimsError(e.code);
    throw e;
  }
}

const dayNumber = (iso: string): number => {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d); // setUTCFullYear: Date.UTC would map years 0–99 to 19xx
  return Math.round(t.getTime() / 86_400_000);
};

function addDays(iso: IsoDate, n: number): IsoDate {
  const t = new Date(`${iso}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10) as IsoDate;
}

function parseIsoDate(v: unknown, path: string): IsoDate {
  const m = typeof v === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v) : null;
  if (!m) throw invalid('Invalid date', path);
  const t = new Date(0);
  t.setUTCFullYear(+m[1]!, +m[2]! - 1, +m[3]!);
  if (t.getUTCMonth() !== +m[2]! - 1 || t.getUTCDate() !== +m[3]!) throw invalid('Invalid date', path);
  return v as IsoDate;
}

function build(from: IsoDate, to: IsoDate, maxDays: number, extra: { bsMonth?: string; fiscalYearBs?: string } = {}): Period {
  const days = dayNumber(to) - dayNumber(from);
  if (days > maxDays) throw new LimsError('analytics.range_too_large');
  const last = addDays(to, -1);
  const labelAd = days === 1 ? formatAd(from) : `${formatAd(from)} – ${formatAd(last)}`;
  const labelBs = extra.fiscalYearBs ? `FY ${extra.fiscalYearBs} B.S.`
    : extra.bsMonth ? `${extra.bsMonth} B.S.`
    : viaBs(() => (days === 1 ? `${formatBs(adToBs(from))} B.S.` : `${formatBs(adToBs(from))} – ${formatBs(adToBs(last))} B.S.`));
  return Object.freeze({ from, to, days, labelAd, labelBs, ...extra });
}

export function resolvePeriod(q: PeriodQuery, today: IsoDate, maxDays: number): Period {
  const { business_date_from: dFrom, business_date_to: dTo, bs_month: bsm, fiscal_year_bs: fy } = q;
  const hasDates = dFrom !== undefined || dTo !== undefined;

  const given = [
    ...(hasDates ? [['dates', ['business_date_from', 'business_date_to'].filter((k) => q[k as keyof PeriodQuery] !== undefined)] as const] : []),
    ...(bsm !== undefined ? [['bs', ['bs_month']] as const] : []),
    ...(fy !== undefined ? [['fy', ['fiscal_year_bs']] as const] : []),
  ];
  if (given.length > 1) throw invalid('Use exactly one period selector', ...given.flatMap(([, paths]) => paths));

  if (bsm !== undefined) {
    const m = typeof bsm === 'string' ? /^([0-9]{4})-(0[1-9]|1[0-2])$/.exec(bsm) : null;
    if (!m) throw invalid('Invalid B.S. month', 'bs_month');
    const year = +m[1]!, month = +m[2]!;
    if (year < BS_SUPPORTED.minYear || year > BS_SUPPORTED.maxYear) throw new LimsError('common.date_out_of_range');
    return viaBs(() => {
      const from = bsToAd({ year, month, day: 1 });
      return build(from, addDays(from, daysInBsMonth(year, month)), maxDays, { bsMonth: bsm });
    });
  }

  if (fy !== undefined) {
    const m = typeof fy === 'string' ? /^([0-9]{4})\/([0-9]{2})$/.exec(fy) : null;
    if (!m || +m[2]! !== (+m[1]! + 1) % 100) throw invalid('Invalid fiscal year', 'fiscal_year_bs');
    const year = +m[1]!;
    // FY y/y+1 ends in Chaitra y+1; its exclusive end (Shrawan 1 of y+1) must be inside the table, so the last FY is 2098/99.
    if (year < BS_SUPPORTED.minYear || year > BS_SUPPORTED.maxYear - 1) throw new LimsError('common.date_out_of_range');
    return viaBs(() => {
      const f = fiscalYearBs(bsToAd({ year, month: 4, day: 1 }));
      return build(f.startsOn, addDays(f.endsOn, 1), maxDays, { fiscalYearBs: f.long });
    });
  }

  if (hasDates) {
    if (dFrom === undefined || dTo === undefined) throw invalid('Both dates are required', dFrom === undefined ? 'business_date_from' : 'business_date_to');
    const from = parseIsoDate(dFrom, 'business_date_from');
    const to = parseIsoDate(dTo, 'business_date_to');
    if (from >= to) throw invalid('business_date_from must be before business_date_to', 'business_date_from', 'business_date_to');
    return build(from, to, maxDays);
  }

  const from = parseIsoDate(today, 'business_date_from');
  return build(from, addDays(from, 1), maxDays);
}

/** Same length, immediately before `p.from` (dashboard deltas, US-01.2). */
export function previousPeriod(p: Period): Period {
  return build(addDays(p.from, -p.days), p.from, p.days);
}

/** Asia/Kathmandu business date of an instant. */
export function businessDateOf(instant: IsoUtc): IsoDate {
  const ok = typeof instant === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(instant);
  const ms = ok ? Date.parse(instant) : NaN;
  if (Number.isNaN(ms)) throw invalid('Invalid instant');
  return new Date(ms + KATHMANDU_OFFSET_MS).toISOString().slice(0, 10) as IsoDate;
}
