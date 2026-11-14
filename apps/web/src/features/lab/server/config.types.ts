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
