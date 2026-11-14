// C17 visit state table (03-APP-FLOW §1.1 V1–V11). Pure. null = no row yet (V1–V4 create as 'unassigned').
import { LimsError } from '../../../core/errors.js';

export type VisitStatus = 'unassigned' | 'assigned' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
export const VISIT_STATUSES: readonly VisitStatus[] = ['unassigned', 'assigned', 'in_progress', 'completed', 'failed', 'cancelled'];
export const CLOSED_VISIT_STATUSES: readonly VisitStatus[] = ['completed', 'failed', 'cancelled'];

const ALLOWED: Readonly<Record<VisitStatus | 'none', readonly VisitStatus[]>> = {
  none: ['unassigned'], // V1–V4
  unassigned: ['assigned', 'cancelled'], // V5, V11
  assigned: ['assigned', 'unassigned', 'in_progress', 'failed', 'cancelled'], // V6, V7, V8, V10, V11
  in_progress: ['completed', 'failed'], // V9, V10
  completed: [],
  failed: [],
  cancelled: [],
};

export function isVisitTransitionAllowed(from: VisitStatus | null, to: VisitStatus): boolean {
  return ALLOWED[from ?? 'none'].includes(to);
}

export function assertVisitTransition(from: VisitStatus | null, to: VisitStatus): void {
  if (isVisitTransitionAllowed(from, to)) return;
  if (from !== null && CLOSED_VISIT_STATUSES.includes(from)) throw new LimsError('homecollection.visit_closed');
  // [CONV] in_progress -> unassigned is named by the spec; every other unlisted pair reuses the same server-wins 409 (spec names no code).
  throw new LimsError('homecollection.mutation_superseded');
}
