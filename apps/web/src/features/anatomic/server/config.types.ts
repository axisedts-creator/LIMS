// C11 T-23 web DTOs for the configuration screens (contracts/openapi/anatomic.yaml: Settings, Stain, TestProfile, Assay, CodedValue, TextTemplate, SynopticTemplate*).
// LD-140 (2026-11-13): UI work uses the kit only; this file is plain data.
import type { Assay, CaseKind, TextTemplate } from './types';

export const CONFIG_TABS = ['settings', 'stains', 'test-profiles', 'assays', 'coded-lists', 'templates', 'text-templates'] as const;
export type ConfigTab = (typeof CONFIG_TABS)[number];
export const CODED_SETS = ['diagnoses', 'cytology_adequacy', 'cancel_reasons'] as const;
export type CodedSet = (typeof CODED_SETS)[number];

export interface Settings {
  auto_accession_on_receipt: boolean; require_gross_complete_for_processing: boolean; default_routine_stain_code: string; max_images_per_case: number; max_report_images: number; version: number;
}
export type SettingsInput = Omit<Settings, 'version'>;

export type StainKind = 'routine' | 'special' | 'ihc';
export interface StainRecord { id: string; code: string; display: string; kind: StainKind; addon_test_id?: string; sort_order: number; is_active: boolean; version: number }
export interface StainCreate { code: string; display: string; kind: StainKind; sort_order: number; addon_test_id?: string }
export interface StainUpdate { display: string; kind: StainKind; sort_order: number; is_active: boolean; addon_test_id?: string }

export interface TestProfile {
  test_id: string; test_name: string; case_kind: CaseKind; is_addon: boolean; requires_gross: boolean; default_stain_code?: string; default_synoptic_template_keys: string[]; is_active: boolean; version: number;
}
export interface TestProfileInput { case_kind: CaseKind; is_addon: boolean; requires_gross: boolean; default_stain_code?: string; default_synoptic_template_keys?: string[]; is_active: boolean }
export interface CatalogTest { id: string; code: string; name: string; workflow_type?: string }

export type AssayRecord = Assay;
export interface AssayValueInput { code: string; display: string; is_abnormal: boolean; sort_order: number; is_active: boolean }
export interface AssayTargetInput { code: string; display: string; allows_quantitative: boolean; unit_code?: string; decimals?: number; sort_order: number; is_active: boolean; result_values: AssayValueInput[] }
export interface AssayInput { code: string; display: string; method_text_default?: string; is_active: boolean; targets: AssayTargetInput[] }

export interface CodedRow { code: string; display: string; system: string; system_version?: string; sort_order: number; is_active: boolean; version: number }
export interface CodedInput { display: string; system: string; system_version?: string; sort_order: number; is_active: boolean }

export type TextTemplateRecord = TextTemplate;
export type TextSection = 'gross' | 'microscopy' | 'impression' | 'comment' | 'addendum';
export interface TextTemplateCreate { short_code: string; section: TextSection; title: string; body: string }
export interface TextTemplateUpdate { title: string; body: string; is_active: boolean }

// ---- synoptic templates (SynopticDefinitionV1; the API validator is the authority, the builder only avoids sending what it would refuse)
export type TemplateStatus = 'draft' | 'published' | 'retired';
export type FieldType = 'text' | 'long_text' | 'integer' | 'decimal' | 'boolean' | 'single_select' | 'multi_select' | 'date';
export interface FieldOption { code: string; display: string }
export interface ShowIf { field_key: string; equals: string | boolean }
export interface DefField {
  key: string; label: string; type: FieldType; required: boolean; help_text?: string; unit_text?: string; min?: string; max?: string; decimals?: number; max_length?: number;
  options?: FieldOption[]; show_if?: ShowIf;
}
export interface DefSection { key: string; heading: string; fields: DefField[] }
export interface Definition { schema_version: 1; title: string; applies_to_case_kinds: CaseKind[]; sections: DefSection[] }
export interface TemplateSummary { id: string; template_key: string; version_no: number; status: TemplateStatus; title: string; applies_to_case_kinds: CaseKind[]; published_at?: string }
export interface SynopticTemplate extends TemplateSummary { definition: Definition; version: number }
