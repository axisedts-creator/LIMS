// C17 collection state table (03-APP-FLOW §1.2 C1–C4). Pure. null = no row (C1/C2).
import { LimsError } from '../../../core/errors.js';

export type CollectionStatus = 'applied' | 'held' | 'discarded';
export const COLLECTION_STATUSES: readonly CollectionStatus[] = ['applied', 'held', 'discarded'];

const ALLOWED: Readonly<Record<CollectionStatus | 'none', readonly CollectionStatus[]>> = {
  none: ['applied', 'held'], // C1, C2
  held: ['applied', 'discarded'], // C3, C4
  applied: [],
  discarded: [],
};

export function isCollectionTransitionAllowed(from: CollectionStatus | null, to: CollectionStatus): boolean {
  return ALLOWED[from ?? 'none'].includes(to);
}

/** [CONV] every forbidden pair answers homecollection.collection_not_held (spec names it for applied|discarded; no other code exists). */
export function assertCollectionTransition(from: CollectionStatus | null, to: CollectionStatus): void {
  if (!isCollectionTransitionAllowed(from, to)) throw new LimsError('homecollection.collection_not_held');
}
