// C5 lab screens (T-11): DTO shapes copied from contracts/openapi/lab.yaml (SpecimenDto allowlist, SpecimenBulkResponse, RejectSpecimenResponse).
export type ActionResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string; title?: string; detail?: string };

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
export interface BoardQuery { registered_at_from: string; registered_at_to: string; centre_id?: string; board_status?: string }
export const ISO_MS_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
