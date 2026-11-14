// Import templates (02-TRD §8.2, AC-16.1): sheet Instructions, data sheets, hidden _meta. Written as a stored ZIP with inline-string
// cells: no formula cell, no macro, no external link (S-9, REQ-SEC-087); every text cell passes neutraliseFormula (08 A13 P-9).
// [CONV] relative import until @lims/shared-ts is a services/api dependency (same as core/errors.ts).
import { crc32 } from 'node:zlib';
import { neutraliseFormula } from '../../../../../../packages/shared-ts/src/spreadsheet/index.js';

export const IMPORT_KINDS = ['price_list', 'catalog_master', 'referrers', 'credit_parties'] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];
type Cell = string | number;

const DATA_SHEETS: Record<ImportKind, Record<string, string[]>> = {
  price_list: { Prices: ['orderable_code', 'orderable_kind', 'orderable_name', 'department', 'unit_price_npr'] },
  catalog_master: {
    Departments: ['code', 'name', 'report_order', 'report_heading'],
    SpecimenTypes: ['code', 'name', 'report_label'],
    Containers: ['code', 'name', 'additive', 'cap_colour_display', 'default_specimen_type_code'],
    Methods: ['code', 'name'],
    Units: ['code', 'display'],
    ValueSets: ['value_set_code', 'is_ordered', 'value_code', 'value_display', 'sort_order'],
    Tests: ['code', 'name', 'department_code', 'workflow_type', 'report_order', 'is_orderable', 'specimen_type_codes', 'container_code'],
    Analytes: ['test_code', 'analyte_code', 'name', 'print_name', 'report_subheading', 'sort_order', 'is_reportable', 'result_type', 'unit_code', 'decimals', 'method_code', 'value_set_code', 'formula'],
    ReferenceRanges: ['analyte_code', 'sex', 'age_low', 'age_low_unit', 'age_high', 'age_high_unit', 'specimen_type_code', 'kind', 'low', 'high', 'normal_codes', 'display_text'],
    CriticalLimits: ['analyte_code', 'sex', 'age_low', 'age_low_unit', 'age_high', 'age_high_unit', 'specimen_type_code', 'low', 'high', 'abnormal_codes'],
    Panels: ['code', 'name', 'panel_kind', 'sex_restriction', 'department_code'],
    PanelMembers: ['panel_code', 'member_code', 'sort_order'],
    CommentCodes: ['code', 'department_code', 'text'],
    TatTargets: ['test_code', 'priority', 'segment', 'target_minutes'],
  },
  referrers: { Doctors: ['doctor_code', 'display_name', 'qualification', 'registration_council', 'registration_no', 'phone_e164', 'email', 'is_verified'] },
  credit_parties: { CreditParties: ['party_code', 'name', 'kind', 'allows_credit', 'pan', 'contact_phone_e164', 'contact_email', 'billing_address'] },
};

const INSTRUCTIONS = [
  'Row 1 of each data sheet holds the column keys. Columns may be reordered; unknown columns are ignored with a warning.',
  'Prices are in NPR with at most 2 decimals.',
  'Do not edit the _meta sheet.',
  'Tax shown by the system is computed from the configured tax rules; this workbook does not carry tax.',
];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const col = (i: number): string => (i < 26 ? '' : col(Math.floor(i / 26) - 1)) + String.fromCharCode(65 + (i % 26));
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const RNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function sheetXml(rows: Cell[][]): string {
  const body = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
    const ref = `${col(ci)}${ri + 1}`;
    return typeof v === 'number' ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(neutraliseFormula(v))}</t></is></c>`;
  }).join('')}</row>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS}"><sheetData>${body}</sheetData></worksheet>`;
}

/** Stored (method 0) ZIP; first bytes are the local header 50 4B 03 04. */
function zip(entries: Array<[string, string]>): Uint8Array {
  const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
  const locals: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const [name, text] of entries) {
    const n = Buffer.from(name, 'utf8'); const d = Buffer.from(text, 'utf8'); const crc = crc32(d);
    const head = [u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(crc), u32(d.length), u32(d.length), u16(n.length), u16(0)];
    const local = Buffer.concat([u32(0x04034b50), ...head, n, d]);
    central.push(Buffer.concat([u32(0x02014b50), u16(20), ...head, u16(0), u16(0), u16(0), u32(0), u32(offset), n]));
    locals.push(local); offset += local.length;
  }
  const cd = Buffer.concat(central);
  return new Uint8Array(Buffer.concat([...locals, cd, u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(cd.length), u32(offset), u16(0)]));
}

/** `exportedAt` is IsoUtc; informational `_meta` keys (price_list_code, tenant_catalog_revision) are left blank (02-TRD §8.2). */
export function buildTemplate(kind: ImportKind, exportedAt: string): { fileName: string; bytes: Uint8Array } {
  const meta: Cell[][] = [['template_kind', kind], ['template_version', 1], ['tenant_catalog_revision', ''], ['exported_at', exportedAt]];
  if (kind === 'price_list') meta.push(['price_list_id', ''], ['price_list_code', ''], ['base_version_no', 0]);
  const sheets: Array<{ name: string; rows: Cell[][]; hidden?: boolean }> = [
    { name: 'Instructions', rows: INSTRUCTIONS.map((t) => [t]) },
    ...Object.entries(DATA_SHEETS[kind]).map(([name, cols]) => ({ name, rows: [cols] })),
    { name: '_meta', rows: meta, hidden: true },
  ];
  const entries: Array<[string, string]> = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RNS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${NS}" xmlns:r="${RNS}"><sheets>${sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}"${s.hidden ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${RNS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`],
    ...sheets.map((s, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.rows)]),
  ];
  return { fileName: `${kind.replace(/_/g, '-')}-template.xlsx`, bytes: zip(entries) };
}
