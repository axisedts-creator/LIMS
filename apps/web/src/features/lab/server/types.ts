// C5 lab screens (T-11): DTO shapes copied from contracts/openapi/lab.yaml (SpecimenDto allowlist, SpecimenBulkResponse, RejectSpecimenResponse).
// Envelope union of T-11 (title/detail) and T-26 (requestId).
export type ActionResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string; title?: string; detail?: string; requestId?: string };

// C5 T-26 web types: DTOs copied from contracts/openapi/lab.yaml (WorklistItemDto, PendingItemDto, WorksheetDto).
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

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const BARCODE_RE = /^[A-Z0-9]{1,20}$/;
export const REGNO_RE = /^[A-Z0-9]{1,40}$/;

export interface Specimen {
  id: string;
  version: number;
  barcode: string;
  order_id: string;
  registration_no: string;
  specimen_type_code: string;
  container_code?: string;
  status: string;
  priority: string;
  centre_id: string;
  processing_centre_id?: string;
  is_active: boolean;
  collected_at?: string;
  rejected_at?: string;
  rejection_reason_code?: string;
  collection_barcode_unverified: boolean;
  tests: { test_id: string; test_code: string }[];
}

export type LookupKey = { barcode: string } | { registration_no: string };
export interface BulkItem { id: string; version: number }
export interface BulkRow { id: string; outcome: 'ok' | 'error'; code?: string; specimen?: Specimen }
export interface RejectBody { reason_code: string; comment?: string; recollection_required: boolean }
export interface RejectResult { specimen: Specimen; recollection_specimen?: Specimen }
export interface RejectionReason { code: string; display: string }

// T-30 specimen detail (lab.yaml SpecimenDetailDto = SpecimenDto + transitions, tests, results summary; 02-TRD §5.1 #3, #10–#13)
export interface SpecimenTransition { from_status?: string; to_status: string; at: string }
export interface SpecimenDetail extends Specimen {
  parent_specimen_id?: string;
  replaces_specimen_id?: string;
  in_transit_at?: string;
  received_at?: string;
  rejection_comment?: string;
  label_print_count: number;
  transitions: SpecimenTransition[];
  results_summary?: { total: number; resulted: number; verified: number; approved: number };
}
export interface StoreBody { location: string }
export interface DiscardSpecimenBody { discard_reason: string }
export interface AliquotBody { aliquots: { specimen_type_code?: string; test_ids: string[] }[] }
export interface AliquotResult { parent: Specimen; aliquots: Specimen[] }

// T-27 status board (lab.yaml StatusBoardRow / StatusBoardPage; getStatusBoard #17)
export const BOARD_STATUSES = ['waiting', 'collected', 'in_lab', 'ready', 'printed'] as const;
export type BoardStatus = (typeof BOARD_STATUSES)[number];
export interface StatusBoardRow {
  order_id: string;
  registration_no: string;
  patient_display: { full_name: string; age_sex: string; patient_code: string };
  centre_id: string;
  board_status: BoardStatus;
  rejected_specimens: number;
  last_released_at?: string;
  priority: string;
}
export interface StatusBoardPage { data: StatusBoardRow[]; page: { limit: number; next_cursor?: string } }
export interface BoardQuery { registered_at_from: string; registered_at_to: string; centre_id?: string; board_status?: string; cursor?: string; limit?: number }
export const ISO_MS_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

