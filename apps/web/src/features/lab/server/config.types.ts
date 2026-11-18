// C5 T-29 web types: DTOs copied from contracts/openapi/lab.yaml (LabSettingsDto / LabSettingsUpdate, DeltaCheckRuleDto, LabCodeDto).
export interface LabSettings {
  version: number; label_width_mm: number; label_height_mm: number; label_copies_default: number; label_renderer: 'html_svg';
  host_query_requires_received: boolean; ingest_auto_receive: boolean; critical_notification_blocks_approval: boolean; recollection_default: boolean;
  delta_check_enabled: boolean; history_days: number;
}
export type LabSettingsUpdate = Omit<LabSettings, 'version'>;

export interface DeltaRule {
  id: string; version: number; analyte_id: string; rule_version: number; window_seconds: number; abs_threshold?: string; pct_threshold?: string;
  unit_code: string; effective_from: string; effective_to?: string; is_active: boolean;
}
/** #50 body (analyte_id) / #51 body (none): thresholds are replaced, never merged. */
export interface DeltaRuleBody { analyte_id?: string; window_seconds: number; abs_threshold?: string; pct_threshold?: string; unit_code: string; effective_from?: string }

export const CODED_SETS = ['rejection_reasons', 'return_reasons', 'amendment_reasons', 'exception_discard_reasons'] as const;
export type CodedSetName = (typeof CODED_SETS)[number];
export interface LabCode { code: string; display: string; sort_order: number; is_active: boolean; source: 'global' | 'tenant' }
export interface LabCodeBody { display: string; sort_order: number; is_active: boolean }

// T0D-VERLEVEL-1 (LD-316): VerificationPolicy / VerificationPolicyUpsert / ResultSignoff (contracts/openapi/lab.yaml), catalog option rows (catalog.yaml listDepartments / listTests).
export type PolicyScope = 'lab' | 'department' | 'test';
export interface VerificationPolicy {
  id: string; scope: PolicyScope; department_id?: string; test_id?: string; required_verifiers: number; require_pathologist: boolean; allow_enterer_verify: boolean;
  active: boolean; version: number; updated_at: string;
}
export interface VerificationPolicyUpsert {
  scope: PolicyScope; department_id?: string; test_id?: string; required_verifiers: number; require_pathologist: boolean; allow_enterer_verify: boolean;
}
export interface ResultSignoff {
  result_version: number; seq: number; action: 'verify' | 'approve'; signer_user_id?: string; signer_display_name: string; signer_title?: string;
  signer_role_code: string; signer_is_pathologist: boolean; signer_registration_no?: string; signed_at: string;
}
export interface CatalogOption { id: string; code: string; name: string }
