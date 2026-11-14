// C5 T-02 — specimen roll-up from result statuses (02-TRD §3.3 "Roll-up (rollup.ts)", 03-IC §10.1 S6–S9/S15, §5.2 X8).
// ACs: AC-06.3 (parent whose results all moved to aliquots stays `aliquoted`, no roll-up).
// Interface expected from the writer (../rollup.ts) — SEAM (spec fixes behaviour, not the name):
//   export function rollupSpecimen(current: SpecimenStatus, resultStatuses: readonly ResultStatus[]): readonly SpecimenStatus[]
//        pure. `resultStatuses` = statuses of the results with specimen_id = s (cancelled ones are ignored by the function).
//        Returns the ordered list of statuses the specimen moves THROUGH (one status_changed event each); [] = no change.
//        e.g. ('received', ['resulted']) → ['in_process', 'resulted'] (S6 then S7).
import { describe, expect, it } from 'vitest';
import { rollupSpecimen } from '../rollup.js';

const R = (cur: string, results: readonly string[]): readonly string[] => rollupSpecimen(cur as never, results as never);

describe('T-02 roll-up up (S6–S9)', () => {
  it('S7: in_process + all results ≥ resulted → resulted', () => {
    expect(R('in_process', ['resulted', 'resulted'])).toEqual(['resulted']);
    expect(R('in_process', ['resulted', 'verified'])).toEqual(['resulted']); // min = resulted
  });
  it('S8: resulted + all ≥ verified → verified', () => {
    expect(R('resulted', ['verified', 'verified'])).toEqual(['verified']);
    expect(R('resulted', ['verified', 'approved'])).toEqual(['verified']);
  });
  it('S9: verified + all approved → approved', () => {
    expect(R('verified', ['approved', 'approved'])).toEqual(['approved']);
  });
  it('single result is enough', () => {
    expect(R('in_process', ['resulted'])).toEqual(['resulted']);
    expect(R('verified', ['approved'])).toEqual(['approved']);
  });
  it('mixed pending + resulted keeps in_process (min = pending)', () => {
    expect(R('in_process', ['resulted', 'pending'])).toEqual([]);
  });
  it('mixed resulted + verified does not reach verified; verified + approved does not reach approved', () => {
    expect(R('resulted', ['verified', 'resulted'])).toEqual([]);
    expect(R('verified', ['approved', 'verified'])).toEqual([]);
  });
});

describe('T-02 first value passes through in_process (S6)', () => {
  it('received + first resulted value → in_process then resulted (both events)', () => {
    expect(R('received', ['resulted'])).toEqual(['in_process', 'resulted']);
    expect(R('aliquoted', ['resulted', 'resulted'])).toEqual(['in_process', 'resulted']);
  });
  it('received + a value while others still pending → in_process only (S6: first value saved)', () => {
    expect(R('received', ['resulted', 'pending'])).toEqual(['in_process']);
    expect(R('aliquoted', ['resulted', 'pending'])).toEqual(['in_process']);
  });
  it('received / aliquoted / in_process with only pending results → no change (physical state kept)', () => {
    expect(R('received', ['pending', 'pending'])).toEqual([]);
    expect(R('aliquoted', ['pending'])).toEqual([]);
    expect(R('in_process', ['pending'])).toEqual([]);
  });
});

describe('T-02 roll-down (S15)', () => {
  it('verified → resulted when a result returns to resulted (R5)', () => {
    expect(R('verified', ['resulted', 'verified'])).toEqual(['resulted']);
    expect(R('verified', ['resulted'])).toEqual(['resulted']);
  });
  it('approved → verified when a result drops to verified (listed for completeness, unreachable in practice)', () => {
    expect(R('approved', ['verified', 'approved'])).toEqual(['verified']);
  });
  it('reported never rolls down — an amendment keeps it reported', () => {
    expect(R('reported', ['approved', 'approved'])).toEqual([]);
    expect(R('reported', ['verified', 'approved'])).toEqual([]);
    expect(R('reported', ['resulted'])).toEqual([]);
  });
});

describe('T-02 cancelled results and empty sets', () => {
  it('cancelled results are ignored in the minimum', () => {
    expect(R('in_process', ['resulted', 'cancelled'])).toEqual(['resulted']);
    expect(R('resulted', ['verified', 'cancelled', 'cancelled'])).toEqual(['verified']);
    expect(R('verified', ['approved', 'cancelled'])).toEqual(['approved']);
  });
  it('no non-cancelled results → no roll-up (status stays)', () => {
    expect(R('in_process', [])).toEqual([]);
    expect(R('in_process', ['cancelled', 'cancelled'])).toEqual([]);
    expect(R('verified', [])).toEqual([]);
  });
  it('AC-06.3: aliquoted parent whose results all moved to aliquots (no results) stays aliquoted', () => {
    expect(R('aliquoted', [])).toEqual([]);
    expect(R('aliquoted', ['cancelled'])).toEqual([]);
  });
});

describe('T-02 states that never roll', () => {
  const RESULT_SETS: string[][] = [[], ['pending'], ['resulted'], ['verified'], ['approved'], ['resulted', 'approved']];
  for (const status of ['rejected', 'recollection_ordered', 'stored', 'discarded']) {
    it(`${status} never rolls, whatever the results`, () => {
      for (const rs of RESULT_SETS) expect(R(status, rs), `${status} ${rs.join(',')}`).toEqual([]);
    });
  }
});

describe('T-02 roll-up is pure and idempotent', () => {
  it('does not mutate its input and gives the same answer twice', () => {
    const rs = Object.freeze(['resulted', 'verified']);
    expect(R('in_process', rs)).toEqual(R('in_process', rs));
    expect(rs).toEqual(['resulted', 'verified']);
  });
  it('applying the result to the current status yields a fixed point', () => {
    const steps = R('received', ['resulted', 'resulted']);
    const final = steps[steps.length - 1]!;
    expect(R(final, ['resulted', 'resulted'])).toEqual([]);
  });
});
