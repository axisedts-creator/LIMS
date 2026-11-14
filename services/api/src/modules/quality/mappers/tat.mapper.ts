// C9 T-19 row -> wire mappers of #48-#50 (02-TRD §5.10 TatAlertDto / TatAlertDetailDto; contracts/openapi/quality.yaml; REQ-SEC-081).
// Explicit allowlists, snake_case on the wire. No tenant_id, no user ids (acknowledged_by leaves as a display label), no internal columns, no undefined values: an absent optional field is omitted.
// Elapsed time is computed here from the row and the caller's clock (stopped clocks stop counting): elapsed = floor(((stopped_at ?? now) - started_at) / 1000), pct = floor(elapsed * 100 / target) (AC-14.8).
import type { AckRow, EventRow, TatItemRow } from '../repository/tat.repo.js';

type Row = Record<string, any>;
export const UNKNOWN_USER = 'Unknown user';   // staff-name placeholder when no label resolves (same rule as the review mapper)

const SEGMENT_LABELS = {
  within_lab: 'Within lab: specimen received to first verified result',
  total_registered_at: 'Total: order registered to report released',
  total_specimen_ordered_at: 'Total: specimen ordered to report released',
} as const;
export const segmentLabel = (r: Pick<TatItemRow, 'segment' | 'start_basis'>): string =>
  r.segment === 'within_lab' ? SEGMENT_LABELS.within_lab : r.start_basis === 'specimen_ordered_at' ? SEGMENT_LABELS.total_specimen_ordered_at : SEGMENT_LABELS.total_registered_at;

export function elapsedSeconds(r: Pick<TatItemRow, 'started_at' | 'stopped_at'>, nowMs: number): number {
  if (r.started_at === null) return 0;
  const end = r.stopped_at !== null ? Date.parse(r.stopped_at) : nowMs;
  return Math.max(0, Math.floor((end - Date.parse(r.started_at)) / 1000));
}

export function tatAlertDto(r: TatItemRow, o: { testCode: string; nowMs: number; labels: Map<string, string> }): Row {
  const elapsed = elapsedSeconds(r, o.nowMs);
  return {
    tat_item_id: r.id, version: r.version, order_id: r.order_id, order_item_id: r.order_item_id, test_id: r.test_id, test_code: o.testCode,
    ...(r.department_id !== null ? { department_id: r.department_id } : {}),   // contract: required, non-nullable; an item without a department omits it (.orchestra/cr/C9.T-19.nonblocking.md)
    specimen_id: r.specimen_id, centre_id: r.centre_id, priority: r.priority, segment: r.segment, segment_label: segmentLabel(r), start_basis: r.start_basis, target_seconds: r.target_seconds,
    ...(r.started_at !== null ? { started_at: r.started_at } : {}),
    elapsed_seconds: elapsed, pct_of_target: r.target_seconds > 0 ? Math.floor((elapsed * 100) / r.target_seconds) : 0, alert_level: r.alert_level, state: r.state,
    ...(r.acknowledged_level !== null ? { acknowledged_level: r.acknowledged_level } : {}),
    ...(r.acknowledged_at !== null ? { acknowledged_at: r.acknowledged_at } : {}),
    ...(r.acknowledged_by !== null ? { acknowledged_by_display: o.labels.get(r.acknowledged_by) ?? UNKNOWN_USER } : {}),
  };
}

export function tatAlertDetailDto(r: TatItemRow, o: { testCode: string; nowMs: number; labels: Map<string, string>; events: EventRow[]; acks: AckRow[] }): Row {
  return {
    ...tatAlertDto(r, o), restart_count: r.restart_count,
    ...(r.first_verified_at !== null ? { first_verified_at: r.first_verified_at } : {}),
    ...(r.stopped_at !== null ? { stopped_at: r.stopped_at } : {}),
    ...(r.stop_source !== null ? { stop_source: r.stop_source } : {}),
    level_events: o.events.map((e) => ({ level: e.level, raised_at: e.raised_at, elapsed_seconds: e.elapsed_seconds, restart_no: e.restart_no })),
    acknowledgements: o.acks.map((a) => ({ level: a.level, ...(a.note !== null ? { note: a.note } : {}), acknowledged_by_display: o.labels.get(a.acknowledged_by_membership_id) ?? UNKNOWN_USER, created_at: a.created_at })),
  };
}
