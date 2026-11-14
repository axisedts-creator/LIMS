// C9 T-18 — TAT clock, pure (02-TRD §9.3/§9.4 vectors T1-T14; 03-APP-FLOW §2.4 TC1-TC11; PRD AC-14.1, AC-14.4, AC-14.5, AC-14.6 guard).
// 07-SECURITY has no TAT-specific unit tests (S-05/S-21 are SQL probes, other tasks); the only security-relevant rule here is
// that an ack on a non-running / level-none clock is refused with 409 common.immutable_record (TRD #50), covered below.
// Interface expected from the writer (../tat-clock.ts). Names are NOT fixed by the spec, so this harness fixes them (T-18 tester seam):
//   type TatSegment = 'within_lab'|'total';  type AlertLevel = 'none'|'warning'|'breached'|'escalated';
//   type TatState = 'not_started'|'running'|'stopped'|'cancelled'|'orphan_closed';
//   interface TatClock { orderItemId; testId; segment; state; alertLevel; targetSeconds; specimenId: string|null;
//     startedAt: Date|null; startBasis: 'specimen_received_at'|'registered_at'|'specimen_ordered_at'|null;
//     stoppedAt: Date|null; stopSource: 'verified_event'|'release_event'|'sweep'|null; restartCount: number;
//     acknowledgedLevel: AlertLevel|null; inPendingView: boolean; firstVerifiedAt: Date|null; leftPendingViewAt: Date|null; expiresAt: Date|null }
//   interface TatConfig { warnPct; escalatePct; orphanCloseHours }            (settings.tat_warn_pct / tat_escalate_pct / tat_orphan_close_hours)
//   alertLevelFor(elapsedSeconds, targetSeconds, cfg): AlertLevel              pct = elapsed/target*100; >= warn, >= 100, >= escalate (inclusive)
//   isOpenAlert(clock): boolean                                                open = state running and level >= warning (TRD #48)
//   transitionClock(clock|null, ev, cfg): { transitions: TC[]; clock: TatClock|null; alertEvents: AlertLevel[] }   never mutates its input
//     ev = { type:'sweep', now, item:{ orderItemId, testId, segment, targetSeconds: number|null, specimenId, receivedAt: Date|null,
//                                       itemStatus: string, totalStart: {at: Date, basis: 'registered_at'|'specimen_ordered_at'}|null } }
//        | { type:'tick', now }                          level recompute only (items outside the pending view, T10)
//        | { type:'verified', verifiedAt }               TC6 (within_lab) / first_verified_at (total)
//        | { type:'release', releasedAt, reportKind, orderItemIds?: string[] }   TC7, decided per item from the event payload
//        | { type:'left_view', now }                     TC9, or total+verified keeps running with inPendingView=false
//        | { type:'orphan_check', now }                  TC10 (strictly greater than orphanCloseHours)
//        | { type:'ack' }                                TC11
//     transitions lists TC ids in the order applied (restart on a new received specimen = ['TC4','TC3']); alertEvents = every level first crossed, ascending.
//   class TatClockError extends Error { code: string }
// [CONV] expires_at = stop/cancel/orphan time + 400 days (05-SCHEMA §7). start_basis for within_lab = 'specimen_received_at' (TRD §9.3 step 2).
import { describe, expect, it } from 'vitest';
import { alertLevelFor, isOpenAlert, TatClockError, transitionClock } from '../tat-clock.js';

