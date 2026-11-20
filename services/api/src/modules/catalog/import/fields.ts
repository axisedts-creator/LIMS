// T0B-TESTIMPORT-1 (LD-318; founder 2026-11-17 08:58 NPT: "excel file ... exactly same fields like form"). ONE field list drives the template (headers, dropdowns,
// instructions), the parser (header check, cell types) and the validator, so the template and the forms cannot drift; __tests__/import/columns.ts pins the same labels
// and static.test.ts proves they cover every property of TestCreate / AnalyteCreate / AnalyteVersionDraftInput / RangeBand / CriticalBand / PanelCreate / PanelMember.
// Enum values are copied from contracts/openapi/catalog.yaml (and the services that enforce them); masters are resolved per tenant at upload time.
import { createHash } from 'node:crypto';
import { RESULT_TYPES } from '../service/masters.service.js';

export const TEMPLATE_VERSION = '1';
export const SHEET = { instructions: 'Instructions', tests: 'Tests', params: 'Parameters', ranges: 'Reference Ranges', panels: 'Panels', lists: 'Lists', meta: 'Meta' } as const;
export type DataSheet = typeof SHEET.tests | typeof SHEET.params | typeof SHEET.ranges | typeof SHEET.panels;
export const DATA_SHEETS: readonly DataSheet[] = [SHEET.tests, SHEET.params, SHEET.ranges, SHEET.panels];

export type Master = 'department' | 'category' | 'specimen' | 'unit' | 'method' | 'valueSet' | 'instrument' | 'laboratory';
export type Kind =
  | { t: 'text'; max: number; min?: number }
  | { t: 'code' }                                   // a code of this file / the catalog (format checked by the validator)
  | { t: 'int'; min: number; max: number }
  | { t: 'dec' }
  | { t: 'bool' }
  | { t: 'enum'; values: readonly string[]; list: string }
  | { t: 'master'; master: Master; list: string }
  | { t: 'list'; itemMax: number; maxItems: number; codes?: boolean };   // comma separated
export interface FieldDef { label: string; key: string; kind: Kind; required?: boolean; help: string }

const WORKFLOW = ['standard', 'narrative', 'microbiology', 'anatomic', 'molecular', 'attachment', 'outsourced'];
const REPORT = ['four_column', 'three_column', 'two_column', 'graph', 'template_based_html', 'micro_automated', 'cbc_four_column', 'micro_manual', 'histo', 'four_column_10_font'];
const PROCESSING = ['local', 'branch_transfer', 'outsource_branch'];
const DISPLAY = ['table', 'note_value_only', 'list_note', 'one_column', 'two_column', 'three_column', 'four_column', 'comment', 'hidden', 'table_with_subheader', 'merge_two_column'];
export const SEXES = ['any', 'male', 'female', 'third_gender'];
const AGE_UNITS = ['hour', 'day', 'week', 'month', 'year'];
const BAND_KINDS = ['numeric', 'text', 'ordinal'];
const PANEL_KINDS = ['clinical', 'package'];
const PANEL_SEX = ['male', 'female'];
const MEMBER_KINDS = ['test', 'panel'];
export const STAGES = ['registration', 'sample_collection', 'accession', 'result', 'approval_1', 'approval_2', 'release'];

const text = (max: number, min?: number): Kind => ({ t: 'text', max, ...(min ? { min } : {}) });
const int = (min: number, max: number): Kind => ({ t: 'int', min, max });
const bool: Kind = { t: 'bool' };
const dec: Kind = { t: 'dec' };
const code: Kind = { t: 'code' };
const en = (list: string, values: readonly string[]): Kind => ({ t: 'enum', values, list });
const ms = (master: Master, list: string): Kind => ({ t: 'master', master, list });
const f = (label: string, key: string, kind: Kind, help: string, required = false): FieldDef => ({ label, key, kind, help, ...(required ? { required } : {}) });

const TAT = STAGES.map((s) => f(`TAT ${s.split('_').map((w) => (/^\d+$/.test(w) ? w : w[0]!.toUpperCase() + w.slice(1))).join(' ')} Minutes`, `tat_${s}`, int(0, 43200), `Target minutes of the ${s.replace('_', ' ')} stage (0 to 43200)`));
const flag = (label: string, key: string) => f(label, key, bool, 'yes or no');

