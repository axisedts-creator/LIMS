// AN-T02 domain/period.ts (02-TRD §4 resolvePeriod; PRD US-02.1–7, US-01.2 previous period, §8.1 time rules).
// Assumed API (TRD §4 signature; names not pinned elsewhere are listed in .orchestra/notes/AN-T02-tests.md):
//   resolvePeriod(q: PeriodQuery, today: IsoDate, maxDays: number): Period      — pure; throws LimsError
//   previousPeriod(p: Period): Period                                           — same length, immediately before p.from
//   businessDateOf(instant: IsoUtc): IsoDate                                    — Asia/Kathmandu business date (UTC+05:45)
//   Period = { from, to /* exclusive */, days, labelAd, labelBs, bsMonth?, fiscalYearBs? }
// All B.S. expectations come from the golden table (helpers.ts); nothing is hard-coded (US-02.7).
import { describe, expect, it } from 'vitest';
import { bsToAd, type IsoDate, type IsoUtc } from '../../../../../../../packages/shared-ts/src/bsdate/index.js';
import { businessDateOf, previousPeriod, resolvePeriod } from '../period.js';
import { GOLDEN, addDays, bsKey, diffDays, expectLims, golden, pad } from './helpers.js';

const D = (s: string) => s as IsoDate;
const U = (s: string) => s as IsoUtc;
const TODAY = D('2026-11-06');
const MAX = 366;
const VALIDATION = ['common.validation_failed', 400] as const;
const OUT_OF_RANGE = ['common.date_out_of_range', 422] as const;
const TOO_LARGE = ['analytics.range_too_large', 422] as const;
const PARAMS = ['business_date_from', 'business_date_to', 'bs_month', 'fiscal_year_bs'];

describe('US-02.1 bs_month -> [bsToAd(Y-M-1), first day of next B.S. month) — golden table, every month 2000..2099', () => {
  it('from/to/days/bsMonth match the golden table for all 1200 months (2099-12 included: its month is in range)', () => {
    const bad: string[] = [];
    for (const g of GOLDEN) {
      const key = bsKey(g.bs_year, g.bs_month);
      let p;
      try { p = resolvePeriod({ bs_month: key }, TODAY, MAX); } catch (e) { bad.push(`${key}: threw ${(e as Error).message}`); continue; }
      const to = addDays(g.ad_first_day, g.days);
      if (p.from !== g.ad_first_day || p.to !== to || p.days !== g.days || p.bsMonth !== key) bad.push(`${key}: got ${p.from}..${p.to} days=${p.days} bsMonth=${p.bsMonth}, want ${g.ad_first_day}..${to} days=${g.days}`);
    }
    expect(bad).toEqual([]);
  });

  it('exclusive end equals the first day of the next B.S. month (Chaitra rolls into next year Baisakh)', () => {
    const next = (y: number, m: number) => (m === 12 ? golden(y + 1, 1) : golden(y, m + 1));
    for (const [y, m] of [[2082, 12], [2082, 6], [2081, 1], [2083, 3]] as const) {
      expect(resolvePeriod({ bs_month: bsKey(y, m) }, TODAY, MAX).to).toBe(next(y, m).ad_first_day);
    }
  });

  it('returns both calendars in the labels (PRD §8.1: period headers show A.D. and B.S.)', () => {
    const g = golden(2082, 7);
    const p = resolvePeriod({ bs_month: bsKey(2082, 7) }, TODAY, MAX);
    expect(p.labelBs).toContain('2082');
    expect(p.labelAd).toContain(`${pad(Number(g.ad_first_day.slice(8)))}/${g.ad_first_day.slice(5, 7)}/${g.ad_first_day.slice(0, 4)}`); // DD/MM/YYYY of from
    expect(p.fiscalYearBs).toBeUndefined();
  });

  it('B.S. years below the golden table (1975..1999) still convert through bsdate', () => {
    const p = resolvePeriod({ bs_month: '1975-01' }, TODAY, MAX);
    expect(p.from).toBe(bsToAd({ year: 1975, month: 1, day: 1 }));
    expect(p.days).toBeGreaterThanOrEqual(29);
  });
});

