// Schedule domain (02-TRD §9.6 steps 2/2a/6 + `nextSlot`; PRD US-18.1/18.5; 07-SECURITY S3). Pure: nothing here reads the system time; every instant is passed in.
// Local time = Asia/Kathmandu, fixed UTC+05:45 (DECISION in TRD §9.6; no DST in the supported range). All B.S. conversion goes through shared-ts/bsdate (US-02.7).
import { adToBs, bsToAd, fiscalYearBs, type IsoDate, type IsoUtc } from '../../../../../../packages/shared-ts/src/bsdate/index.js';
import { LimsError } from '../../../core/errors.js';

export const SCHEDULE_FREQUENCIES = ['daily', 'weekly', 'monthly_ad', 'monthly_bs'] as const;
export const PERIOD_RULES = [
  'previous_business_day', 'previous_7_days', 'month_to_date_ad', 'previous_ad_month', 'month_to_date_bs', 'previous_bs_month', 'fiscal_year_to_date',
] as const;
export type Frequency = (typeof SCHEDULE_FREQUENCIES)[number];
export type PeriodRule = (typeof PERIOD_RULES)[number];

export interface SlotSpec { readonly frequency: string; readonly send_time_local: string; readonly weekday?: number | null | undefined }

const OFFSET_MS = (5 * 60 + 45) * 60_000;
const DAY_MS = 86_400_000;
const LATE_MS = DAY_MS; // [CONV] TRD §9.6 step 2a

const dayMs = (iso: string): number => Date.parse(`${iso}T00:00:00.000Z`);
const isoOf = (ms: number): IsoDate => new Date(ms).toISOString().slice(0, 10) as IsoDate;
const addDays = (iso: string, n: number): IsoDate => isoOf(dayMs(iso) + n * DAY_MS);
const firstOfAdMonth = (iso: string, shift = 0): IsoDate => {
  const d = new Date(dayMs(iso));
  return isoOf(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + shift, 1));
};
const bsFirst = (year: number, month: number): IsoDate => bsToAd({ year, month, day: 1 });
const bsShift = (b: { year: number; month: number }, shift: 1 | -1): { year: number; month: number } => {
  const m = b.month + shift;
  return m < 1 ? { year: b.year - 1, month: 12 } : m > 12 ? { year: b.year + 1, month: 1 } : { year: b.year, month: m };
};

/** [from, to) in local business dates for `rule` relative to the slot's local date (TRD §9.6 step 2). An unknown rule throws: never a silent default period. */
export function schedulePeriod(rule: PeriodRule, slotDate: IsoDate): { from: IsoDate; to: IsoDate } {
  if (typeof rule !== 'string' || !(PERIOD_RULES as readonly string[]).includes(rule)) throw new TypeError('schedulePeriod: unknown period rule');
  const d = slotDate;
  switch (rule) {
    case 'previous_business_day': return { from: addDays(d, -1), to: d };
    case 'previous_7_days': return { from: addDays(d, -7), to: d };
    case 'month_to_date_ad': {
      const first = firstOfAdMonth(d);
      return { from: first === d ? firstOfAdMonth(d, -1) : first, to: d };
    }
    case 'previous_ad_month': return { from: firstOfAdMonth(d, -1), to: firstOfAdMonth(d) };
    case 'month_to_date_bs': {
      const b = adToBs(d);
      if (b.day === 1) { const p = bsShift(b, -1); return { from: bsFirst(p.year, p.month), to: d }; }
      return { from: bsFirst(b.year, b.month), to: d };
    }
    case 'previous_bs_month': {
      const b = adToBs(d);
      const p = bsShift(b, -1);
      return { from: bsFirst(p.year, p.month), to: bsFirst(b.year, b.month) };
    }
    case 'fiscal_year_to_date': return { from: fiscalYearBs(addDays(d, -1)).startsOn as IsoDate, to: d };
  }
}

const HM = /^([01][0-9]|2[0-3]):(00|15|30|45)$/;

/** The earliest slot STRICTLY after `after` (ISO UTC, ms precision). daily / weekly (ISO weekday, local) / monthly_ad / monthly_bs (1st of the next month). */
export function nextSlot(s: SlotSpec, after: IsoUtc): IsoUtc {
  if (!HM.test(s.send_time_local)) throw new TypeError('nextSlot: send_time_local must be HH:MM on a quarter hour');
  const afterMs = Date.parse(after);
  if (Number.isNaN(afterMs)) throw new TypeError('nextSlot: invalid instant');
  const local = afterMs + OFFSET_MS;                                   // local wall clock as if it were UTC
  const today = isoOf(local);
  const at = (date: string): number => Date.parse(`${date}T${s.send_time_local}:00.000Z`);
  let cand: number;
  switch (s.frequency) {
    case 'daily': {
      cand = at(today);
      if (cand <= local) cand = at(addDays(today, 1));
      break;
    }
    case 'weekly': {
      const w = s.weekday;
      if (typeof w !== 'number' || !Number.isInteger(w) || w < 1 || w > 7) throw new TypeError('nextSlot: weekday 1..7 required for weekly');
      const cur = ((new Date(dayMs(today)).getUTCDay() + 6) % 7) + 1;
      cand = at(addDays(today, (w - cur + 7) % 7));
      if (cand <= local) cand = at(addDays(today, ((w - cur + 7) % 7) + 7));
      break;
    }
    case 'monthly_ad': {
      cand = at(firstOfAdMonth(today));
      if (cand <= local) cand = at(firstOfAdMonth(today, 1));
      break;
    }
    case 'monthly_bs': {
      const b = adToBs(today);
      cand = at(bsFirst(b.year, b.month));
      if (cand <= local) { const n = bsShift(b, 1); cand = at(bsFirst(n.year, n.month)); }
      break;
    }
    default: throw new TypeError('nextSlot: unknown frequency');
  }
  return new Date(cand - OFFSET_MS).toISOString() as IsoUtc;
}

/** now − slot_start > 24 h (strict) [CONV, TRD §9.6 step 2a]. */
export function isSlotLate(slotStart: IsoUtc, now: IsoUtc): boolean {
  return Date.parse(now) - Date.parse(slotStart) > LATE_MS;
}

/** Mirrors schedules__name__ck / C6 label_text (TRD §9.6 step 6; 08 A4.3/A5.4): 1–80 characters, no `://` or `www.` (any case), no `@`, no run of 7+ digits [CONV]. */
export function validateScheduleName(name: unknown): void {
  const ok = typeof name === 'string' && [...name].length >= 1 && [...name].length <= 80
    && !/:\/\//i.test(name) && !/www\./i.test(name) && !/@/.test(name) && !/[0-9]{7,}/.test(name);
  if (!ok) throw new LimsError('common.validation_failed', 'Invalid name', [{ path: 'name', code: 'common.field_invalid', message: 'Field invalid' }]);
}
