// C9 T-04 — QC run state machine, pure (03-APP-FLOW §2.1 QR1-QR7 + "Forbidden" line; 02-TRD §7.3 step 1a/5/6; 07-SECURITY S-09, S-10).
// done_when: every QR transition + forbidden ones. ACs: AC-06.6 (QR6: no second event), AC-06.7 (QR5 incomplete/stale), AC-07.2/07.3 guards (QR7).
// Interface expected from the writer (../run.state.ts). Names are NOT fixed by the spec, so this harness fixes them (T-04 tester seam):
//   type RunState = { status: 'collecting'|'evaluated'|'closed'; outcome: 'accepted'|'accepted_warning'|'incomplete'|'rejected'|null; isComplete: boolean }
//   transitionRun(state: RunState | null, ev: RunEvent): { transition: 'QR1'..'QR7'; state: RunState; emitsRejectedEvent: boolean }
//     RunEvent = { type: 'open' }                                          QR1  (state null)
//              | { type: 'add_member' }                                    QR2  collecting stays collecting
//              | { type: 'reject_early' }                                  QR3  collecting -> evaluated/rejected, is_complete=false, event
//              | { type: 'complete', outcome }                             QR4  composition full: is_complete=true, event iff rejected
//              | { type: 'finalize', outcome }                             QR5  stale close / next run opened / evaluateQcRunNow: is_complete=false
//              | { type: 'attach_late_member' }                            QR6  early-rejected run, no event, state unchanged
//              | { type: 'close', correctiveActionCount: number, laterAcceptedRunAfterWindow: boolean }   QR7
//        laterAcceptedRunAfterWindow = caller already applied "accepted/accepted_warning run with run_at > R.run_at + run_window_minutes".
//   assertRunAction(state, 'acknowledge' | 'exclude_observation'): void     throws RunStateError for forbidden cases (#33 / #27, S-10)
//   class RunStateError extends Error { code: string }
// Error codes (spec): evaluate-type on an evaluated run -> quality.qc_run_already_evaluated (#30/#27); closing a non-rejected run, closed -> *,
//   acknowledging a collecting run -> common.immutable_record; close guards -> quality.corrective_action_required, then quality.rerun_required.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertRunAction, RunStateError, transitionRun } from '../run.state.js';

type Outcome = 'accepted' | 'accepted_warning' | 'incomplete' | 'rejected';
interface RS { status: 'collecting' | 'evaluated' | 'closed'; outcome: Outcome | null; isComplete: boolean }
type Ev =
  | { type: 'open' } | { type: 'add_member' } | { type: 'reject_early' }
  | { type: 'complete'; outcome: Outcome } | { type: 'finalize'; outcome: Outcome }
  | { type: 'attach_late_member' }
  | { type: 'close'; correctiveActionCount: number; laterAcceptedRunAfterWindow: boolean };

const COLLECTING: RS = { status: 'collecting', outcome: null, isComplete: false };
const ev = (outcome: Outcome, isComplete: boolean): RS => ({ status: 'evaluated', outcome, isComplete });
const EARLY_REJECTED = ev('rejected', false);
const FULL_REJECTED = ev('rejected', true);
const CLOSED: RS = { status: 'closed', outcome: 'rejected', isComplete: false };
const OUTCOMES: Outcome[] = ['accepted', 'accepted_warning', 'incomplete', 'rejected'];
const OK_CLOSE: Ev = { type: 'close', correctiveActionCount: 1, laterAcceptedRunAfterWindow: true };

const codeOf = (fn: () => unknown): string | undefined => {
  try { fn(); } catch (e) { expect(e).toBeInstanceOf(RunStateError); return (e as RunStateError).code; }
  return undefined;
};