type Level = 'none' | 'warning' | 'breached' | 'escalated';
type Basis = 'specimen_received_at' | 'registered_at' | 'specimen_ordered_at';
interface Clock {
  orderItemId: string; testId: string; segment: 'within_lab' | 'total';
  state: 'not_started' | 'running' | 'stopped' | 'cancelled' | 'orphan_closed';
  alertLevel: Level; targetSeconds: number; specimenId: string | null;
  startedAt: Date | null; startBasis: Basis | null; stoppedAt: Date | null;
  stopSource: 'verified_event' | 'release_event' | 'sweep' | null; restartCount: number;
  acknowledgedLevel: Level | null; inPendingView: boolean; firstVerifiedAt: Date | null;
  leftPendingViewAt: Date | null; expiresAt: Date | null;
}
interface Item {
  orderItemId: string; testId: string; segment: 'within_lab' | 'total'; targetSeconds: number | null; specimenId: string;
  receivedAt: Date | null; itemStatus: string; totalStart: { at: Date; basis: 'registered_at' | 'specimen_ordered_at' } | null;
}
type Ev = Record<string, unknown> & { type: string };
type Result = { transitions: string[]; clock: Clock | null; alertEvents: Level[] };

const CFG = { warnPct: 80, escalatePct: 150, orphanCloseHours: 72 };
const CBC = 14_400; // routine target, 02-TRD §9.4
const DAY = 86_400_000;
const at = (hms: string): Date => new Date(`2026-11-13T${hms.length === 5 ? `${hms}:00` : hms}Z`);
const run = (c: Clock | null, ev: Ev, cfg = CFG): Result => transitionClock(c as never, ev as never, cfg) as unknown as Result;
const must = (r: Result): Clock => { expect(r.clock).not.toBeNull(); return r.clock as Clock; };

const within = (o: Partial<Item> = {}): Item => ({
  orderItemId: 'I1', testId: 'CBC', segment: 'within_lab', targetSeconds: CBC, specimenId: 'S1',
  receivedAt: at('08:00'), itemStatus: 'received', totalStart: null, ...o,
});
const total = (o: Partial<Item> = {}): Item => within({
  segment: 'total', receivedAt: at('08:30'), totalStart: { at: at('08:00'), basis: 'registered_at' }, ...o,
});
const sweep = (c: Clock | null, now: string, item: Item): Result => run(c, { type: 'sweep', now: at(now), item });
const tick = (c: Clock, now: string): Result => run(c, { type: 'tick', now: at(now) });

describe('alertLevelFor — thresholds are inclusive (T1-T4, AC-14.1)', () => {
  it.each([
    [11_459, 'none'], [11_460, 'none'], [11_519, 'none'], [11_520, 'warning'],      // T1 / T2: 80 % of 14,400 = 11,520 s
    [14_399, 'warning'], [14_400, 'breached'],                                      // T3
    [21_599, 'breached'], [21_600, 'escalated'], [99_999, 'escalated'],             // T4: 150 % = 21,600 s
  ] as const)('elapsed %i s of 14,400 s → %s', (elapsed, level) => {
    expect(alertLevelFor(elapsed, CBC, CFG)).toBe(level);
  });

  it('honours custom warn/escalate percentages from settings', () => {
    const cfg = { warnPct: 50, escalatePct: 200, orphanCloseHours: 72 };
    expect([alertLevelFor(499, 1000, cfg), alertLevelFor(500, 1000, cfg), alertLevelFor(1000, 1000, cfg),
      alertLevelFor(1999, 1000, cfg), alertLevelFor(2000, 1000, cfg)]).toEqual(['none', 'warning', 'breached', 'breached', 'escalated']);
  });

  it('matches an independent integer oracle and is monotone (no float drift at odd targets)', () => {
    const oracle = (e: number, t: number): Level =>
      e * 100 >= CFG.escalatePct * t ? 'escalated' : e * 100 >= t * 100 ? 'breached' : e * 100 >= CFG.warnPct * t ? 'warning' : 'none';
    const rank = { none: 0, warning: 1, breached: 2, escalated: 3 } as const;
    for (const target of [7, 3, 600, 7_200, 14_400, 86_399]) {
      let prev = 0;
      for (let e = 0; e <= target * 2; e += Math.max(1, Math.floor(target / 97))) {
        const got = alertLevelFor(e, target, CFG);
        expect(got, `elapsed ${e} target ${target}`).toBe(oracle(e, target));
        expect(rank[got]).toBeGreaterThanOrEqual(prev);
        prev = rank[got];
      }
    }
  });
});

