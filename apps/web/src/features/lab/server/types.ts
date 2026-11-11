// C5 T-26 web types: DTOs copied from contracts/openapi/lab.yaml (WorklistItemDto, PendingItemDto, WorksheetDto) + the action result envelope.
export type ActionResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string; requestId?: string };

export interface PatientDisplay { full_name: string; age_sex: string; patient_code: string }
export interface WorklistItem {
  order_test_id: string; order_id: string; specimen_id?: string; barcode?: string; registration_no: string; patient_display: PatientDisplay; test_id: string; test_code: string;
  priority: string; status: string; received_at?: string; result_counts: { total: number; resulted: number; verified: number };
}
export interface PendingItem {
  order_test_id: string; order_id: string; registration_no: string; patient_display: PatientDisplay; test_code: string; item_status: string; priority: string; centre_id?: string;
  age_seconds: number; age_anchor: 'registered' | 'received'; tat_target_seconds?: number; over_target: boolean;
}
export interface Worksheet {
  id: string; title: string; centre_id: string; processing_centre_id?: string; department_id?: string; instrument_id?: string; created_at: string;
  rows: { order_test_id: string; position: number; barcode?: string; test_code: string }[];
}
export interface WorksheetSummary {
  id: string; title: string; centre_id: string; processing_centre_id?: string; department_id?: string; instrument_id?: string; created_at: string; row_count: number;
}
export interface Page<T> { data: T[]; page: { limit: number; next_cursor?: string } }
export interface InstrumentOption { id: string; display_name: string }
