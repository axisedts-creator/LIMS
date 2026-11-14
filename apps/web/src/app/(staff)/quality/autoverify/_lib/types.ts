// C9 T-23 view-model types: the subset of contracts/openapi/quality.yaml (AutoverifyRuleSetDto, AutoverifyVersionDto, SimulationReportDto, AutoverifyDecisionDto,
// QualitySettingsDto) the auto-verification screens read. Plain JSON only. No patient identifiers exist in any of these DTOs.

export type VersionStatus = 'draft' | 'simulating' | 'stopped' | 'active' | 'retired' | 'discarded';
export type Reason = 'manual_origin' | 'rule_missing' | 'critical' | 'delta_failure' | 'instrument_flag' | 'outside_autoverify_limits' | 'qc_out_of_control' | 'qc_warning' | 'qc_no_data';
export type RangeFlag = 'N' | 'L' | 'H';

export interface Rule {
  key: string;
  test_id: string;
  analyte_id: string;
  instrument_id?: string;
  enabled: boolean;
  limits?: { low?: string; high?: string };
  allowed_range_flags?: RangeFlag[];
  instrument_flags_allowed?: string[];
  qc_allow_warning?: boolean;
  note?: string;
}
export interface Definition { schema_version: 1; rules: Rule[] }

export interface VersionSummary {
  id: string;
  version_no: number;
  status: VersionStatus;
  rule_count: number;
  created_at: string;
  created_by_display: string;
  simulation_started_at?: string;
  simulation_stopped_at?: string;
  activated_at?: string;
  activated_by_display?: string;
  retired_at?: string;
}
export interface RuleSet { id: string; version: number; active_version_id?: string; simulating_version_id?: string; versions: VersionSummary[] }
export interface Version extends VersionSummary { rule_set_id: string; version: number; definition: Definition }

export interface Settings { sim_min_days: number; sim_min_decisions: number; auto_verification_enabled: boolean }

export interface SampleRow {
  decision_id: string;
  result_id: string;
  order_id?: string;
  analyte_id: string;
  decided_at: string;
  shadow_decision: 'allow' | 'deny';
  shadow_reasons: Reason[];
  live_decision?: 'allow' | 'deny';
  manually_verified_at?: string;
}
export interface Report {
  version_id: string;
  started_at: string;
  days_running: number;
  decisions: number;
  would_allow: number;
  would_deny: number;
  deny_by_reason: Partial<Record<Reason, number>>;
  allow_later_manually_verified: number;
  allow_not_verified_yet: number;
  sample: SampleRow[];
}

export type QcState = 'in_control' | 'warning' | 'out_of_control' | 'no_qc_data';
export interface Decision {
  id: string;
  decided_at: string;
  mode: 'live' | 'shadow';
  decision: 'allow' | 'deny';
  reasons: Reason[];
  result_id: string;
  analyte_id: string;
  instrument_id?: string;
  version_id?: string;
  matched_rule_key?: string;
  qc_status: QcState;
  qc_run_id?: string;
  inputs?: { value_numeric?: string; range_flag?: string; delta_check_failed: boolean; is_critical: boolean; instrument_flags: string[]; resulted_at: string };
}

export interface FieldError { path: string; message: string }
/** Outcome of a mutation / read through a server action; never carries a problem body or token. `errors` only for 422 validation. */
export type ActionResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string; errors?: FieldError[] };
