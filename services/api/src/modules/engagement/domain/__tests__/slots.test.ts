// C16 T-02 slots.ts (02-TRD §4.8 "Slot generation"; 05-SCHEMA slot_templates/blackouts/occupancy; US-EN-12.1, 12.7).
// Assumed API (pure; timezone injected; Date in/out; localDate 'YYYY-MM-DD'; weekdays ISO 1=Mon..7=Sun):
//   generateSlots({template, localDate, timeZone}) -> [{slotStart: Date, slotEnd: Date}]  (ascending)
//   availableSlots({templates, blackouts, occupancy, bookingKind, now, minLeadMinutes, horizonDays, timeZone, dateFrom, dateTo})
//       -> [{slotStart: Date, slotEnd: Date, capacity: number, remaining: number}]  (ascending)
//   template  {weekdays, startLocal:'HH:MM', endLocal:'HH:MM', slotMinutes, capacity, effectiveFrom, effectiveTo|null}
//   blackout  {bookingKind: string|null, startsAt: Date, endsAt: Date}
//   occupancy {slotStart: Date, capacity: number, booked: number}
// Fixture: 2026-11-16 is a Monday; Asia/Kathmandu = UTC+05:45 (07:00 local = 01:15Z).
import { describe, expect, it } from 'vitest';
import { availableSlots, generateSlots } from '../slots.js';

const NPT = 'Asia/Kathmandu';
const weekdayTpl = { weekdays: [1, 2, 3, 4, 5], startLocal: '07:00', endLocal: '11:00', slotMinutes: 15, capacity: 3, effectiveFrom: '2026-01-01', effectiveTo: null };
const allDays = { ...weekdayTpl, weekdays: [1, 2, 3, 4, 5, 6, 7] };
const z = (s: string) => new Date(s);
const iso = (xs: { slotStart: Date }[]) => xs.map((x) => x.slotStart.toISOString());

describe('generateSlots (t + slot_minutes <= end_local)', () => {
  it('07:00–11:00 / 15 min on a Monday = 16 slots, local time converted to UTC', () => {
    const s = generateSlots({ template: weekdayTpl, localDate: '2026-11-16', timeZone: NPT });
    expect(s).toHaveLength(16);
    expect(s[0]!.slotStart).toEqual(z('2026-11-16T01:15:00Z'));
    expect(s[0]!.slotEnd).toEqual(z('2026-11-16T01:30:00Z'));
    expect(s[15]!.slotStart).toEqual(z('2026-11-16T05:00:00Z')); // 10:45 local
    expect(s[15]!.slotEnd).toEqual(z('2026-11-16T05:15:00Z')); // 11:00 local
  });
  it('the same template in UTC is not shifted', () =>
    expect(generateSlots({ template: weekdayTpl, localDate: '2026-11-16', timeZone: 'UTC' })[0]!.slotStart).toEqual(z('2026-11-16T07:00:00Z')));
  it('end_local not a multiple of slot_minutes: partial last slot dropped (07:00–10:50 -> 15 slots, last ends 10:45)', () => {
    const s = generateSlots({ template: { ...weekdayTpl, endLocal: '10:50' }, localDate: '2026-11-16', timeZone: NPT });
    expect(s).toHaveLength(15);
    expect(s[14]!.slotEnd).toEqual(z('2026-11-16T05:00:00Z'));
  });
  it('slot exactly fills the window -> one slot', () =>
    expect(generateSlots({ template: { ...weekdayTpl, slotMinutes: 240 }, localDate: '2026-11-16', timeZone: NPT })).toHaveLength(1));
  it('end-of-day: 23:00–23:59 / 30 min -> only 23:00–23:30 (23:30 slot would cross midnight)', () => {
    const s = generateSlots({ template: { ...allDays, startLocal: '23:00', endLocal: '23:59', slotMinutes: 30 }, localDate: '2026-11-16', timeZone: NPT });
    expect(s).toHaveLength(1);
    expect(s[0]!.slotStart).toEqual(z('2026-11-16T17:15:00Z'));
  });
  it('weekday not in template -> none (Saturday 2026-11-14, Sunday 2026-11-15)', () => {
    expect(generateSlots({ template: weekdayTpl, localDate: '2026-11-14', timeZone: NPT })).toEqual([]);
    expect(generateSlots({ template: weekdayTpl, localDate: '2026-11-15', timeZone: NPT })).toEqual([]);
  });
  it('effective_from / effective_to are inclusive local dates', () => {
    const t = { ...weekdayTpl, effectiveFrom: '2026-11-16', effectiveTo: '2026-11-17' };
    expect(generateSlots({ template: t, localDate: '2026-11-13', timeZone: NPT })).toEqual([]);
    expect(generateSlots({ template: t, localDate: '2026-11-16', timeZone: NPT })).toHaveLength(16);
    expect(generateSlots({ template: t, localDate: '2026-11-17', timeZone: NPT })).toHaveLength(16);
    expect(generateSlots({ template: t, localDate: '2026-11-18', timeZone: NPT })).toEqual([]);
  });
});

