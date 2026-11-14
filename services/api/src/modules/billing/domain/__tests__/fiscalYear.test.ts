// BL-T02 domain/fiscalYear.ts (02-TRD §12 "FY derivation"; US-BL-01.3; 01 §4.8: FY 2082/83 commenced 1 Shrawan = 17 Jul 2025).
// Assumed API: fiscalYearOf(instant: IsoUtc, timezone = 'Asia/Kathmandu') -> { short: '082/83', long: '2082/83' }   (via @lims/shared-ts/bsdate)
//   checkFiscalYear(allocatedAt, timezone, expectedLong) -> {ok:true} | {ok:false, code:'billing.counter_busy', detail:'fiscal_year_rollover'}  (TRD §12 step 3)
import { describe, expect, it } from 'vitest';
import { adToBs, bsToAd, type IsoUtc } from '../../../../../../../packages/shared-ts/src/bsdate/index.js'; // services/api does not alias @lims/shared-ts yet (see core/errors.ts)
import { checkFiscalYear, fiscalYearOf } from '../fiscalYear.js';

const utc = (s: string) => s as IsoUtc;
const KTM = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kathmandu', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const ktmLocal = (t: number): string => { const p = Object.fromEntries(KTM.formatToParts(t).map((x) => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; };
/** Instant at 00:00 Asia/Kathmandu of an A.D. date, plus `ms`. Offset comes from the zone (+05:30 before 1986-01-01, +05:45 after), not a constant. */
const nptMidnight = (ad: string, ms = 0): IsoUtc => {
  for (const off of [(5 * 60 + 45) * 60_000, (5 * 60 + 30) * 60_000]) {
    const t = Date.parse(`${ad}T00:00:00Z`) - off;
    if (ktmLocal(t) === `${ad}T00:00`) return new Date(t + ms).toISOString() as IsoUtc;
  }
  throw new Error(`no Asia/Kathmandu midnight for ${ad}`);
};

describe('fiscalYearOf — 01 §4.8 boundary (Shrawan 1 2082 = 2025-07-17)', () => {
  it('2025-07-16 23:59 NPT -> 2081/82', () => {
    expect(fiscalYearOf(utc('2025-07-16T18:14:00.000Z'))).toMatchObject({ long: '2081/82', short: '081/82' });
  });
  it('2025-07-16 23:59:59.999 NPT (one ms before) -> 2081/82', () => {
    expect(fiscalYearOf(utc('2025-07-16T18:14:59.999Z')).long).toBe('2081/82');
  });
  it('2025-07-17 00:00 NPT -> 2082/83, short 082/83', () => {
    expect(fiscalYearOf(utc('2025-07-16T18:15:00.000Z'))).toMatchObject({ long: '2082/83', short: '082/83' });
  });
  it('a UTC instant that is still 16 Jul in UTC but 17 Jul in Kathmandu already belongs to 2082/83', () => {
    expect(fiscalYearOf(utc('2025-07-16T20:00:00Z')).long).toBe('2082/83');
  });
  it('the same instant in another timezone uses THAT calendar date (tenant tz, not server tz)', () => {
    expect(fiscalYearOf(utc('2025-07-16T18:15:00.000Z'), 'UTC').long).toBe('2081/82');
    expect(fiscalYearOf(utc('2025-07-16T18:15:00.000Z'), 'Asia/Kathmandu').long).toBe('2082/83');
  });
  it('default timezone is Asia/Kathmandu (02-CV §4.8)', () => {
    expect(fiscalYearOf(utc('2025-07-16T18:15:00.000Z')).long).toBe(fiscalYearOf(utc('2025-07-16T18:15:00.000Z'), 'Asia/Kathmandu').long);
  });
  it('end of year: one minute before Shrawan 1 2083 is still 2082/83; Shrawan 1 2083 starts 2083/84', () => {
    const shrawan1 = bsToAd({ year: 2083, month: 4, day: 1 });
    expect(fiscalYearOf(nptMidnight(shrawan1, -60_000)).long).toBe('2082/83');
    expect(fiscalYearOf(nptMidnight(shrawan1)).long).toBe('2083/84');
  });
  it('mid-year dates: Baisakh, Poush and Chaitra belong to the year that started the previous Shrawan', () => {
    expect(fiscalYearOf(utc('2025-04-20T06:00:00Z')).long).toBe('2081/82'); // Baisakh 2082
    expect(fiscalYearOf(utc('2026-01-05T06:00:00Z')).long).toBe('2082/83'); // Poush 2082
    expect(fiscalYearOf(utc('2026-04-10T06:00:00Z')).long).toBe('2082/83'); // Chaitra 2082
  });
});