describe('allowed transitions QR1-QR7', () => {
  it('QR1: (none) -> collecting', () => {
    const r = transitionRun(null, { type: 'open' });
    expect(r).toMatchObject({ transition: 'QR1', state: COLLECTING, emitsRejectedEvent: false });
  });
  it('QR2: collecting -> collecting, no event', () => {
    expect(transitionRun(COLLECTING, { type: 'add_member' })).toMatchObject({ transition: 'QR2', state: COLLECTING, emitsRejectedEvent: false });
  });
  it('QR3: early rejection -> evaluated/rejected, is_complete=false, exactly the rejected event', () => {
    expect(transitionRun(COLLECTING, { type: 'reject_early' })).toEqual({ transition: 'QR3', state: EARLY_REJECTED, emitsRejectedEvent: true });
  });
  it.each(OUTCOMES.filter((o) => o !== 'incomplete'))('QR4: full composition, outcome %s -> evaluated, is_complete=true, event iff rejected', (outcome) => {
    expect(transitionRun(COLLECTING, { type: 'complete', outcome })).toEqual({ transition: 'QR4', state: ev(outcome, true), emitsRejectedEvent: outcome === 'rejected' });
  });
  it.each(OUTCOMES)('QR5: stale close / next run / evaluate-now, outcome %s -> evaluated, is_complete=false, event iff rejected (AC-06.7)', (outcome) => {
    expect(transitionRun(COLLECTING, { type: 'finalize', outcome })).toEqual({ transition: 'QR5', state: ev(outcome, false), emitsRejectedEvent: outcome === 'rejected' });
  });
  it('QR6: late member of an early-rejected run leaves state unchanged and emits no second event (AC-06.6)', () => {
    expect(transitionRun(EARLY_REJECTED, { type: 'attach_late_member' })).toEqual({ transition: 'QR6', state: EARLY_REJECTED, emitsRejectedEvent: false });
  });
  it.each([['early-rejected', EARLY_REJECTED], ['complete rejected', FULL_REJECTED]])('QR7: %s run closes with a corrective action and a later accepted run; outcome and is_complete are kept', (_n, s) => {
    const r = transitionRun(s, OK_CLOSE);
    expect(r).toMatchObject({ transition: 'QR7', emitsRejectedEvent: false });
    expect(r.state).toEqual({ status: 'closed', outcome: 'rejected', isComplete: s.isComplete });
  });
});

describe('QR7 close guards (AC-07.2, AC-07.3, 08 A17 D-52)', () => {
  it('no corrective action -> quality.corrective_action_required', () => {
    expect(codeOf(() => transitionRun(EARLY_REJECTED, { type: 'close', correctiveActionCount: 0, laterAcceptedRunAfterWindow: true }))).toBe('quality.corrective_action_required');
  });
  it('corrective action but no later accepted run outside the window -> quality.rerun_required', () => {
    expect(codeOf(() => transitionRun(EARLY_REJECTED, { type: 'close', correctiveActionCount: 2, laterAcceptedRunAfterWindow: false }))).toBe('quality.rerun_required');
  });
  it('both missing: corrective_action_required is reported first', () => {
    expect(codeOf(() => transitionRun(FULL_REJECTED, { type: 'close', correctiveActionCount: 0, laterAcceptedRunAfterWindow: false }))).toBe('quality.corrective_action_required');
  });
  it.each([-1, 1.5, Number.NaN])('rejects nonsense corrective action count %s (cannot satisfy the guard)', (n) => {
    expect(codeOf(() => transitionRun(EARLY_REJECTED, { type: 'close', correctiveActionCount: n, laterAcceptedRunAfterWindow: true }))).toBeDefined();
  });
  it.each([
    ['collecting', COLLECTING], ['accepted', ev('accepted', true)], ['accepted_warning', ev('accepted_warning', true)],
    ['incomplete', ev('incomplete', false)], ['closed', CLOSED],
  ] as [string, RS][])('closing a non-rejected / %s run -> common.immutable_record, even with both guards satisfied', (_n, s) => {
    expect(codeOf(() => transitionRun(s, OK_CLOSE))).toBe('common.immutable_record');
  });
});

