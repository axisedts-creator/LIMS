// C11 case kinds + status predicates. Pure.
import type { CaseStatus } from './case.state.js';

export const CASE_KINDS = ['histology', 'cytology', 'ihc', 'molecular'] as const;
export type CaseKind = (typeof CASE_KINDS)[number];

/** The statuses of the open-case partial unique index. */
export const isOpenStatus = (s: CaseStatus): boolean =>
  s === 'received' || s === 'accessioned' || s === 'in_processing' || s === 'ready_for_reporting';

/** TRD §7 "Data edits": allowed once accessioned, until sign-out. */
export const isDataEditable = (s: CaseStatus): boolean =>
  s === 'accessioned' || s === 'in_processing' || s === 'ready_for_reporting';
