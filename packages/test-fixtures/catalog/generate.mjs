// Generates starter_catalog_master.xlsx + starter_price_list.xlsx (C0 02-TRD §3.5 `catalog/`; 08 A13 D-17, CR-C3-007).
// Columns: C3 02-TRD §8.2. Content: C3 05-SCHEMA §8 (synthetic tenant A). Regenerate, never hand-edit:
//   node packages/test-fixtures/catalog/generate.mjs [--out <dir>]
// Output is byte-deterministic (stored zip entries, fixed timestamps). Every text cell passes neutraliseFormula
// (08 R12e); numbers are number cells; no formula cells. Values are SYNTHETIC, not clinical reference values.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { neutraliseFormula } from '../../shared-ts/src/spreadsheet/index.ts';
import { parseFormula } from '../../shared-ts/src/formula/index.ts';

// ---------- content ----------
const SYN = 'SYNTHETIC test data for non-production tenants only. Every value in this workbook is SYNTHETIC and is not a clinical reference value.';
const COMMON_HELP = ['Header row = row 1; exact lower-snake column keys; columns may be reordered.', 'Prices in NPR with at most 2 decimals.',
  'Do not edit _meta.', 'Tax shown here is synthetic and is not a tax position.'];
const sheet = (name, header, rows, hidden = false) => ({ name, rows: [header, ...rows], hidden });
const instructions = (lines) => sheet('Instructions', ['instructions'], [[SYN], ...lines.map((l) => [l])]);
const meta = (kind, extra) => sheet('_meta', ['key', 'value'],
  [['template_kind', kind], ['template_version', 1], ['tenant_catalog_revision', ''], ['exported_at', ''], ...extra], true);

const AGE = (lo, loU, hi, hiU) => [lo, loU, hi, hiU];
const ANY = AGE('', '', '', '');