describe('US-02.2 fiscal_year_bs -> fiscalYearBs().startsOn .. endsOn + 1 day (FY starts Shrawan 1)', () => {
  it('bounds match the golden table (Shrawan 1 of y .. Shrawan 1 of y+1, exclusive) for FY 2000/01 .. 2098/99', () => {
    const bad: string[] = [];
    for (let y = 2000; y <= 2098; y++) {
      const label = `${y}/${pad((y + 1) % 100)}`;
      const from = golden(y, 4).ad_first_day;
      const to = golden(y + 1, 4).ad_first_day;
      let p;
      try { p = resolvePeriod({ fiscal_year_bs: label }, TODAY, 400); } catch (e) { bad.push(`${label}: threw ${(e as Error).message}`); continue; }
      if (p.from !== from || p.to !== to || p.days !== diffDays(from, to) || p.fiscalYearBs !== label) bad.push(`${label}: got ${p.from}..${p.to} (${p.days}) want ${from}..${to}`);
    }
    expect(bad).toEqual([]);
  });

  it('the label is echoed and shown in labelBs', () => {
    const p = resolvePeriod({ fiscal_year_bs: '2082/83' }, TODAY, MAX);
    expect(p.fiscalYearBs).toBe('2082/83');
    expect(p.labelBs).toContain('2082/83');
  });

  it('a label that is not the FY of its own start year is rejected (fy.long must equal the input)', () => {
    for (const bad of ['2082/84', '2082/82', '2082/00']) expectLims(() => resolvePeriod({ fiscal_year_bs: bad }, TODAY, MAX), ...VALIDATION);
  });

  it('malformed labels -> 400 (not a crash)', () => {
    for (const bad of ['082/83', '2082-83', '2082/8', '2082/083', ' 2082/83', '2082/83 ', '']) expectLims(() => resolvePeriod({ fiscal_year_bs: bad }, TODAY, MAX), ...VALIDATION);
  });

  it('FY outside 1975..2099 B.S. -> 422 common.date_out_of_range', () => {
    for (const bad of ['1974/75', '2099/00', '2100/01']) expectLims(() => resolvePeriod({ fiscal_year_bs: bad }, TODAY, MAX), ...OUT_OF_RANGE);
  });
});

describe('US-02.3 selector exclusivity -> 400 common.validation_failed', () => {
  const cases: Array<[string, Record<string, string>]> = [
    ['bs_month + fiscal_year_bs', { bs_month: '2082-07', fiscal_year_bs: '2082/83' }],
    ['dates + bs_month', { business_date_from: '2026-11-01', business_date_to: '2026-11-08', bs_month: '2082-07' }],
    ['dates + fiscal_year_bs', { business_date_from: '2026-11-01', business_date_to: '2026-11-08', fiscal_year_bs: '2082/83' }],
    ['all three', { business_date_from: '2026-11-01', business_date_to: '2026-11-08', bs_month: '2082-07', fiscal_year_bs: '2082/83' }],
    ['from without to', { business_date_from: '2026-11-01' }],
    ['to without from', { business_date_to: '2026-11-08' }],
    ['from + bs_month (half a pair plus a selector)', { business_date_from: '2026-11-01', bs_month: '2082-07' }],
  ];
  it.each(cases)('%s', (_n, q) => {
    const e = expectLims(() => resolvePeriod(q, TODAY, MAX), ...VALIDATION);
    expect(e.errors?.length ?? 0).toBeGreaterThan(0);
    for (const err of e.errors ?? []) expect(PARAMS).toContain(err.path);
  });
});