describe('TC1-TC3 creation and start (T1-T4 on a live clock, AC-14.1, AC-14.5)', () => {
  it('TC1: within_lab item without received_at → not_started, no start time', () => {
    const r = sweep(null, '07:55', within({ receivedAt: null }));
    expect(r.transitions).toEqual(['TC1']);
    expect(r.clock).toMatchObject({ state: 'not_started', startedAt: null, startBasis: null, alertLevel: 'none', segment: 'within_lab', targetSeconds: CBC, restartCount: 0 });
    expect(r.alertEvents).toEqual([]);
  });

  it('TC2: within_lab item with received_at → running from received_at, basis specimen_received_at', () => {
    const r = sweep(null, '08:00', within());
    expect(r.transitions).toEqual(['TC2']);
    expect(r.clock).toMatchObject({ state: 'running', startedAt: at('08:00'), startBasis: 'specimen_received_at', alertLevel: 'none', specimenId: 'S1', orderItemId: 'I1', testId: 'CBC' });
  });

  it('TC3: not_started + received_at appears → running, started_at = received_at', () => {
    const c = must(sweep(null, '07:55', within({ receivedAt: null })));
    const r = sweep(c, '08:05', within({ receivedAt: at('08:00') }));
    expect(r.transitions).toEqual(['TC3']);
    expect(r.clock).toMatchObject({ state: 'running', startedAt: at('08:00') });
  });

  it('AC-14.5 / T8: no target for the priority → no clock, no alert', () => {
    const r = sweep(null, '09:00', within({ targetSeconds: null }));
    expect(r.clock).toBeNull();
    expect(r.transitions).toEqual([]);
    expect(r.alertEvents).toEqual([]);
  });

  it('T1-T4 (AC-14.1): running clock walks none → warning → breached → escalated, one alert event per first crossing', () => {
    let c = must(sweep(null, '08:00', within()));
    let r = sweep(c, '11:11', within());
    expect([r.clock?.state, r.clock?.alertLevel, r.transitions, r.alertEvents]).toEqual(['running', 'none', [], []]);          // T1
    r = sweep(must(r), '11:12', within()); c = must(r);
    expect([c.alertLevel, r.transitions, r.alertEvents]).toEqual(['warning', ['TC5'], ['warning']]);                           // T2
    r = sweep(c, '11:13', within());
    expect([r.transitions, r.alertEvents]).toEqual([[], []]);                                                                  // same level: no new event
    r = sweep(c, '12:00', within()); c = must(r);
    expect([c.alertLevel, r.transitions, r.alertEvents]).toEqual(['breached', ['TC5'], ['breached']]);                         // T3
    r = sweep(c, '14:00', within()); c = must(r);
    expect([c.alertLevel, r.transitions, r.alertEvents]).toEqual(['escalated', ['TC5'], ['escalated']]);                       // T4
    expect(sweep(c, '14:01', within()).alertEvents).toEqual([]);
  });

  it('a sweep after downtime records every level crossed, ascending (each first crossing inserts a row)', () => {
    const c = must(sweep(null, '08:00', within()));
    const r = sweep(c, '14:00', within());
    expect(r.alertEvents).toEqual(['warning', 'breached', 'escalated']);
    expect(r.clock?.alertLevel).toBe('escalated');
  });

  it('levels only rise while running (a lower recomputed level never lowers it)', () => {
    const c = { ...must(sweep(null, '08:00', within())), alertLevel: 'escalated' as Level };
    const r = sweep(c, '08:01', within());
    expect(r.clock?.alertLevel).toBe('escalated');
    expect(r.alertEvents).toEqual([]);
  });
});

