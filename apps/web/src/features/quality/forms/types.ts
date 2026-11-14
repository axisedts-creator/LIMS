// C9 T-22 set-up DTOs (contracts/openapi/quality.yaml: ControlMaterialDto, ControlLevelDto, ControlLotDto, ControlIdMapDto, QcPlanDto, QcTargetDto). Plain JSON only.
export interface Lot { id: string; version: number; level_id: string; material_id: string; lot_no: string; expires_on: string; is_expired: boolean; is_active: boolean }
export interface Level { id: string; version: number; material_id: string; level_code: string; display_name: string; sort_order: number; is_active: boolean; lots?: Lot[] }
export interface Material {
  id: string; version: number; code: string; name: string; manufacturer?: string; matrix?: string; is_active: boolean; lots_expiring_30d: number; levels: Level[];
}
export interface IdMap {
  id: string; version: number; instrument_id: string; instrument_label?: string; control_id_raw: string; control_lot_raw?: string; lot_id: string; is_active: boolean;
}
export interface PlanParams {
  controls_per_run: number;
  composition: { level_id: string; count: number }[];
  mean_rule: string;
  two_two_s_across_runs?: boolean;
  count_rules_across_materials?: boolean;
  exclude_rejected_runs_from_history?: boolean;
  run_window_minutes?: number;
  qc_validity_hours?: number;
  hold_lookback_hours?: number;
}
export interface Plan {
  id: string; version: number; instrument_id: string; instrument_label?: string; test_id?: string; analyte_id: string; analyte_code?: string; analyte_name?: string;
  unit_code?: string; decimals?: number; status: 'active' | 'inactive' | string; current_version_no: number; params: PlanParams;
}
export interface Target {
  id: string; version: number; plan_id: string; lot_id: string; level_id: string; mean: string; sd: string; cv_pct?: string; unit_code?: string; source: 'manufacturer' | 'established';
  status: 'draft' | 'active' | 'superseded' | 'retired' | 'discarded' | string; effective_from?: string; effective_to?: string; basis?: { n: number }; note?: string;
}
/** One option of an async picker (instrument, test) or a fixed id/label pair. */
export interface Picked { id: string; label: string }
export interface AnalyteOption { id: string; label: string }
export interface PreviewPoint { id: string; observed_at: string; value: string }
export interface FieldIssue { pointer: string; message: string }

/** Result of a set-up server action: never carries a token or a raw problem body, only the code, status and sanitised field messages. */
export type SetupResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string; errors?: FieldIssue[] };
