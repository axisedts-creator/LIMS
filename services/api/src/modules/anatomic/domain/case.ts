// C11 case kinds + status predicates. Pure.
import type { CaseStatus } from './case.state.js';

export const CASE_KINDS = ['histology', 'cytology', 'ihc', 'molecular'] as const;
export type CaseKind = (typeof CASE_KINDS)[number];

/** A1 listAnatomicCases enums (02-TRD §5 A1; queue definitions 03-APP-FLOW §4.1). */
export const CASE_QUEUES = ['to_accession', 'grossing', 'bench', 'reporting', 'awaiting_lab', 'signed_out', 'cancelled', 'all'] as const;
export const CASE_SORTS = ['received_at', '-received_at', 'accessioned_at', '-accessioned_at', 'priority_received_at'] as const;
export type CaseQueue = (typeof CASE_QUEUES)[number];
export type CaseSort = (typeof CASE_SORTS)[number];

/** The statuses of the open-case partial unique index. */
export const isOpenStatus = (s: CaseStatus): boolean =>
  s === 'received' || s === 'accessioned' || s === 'in_processing' || s === 'ready_for_reporting';

/** TRD §7 "Data edits": allowed once accessioned, until sign-out. */
export const isDataEditable = (s: CaseStatus): boolean =>
  s === 'accessioned' || s === 'in_processing' || s === 'ready_for_reporting';
