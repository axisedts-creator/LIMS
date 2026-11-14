// B.S. wrapper (02-TRD §3.2; 04 D13, L16; CV §4.8, §13). All B.S. conversion goes through here.
import { rawAdToBs, rawBsToAd, type Ymd } from './impl.ts';

/** IC §2 brands. [CONV] local until `@lims/contracts/ports/common` exists; re-export them then. */
export type IsoDate = string & { readonly __brand: 'IsoDate' };
export type IsoUtc = string & { readonly __brand: 'IsoUtc' };

export interface BsDate { readonly year: number; readonly month: number; readonly day: number } // 1 = Baisakh … 4 = Shrawan … 12 = Chaitra
export const BS_SUPPORTED = { minYear: 1975, maxYear: 2099 } as const; // 04 D13 common range
export type FiscalYearBs = { readonly short: string; readonly long: string; readonly startsOn: IsoDate; readonly endsOn: IsoDate };

/** [CONV] carries the registered code until LimsError lands (T0A-08); swap the class for LimsError then. */
export class BsDateError extends Error {
  readonly code: 'common.date_out_of_range' | 'common.validation_failed';
  constructor(code: BsDateError['code'], message: string) {
    super(message);
    this.name = 'BsDateError';
    this.code = code;
  }
}
const outOfRange = (what: string): BsDateError => new BsDateError('common.date_out_of_range', `${what} is outside B.S. ${BS_SUPPORTED.minYear}–${BS_SUPPORTED.maxYear}`);
const invalid = (what: string): BsDateError => new BsDateError('common.validation_failed', `invalid date: ${what}`);

const DEFAULT_TZ = 'Asia/Kathmandu'; // CV §4.8
const pad = (n: number, w: number): string => String(n).padStart(w, '0');
const iso = (d: Ymd): IsoDate => `${pad(d.year, 4)}-${pad(d.month, 2)}-${pad(d.day, 2)}` as IsoDate;
const bs = (d: Ymd): BsDate => Object.freeze({ year: d.year, month: d.month, day: d.day });
const gregDays = (y: number, m: number): number => [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;

function parseAd(date: string): Ymd {
  const m = typeof date === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) : null;
  if (!m) throw invalid(String(date));
  const r = { year: +m[1]!, month: +m[2]!, day: +m[3]! };
  if (r.month < 1 || r.month > 12 || r.day < 1 || r.day > gregDays(r.year, r.month)) throw invalid(date);
  return r;
}

function checkBs(b: BsDate): void {
  if (b === null || typeof b !== 'object' || ![b.year, b.month, b.day].every(Number.isInteger)) throw invalid(JSON.stringify(b));
  if (b.year < BS_SUPPORTED.minYear || b.year > BS_SUPPORTED.maxYear) throw outOfRange(`B.S. year ${b.year}`);
  if (b.month < 1 || b.month > 12 || b.day < 1) throw invalid(JSON.stringify(b));
}

export function daysInBsMonth(year: number, month: number): number {
  checkBs({ year, month, day: 1 });
  for (let d = 32; d >= 29; d--) if (rawBsToAd(year, month, d)) return d;
  throw outOfRange(`B.S. ${year}-${month}`); // library has no row for it
}

export function bsToAd(b: BsDate): IsoDate {
  checkBs(b);
  if (b.day > daysInBsMonth(b.year, b.month)) throw invalid(JSON.stringify(b));
  const r = rawBsToAd(b.year, b.month, b.day);
  if (!r) throw outOfRange(JSON.stringify(b));
  return iso(r);
}

// A.D. window of the supported B.S. range; ISO strings with 4-digit years compare lexicographically.
let window: { min: IsoDate; max: IsoDate } | undefined;
const adWindow = () =>
  (window ??= {
    min: bsToAd({ year: BS_SUPPORTED.minYear, month: 1, day: 1 }),
    max: bsToAd({ year: BS_SUPPORTED.maxYear, month: 12, day: daysInBsMonth(BS_SUPPORTED.maxYear, 12) }),
  });

export function adToBs(date: IsoDate): BsDate {
  const ad = parseAd(date);
  const { min, max } = adWindow();
  if (date < min || date > max) throw outOfRange(`A.D. ${date}`);
  const r = rawAdToBs(ad.year, ad.month, ad.day);
  if (!r) throw outOfRange(`A.D. ${date}`);
  return bs(r);
}

/** Calendar date of `instant` in `timezone` (default Asia/Kathmandu), as B.S. */
export function instantToBs(instant: IsoUtc, timezone: string = DEFAULT_TZ): BsDate {
  return adToBs(localParts(instant, timezone).date);
}

const addDays = (date: IsoDate, n: number): IsoDate => {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10) as IsoDate;
};

/** FY starts Shrawan 1 (04 L16). `short` = `{fy}`, `long` = `{fyl}` (IC §9.3).
 *  startsOn/endsOn are getters: for FY 1974/75 and 2099/00 the boundary lies outside the table and reading it throws common.date_out_of_range. */
export function fiscalYearBs(date: IsoDate): FiscalYearBs {
  const b = adToBs(date);
  const y = b.month >= 4 ? b.year : b.year - 1;
  const long = `${y}/${pad((y + 1) % 100, 2)}`;
  return Object.freeze(Object.defineProperties({ short: long.slice(1), long } as unknown as FiscalYearBs, {
    startsOn: { enumerable: true, get: () => bsToAd({ year: y, month: 4, day: 1 }) },
    endsOn: { enumerable: true, get: () => addDays(bsToAd({ year: y + 1, month: 4, day: 1 }), -1) },
  }));
}

/** 'iso' = 'YYYY-MM-DD'; 'display' = 'YYYY-MM-DD B.S.' (CV §13). */
export function formatBs(b: BsDate, style: 'iso' | 'display' = 'iso'): string {
  const s = iso(b);
  return style === 'display' ? `${s} B.S.` : s;
}

function localParts(instant: string, timezone: string): { date: IsoDate; time: string } {
  const t = typeof instant === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(instant) ? new Date(instant) : new Date(NaN);
  if (Number.isNaN(t.getTime())) throw invalid(String(instant));
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: true })
      .formatToParts(t)
      .map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}` as IsoDate, time: `${p.hour}:${p.minute} ${String(p.dayPeriod).toUpperCase()}` };
}

/** 'DD/MM/YYYY' for a date, 'DD/MM/YYYY hh:mm A' for an instant in `timezone` (CV §13; 00 §4). */
export function formatAd(date: IsoDate | IsoUtc, timezone: string = DEFAULT_TZ): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const d = parseAd(date);
    return `${pad(d.day, 2)}/${pad(d.month, 2)}/${pad(d.year, 4)}`;
  }
  const { date: day, time } = localParts(date, timezone);
  return `${formatAd(day)} ${time}`;
}

/** Accepts 'YYYY-MM-DD' and 'YYYY/MM/DD'; never guesses. Range/day checks happen on conversion. */
export function parseBs(text: string): BsDate {
  const m = typeof text === 'string' ? /^(\d{4})([-/])(\d{2})\2(\d{2})$/.exec(text) : null;
  if (!m) throw invalid(String(text));
  const r = bs({ year: +m[1]!, month: +m[3]!, day: +m[4]! });
  if (r.month < 1 || r.month > 12 || r.day < 1 || r.day > 32) throw invalid(text);
  return r;
}
