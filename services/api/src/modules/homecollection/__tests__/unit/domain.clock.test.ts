// C17 HC-T02 — capture-time correction (02-TRD §7.5 "Server correction" steps 1–4 + skew metric; 07-SECURITY AB15 future device clock).
// Interface expected from the writer (../../domain/clock.ts) — SEAMS (spec fixes behaviour, not names). Pure, IO-free, no `new Date()` inside:
//   export interface ClockAnchor { anchorId: string; serverTime: string; deviceWallTime: string; monotonicMs: number; bootId: string }  // ISO-8601 UTC strings
//   export interface CorrectCapturedTimeInput {
//     captured: { deviceWallTime: string; anchorId: string; elapsedSinceAnchorMs: number };
//     anchors: readonly ClockAnchor[];            // anchors of this batch + stored ones of the device, already merged by the caller
//     now: { deviceWallTime: string; monotonicMs: number; bootId: string };   // batch-level "now"
//     receivedAt: string;                          // server receipt time (upper clamp)
//     assignedAt: string;                          // visit.assigned_at (lower clamp = assignedAt − tolerance)
//     toleranceSeconds: number;                    // settings.clock_tolerance_seconds, 60..3600, default 600
//   }
//   export interface CorrectedTime { correctedAt: string /* ISO, ms precision, 'Z' */; clockSource: 'anchor' | 'offset' | 'device'; clockSuspect: boolean; skewSeconds: number }
//   export function correctCapturedTime(i: CorrectCapturedTimeInput): CorrectedTime
//   skewSeconds = (captured.deviceWallTime − correctedAt) in seconds (metric lims_homecollection_clock_skew_seconds).
//   "most recent anchor" (step 2) = the one with the greatest serverTime.
import { describe, expect, it } from 'vitest';
import { type ClockAnchor, type CorrectCapturedTimeInput, correctCapturedTime } from '../../domain/clock.js';

const A1: ClockAnchor = { anchorId: '01a1a98a-ac41-7000-8000-0000001d0001', serverTime: '2026-11-06T00:30:00.000Z', deviceWallTime: '2026-11-06T00:29:41.000Z', monotonicMs: 86_400_123, bootId: 'b-0000000017' };
const A2: ClockAnchor = { anchorId: '01a1a98a-ac41-7000-8000-0000001d0002', serverTime: '2026-11-06T01:00:00.000Z', deviceWallTime: '2026-11-06T00:59:50.000Z', monotonicMs: 88_200_000, bootId: 'b-0000000017' };
const base = (over: Partial<CorrectCapturedTimeInput> = {}): CorrectCapturedTimeInput => ({
  captured: { deviceWallTime: '2026-11-06T01:26:41.000Z', anchorId: A1.anchorId, elapsedSinceAnchorMs: 3_401_000 },
  anchors: [A1],
  now: { deviceWallTime: '2026-11-06T02:39:58.000Z', monotonicMs: 94_198_123, bootId: 'b-0000000017' },
  receivedAt: '2026-11-06T02:40:00.000Z',
  assignedAt: '2026-11-05T18:00:00.000Z',
  toleranceSeconds: 600,
  ...over,
});

describe('step 1 — anchor (same boot, elapsed >= 0)', () => {
  it('corrected = anchor.server_time + elapsed (spec example: 00:30:00 + 3401 s = 01:26:41)', () => {
    expect(correctCapturedTime(base())).toEqual({ correctedAt: '2026-11-06T01:26:41.000Z', clockSource: 'anchor', clockSuspect: false, skewSeconds: 0 });
  });
  it('ignores a wrong device wall clock: phone 1 h fast still corrects to the anchor time, skew +3600 s', () => {
    const r = correctCapturedTime(base({ captured: { deviceWallTime: '2026-11-06T02:26:41.000Z', anchorId: A1.anchorId, elapsedSinceAnchorMs: 3_401_000 } }));
    expect(r.correctedAt).toBe('2026-11-06T01:26:41.000Z');
    expect(r.clockSource).toBe('anchor');
    expect(r.skewSeconds).toBe(3600);
  });
  it('phone 1 h slow: skew is negative', () => {
    const r = correctCapturedTime(base({ captured: { deviceWallTime: '2026-11-06T00:26:41.000Z', anchorId: A1.anchorId, elapsedSinceAnchorMs: 3_401_000 } }));
    expect(r.clockSource).toBe('anchor');
    expect(r.skewSeconds).toBe(-3600);
  });
  it('elapsed = 0 is valid (capture at the anchor instant)', () => {
    const r = correctCapturedTime(base({ captured: { deviceWallTime: '2026-11-06T00:29:41.000Z', anchorId: A1.anchorId, elapsedSinceAnchorMs: 0 } }));
    expect(r).toMatchObject({ correctedAt: '2026-11-06T00:30:00.000Z', clockSource: 'anchor', clockSuspect: false });
  });
  it('uses the anchor named by captured.anchor_id, not the newest one', () => {
    const r = correctCapturedTime(base({ anchors: [A2, A1] }));
    expect(r.correctedAt).toBe('2026-11-06T01:26:41.000Z');
    expect(r.clockSource).toBe('anchor');
  });
  it('keeps millisecond precision', () => {
    const r = correctCapturedTime(base({ captured: { deviceWallTime: '2026-11-06T00:30:01.250Z', anchorId: A1.anchorId, elapsedSinceAnchorMs: 1250 } }));
    expect(r.correctedAt).toBe('2026-11-06T00:30:01.250Z');
  });
});

