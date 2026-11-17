// Specimen roll-up from its results (02-TRD §3.3 "Roll-up", 03-IC §10.1 S6–S9 / S15). Pure.
// Specimen status = min over non-cancelled results; returns every status passed through (one status_changed event each).
import type { ResultStatus } from './result.state.js';
import type { SpecimenStatus } from './specimen.state.js';

const RANK: Readonly<Record<Exclude<ResultStatus, 'cancelled'>, number>> = { pending: 0, resulted: 1, verified: 2, approved: 3 };
const LADDER = ['in_process', 'resulted', 'verified', 'approved'] as const; // index = rank
const ON_LADDER: Readonly<Partial<Record<SpecimenStatus, number>>> = { in_process: 0, resulted: 1, verified: 2, approved: 3 };

export function rollupSpecimen(current: SpecimenStatus, resultStatuses: readonly ResultStatus[]): readonly SpecimenStatus[] {
  const ranks = resultStatuses.filter((s): s is keyof typeof RANK => s !== 'cancelled').map((s) => RANK[s]);
  if (ranks.length === 0) return []; // AC-06.3: nothing to roll from
  const target = Math.min(...ranks);
  const out: SpecimenStatus[] = [];
  let cur = ON_LADDER[current];
  if (current === 'received' || current === 'aliquoted') {
    if (Math.max(...ranks) === 0) return []; // only pending: physical state kept
    out.push('in_process'); // S6: first value saved
    cur = 0;
  }
  if (cur === undefined) return []; // ordered…in_transit, reported (never rolls down), rejected, stored, …
  while (cur < target) out.push(LADDER[++cur]!); // S7, S8, S9
  while (cur > target && cur >= 2) out.push(LADDER[--cur]!); // S15 only: approved→verified→resulted
  return out;
}