describe('TC4 restart on recollection (T6, AC-14.4)', () => {
  const running = (): Clock => ({ ...must(sweep(null, '08:00', within())), alertLevel: 'warning' as Level, acknowledgedLevel: 'warning' as Level });

  it('TC4: item moves to a new specimen without received_at → not_started, restart_count+1, level reset, ack cleared', () => {
    const r = sweep(running(), '10:00', within({ specimenId: 'S2', receivedAt: null }));
    expect(r.transitions).toEqual(['TC4']);
    expect(r.clock).toMatchObject({ state: 'not_started', restartCount: 1, alertLevel: 'none', acknowledgedLevel: null, specimenId: 'S2', startedAt: null });
  });

  it('T6: new specimen already received 12:30, now 13:00 → running from 12:30, level none, restart_count 1', () => {
    const r = sweep(running(), '13:00', within({ specimenId: 'S2', receivedAt: at('12:30') }));
    expect(r.transitions).toEqual(['TC4', 'TC3']);
    expect(r.clock).toMatchObject({ state: 'running', startedAt: at('12:30'), alertLevel: 'none', restartCount: 1, acknowledgedLevel: null, specimenId: 'S2' });
    expect(r.alertEvents).toEqual([]);
  });

  it('two-step restart: TC4 now, TC3 when the recollection is received; restart_count stays 1', () => {
    const c = must(sweep(running(), '10:00', within({ specimenId: 'S2', receivedAt: null })));
    const r = sweep(c, '12:30', within({ specimenId: 'S2', receivedAt: at('12:30') }));
    expect(r.transitions).toEqual(['TC3']);
    expect(r.clock).toMatchObject({ state: 'running', startedAt: at('12:30'), restartCount: 1 });
  });

  it('restarted clock alerts again from the new start (warning at 12:30 + 80 %)', () => {
    const c = must(sweep(running(), '13:00', within({ specimenId: 'S2', receivedAt: at('12:30') })));
    expect(sweep(c, '15:41', within({ specimenId: 'S2', receivedAt: at('12:30') })).alertEvents).toEqual([]);
    expect(sweep(c, '15:42', within({ specimenId: 'S2', receivedAt: at('12:30') })).alertEvents).toEqual(['warning']);
  });

  it('AC-14.4: a total clock continues across a specimen change (no restart, same start, same level)', () => {
    const c = { ...must(sweep(null, '08:00', total())), alertLevel: 'warning' as Level };
    const r = sweep(c, '11:30', total({ specimenId: 'S2', receivedAt: at('11:00') }));
    expect(r.transitions).toEqual([]);
    expect(r.clock).toMatchObject({ state: 'running', startedAt: at('08:00'), restartCount: 0, alertLevel: 'warning' });
  });
});

