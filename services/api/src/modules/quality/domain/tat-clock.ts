// C9 T-18 — TAT clock, pure (02-TRD §9.2/§9.3/§9.4; 03-APP-FLOW §2.4 TC1-TC11; AC-14.1, AC-14.4, AC-14.5).
// No DB, no clock, no mutation of inputs: every call returns a new clock plus the transitions applied and the alert levels first crossed.
// The caller (tat.worker / tat.service) loads/persists the row, inserts tat_alert_events and maps TatClockError to HTTP.

export type TatSegment = 'within_lab' | 'total';
export type AlertLevel = 'none' | 'warning' | 'breached' | 'escalated';
export type TatState = 'not_started' | 'running' | 'stopped' | 'cancelled' | 'orphan_closed';
export type TatStartBasis = 'specimen_received_at' | 'registered_at' | 'specimen_ordered_at';
export type TatStopSource = 'verified_event' | 'release_event' | 'sweep';
export type TatTransition = 'TC1' | 'TC2' | 'TC3' | 'TC4' | 'TC5' | 'TC6' | 'TC7' | 'TC8' | 'TC9' | 'TC10' | 'TC11';

export interface TatClock {
  orderItemId: string;
  testId: string;
  segment: TatSegment;
  state: TatState;
  alertLevel: AlertLevel;
  targetSeconds: number;
  specimenId: string | null;
  startedAt: Date | null;
  startBasis: TatStartBasis | null;
  stoppedAt: Date | null;
  stopSource: TatStopSource | null;
  restartCount: number;
  acknowledgedLevel: AlertLevel | null;
  inPendingView: boolean;
  firstVerifiedAt: Date | null;
  leftPendingViewAt: Date | null;
  expiresAt: Date | null;
}

/** settings.tat_warn_pct / tat_escalate_pct / tat_orphan_close_hours */
export interface TatConfig { warnPct: number; escalatePct: number; orphanCloseHours: number }

export interface TatSweepItem {
  orderItemId: string;
  testId: string;
  segment: TatSegment;
  targetSeconds: number | null;
  specimenId: string;
  receivedAt: Date | null;
  itemStatus: string;
  totalStart: { at: Date; basis: 'registered_at' | 'specimen_ordered_at' } | null;
}

export type TatEvent =
  | { type: 'sweep'; now: Date; item: TatSweepItem }
  | { type: 'tick'; now: Date }
  | { type: 'verified'; verifiedAt: Date }
  | { type: 'release'; releasedAt: Date; reportKind: string; orderItemIds?: readonly string[] }
  | { type: 'left_view'; now: Date }
  | { type: 'orphan_check'; now: Date }
  | { type: 'ack' };

export interface TatResult { transitions: TatTransition[]; clock: TatClock | null; alertEvents: AlertLevel[] }

export class TatClockError extends Error {
  constructor(readonly code: string, message: string = code) {
    super(message);
    this.name = 'TatClockError';
  }
}

const LEVELS: readonly AlertLevel[] = ['none', 'warning', 'breached', 'escalated'];
const rank = (l: AlertLevel): number => LEVELS.indexOf(l);
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const RETENTION_DAYS = 400; // [CONV] expires_at = end of clock + 400 days (05-SCHEMA §7)
const expiry = (d: Date): Date => new Date(d.getTime() + RETENTION_DAYS * DAY_MS);

/** pct = elapsed / target * 100; thresholds inclusive. Integer-style compare (no division) so odd targets do not drift. */
export function alertLevelFor(elapsedSeconds: number, targetSeconds: number, cfg: TatConfig): AlertLevel {
  const e = elapsedSeconds * 100;
  if (e >= cfg.escalatePct * targetSeconds) return 'escalated';
  if (e >= 100 * targetSeconds) return 'breached';
  if (e >= cfg.warnPct * targetSeconds) return 'warning';
  return 'none';
}

/** Open alert = running clock at warning or above (02-TRD #48). */
export const isOpenAlert = (c: TatClock): boolean => c.state === 'running' && rank(c.alertLevel) >= 1;

const out = (clock: TatClock | null, transitions: TatTransition[] = [], alertEvents: AlertLevel[] = []): TatResult =>
  ({ transitions, clock, alertEvents });

const stopped = (c: TatClock, at: Date, src: TatStopSource): TatClock =>
  ({ ...c, state: 'stopped', stoppedAt: at, stopSource: src, expiresAt: expiry(at) });

/** TC5: levels only rise while running; every level first crossed is reported, ascending. */
function rise(c: TatClock, now: Date, cfg: TatConfig, before: TatTransition[] = []): TatResult {
  if (c.state !== 'running' || !c.startedAt) return out(c, before);
  const to = rank(alertLevelFor((now.getTime() - c.startedAt.getTime()) / 1000, c.targetSeconds, cfg));
  const crossed = LEVELS.slice(rank(c.alertLevel) + 1, to + 1);
  if (crossed.length === 0) return out(c, before);
  return out({ ...c, alertLevel: LEVELS[to] as AlertLevel }, [...before, ...crossed.map((): TatTransition => 'TC5')], [...crossed]);
}

