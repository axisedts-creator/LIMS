// Specimen state machine (03-IC §10.1 S1–S15, 02-TRD §3.3). Pure: no DB, no clock.
import { LimsError } from '../../../core/errors.js';

export const SPECIMEN_STATUSES = [
  'ordered', 'collected', 'in_transit', 'received', 'aliquoted', 'in_process', 'resulted', 'verified', 'approved',
  'reported', 'rejected', 'recollection_ordered', 'stored', 'discarded',
] as const;
export type SpecimenStatus = (typeof SPECIMEN_STATUSES)[number];
export type SpecimenTransitionId = `S${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15}`;

const ABSENT = '∅';
/** to -> { from -> id }. Anything absent here is forbidden. */
const TABLE: Readonly<Record<SpecimenStatus, Readonly<Partial<Record<SpecimenStatus | typeof ABSENT, SpecimenTransitionId>>>>> = {
  ordered: { [ABSENT]: 'S1' },
  collected: { ordered: 'S2' },
  in_transit: { collected: 'S3' },
  received: { collected: 'S4', in_transit: 'S4' },
  aliquoted: { received: 'S5' },
  in_process: { received: 'S6', aliquoted: 'S6' },
  resulted: { in_process: 'S7', verified: 'S15' },
  verified: { resulted: 'S8', approved: 'S15' },
  approved: { verified: 'S9' },
  reported: { approved: 'S10' },
  rejected: Object.fromEntries(
    (['ordered', 'collected', 'in_transit', 'received', 'aliquoted', 'in_process', 'resulted', 'verified'] as const).map((f) => [f, 'S11']),
  ),
  recollection_ordered: { rejected: 'S12' },
  stored: Object.fromEntries(
    (['received', 'aliquoted', 'in_process', 'resulted', 'verified', 'approved', 'reported'] as const).map((f) => [f, 'S13']),
  ),
  discarded: { stored: 'S14', reported: 'S14', rejected: 'S14', recollection_ordered: 'S14' },
};

const lookup = (from: SpecimenStatus | null, to: SpecimenStatus): SpecimenTransitionId | undefined => TABLE[to]?.[from ?? ABSENT];
// 03-APP-FLOW §1.1: an inactive specimen only accepts storage / disposal.
const blockedWhenInactive = (id: SpecimenTransitionId, isActive: boolean): boolean => !isActive && id !== 'S13' && id !== 'S14';

export function isSpecimenTransitionAllowed(from: SpecimenStatus | null, to: SpecimenStatus, opts: { isActive?: boolean } = {}): boolean {
  const id = lookup(from, to);
  return id !== undefined && !blockedWhenInactive(id, opts.isActive ?? true);
}

/** Table first (409 lab.specimen_invalid_transition), then activity (409 lab.specimen_inactive, CR-C5-005). */
export function specimenTransition(from: SpecimenStatus | null, to: SpecimenStatus, opts: { isActive?: boolean } = {}): SpecimenTransitionId {
  const id = lookup(from, to);
  if (!id) throw new LimsError('lab.specimen_invalid_transition');
  if (blockedWhenInactive(id, opts.isActive ?? true)) throw new LimsError('lab.specimen_inactive');
  return id;
}

/** AC-04.3: receive scan on a rejected / discarded specimen. */
export function assertSpecimenReceivable(status: SpecimenStatus): void {
  if (status === 'rejected' || status === 'discarded') throw new LimsError('lab.specimen_not_receivable');
}
