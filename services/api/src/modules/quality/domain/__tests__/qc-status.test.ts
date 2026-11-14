// C9 T-05 — qcStatus, pure (02-TRD §7.8 steps 1-6, vectors S1-S8; 03-IC §4.11 contract cases 6/7/8/9; CR-C9-003 semantics).
// ACs: AC-09.1 (S1-S8 exact), AC-09.2 (no run -> no_qc_data; only 1-2s -> warning), AC-09.3 (open rejected masks newer accepted), AC-09.4 (validity).
// Interface expected from the writer (../qc-status.ts). Names are NOT fixed by the spec, so this harness fixes them (T-05 tester seam, same style as T-04):
//   interface QcStatusRun { id: string; status: 'collecting'|'evaluated'|'closed'; outcome: 'accepted'|'accepted_warning'|'incomplete'|'rejected'|null;
//                           runAt: Date; closedAt: Date | null; rulesViolated: readonly string[] }
//   qcStatus(i: { hasPlan: boolean; runs: readonly QcStatusRun[]; at: Date; qcValidityHours: number }):
//     { status: 'in_control'|'warning'|'out_of_control'|'no_qc_data'; lastInControlRunAt?: Date; currentRunId?: string; violatedRules?: readonly string[] }
//   Absent values (the "—" cells of §7.8) are ABSENT KEYS, not undefined-valued keys. `runs` = all runs of the plan, any order, any status/run_at;
//   the function applies the "status in {evaluated, closed} and run_at <= at" filter itself (step 2). No DB, no clock, no mutation of inputs.
import { describe, it, expect } from 'vitest';
import * as mod from '../qc-status';

type Outcome = 'accepted' | 'accepted_warning' | 'incomplete' | 'rejected' | null;
interface Run { id: string; status: 'collecting' | 'evaluated' | 'closed'; outcome: Outcome; runAt: Date; closedAt: Date | null; rulesViolated: readonly string[] }
interface Result { status: string; lastInControlRunAt?: Date; currentRunId?: string; violatedRules?: readonly string[] }
type Input = { hasPlan: boolean; runs: readonly Run[]; at: Date; qcValidityHours: number };
const qcStatus = (mod as unknown as { qcStatus: (i: Input) => Result }).qcStatus;

const D = (hhmm: string, day = '2026-11-05') => new Date(`${day}T${hhmm}:00.000Z`);
const run = (id: string, runAt: Date, outcome: Outcome, over: Partial<Run> = {}): Run => ({
  id, status: 'evaluated', outcome, runAt, closedAt: null, rulesViolated: [], ...over,
});

// §7.8 timeline (pair I1xK, validity 24 h): R1 01:00 accepted; R2 06:00 accepted_warning (1-2s); R3 09:00 rejected (1-3s) closed 10:30; R4 10:00 accepted; R5 14:00 incomplete.
const R1 = run('R1', D('01:00'), 'accepted');
const R2 = run('R2', D('06:00'), 'accepted_warning', { rulesViolated: ['1-2s'] });
const R3 = run('R3', D('09:00'), 'rejected', { status: 'closed', closedAt: D('10:30'), rulesViolated: ['1-3s'] });
const R4 = run('R4', D('10:00'), 'accepted');
const R5 = run('R5', D('14:00'), 'incomplete');
const TIMELINE: readonly Run[] = [R1, R2, R3, R4, R5];
const call = (at: Date, runs: readonly Run[] = TIMELINE, over: Partial<Input> = {}): Result =>
  qcStatus({ hasPlan: true, runs, at, qcValidityHours: 24, ...over });