describe('TC6 within_lab stop on verified event (T5, T11, AC-14.2 clock side)', () => {
  it('T5: verified 11:30 after a warning → stopped at 11:30, open list empty, level history [warning]', () => {
    let c = must(sweep(null, '08:00', within()));
    const history: Level[] = [];
    let r = sweep(c, '11:12', within()); history.push(...r.alertEvents); c = must(r);
    expect(isOpenAlert(c)).toBe(true);
    r = run(c, { type: 'verified', verifiedAt: at('11:30') }); c = must(r);
    expect(r.transitions).toEqual(['TC6']);
    expect(c).toMatchObject({ state: 'stopped', stoppedAt: at('11:30'), stopSource: 'verified_event' });
    expect(c.expiresAt).toEqual(new Date(at('11:30').getTime() + 400 * DAY));
    expect(isOpenAlert(c)).toBe(false);
    expect(history).toEqual(['warning']);
    expect(r.alertEvents).toEqual([]);
  });

  it('TC6 also fires from not_started', () => {
    const c = must(sweep(null, '07:55', within({ receivedAt: null })));
    const r = run(c, { type: 'verified', verifiedAt: at('09:00') });
    expect(r.transitions).toEqual(['TC6']);
    expect(r.clock).toMatchObject({ state: 'stopped', stoppedAt: at('09:00'), stopSource: 'verified_event' });
  });

  it('T11: late verified event after the item was cancelled → stopped with verified_at (correction)', () => {
    const cancelled = must(run(must(sweep(null, '08:00', within())), { type: 'left_view', now: at('10:00') }));
    expect(cancelled.state).toBe('cancelled');
    const r = run(cancelled, { type: 'verified', verifiedAt: at('09:45') });
    expect(r.transitions).toEqual(['TC6']);
    expect(r.clock).toMatchObject({ state: 'stopped', stoppedAt: at('09:45'), stopSource: 'verified_event' });
  });

  it('earliest wins: a verified event earlier than a sweep-fallback stop corrects stopped_at; a later one changes nothing', () => {
    const swept = must(sweep(must(sweep(null, '08:00', within())), '10:00', within({ itemStatus: 'verified' })));
    expect(swept).toMatchObject({ state: 'stopped', stoppedAt: at('10:00'), stopSource: 'sweep' });
    const earlier = run(swept, { type: 'verified', verifiedAt: at('09:30') });
    expect(earlier.clock).toMatchObject({ state: 'stopped', stoppedAt: at('09:30'), stopSource: 'verified_event' });
    const later = run(must(earlier), { type: 'verified', verifiedAt: at('09:50') });
    expect(later.clock).toMatchObject({ stoppedAt: at('09:30'), stopSource: 'verified_event' });
  });

  it('a stopped clock is final for sweeps: no restart, no level change, no events', () => {
    const stopped = must(run(must(sweep(null, '08:00', within())), { type: 'verified', verifiedAt: at('09:00') }));
    const r = sweep(stopped, '15:00', within({ specimenId: 'S9', receivedAt: at('14:00') }));
    expect(r.transitions).toEqual([]);
    expect(r.clock).toMatchObject({ state: 'stopped', alertLevel: 'none', stoppedAt: at('09:00'), restartCount: 0 });
    expect(r.alertEvents).toEqual([]);
  });
});

describe('TC7 total stop on release (T7, T12)', () => {
  const urgent = (): Clock => must(sweep(null, '08:00', total({ targetSeconds: 7_200 })));

  it('T7: urgent 7,200 s total, ordered 08:00 → warning at 09:36 exactly, stopped 09:50 by final release, history [warning], never breached', () => {
    let c = urgent();
    expect(c).toMatchObject({ startedAt: at('08:00'), startBasis: 'registered_at' });
    const history: Level[] = [];
    let r = sweep(c, '09:35:59', total({ targetSeconds: 7_200 }));
    expect([r.clock?.alertLevel, r.alertEvents]).toEqual(['none', []]);
    r = sweep(c, '09:36', total({ targetSeconds: 7_200 })); c = must(r); history.push(...r.alertEvents);
    expect(history).toEqual(['warning']);
    r = run(c, { type: 'release', releasedAt: at('09:50'), reportKind: 'final' }); c = must(r);
    expect(r.transitions).toEqual(['TC7']);
    expect(c).toMatchObject({ state: 'stopped', stoppedAt: at('09:50'), stopSource: 'release_event', alertLevel: 'warning' });
    expect(history).not.toContain('breached');
  });

  it('T12: final release with order_item_ids=[I1] stops I1 only; I2 keeps running until a release containing it', () => {
    const i1 = must(sweep(null, '08:00', total({ orderItemId: 'I1' })));
    const i2 = must(sweep(null, '08:00', total({ orderItemId: 'I2' })));
    const ev = { type: 'release', releasedAt: at('10:00'), reportKind: 'final', orderItemIds: ['I1'] };
    const r1 = run(i1, ev), r2 = run(i2, ev);
    expect(r1.transitions).toEqual(['TC7']);
    expect(r1.clock).toMatchObject({ state: 'stopped', stopSource: 'release_event', stoppedAt: at('10:00') });
    expect(r2.transitions).toEqual([]);
    expect(r2.clock).toMatchObject({ state: 'running', stoppedAt: null });
    expect(run(must(r2), { type: 'release', releasedAt: at('11:00'), reportKind: 'partial', orderItemIds: ['I2'] }).clock)
      .toMatchObject({ state: 'stopped', stoppedAt: at('11:00') });
  });

  it.each([
    ['partial', ['I1'], true], ['final', undefined, true], ['partial', undefined, false],
    ['preliminary', ['I1'], false], ['amended', ['I1'], false], ['addendum', ['I1'], false], ['some_future_kind', ['I1'], false],
    ['final', [], false], ['final', ['I2'], false],
  ] as const)('report_kind %s, order_item_ids %j → stops: %s', (reportKind, orderItemIds, stops) => {
    const c = must(sweep(null, '08:00', total()));
    const r = run(c, { type: 'release', releasedAt: at('10:00'), reportKind, ...(orderItemIds ? { orderItemIds: [...orderItemIds] } : {}) });
    expect(r.clock?.state).toBe(stops ? 'stopped' : 'running');
    expect(r.transitions).toEqual(stops ? ['TC7'] : []);
  });

  it('a release never stops a within_lab clock or a clock that is not running', () => {
    const wl = must(sweep(null, '08:00', within()));
    expect(run(wl, { type: 'release', releasedAt: at('10:00'), reportKind: 'final' }).clock?.state).toBe('running');
    const cancelled = must(run(must(sweep(null, '08:00', total())), { type: 'left_view', now: at('09:00') }));
    expect(cancelled.state).toBe('cancelled');
    expect(run(cancelled, { type: 'release', releasedAt: at('10:00'), reportKind: 'final' }).clock?.state).toBe('cancelled');
  });
});

