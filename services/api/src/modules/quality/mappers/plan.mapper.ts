// DTO allowlists of 02-TRD §5.10 for #14-#19 (QcPlanDto, its versions[]): only listed fields leave; no tenant_id / *_by ids / updated_* / is_active / unknown
// columns; no null on the wire (absent optional = key omitted). Timestamps are ISO-8601 UTC strings.
import { UNKNOWN_USER, type Labels } from './autoverify.mapper.js';

type Row = Record<string, any>;
export interface AnalyteDef { resultType?: string; code?: string; name?: string; unitCode?: string; decimals?: number }
export interface InstrumentLabel { instrument_code: string; display_name: string }

const iso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();
const opt = (k: string, v: unknown): Row => (v === null || v === undefined ? {} : { [k]: v });

export const paramsOf = (v: Row): Row => ({
  controls_per_run: v['controls_per_run'],
  composition: (v['composition'] as Row[]).map((c) => ({ level_id: c['level_id'], count: c['count'] })),
  mean_rule: v['mean_rule'],
  two_two_s_across_runs: v['two_two_s_across_runs'],
  count_rules_across_materials: v['count_rules_across_materials'],
  exclude_rejected_runs_from_history: v['exclude_rejected_runs_from_history'],
  run_window_minutes: v['run_window_minutes'],
  qc_validity_hours: v['qc_validity_hours'],
  hold_lookback_hours: v['hold_lookback_hours'],
});

/** Rule set by N (04 L23; 02-TRD §5.3): 1-2s warns; N=2/4 reject on 1-3s, 2-2s, R-4s, 4-1s, n-x; N=3 on 1-3s, 2of3-2s, R-4s, 3-1s, n-x. */
export const ruleSetPreview = (n: number, meanRule: string) => ({
  warning: ['1-2s'],
  rejection: n === 3 ? ['1-3s', '2of3-2s', 'R-4s', '3-1s', meanRule] : ['1-3s', '2-2s', 'R-4s', '4-1s', meanRule],
});

export const planDto = (p: Row, cur: Row | undefined, analyte: AnalyteDef | undefined, ins: InstrumentLabel | undefined): Row => ({
  id: p['id'], instrument_id: p['instrument_id'],
  ...(ins ? { instrument_label: `${ins.display_name} (${ins.instrument_code})` } : {}),
  test_id: p['test_id'], analyte_id: p['analyte_id'],
  ...opt('analyte_code', analyte?.code), ...opt('analyte_name', analyte?.name), ...opt('unit_code', analyte?.unitCode), ...opt('decimals', analyte?.decimals),
  status: p['status'], current_version_no: p['current_version_no'],
  ...(cur ? { effective_from: iso(cur['effective_from']), params: paramsOf(cur), rule_set_preview: ruleSetPreview(cur['controls_per_run'], cur['mean_rule']) } : {}),
  version: p['version'],
});

export const planVersionDto = (v: Row, labels: Labels): Row => ({
  id: v['id'], version_no: v['version_no'], params: paramsOf(v), ...opt('change_reason', v['change_reason']),
  effective_from: iso(v['effective_from']), created_at: iso(v['created_at']),
  created_by_display: (typeof v['created_by'] === 'string' ? labels.get(v['created_by']) : undefined) ?? UNKNOWN_USER,
});