describe('AC-09.1 vectors S1-S8 (02-TRD §7.8)', () => {
  it('S1 00:30 -> no_qc_data, no other keys', () => {
    const r = call(D('00:30'));
    expect(r.status).toBe('no_qc_data');
    expect(Object.keys(r)).toEqual(['status']);
  });
  it('S2 03:00 -> in_control, last 01:00, current R1, no violatedRules key', () => {
    const r = call(D('03:00'));
    expect(r.status).toBe('in_control');
    expect(r.lastInControlRunAt).toEqual(D('01:00'));
    expect(r.currentRunId).toBe('R1');
    expect('violatedRules' in r).toBe(false);
  });
  it('S3 07:00 -> warning, last 06:00 (the warning run itself counts), current R2, [1-2s]', () => {
    const r = call(D('07:00'));
    expect(r).toEqual({ status: 'warning', lastInControlRunAt: D('06:00'), currentRunId: 'R2', violatedRules: ['1-2s'] });
  });
  it('S4 09:30 -> out_of_control, last 06:00, current R3 (rejected, not yet closed), [1-3s]', () => {
    expect(call(D('09:30'))).toEqual({ status: 'out_of_control', lastInControlRunAt: D('06:00'), currentRunId: 'R3', violatedRules: ['1-3s'] });
  });
  it('S5 10:15 -> out_of_control although newer accepted R4 exists (R3 still open: closed_at 10:30 > at); last 10:00', () => {
    expect(call(D('10:15'))).toEqual({ status: 'out_of_control', lastInControlRunAt: D('10:00'), currentRunId: 'R3', violatedRules: ['1-3s'] });
  });
  it('S6 11:00 -> in_control, last 10:00, current R4, no violatedRules key', () => {
    const r = call(D('11:00'));
    expect(r.status).toBe('in_control');
    expect(r.lastInControlRunAt).toEqual(D('10:00'));
    expect(r.currentRunId).toBe('R4');
    expect('violatedRules' in r).toBe(false);
  });
  it('S7 15:00 -> warning, last 10:00, current R5, [incomplete_run]', () => {
    expect(call(D('15:00'))).toEqual({ status: 'warning', lastInControlRunAt: D('10:00'), currentRunId: 'R5', violatedRules: ['incomplete_run'] });
  });
  it('S8 2026-11-06T10:30 -> no_qc_data (10:00 is 24.5 h old) but keeps last 10:00 (11-05), current R5, [incomplete_run]', () => {
    expect(call(D('10:30', '2026-11-06'))).toEqual({ status: 'no_qc_data', lastInControlRunAt: D('10:00'), currentRunId: 'R5', violatedRules: ['incomplete_run'] });
  });
  it('vectors do not depend on the order the runs are passed in', () => {
    const rev = [...TIMELINE].reverse();
    const shuffled = [R3, R5, R1, R4, R2];
    for (const at of [D('00:30'), D('03:00'), D('07:00'), D('09:30'), D('10:15'), D('11:00'), D('15:00'), D('10:30', '2026-11-06')]) {
      expect(call(at, rev)).toEqual(call(at));
      expect(call(at, shuffled)).toEqual(call(at));
    }
  });
});

