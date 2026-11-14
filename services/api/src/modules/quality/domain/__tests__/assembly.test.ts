// C9 T-04 — run assembly, pure (02-TRD §7.3 steps 1-7, AS1-AS4; 08 A17 D-52 early-rejected late members).
// done_when: window, composition full, early rejection, late member attached to early-rejected run (step 1a), stale close on last_assembled_at.
// ACs: AC-06.6 (V27 then L2 inside window = one run, one event — AS1), AC-06.7 (stale/incomplete run closes on last_assembled_at — AS4, step 7).
// Interface expected from the writer (../assembly.ts). Signatures are NOT fixed by the spec, so this harness fixes them (T-04 tester seam):
//   assembleObservation({ observation, collecting, latestEarlyRejected, composition, runWindowMinutes }): AssemblyDecision
//     observation          { id, level, observedAt: Date }
//     collecting           the pair's collecting run or null (§7.3 step 1)
//     latestEarlyRejected  the caller's query result for step 1a (pair's latest evaluated+rejected+!is_complete run) or null.
//                          The function re-checks status/outcome/isComplete itself and ignores it when a collecting run exists.
//     composition          { L1: 1, L2: 1 } required count per level;  runWindowMinutes: number
//     AssemblyDecision =
//       { action: 'attach_collecting', runId }          step 2   (caller then evaluates provisionally, step 5)
//     | { action: 'attach_early_rejected', runId }      step 1a  (never re-evaluated, no second event)
//     | { action: 'open_run', finalizeRunId: string | null }   steps 3/4 (finalizeRunId = collecting run to evaluate final first, step 3)
//   isCompositionFull(levelCounts, composition): boolean      step 5 "N observations matching the composition"
//   isStale(run, now: Date, runWindowMinutes): boolean         step 7, server time `now` is a parameter (module must not read the clock)
// Window test uses observed_at - run_at <= window (inclusive); staleness uses last_assembled_at < now - window (strict).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assembleObservation, isCompositionFull, isStale } from '../assembly.js';
import { transitionRun } from '../run.state.js';

type Level = string;
interface Run {
  id: string;
  status: 'collecting' | 'evaluated' | 'closed';
  outcome: 'accepted' | 'accepted_warning' | 'incomplete' | 'rejected' | null;
  isComplete: boolean;
  runAt: Date;
  lastAssembledAt: Date;
  levelCounts: Record<Level, number>;
}
const T = (hhmm: string, day = '2026-11-13'): Date => new Date(`${day}T${hhmm}:00.000Z`);
const COMP = { L1: 1, L2: 1 } as const;
const WINDOW = 30;

const collectingRun = (o: Partial<Run> = {}): Run => ({
  id: 'run-c', status: 'collecting', outcome: null, isComplete: false,
  runAt: T('08:00'), lastAssembledAt: T('08:00'), levelCounts: { L1: 1 }, ...o,
});
// V27: L1 z 3.4 at 08:00, rejected early (AS1 precondition)
const earlyRejected = (o: Partial<Run> = {}): Run => ({
  id: 'run-r', status: 'evaluated', outcome: 'rejected', isComplete: false,
  runAt: T('08:00'), lastAssembledAt: T('08:00'), levelCounts: { L1: 1 }, ...o,
});
const obs = (id: string, level: Level, at: Date) => ({ id, level, observedAt: at });
const decide = (o: ReturnType<typeof obs>, collecting: Run | null, latestEarlyRejected: Run | null, composition: Record<Level, number> = COMP, runWindowMinutes = WINDOW) =>
  assembleObservation({ observation: o, collecting, latestEarlyRejected, composition, runWindowMinutes });

