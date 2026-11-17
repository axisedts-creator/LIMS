// C5 T-02 — result state machine (03-IC §10.2 R1–R8, 02-TRD §3.3). done_when: every allowed transition + every forbidden example unit-tested.
// ACs: AC-15.3 (pending → verified = 409 lab.result_invalid_transition). Security: 07-SECURITY S-02 (approver = verifier → lab.self_approval_forbidden).
// Interface expected from the writer (../result.state.ts) — SEAMS (spec fixes behaviour, not names):
//   export const RESULT_STATUSES: readonly ResultStatus[]    pending | resulted | verified | approved | cancelled
//   export function resultTransition(from: ResultStatus | null, to: ResultStatus,
//        guards?: { onHold?: boolean; verifiedBy?: string; approvedBy?: string }): 'R1'|…|'R8'
//        pure; `from === null` = absent (R1). Throws LimsError('lab.result_invalid_transition') (409) when not in the table (table is checked first).
//        R4 and R6 with guards.onHold = true → LimsError('lab.result_on_hold') (409).
//        R6 with verifiedBy or approvedBy missing, or approvedBy === verifiedBy →LimsError('lab.self_approval_forbidden') (403).
//   export function isResultTransitionAllowed(from, to): boolean       table only (no guards), no throw
//   export function assertResultValueEditable(status: ResultStatus): void    R2/R3 value change: approved → LimsError('lab.result_locked') (409);
//        cancelled → 'lab.result_invalid_transition'; pending / resulted ok.
import { describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { assertResultValueEditable, isResultTransitionAllowed, RESULT_STATUSES, resultTransition } from '../result.state.js';

type R = (typeof RESULT_STATUSES)[number];
const ALL = ['pending', 'resulted', 'verified', 'approved', 'cancelled'] as R[];

const TABLE: Array<[R | null, R, string]> = [
  [null, 'pending', 'R1'],
  ['pending', 'resulted', 'R2'],
  ['resulted', 'resulted', 'R3'],
  ['resulted', 'verified', 'R4'],
  ['verified', 'resulted', 'R5'],
  ['verified', 'approved', 'R6'],
  ['approved', 'approved', 'R7'],
  ['pending', 'cancelled', 'R8'],
  ['resulted', 'cancelled', 'R8'],
  ['verified', 'cancelled', 'R8'],
];
const R6_GUARDS = { verifiedBy: 'u1', approvedBy: 'u2' }; // R6 needs both ids, distinct (S-02, fail closed)
const key = (f: R | null, t: R): string => `${f ?? '∅'}>${t}`;
const ALLOWED = new Map(TABLE.map(([f, t, id]) => [key(f, t), id]));

function catchErr(fn: () => unknown): unknown {
  try { fn(); } catch (e) { return e; }
  return undefined;
}
function expectCode(fn: () => unknown, code: string, status: number): void {
  const err = catchErr(fn);
  expect(isLimsError(err, code), `expected LimsError ${code}, got ${String(err)}`).toBe(true);
  expect((err as { statusCode: number }).statusCode).toBe(status);
}
const expectInvalid = (fn: () => unknown): void => expectCode(fn, 'lab.result_invalid_transition', 409);

describe('T-02 result status set', () => {
  it('has exactly pending / resulted / verified / approved / cancelled', () => {
    expect([...RESULT_STATUSES].sort()).toEqual([...ALL].sort());
  });
});

describe('T-02 result allowed transitions R1–R8 (03-IC §10.2)', () => {
  it.each(TABLE)('%s → %s is allowed and is %s', (from, to, id) => {
    expect(resultTransition(from, to, R6_GUARDS)).toBe(id);
    expect(isResultTransitionAllowed(from, to)).toBe(true);
  });
  it('every R-number R1..R8 is exercised', () => {
    expect(new Set(TABLE.map((r) => r[2]))).toEqual(new Set(Array.from({ length: 8 }, (_, i) => `R${i + 1}`)));
  });
});

describe('T-02 result forbidden transitions → lab.result_invalid_transition (409)', () => {
  it('AC-15.3: pending → verified', () => {
    expectInvalid(() => resultTransition('pending', 'verified'));
  });
  it('cancelled → anything (terminal)', () => {
    for (const to of ALL) expectInvalid(() => resultTransition('cancelled', to));
  });
  it('approved cannot be cancelled (R8 excludes approved) nor go back (only R7 amends)', () => {
    for (const to of ['pending', 'resulted', 'verified', 'cancelled'] as R[]) expectInvalid(() => resultTransition('approved', to));
  });
  it('pending cannot skip to approved; verified cannot be re-verified; nothing returns to pending', () => {
    expectInvalid(() => resultTransition('pending', 'approved'));
    expectInvalid(() => resultTransition('pending', 'pending'));
    expectInvalid(() => resultTransition('verified', 'verified'));
    for (const f of ['resulted', 'verified', 'approved'] as R[]) expectInvalid(() => resultTransition(f, 'pending'));
  });
  it('absent → anything but pending', () => {
    for (const to of ALL.filter((s) => s !== 'pending')) expectInvalid(() => resultTransition(null, to));
  });
  it('EXHAUSTIVE: every (from,to) outside the §10.2 table is forbidden; every pair inside is allowed', () => {
    for (const from of [null, ...ALL]) {
      for (const to of ALL) {
        const ok = ALLOWED.has(key(from, to));
        expect(isResultTransitionAllowed(from, to), key(from, to)).toBe(ok);
        if (ok) expect(resultTransition(from, to, R6_GUARDS), key(from, to)).toBe(ALLOWED.get(key(from, to)));
        else expectInvalid(() => resultTransition(from, to));
      }
    }
  });
});

describe('T-02 value lock (R2/R3 vs approved)', () => {
  it('value change on approved → lab.result_locked (409); amend is the only way (R7)', () => {
    expectCode(() => assertResultValueEditable('approved'), 'lab.result_locked', 409);
  });
  it('value change on cancelled → lab.result_invalid_transition', () => {
    expectInvalid(() => assertResultValueEditable('cancelled'));
  });
  it.each(['pending', 'resulted'] as R[])('%s value is editable', (s) => {
    expect(() => assertResultValueEditable(s)).not.toThrow();
  });
});

describe('T-02 guards in the table (02-TRD §3.3)', () => {
  it('R4 / R6 on an on_hold result → lab.result_on_hold (409)', () => {
    expectCode(() => resultTransition('resulted', 'verified', { onHold: true }), 'lab.result_on_hold', 409);
    expectCode(() => resultTransition('verified', 'approved', { onHold: true, verifiedBy: 'u1', approvedBy: 'u2' }), 'lab.result_on_hold', 409);
  });
  it('on_hold does not block the other transitions (R2, R3, R5, R7, R8)', () => {
    expect(resultTransition('pending', 'resulted', { onHold: true })).toBe('R2');
    expect(resultTransition('resulted', 'resulted', { onHold: true })).toBe('R3');
    expect(resultTransition('verified', 'resulted', { onHold: true })).toBe('R5');
    expect(resultTransition('approved', 'approved', { onHold: true })).toBe('R7');
    expect(resultTransition('resulted', 'cancelled', { onHold: true })).toBe('R8');
  });
  it('S-02: R6 with approver = verifier → lab.self_approval_forbidden (403)', () => {
    expectCode(() => resultTransition('verified', 'approved', { verifiedBy: 'u1', approvedBy: 'u1' }), 'lab.self_approval_forbidden', 403);
  });
  it('S-02 fail closed: R6 with verifiedBy or approvedBy missing → lab.self_approval_forbidden (403)', () => {
    expectCode(() => resultTransition('verified', 'approved'), 'lab.self_approval_forbidden', 403);
    expectCode(() => resultTransition('verified', 'approved', {}), 'lab.self_approval_forbidden', 403);
    expectCode(() => resultTransition('verified', 'approved', { approvedBy: 'u2' }), 'lab.self_approval_forbidden', 403);
    expectCode(() => resultTransition('verified', 'approved', { verifiedBy: 'u1' }), 'lab.self_approval_forbidden', 403);
  });
  it('R6 with approver ≠ verifier passes; R4 is not subject to the approver rule', () => {
    expect(resultTransition('verified', 'approved', { verifiedBy: 'u1', approvedBy: 'u2' })).toBe('R6');
    expect(resultTransition('resulted', 'verified', { verifiedBy: 'u1', approvedBy: 'u1' })).toBe('R4');
  });
  it('an illegal pair is invalid_transition even when guards are also violated (table first)', () => {
    expectInvalid(() => resultTransition('pending', 'approved', { onHold: true, verifiedBy: 'u1', approvedBy: 'u1' }));
  });
});
