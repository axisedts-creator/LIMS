// C11 web DTOs (contracts/openapi/anatomic.yaml schemas, only the fields the T-19 screens read) and shared BFF types.
// LD-140 (2026-11-13): UI work uses the kit only; this file is plain data.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** [CONV] same shape as the micro / catalog keys: generated ones are UUIDs. */
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;

export interface FieldError { path?: string; code?: string; message: string }
/** ApiError cannot cross the server-action boundary, so the problem code travels as data. */
export type ActionResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string; requestId?: string; errors?: FieldError[] };
export interface Page<T> { data: T[]; page: { next_cursor?: string; limit: number } }

export const QUEUES = ['to_accession', 'grossing', 'bench', 'reporting', 'awaiting_lab', 'signed_out', 'cancelled', 'all'] as const;
export type Queue = (typeof QUEUES)[number];
export type CaseKind = 'histology' | 'cytology' | 'ihc' | 'molecular';
export type CaseStatus = 'received' | 'accessioned' | 'in_processing' | 'ready_for_reporting' | 'signed_out' | 'cancelled';

export interface CaseFlags { profile_missing: boolean; specimen_rejected: boolean; open_change: boolean; pending_stain_orders: number; parts_missing_site: boolean }
export interface PatientLite { display_name: string; sex: string; age_text: string; patient_code: string }
export interface CaseSummary {
  id: string; accession_no?: string; case_kind: CaseKind; status: CaseStatus; priority: 'routine' | 'urgent'; centre_id: string; order_id: string; patient_id: string;
  patient?: PatientLite; test_names: string[]; part_count: number; received_at: string; accessioned_at?: string; signed_out_at?: string;
  assigned_pathologist?: { membership_id: string; display_name: string }; flags: CaseFlags; version: number;
}
export interface GrossRecord {
  part_id: string; gross_text: string; pieces_count?: number; dimensions_mm?: string[]; weight_g?: string; is_complete: boolean; completed_at?: string;
  grossed_by_display_name: string; updated_at: string; version: number;
}
export interface Part {
  id: string; letter: string; site_text?: string; description_text?: string; specimen_id?: string; specimen_type_code?: string;
  specimen_state: 'received' | 'rejected' | 'none'; gross?: GrossRecord; version: number;
}
export interface CaseItem {
  case_item_id: string; order_item_id: string; test_id: string; test_name: string; role: 'primary' | 'addon'; is_active: boolean;
  lab_status?: 'pending' | 'resulted' | 'verified' | 'approved' | 'cancelled';
}
export interface CaseDetail extends CaseSummary {
  clinical_history_text?: string; current_version_no: number; parts: Part[]; items: CaseItem[]; molecular_rev: number;
  open_draft?: { kind: 'initial' | 'revision' | 'amendment'; version: number; updated_at: string };
  transitions: { from_status?: CaseStatus; to_status: CaseStatus; at: string; by_display_name: string }[];
  allowed_actions: string[];
  // Blocks, slides, stains, images, molecular results and addenda belong to the later tabs (T-20+); not typed here.
}
export interface TextTemplate { id: string; short_code: string; section: string; title: string; body: string; is_active: boolean; version: number }
export interface Assignee { membership_id: string; display_name: string }
export interface CodedValue { code: string; display: string }
export interface LookupResult { object_kind: 'case' | 'block' | 'slide'; case_id: string; block_id?: string; slide_id?: string }

export type TransitionOp = 'start-processing' | 'mark-ready';
export interface AccessionInput { clinical_history_text?: string; assigned_pathologist_membership_id?: string; parts: { part_id: string; site_text: string; description_text?: string }[] }
export interface PartInput { site_text: string; description_text?: string }
export interface GrossInput { gross_text: string; pieces_count?: number; dimensions_mm?: string[]; weight_g?: string; is_complete: boolean }
export interface CancelInput { reason_code: string; reason_text?: string }