const baseInput = {
  templates: [weekdayTpl],
  blackouts: [] as never[],
  occupancy: [] as never[],
  bookingKind: 'centre_visit',
  now: z('2026-11-16T00:00:00Z'), // 05:45 local Monday
  minLeadMinutes: 120,
  horizonDays: 14,
  timeZone: NPT,
  dateFrom: '2026-11-16',
  dateTo: '2026-11-16',
};

describe('availableSlots — lead time (slot_start >= now + lead, inclusive)', () => {
  it('first slot is exactly now+120 min (07:45 local); 07:30 is excluded', () => {
    const r = availableSlots(baseInput as never);
    expect(iso(r)[0]).toBe('2026-11-16T02:00:00.000Z');
    expect(iso(r)).not.toContain('2026-11-16T01:45:00.000Z');
    expect(r).toHaveLength(13); // 07:45 … 10:45
  });
  it('lead 0: slot starting exactly now is included, earlier ones are not', () => {
    const r = availableSlots({ ...baseInput, now: z('2026-11-16T02:00:00Z'), minLeadMinutes: 0 } as never);
    expect(iso(r)[0]).toBe('2026-11-16T02:00:00.000Z');
  });
  it('now = start of the last slot, lead 0 -> only that slot remains; one ms later -> none', () => {
    expect(iso(availableSlots({ ...baseInput, now: z('2026-11-16T05:00:00Z'), minLeadMinutes: 0 } as never))).toEqual(['2026-11-16T05:00:00.000Z']);
    expect(availableSlots({ ...baseInput, now: z('2026-11-16T05:00:00.001Z'), minLeadMinutes: 0 } as never)).toEqual([]);
  });
  it('returns remaining = capacity and ascending order for an empty occupancy', () => {
    const r = availableSlots({ ...baseInput, minLeadMinutes: 0, now: z('2026-11-15T00:00:00Z') } as never);
    expect(r.every((s) => s.remaining === 3 && s.capacity === 3)).toBe(true);
    expect(iso(r)).toEqual([...iso(r)].sort());
  });
});

describe('availableSlots — horizon (slot_start < local midnight of today + horizon_days)', () => {
  const wide = { ...baseInput, templates: [allDays], minLeadMinutes: 0, now: z('2026-11-16T00:00:00Z'), dateFrom: '2026-11-16', dateTo: '2026-12-05' };
  it('last local day inside the window (2026-11-29) is served; 2026-11-30 is not', () => {
    const r = availableSlots(wide as never);
    expect(iso(r).at(-1)).toBe('2026-11-29T05:00:00.000Z'); // 10:45 local on 11-29
    expect(r.some((s) => s.slotStart >= z('2026-11-29T18:15:00Z'))).toBe(false);
  });
  it('a slot starting exactly at the horizon boundary (00:00 local 2026-11-30) is excluded; 11-29 00:00 is included', () => {
    const midnight = { ...allDays, startLocal: '00:00', endLocal: '00:30', slotMinutes: 30 };
    const r = availableSlots({ ...wide, templates: [midnight] } as never);
    expect(iso(r)).toContain('2026-11-28T18:15:00.000Z'); // 11-29 00:00 local
    expect(iso(r)).not.toContain('2026-11-29T18:15:00.000Z'); // 11-30 00:00 local
  });
  it('horizon follows the local date, not UTC (now 23:00Z on 11-15 is already 11-16 local)', () => {
    const r = availableSlots({ ...wide, now: z('2026-11-15T23:00:00Z'), dateFrom: '2026-11-29', dateTo: '2026-11-30' } as never);
    expect(r.every((s) => s.slotStart < z('2026-11-29T18:15:00Z'))).toBe(true);
    expect(r.length).toBeGreaterThan(0);
  });
});

