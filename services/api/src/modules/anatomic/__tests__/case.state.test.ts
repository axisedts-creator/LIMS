// C11 T-02 — case state table (02-TRD §7 C1–C8 + forbidden examples; AC-/done_when: 100% of state rows + forbidden examples).
// SEAMS (spec fixes behaviour, not signatures):
//   ../domain/case.state.ts  export const CASE_STATUSES (6 values, order as in 05-SCHEMA cases__status__ck)
//                            export function canTransition(from: CaseStatus | null, to: CaseStatus): boolean   (null = no case yet, C1)
//                            export function assertTransition(from, to): void  -> throws LimsError('anatomic.case_invalid_transition')
//   ../domain/case.ts        export const CASE_KINDS ['histology','cytology','ihc','molecular']
//                            export function isOpenStatus(s): boolean       (received|accessioned|in_processing|ready_for_reporting — the open-case unique index)
//                            export function isDataEditable(s): boolean     (accessioned|in_processing|ready_for_reporting — TRD §7 "Data edits")
// Fails now: ../domain/case.state.js and ../domain/case.js do not exist.
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../core/errors.js';
import { CASE_KINDS, isDataEditable, isOpenStatus } from '../domain/case.js';
import { assertTransition, canTransition, CASE_STATUSES } from '../domain/case.state.js';

type S = (typeof CASE_STATUSES)[number];

const ALL: readonly S[] = ['received', 'accessioned', 'in_processing', 'ready_for_reporting', 'signed_out', 'cancelled'];

/** Every allowed edge, straight from TRD §7 (C1–C7; C8 "none in v1" is NOT allowed). */
const ALLOWED: ReadonlyArray<[S | null, S, string]> = [
  [null, 'received', 'C1'],
  ['received', 'accessioned', 'C2'],
  ['accessioned', 'in_processing', 'C3'],
  ['in_processing', 'ready_for_reporting', 'C4'],
  ['ready_for_reporting', 'signed_out', 'C5'],
  ['signed_out', 'signed_out', 'C6'],
  ['received', 'cancelled', 'C7'],
  ['accessioned', 'cancelled', 'C7'],
  ['in_processing', 'cancelled', 'C7'],
  ['ready_for_reporting', 'cancelled', 'C7'],
];
const key = (f: S | null, t: S): string => `${f ?? '(none)'}->${t}`;
const ALLOWED_KEYS = new Set(ALLOWED.map(([f, t]) => key(f, t)));

describe('C11 case.state — statuses', () => {
  it('has exactly the six statuses of cases__status__ck, in lifecycle order', () => {
    expect([...CASE_STATUSES]).toEqual(ALL);
  });
  it('kinds are exactly histology, cytology, ihc, molecular', () => {
    expect([...CASE_KINDS]).toEqual(['histology', 'cytology', 'ihc', 'molecular']);
  });
});

describe('C11 case.state — allowed transitions C1–C7', () => {
  it.each(ALLOWED)('%s -> %s (%s) is allowed', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });
});

describe('C11 case.state — every other pair is forbidden (full matrix)', () => {
  const pairs: Array<[S | null, S]> = [];
  for (const from of [null, ...ALL]) for (const to of ALL) if (!ALLOWED_KEYS.has(key(from, to))) pairs.push([from, to]);

  it('matrix covers all 7×6 = 42 pairs: 10 allowed + 32 forbidden', () => {
    expect(ALLOWED.length).toBe(10);
    expect(pairs.length).toBe(32);
  });

  it.each(pairs)('%s -> %s is forbidden → anatomic.case_invalid_transition', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    let err: unknown;
    try {
      assertTransition(from, to);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LimsError);
    expect((err as LimsError).code).toBe('anatomic.case_invalid_transition');
  });
});

describe('C11 case.state — named forbidden examples (TRD §7)', () => {
  it('received → in_processing (skips accession)', () => expect(canTransition('received', 'in_processing')).toBe(false));
  it('accessioned → signed_out (skips processing/ready)', () => expect(canTransition('accessioned', 'signed_out')).toBe(false));
  it('signed_out → cancelled', () => expect(canTransition('signed_out', 'cancelled')).toBe(false));
  it.each(ALL)('any transition out of cancelled: cancelled → %s', (to) => expect(canTransition('cancelled', to)).toBe(false));
  it('a second accession: accessioned → accessioned', () => expect(canTransition('accessioned', 'accessioned')).toBe(false));
  it('C8 has no v1 action: in_processing/ready_for_reporting → accessioned', () => {
    expect(canTransition('in_processing', 'accessioned')).toBe(false);
    expect(canTransition('ready_for_reporting', 'accessioned')).toBe(false);
  });
  it('only signed_out may transition to itself (C6 version n+1)', () => {
    for (const s of ALL) expect(canTransition(s, s)).toBe(s === 'signed_out');
  });
  it('nothing but "received" may be created from (none)', () => {
    for (const to of ALL) expect(canTransition(null, to)).toBe(to === 'received');
  });
});

describe('C11 case.state — input hardening', () => {
  it('unknown status strings are rejected, never allowed', () => {
    expect(canTransition('bogus' as S, 'accessioned')).toBe(false);
    expect(canTransition('received', 'bogus' as S)).toBe(false);
    expect(canTransition('__proto__' as S, 'received')).toBe(false);
    expect(canTransition('constructor' as S, 'received')).toBe(false);
    expect(() => assertTransition('received', 'bogus' as S)).toThrow(LimsError);
  });
});

describe('C11 case — status predicates', () => {
  it('isOpenStatus: the four statuses of the open-case partial index', () => {
    expect(ALL.filter(isOpenStatus)).toEqual(['received', 'accessioned', 'in_processing', 'ready_for_reporting']);
  });
  it('isDataEditable: accessioned, in_processing, ready_for_reporting only', () => {
    expect(ALL.filter(isDataEditable)).toEqual(['accessioned', 'in_processing', 'ready_for_reporting']);
  });
});
