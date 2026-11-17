// C9 T-21 view-model types: the subset of contracts/openapi/quality.yaml (QcStatusRowDto, QcRunSummaryDto, QcRunDto, QcObservationDto, LjChartDto) the screens read.
// Plain JSON only: server components hand these to client views. No patient identifiers exist in any of these DTOs.

export type QcStatus = 'in_control' | 'warning' | 'out_of_control' | 'no_qc_data';

export interface StatusRow {
  plan_id: string;
  instrument_id: string;
  instrument_label: string;
  analyte_id: string;
  analyte_code: string;
  status: QcStatus;
  last_in_control_run_at?: string;
  current_run_id?: string;
  violated_rules: string[];
  open_rejected_run_ids: string[];
  qc_overdue: boolean;
  patient_results_since_last_qc: number;
}

export interface RunSummary {
  id: string;
  version: number;
  plan_id: string;
  instrument_id: string;
  analyte_id: string;
  run_at: string;
  status: 'collecting' | 'evaluated' | 'closed';
  outcome?: 'accepted' | 'accepted_warning' | 'incomplete' | 'rejected';
  is_complete: boolean;
  observation_count: number;
  controls_per_run: number;
  rule_mode: 'classic' | 'modern';
  warning_rules: string[];
  rules_violated: string[];
  needs_action: boolean;
  needs_action_reason?: 'corrective_action' | 'rerun';
  closed_at?: string;
}

export interface RunObservation {
  id: string;
  level_id?: string;
  lot_id?: string;
  control_lot_raw: string;
  control_level_raw: string;
  value: string;
  unit_code?: string;
  observed_at: string;
  observed_at_basis: string;
  status: string;
  z?: string;
  rule_hits: string[];
}

export interface CorrectiveAction {
  id: string;
  action_display: string;
  description: string;
  performed_at: string;
  performed_by_display: string;
}

export interface RunReview {
  id: string;
  kind: 'acknowledge' | 'evaluate_now' | 'close';
  comment?: string;
  reviewed_by_display: string;
  created_at: string;
}

export interface RunDetail extends RunSummary {
  plan_version_no: number;
  observations: RunObservation[];
  rule_detail: { rule: string; observation_ids: string[] }[];
  hold?: { hold_since: string; last_in_control_run_at?: string; event_id: string };
  corrective_actions: CorrectiveAction[];
  reviews: RunReview[];
  evaluated_at?: string;
  evaluated_by?: string;
}

export interface UnassignedObservation {
  id: string;
  instrument_id: string;
  control_id_raw: string;
  control_lot_raw: string;
  control_level_raw: string;
  value: string;
  unit_code?: string;
  observed_at: string;
  status: string;
}

export type PointStatus = 'accepted' | 'warning' | 'rejected' | 'excluded' | 'unevaluated' | 'collecting';
export interface LjPoint { observation_id: string; observed_at: string; value: string; z?: string; status: PointStatus; qc_run_id?: string; rule_hits: string[] }
export interface LjTarget { target_id: string; effective_from: string; effective_to?: string; mean: string; sd: string; source: 'manufacturer' | 'established' }
export interface LjSeries { level_id: string; level_code: string; lot_id: string; lot_no: string; points: LjPoint[]; targets: LjTarget[] }
export interface LjChart {
  plan: { id: string; instrument_id: string; analyte_id: string; analyte_code: string; unit_code?: string; decimals: number };
  view: 'level' | 'z';
  truncated: boolean;
  series: LjSeries[];
}

export interface CodeOption { code: string; display: string; isActive: boolean }
export type ListPage<T> = { rows: T[]; next?: string };

// C9 T-24 (contracts/openapi/quality.yaml: TatAlertDto, QualitySettingsDto, QualityCode). Plain JSON only; no patient identifiers.
export type TatLevel = 'none' | 'warning' | 'breached' | 'escalated';
export interface TatAlert {
  tat_item_id: string; version: number; order_id: string; order_item_id: string; test_id: string; test_code: string; department_id: string; specimen_id?: string; centre_id: string;
  priority: 'routine' | 'urgent'; segment: 'within_lab' | 'total'; segment_label: string; start_basis: string; target_seconds: number; started_at?: string; elapsed_seconds: number; pct_of_target: number;
  alert_level: TatLevel; acknowledged_level?: Exclude<TatLevel, 'none'>; acknowledged_at?: string; acknowledged_by_display?: string; state: string;
}
export interface QualitySettings {
  version: number; tat_alerts_enabled: boolean; tat_warn_pct: number; tat_escalate_pct: number; tat_orphan_close_hours: number; target_min_points: number; sim_min_days: number; sim_min_decisions: number;
  reprocess_window_days: number; default_plan_params: Record<string, unknown>; activated_at: string; updated_at?: string; updated_by_display?: string; westgard_mode: 'classic' | 'modern'; auto_verification_enabled: boolean;
}
export interface QualityCode { code: string; display: string; sort_order: number; is_active: boolean; source: 'global' | 'tenant' | string }
/** Outcome of a client poll / mutation through a server action; never carries a problem body or token. */
export type ActionResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string };