describe('fiscalYearOf — shared B.S. table sweep 2000..2099 (every Shrawan 1)', () => {
  it('1 Shrawan 00:00 NPT starts FY y/(y+1); one minute earlier is the previous FY', () => {
    const fmt = (y: number) => `${y}/${String((y + 1) % 100).padStart(2, '0')}`;
    for (let y = 2000; y <= 2099; y++) {
      const ad = bsToAd({ year: y, month: 4, day: 1 });
      expect(adToBs(ad)).toMatchObject({ year: y, month: 4, day: 1 });
      expect(fiscalYearOf(nptMidnight(ad)).long, `Shrawan 1 ${y}`).toBe(fmt(y));
      expect(fiscalYearOf(nptMidnight(ad, 5 * 3_600_000)).long, `Shrawan 1 ${y} 05:00`).toBe(fmt(y));
      expect(fiscalYearOf(nptMidnight(ad, -60_000)).long, `before Shrawan 1 ${y}`).toBe(fmt(y - 1));
    }
  });
  it('long always matches the DB check invoices__fy__ck ^[0-9]{4}/[0-9]{2}$ and short is long without the leading digit', () => {
    for (const i of ['2025-07-17T00:00:00Z', '2030-01-01T00:00:00Z', '2042-12-31T12:00:00Z']) {
      const fy = fiscalYearOf(utc(i));
      expect(fy.long).toMatch(/^[0-9]{4}\/[0-9]{2}$/);
      expect(fy.short).toBe(fy.long.slice(1));
    }
  });
  it('century roll: FY 2099/00', () => {
    const ad = bsToAd({ year: 2099, month: 4, day: 1 });
    expect(fiscalYearOf(nptMidnight(ad)).long).toBe('2099/00');
  });
});

describe('fiscalYearOf — bad input', () => {
  it.each(['', 'not-a-date', '2025-07-17', '2025-13-01T00:00:00Z'])('rejects %j', (bad) => {
    expect(() => fiscalYearOf(utc(bad))).toThrow();
  });
  it('out of the B.S. range throws common.date_out_of_range', () => {
    expect(() => fiscalYearOf(utc('1900-01-01T00:00:00Z'))).toThrowError(expect.objectContaining({ code: 'common.date_out_of_range' }));
  });
});

describe('checkFiscalYear — allocation straddling midnight is never numbered in the wrong FY (US-BL-01.3, TRD §12 step 3)', () => {
  it('same FY -> ok', () => {
    expect(checkFiscalYear(utc('2025-07-16T18:14:00Z'), 'Asia/Kathmandu', '2081/82')).toEqual({ ok: true });
    expect(checkFiscalYear(utc('2025-07-16T18:15:00Z'), 'Asia/Kathmandu', '2082/83')).toEqual({ ok: true });
  });
  it('counter row read for 2081/82 but allocated_at already in 2082/83 -> billing.counter_busy / fiscal_year_rollover', () => {
    expect(checkFiscalYear(utc('2025-07-16T18:15:00Z'), 'Asia/Kathmandu', '2081/82')).toEqual({
      ok: false, code: 'billing.counter_busy', detail: 'fiscal_year_rollover',
    });
  });
  it('and the other way round', () => {
    expect(checkFiscalYear(utc('2025-07-16T18:14:00Z'), 'Asia/Kathmandu', '2082/83')).toMatchObject({ ok: false, code: 'billing.counter_busy' });
  });
});
