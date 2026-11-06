import type { Tone } from '../_shared/messages';

export type StatusKind = 'specimen' | 'result' | 'report_version' | 'order' | 'invoice' | 'payment_intent' | 'dead_letter' | 'generic';

type Row = readonly [Tone, string];
/** 04-UI-UX §1.3 (labels = message keys ui.status.<kind>.<code>). [CONV] labels marked * are not given by the spec. */
const MAP: Record<Exclude<StatusKind, 'generic'>, Record<string, Row>> = {
  specimen: {
    ordered: ['neutral', 'Ordered'],
    collected: ['info', 'Collected'],
    in_transit: ['info', 'In transit'],
    received: ['info', 'Received'],
    aliquoted: ['info', 'Aliquoted'],
    in_process: ['info', 'In process'],
    resulted: ['warning', 'Resulted'],
    verified: ['warning', 'Verified'],
    approved: ['success', 'Approved'],
    reported: ['success', 'Reported'],
    rejected: ['danger', 'Rejected'],
    recollection_ordered: ['warning', 'Recollection ordered'],
    stored: ['neutral', 'Stored'],
    discarded: ['neutral', 'Discarded'],
  },
  result: {
    pending: ['neutral', 'Pending'],
    resulted: ['warning', 'Resulted'],
    verified: ['warning', 'Verified'],
    approved: ['success', 'Approved'],
    cancelled: ['neutral', 'Cancelled'],
    // flags, not states: rendered as extra chips
    on_hold: ['warning', 'QC hold'],
    qc_review_required: ['warning', 'QC review'],
  },
  report_version: {
    rendering: ['info', 'Rendering'],
    rendered: ['info', 'Ready to release'],
    render_failed: ['danger', 'Render failed'],
    released: ['success', 'Released'],
    superseded: ['neutral', 'Superseded'],
    discarded: ['neutral', 'Discarded'], // CR-C6-005
  },
  order: {
    pre_registered: ['neutral', 'Pre-registered'],
    registered: ['info', 'Registered'],
    in_progress: ['info', 'In progress'],
    completed: ['success', 'Completed'],
    cancelled: ['danger', 'Cancelled'],
  },
  invoice: {
    issued: ['success', 'Issued'],
    cancelled: ['danger', 'Cancelled'],
  },
  payment_intent: {
    created: ['info', 'Created'], // *
    initiated: ['info', 'Initiated'], // *
    pending: ['info', 'Pending'], // *
    settled: ['success', 'Paid'],
    failed: ['danger', 'Failed'], // *
    expired: ['danger', 'Expired'], // *
    held_for_review: ['warning', 'Under review'],
    refunded: ['neutral', 'Refunded'], // *
    partially_refunded: ['neutral', 'Partially refunded'], // *
  },
  dead_letter: {
    open: ['danger', 'Open'],
    replayed: ['success', 'Replayed'],
    discarded: ['neutral', 'Discarded'],
  },
};

const TONES: readonly Tone[] = ['neutral', 'info', 'success', 'warning', 'danger', 'critical'];

export interface StatusChipProps {
  kind: StatusKind;
  status: string;
  /** Only for kind 'generic'. */
  tone?: Tone;
  /** Only for kind 'generic'. */
  label?: string;
  size?: 'sm' | 'md';
  'data-testid'?: string;
}

/** Resolve tone + text; unknown kind/status -> neutral chip with the raw code (x-extensible enums, CV §4.11). */
export function statusOf(kind: string, status: string, tone?: Tone, label?: string): Row {
  if (kind === 'generic') return [tone && TONES.includes(tone) ? tone : 'neutral', label ?? status];
  const table = Object.hasOwn(MAP, kind) ? MAP[kind as keyof typeof MAP] : undefined;
  const row = table && Object.hasOwn(table, status) ? table[status] : undefined;
  return row ?? ['neutral', status];
}

export function StatusChip({ kind, status, tone, label, size = 'md', ...rest }: StatusChipProps) {
  const [t, text] = statusOf(kind, String(status ?? ''), tone, label);
  return (
    <span className={`lims-chip lims-chip-${size} lims-tone-${t}`} data-tone={t} {...rest}>
      {text}
    </span>
  );
}
