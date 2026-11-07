// API-T02 — 02-TRD §5.9 / §6.4 step 10: local instrument time + IANA zone -> UTC IsoUtc; agent/instrument clock offsets.
// Expected API (domain/instrumentTime.ts):
//   localToUtc(local: 'YYYY-MM-DDTHH:mm:ss[.sss]' (no offset), timeZone: string): IsoUtc   throws on malformed input / unknown zone
//   capturedAt(capturedAtAgent: IsoUtc, clockOffsetMs: number): IsoUtc                      captured_at_agent + clock_offset_ms
//   instrumentClockOffsetSeconds(instrumentTimeUtc: IsoUtc, capturedAt: IsoUtc): number     round((instrument - captured)/1 s)
import { describe, expect, it } from 'vitest';
import { capturedAt, instrumentClockOffsetSeconds, localToUtc } from '../../domain/instrumentTime.js';

const ISO_UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

describe('localToUtc', () => {
  it.each([
    ['2026-11-07T14:30:05', 'UTC', '2026-11-07T14:30:05.000Z'],
    ['2026-11-07T14:30:05', 'Asia/Kathmandu', '2026-11-07T08:45:05.000Z'], // +05:45
    ['2026-11-07T14:30:05', 'Asia/Kolkata', '2026-11-07T09:00:05.000Z'], // +05:30
    ['2026-01-15T08:00:00', 'America/New_York', '2026-01-15T13:00:00.000Z'], // EST -05:00
    ['2026-07-15T08:00:00', 'America/New_York', '2026-07-15T12:00:00.000Z'], // EDT -04:00
    ['2026-11-07T00:00:00', 'Asia/Kathmandu', '2026-11-06T18:15:00.000Z'], // crosses the date line
    ['2026-11-07T14:30:05.250', 'UTC', '2026-11-07T14:30:05.250Z'],
  ])('%s in %s -> %s', (local, tz, utc) => {
    const out = localToUtc(local, tz);
    expect(out).toBe(utc);
    expect(out).toMatch(ISO_UTC);
  });
  it.each(['', 'not a time', '2026-13-01T00:00:00', '2026-02-30T10:00:00', '2026-11-07T25:00:00', '2026-11-07T14:30:05Z', '2026-11-07T14:30:05+05:45'])(
    'rejects malformed / already-offset local time %j',
    (bad) => expect(() => localToUtc(bad, 'UTC')).toThrow(),
  );
  it.each(['Not/AZone', '', 'UTC+5', "Asia/Kathmandu'; DROP TABLE x;--"])('rejects unknown zone %j', (tz) =>
    expect(() => localToUtc('2026-11-07T14:30:05', tz)).toThrow(),
  );
});

describe('capturedAt (captured_at_agent + clock_offset_ms)', () => {
  it('applies positive and negative offsets', () => {
    expect(capturedAt('2026-11-07T10:00:00.000Z', 1500)).toBe('2026-11-07T10:00:01.500Z');
    expect(capturedAt('2026-11-07T10:00:00.000Z', -61000)).toBe('2026-11-07T09:58:59.000Z');
    expect(capturedAt('2026-11-07T10:00:00.000Z', 0)).toBe('2026-11-07T10:00:00.000Z');
  });
  it('handles the schema extreme (|offset| = 10^9 ms) without overflow', () => {
    expect(capturedAt('2026-11-07T10:00:00.000Z', 1_000_000_000)).toMatch(ISO_UTC);
  });
  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5])('rejects non-integer / non-finite offset %s', (o) =>
    expect(() => capturedAt('2026-11-07T10:00:00.000Z', o)).toThrow(),
  );
});

describe('instrumentClockOffsetSeconds', () => {
  const C = '2026-11-07T10:00:00.000Z';
  it('instrument ahead / behind / equal', () => {
    expect(instrumentClockOffsetSeconds('2026-11-07T10:01:30.000Z', C)).toBe(90);
    expect(instrumentClockOffsetSeconds('2026-11-07T09:58:30.000Z', C)).toBe(-90);
    expect(instrumentClockOffsetSeconds(C, C)).toBe(0);
  });
  it('rounds to whole seconds', () => {
    expect(instrumentClockOffsetSeconds('2026-11-07T10:00:02.400Z', C)).toBe(2);
    expect(instrumentClockOffsetSeconds('2026-11-07T10:00:02.600Z', C)).toBe(3);
  });
});
