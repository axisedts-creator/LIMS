// C11 web DTOs (contracts/openapi/anatomic.yaml schemas, only the fields the T-19 screens read) and shared BFF types.
// LD-140 (2026-11-13): UI work uses the kit only; this file is plain data.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** [CONV] same shape as the micro / catalog keys: generated ones are UUIDs. */
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;

export interface FieldError { path?: string; code?: string; message: string }
/** ApiError cannot cross the server-action boundary, so the problem code travels as data. */
export type ActionResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string; requestId?: string; detail?: string; errors?: FieldError[] };
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
export type LocationStatus = 'in_lab' | 'stored' | 'sent_out' | 'discarded';
export interface Block { id: string; part_id: string; label: string; seq: number; note?: string; location_status: LocationStatus; location_text?: string; slide_count: number; version: number }
/** listAnatomicBlocks row (BlockRow): a Block plus its case. */
export interface BlockRow extends Block { case_id: string; accession_no: string; last_movement_at?: string }
export interface Slide {
  id: string; label: string; block_id?: string; part_id: string; stain_code: string; stain_display: string; status: 'pending_stain' | 'ready'; location_status: LocationStatus;
  location_text?: string; stain_order_id?: string; adequacy_code?: string; finding_text?: string; include_in_report: boolean; version: number;
}
export type StainOrderStatus = 'requested' | 'in_progress' | 'completed' | 'cancelled';
export interface StainOrder {
  id: string; stain_code: string; stain_display: string; stain_kind: 'special' | 'ihc'; block_id?: string; block_label?: string; part_id?: string; status: StainOrderStatus; note?: string;
  reagent_lot?: string; addon_order_item_id?: string; requested_at: string; requested_by_display_name: string; completed_at?: string; version: number;
}
export type ImageKind = 'gross' | 'microscopy' | 'other';
export interface CaseImage {
  id: string; kind: ImageKind; part_id?: string; caption?: string; state: 'processing' | 'ready' | 'quarantined'; mime_type?: 'image/png' | 'image/jpeg'; width_px?: number; height_px?: number;
  created_at: string; is_active: boolean; version: number;
}
export type MovementKind = 'stored' | 'retrieved' | 'sent_out' | 'returned' | 'discarded';
export type MovementReason = 'second_opinion' | 'external_stain' | 'consultation' | 'retention_expired' | 'other';
export interface Movement { id: string; movement: MovementKind; location_text?: string; destination_text?: string; reason_code?: MovementReason; note?: string; at: string; by_display_name: string }
export interface MovementInput { object_kind: 'block' | 'slide'; object_ids: string[]; movement: MovementKind; location_text?: string; destination_text?: string; reason_code?: MovementReason; note?: string }
export interface MovementOutcome { id: string; outcome: 'recorded' | 'invalid_state' | 'not_found' }
export interface LabelItem { object_kind: 'block' | 'slide'; object_id: string; label: string; line2: string }
export interface Stain { id: string; code: string; display: string; kind: 'routine' | 'special' | 'ihc'; is_active: boolean }

export interface CaseDetail extends CaseSummary {
  clinical_history_text?: string; current_version_no: number; parts: Part[]; items: CaseItem[]; molecular_rev: number;
  blocks: Block[]; slides: Slide[]; stain_orders: StainOrder[]; images: CaseImage[];
  open_draft?: { kind: 'initial' | 'revision' | 'amendment'; version: number; updated_at: string };
  transitions: { from_status?: CaseStatus; to_status: CaseStatus; at: string; by_display_name: string }[];
  allowed_actions: string[];
  /** Molecular cases only (T-22). Addenda belong to the later tabs (T-21+) and are not typed here. */
  molecular_results?: MolecularResult[];
  /** T-21: addenda of the case (R8-R10). */
  addenda?: import('./report.types').Addendum[];
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
export interface AddBlocksInput { part_id: string; count: number; note?: string }
/** Exactly one of block_id / part_id (API rule). */
export interface AddSlidesInput { block_id?: string; part_id?: string; stain_code: string; count: number }
export interface AssessmentInput { adequacy_code?: string; finding_text?: string; include_in_report: boolean }
export interface OrderStainInput { stain_code: string; block_id?: string; part_id?: string; note?: string; addon_order_item_id?: string }
export interface CompleteStainInput { slide_count: number; reagent_lot?: string; performed_at?: string }
export interface ImageMetaInput { kind: ImageKind; part_id?: string; caption?: string }
export interface BulkResult { id: string; outcome: string }

// ---- molecular (T-22): Assay (K8), MolecularResult / saveAnatomicMolecularResults (Q1), Batch / BatchDetail (Q2-Q7)
export interface AssayResultValue { code: string; display: string; is_abnormal: boolean; sort_order: number; is_active: boolean }
export interface AssayTarget {
  id: string; code: string; display: string; allows_quantitative: boolean; unit_code?: string; decimals?: number; sort_order: number; is_active: boolean; result_values: AssayResultValue[];
}
export interface Assay { id: string; code: string; display: string; method_text_default?: string; is_active: boolean; version: number; targets: AssayTarget[] }
export interface MolecularResult {
  id: string; assay_code: string; assay_display: string; target_code: string; target_display: string; result_code: string; result_display: string; is_abnormal: boolean;
  value_decimal?: string; unit_code?: string; method_text?: string; kit_name?: string; kit_lot?: string; kit_expiry_on?: string; batch_id?: string; batch_no?: string; comment_text?: string;
}
/** Body item of saveAnatomicMolecularResults (additionalProperties: false: no display fields, no ids except batch_id). */
export interface MolecularInput {
  assay_code: string; target_code: string; result_code: string; value_decimal?: string; unit_code?: string; method_text?: string; kit_name?: string; kit_lot?: string;
  kit_expiry_on?: string; batch_id?: string; comment_text?: string;
}
export type BatchStatus = 'open' | 'closed';
export interface Batch {
  id: string; batch_no: string; assay_code: string; status: BatchStatus; kit_name?: string; kit_lot?: string; kit_expiry_on?: string; instrument_text?: string; run_at?: string;
  capacity: number; member_count: number; version: number;
}
/** `accession_no` is withheld by the API outside the user's centres (07-SECURITY): the UI shows "Restricted". */
export interface BatchMember { case_id: string; accession_no?: string; position: number }
export interface BatchDetail extends Batch { members: BatchMember[] }
export interface BatchInput { assay_code: string; kit_name?: string; kit_lot?: string; kit_expiry_on?: string; instrument_text?: string; run_at?: string; capacity?: number }
export interface BatchQuery { status?: BatchStatus; assay_code?: string; cursor?: string }