describe('step 2 — offset (reboot, negative elapsed, unknown anchor id)', () => {
  it('reboot: batch now.boot_id differs from the anchor boot_id => device wall + (server − device) of the anchor (+19 s)', () => {
    const r = correctCapturedTime(base({ now: { deviceWallTime: '2026-11-06T02:39:58.000Z', monotonicMs: 5_000, bootId: 'b-0000000018' } }));
    expect(r).toEqual({ correctedAt: '2026-11-06T01:27:00.000Z', clockSource: 'offset', clockSuspect: false, skewSeconds: -19 });
  });
  it('negative elapsed_since_anchor_ms (monotonic went backwards) => offset', () => {
    const r = correctCapturedTime(base({ captured: { deviceWallTime: '2026-11-06T01:26:41.000Z', anchorId: A1.anchorId, elapsedSinceAnchorMs: -1 } }));
    expect(r.clockSource).toBe('offset');
    expect(r.correctedAt).toBe('2026-11-06T01:27:00.000Z');
  });
  it('captured.anchor_id not among the anchors but other anchors exist => offset of the MOST RECENT anchor', () => {
    // A1 offset +19 s, A2 offset +10 s; A2 is more recent (server_time 01:00) => +10 s
    const r = correctCapturedTime(base({ captured: { deviceWallTime: '2026-11-06T01:26:41.000Z', anchorId: '01a1a98a-ac41-7000-8000-0000001dffff', elapsedSinceAnchorMs: 100 }, anchors: [A1, A2] }));
    expect(r.clockSource).toBe('offset');
    expect(r.correctedAt).toBe('2026-11-06T01:26:51.000Z');
  });
  it('most recent anchor is chosen by server_time, not by array position', () => {
    const r = correctCapturedTime(base({ captured: { deviceWallTime: '2026-11-06T01:26:41.000Z', anchorId: 'missing', elapsedSinceAnchorMs: 0 }, anchors: [A2, A1] }));
    expect(r.correctedAt).toBe('2026-11-06T01:26:51.000Z');
  });
  it('reboot with several anchors still uses the most recent anchor offset', () => {
    const r = correctCapturedTime(base({ anchors: [A1, A2], now: { deviceWallTime: '2026-11-06T02:39:58.000Z', monotonicMs: 1, bootId: 'b-0000000099' } }));
    expect(r.clockSource).toBe('offset');
    expect(r.correctedAt).toBe('2026-11-06T01:26:51.000Z');
  });
});

describe('step 3 — device (no anchor at all)', () => {
  it('corrected = device_wall_time, clock_source device, skew 0', () => {
    expect(correctCapturedTime(base({ anchors: [] }))).toEqual({ correctedAt: '2026-11-06T01:26:41.000Z', clockSource: 'device', clockSuspect: false, skewSeconds: 0 });
  });
});

