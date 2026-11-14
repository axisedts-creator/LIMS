// C11 T-21 web DTOs for the Report tab (contracts/openapi/anatomic.yaml: ReportDraft, ReportDraftInput, ReportVersion(Summary), SignOutResult, Addendum).
// LD-140 (2026-11-13): UI work uses the kit only; this file is plain data.
import type { CaseDetail } from './types';

export type ReportKind = 'initial' | 'revision' | 'amendment';
export type SynopticValue = string | number | boolean | string[];
export interface DraftSynoptic { template_id: string; template_key: string; template_version: number; title: string; values: Record<string, SynopticValue> }
export interface DiagnosisCode { code: string; display: string; system: string; system_version?: string }
export interface ReportDraft {
  case_id: string; kind: ReportKind; change_reason_code?: string; change_reason_text?: string;
  gross_text: string; microscopy_text: string; impression_text: string; comment_text: string; flag?: 'N' | 'A'; is_critical: boolean;
  synoptic: DraftSynoptic[]; image_ids: string[]; ancillary: { stain_order_id: string; result_text: string }[]; diagnosis_codes: DiagnosisCode[];
  updated_at: string; updated_by_display_name: string; version: number;
}
/** Full replacement of the mutable draft content (R2). `flag` is omitted for "Not stated". */
export interface ReportDraftInput {
  gross_text: string; microscopy_text: string; impression_text: string; comment_text: string; flag?: 'N' | 'A'; is_critical: boolean;
  synoptic: { template_id: string; values: Record<string, SynopticValue> }[]; image_ids: string[];
  ancillary: { stain_order_id: string; result_text: string }[]; diagnosis_codes: { code: string }[];
}
export type VersionKind = 'original' | 'revision' | 'amendment' | 'addendum';
export interface VersionSummary {
  version_no: number; version_kind: VersionKind; scope: string; signed_at: string; signed_by_display_name: string; change_reason_code?: string;
  submissions: { case_item_id: string; order_item_id: string; item_version_no: number; lab_status_at_submit?: string }[];
}
/** R7 snapshot. Image storage paths are never typed here: only captions are shown (REQ-SEC-088). */
export interface VersionFull extends VersionSummary {
  clinical_history_text?: string; gross_text: string; microscopy_text: string; impression_text: string; comment_text: string; is_critical?: boolean;
  synoptic: { template_key: string; template_version: number; title: string; sections: { heading: string; items: { label: string; value: string }[] }[] }[];
  images: { caption?: string }[]; specimen_parts: { letter: string; site_text?: string }[]; slides: { label: string; stain_display?: string }[];
  ancillary: { stain_display?: string; block_label?: string; result_text: string }[]; diagnosis_codes: DiagnosisCode[];
}
export interface SignOutResult { case: CaseDetail; report_version: VersionSummary }
export type AddendumKind = 'ihc' | 'special_stain' | 'molecular' | 'other';
export interface Addendum {
  id: string; kind: AddendumKind; text: string; stain_order_ids: string[]; addon_case_item_id?: string; status: 'draft' | 'signed';
  signed_at?: string; signed_by_display_name?: string; report_version_no?: number; version: number;
}
export interface AddendumInput { kind: AddendumKind; text: string; stain_order_ids: string[]; addon_case_item_id?: string }
export interface ChangeInput { reason_code: string; reason_text?: string }
export interface SynopticSummary { id: string; template_key: string; version_no: number; title: string }
export interface DiagnosisOption { code: string; display: string; system: string }
export interface ReasonOption { code: string; display: string }
