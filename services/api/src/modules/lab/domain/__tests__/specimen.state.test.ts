// C5 T-02 — specimen state machine (03-IC §10.1 S1–S15, 02-TRD §3.3). done_when: every allowed transition + every forbidden example unit-tested.
// ACs: AC-03.4 (received → collected = 409 lab.specimen_invalid_transition), AC-04.3 (rejected/discarded scan-for-receive = lab.specimen_not_receivable),
//      AC-05.4 (approved → rejected = 409 lab.specimen_invalid_transition).
// Interface expected from the writer (../specimen.state.ts) — SEAMS (spec fixes behaviour, not names):
//   export const SPECIMEN_STATUSES: readonly SpecimenStatus[]      the 14 statuses of lab.specimens.status
//   export function specimenTransition(from: SpecimenStatus | null, to: SpecimenStatus, opts?: { isActive?: boolean }): 'S1'|…|'S15'
//        pure; returns the 03-IC transition id; throws LimsError('lab.specimen_invalid_transition') (409) when not in the table.
//        `from === null` = absent (S1). opts.isActive defaults true; inactive specimens accept only S13/S14 (03-APP-FLOW §1.1 note); other table-valid pairs → LimsError('lab.specimen_inactive') (409, 02-TRD §5).
//   export function isSpecimenTransitionAllowed(from, to, opts?): boolean     same table, no throw
//   export function assertSpecimenReceivable(status: SpecimenStatus): void    throws LimsError('lab.specimen_not_receivable') (409) for rejected/discarded
import { describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { assertSpecimenReceivable, isSpecimenTransitionAllowed, SPECIMEN_STATUSES, specimenTransition } from '../specimen.state.js';

type S = (typeof SPECIMEN_STATUSES)[number];
const ALL = [
  'ordered', 'collected', 'in_transit', 'received', 'aliquoted', 'in_process', 'resulted', 'verified', 'approved',
  'reported', 'rejected', 'recollection_ordered', 'stored', 'discarded',
] as S[];
const PRE_APPROVED = ['ordered', 'collected', 'in_transit', 'received', 'aliquoted', 'in_process', 'resulted', 'verified'] as S[];
const RECEIVED_TO_REPORTED = ['received', 'aliquoted', 'in_process', 'resulted', 'verified', 'approved', 'reported'] as S[];

/** The whole of 03-IC §10.1 as data: [from, to, id]. Anything not listed here must be forbidden. */
const TABLE: Array<[S | null, S, string]> = [
  [null, 'ordered', 'S1'],
  ['ordered', 'collected', 'S2'],
  ['collected', 'in_transit', 'S3'],
  ['collected', 'received', 'S4'],
  ['in_transit', 'received', 'S4'],
  ['received', 'aliquoted', 'S5'],
  ['received', 'in_process', 'S6'],
  ['aliquoted', 'in_process', 'S6'],
  ['in_process', 'resulted', 'S7'],
  ['resulted', 'verified', 'S8'],
  ['verified', 'approved', 'S9'],
  ['approved', 'reported', 'S10'],
  ...PRE_APPROVED.map((f): [S, S, string] => [f, 'rejected', 'S11']),
  ['rejected', 'recollection_ordered', 'S12'],
  ...RECEIVED_TO_REPORTED.map((f): [S, S, string] => [f, 'stored', 'S13']),
  ...(['stored', 'reported', 'rejected', 'recollection_ordered'] as S[]).map((f): [S, S, string] => [f, 'discarded', 'S14']),
  ['verified', 'resulted', 'S15'],
  ['approved', 'verified', 'S15'],
];
const key = (f: S | null, t: S): string => `${f ?? '∅'}>${t}`;
const ALLOWED = new Map(TABLE.map(([f, t, id]) => [key(f, t), id]));

function expectInvalid(fn: () => unknown): void {
  let err: unknown;
  try { fn(); } catch (e) { err = e; }
  expect(isLimsError(err, 'lab.specimen_invalid_transition'), `expected LimsError lab.specimen_invalid_transition, got ${String(err)}`).toBe(true);
  expect((err as { statusCode: number }).statusCode).toBe(409);
}

describe('T-02 specimen status set', () => {
  it('has exactly the 14 statuses of lab.specimens.status', () => {
    expect([...SPECIMEN_STATUSES].sort()).toEqual([...ALL].sort());
  });
});

describe('T-02 specimen allowed transitions S1–S15 (03-IC §10.1)', () => {
  it.each(TABLE)('%s → %s is allowed and is %s', (from, to, id) => {
    expect(specimenTransition(from, to)).toBe(id);
    expect(isSpecimenTransitionAllowed(from, to)).toBe(true);
  });

  it('every S-number S1..S15 is exercised at least once', () => {
    expect(new Set(TABLE.map((r) => r[2]))).toEqual(new Set(Array.from({ length: 15 }, (_, i) => `S${i + 1}`)));
  });
});

describe('T-02 specimen forbidden transitions', () => {
  it('03-IC §10.1 named examples → lab.specimen_invalid_transition (409)', () => {
    expectInvalid(() => specimenTransition('received', 'collected')); // AC-03.4
    expectInvalid(() => specimenTransition('approved', 'rejected')); // AC-05.4
    expectInvalid(() => specimenTransition('rejected', 'received'));
    for (const to of ALL) expectInvalid(() => specimenTransition('discarded', to)); // any transition out of discarded
  });

  it('03-APP-FLOW §1.1 extra forbidden: ordered → received (must be collected first), reported → rejected', () => {
    expectInvalid(() => specimenTransition('ordered', 'received'));
    expectInvalid(() => specimenTransition('reported', 'rejected'));
  });

  it('S11 never starts from stored / discarded / recollection_ordered / rejected / reported / approved (02-TRD §3.3)', () => {
    for (const f of ['stored', 'discarded', 'recollection_ordered', 'rejected', 'reported', 'approved'] as S[]) {
      expectInvalid(() => specimenTransition(f, 'rejected'));
    }
  });

  it('S4 only from collected / in_transit; S12 only from rejected; S5 only from received', () => {
    for (const f of ALL.filter((s) => s !== 'collected' && s !== 'in_transit')) expectInvalid(() => specimenTransition(f, 'received'));
    for (const f of ALL.filter((s) => s !== 'rejected')) expectInvalid(() => specimenTransition(f, 'recollection_ordered'));
    for (const f of ALL.filter((s) => s !== 'received')) expectInvalid(() => specimenTransition(f, 'aliquoted'));
  });

  it('absent → anything but ordered is forbidden (S1 is the only creation)', () => {
    for (const to of ALL.filter((s) => s !== 'ordered')) expectInvalid(() => specimenTransition(null, to));
  });

  it('no status transitions to itself', () => {
    for (const s of ALL) expectInvalid(() => specimenTransition(s, s));
  });

  it('EXHAUSTIVE: every (from,to) pair outside the §10.1 table is forbidden; every pair inside is allowed', () => {
    for (const from of [null, ...ALL]) {
      for (const to of ALL) {
        const ok = ALLOWED.has(key(from, to));
        expect(isSpecimenTransitionAllowed(from, to), key(from, to)).toBe(ok);
        if (ok) expect(specimenTransition(from, to), key(from, to)).toBe(ALLOWED.get(key(from, to)));
        else expectInvalid(() => specimenTransition(from, to));
      }
    }
  });
});

describe('T-02 inactive specimens (03-APP-FLOW §1.1: only S13/S14 once received)', () => {
  it('reject S2 / S4 / S11 when isActive = false → lab.specimen_inactive (409, 02-TRD §5, CR-C5-005)', () => {
    for (const [from, to] of [['ordered', 'collected'], ['collected', 'received'], ['collected', 'rejected']] as Array<[S, S]>) {
      let err: unknown;
      try { specimenTransition(from, to, { isActive: false }); } catch (e) { err = e; }
      expect(isLimsError(err, 'lab.specimen_inactive'), `${from}>${to}: got ${String(err)}`).toBe(true);
      expect((err as { statusCode: number }).statusCode).toBe(409);
      expect(isSpecimenTransitionAllowed(from, to, { isActive: false })).toBe(false);
    }
  });
  it('an illegal pair stays invalid_transition even when inactive (table first)', () => {
    expectInvalid(() => specimenTransition('received', 'collected', { isActive: false }));
  });
  it('still allow S13 and S14', () => {
    expect(specimenTransition('received', 'stored', { isActive: false })).toBe('S13');
    expect(specimenTransition('stored', 'discarded', { isActive: false })).toBe('S14');
  });
  it('isActive defaults to true', () => {
    expect(specimenTransition('ordered', 'collected', {})).toBe('S2');
  });
});

describe('T-02 AC-04.3 receive scan on rejected / discarded', () => {
  it.each(['rejected', 'discarded'] as S[])('%s → lab.specimen_not_receivable (409)', (s) => {
    let err: unknown;
    try { assertSpecimenReceivable(s); } catch (e) { err = e; }
    expect(isLimsError(err, 'lab.specimen_not_receivable')).toBe(true);
    expect((err as { statusCode: number }).statusCode).toBe(409);
  });
  it.each(['collected', 'in_transit'] as S[])('%s is receivable', (s) => {
    expect(() => assertSpecimenReceivable(s)).not.toThrow();
  });
});
