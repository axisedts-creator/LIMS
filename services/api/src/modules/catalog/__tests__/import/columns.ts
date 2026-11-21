// T0B-TESTIMPORT-1 (LD-318, founder 2026-11-17 08:58 NPT) PINNED template layout. The tester pins the sheet names, the header labels (and their order) and the contract field each
// column feeds; the writer generates the workbook from field definitions that produce exactly these headers, and template.test.ts proves two things:
//   (1) the headers of the downloaded template equal this list (in order), and
//   (2) every property of the contract create schemas is fed by a column here or is in EXCLUDED with a reason, so the template and the forms can never drift.
// The lead may overrule a label; then this one file and the writer change together. Row numbers in errors are EXCEL rows (header = row 1, first data row = 2).
export const TEMPLATE_VERSION = '1';
export const SHEET = { instructions: 'Instructions', tests: 'Tests', params: 'Parameters', ranges: 'Reference Ranges', panels: 'Panels', lists: 'Lists', meta: 'Meta' } as const;
export type DataSheet = typeof SHEET.tests | typeof SHEET.params | typeof SHEET.ranges | typeof SHEET.panels;
export interface Col { label: string; /** contract properties this column feeds, `Schema.property` */ fields: string[]; required?: boolean }
const c = (label: string, fields: string[] = [], required = false): Col => ({ label, fields, required });

