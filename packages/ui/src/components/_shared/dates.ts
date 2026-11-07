// Date helpers for the kit's date components (04-UI-UX §2.3). All B.S. conversion goes through @lims/shared-ts/bsdate (04 D13).
// [CONV] relative source import until @lims/ui depends on @lims/shared-ts with a `./bsdate` export — see .orchestra/cr/T0D-13.nonblocking.md (owner C0-0A: package.json + lock).
import {
  BS_SUPPORTED,
  BsDateError,
  adToBs,
  bsToAd,
  daysInBsMonth,
  formatAd,
  formatBs,
  instantToBs,
  parseBs,
  type BsDate,
  type IsoDate,
  type IsoUtc,
} from '../../../../shared-ts/src/bsdate/index';

export { adToBs, bsToAd, daysInBsMonth, formatAd, formatBs, instantToBs, type BsDate, type IsoDate, type IsoUtc };
export type CalendarMode = 'AD' | 'BS';
export const DEFAULT_TZ = 'Asia/Kathmandu'; // CV §4.8 tenant default

export const BS_MONTHS = ['Baisakh', 'Jestha', 'Asar', 'Shrawan', 'Bhadra', 'Asoj', 'Kartik', 'Mangsir', 'Poush', 'Magh', 'Falgun', 'Chaitra'] as const;
export const AD_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
export const isoOf = (y: number, m: number, d: number) => `${pad(y, 4)}-${pad(m)}-${pad(d)}` as IsoDate;
export const ymd = (iso: string) => ({ year: +iso.slice(0, 4), month: +iso.slice(5, 7), day: +iso.slice(8, 10) });
export const addDays = (iso: IsoDate, n: number): IsoDate => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10) as IsoDate;
export const dayDiff = (a: IsoDate, b: IsoDate) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
export const weekday = (iso: IsoDate) => new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0 = Sunday (Nepal week starts Sunday)
export const adDaysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Supported A.D. window = B.S. 1975-01-01 … 2099-12-last (bsdate range). */
let win: { min: IsoDate; max: IsoDate } | undefined;
export const adWindow = () =>
  (win ??= {
    min: bsToAd({ year: BS_SUPPORTED.minYear, month: 1, day: 1 }),
    max: bsToAd({ year: BS_SUPPORTED.maxYear, month: 12, day: daysInBsMonth(BS_SUPPORTED.maxYear, 12) }),
  });

/** Calendar date of `now` in `tz`. */
export function todayIn(tz: string = DEFAULT_TZ): IsoDate {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now())) as IsoDate;
}

/** 'YYYY-MM-DD B.S.' or undefined when outside the supported range. */
export function bsDisplay(iso: IsoDate): string | undefined {
  try {
    return formatBs(adToBs(iso), 'display');
  } catch {
    return undefined;
  }
}

export const displayDate = (iso: IsoDate, cal: CalendarMode) => (cal === 'BS' ? (bsDisplay(iso) ?? formatAd(iso)) : formatAd(iso));

export const msgDate = {
  invalid: (example: string) => `Enter a date like ${example}`, // ui.validation.date_invalid
  outOfRange: (min: string, max: string) => `Dates must be between ${min} and ${max}`, // ui.validation.date_out_of_range
};
export const example = (cal: CalendarMode, withTime = false) => (cal === 'BS' ? '2082-04-01' : '17/07/2025') + (withTime ? ' 10:30 AM' : '');

export function rangeMessage(cal: CalendarMode, min?: IsoDate, max?: IsoDate): string {
  const w = adWindow();
  const lo = min && min > w.min ? min : w.min;
  const hi = max && max < w.max ? max : w.max;
  return msgDate.outOfRange(displayDate(lo, cal), displayDate(hi, cal));
}

export type Parsed = { ok: true; value: IsoDate } | { ok: false; error: string };

/** Manual entry: A.D. 'DD/MM/YYYY', B.S. 'YYYY-MM-DD' (an optional trailing 'B.S.' is accepted). Never guesses. */
export function parseDateText(raw: string, cal: CalendarMode, min?: IsoDate, max?: IsoDate): Parsed {
  const text = raw.trim().replace(/\s*B\.S\.?$/i, '');
  const bad = { ok: false as const, error: msgDate.invalid(example(cal)) };
  let value: IsoDate;
  if (cal === 'BS') {
    try {
      value = bsToAd(parseBs(text));
    } catch (e) {
      if (e instanceof BsDateError && e.code === 'common.date_out_of_range') return { ok: false, error: rangeMessage(cal, min, max) };
      return bad;
    }
  } else {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
    if (!m) return bad;
    const [d, mo, y] = [+m[1]!, +m[2]!, +m[3]!];
    if (mo < 1 || mo > 12 || d < 1 || d > adDaysInMonth(y, mo)) return bad;
    value = isoOf(y, mo, d);
  }
  const w = adWindow();
  if (value < w.min || value > w.max || (min && value < min) || (max && value > max)) return { ok: false, error: rangeMessage(cal, min, max) };
  return { ok: true, value };
}

/** Offset (ms) of `tz` from UTC at instant `t`. */
function tzOffset(t: number, tz: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(t))
      .map((x) => [x.type, x.value]),
  );
  return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour! % 24, +p.minute!, +p.second!) - Math.floor(t / 1000) * 1000;
}

/** Local wall time in `tz` -> IsoUtc. */
export function localToUtc(date: IsoDate, hour24: number, minute: number, tz: string): IsoUtc {
  const { year, month, day } = ymd(date);
  const guess = Date.UTC(year, month - 1, day, hour24, minute);
  let t = guess - tzOffset(guess, tz);
  t = guess - tzOffset(t, tz); // second pass settles DST edges
  return new Date(t).toISOString() as IsoUtc;
}

/** IsoUtc -> { date in tz, 'hh:mm A' }. */
export function utcParts(instant: string, tz: string): { date: IsoDate; time: string } | undefined {
  try {
    const s = formatAd(instant as IsoUtc, tz); // 'DD/MM/YYYY hh:mm A'
    return { date: isoOf(+s.slice(6, 10), +s.slice(3, 5), +s.slice(0, 2)), time: s.slice(11) };
  } catch {
    return undefined;
  }
}
