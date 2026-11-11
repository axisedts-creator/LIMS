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
export interface VerifyItem { id: string; version: number; acknowledged_flags?: AckFlag[] }
export interface ResultBulkRow { id: string; outcome: 'ok' | 'error'; code?: string }