export const COLUMNS: Record<DataSheet, Col[]> = {
  [SHEET.tests]: [
    c('Test Code', ['TestCreate.code'], true), c('Test Name', ['TestCreate.name'], true), c('Short Name', ['TestCreate.short_name']), c('Display Name', ['TestCreate.display_name']),
    c('Department Code', ['TestCreate.department_id'], true), c('Category Name', ['TestCreate.category_id']), c('Specimen Code', ['TestCreate.specimen_requirements'], true),
    c('Workflow Type', ['TestCreate.workflow_type'], true), c('Report Type', ['TestCreate.report_type']), c('Processing Type', ['TestCreate.processing_type']),
    c('Tags', ['TestCreate.tags']), c('Barcode Text', ['TestCreate.barcode_text']), c('Loyalty Points', ['TestCreate.loyalty_points']), c('Display Order', ['TestCreate.display_order']),
    c('Report Order', ['TestCreate.report_order']), c('Description', ['TestCreate.description']), c('Outsource Name', ['TestCreate.outsource_name']),
    c('Orderable', ['TestCreate.is_orderable']), c('Outsourced', ['TestCreate.is_outsourced']), c('Popular', ['TestCreate.is_popular']), c('Smart Report', ['TestCreate.smart_report']),
    c('Print Category Wise', ['TestCreate.print_category_wise']), c('NABL', ['TestCreate.nabl']), c('ACCAB Logo', ['TestCreate.accab_logo']),
    c('Auto Approval', ['TestCreate.auto_approval_enabled']), c('Use Normal Range For Auto Approval', ['TestCreate.use_normal_range_for_auto_approval']),
    c('Template Test', ['TestCreate.template_test']), c('Font', ['TestCreate.font']), c('Alert Before Expiry Minutes', ['TestCreate.alert_before_expiry_minutes']),
    c('TAT Registration Minutes', ['StageTatTarget.stage=registration']), c('TAT Sample Collection Minutes', ['StageTatTarget.stage=sample_collection']),
    c('TAT Accession Minutes', ['StageTatTarget.stage=accession']), c('TAT Result Minutes', ['StageTatTarget.stage=result']),
    c('TAT Approval 1 Minutes', ['StageTatTarget.stage=approval_1']), c('TAT Approval 2 Minutes', ['StageTatTarget.stage=approval_2']), c('TAT Release Minutes', ['StageTatTarget.stage=release']),
  ],
  [SHEET.params]: [
    c('Test Code', [], true), c('Short Name', ['AnalyteCreate.code'], true), c('Parameter Name', ['AnalyteCreate.name'], true), c('Print Name', ['AnalyteCreate.print_name']),
    c('Report Subheading', ['AnalyteCreate.report_subheading']), c('Sort Order', ['AnalyteCreate.sort_order']), c('Reportable', ['AnalyteCreate.is_reportable']), c('Trend Name', ['AnalyteCreate.trend_name']),
    c('Specimen Code', ['AnalyteCreate.specimen_type_id']), c('Font', ['AnalyteCreate.font']), c('Result Display Type', ['AnalyteCreate.result_display_type']),
    c('Print On Negative', ['AnalyteCreate.print_on_negative']), c('Print On Worksheet', ['AnalyteCreate.print_on_worksheet']), c('Send In SMS', ['AnalyteCreate.send_in_sms']),
    c('NABL', ['AnalyteCreate.nabl']), c('ACCAB Logo', ['AnalyteCreate.accab_logo']), c('Is Trend', ['AnalyteCreate.is_trend']),
    c('Result Type', ['AnalyteVersionDraftInput.result_type'], true), c('Unit Code', ['AnalyteVersionDraftInput.unit_code']), c('Decimals', ['AnalyteVersionDraftInput.decimals']),
    c('Method Code', ['AnalyteVersionDraftInput.method_id']), c('Value Set Code', ['AnalyteVersionDraftInput.value_set_code']), c('Equation', ['AnalyteVersionDraftInput.formula_expression']),
    c('Default Value', ['AnalyteVersionDraftInput.default_value']), c('Long Text Value', ['AnalyteVersionDraftInput.long_text_value']), c('High Low', ['AnalyteVersionDraftInput.high_low']),
    c('Require Verification', ['AnalyteVersionDraftInput.require_verification']),
  ],
  [SHEET.ranges]: [
    c('Test Code', [], true), c('Short Name', [], true), c('Instrument Code', ['RangeBand.instrument_id']), c('Laboratory Code', ['RangeBand.laboratory_id']),
    c('Sex', ['RangeBand.sex', 'CriticalBand.sex'], true), c('Age From', ['RangeBand.age_low.value', 'CriticalBand.age_low.value']), c('Age From Unit', ['RangeBand.age_low.unit', 'CriticalBand.age_low.unit']),
    c('Age To', ['RangeBand.age_high.value', 'CriticalBand.age_high.value']), c('Age To Unit', ['RangeBand.age_high.unit', 'CriticalBand.age_high.unit']),
    c('Specimen Code', ['RangeBand.specimen_type_id', 'CriticalBand.specimen_type_id']), c('Kind', ['RangeBand.kind'], true), c('Normal Low', ['RangeBand.low']), c('Normal High', ['RangeBand.high']),
    c('Normal Codes', ['RangeBand.normal_codes']), c('Display Text', ['RangeBand.display_text']), c('Default Range', ['RangeBand.default_range']), c('Method Code', ['RangeBand.method_id']),
    c('Auto Approved Low', ['RangeBand.auto_approved_low']), c('Auto Approved High', ['RangeBand.auto_approved_high']), c('Sort Order', ['RangeBand.sort_order']),
    c('Critical Low', ['CriticalBand.low']), c('Critical High', ['CriticalBand.high']), c('Abnormal Codes', ['CriticalBand.abnormal_codes']),
  ],
  [SHEET.panels]: [
    c('Panel Code', ['PanelCreate.code'], true), c('Panel Name', ['PanelCreate.name'], true), c('Panel Kind', ['PanelCreate.panel_kind'], true), c('Sex Restriction', ['PanelCreate.sex_restriction']),
    c('Department Code', ['PanelCreate.department_id']), c('Barcode Text', ['PanelCreate.barcode_text']), c('Loyalty Points', ['PanelCreate.loyalty_points']), c('Display Order', ['PanelCreate.display_order']),
    c('Popular', ['PanelCreate.is_popular']), c('Member Kind', ['PanelMember.kind'], true), c('Member Code', ['PanelMember.orderable_id'], true), c('Member Sort Order', ['PanelMember.sort_order']),
  ],
};
export const labels = (s: DataSheet): string[] => COLUMNS[s].map((x) => x.label);
export const requiredLabels = (s: DataSheet): string[] => COLUMNS[s].filter((x) => x.required).map((x) => x.label);

/** contract properties that deliberately have NO spreadsheet column (reason each); everything else must be fed by a column above */
export const EXCLUDED: Record<string, string> = {
  'TestCreate.uses_existing_material': 'derived workflow flag, not an ElabAssist Add Test field; set in the screen',
  'TestCreate.template_ref': 'a report template reference is chosen in the template screen, not typed in Excel',
  'TestCreate.nabl_processing_centres': 'list of centre ids, set in the screen',
  'AnalyteCreate.initial_version': 'container only: its fields are the AnalyteVersionDraftInput columns of the Parameters sheet',
  'PanelCreate.members': 'container only: its fields are the PanelMember columns of the Panels sheet (one row per member)',
};
export const OPS = ['downloadCatalogImportTemplate', 'validateCatalogImport', 'commitCatalogImport', 'listCatalogImports', 'getCatalogImport', 'downloadCatalogImportErrors'] as const;
export const DATA_SHEETS: DataSheet[] = [SHEET.tests, SHEET.params, SHEET.ranges, SHEET.panels];