describe('availableSlots — blackouts (overlap = slot_start < end AND slot_end > start)', () => {
  const bo = (startsAt: string, endsAt: string, bookingKind: string | null = null) => ({ bookingKind, startsAt: z(startsAt), endsAt: z(endsAt) });
  const run = (blackouts: unknown[], bookingKind = 'centre_visit') =>
    iso(availableSlots({ ...baseInput, bookingKind, blackouts, minLeadMinutes: 0, now: z('2026-11-15T00:00:00Z') } as never));
  const all = run([]);

  it('edges are exclusive: slot ending at blackout start and slot starting at blackout end both survive', () => {
    // blackout 08:45–09:15 local = 03:00Z–03:30Z
    const r = run([bo('2026-11-16T03:00:00Z', '2026-11-16T03:30:00Z')]);
    expect(r).toContain('2026-11-16T02:45:00.000Z'); // 08:30–08:45
    expect(r).not.toContain('2026-11-16T03:00:00.000Z'); // 08:45
    expect(r).not.toContain('2026-11-16T03:15:00.000Z'); // 09:00
    expect(r).toContain('2026-11-16T03:30:00.000Z'); // 09:15
    expect(all.length - r.length).toBe(2);
  });
  it('a partial overlap removes the slot (blackout 08:50–09:10 local removes 08:45 and 09:00)', () => {
    const r = run([bo('2026-11-16T03:05:00Z', '2026-11-16T03:25:00Z')]);
    expect(all.length - r.length).toBe(2);
    expect(r).not.toContain('2026-11-16T03:00:00.000Z');
    expect(r).not.toContain('2026-11-16T03:15:00.000Z');
  });
  it('blackout covering the whole day removes every slot', () => expect(run([bo('2026-11-15T18:15:00Z', '2026-11-16T18:15:00Z')])).toEqual([]));
  it('kind NULL blackout hits every kind; a home_collection blackout does not hit centre_visit', () => {
    expect(run([bo('2026-11-16T03:00:00Z', '2026-11-16T03:30:00Z', null)], 'centre_visit')).not.toContain('2026-11-16T03:00:00.000Z');
    expect(run([bo('2026-11-16T03:00:00Z', '2026-11-16T03:30:00Z', 'home_collection')], 'centre_visit')).toEqual(all);
    expect(run([bo('2026-11-16T03:00:00Z', '2026-11-16T03:30:00Z', 'centre_visit')], 'centre_visit')).not.toContain('2026-11-16T03:00:00.000Z');
  });
});

describe('availableSlots — remaining capacity (US-EN-12.1: only remaining > 0)', () => {
  const occ = (slotStart: string, booked: number, capacity = 3) => ({ slotStart: z(slotStart), capacity, booked });
  const run = (occupancy: unknown[]) => availableSlots({ ...baseInput, occupancy, minLeadMinutes: 0, now: z('2026-11-15T00:00:00Z') } as never);

  it('absent row = template capacity; booked 2/3 -> remaining 1; full slot is hidden', () => {
    const r = run([occ('2026-11-16T02:00:00Z', 2), occ('2026-11-16T02:15:00Z', 3)]);
    expect(r.find((s) => s.slotStart.toISOString() === '2026-11-16T02:00:00.000Z')!.remaining).toBe(1);
    expect(iso(r)).not.toContain('2026-11-16T02:15:00.000Z');
    expect(r.find((s) => s.slotStart.toISOString() === '2026-11-16T02:30:00.000Z')!.remaining).toBe(3);
  });
  it('overbooked (booked > capacity after a capacity cut) is hidden, never negative', () => {
    const r = run([occ('2026-11-16T02:00:00Z', 5)]);
    expect(iso(r)).not.toContain('2026-11-16T02:00:00.000Z');
    expect(r.every((s) => s.remaining > 0)).toBe(true);
  });
});
