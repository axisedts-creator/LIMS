// C5 T-25 web types: DTOs copied from contracts/openapi/lab.yaml (QcResultDto, QcHoldDto, captureQcResult body).
export interface QcResult {
  id: string; centre_id: string; instrument_id: string; analyte_id: string; control_id_raw: string; control_lot_raw?: string; control_level?: string;
  value_numeric: string; unit_code?: string; instrument_result_time: string; source: string; received_at: string;
}
export interface QcCaptureBody {
  centre_id: string; instrument_id: string; analyte_id: string; control_id_raw: string; control_lot_raw?: string; control_level?: string;
  value_numeric: string; unit_code?: string; instrument_result_time: string;
}
export type QcHoldStatus = 'active' | 'released';
export interface QcHold { id: string; instrument_id: string; analyte_id: string; status: QcHoldStatus; held_at: string; released_at?: string; release_comment?: string }
export interface NamedOption { id: string; name: string }