export const FIELDS: Readonly<Record<DataSheet, readonly FieldDef[]>> = {
  [SHEET.tests]: [
    f('Test Code', 'code', code, 'Unique test code (letters, digits, _ - + .), at most 32 characters', true),
    f('Test Name', 'name', text(200), 'Name of the test', true),
    f('Short Name', 'short_name', text(60), 'Short name'),
    f('Display Name', 'display_name', text(300, 3), 'Display name, for example NAME, SPECIMEN(CODE)'),
    f('Department Code', 'department', ms('department', 'Departments'), 'Department code from the masters', true),
    f('Category Name', 'category', ms('category', 'Categories'), 'Test category name from the masters'),
    f('Specimen Code', 'specimen', ms('specimen', 'Specimen Types'), 'Preferred specimen type code', true),
    f('Workflow Type', 'workflow_type', en('Workflow Types', WORKFLOW), 'Workflow type', true),
    f('Report Type', 'report_type', en('Report Types', REPORT), 'Report type'),
    f('Processing Type', 'processing_type', en('Processing Types', PROCESSING), 'Local, branch transfer or outsource to another branch'),
    f('Tags', 'tags', { t: 'list', itemMax: 60, maxItems: 20 }, 'Comma separated tags (needed when any display field is filled)'),
    f('Barcode Text', 'barcode_text', text(64), 'Text printed on the barcode'),
    f('Loyalty Points', 'loyalty_points', int(0, 1_000_000), 'Whole number 0 to 1000000'),
    f('Display Order', 'display_order', int(0, 9999), 'Whole number 0 to 9999'),
    f('Report Order', 'report_order', int(0, 9999), 'Whole number 0 to 9999'),
    f('Description', 'description', text(2000), 'Description'),
    f('Outsource Name', 'outsource_name', text(200), 'Name of the outsourcing laboratory'),
    flag('Orderable', 'is_orderable'), flag('Outsourced', 'is_outsourced'), flag('Popular', 'is_popular'), flag('Smart Report', 'smart_report'),
    flag('Print Category Wise', 'print_category_wise'), flag('NABL', 'nabl'), flag('ACCAB Logo', 'accab_logo'), flag('Auto Approval', 'auto_approval_enabled'),
    flag('Use Normal Range For Auto Approval', 'use_normal_range_for_auto_approval'), flag('Template Test', 'template_test'),
    f('Font', 'font', text(60), 'Font name'),
    f('Alert Before Expiry Minutes', 'alert_before_expiry_minutes', int(0, 525600), 'Whole number 0 to 525600'),
    ...TAT,
  ],
  [SHEET.params]: [
    f('Test Code', 'test_code', code, 'Test Code of a row of the Tests sheet', true),
    f('Short Name', 'code', code, 'Parameter short name = analyte code (a letter, then letters, digits or _), unique', true),
    f('Parameter Name', 'name', text(120), 'Name of the parameter', true),
    f('Print Name', 'print_name', text(120), 'Name printed on the report'),
    f('Report Subheading', 'report_subheading', text(80), 'Subheading on the report'),
    f('Sort Order', 'sort_order', int(0, 9999), 'Whole number 0 to 9999 (default: row order)'),
    flag('Reportable', 'is_reportable'),
    f('Trend Name', 'trend_name', text(120), 'Name in trend charts'),
    f('Specimen Code', 'specimen', ms('specimen', 'Specimen Types'), 'Specimen type code'),
    f('Font', 'font', text(60), 'Font name'),
    f('Result Display Type', 'result_display_type', en('Result Display Types', DISPLAY), 'How the result is displayed'),
    flag('Print On Negative', 'print_on_negative'), flag('Print On Worksheet', 'print_on_worksheet'), flag('Send In SMS', 'send_in_sms'),
    flag('NABL', 'nabl'), flag('ACCAB Logo', 'accab_logo'), flag('Is Trend', 'is_trend'),
    f('Result Type', 'result_type', en('Result Types', RESULT_TYPES), 'numeric (Integer, Float, Equation), coded (List), text, narrative, ...', true),
    f('Unit Code', 'unit', ms('unit', 'Units'), 'Unit code from the masters'),
    f('Decimals', 'decimals', int(0, 6), 'Decimals 0 to 6 (required for numeric)'),
    f('Method Code', 'method', ms('method', 'Methods'), 'Method code from the masters'),
    f('Value Set Code', 'value_set_code', ms('valueSet', 'Value Sets'), 'Value set of a coded or ordinal (List) parameter'),
    f('Equation', 'formula_expression', text(500), 'Expression over the Short Names of other parameters of the same test, for example TG/5'),
    f('Default Value', 'default_value', text(500), 'Default value'),
    f('Long Text Value', 'long_text_value', text(20000), 'Long text value'),
    f('High Low', 'high_low', dec, 'Decimal number'),
    flag('Require Verification', 'require_verification'),
  ],
  [SHEET.ranges]: [
    f('Test Code', 'test_code', code, 'Test Code of a row of the Tests sheet', true),
    f('Short Name', 'param', code, 'Short Name of a parameter of that test on the Parameters sheet', true),
    f('Instrument Code', 'instrument', ms('instrument', 'Instruments'), 'Instrument specific range (instrument code)'),
    f('Laboratory Code', 'laboratory', ms('laboratory', 'Laboratories'), 'Laboratory specific range (laboratory code)'),
    f('Sex', 'sex', en('Sexes', SEXES), 'any, male, female or third_gender', true),
    f('Age From', 'age_from', int(0, 200), 'Whole number 0 to 200'),
    f('Age From Unit', 'age_from_unit', en('Age Units', AGE_UNITS), 'hour, day, week, month or year'),
    f('Age To', 'age_to', int(1, 200), 'Whole number 1 to 200 (exclusive)'),
    f('Age To Unit', 'age_to_unit', en('Age Units', AGE_UNITS), 'hour, day, week, month or year'),
    f('Specimen Code', 'specimen', ms('specimen', 'Specimen Types'), 'Specimen specific range'),
    f('Kind', 'kind', en('Range Kinds', BAND_KINDS), 'numeric, text or ordinal', true),
    f('Normal Low', 'low', dec, 'Decimal number'),
    f('Normal High', 'high', dec, 'Decimal number'),
    f('Normal Codes', 'normal_codes', { t: 'list', itemMax: 16, maxItems: 20, codes: true }, 'Comma separated value codes (ordinal)'),
    f('Display Text', 'display_text', text(500), 'Range text shown on the report'),
    flag('Default Range', 'default_range'),
    f('Method Code', 'method', ms('method', 'Methods'), 'Method specific range'),
    f('Auto Approved Low', 'auto_approved_low', dec, 'Decimal number inside the normal range'),
    f('Auto Approved High', 'auto_approved_high', dec, 'Decimal number inside the normal range'),
    f('Sort Order', 'sort_order', int(0, 9999), 'Whole number 0 to 9999 (default: row order)'),
    f('Critical Low', 'critical_low', dec, 'Decimal below the normal low (0 and 0 = no critical limits)'),
    f('Critical High', 'critical_high', dec, 'Decimal above the normal high'),
    f('Abnormal Codes', 'abnormal_codes', { t: 'list', itemMax: 16, maxItems: 20, codes: true }, 'Comma separated critical value codes'),
  ],
  [SHEET.panels]: [
    f('Panel Code', 'code', code, 'Unique profile or package code; one row per member, repeat the panel columns', true),
    f('Panel Name', 'name', text(200), 'Name of the profile or package', true),
    f('Panel Kind', 'panel_kind', en('Panel Kinds', PANEL_KINDS), 'clinical (profile) or package', true),
    f('Sex Restriction', 'sex_restriction', en('Panel Sexes', PANEL_SEX), 'male or female'),
    f('Department Code', 'department', ms('department', 'Departments'), 'Department code from the masters'),
    f('Barcode Text', 'barcode_text', text(64), 'Text printed on the barcode'),
    f('Loyalty Points', 'loyalty_points', int(0, 1_000_000), 'Whole number 0 to 1000000'),
    f('Display Order', 'display_order', int(0, 9999), 'Whole number 0 to 9999'),
    flag('Popular', 'is_popular'),
    f('Member Kind', 'member_kind', en('Member Kinds', MEMBER_KINDS), 'test or panel', true),
    f('Member Code', 'member_code', code, 'Code of a test or panel of this file or of the catalog', true),
    f('Member Sort Order', 'member_sort_order', int(0, 9999), 'Whole number 0 to 9999 (default: row order)'),
  ],
};
export const labels = (s: DataSheet): string[] => FIELDS[s].map((x) => x.label);

/** Checksum of the template definition (version + every header), the same for every tenant; Meta carries it so a hand-made or older layout is refused. */
export const TEMPLATE_CHECKSUM = createHash('sha256').update(JSON.stringify([TEMPLATE_VERSION, DATA_SHEETS.map((s) => [s, labels(s)])])).digest('hex');
export const ERRORS_HEADER = 'Errors';   // the errors file adds it after the last column; an upload may carry it (ignored) so a fixed errors file validates again