describe('default and explicit A.D. ranges', () => {
  it('no selector -> today: [today, today+1) in business dates, one day', () => {
    expect(resolvePeriod({}, D('2026-11-06'), MAX)).toMatchObject({ from: '2026-11-06', to: '2026-11-07', days: 1 });
  });
  it('today+1 crosses month, year and leap-day boundaries', () => {
    expect(resolvePeriod({}, D('2026-12-31'), MAX).to).toBe('2027-01-01');
    expect(resolvePeriod({}, D('2028-02-28'), MAX).to).toBe('2028-02-29');
    expect(resolvePeriod({}, D('2028-02-29'), MAX).to).toBe('2028-03-01');
    expect(resolvePeriod({}, D('2026-02-28'), MAX).to).toBe('2026-03-01');
  });
  it('explicit dates are half-open: to is exclusive', () => {
    expect(resolvePeriod({ business_date_from: '2026-11-01', business_date_to: '2026-11-08' }, TODAY, MAX)).toMatchObject({ from: '2026-11-01', to: '2026-11-08', days: 7 });
  });
  it('from >= to -> 400', () => {
    expectLims(() => resolvePeriod({ business_date_from: '2026-11-08', business_date_to: '2026-11-08' }, TODAY, MAX), ...VALIDATION);
    expectLims(() => resolvePeriod({ business_date_from: '2026-11-09', business_date_to: '2026-11-08' }, TODAY, MAX), ...VALIDATION);
  });
  it('impossible or malformed dates -> 400, never a 500', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '2026-00-10', 'abc', '2026-1-1', '20261101', '2026-11-01T00:00:00Z', '']) {
      expectLims(() => resolvePeriod({ business_date_from: bad, business_date_to: '2027-01-01' }, TODAY, MAX), ...VALIDATION);
    }
  });
});

describe('US-02.4 maximum range (LIMS_ANALYTICS_MAX_RANGE_DAYS = 366)', () => {
  it('366 days is accepted, 367 -> 422 analytics.range_too_large', () => {
    expect(resolvePeriod({ business_date_from: '2026-01-01', business_date_to: '2027-01-02' }, TODAY, MAX).days).toBe(366);
    expectLims(() => resolvePeriod({ business_date_from: '2026-01-01', business_date_to: '2027-01-03' }, TODAY, MAX), ...TOO_LARGE);
  });
  it('the limit is the maxDays argument, not a constant', () => {
    expect(resolvePeriod({ business_date_from: '2026-11-01', business_date_to: '2026-12-02' }, TODAY, 31).days).toBe(31);
    expectLims(() => resolvePeriod({ business_date_from: '2026-11-01', business_date_to: '2026-12-03' }, TODAY, 31), ...TOO_LARGE);
  });
  it('applies to bs_month and fiscal_year_bs too', () => {
    expectLims(() => resolvePeriod({ bs_month: '2082-07' }, TODAY, 20), ...TOO_LARGE);
    expectLims(() => resolvePeriod({ fiscal_year_bs: '2082/83' }, TODAY, 300), ...TOO_LARGE);
  });
  it('a huge range is rejected without iterating (fast)', () => {
    const t = Date.now();
    expectLims(() => resolvePeriod({ business_date_from: '0001-01-01', business_date_to: '9999-12-31' }, TODAY, MAX), ...TOO_LARGE);
    expect(Date.now() - t).toBeLessThan(200);
  });
});

describe('US-02.5 B.S. month outside 1975–2099 -> 422 common.date_out_of_range; bad syntax -> 400', () => {
  it('years outside the supported range', () => {
    for (const bad of ['1974-12', '2100-01', '0000-01', '9999-12']) expectLims(() => resolvePeriod({ bs_month: bad }, TODAY, MAX), ...OUT_OF_RANGE);
  });
  it('the range edges are valid', () => {
    expect(resolvePeriod({ bs_month: '1975-01' }, TODAY, MAX).bsMonth).toBe('1975-01');
    expect(resolvePeriod({ bs_month: '2099-12' }, TODAY, MAX).bsMonth).toBe('2099-12');
  });
  it('syntax outside ^[0-9]{4}-(0[1-9]|1[0-2])$ -> 400', () => {
    for (const bad of ['2082-13', '2082-00', '2082-7', '82-07', '2082/07', '2082-07-01', '2082-07 ', '', '2082-07; DROP TABLE x', 'x'.repeat(10_000)]) {
      expectLims(() => resolvePeriod({ bs_month: bad }, TODAY, MAX), ...VALIDATION);
    }
  });
  it('non-string input from a hostile caller -> 400, not a TypeError', () => {
    for (const bad of [20820, null, {}, [], ['2082-07'], true]) {
      expectLims(() => resolvePeriod({ bs_month: bad as unknown as string }, TODAY, MAX), ...VALIDATION);
    }
  });
});