describe('TC8 sweep fallback stop', () => {
  it('within_lab running item with item_status verified and no event yet → stopped, stopped_at = now, stop_source sweep', () => {
    const c = must(sweep(null, '08:00', within()));
    const r = sweep(c, '10:00', within({ itemStatus: 'verified' }));
    expect(r.transitions).toEqual(['TC8']);
    expect(r.clock).toMatchObject({ state: 'stopped', stoppedAt: at('10:00'), stopSource: 'sweep' });
    expect(r.clock?.expiresAt).toEqual(new Date(at('10:00').getTime() + 400 * DAY));
  });

  it('does not apply to a total clock (a verified item still waits for its release)', () => {
    const c = must(sweep(null, '08:00', total()));
    const r = sweep(c, '10:00', total({ itemStatus: 'verified' }));
    expect(r.transitions).not.toContain('TC8');
    expect(r.clock?.state).toBe('running');
  });
});

describe('TC9 left the pending view; verified event on total (T9, T10)', () => {
  it('T9 / TC9: within_lab running item disappears with no verified event → cancelled, expires_at set', () => {
    const r = run(must(sweep(null, '08:00', within())), { type: 'left_view', now: at('10:00') });
    expect(r.transitions).toEqual(['TC9']);
    expect(r.clock).toMatchObject({ state: 'cancelled' });
    expect(r.clock?.expiresAt).toEqual(new Date(at('10:00').getTime() + 400 * DAY));
  });

  it('TC9 from not_started, and total without first_verified_at', () => {
    expect(run(must(sweep(null, '07:00', within({ receivedAt: null }))), { type: 'left_view', now: at('08:00') }).clock?.state).toBe('cancelled');
    const r = run(must(sweep(null, '08:00', total())), { type: 'left_view', now: at('09:00') });
    expect(r.transitions).toEqual(['TC9']);
    expect(r.clock?.state).toBe('cancelled');
  });

  it('total with first_verified_at keeps running when it leaves the view: in_pending_view=false, left_pending_view_at stamped once', () => {
    let c = must(run(must(sweep(null, '08:00', total())), { type: 'verified', verifiedAt: at('10:00') }));
    expect(c).toMatchObject({ state: 'running', firstVerifiedAt: at('10:00') });
    let r = run(c, { type: 'left_view', now: at('10:30') }); c = must(r);
    expect(r.transitions).toEqual([]);
    expect(c).toMatchObject({ state: 'running', inPendingView: false, leftPendingViewAt: at('10:30') });
    c = must(run(c, { type: 'left_view', now: at('10:45') }));
    expect(c.leftPendingViewAt).toEqual(at('10:30'));
  });

  it('first_verified_at keeps the earliest verification (total)', () => {
    const c = must(run(must(sweep(null, '08:00', total())), { type: 'verified', verifiedAt: at('10:00') }));
    expect(run(c, { type: 'verified', verifiedAt: at('10:20') }).clock?.firstVerifiedAt).toEqual(at('10:00'));
  });

  it('T10: total 14,400 s, ordered 08:00, verified 10:00, left view 10:30, final release 13:00 → running, breached 12:00, stopped 13:00', () => {
    let c = must(sweep(null, '08:00', total()));
    c = must(run(c, { type: 'verified', verifiedAt: at('10:00') }));
    c = must(run(c, { type: 'left_view', now: at('10:30') }));
    expect(c).toMatchObject({ state: 'running', inPendingView: false });
    const history: Level[] = [];
    for (const now of ['11:12', '11:59:59', '12:00']) { const r = tick(c, now); c = must(r); history.push(...r.alertEvents); }
    expect(history).toEqual(['warning', 'breached']);
    expect(c.alertLevel).toBe('breached');
    const r = run(c, { type: 'release', releasedAt: at('13:00'), reportKind: 'final' });
    expect(r.clock).toMatchObject({ state: 'stopped', stoppedAt: at('13:00'), stopSource: 'release_event', alertLevel: 'breached' });
  });
});