describe('AS1-AS4 (02-TRD §7.3 assembly vectors, N=2, composition {L1:1,L2:1}, window 30)', () => {
  it('AS1 / AC-06.6: V27 rejected early, L2 at 08:10 attaches to the same run, no re-evaluation, no second event', () => {
    // first member: nothing exists -> open a run (QR1), then provisional rejection (QR3) emits exactly one event
    expect(decide(obs('o1', 'L1', T('08:00')), null, null)).toEqual({ action: 'open_run', finalizeRunId: null });
    const opened = transitionRun(null, { type: 'open' });
    const rejected = transitionRun(opened.state, { type: 'reject_early' });
    expect(rejected.emitsRejectedEvent).toBe(true);
    // L2 at 08:10: step 1a
    const d = decide(obs('o2', 'L2', T('08:10')), null, earlyRejected());
    expect(d).toEqual({ action: 'attach_early_rejected', runId: 'run-r' });
    const late = transitionRun(rejected.state, { type: 'attach_late_member' });
    expect(late.emitsRejectedEvent).toBe(false); // exactly one quality.qc_run.rejected.v1 across the sequence
    expect(late.state).toEqual({ status: 'evaluated', outcome: 'rejected', isComplete: false }); // frozen: outcome and is_complete never change
  });

  it('AS2: same, but L2 observed 08:40 (outside window) opens a new collecting run', () => {
    expect(decide(obs('o2', 'L2', T('08:40')), null, earlyRejected())).toEqual({ action: 'open_run', finalizeRunId: null });
  });

  it('AS3: a second L1 at 08:15 hits count(R,L1)=composition[L1], opens a new run (step 4)', () => {
    expect(decide(obs('o2', 'L1', T('08:15')), null, earlyRejected())).toEqual({ action: 'open_run', finalizeRunId: null });
  });

  it('AS4 / AC-06.7: backlog L1 observed 02:00 assembled 08:00; stale tick 08:05 does not close; L2 observed 02:02 joins; run complete', () => {
    const r = collectingRun({ id: 'run-b', runAt: T('02:00'), lastAssembledAt: T('08:00'), levelCounts: { L1: 1 } });
    expect(isStale(r, T('08:05'), WINDOW)).toBe(false); // last_assembled_at 08:00 + 30 > 08:05 (server time, not received_at/observed_at)
    // window test uses observed_at: 02:02 - 02:00 = 2 min <= 30
    expect(decide(obs('o2', 'L2', T('02:02')), r, null)).toEqual({ action: 'attach_collecting', runId: 'run-b' });
    expect(isCompositionFull({ L1: 1, L2: 1 }, COMP)).toBe(true); // -> evaluate final, one complete run
  });
});

describe('window (step 2) and composition full (steps 2/3)', () => {
  it('joins a collecting run at exactly run_window_minutes (inclusive), not one millisecond later', () => {
    const r = collectingRun();
    expect(decide(obs('o', 'L2', T('08:30')), r, null)).toEqual({ action: 'attach_collecting', runId: 'run-c' });
    expect(decide(obs('o', 'L2', new Date(T('08:30').getTime() + 1)), r, null)).toEqual({ action: 'open_run', finalizeRunId: 'run-c' });
  });

  it('out of window with a collecting run: finalise it (step 3) then open a new run with the observation', () => {
    expect(decide(obs('o', 'L2', T('09:00')), collectingRun(), null)).toEqual({ action: 'open_run', finalizeRunId: 'run-c' });
  });

  it('composition full for that level closes the current run and opens a new one (E5 repeated control)', () => {
    expect(decide(obs('o', 'L1', T('08:05')), collectingRun(), null)).toEqual({ action: 'open_run', finalizeRunId: 'run-c' });
  });

  it('respects a different window (5 min) and composition (L1:2)', () => {
    const r = collectingRun({ levelCounts: { L1: 1 } });
    expect(decide(obs('o', 'L2', T('08:06')), r, null, { L1: 1, L2: 1 }, 5)).toEqual({ action: 'open_run', finalizeRunId: 'run-c' });
    expect(decide(obs('o', 'L1', T('08:04')), r, null, { L1: 2, L2: 1 }, 5)).toEqual({ action: 'attach_collecting', runId: 'run-c' });
  });

  it('isCompositionFull: needs every level at its count, partial / empty / unknown level is not full', () => {
    expect(isCompositionFull({ L1: 1, L2: 1 }, COMP)).toBe(true);
    expect(isCompositionFull({ L1: 1 }, COMP)).toBe(false);
    expect(isCompositionFull({}, COMP)).toBe(false);
    expect(isCompositionFull({ L1: 2, L2: 1, L3: 1 }, { L1: 2, L2: 1, L3: 1 })).toBe(true); // N=4, L1 twice
    expect(isCompositionFull({ L1: 1, L2: 1, L3: 1 }, { L1: 2, L2: 1, L3: 1 })).toBe(false);
  });
});

