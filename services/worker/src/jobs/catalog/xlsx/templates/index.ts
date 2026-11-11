// 02-TRD §8.2 import templates: `Instructions` + data sheets (header row = exact column keys) + hidden `_meta`.
import { writeXlsx, type SheetIn } from '../XlsxWriter.js';

export type TemplateKind = 'price_list' | 'catalog_master' | 'referrers' | 'credit_parties';
export type TemplateMeta = {
  tenantCatalogRevision: number;
  exportedAt: string; // IsoUtc
  priceList?: { id: string; code: string; baseVersionNo: number };
};

export const TEMPLATE_VERSION = 1;

/** Data sheets per kind, in workbook order: sheet name -> column keys (02-TRD §8.2, verbatim). */
export const TEMPLATE_SHEETS: Record<TemplateKind, Record<string, string[]>> = {
  price_list: {
    Prices: ['orderable_code', 'orderable_kind', 'orderable_name', 'department', 'unit_price_npr'],
  },
  catalog_master: {
    Departments: ['code', 'name', 'report_order', 'report_heading'],
    SpecimenTypes: ['code', 'name', 'report_label'],
    Containers: ['code', 'name', 'additive', 'cap_colour_display', 'default_specimen_type_code'],
    Methods: ['code', 'name'],
    Units: ['code', 'display'],
    ValueSets: ['value_set_code', 'is_ordered', 'value_code', 'value_display', 'sort_order'],
    Tests: ['code', 'name', 'department_code', 'workflow_type', 'report_order', 'is_orderable', 'specimen_type_codes', 'container_code'],
    Analytes: ['test_code', 'analyte_code', 'name', 'print_name', 'report_subheading', 'sort_order', 'is_reportable', 'result_type',
      'unit_code', 'decimals', 'method_code', 'value_set_code', 'formula'],
    ReferenceRanges: ['analyte_code', 'sex', 'age_low', 'age_low_unit', 'age_high', 'age_high_unit', 'specimen_type_code', 'kind',
      'low', 'high', 'normal_codes', 'display_text'],
    CriticalLimits: ['analyte_code', 'sex', 'age_low', 'age_low_unit', 'age_high', 'age_high_unit', 'specimen_type_code', 'low', 'high',
      'abnormal_codes'],
    Panels: ['code', 'name', 'panel_kind', 'sex_restriction', 'department_code'],
    PanelMembers: ['panel_code', 'member_code', 'sort_order'],
    CommentCodes: ['code', 'department_code', 'text'],
    TatTargets: ['test_code', 'priority', 'segment', 'target_minutes'],
  },
  referrers: {
    Doctors: ['doctor_code', 'display_name', 'qualification', 'registration_council', 'registration_no', 'phone_e164', 'email', 'is_verified'],
  },
  credit_parties: {
    CreditParties: ['party_code', 'name', 'kind', 'allows_credit', 'pan', 'contact_phone_e164', 'contact_email', 'billing_address'],
  },
};

function instructions(kind: TemplateKind): unknown[][] {
  return [
    [`Import template: ${kind} (template version ${TEMPLATE_VERSION})`],
    ['Row 1 of each data sheet holds the column keys. Columns may be reordered; unknown columns are ignored with a warning.'],
    ...Object.entries(TEMPLATE_SHEETS[kind]).map(([sheet, cols]) => [`Sheet ${sheet}: ${cols.join(', ')}`]),
    ['Prices in NPR with at most 2 decimals.'],
    ['Do not edit the hidden _meta sheet.'],
    ['Tax treatment of lab services is pending confirmation by your auditor.'],
  ];
}

export async function buildImportTemplate(kind: TemplateKind, meta: TemplateMeta): Promise<Uint8Array> {
  const metaRows: unknown[][] = [
    ['template_kind', kind],
    ['template_version', TEMPLATE_VERSION],
    ['tenant_catalog_revision', meta.tenantCatalogRevision],
    ['exported_at', meta.exportedAt],
  ];
  if (kind === 'price_list') {
    if (!meta.priceList) throw new Error('price_list template needs meta.priceList');
    metaRows.push(['price_list_id', meta.priceList.id], ['price_list_code', meta.priceList.code], ['base_version_no', meta.priceList.baseVersionNo]);
  }
  const sheets: SheetIn[] = [
    { name: 'Instructions', rows: instructions(kind) },
    ...Object.entries(TEMPLATE_SHEETS[kind]).map(([name, cols]) => ({ name, rows: [cols] })),
    { name: '_meta', rows: metaRows, hidden: true },
  ];
  return writeXlsx(sheets);
}