describe('TC10 orphan close', () => {
  const orphan = (): Clock => {
    let c = must(sweep(null, '08:00', total()));
    c = must(run(c, { type: 'verified', verifiedAt: at('10:00') }));
    return must(run(c, { type: 'left_view', now: at('10:30') }));
  };
  const plus = (h: number, ms = 0): Date => new Date(at('10:30').getTime() + h * 3_600_000 + ms);

  it('strictly more than tat_orphan_close_hours after leaving the view → orphan_closed with expires_at', () => {
    expect(run(orphan(), { type: 'orphan_check', now: plus(72) }).transitions).toEqual([]);
    const r = run(orphan(), { type: 'orphan_check', now: plus(72, 1_000) });
    expect(r.transitions).toEqual(['TC10']);
    expect(r.clock).toMatchObject({ state: 'orphan_closed' });
    expect(r.clock?.expiresAt).toEqual(new Date(plus(72, 1_000).getTime() + 400 * DAY));
  });

  it('uses the configured hours', () => {
    const cfg = { ...CFG, orphanCloseHours: 1 };
    expect(run(orphan(), { type: 'orphan_check', now: plus(1, 1_000) }, cfg).clock?.state).toBe('orphan_closed');
    expect(run(orphan(), { type: 'orphan_check', now: plus(1) }, cfg).clock?.state).toBe('running');
  });

  it('never closes a clock that is still in the pending view or is within_lab', () => {
    const inView = must(sweep(null, '08:00', total()));
    expect(run(inView, { type: 'orphan_check', now: at('23:59') }).clock?.state).toBe('running');
    const wl = must(sweep(null, '08:00', within()));
    expect(run(wl, { type: 'orphan_check', now: new Date(at('08:00').getTime() + 400 * DAY) }).clock?.state).toBe('running');
  });
});

