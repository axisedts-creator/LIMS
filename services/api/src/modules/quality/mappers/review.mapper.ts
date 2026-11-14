// DTO allowlists of 02-TRD §5.10 for #26-#33 (QcObservationDto, QcRunSummaryDto, QcRunDto, CorrectiveActionDto, QcRunReviewDto): only listed fields leave. No tenant_id, no *_by / membership ids
// (names are labels, REQ-SEC-081), no internal columns. Absent optional = key omitted, never null. Timestamps are ISO-8601 UTC with milliseconds; z is shown with 3 decimal places.
import { parseDecimal, roundDp, toDecimalString } from '../../../../../../packages/shared-ts/src/decimal/index.js';
import { UNKNOWN_USER, type Labels } from './autoverify.mapper.js';

type Row = Record<string, any>;
const iso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();
const opt = (k: string, v: unknown, f: (x: any) => unknown = (x) => x): Row => (v === null || v === undefined ? {} : { [k]: f(v) });
const label = (labels: Labels, id: unknown): string => (typeof id === 'string' ? labels.get(id) : undefined) ?? UNKNOWN_USER;

/** z-score: half-up to exactly 3 places (display only). */
function z3(v: string): string {
  const d = parseDecimal(v);
  if (!d) return v;
  const r = roundDp(d, 3);
  return toDecimalString(r.s < 3 ? { m: r.m * 10n ** BigInt(3 - r.s), s: 3 } : r);
}

/** needs_action (TRD §5.10, §5.5 #28): rejected and not closed; the reason is `corrective_action` while none was recorded, else `rerun`. */
export const needsAction = (r: Row): boolean => r['outcome'] === 'rejected' && r['status'] !== 'closed';

export const observationUserIds = (rows: Row[]): string[] => [...new Set(rows.map((r) => r['excluded_by']).filter((x): x is string => typeof x === 'string'))];

export const observationDto = (r: Row, users: Labels): Row => ({
  id: r['id'], version: r['version'], ...opt('plan_id', r['plan_id']), instrument_id: r['instrument_id'], ...opt('analyte_id', r['analyte_id']), ...opt('level_id', r['level_id']), ...opt('lot_id', r['lot_id']),
  control_id_raw: r['control_id_raw'], ...opt('control_lot_raw', r['control_lot_raw']), ...opt('control_level_raw', r['control_level_raw']), ...opt('value', r['value']), ...opt('unit_code', r['unit_code']),
  observed_at: iso(r['observed_at']), received_at: iso(r['received_at']), observed_at_basis: r['observed_at_basis'], source: r['source'], status: r['status'],
  ...opt('qc_run_id', r['qc_run_id']), ...opt('z', r['z'], z3), ...opt('target_id', r['target_id']),
  ...(r['status'] === 'excluded' && r['excluded_at'] != null
    ? { excluded: { reason_code: r['excluded_reason_code'], ...opt('comment', r['excluded_comment']), by_display: label(users, r['excluded_by']), at: iso(r['excluded_at']) } } : {}),
});

export const runSummaryDto = (r: Row): Row => {
  const needs = needsAction(r);
  return {
    id: r['id'], version: r['version'], plan_id: r['plan_id'], instrument_id: r['instrument_id'], analyte_id: r['analyte_id'], run_at: iso(r['run_at']), status: r['status'],
    ...opt('outcome', r['outcome']), is_complete: r['is_complete'] === true, observation_count: r['observation_count'], controls_per_run: r['controls_per_run'], rule_mode: r['rule_mode'],
    warning_rules: [...(r['warning_rules'] ?? [])], rules_violated: [...(r['rules_violated'] ?? [])], needs_action: needs,
    ...(needs ? { needs_action_reason: (r['corrective_action_count'] ?? 0) > 0 ? 'rerun' : 'corrective_action' } : {}),
    ...opt('closed_at', r['closed_at'], iso),
  };
};

export const correctiveActionDto = (r: Row, members: Labels): Row => ({
  id: r['id'], qc_run_id: r['qc_run_id'], action_code: r['action_code'], action_display: r['action_display'] ?? r['action_code'], description: r['description'],
  performed_at: iso(r['performed_at']), performed_by_display: label(members, r['performed_by_membership_id']), created_at: iso(r['created_at']),
});

export const reviewDto = (r: Row, members: Labels): Row => ({
  id: r['id'], qc_run_id: r['qc_run_id'], kind: r['kind'], ...opt('comment', r['comment']), reviewed_by_display: label(members, r['reviewed_by_membership_id']), created_at: iso(r['created_at']),
});

/** The user ids / membership ids a QcRunDto names, so the service can fetch the labels in one call each. */
export function runLabelIds(run: Row, observations: Row[], correctives: Row[], reviews: Row[]): { users: string[]; members: string[] } {
  const ev = typeof run['evaluated_by'] === 'string' && run['evaluated_by'] !== run['created_by'] ? [run['evaluated_by']] : [];
  return {
    users: [...new Set([...ev, ...observationUserIds(observations)])],
    members: [...new Set([...correctives.map((c) => c['performed_by_membership_id']), ...reviews.map((c) => c['reviewed_by_membership_id'])].filter((x): x is string => typeof x === 'string'))],
  };
}

/** [CONV] runs are only ever created by the assembly job's system actor, so an evaluator equal to the creator is `system`; any other evaluator is a staff user shown by label. */
export function runDto(run: Row, parts: { observations: Row[]; correctives: Row[]; reviews: Row[]; users: Labels; members: Labels }): Row {
  const detail: Row[] = (run['rule_detail'] ?? []).map((d: Row) => ({ rule: d['rule'], observation_ids: [...d['observation_ids']] }));
  const hits = (id: string): string[] => [...new Set(detail.filter((d) => d['observation_ids'].includes(id)).map((d) => d['rule'] as string))];
  return {
    ...runSummaryDto(run), plan_version_no: run['plan_version_no'],
    observations: parts.observations.map((o) => ({ ...observationDto(o, parts.users), rule_hits: hits(o['id']) })),
    rule_detail: detail,
    ...(run['hold_since'] != null && run['rejection_event_id'] != null
      ? { hold: { hold_since: iso(run['hold_since']), ...opt('last_in_control_run_at', run['last_in_control_run_at'], iso), event_id: run['rejection_event_id'] } } : {}),
    corrective_actions: parts.correctives.map((c) => correctiveActionDto(c, parts.members)),
    reviews: parts.reviews.map((c) => reviewDto(c, parts.members)),
    ...opt('evaluated_at', run['evaluated_at'], iso),
    ...(typeof run['evaluated_by'] === 'string' ? { evaluated_by: run['evaluated_by'] === run['created_by'] ? 'system' : label(parts.users, run['evaluated_by']) } : {}),
  };
}
