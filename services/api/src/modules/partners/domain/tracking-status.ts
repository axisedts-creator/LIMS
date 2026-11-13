// C13 T04 — tracking-status derivation T1–T7, first match wins (03-APP-FLOW §3; US-07.1, US-07.5). Pure, no mutation.
export const TRACKING_STATUSES = ['cancelled', 'reported', 'partially_reported', 'action_needed', 'in_lab', 'in_transit', 'registered'] as const;
export type TrackingStatus = (typeof TRACKING_STATUSES)[number];

export const TRACKING_LABELS: Readonly<Record<TrackingStatus, string>> = {
  cancelled: 'Cancelled by lab', reported: 'Report ready', partially_reported: 'Partly reported', action_needed: 'New sample needed',
  in_lab: 'In lab', in_transit: 'On the way to lab', registered: 'Registered',
};

export interface TrackingInput {
  readonly lineState: string;
  readonly specimens: readonly { readonly id: string; readonly status: string; readonly replacesSpecimenId?: string | null }[];
  readonly reports: readonly { readonly kind: string; readonly status: 'valid' | 'superseded' }[];
}

const PARTIAL_KINDS = new Set(['partial', 'preliminary']);
const AT_LEAST_RECEIVED = new Set(['received', 'aliquoted', 'in_process', 'resulted', 'verified', 'approved', 'reported', 'stored']);
const NEEDS_REPLACEMENT = new Set(['rejected', 'recollection_ordered']);
const ON_THE_WAY = new Set(['collected', 'in_transit']);

export function deriveTrackingStatus(i: TrackingInput): TrackingStatus {
  if (i.lineState === 'cancelled') return 'cancelled'; // T1
  const valid = i.reports.filter((r) => r.status === 'valid');
  // T2: final/amended/addendum; any unknown future kind is treated as amended (02-CV §7.2)
  if (valid.some((r) => !PARTIAL_KINDS.has(r.kind))) return 'reported';
  if (valid.length > 0) return 'partially_reported'; // T3
  const replacementReceived = (id: string): boolean =>
    i.specimens.some((s) => s.replacesSpecimenId === id && AT_LEAST_RECEIVED.has(s.status));
  if (i.specimens.some((s) => NEEDS_REPLACEMENT.has(s.status) && !replacementReceived(s.id))) return 'action_needed'; // T4
  if (i.specimens.some((s) => AT_LEAST_RECEIVED.has(s.status))) return 'in_lab'; // T5
  if (i.specimens.some((s) => ON_THE_WAY.has(s.status))) return 'in_transit'; // T6
  return 'registered'; // T7
}