describe('TC11 acknowledge (AC-14.6 guard; TRD #50 409 common.immutable_record)', () => {
  it('TC11: acknowledged_level = alert_level; a later higher level stays unacknowledged and raises a new event', () => {
    let c = must(sweep(must(sweep(null, '08:00', within())), '11:12', within()));
    let r = run(c, { type: 'ack' }); c = must(r);
    expect(r.transitions).toEqual(['TC11']);
    expect(c).toMatchObject({ state: 'running', alertLevel: 'warning', acknowledgedLevel: 'warning' });
    r = sweep(c, '12:00', within()); c = must(r);
    expect(r.alertEvents).toEqual(['breached']);
    expect(c).toMatchObject({ alertLevel: 'breached', acknowledgedLevel: 'warning' });
    expect(isOpenAlert(c)).toBe(true);
  });

  it.each([
    ['level none', (): Clock => must(sweep(null, '08:00', within()))],
    ['not_started', (): Clock => must(sweep(null, '07:00', within({ receivedAt: null })))],
    ['stopped', (): Clock => ({ ...must(run(must(sweep(null, '08:00', within())), { type: 'verified', verifiedAt: at('11:30') })), alertLevel: 'warning' as Level })],
    ['cancelled', (): Clock => ({ ...must(run(must(sweep(null, '08:00', within())), { type: 'left_view', now: at('09:00') })), alertLevel: 'warning' as Level })],
  ])('refuses ack when %s with common.immutable_record', (_n, make) => {
    let err: unknown;
    try { run(make(), { type: 'ack' }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(TatClockError);
    expect((err as TatClockError).code).toBe('common.immutable_record');
  });
});

describe('T13 / T14 total start basis (AC-14.3 data, 02-TRD §9.2)', () => {
  it('T13: registered_at 07:58 beats the earliest specimen ordered_at 08:00 → started_at 07:58, basis registered_at', () => {
    const r = sweep(null, '08:05', total({ totalStart: { at: at('07:58'), basis: 'registered_at' } }));
    expect(r.transitions).toEqual(['TC2']);
    expect(r.clock).toMatchObject({ state: 'running', segment: 'total', startedAt: at('07:58'), startBasis: 'registered_at' });
  });

  it('T14: no registered_at row yet → started_at = specimen ordered_at 08:00, basis specimen_ordered_at', () => {
    const r = sweep(null, '08:05', total({ totalStart: { at: at('08:00'), basis: 'specimen_ordered_at' } }));
    expect(r.clock).toMatchObject({ state: 'running', startedAt: at('08:00'), startBasis: 'specimen_ordered_at' });
  });

  it('a total clock starts even when the specimen is not received yet, and its basis is never changed later', () => {
    const c = must(sweep(null, '08:05', total({ receivedAt: null, totalStart: { at: at('08:00'), basis: 'specimen_ordered_at' } })));
    expect(c).toMatchObject({ state: 'running', startedAt: at('08:00') });
    const later = sweep(c, '08:10', total({ totalStart: { at: at('07:58'), basis: 'registered_at' } }));
    expect(later.clock).toMatchObject({ startedAt: at('08:00'), startBasis: 'specimen_ordered_at' });
  });

  it('total clock alerts count from the total start, not from received_at', () => {
    const c = must(sweep(null, '08:00', total({ targetSeconds: 7_200, receivedAt: at('09:00') })));
    expect(sweep(c, '09:36', total({ targetSeconds: 7_200, receivedAt: at('09:00') })).alertEvents).toEqual(['warning']);
  });
});

describe('purity', () => {
  it('does not mutate a frozen input clock or the event', () => {
    const c = Object.freeze(must(sweep(null, '08:00', within()))) as Clock;
    const ev = Object.freeze({ type: 'sweep', now: at('14:00'), item: Object.freeze(within()) });
    const before = JSON.stringify(c);
    const r = run(c, ev as unknown as Ev);
    expect(JSON.stringify(c)).toBe(before);
    expect(r.clock).not.toBe(c);
    expect(r.clock?.alertLevel).toBe('escalated');
  });

  it('is deterministic for the same input', () => {
    const c = must(sweep(null, '08:00', within()));
    expect(sweep(c, '12:00', within())).toEqual(sweep(c, '12:00', within()));
  });
});
