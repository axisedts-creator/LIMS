// Result state machine (03-IC §10.2 R1–R8, 02-TRD §3.3) + guards (01 §2.5 on_hold, 07-SECURITY S-02). Pure.
import { LimsError } from '../../../core/errors.js';

export const RESULT_STATUSES = ['pending', 'resulted', 'verified', 'approved', 'cancelled'] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];
export type ResultTransitionId = `R${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`;

const ABSENT = '∅';
const TABLE: Readonly<Record<string, ResultTransitionId>> = {
  [`${ABSENT}>pending`]: 'R1',
  'pending>resulted': 'R2',
  'resulted>resulted': 'R3',
  'resulted>verified': 'R4',
  'verified>resulted': 'R5',
  'verified>approved': 'R6',
  'approved>approved': 'R7',
  'pending>cancelled': 'R8',
  'resulted>cancelled': 'R8',
  'verified>cancelled': 'R8',
};
const lookup = (from: ResultStatus | null, to: ResultStatus): ResultTransitionId | undefined =>
  Object.hasOwn(TABLE, `${from ?? ABSENT}>${to}`) ? TABLE[`${from ?? ABSENT}>${to}`] : undefined;

export function isResultTransitionAllowed(from: ResultStatus | null, to: ResultStatus): boolean {
  return lookup(from, to) !== undefined;
}

/** Table first (409 invalid_transition), then guards: on_hold blocks R4/R6; R6 needs approver ≠ verifier. */
export function resultTransition(
  from: ResultStatus | null,
  to: ResultStatus,
  guards: { onHold?: boolean; verifiedBy?: string; approvedBy?: string } = {},
): ResultTransitionId {
  const id = lookup(from, to);
  if (!id) throw new LimsError('lab.result_invalid_transition');
  if ((id === 'R4' || id === 'R6') && guards.onHold) throw new LimsError('lab.result_on_hold');
  // S-02 fail closed: a missing verifier or approver id is treated as self-approval.
  if (id === 'R6' && (!guards.verifiedBy || !guards.approvedBy || guards.approvedBy === guards.verifiedBy)) {
    throw new LimsError('lab.self_approval_forbidden');
  }
  return id;
}

/** R2/R3 value write: approved is locked (amend via R7), cancelled is terminal. */
export function assertResultValueEditable(status: ResultStatus): void {
  if (status === 'approved') throw new LimsError('lab.result_locked');
  if (status === 'cancelled' || status === 'verified') throw new LimsError('lab.result_invalid_transition');
}
