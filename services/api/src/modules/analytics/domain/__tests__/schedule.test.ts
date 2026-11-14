// C8 AN-T16 — domain/schedule.ts: slot math, period rules, late-slot rule, schedule-name rules (02-TRD §9.6 steps 2/2a/6 + `nextSlot`; PRD US-18.1/18.5; 07-SECURITY S3).
// Pure functions, injected clock (nothing here reads the system time). Assumed API (names are not pinned by the spec; dispute through the reviewer):
//   schedulePeriod(rule: PeriodRule, slotDate: IsoDate): { from: IsoDate; to: IsoDate }      // slotDate = the slot's local (Asia/Kathmandu) date; [from, to) as in TRD §9.6 step 2
//   nextSlot(s: { frequency; send_time_local: 'HH:MM'; weekday?: number|null }, after: IsoUtc): IsoUtc   // earliest slot STRICTLY after `after`; ISO via Date#toISOString(); local = UTC+05:45
//   isSlotLate(slotStart: IsoUtc, now: IsoUtc): boolean                                       // now − slotStart > 24 h (strict) [CONV]
//   validateScheduleName(name: unknown): void                                                 // throws LimsError common.validation_failed (400), errors[0].path ends with `name`
// Every B.S. boundary is read from the golden table (helpers.ts) — never hard-coded (US-02.7).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { isSlotLate, nextSlot, schedulePeriod, validateScheduleName } from '../schedule.js';
import { GOLDEN, addDays, diffDays, golden } from './helpers.js';
import { INVALID_NAMES, VALID_NAMES } from './scheduleNames.js';

afterEach(() => { vi.useRealTimers(); });

const OFFSET_MS = (5 * 60 + 45) * 60_000;                                   // Asia/Kathmandu, fixed
/** Independent arithmetic: UTC instant of local `date` at `hm`. */
const npt = (date: string, hm: string): string => new Date(Date.parse(`${date}T${hm}:00.000Z`) - OFFSET_MS).toISOString();
const isoWeekday = (date: string): number => ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
const first = (y: number, m: number): string => golden(y, m).ad_first_day;
const P = (from: string, to: string) => ({ from, to });
const period = (rule: string, d: string) => schedulePeriod(rule as never, d as never);

// ============================================================================================ period rules
describe('schedulePeriod — A.D. rules (TRD §9.6 step 2 table)', () => {
  it.each([
    // [rule, slot date, from, to]
    ['previous_business_day', '2026-11-06', '2026-11-05', '2026-11-06'],
    ['previous_business_day', '2026-11-01', '2026-10-31', '2026-11-01'],
    ['previous_business_day', '2027-01-01', '2026-12-31', '2027-01-01'],
    ['previous_business_day', '2028-03-01', '2028-02-29', '2028-03-01'],         // leap year
    ['previous_business_day', '2027-03-01', '2027-02-28', '2027-03-01'],
    ['previous_7_days', '2026-11-06', '2026-10-30', '2026-11-06'],
    ['previous_7_days', '2027-01-03', '2026-12-27', '2027-01-03'],                // year rollover
    ['month_to_date_ad', '2026-11-06', '2026-11-01', '2026-11-06'],
    ['month_to_date_ad', '2026-11-02', '2026-11-01', '2026-11-02'],               // one day
    ['month_to_date_ad', '2026-12-15', '2026-12-01', '2026-12-15'],
    ['month_to_date_ad', '2026-11-01', '2026-10-01', '2026-11-01'],               // 1st of the month -> the previous A.D. month
    ['month_to_date_ad', '2027-01-01', '2026-12-01', '2027-01-01'],               // ... across the year
    ['previous_ad_month', '2026-11-06', '2026-10-01', '2026-11-01'],
    ['previous_ad_month', '2027-01-01', '2026-12-01', '2027-01-01'],
    ['previous_ad_month', '2028-03-01', '2028-02-01', '2028-03-01'],              // leap February (29 days)
    ['previous_ad_month', '2027-03-15', '2027-02-01', '2027-03-01'],
  ])('%s on %s -> [%s, %s)', (rule, slot, from, to) => { expect(period(rule, slot)).toEqual(P(from, to)); });

  it('an unknown rule is refused (never a silent default period)', () => {
    expect(() => period('last_week', '2026-11-06')).toThrow();
    expect(() => period('__proto__', '2026-11-06')).toThrow();
  });
});