function create(item: TatSweepItem, now: Date, cfg: TatConfig): TatResult {
  const base = {
    orderItemId: item.orderItemId, testId: item.testId, segment: item.segment, alertLevel: 'none' as const,
    targetSeconds: item.targetSeconds as number, specimenId: item.specimenId, stoppedAt: null, stopSource: null,
    restartCount: 0, acknowledgedLevel: null, inPendingView: true, firstVerifiedAt: null, leftPendingViewAt: null, expiresAt: null,
  };
  if (item.segment === 'total') {
    // total starts at order registration (or earliest specimen ordered_at), even before receipt; basis never changes later (§9.2)
    if (!item.totalStart) return out(null); // ponytail: caller must supply the start; no row until it can
    return rise({ ...base, state: 'running', startedAt: item.totalStart.at, startBasis: item.totalStart.basis }, now, cfg, ['TC2']);
  }
  if (!item.receivedAt) return out({ ...base, state: 'not_started', startedAt: null, startBasis: null }, ['TC1']);
  return rise({ ...base, state: 'running', startedAt: item.receivedAt, startBasis: 'specimen_received_at' }, now, cfg, ['TC2']);
}

function sweep(clock: TatClock | null, now: Date, item: TatSweepItem, cfg: TatConfig): TatResult {
  if (item.targetSeconds === null) return out(clock); // AC-14.5 / T8: no target, no clock
  if (clock === null) return create(item, now, cfg);
  if (clock.state !== 'running' && clock.state !== 'not_started') return out(clock); // stopped / cancelled / orphan_closed are final for sweeps

  let c = clock;
  const t: TatTransition[] = [];
  if (c.segment === 'within_lab') {
    if (c.state === 'running' && item.itemStatus === 'verified') { // TC8
      return out(stopped(c, now, 'sweep'), ['TC8']);
    }
    if (item.specimenId !== c.specimenId) {
      if (c.state === 'running') { // TC4 recollection restart; a total clock is not restarted (AC-14.4)
        c = { ...c, state: 'not_started', restartCount: c.restartCount + 1, alertLevel: 'none', acknowledgedLevel: null, startedAt: null, startBasis: null, specimenId: item.specimenId };
        t.push('TC4');
      } else c = { ...c, specimenId: item.specimenId };
    }
    if (c.state === 'not_started' && item.receivedAt) { // TC3
      c = { ...c, state: 'running', startedAt: item.receivedAt, startBasis: 'specimen_received_at' };
      t.push('TC3');
    }
  } else if (item.specimenId !== c.specimenId) c = { ...c, specimenId: item.specimenId };
  return rise(c, now, cfg, t);
}

const earliest = (a: Date | null, b: Date): Date => (a && a.getTime() <= b.getTime() ? a : b);

function verified(c: TatClock, at: Date): TatResult {
  if (c.segment === 'total') { // first_verified_at only; the clock stops on release (TC7)
    return out({ ...c, firstVerifiedAt: earliest(c.firstVerifiedAt, at) });
  }
  if (c.state === 'running' || c.state === 'not_started' || c.state === 'cancelled') return out(stopped(c, at, 'verified_event'), ['TC6']); // TC6, T11
  if (c.state === 'stopped' && c.stoppedAt && at.getTime() < c.stoppedAt.getTime()) return out(stopped(c, at, 'verified_event')); // earliest wins
  return out(c);
}

// TRD §9.1: final/partial stop the items named in order_item_ids; final without the field stops all; anything else none.
function stopsOnRelease(c: TatClock, kind: string, ids: readonly string[] | undefined): boolean {
  if (ids) return (kind === 'final' || kind === 'partial') && ids.includes(c.orderItemId);
  return kind === 'final';
}

function leftView(c: TatClock, now: Date): TatResult {
  if (c.state !== 'running' && c.state !== 'not_started') return out(c);
  if (c.segment === 'total' && c.firstVerifiedAt) {
    if (c.state !== 'running') return out(c);
    return out({ ...c, inPendingView: false, leftPendingViewAt: c.leftPendingViewAt ?? now });
  }
  return out({ ...c, state: 'cancelled', expiresAt: expiry(now) }, ['TC9']);
}

export function transitionClock(clock: TatClock | null, ev: TatEvent, cfg: TatConfig): TatResult {
  if (ev.type === 'sweep') return sweep(clock, ev.now, ev.item, cfg);
  if (clock === null) return out(null);
  switch (ev.type) {
    case 'tick': return rise(clock, ev.now, cfg);
    case 'verified': return verified(clock, ev.verifiedAt);
    case 'release':
      return clock.segment === 'total' && clock.state === 'running' && stopsOnRelease(clock, ev.reportKind, ev.orderItemIds)
        ? out(stopped(clock, ev.releasedAt, 'release_event'), ['TC7'])
        : out(clock);
    case 'left_view': return leftView(clock, ev.now);
    case 'orphan_check': {
      const left = clock.leftPendingViewAt;
      if (clock.segment === 'total' && clock.state === 'running' && !clock.inPendingView && left
        && ev.now.getTime() - left.getTime() > cfg.orphanCloseHours * HOUR_MS) {
        return out({ ...clock, state: 'orphan_closed', expiresAt: expiry(ev.now) }, ['TC10']);
      }
      return out(clock);
    }
    case 'ack':
      if (clock.state !== 'running' || clock.alertLevel === 'none') throw new TatClockError('common.immutable_record'); // TRD #50 -> 409
      return out({ ...clock, acknowledgedLevel: clock.alertLevel }, ['TC11']);
  }
}