describe('US-02.6 business date = Asia/Kathmandu day; midnight there is 18:15 UTC', () => {
  it('18:14:59.999Z is still 2026-11-05, 18:15:00.000Z is 2026-11-06', () => {
    expect(businessDateOf(U('2026-11-05T18:14:59.999Z'))).toBe('2026-11-05');
    expect(businessDateOf(U('2026-11-05T18:15:00.000Z'))).toBe('2026-11-06');
  });
  it('the boundary holds across month, year and leap day', () => {
    expect(businessDateOf(U('2026-12-31T18:14:59.999Z'))).toBe('2026-12-31');
    expect(businessDateOf(U('2026-12-31T18:15:00.000Z'))).toBe('2027-01-01');
    expect(businessDateOf(U('2028-02-28T18:14:59.999Z'))).toBe('2028-02-28');
    expect(businessDateOf(U('2028-02-28T18:15:00.000Z'))).toBe('2028-02-29');
  });
  it('a UTC clock-day is not the business day: 00:00Z and 12:00Z are same-day, 18:30Z is next day', () => {
    expect(businessDateOf(U('2026-11-06T00:00:00.000Z'))).toBe('2026-11-06');
    expect(businessDateOf(U('2026-11-06T12:00:00.000Z'))).toBe('2026-11-06');
    expect(businessDateOf(U('2026-11-06T18:30:00.000Z'))).toBe('2026-11-07');
  });
  it('garbage is rejected', () => {
    for (const bad of ['', 'garbage', '2026-11-05', '2026-13-45T00:00:00Z']) expect(() => businessDateOf(U(bad))).toThrow();
  });
});

describe('previous period (dashboard deltas, US-01.2): same length, immediately before from', () => {
  it('one day -> the day before', () => {
    expect(previousPeriod(resolvePeriod({}, D('2026-11-06'), MAX))).toMatchObject({ from: '2026-11-05', to: '2026-11-06', days: 1 });
  });
  it('7-day range crosses a month boundary', () => {
    const p = previousPeriod(resolvePeriod({ business_date_from: '2026-11-01', business_date_to: '2026-11-08' }, TODAY, MAX));
    expect(p).toMatchObject({ from: '2026-10-25', to: '2026-11-01', days: 7 });
  });
  it('year and leap-day boundaries', () => {
    expect(previousPeriod(resolvePeriod({}, D('2027-01-01'), MAX))).toMatchObject({ from: '2026-12-31', to: '2027-01-01' });
    expect(previousPeriod(resolvePeriod({}, D('2028-03-01'), MAX))).toMatchObject({ from: '2028-02-29', to: '2028-03-01' });
  });
  it('a B.S. month compares with the equal number of days before it (not the previous B.S. month)', () => {
    const g = golden(2082, 7);
    const p = resolvePeriod({ bs_month: bsKey(2082, 7) }, TODAY, MAX);
    const prev = previousPeriod(p);
    expect(prev.to).toBe(g.ad_first_day);
    expect(prev.days).toBe(g.days);
    expect(prev.from).toBe(addDays(g.ad_first_day, -g.days));
  });
  it('contiguous and equal length for every golden month; labels are present strings', () => {
    const bad: string[] = [];
    for (const g of GOLDEN.filter((_, i) => i % 7 === 0)) {
      const p = resolvePeriod({ bs_month: bsKey(g.bs_year, g.bs_month) }, TODAY, MAX);
      const q = previousPeriod(p);
      if (q.to !== p.from || q.days !== p.days || diffDays(q.from, q.to) !== q.days || !q.labelAd || !q.labelBs) bad.push(bsKey(g.bs_year, g.bs_month));
    }
    expect(bad).toEqual([]);
  });
  it('does not mutate its input', () => {
    const p = resolvePeriod({}, TODAY, MAX);
    const snap = JSON.stringify(p);
    previousPeriod(p);
    expect(JSON.stringify(p)).toBe(snap);
  });
});