describe('step 4 — plausibility clamp [assigned_at − tolerance, receipt] (AB15)', () => {
  it('device clock set to the future => clamped to receipt time, suspect, source unchanged', () => {
    const r = correctCapturedTime(base({ anchors: [], captured: { deviceWallTime: '2027-01-01T00:00:00.000Z', anchorId: 'x', elapsedSinceAnchorMs: 0 } }));
    expect(r.correctedAt).toBe('2026-11-06T02:40:00.000Z');
    expect(r.clockSuspect).toBe(true);
    expect(r.clockSource).toBe('device');
    expect(r.skewSeconds).toBe((Date.parse('2027-01-01T00:00:00.000Z') - Date.parse('2026-11-06T02:40:00.000Z')) / 1000);
  });
  it('device clock far in the past => clamped to assigned_at − tolerance (600 s), suspect', () => {
    const r = correctCapturedTime(base({ anchors: [], assignedAt: '2026-11-06T00:00:00.000Z', captured: { deviceWallTime: '2026-11-01T00:00:00.000Z', anchorId: 'x', elapsedSinceAnchorMs: 0 } }));
    expect(r.correctedAt).toBe('2026-11-05T23:50:00.000Z');
    expect(r.clockSuspect).toBe(true);
  });
  it('tolerance is configurable (60 s)', () => {
    const r = correctCapturedTime(base({ anchors: [], toleranceSeconds: 60, assignedAt: '2026-11-06T00:00:00.000Z', captured: { deviceWallTime: '2026-11-01T00:00:00.000Z', anchorId: 'x', elapsedSinceAnchorMs: 0 } }));
    expect(r.correctedAt).toBe('2026-11-05T23:59:00.000Z');
  });
  it('exactly at the lower bound is not suspect', () => {
    const r = correctCapturedTime(base({ anchors: [], assignedAt: '2026-11-06T00:00:00.000Z', captured: { deviceWallTime: '2026-11-05T23:50:00.000Z', anchorId: 'x', elapsedSinceAnchorMs: 0 } }));
    expect(r).toMatchObject({ correctedAt: '2026-11-05T23:50:00.000Z', clockSuspect: false });
  });
  it('1 ms below the lower bound is suspect and clamped', () => {
    const r = correctCapturedTime(base({ anchors: [], assignedAt: '2026-11-06T00:00:00.000Z', captured: { deviceWallTime: '2026-11-05T23:49:59.999Z', anchorId: 'x', elapsedSinceAnchorMs: 0 } }));
    expect(r).toMatchObject({ correctedAt: '2026-11-05T23:50:00.000Z', clockSuspect: true });
  });
  it('exactly at receipt time is not suspect; 1 ms after is', () => {
    const at = correctCapturedTime(base({ anchors: [], captured: { deviceWallTime: '2026-11-06T02:40:00.000Z', anchorId: 'x', elapsedSinceAnchorMs: 0 } }));
    expect(at).toMatchObject({ correctedAt: '2026-11-06T02:40:00.000Z', clockSuspect: false });
    const after = correctCapturedTime(base({ anchors: [], captured: { deviceWallTime: '2026-11-06T02:40:00.001Z', anchorId: 'x', elapsedSinceAnchorMs: 0 } }));
    expect(after).toMatchObject({ correctedAt: '2026-11-06T02:40:00.000Z', clockSuspect: true });
  });
  it('an anchor-derived time beyond receipt (bogus huge elapsed) is also clamped and suspect, source stays anchor', () => {
    const r = correctCapturedTime(base({ captured: { deviceWallTime: '2026-11-06T01:26:41.000Z', anchorId: A1.anchorId, elapsedSinceAnchorMs: 999_999_999_999 } }));
    expect(r).toMatchObject({ correctedAt: '2026-11-06T02:40:00.000Z', clockSource: 'anchor', clockSuspect: true });
  });
  it('an offset-derived time before the window is clamped and suspect, source stays offset', () => {
    const r = correctCapturedTime(base({ now: { deviceWallTime: '2026-11-06T02:39:58.000Z', monotonicMs: 1, bootId: 'b-2' }, assignedAt: '2026-11-06T05:00:00.000Z', receivedAt: '2026-11-06T09:00:00.000Z' }));
    expect(r).toMatchObject({ clockSource: 'offset', clockSuspect: true, correctedAt: '2026-11-06T04:50:00.000Z' });
  });
  it('clamp never produces a time outside [assigned_at − tolerance, receipt]', () => {
    const lo = Date.parse('2026-11-05T17:50:00.000Z');
    const hi = Date.parse('2026-11-06T02:40:00.000Z');
    for (const wall of ['1970-01-01T00:00:00.000Z', '2026-11-05T17:49:59.000Z', '2026-11-06T01:00:00.000Z', '2026-11-06T02:40:01.000Z', '2099-12-31T23:59:59.000Z']) {
      const t = Date.parse(correctCapturedTime(base({ anchors: [], captured: { deviceWallTime: wall, anchorId: 'x', elapsedSinceAnchorMs: 0 } })).correctedAt);
      expect(t).toBeGreaterThanOrEqual(lo);
      expect(t).toBeLessThanOrEqual(hi);
    }
  });
});

describe('purity', () => {
  it('does not mutate its input and is deterministic', () => {
    const input = base({ anchors: [A2, A1] });
    const copy = JSON.parse(JSON.stringify(input));
    const a = correctCapturedTime(input);
    const b = correctCapturedTime(input);
    expect(a).toEqual(b);
    expect(input).toEqual(copy);
  });
});