describe('schedulePeriod — B.S. rules, boundaries from the golden table (US-18.1, TRD §9.6)', () => {
  it('previous_bs_month mid-month: the whole previous B.S. month', () => {
    const slot = addDays(first(2082, 7), 10);
    expect(period('previous_bs_month', slot)).toEqual(P(first(2082, 6), first(2082, 7)));
  });
  it('month_to_date_bs mid-month: [first of the slot\'s B.S. month, slot)', () => {
    const slot = addDays(first(2082, 7), 10);
    expect(period('month_to_date_bs', slot)).toEqual(P(first(2082, 7), slot));
  });
  it('month_to_date_bs on the 1st of a B.S. month -> the previous B.S. month (mirrors the A.D. rule)', () => {
    expect(period('month_to_date_bs', first(2082, 7))).toEqual(P(first(2082, 6), first(2082, 7)));
  });
  it('B.S. month ROLLOVER: on Baisakh 1 the previous month is Chaitra of the previous B.S. year', () => {
    const slot = first(2083, 1);
    expect(period('previous_bs_month', slot)).toEqual(P(first(2082, 12), first(2083, 1)));
    expect(period('month_to_date_bs', slot)).toEqual(P(first(2082, 12), first(2083, 1)));
    expect(period('previous_bs_month', addDays(slot, 3))).toEqual(P(first(2082, 12), first(2083, 1)));
    expect(period('month_to_date_bs', addDays(slot, 3))).toEqual(P(first(2083, 1), addDays(slot, 3)));
  });
  it('last day of a B.S. month: that day is still in its own month, so the previous month is the one before it', () => {
    const slot = addDays(first(2082, 7), -1); // last day of B.S. 2082-06
    expect(period('previous_bs_month', slot)).toEqual(P(first(2082, 5), first(2082, 6)));
  });
  it('every B.S. month 2001..2098 (29/30/31/32-day months): previous_bs_month and month_to_date_bs on the 1st and on day 14', () => {
    const bad: string[] = [];
    for (const g of GOLDEN.filter((x) => x.bs_year >= 2001 && x.bs_year <= 2098)) {
      const prev = g.bs_month === 1 ? golden(g.bs_year - 1, 12) : golden(g.bs_year, g.bs_month - 1);
      const mid = addDays(g.ad_first_day, 13);
      const want: [string, string, string, string][] = [
        ['previous_bs_month', g.ad_first_day, prev.ad_first_day, g.ad_first_day], ['month_to_date_bs', g.ad_first_day, prev.ad_first_day, g.ad_first_day],
        ['previous_bs_month', mid, prev.ad_first_day, g.ad_first_day], ['month_to_date_bs', mid, g.ad_first_day, mid],
      ];
      for (const [rule, slot, from, to] of want) {
        const got = period(rule, slot);
        if (got.from !== from || got.to !== to) bad.push(`${g.bs_year}-${g.bs_month} ${rule} @${slot}: got ${got.from}..${got.to} want ${from}..${to}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('schedulePeriod — fiscal_year_to_date = [fiscalYearBs(slot − 1).startsOn, slot)', () => {
  it('mid fiscal year: from Shrawan 1 of the current fiscal year', () => {
    const slot = addDays(first(2082, 10), 9);
    expect(period('fiscal_year_to_date', slot)).toEqual(P(first(2082, 4), slot));
  });
  it('on Shrawan 1 (the new fiscal year starts) the period is the WHOLE previous fiscal year (the day before still belongs to it)', () => {
    const slot = first(2082, 4);
    expect(period('fiscal_year_to_date', slot)).toEqual(P(first(2081, 4), slot));
  });
  it('the day after Shrawan 1 starts the new fiscal year', () => {
    const slot = addDays(first(2082, 4), 1);
    expect(period('fiscal_year_to_date', slot)).toEqual(P(first(2082, 4), slot));
  });
  it('Chaitra (end of the fiscal year) is still the year that began the previous Shrawan; every FY 2001..2097 stays within 366 days (report_runs__period__ck)', () => {
    const bad: string[] = [];
    for (let y = 2001; y <= 2097; y++) {
      const atStart = period('fiscal_year_to_date', first(y, 4));
      if (atStart.from !== first(y - 1, 4) || diffDays(atStart.from, atStart.to) > 366) bad.push(`FY start ${y}: ${atStart.from}..${atStart.to}`);
      const chaitra = period('fiscal_year_to_date', addDays(first(y + 1, 1), -2));
      if (chaitra.from !== first(y, 4)) bad.push(`Chaitra of ${y}: from ${chaitra.from}`);
    }
    expect(bad).toEqual([]);
  });
});

// ============================================================================================ nextSlot
describe('nextSlot — daily (local time -> UTC at the fixed +05:45 offset)', () => {
  const daily = (hm: string) => ({ frequency: 'daily', send_time_local: hm, weekday: null });
  it('07:00 Nepal = 01:15Z; strictly after: exactly on the slot -> tomorrow, 1 ms before -> today', () => {
    expect(nextSlot(daily('07:00') as never, '2026-11-06T01:14:59.999Z' as never)).toBe('2026-11-06T01:15:00.000Z');
    expect(nextSlot(daily('07:00') as never, '2026-11-06T01:15:00.000Z' as never)).toBe('2026-11-07T01:15:00.000Z');
    expect(nextSlot(daily('07:00') as never, '2026-11-06T06:00:00.000Z' as never)).toBe(npt('2026-11-07', '07:00'));
  });
  it('00:00 local is 18:15Z of the previous UTC day', () => {
    expect(nextSlot(daily('00:00') as never, '2026-11-06T00:00:00.000Z' as never)).toBe('2026-11-06T18:15:00.000Z');
    expect(nextSlot(daily('00:00') as never, '2026-11-06T18:15:00.000Z' as never)).toBe('2026-11-07T18:15:00.000Z');
  });
  it('23:45 local is 18:00Z the same UTC day', () => {
    expect(nextSlot(daily('23:45') as never, '2026-11-06T17:59:59.999Z' as never)).toBe('2026-11-06T18:00:00.000Z');
  });
  it('year rollover and quarter-hour minutes', () => {
    expect(nextSlot(daily('07:00') as never, '2026-12-31T06:00:00.000Z' as never)).toBe(npt('2027-01-01', '07:00'));
    expect(nextSlot(daily('07:30') as never, '2026-11-06T00:00:00.000Z' as never)).toBe('2026-11-06T01:45:00.000Z');
    expect(nextSlot(daily('07:15') as never, '2026-11-06T00:00:00.000Z' as never)).toBe('2026-11-06T01:30:00.000Z');
  });
  it('40 consecutive slots are exactly 24 h apart (no DST in Asia/Kathmandu)', () => {
    let at = '2026-11-06T06:00:00.000Z';
    let prev = Date.parse(nextSlot(daily('07:00') as never, at as never));
    for (let i = 0; i < 40; i++) {
      at = new Date(prev).toISOString();
      const n = Date.parse(nextSlot(daily('07:00') as never, at as never));
      expect(n - prev).toBe(86_400_000);
      prev = n;
    }
  });
});

describe('nextSlot — weekly (ISO weekday 1 = Monday .. 7 = Sunday, evaluated on the LOCAL date)', () => {
  const weekly = (weekday: number, hm: string) => ({ frequency: 'weekly', send_time_local: hm, weekday });
  it('sanity: 2026-11-06 is a Friday (ISO 5)', () => { expect(isoWeekday('2026-11-06')).toBe(5); });
  it('Sunday 08:30 after Friday 06:00Z -> Sunday 2026-11-08 08:30 local (02:45Z)', () => {
    expect(nextSlot(weekly(7, '08:30') as never, '2026-11-06T06:00:00.000Z' as never)).toBe('2026-11-08T02:45:00.000Z');
  });
  it('same weekday: before the send time -> today, after it -> next week', () => {
    expect(nextSlot(weekly(5, '07:00') as never, '2026-11-06T00:00:00.000Z' as never)).toBe('2026-11-06T01:15:00.000Z');
    expect(nextSlot(weekly(5, '07:00') as never, '2026-11-06T06:00:00.000Z' as never)).toBe('2026-11-13T01:15:00.000Z');
    expect(nextSlot(weekly(5, '07:00') as never, '2026-11-06T01:15:00.000Z' as never)).toBe('2026-11-13T01:15:00.000Z');
  });
  it('Monday 00:00 local is Sunday 18:15Z; the weekday is the LOCAL one (Sunday 17:45 local is still Sunday)', () => {
    expect(nextSlot(weekly(1, '00:00') as never, '2026-11-08T12:00:00.000Z' as never)).toBe('2026-11-08T18:15:00.000Z');
  });
  it.each([1, 2, 3, 4, 5, 6, 7])('weekday %i: lands on that local weekday, within 7 days, after `after`', (w) => {
    const after = '2026-11-06T06:00:00.000Z';
    const got = nextSlot(weekly(w, '08:30') as never, after as never);
    const local = new Date(Date.parse(got) + OFFSET_MS).toISOString();
    expect(isoWeekday(local.slice(0, 10))).toBe(w);
    expect(local.slice(11, 16)).toBe('08:30');
    expect(Date.parse(got)).toBeGreaterThan(Date.parse(after));
    expect(Date.parse(got) - Date.parse(after)).toBeLessThanOrEqual(7 * 86_400_000);
  });
});

describe('nextSlot — monthly_ad (the 1st of the next A.D. month)', () => {
  const m = (hm = '07:00') => ({ frequency: 'monthly_ad', send_time_local: hm, weekday: null });
  it('mid-month -> the 1st of the next month; December rolls into January', () => {
    expect(nextSlot(m() as never, '2026-11-06T06:00:00.000Z' as never)).toBe(npt('2026-12-01', '07:00'));
    expect(nextSlot(m() as never, '2026-12-15T06:00:00.000Z' as never)).toBe(npt('2027-01-01', '07:00'));
  });
  it('on the 1st before the send time -> that same day; after it -> next month', () => {
    expect(nextSlot(m() as never, '2026-11-01T00:00:00.000Z' as never)).toBe(npt('2026-11-01', '07:00'));
    expect(nextSlot(m() as never, npt('2026-11-01', '07:00') as never)).toBe(npt('2026-12-01', '07:00'));
  });
  it('the local month decides, not the UTC one: Oct 31 18:14:59.999Z is still October locally', () => {
    expect(nextSlot(m('00:00') as never, '2026-10-31T18:14:59.999Z' as never)).toBe('2026-10-31T18:15:00.000Z');
    expect(nextSlot(m('00:00') as never, '2026-10-31T18:15:00.000Z' as never)).toBe('2026-11-30T18:15:00.000Z');
  });
});

describe('nextSlot — monthly_bs (the 1st of the next B.S. month, golden table)', () => {
  const m = (hm = '07:00') => ({ frequency: 'monthly_bs', send_time_local: hm, weekday: null });
  it('mid-month -> the 1st of the next B.S. month at the send time', () => {
    expect(nextSlot(m() as never, npt(addDays(first(2082, 6), 9), '12:00') as never)).toBe(npt(first(2082, 7), '07:00'));
  });
  it('B.S. month rollover: Chaitra -> Baisakh of the next B.S. year', () => {
    expect(nextSlot(m() as never, npt(addDays(first(2083, 1), -5), '12:00') as never)).toBe(npt(first(2083, 1), '07:00'));
    expect(nextSlot(m() as never, npt(first(2082, 12), '07:00') as never)).toBe(npt(first(2083, 1), '07:00'));
  });
  it('on the B.S. 1st before the send time -> that day; exactly at it -> the next B.S. month', () => {
    expect(nextSlot(m() as never, npt(first(2082, 7), '05:00') as never)).toBe(npt(first(2082, 7), '07:00'));
    expect(nextSlot(m() as never, npt(first(2082, 7), '07:00') as never)).toBe(npt(first(2082, 8), '07:00'));
  });
  it('the chain of slots visits every B.S. month 2001..2098 in order (29..32-day months)', () => {
    const bad: string[] = [];
    for (const g of GOLDEN.filter((x) => x.bs_year >= 2001 && x.bs_year <= 2097)) {
      const next = g.bs_month === 12 ? golden(g.bs_year + 1, 1) : golden(g.bs_year, g.bs_month + 1);
      const got = nextSlot(m() as never, npt(g.ad_first_day, '07:00') as never);
      if (got !== npt(next.ad_first_day, '07:00')) bad.push(`${g.bs_year}-${g.bs_month}: got ${got}`);
    }
    expect(bad).toEqual([]);
  });
});

describe('nextSlot — purity (injected clock)', () => {
  it('does not read the system time: the same arguments give the same slot whatever "now" is', () => {
    const s = { frequency: 'weekly', send_time_local: '07:45', weekday: 3 };
    const want = nextSlot(s as never, '2026-11-06T06:00:00.000Z' as never);
    vi.useFakeTimers(); vi.setSystemTime(new Date('2041-02-03T04:05:06.000Z'));
    expect(nextSlot(s as never, '2026-11-06T06:00:00.000Z' as never)).toBe(want);
    vi.setSystemTime(new Date('1999-12-31T23:59:59.000Z'));
    expect(nextSlot(s as never, '2026-11-06T06:00:00.000Z' as never)).toBe(want);
  });
  it('result is always an ISO-8601 UTC string with milliseconds on a quarter hour', () => {
    const got = nextSlot({ frequency: 'daily', send_time_local: '07:45', weekday: null } as never, '2026-11-06T06:00:00.000Z' as never);
    expect(got).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/);
  });
});

// ============================================================================================ late slots (TRD §9.6 step 2a)
describe('isSlotLate — now − slot_start > 24 h (strict)', () => {
  const slot = '2026-11-05T01:15:00.000Z';
  it('exactly 24 h is not late, 24 h + 1 ms is late; a slot in the future is not late', () => {
    expect(isSlotLate(slot as never, '2026-11-06T01:15:00.000Z' as never)).toBe(false);
    expect(isSlotLate(slot as never, '2026-11-06T01:15:00.001Z' as never)).toBe(true);
    expect(isSlotLate(slot as never, '2026-11-05T01:15:00.000Z' as never)).toBe(false);
    expect(isSlotLate(slot as never, '2026-11-04T00:00:00.000Z' as never)).toBe(false);
  });
  it('3 days late is late', () => { expect(isSlotLate(slot as never, '2026-11-08T01:15:00.000Z' as never)).toBe(true); });
});

// ============================================================================================ names (07-SECURITY S3)
describe('validateScheduleName — 80 ok / 81 rejected / URLs, e-mail and phone-like names rejected', () => {
  it.each(VALID_NAMES.map((n) => [n.length > 20 ? `${n.slice(0, 8)}…(${[...n].length} chars)` : n, n]))('accepts %s', (_l, n) => { expect(() => validateScheduleName(n)).not.toThrow(); });

  it.each(INVALID_NAMES.map((n) => [n.length > 20 ? `${n.slice(0, 8)}…(${[...n].length} chars)` : JSON.stringify(n), n]))('rejects %s -> 400 common.validation_failed on the name field', (_l, n) => {
    let e: unknown;
    try { validateScheduleName(n); } catch (x) { e = x; }
    expect(e).toBeInstanceOf(LimsError);
    expect((e as LimsError).code).toBe('common.validation_failed');
    expect((e as LimsError).statusCode).toBe(400);
    expect((e as any).errors?.[0]?.path).toMatch(/name$/);
  });

  it.each([undefined, null, 42, {}, ['Daily'], true])('rejects the non-string %j', (v) => {
    expect(() => validateScheduleName(v)).toThrow(LimsError);
  });
});
