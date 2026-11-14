// Library state table (03-APP-FLOW §1.1 L1-L6; 02-TRD §6). Pure. Anything not listed is forbidden (fail closed), incl. unknown statuses.
import { LimsError } from '../../../core/errors.js';

export type LibraryStatus = 'draft' | 'in_review' | 'approved' | 'retired';

const NEXT: Readonly<Record<string, readonly string[]>> = { draft: ['in_review'], in_review: ['draft', 'approved'], approved: ['retired'], retired: [] };

export const canTransition = (from: LibraryStatus, to: LibraryStatus): boolean => Object.hasOwn(NEXT, from) && NEXT[from]!.includes(to);

export function assertTransition(from: LibraryStatus, to: LibraryStatus): void {
  if (!canTransition(from, to)) throw new LimsError('smartreport.library_invalid_transition');
}

/** Content edits (L2) happen in `draft` only. */
export function assertEditable(status: LibraryStatus): void {
  if (status !== 'draft') throw new LimsError('smartreport.library_invalid_transition');
}