describe('AC-09.2 no data / warning (03-IC §4.11 contract cases 7 and 6)', () => {
  it('step 1: no plan for the pair -> no_qc_data only, even when runs are supplied', () => {
    const r = call(D('11:00'), TIMELINE, { hasPlan: false });
    expect(r).toEqual({ status: 'no_qc_data' });
    expect(Object.keys(r)).toEqual(['status']);
  });
  it('step 2: plan but zero runs -> no_qc_data only', () => {
    expect(call(D('11:00'), [])).toEqual({ status: 'no_qc_data' });
  });
  it('step 2: only collecting runs (never evaluated) -> no_qc_data only', () => {
    expect(call(D('11:00'), [run('C1', D('10:00'), null, { status: 'collecting' })])).toEqual({ status: 'no_qc_data' });
  });
  it('step 2: only runs with run_at after `at` -> no_qc_data only (time before any evaluated run)', () => {
    expect(call(D('00:59'), [R1, R2])).toEqual({ status: 'no_qc_data' });
  });
  it('run_at == at is included (<=)', () => {
    expect(call(D('01:00'), [R1])).toEqual({ status: 'in_control', lastInControlRunAt: D('01:00'), currentRunId: 'R1' });
  });
  it('a collecting run is ignored even when newer than the governing run', () => {
    const c = run('C1', D('12:00'), null, { status: 'collecting' });
    expect(call(D('13:00'), [R1, R4, c])).toEqual({ status: 'in_control', lastInControlRunAt: D('10:00'), currentRunId: 'R4' });
  });
  it('only a 1-2s warning on the governing run -> warning with violatedRules [1-2s]', () => {
    expect(call(D('07:00'), [R2])).toEqual({ status: 'warning', lastInControlRunAt: D('06:00'), currentRunId: 'R2', violatedRules: ['1-2s'] });
  });
  it('incomplete run that also carries 1-2s -> warning, [incomplete_run, 1-2s] in that order', () => {
    const inc = run('RI', D('05:00'), 'incomplete', { rulesViolated: ['1-2s'] });
    expect(call(D('06:00'), [R1, inc])).toEqual({ status: 'warning', lastInControlRunAt: D('01:00'), currentRunId: 'RI', violatedRules: ['incomplete_run', '1-2s'] });
  });
  it('incomplete run alone (no accepted run ever): no_qc_data (step 6, lastInControlRunAt absent) but keeps currentRunId and violatedRules', () => {
    const r = call(D('15:00'), [R5]);
    expect(r.status).toBe('no_qc_data');
    expect('lastInControlRunAt' in r).toBe(false);
    expect(r.currentRunId).toBe('R5');
    expect(r.violatedRules).toEqual(['incomplete_run']);
  });
  it('accepted_warning governing run whose rulesViolated is empty still reports [1-2s] (fixed by §7.8 step 4)', () => {
    const w = run('RW', D('02:00'), 'accepted_warning', { rulesViolated: [] });
    expect(call(D('03:00'), [w]).violatedRules).toEqual(['1-2s']);
  });
});

describe('AC-09.3 open rejected run masks newer accepted runs (contract case 8, S4/S5)', () => {
  const rej = run('RJ', D('09:00'), 'rejected', { rulesViolated: ['1-3s'] }); // evaluated, never closed
  it('rejected, not closed, newer accepted run -> out_of_control, current = rejected run, last = newer accepted', () => {
    expect(call(D('12:00'), [R1, rej, R4])).toEqual({ status: 'out_of_control', lastInControlRunAt: D('10:00'), currentRunId: 'RJ', violatedRules: ['1-3s'] });
  });
  it('stays out_of_control long after (no staleness for out_of_control)', () => {
    const r = call(D('09:00', '2026-11-20'), [R1, rej, R4]);
    expect(r.status).toBe('out_of_control');
    expect(r.currentRunId).toBe('RJ');
  });
  it('closed_at > at -> still open at `at`; closed_at == at -> already closed (strict >)', () => {
    const closed = run('RC', D('09:00'), 'rejected', { status: 'closed', closedAt: D('10:30'), rulesViolated: ['1-3s'] });
    expect(call(D('10:29'), [R1, closed, R4]).status).toBe('out_of_control');
    expect(call(D('10:30'), [R1, closed, R4]).status).toBe('in_control');
    expect(call(D('10:31'), [R1, closed, R4]).currentRunId).toBe('R4');
  });
  it('several open rejected runs: the latest run_at wins, its rulesViolated are reported', () => {
    const a = run('RA', D('08:00'), 'rejected', { rulesViolated: ['4-1s'] });
    const b = run('RB', D('09:00'), 'rejected', { rulesViolated: ['R-4s', '1-3s'] });
    expect(call(D('10:00'), [a, b, R1])).toEqual({ status: 'out_of_control', lastInControlRunAt: D('01:00'), currentRunId: 'RB', violatedRules: ['R-4s', '1-3s'] });
  });
  it('rejected run with run_at after `at` does not count (time-travel safe)', () => {
    expect(call(D('08:00'), [R1, rej]).status).toBe('in_control');
  });
  it('only rejected run, open: last absent, out_of_control', () => {
    const r = call(D('10:00'), [rej]);
    expect(r.status).toBe('out_of_control');
    expect('lastInControlRunAt' in r).toBe(false);
    expect(r.currentRunId).toBe('RJ');
  });
  it('closed rejected run is no longer a governing candidate: governing run is the latest evaluated/closed run (here the closed rejected run itself is not accepted-ish)', () => {
    // R3 closed at 10:30 with no later accepted run: step 3 finds no open run; g = latest run in E = R3 (rejected) -> no accepted/warning/incomplete branch.
    // §7.8 step 4 only defines accepted / accepted_warning / incomplete; a closed rejected run can only be closed after a later accepted run (QR7), so this state is unreachable.
    // Pinned here: the function must not throw and must not report in_control for it.
    const r = call(D('11:00'), [R1, R3]);
    expect(r.status).not.toBe('in_control');
  });
});