const master = [
  instructions([...COMMON_HELP, 'catalog_master: each sheet upserts by code; blank optional cells mean "no value".',
    'specimen_type_codes and normal_codes are ";"-separated; preferred specimen type first.']),
  meta('catalog_master', []),
  sheet('Departments', ['code', 'name', 'report_order', 'report_heading'], [
    ['HAEM', 'Haematology', 10, 'HAEMATOLOGY'], ['BIOCHEM', 'Biochemistry', 20, 'BIOCHEMISTRY'],
    ['CLINPATH', 'Clinical Pathology', 30, 'CLINICAL PATHOLOGY'], ['MICRO', 'Microbiology', 40, 'MICROBIOLOGY']]),
  sheet('SpecimenTypes', ['code', 'name', 'report_label'], [
    ['EDTA_WB', 'EDTA Whole Blood', 'EDTA WHOLE BLOOD'], ['SERUM', 'Serum', 'SERUM'],
    ['FL_PLASMA', 'Fluoride Plasma', 'FASTING PLASMA FL.'], ['URINE', 'Urine', 'URINE']]),
  sheet('Containers', ['code', 'name', 'additive', 'cap_colour_display', 'default_specimen_type_code'], [
    ['EDTA_TUBE', 'EDTA tube', 'K2 EDTA', 'Lavender', 'EDTA_WB'], ['PLAIN_TUBE', 'Plain tube', 'Clot activator', 'Red', 'SERUM'],
    ['FL_TUBE', 'Fluoride tube', 'Sodium fluoride', 'Grey', 'FL_PLASMA'], ['URINE_CUP', 'Urine container', '', 'White', 'URINE']]),
  sheet('Methods', ['code', 'name'], [
    ['AUTO_HAEM', 'Automated haematology analyser'], ['CALC', 'Calculated'], ['PHOTO', 'Photometry'],
    ['ISE', 'Ion selective electrode'], ['DIPSTICK', 'Reagent strip'], ['HPLC', 'HPLC'], ['CULTURE', 'Culture']]),
  sheet('Units', ['code', 'display'], [
    ['g_dl', 'g/dL'], ['pct', '%'], ['fl', 'fL'], ['pg', 'pg'], ['x10e3_ul', '10^3/µL'], ['x10e6_ul', '10^6/µL'],
    ['mg_dl', 'mg/dL'], ['mmol_l', 'mmol/L'], ['ratio', 'ratio'], ['none', '']]),
  sheet('ValueSets', ['value_set_code', 'is_ordered', 'value_code', 'value_display', 'sort_order'], [
    ['URINE_SEMIQ', 'Y', 'NEG', 'Negative', 1], ['URINE_SEMIQ', 'Y', 'TRACE', 'Trace', 2], ['URINE_SEMIQ', 'Y', '1+', '1+', 3],
    ['URINE_SEMIQ', 'Y', '2+', '2+', 4], ['URINE_SEMIQ', 'Y', '3+', '3+', 5], ['URINE_SEMIQ', 'Y', '4+', '4+', 6],
    ['POS_NEG', 'N', 'NEG', 'Negative', 1], ['POS_NEG', 'N', 'POS', 'Positive', 2]]),
  sheet('Tests', ['code', 'name', 'department_code', 'workflow_type', 'report_order', 'is_orderable', 'specimen_type_codes', 'container_code'], [
    ['CBC', 'Complete Blood Count', 'HAEM', 'standard', 10, 'Y', 'EDTA_WB', 'EDTA_TUBE'],
    ['HBA1C', 'HbA1c', 'BIOCHEM', 'attachment', 20, 'Y', 'EDTA_WB', 'EDTA_TUBE'],
    ['CHOL', 'Total Cholesterol', 'BIOCHEM', 'standard', 30, 'Y', 'SERUM', 'PLAIN_TUBE'],
    ['HDL', 'HDL Cholesterol', 'BIOCHEM', 'standard', 31, 'Y', 'SERUM', 'PLAIN_TUBE'],
    ['TG', 'Triglycerides', 'BIOCHEM', 'standard', 32, 'Y', 'SERUM', 'PLAIN_TUBE'],
    ['LDL', 'LDL Cholesterol (calculated)', 'BIOCHEM', 'standard', 33, 'N', 'SERUM', 'PLAIN_TUBE'],
    ['FBS', 'Fasting Blood Sugar', 'BIOCHEM', 'standard', 40, 'Y', 'FL_PLASMA;SERUM', 'FL_TUBE'],
    ['K', 'Potassium', 'BIOCHEM', 'standard', 50, 'Y', 'SERUM', 'PLAIN_TUBE'],
    ['URINE_RE', 'Urine Routine Examination', 'CLINPATH', 'standard', 60, 'Y', 'URINE', 'URINE_CUP'],
    ['URINE_CS', 'Urine Culture', 'MICRO', 'microbiology', 70, 'Y', 'URINE', 'URINE_CUP']]),
  sheet('Analytes', ['test_code', 'analyte_code', 'name', 'print_name', 'report_subheading', 'sort_order', 'is_reportable',
    'result_type', 'unit_code', 'decimals', 'method_code', 'value_set_code', 'formula'], [
    ['CBC', 'HB', 'Haemoglobin', 'Haemoglobin', 'RED CELLS', 10, 'Y', 'numeric', 'g_dl', 1, 'AUTO_HAEM', '', ''],
    ['CBC', 'RBC', 'Red Blood Cell Count', 'RBC Count', 'RED CELLS', 20, 'Y', 'numeric', 'x10e6_ul', 2, 'AUTO_HAEM', '', ''],
    ['CBC', 'MCV', 'Mean Corpuscular Volume', 'MCV', 'RED CELLS', 30, 'Y', 'numeric', 'fl', 1, 'AUTO_HAEM', '', ''],
    ['CBC', 'MENTZER', 'Mentzer Index', 'Mentzer Index', 'RED CELLS', 40, 'Y', 'numeric', 'none', 1, 'CALC', '', 'MCV / RBC'],
    ['CBC', 'MENTZER_BAND', 'Mentzer Interpretation', 'Mentzer Interpretation', 'RED CELLS', 41, 'Y', 'text', '', '', 'CALC', '', ''],
    ['CBC', 'WBC', 'Total Leucocyte Count', 'TLC', 'WHITE CELLS', 50, 'Y', 'numeric', 'x10e3_ul', 2, 'AUTO_HAEM', '', ''],
    ['CBC', 'NEUT_PCT', 'Neutrophils', 'Neutrophils', 'WHITE CELLS', 60, 'Y', 'numeric', 'pct', 0, 'AUTO_HAEM', '', ''],
    ['CBC', 'LYMPH_PCT', 'Lymphocytes', 'Lymphocytes', 'WHITE CELLS', 70, 'Y', 'numeric', 'pct', 0, 'AUTO_HAEM', '', ''],
    ['CBC', 'NEUT_ABS', 'Absolute Neutrophil Count', 'Absolute Neutrophils', 'WHITE CELLS', 80, 'Y', 'numeric', 'x10e3_ul', 2, 'CALC', '', 'WBC * NEUT_PCT / 100'],
    ['CBC', 'LYMPH_ABS', 'Absolute Lymphocyte Count', 'Absolute Lymphocytes', 'WHITE CELLS', 90, 'Y', 'numeric', 'x10e3_ul', 2, 'CALC', '', 'WBC * LYMPH_PCT / 100'],
    ['CBC', 'NLR', 'Neutrophil Lymphocyte Ratio', 'NLR', 'WHITE CELLS', 100, 'Y', 'numeric', 'ratio', 2, 'CALC', '', 'NEUT_ABS / LYMPH_ABS'],
    ['CBC', 'PLT', 'Platelet Count', 'Platelets', 'PLATELETS', 110, 'Y', 'numeric', 'x10e3_ul', 0, 'AUTO_HAEM', '', ''],
    ['CBC', 'PLR', 'Platelet Lymphocyte Ratio', 'PLR', 'PLATELETS', 120, 'Y', 'numeric', 'ratio', 1, 'CALC', '', 'PLT / LYMPH_ABS'],
    ['HBA1C', 'HBA1C', 'HbA1c', 'HbA1c', '', 10, 'Y', 'numeric', 'pct', 1, 'HPLC', '', ''],
    ['HBA1C', 'HBA1C_CHROM', 'HbA1c Chromatogram', 'Chromatogram', '', 20, 'Y', 'attachment', '', '', 'HPLC', '', ''],
    ['CHOL', 'CHOL', 'Total Cholesterol', 'Total Cholesterol', '', 10, 'Y', 'numeric', 'mg_dl', 0, 'PHOTO', '', ''],
    ['HDL', 'HDL', 'HDL Cholesterol', 'HDL Cholesterol', '', 10, 'Y', 'numeric', 'mg_dl', 0, 'PHOTO', '', ''],
    ['TG', 'TG', 'Triglycerides', 'Triglycerides', '', 10, 'Y', 'numeric', 'mg_dl', 0, 'PHOTO', '', ''],
    ['LDL', 'LDL', 'LDL Cholesterol', 'LDL Cholesterol', '', 10, 'Y', 'numeric', 'mg_dl', 0, 'CALC', '', 'if(TG > 400, invalid("tg_over_400"), CHOL - HDL - TG / 5)'],
    ['FBS', 'FBS', 'Fasting Blood Sugar', 'Fasting Blood Sugar', '', 10, 'Y', 'numeric', 'mg_dl', 0, 'PHOTO', '', ''],
    ['K', 'K', 'Potassium', 'Potassium', '', 10, 'Y', 'numeric', 'mmol_l', 1, 'ISE', '', ''],
    ['URINE_RE', 'U_PROTEIN', 'Urine Protein', 'Protein', 'CHEMICAL', 10, 'Y', 'ordinal', '', '', 'DIPSTICK', 'URINE_SEMIQ', ''],
    ['URINE_RE', 'U_NITRITE', 'Urine Nitrite', 'Nitrite', 'CHEMICAL', 20, 'Y', 'ordinal', '', '', 'DIPSTICK', 'POS_NEG', ''],
    ['URINE_CS', 'U_CULTURE', 'Culture Report', 'Culture Report', '', 10, 'Y', 'narrative', '', '', 'CULTURE', '', '']]),
  sheet('ReferenceRanges', ['analyte_code', 'sex', 'age_low', 'age_low_unit', 'age_high', 'age_high_unit', 'specimen_type_code',
    'kind', 'low', 'high', 'normal_codes', 'display_text'], [
    ['HB', 'any', ...AGE(0, 'day', 1, 'day'), 'EDTA_WB', 'numeric', 14, 22, '', ''],
    ['HB', 'any', ...AGE(1, 'day', 12, 'year'), 'EDTA_WB', 'numeric', 11, 15, '', ''],
    ['HB', 'male', ...AGE(12, 'year', '', ''), 'EDTA_WB', 'numeric', 13, 17, '', ''],
    ['HB', 'female', ...AGE(12, 'year', '', ''), 'EDTA_WB', 'numeric', 12, 15, '', ''],
    ['MENTZER_BAND', 'any', ...ANY, 'EDTA_WB', 'text', '', '', '', 'Index above 13 suggests iron deficiency (SYNTHETIC)'],
    ['K', 'any', ...ANY, 'SERUM', 'numeric', 3.5, 5.1, '', ''],
    ['U_PROTEIN', 'any', ...ANY, 'URINE', 'ordinal', '', '', 'NEG;TRACE', ''],
    ['U_NITRITE', 'any', ...ANY, 'URINE', 'ordinal', '', '', 'NEG', '']]),
  sheet('CriticalLimits', ['analyte_code', 'sex', 'age_low', 'age_low_unit', 'age_high', 'age_high_unit', 'specimen_type_code',
    'low', 'high', 'abnormal_codes'], [
    ['K', 'any', ...ANY, 'SERUM', 2.8, 6.2, '']]),
  sheet('Panels', ['code', 'name', 'panel_kind', 'sex_restriction', 'department_code'], [
    ['LIPID', 'Lipid Profile', 'clinical', '', 'BIOCHEM'],
    ['HP_ELITE_M', 'Health Package Elite (Male)', 'package', 'male', '']]),
  sheet('PanelMembers', ['panel_code', 'member_code', 'sort_order'], [
    ['LIPID', 'CHOL', 1], ['LIPID', 'HDL', 2], ['LIPID', 'TG', 3], ['LIPID', 'LDL', 4],
    ['HP_ELITE_M', 'CBC', 1], ['HP_ELITE_M', 'LIPID', 2], ['HP_ELITE_M', 'FBS', 3], ['HP_ELITE_M', 'URINE_RE', 4]]),
  sheet('CommentCodes', ['code', 'department_code', 'text'], [
    ['HAEM_CLOT', 'HAEM', 'Sample clotted, repeat advised (SYNTHETIC).'],
    ['GEN_HAEMOLYSED', '', 'Sample haemolysed (SYNTHETIC).']]),
  sheet('TatTargets', ['test_code', 'priority', 'segment', 'target_minutes'], [
    ['CBC', 'routine', 'within_lab', 120], ['CBC', 'urgent', 'within_lab', 60], ['K', 'urgent', 'total', 90]]),
];