describe('forbidden transitions (03-APP-FLOW "Forbidden", 07-SECURITY S-09/S-10)', () => {
  it('outcome can never change once set: complete/finalize on an evaluated run -> quality.qc_run_already_evaluated', () => {
    for (const s of [ev('accepted', true), ev('accepted_warning', true), ev('incomplete', false), EARLY_REJECTED, FULL_REJECTED]) {
      for (const outcome of OUTCOMES) {
        expect(codeOf(() => transitionRun(s, { type: 'complete', outcome }))).toBe('quality.qc_run_already_evaluated');
        expect(codeOf(() => transitionRun(s, { type: 'finalize', outcome }))).toBe('quality.qc_run_already_evaluated');
      }
    }
  });
  it('reject_early on an already evaluated rejected run is refused (no second event)', () => {
    expect(codeOf(() => transitionRun(EARLY_REJECTED, { type: 'reject_early' }))).toBeDefined();
  });
  it('closed -> * is refused for every event (also trigger quality.enforce_run_frozen)', () => {
    const evs: Ev[] = [
      { type: 'open' }, { type: 'add_member' }, { type: 'reject_early' }, { type: 'attach_late_member' }, OK_CLOSE,
      ...OUTCOMES.flatMap((outcome): Ev[] => [{ type: 'complete', outcome }, { type: 'finalize', outcome }]),
    ];
    for (const e of evs) {
      const c = codeOf(() => transitionRun(CLOSED, e));
      expect(c).toBeDefined();
      if (e.type === 'complete' || e.type === 'finalize' || e.type === 'close') {
        expect(['common.immutable_record', 'quality.qc_run_already_evaluated']).toContain(c);
      }
    }
  });
  it('late member only attaches to an early-rejected run (evaluated/rejected/is_complete=false)', () => {
    for (const s of [COLLECTING, ev('accepted', true), ev('accepted_warning', true), ev('incomplete', false), FULL_REJECTED, CLOSED]) {
      expect(codeOf(() => transitionRun(s, { type: 'attach_late_member' }))).toBeDefined();
    }
  });
  it('add_member / reject_early need a collecting run', () => {
    for (const s of [ev('accepted', true), ev('incomplete', false), EARLY_REJECTED, FULL_REJECTED, CLOSED]) {
      expect(codeOf(() => transitionRun(s, { type: 'add_member' }))).toBeDefined();
      expect(codeOf(() => transitionRun(s, { type: 'reject_early' }))).toBeDefined();
    }
  });
  it('open needs "no run": refused for every existing state', () => {
    for (const s of [COLLECTING, ev('accepted', true), EARLY_REJECTED, CLOSED]) {
      expect(codeOf(() => transitionRun(s, { type: 'open' }))).toBeDefined();
    }
  });
  it('every other event needs an existing run: null state refuses all but open', () => {
    const evs: Ev[] = [{ type: 'add_member' }, { type: 'reject_early' }, { type: 'attach_late_member' }, OK_CLOSE, { type: 'complete', outcome: 'accepted' }, { type: 'finalize', outcome: 'incomplete' }];
    for (const e of evs) expect(codeOf(() => transitionRun(null, e))).toBeDefined();
  });
  it('a refused transition leaves its input state untouched', () => {
    const s = Object.freeze({ ...EARLY_REJECTED });
    codeOf(() => transitionRun(s, { type: 'finalize', outcome: 'accepted' }));
    expect(s).toEqual(EARLY_REJECTED);
  });
});

describe('assertRunAction (#33 acknowledge, #27 exclude; S-10)', () => {
  it('acknowledging a collecting run -> common.immutable_record', () => {
    expect(codeOf(() => assertRunAction(COLLECTING, 'acknowledge'))).toBe('common.immutable_record');
  });
  it.each([['evaluated/rejected', EARLY_REJECTED], ['accepted', ev('accepted', true)], ['closed', CLOSED]] as [string, RS][])('acknowledge on %s run is allowed', (_n, s) => {
    expect(() => assertRunAction(s, 'acknowledge')).not.toThrow();
  });
  it('S-10: excluding an observation is allowed only while the run is collecting', () => {
    expect(() => assertRunAction(COLLECTING, 'exclude_observation')).not.toThrow();
    for (const s of [EARLY_REJECTED, FULL_REJECTED, ev('accepted', true), ev('incomplete', false), CLOSED]) {
      expect(codeOf(() => assertRunAction(s, 'exclude_observation'))).toBe('quality.qc_run_already_evaluated');
    }
  });
});

describe('purity', () => {
  it('returns new state objects and never mutates its input', () => {
    const s = Object.freeze({ ...COLLECTING });
    const r = transitionRun(s, { type: 'reject_early' });
    expect(r.state).not.toBe(s);
    expect(s).toEqual(COLLECTING);
  });
  it('module source reads no clock, randomness, DB or env', () => {
    const src = readFileSync(new URL('../run.state.ts', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(src).not.toMatch(/Date\.now\s*\(|new Date\s*\(|Math\.random|process\.env|from ['"](pg|kysely|knex|node:)/);
  });
});