describe('AC-09.4 validity (qc_validity_hours, default 24)', () => {
  const acc = run('RV', D('00:00'), 'accepted');
  it('exactly 24 h old -> still in_control (strict >)', () => {
    expect(call(D('00:00', '2026-11-06'), [acc]).status).toBe('in_control');
  });
  it('24 h + 1 ms old -> no_qc_data, lastInControlRunAt kept', () => {
    const at = new Date(D('00:00', '2026-11-06').getTime() + 1);
    expect(call(at, [acc])).toEqual({ status: 'no_qc_data', lastInControlRunAt: D('00:00'), currentRunId: 'RV' });
  });
  it('validity is read from the input, not hard-coded: 1 h and 168 h', () => {
    expect(call(D('01:00'), [acc], { qcValidityHours: 1 }).status).toBe('in_control');
    expect(call(new Date(D('01:00').getTime() + 1), [acc], { qcValidityHours: 1 }).status).toBe('no_qc_data');
    expect(call(D('00:00', '2026-11-12'), [acc], { qcValidityHours: 168 }).status).toBe('in_control');
    expect(call(new Date(D('00:00', '2026-11-12').getTime() + 1), [acc], { qcValidityHours: 168 }).status).toBe('no_qc_data');
  });
  it('stale warning -> no_qc_data, keeps currentRunId and violatedRules', () => {
    const w = run('RW', D('00:00'), 'accepted_warning', { rulesViolated: ['1-2s'] });
    expect(call(D('00:01', '2026-11-06'), [w])).toEqual({ status: 'no_qc_data', lastInControlRunAt: D('00:00'), currentRunId: 'RW', violatedRules: ['1-2s'] });
  });
  it('staleness measures the latest accepted/accepted_warning run, not an incomplete one: old accepted + fresh incomplete -> no_qc_data', () => {
    const inc = run('RI', D('23:00'), 'incomplete');
    const r = call(D('23:30'), [run('RO', D('00:00', '2026-11-04'), 'accepted'), inc]);
    expect(r.status).toBe('no_qc_data');
    expect(r.currentRunId).toBe('RI');
  });
  it('a fresh accepted run after a stale one restores in_control', () => {
    const r = call(D('12:00', '2026-11-06'), [acc, run('RN', D('11:00', '2026-11-06'), 'accepted')]);
    expect(r).toEqual({ status: 'in_control', lastInControlRunAt: D('11:00', '2026-11-06'), currentRunId: 'RN' });
  });
});

describe('purity', () => {
  it('does not mutate its input (deep-frozen runs and array)', () => {
    const frozen = Object.freeze(TIMELINE.map((r) => Object.freeze({ ...r, rulesViolated: Object.freeze([...r.rulesViolated]) })));
    expect(() => call(D('10:15'), frozen as readonly Run[])).not.toThrow();
    expect(call(D('10:15'), frozen as readonly Run[])).toEqual(call(D('10:15')));
  });
  it('same input -> same output, and the result does not alias the input rulesViolated array', () => {
    const a = call(D('09:30'));
    const b = call(D('09:30'));
    expect(a).toEqual(b);
    expect(a.violatedRules).not.toBe(R3.rulesViolated);
  });
  it('does not read the wall clock: result is independent of Date.now()', () => {
    const real = Date.now;
    try {
      Date.now = () => new Date('2030-01-01T00:00:00Z').getTime();
      expect(call(D('03:00')).status).toBe('in_control');
    } finally { Date.now = real; }
  });
});
