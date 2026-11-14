// DTO allowlists of 02-TRD §5.10 / §8.6 for #42 (SimulationReportDto), #46 (AutoverifyDecisionDto) and #47 (decision + inputs, P3). Only listed fields leave: no tenant_id,
// created_by, internal columns, no patient text; no null on the wire (absent optional = key omitted). Enums are the closed sets of contracts/openapi/quality.yaml.
type Row = Record<string, any>;

const iso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();
const opt = (k: string, v: unknown, f: (x: any) => unknown = (x) => x): Row => (v === null || v === undefined ? {} : { [k]: f(v) });

/** The nine reasons of the wire enum. `feature_disabled` is stored on live rows (TRD §8.5) but is not part of AutoverifyDecisionDto, so it never leaves. */
const REASONS = ['manual_origin', 'rule_missing', 'critical', 'delta_failure', 'instrument_flag', 'outside_autoverify_limits', 'qc_out_of_control', 'qc_warning', 'qc_no_data'] as const;
const reasonList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((r): r is string => (REASONS as readonly string[]).includes(r)) : []);
const RANGE_FLAGS = ['N', 'L', 'H', 'LL', 'HH', 'A'];

export const decisionDto = (r: Row): Row => ({
  id: r['id'], decided_at: iso(r['decided_at']), mode: r['mode'], decision: r['decision'], reasons: reasonList(r['reasons']),
  result_id: r['result_id'], analyte_id: r['analyte_id'], ...opt('instrument_id', r['instrument_id']), ...opt('version_id', r['version_id']),
  ...opt('matched_rule_key', r['matched_rule_key']), qc_status: r['qc_status'], ...opt('qc_run_id', r['qc_run_id']),
});

/** #47: the decision + its inputs, key by key (the stored jsonb may carry more than the contract names, e.g. P3 text a producer should never have written). */
export const decisionDetailDto = (r: Row): Row => {
  const i: Row = r['inputs'] && typeof r['inputs'] === 'object' ? r['inputs'] : {};
  return {
    ...decisionDto(r),
    inputs: {
      ...opt('value_numeric', i['value_numeric'], String),
      ...(RANGE_FLAGS.includes(i['range_flag']) ? { range_flag: i['range_flag'] } : {}),
      delta_check_failed: i['delta_check_failed'] === true, is_critical: i['is_critical'] === true,
      instrument_flags: Array.isArray(i['instrument_flags']) ? i['instrument_flags'].filter((f): f is string => typeof f === 'string').slice(0, 20) : [],
      ...opt('resulted_at', i['resulted_at'], iso),
    },
  };
};

const sampleDto = (s: Row): Row => ({
  decision_id: s['decision_id'], result_id: s['result_id'], ...opt('order_id', s['order_id']), analyte_id: s['analyte_id'], decided_at: iso(s['decided_at']),
  shadow_decision: s['shadow_decision'], shadow_reasons: reasonList(s['shadow_reasons']),
  ...opt('live_decision', s['live_decision']), ...opt('manually_verified_at', s['manually_verified_at'], iso),
});

export const simulationReportDto = (a: { versionId: string; startedAt: string; daysRunning: number; sampleLimit: number }, rows: Row): Row => ({
  version_id: a.versionId, started_at: iso(a.startedAt), days_running: a.daysRunning,
  decisions: rows['decisions'], would_allow: rows['would_allow'], would_deny: rows['would_deny'],
  deny_by_reason: Object.fromEntries(Object.entries<number>(rows['deny_by_reason'] ?? {}).filter(([k]) => (REASONS as readonly string[]).includes(k))),
  allow_later_manually_verified: rows['allow_later_manually_verified'], allow_not_verified_yet: rows['allow_not_verified_yet'],
  ...opt('live_comparison', rows['live_comparison'], (l: Row) => ({ both_allow: l['both_allow'], live_only_allow: l['live_only_allow'], shadow_only_allow: l['shadow_only_allow'] })),
  sample: (rows['sample'] as Row[]).slice(0, a.sampleLimit).map(sampleDto),
});