const price = [
  instructions([...COMMON_HELP, 'price_list: the Prices sheet is the complete content of the new version.']),
  // [CONV] synthetic default price list id of tenant A (same id family as packages/test-fixtures/src/tenants).
  meta('price_list', [['price_list_id', '01a1a98a-ac40-7000-8000-00000000a401'], ['price_list_code', 'DEFAULT'], ['base_version_no', 0]]),
  sheet('Prices', ['orderable_code', 'orderable_kind', 'orderable_name', 'department', 'unit_price_npr'], [
    ['CBC', 'test', 'Complete Blood Count', 'HAEM', 500], ['HBA1C', 'test', 'HbA1c', 'BIOCHEM', 1200],
    ['CHOL', 'test', 'Total Cholesterol', 'BIOCHEM', 300], ['HDL', 'test', 'HDL Cholesterol', 'BIOCHEM', 350],
    ['TG', 'test', 'Triglycerides', 'BIOCHEM', 300], ['FBS', 'test', 'Fasting Blood Sugar', 'BIOCHEM', 150],
    ['K', 'test', 'Potassium', 'BIOCHEM', 250.5], ['URINE_RE', 'test', 'Urine Routine Examination', 'CLINPATH', 200],
    ['URINE_CS', 'test', 'Urine Culture', 'MICRO', 900], ['LIPID', 'panel', 'Lipid Profile', 'BIOCHEM', 800],
    ['HP_ELITE_M', 'panel', 'Health Package Elite (Male)', '', 2500]]),
];

