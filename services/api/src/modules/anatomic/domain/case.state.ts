// C11 case state table — 02-TRD §7 C1–C7. Pure. C8 has no v1 action, so it is not an edge.
import { LimsError } from '../../../core/errors.js';

export const CASE_STATUSES = ['received', 'accessioned', 'in_processing', 'ready_for_reporting', 'signed_out', 'cancelled'] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

// Map (not an object) so '__proto__' / 'constructor' can never match.
const NEXT = new Map<CaseStatus | null, ReadonlySet<CaseStatus>>([
  [null, new Set<CaseStatus>(['received'])], // C1
  ['received', new Set<CaseStatus>(['accessioned', 'cancelled'])], // C2, C7
  ['accessioned', new Set<CaseStatus>(['in_processing', 'cancelled'])], // C3, C7
  ['in_processing', new Set<CaseStatus>(['ready_for_reporting', 'cancelled'])], // C4, C7
  ['ready_for_reporting', new Set<CaseStatus>(['signed_out', 'cancelled'])], // C5, C7
  ['signed_out', new Set<CaseStatus>(['signed_out'])], // C6 (version n+1)
  ['cancelled', new Set<CaseStatus>()],
]);

export function canTransition(from: CaseStatus | null, to: CaseStatus): boolean {
  return NEXT.get(from)?.has(to) ?? false;
}

export function assertTransition(from: CaseStatus | null, to: CaseStatus): void {
  if (!canTransition(from, to)) throw new LimsError('anatomic.case_invalid_transition');
}
