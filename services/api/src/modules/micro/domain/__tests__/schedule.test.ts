// C10 T-04 — pure domain: read/final schedule maths (02-TRD §4.1), AC-03.1 (first read), AC-03.2 (final hours fallback), AC-04.2.
// Seams expected from the writer (spec does not fix signatures):
//   ../schedule.ts   (all Date-in / Date-out; no clock access — `now` is an argument)
//     export function nextReadDueAt(i: { plantedAt: Date; readScheduleHours: readonly number[]; latestReadObservedAt?: Date | null }): Date | null;
//         // smallest h with plantedAt + h hours STRICTLY > latestReadObservedAt (or > plantedAt when none); null when exhausted
//     export function finalDueAt(i: { plantedAt: Date; finalNoGrowthHours?: number | null; defaultFinalNoGrowthHours: number }): Date;
//         // protocol hours when given (not null/undefined), else micro.settings.default_final_no_growth_hours
//     export function hoursSincePlanting(plantedAt: Date, observedAt: Date): number;   // hours, rounded to 2 decimals
//     export function isReadOverdue(i: { status: string; nextReadDueAt: Date | null; now: Date }): boolean;
import { describe, expect, it } from 'vitest';
import { finalDueAt, hoursSincePlanting, isReadOverdue, nextReadDueAt } from '../schedule.js';

const P = new Date('2030-03-01T08:00:00Z');
const at = (h: number) => new Date(P.getTime() + h * 3_600_000);
const SCHED = [18, 24, 48]; // synthetic

describe('nextReadDueAt (AC-03.1, AC-04.2)', () => {
  it('no reads yet -> planted_at + first hour', () => {
    expect(nextReadDueAt({ plantedAt: P, readScheduleHours: SCHED })).toEqual(at(18));
    expect(nextReadDueAt({ plantedAt: P, readScheduleHours: SCHED, latestReadObservedAt: null })).toEqual(at(18));
  });
  it('read before the first slot keeps the first slot', () => expect(nextReadDueAt({ plantedAt: P, readScheduleHours: SCHED, latestReadObservedAt: at(2) })).toEqual(at(18)));
  it('read between slots moves to the next later slot', () => {
    expect(nextReadDueAt({ plantedAt: P, readScheduleHours: SCHED, latestReadObservedAt: at(20) })).toEqual(at(24));
    expect(nextReadDueAt({ plantedAt: P, readScheduleHours: SCHED, latestReadObservedAt: at(30) })).toEqual(at(48));
  });
  it('read exactly on a slot -> strictly later slot', () => {
    expect(nextReadDueAt({ plantedAt: P, readScheduleHours: SCHED, latestReadObservedAt: at(18) })).toEqual(at(24));
    expect(nextReadDueAt({ plantedAt: P, readScheduleHours: SCHED, latestReadObservedAt: at(48) })).toBeNull();
  });
  it('one millisecond before a slot keeps that slot', () => {
    expect(nextReadDueAt({ plantedAt: P, readScheduleHours: SCHED, latestReadObservedAt: new Date(at(24).getTime() - 1) })).toEqual(at(24));
  });
  it('schedule exhausted -> null', () => {
    expect(nextReadDueAt({ plantedAt: P, readScheduleHours: SCHED, latestReadObservedAt: at(49) })).toBeNull();
    expect(nextReadDueAt({ plantedAt: P, readScheduleHours: [], latestReadObservedAt: null })).toBeNull();
  });
  it('single-slot schedule', () => {
    expect(nextReadDueAt({ plantedAt: P, readScheduleHours: [24] })).toEqual(at(24));
    expect(nextReadDueAt({ plantedAt: P, readScheduleHours: [24], latestReadObservedAt: at(24) })).toBeNull();
  });
  it('takes the smallest qualifying h even if the array is unsorted', () => {
    expect(nextReadDueAt({ plantedAt: P, readScheduleHours: [48, 18, 24], latestReadObservedAt: at(19) })).toEqual(at(24));
  });
  it('does not mutate its inputs', () => {
    const hours = [18, 24, 48]; const p = new Date(P);
    nextReadDueAt({ plantedAt: p, readScheduleHours: hours, latestReadObservedAt: at(20) });
    expect(hours).toEqual([18, 24, 48]); expect(p).toEqual(P);
  });
});

describe('finalDueAt (AC-03.1, AC-03.2)', () => {
  it('protocol hours win', () => expect(finalDueAt({ plantedAt: P, finalNoGrowthHours: 120, defaultFinalNoGrowthHours: 48 })).toEqual(at(120)));
  it('no protocol (null/undefined) -> settings default', () => {
    expect(finalDueAt({ plantedAt: P, finalNoGrowthHours: null, defaultFinalNoGrowthHours: 48 })).toEqual(at(48));
    expect(finalDueAt({ plantedAt: P, defaultFinalNoGrowthHours: 72 })).toEqual(at(72));
  });
});

describe('hoursSincePlanting (2 decimals)', () => {
  it.each([[0, 0], [1.5, 1.5], [24, 24]])('%s h -> %s', (h, out) => expect(hoursSincePlanting(P, at(h))).toBe(out));
  it('rounds to two decimals', () => {
    expect(hoursSincePlanting(P, new Date(P.getTime() + 20 * 60_000))).toBe(0.33); // 0.3333
    expect(hoursSincePlanting(P, new Date(P.getTime() + 40 * 60_000))).toBe(0.67); // 0.6667
    expect(hoursSincePlanting(P, new Date(P.getTime() + 3_600_000 * 17 + 1))).toBe(17);
  });
});

describe('isReadOverdue (02-TRD §4.1)', () => {
  const now = at(30);
  it.each(['incubating', 'growth_detected'])('%s with due < now -> overdue', (status) => expect(isReadOverdue({ status, nextReadDueAt: at(24), now })).toBe(true));
  it('due == now is not yet overdue; due > now is not overdue', () => {
    expect(isReadOverdue({ status: 'incubating', nextReadDueAt: now, now })).toBe(false);
    expect(isReadOverdue({ status: 'incubating', nextReadDueAt: at(48), now })).toBe(false);
  });
  it('no next read due (null) is never overdue', () => expect(isReadOverdue({ status: 'incubating', nextReadDueAt: null, now })).toBe(false));
  it.each(['awaiting_setup', 'final_submitted', 'amending', 'cancelled'])('status %s is never overdue', (status) => {
    expect(isReadOverdue({ status, nextReadDueAt: at(1), now })).toBe(false);
  });
});