// Self-check: every formula parses with the program's one parser (02-TRD §3.1).
for (const row of master.find((s) => s.name === 'Analytes').rows.slice(1)) {
  const f = row[12];
  if (f && parseFormula(f).errors.length) throw new Error(`bad formula for ${row[1]}: ${f}`);
}

// ---------- xlsx writer ----------
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const col = (i) => (i < 26 ? '' : String.fromCharCode(64 + Math.floor(i / 26))) + String.fromCharCode(65 + (i % 26));
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = 'http://schemas.openxmlformats.org';

function cell(v, ref) {
  if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
  if (v === '') return '';
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(neutraliseFormula(v))}</t></is></c>`;
}

function sheetXml(rows) {
  const body = rows.map((r, i) => `<row r="${i + 1}">${r.map((v, j) => cell(v, `${col(j)}${i + 1}`)).join('')}</row>`).join('');
  return `${XML}<worksheet xmlns="${NS}/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

function workbookEntries(sheets) {
  const e = [];
  e.push(['[Content_Types].xml', `${XML}<Types xmlns="${NS}/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
    + `<Default Extension="xml" ContentType="application/xml"/>`
    + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
    + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
    + '</Types>']);
  e.push(['_rels/.rels', `${XML}<Relationships xmlns="${NS}/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="${NS}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`]);
  e.push(['xl/workbook.xml', `${XML}<workbook xmlns="${NS}/spreadsheetml/2006/main" xmlns:r="${NS}/officeDocument/2006/relationships"><sheets>`
    + sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}"${s.hidden ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`).join('')
    + '</sheets></workbook>']);
  e.push(['xl/_rels/workbook.xml.rels', `${XML}<Relationships xmlns="${NS}/package/2006/relationships">`
    + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + '</Relationships>']);
  sheets.forEach((s, i) => e.push([`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.rows)]));
  return e;
}

/** Stored (method 0) zip; DOS time 1980-01-01 00:00 so bytes never depend on the clock. */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let off = 0;
  for (const [name, text] of entries) {
    const n = Buffer.from(name, 'utf8');
    const data = Buffer.from(text, 'utf8');
    const crc = crc32(data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(0, 8);
    h.writeUInt16LE(0, 10); h.writeUInt16LE(0x21, 12); h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26); h.writeUInt16LE(0, 28);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(0, 10); c.writeUInt16LE(0, 12); c.writeUInt16LE(0x21, 14); c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(off, 42);
    locals.push(h, n, data);
    centrals.push(c, n);
    off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ---------- main ----------
const args = process.argv.slice(2);
const i = args.indexOf('--out');
const out = i >= 0 && args[i + 1] ? args[i + 1] : fileURLToPath(new URL('.', import.meta.url));
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'starter_catalog_master.xlsx'), zip(workbookEntries(master)));
writeFileSync(join(out, 'starter_price_list.xlsx'), zip(workbookEntries(price)));