// C5.T-21: verification / approval queue (VerificationQueueItem, ResultBulkResponse). Only the ResultDto fields the queues read.
export type AckFlag = 'delta' | 'critical' | 'unit_mismatch' | 'instrument_flag';
export interface QueueResult {
  id: string;
  version: number;
  analyte_code: string;
  status: string;
  flag?: string;
  range_unavailable_age_unknown: boolean;
  critical: { is_critical: boolean; critical_event_id?: string };
  delta?: { status: string };
  unit_mismatch: boolean;
  instrument_flags?: string[];
  on_hold: boolean;
}
export interface QueueItem {
  result: QueueResult;
  registration_no: string;
  barcode?: string;
  patient_display: { full_name: string; age_sex: string; patient_code: string };
  priority: string;
}
export interface QueueFilters { department_id?: string; priority?: string; flagged_only?: 'true' }
// C5.T-23: instrument exceptions (IngestExceptionDto / IngestExceptionDetail / IngestExceptionActionResponse; GET /v1/lab/orders/{id}/results).
export type ExceptionStatus = 'open' | 'resolved' | 'discarded';
export const EXCEPTION_STATUSES: readonly ExceptionStatus[] = ['open', 'resolved', 'discarded'];
export const EXCEPTION_REASONS = ['unmapped_code', 'unknown_barcode', 'specimen_rejected', 'specimen_not_received', 'analyte_not_ordered', 'result_locked', 'result_already_verified', 'unit_mismatch'] as const;
export interface IngestException {
  id: string; status: ExceptionStatus; reason: string; result_key: string; created_at: string;
  instrument_id?: string; sample_barcode?: string; instrument_analyte_code?: string; result_id?: string; resolved_at?: string; resolution?: string;
}
export interface IngestExceptionDetailDto extends IngestException { raw_value?: string; raw_flags?: string[]; unit_raw?: string }
export interface ExceptionPage { items: IngestException[]; nextCursor?: string }
export interface ExceptionAction { exception: IngestException; outcome: 'applied' | 'held' | 'unmatched' | 'rejected_state' | 'duplicate' | 'not_applicable'; result?: { id: string; status: string } }
export interface DiscardBody { reason_code: string; comment?: string }
export interface AssignBody { result_id: string; override_analyte?: true }
export interface OrderResult { id: string; analyte_code: string; status: string }
export interface OrderResultsItem { order_item_id: string; test: { id: string; code: string; name?: string }; results: OrderResult[] }

export interface VerifyItem { id: string; version: number; acknowledged_flags?: AckFlag[] }
export interface ResultBulkRow { id: string; outcome: 'ok' | 'error'; code?: string }

// C5.T-20: result entry grid (ResultDto / OrderResultsResponse / bulkEnterResults / getResultHistory / getAnalyteTrend). Only the fields the grid reads.
export const OCCURRED_AT_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$/;
export interface GridResult {
  id: string;
  version: number;
  order_id: string;
  order_item_id: string;
  specimen_id?: string;
  test_id: string;
  analyte_id: string;
  analyte_code: string;
  status: string; // pending | resulted | verified | approved | cancelled (kept a string so DTOs parsed from JSON type-check)
  origin: string;
  value_numeric?: string;
  value_text?: string;
  ordinal_code?: string;
  unit_code?: string;
  flag?: string;
  reference_range_snapshot?: { low?: string; high?: string; text?: string; unit_code?: string };
  range_unavailable_age_unknown: boolean;
  delta?: { status: string; prev_value?: string; abs?: string; pct?: string; prev_at?: string };
  critical: { is_critical: boolean; critical_event_id?: string };
  calc?: { status: string; reason?: string; provenance?: string };
  comment_codes?: string[];
  comment_text?: string;
  on_hold: boolean;
  qc_review_required: boolean;
  unit_mismatch: boolean;
  instrument_flags?: string[];
  current_version_no: number;
  // LD-25 (2026-11-07): not in lab.yaml ResultDto yet (SPEC GAP, see C5.T-20-impl.md); read when the API sends them
  entry_mode?: 'live' | 'downtime_backentry';
  occurred_at?: string;
  downtime_ref?: string;
}
export interface OrderResults {
  order: { order_id: string; registration_no: string; [k: string]: unknown };
  items: { order_item_id: string; test: { test_id: string; test_code: string }; results: GridResult[] }[];
}
export interface EnterEntry { result_id: string; version: number; value_numeric?: string; value_text?: string; ordinal_code?: string; comment_codes?: string[]; comment_text?: string }
/** LD-25 downtime back-entry: occurred_at = original time from the paper form (ISO instant), downtime_ref = paper form serial (<= 32). */
export interface DowntimeFields { entry_mode: 'downtime_backentry'; occurred_at: string; downtime_ref: string }
export interface EnterRow { result_id: string; outcome: 'ok' | 'error'; code?: string; result?: GridResult }
export interface EnterResponse { results: EnterRow[]; recomputed?: GridResult[] }
export interface ReturnBody { reason_code: string; comment?: string }
export interface AmendBody { value_numeric?: string; value_text?: string; ordinal_code?: string; amendment_reason_code: string; amendment_reason_text?: string; comment_codes?: string[]; comment_text?: string }
export interface HistoryRow { result_id: string; approved_at: string; value: string; unit_code?: string; flag?: string; version_no: number }
export interface TrendPoint { result_id: string; at: string; value: string; unit_code?: string; flag?: string }
export interface TrendResponse { points: TrendPoint[]; reference_band?: { low?: string; high?: string; unit_code?: string } }
export interface CommentCodeRow { code: string; text: string; version: number }
export interface CodedOption { code: string; display: string }