describe('late member of an early-rejected run (step 1a, 08 A17 D-52)', () => {
  it('attaches inside the window while the level count is below composition', () => {
    expect(decide(obs('o', 'L2', T('08:30')), null, earlyRejected())).toEqual({ action: 'attach_early_rejected', runId: 'run-r' });
  });

  it('does not attach one millisecond after the window', () => {
    expect(decide(obs('o', 'L2', new Date(T('08:30').getTime() + 1)), null, earlyRejected())).toEqual({ action: 'open_run', finalizeRunId: null });
  });

  it('measures the window from run_at, not from the last attached member', () => {
    const r = earlyRejected({ lastAssembledAt: T('08:29'), levelCounts: { L1: 1, L2: 0 } });
    expect(decide(obs('o', 'L2', T('08:31')), null, r)).toEqual({ action: 'open_run', finalizeRunId: null });
  });

  it('composition full (all levels present) opens a new run even inside the window', () => {
    const r = earlyRejected({ levelCounts: { L1: 1, L2: 1 } });
    expect(decide(obs('o', 'L2', T('08:10')), null, r)).toEqual({ action: 'open_run', finalizeRunId: null });
  });

  it.each([
    ['closed', { status: 'closed' as const }],
    ['accepted', { outcome: 'accepted' as const }],
    ['accepted_warning', { outcome: 'accepted_warning' as const }],
    ['incomplete', { outcome: 'incomplete' as const }],
    ['rejected but complete (is_complete = true)', { isComplete: true }],
    ['still collecting', { status: 'collecting' as const, outcome: null }],
  ])('never attaches to a %s run even if the caller hands it over', (_n, patch) => {
    expect(decide(obs('o', 'L2', T('08:10')), null, earlyRejected(patch))).toEqual({ action: 'open_run', finalizeRunId: null });
  });

  it('a collecting run wins over an early-rejected one (step 1a only runs when no collecting run exists)', () => {
    const c = collectingRun({ id: 'run-new', runAt: T('08:40'), lastAssembledAt: T('08:40'), levelCounts: { L1: 1 } });
    expect(decide(obs('o', 'L2', T('08:45')), c, earlyRejected())).toEqual({ action: 'attach_collecting', runId: 'run-new' });
    // out of the collecting run's window: finalise the collecting run, never attach to the old rejected one
    expect(decide(obs('o', 'L2', T('09:30')), c, earlyRejected({ runAt: T('09:20') }))).toEqual({ action: 'open_run', finalizeRunId: 'run-new' });
  });
});

describe('stale close on last_assembled_at (step 7)', () => {
  const r = collectingRun({ runAt: T('02:00'), lastAssembledAt: T('08:00') });
  it('is strict: exactly window after last_assembled_at is not stale, one ms later is', () => {
    expect(isStale(r, T('08:30'), WINDOW)).toBe(false);
    expect(isStale(r, new Date(T('08:30').getTime() + 1), WINDOW)).toBe(true);
  });
  it('uses last_assembled_at, never run_at: an old run_at with fresh assembly is not stale', () => {
    expect(isStale(r, T('08:10'), WINDOW)).toBe(false);
    expect(isStale(collectingRun({ runAt: T('08:00'), lastAssembledAt: T('08:00') }), T('08:31'), WINDOW)).toBe(true);
  });
  it('only collecting runs can be stale', () => {
    for (const run of [earlyRejected(), earlyRejected({ status: 'closed' }), collectingRun({ status: 'evaluated', outcome: 'accepted', isComplete: true })]) {
      expect(isStale(run, T('23:59'), WINDOW)).toBe(false);
    }
  });
  it('honours the window argument', () => {
    expect(isStale(collectingRun(), T('08:06'), 5)).toBe(true);
    expect(isStale(collectingRun(), T('08:06'), 240)).toBe(false);
  });
});

describe('purity / robustness (adversarial)', () => {
  const deepFreeze = <X>(x: X): X => {
    if (x && typeof x === 'object' && !(x instanceof Date)) { Object.values(x).forEach(deepFreeze); Object.freeze(x); }
    return x;
  };
  it('does not mutate frozen inputs and is deterministic', () => {
    const o = deepFreeze(obs('o', 'L2', T('08:10')));
    const c = deepFreeze(collectingRun());
    const e = deepFreeze(earlyRejected());
    const comp = deepFreeze({ ...COMP });
    const a = assembleObservation({ observation: o, collecting: c, latestEarlyRejected: null, composition: comp, runWindowMinutes: WINDOW });
    const b = assembleObservation({ observation: o, collecting: c, latestEarlyRejected: null, composition: comp, runWindowMinutes: WINDOW });
    expect(a).toEqual(b);
    expect(() => assembleObservation({ observation: o, collecting: null, latestEarlyRejected: e, composition: comp, runWindowMinutes: WINDOW })).not.toThrow();
    expect(() => isStale(c, T('09:00'), WINDOW)).not.toThrow();
  });
  it('level absent from the composition never joins a run', () => {
    expect(decide(obs('o', 'L9', T('08:05')), collectingRun(), null).action).toBe('open_run');
    expect(decide(obs('o', 'L9', T('08:05')), null, earlyRejected()).action).toBe('open_run');
  });
  it('module source reads no clock, randomness, DB or env (server time and data come in as arguments)', () => {
    const src = readFileSync(new URL('../assembly.ts', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(src).not.toMatch(/Date\.now\s*\(|new Date\s*\(\s*\)|Math\.random|process\.env|from ['"](pg|kysely|knex|node:)/);
  });
});
