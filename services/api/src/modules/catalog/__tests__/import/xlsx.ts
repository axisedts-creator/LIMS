// T0B-TESTIMPORT-1 test helper: builds xlsx workbooks in code (no spreadsheet library, so the tests do not depend on the writer's library pick) and reads the template back.
// Synthetic data only. Cells: string | number | boolean | null | {f} (formula cell) ; `shared` = Excel style sharedStrings (default), false = inline strings.
import { crc32, deflateRawSync } from 'node:zlib';
import { readZip } from '../helpers/zip.js';
import { COLUMNS, DATA_SHEETS, SHEET, TEMPLATE_VERSION, type DataSheet } from './columns.js';

export type Cell = string | number | boolean | null | undefined | { f: string };
export type Row = Record<string, Cell>;
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

/** ZIP with deflate entries (so a bomb is small on the wire). */
export function zipDeflate(entries: Record<string, string | Uint8Array>, level = 6): Buffer {
  const locals: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const [name, data] of Object.entries(entries)) {
    const nameB = Buffer.from(name, 'utf8');
    const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    const comp = deflateRawSync(body, { level });
    const crc = crc32(body);
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0), u16(8), u16(0), u16(0x21), u32(crc), u32(comp.length), u32(body.length), u16(nameB.length), u16(0), nameB, comp]);
    central.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(8), u16(0), u16(0x21), u32(crc), u32(comp.length), u32(body.length), u16(nameB.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameB]));
    locals.push(local); offset += local.length;
  }
  const cd = Buffer.concat(central);
  return Buffer.concat([...locals, cd, Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(cd.length), u32(offset), u16(0)])]);
}

export const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// XML 1.0 cannot carry control chars; tests that need them put them in as numeric character references the parser must strip after decoding.
const ref = (s: string): string => esc(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, (m) => `&#${m.charCodeAt(0)};`);
export const colName = (i: number): string => { let n = i + 1; let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

export interface SheetSpec { name: string; rows: Cell[][]; state?: 'hidden' | 'veryHidden' }
export interface BuildOpts { shared?: boolean; extra?: Record<string, string | Uint8Array>; contentTypeExtra?: string; macroContentType?: boolean; relsExtra?: string; workbookExtra?: string; level?: number }

export function buildXlsx(sheets: SheetSpec[], o: BuildOpts = {}): Buffer {
  const shared = o.shared ?? true; const sst: string[] = []; const sstIx = new Map<string, number>();
  const sheetXml = (rows: Cell[][]): string => {
    const body = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
      if (v === null || v === undefined || v === '') return '';
      const a = `${colName(ci)}${ri + 1}`;
      if (typeof v === 'object') return `<c r="${a}"><f>${esc(v.f)}</f><v>0</v></c>`;
      if (typeof v === 'number') return `<c r="${a}"><v>${v}</v></c>`;
      if (typeof v === 'boolean') return `<c r="${a}" t="b"><v>${v ? 1 : 0}</v></c>`;
      if (!shared) return `<c r="${a}" t="inlineStr"><is><t xml:space="preserve">${ref(v)}</t></is></c>`;
      let ix = sstIx.get(v); if (ix === undefined) { ix = sst.length; sst.push(v); sstIx.set(v, ix); }
      return `<c r="${a}" t="s"><v>${ix}</v></c>`;
    }).join('')}</row>`).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
  };
  const files: Record<string, string | Uint8Array> = {};
  sheets.forEach((s, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(s.rows); });
  const wbCt = o.macroContentType ? 'application/vnd.ms-excel.sheet.macroEnabled.main+xml' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
  files['[Content_Types].xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${wbCt}"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}${shared ? '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' : ''}${o.contentTypeExtra ?? ''}</Types>`;
  files['_rels/.rels'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
  files['xl/workbook.xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ''} r:id="rId${i + 1}"/>`).join('')}</sheets>${o.workbookExtra ?? ''}</workbook>`;
  files['xl/_rels/workbook.xml.rels'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}${shared ? `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` : ''}${o.relsExtra ?? ''}</Relationships>`;
  if (shared) files['xl/sharedStrings.xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sst.length}" uniqueCount="${sst.length}">${sst.map((x) => `<si><t xml:space="preserve">${ref(x)}</t></si>`).join('')}</sst>`;
  return zipDeflate({ ...files, ...(o.extra ?? {}) }, o.level);
}

// ------------------------------------------------------------------------------------------------ golden workbook
export type Data = Partial<Record<DataSheet, Row[]>>;
export interface Golden { data: Record<DataSheet, Row[]>; codes: { t1: string; t2: string; panel: string; tg: string; chol: string; hdl: string; vldl: string; glu: string } }
export interface Masters { dept: string; spec: string; unit: string; valueSet: string; category?: string }

/** Row objects keyed by header label; a header the row does not name is an empty cell. */
export const toRows = (sheet: DataSheet, rows: Row[], headers = COLUMNS[sheet].map((c) => c.label)): Cell[][] => [headers, ...rows.map((r) => headers.map((h) => r[h]))];

export function metaRows(version: string = TEMPLATE_VERSION, checksum = 'a'.repeat(64)): Cell[][] { return [['template_version', version], ['checksum', checksum]]; }
export interface WbOpts extends BuildOpts { metaVersion?: string; metaChecksum?: string; noMeta?: boolean; headers?: Partial<Record<DataSheet, string[]>>; omitSheet?: DataSheet; extraSheets?: SheetSpec[] }
/** The template checksum a real template carries (read from a downloaded template) can be reused so tests do not depend on how the checksum is computed. */
export function workbook(data: Data, o: WbOpts = {}): Buffer {
  const sheets: SheetSpec[] = [{ name: SHEET.instructions, rows: [['Instructions']] }];
  for (const s of DATA_SHEETS) if (s !== o.omitSheet) sheets.push({ name: s, rows: toRows(s, data[s] ?? [], o.headers?.[s]) });
  sheets.push({ name: SHEET.lists, rows: [['x']], state: 'hidden' });
  if (!o.noMeta) sheets.push({ name: SHEET.meta, rows: metaRows(o.metaVersion, o.metaChecksum), state: 'hidden' });
  sheets.push(...(o.extraSheets ?? []));
  return buildXlsx(sheets, o);
}

/** Two tests (a lipid profile with 4 parameters and a glucose with 1), ranges for the numeric parameters, one panel of the two tests. All codes carry a random tag so reruns never collide. */
export function golden(t: string, m: Masters): Golden {
  const codes = { t1: `LIP${t}`, t2: `GLU${t}`, panel: `PNL${t}`, tg: `TG${t}`, chol: `CHOL${t}`, hdl: `HDL${t}`, vldl: `VLDL${t}`, glu: `GLUC${t}` };
  const test = (code: string, name: string, o: Row = {}): Row => ({ 'Test Code': code, 'Test Name': name, 'Department Code': m.dept, 'Specimen Code': m.spec, 'Workflow Type': 'standard', 'Report Type': 'four_column', 'Processing Type': 'local', Tags: 'syn,import', 'TAT Result Minutes': 120, 'TAT Release Minutes': 240, ...(m.category ? { 'Category Name': m.category } : {}), ...o });
  const par = (tc: string, sn: string, name: string, o: Row = {}): Row => ({ 'Test Code': tc, 'Short Name': sn, 'Parameter Name': name, 'Result Type': 'numeric', 'Unit Code': m.unit, Decimals: 1, ...o });
  const rng = (tc: string, sn: string, o: Row = {}): Row => ({ 'Test Code': tc, 'Short Name': sn, Kind: 'numeric', 'Age From': 0, 'Age From Unit': 'year', 'Age To': 150, 'Age To Unit': 'year', ...o });
  const both = (tc: string, sn: string, low: number, high: number, o: Row = {}): Row[] => (['male', 'female'] as const).map((sex, i) => rng(tc, sn, { Sex: sex, 'Normal Low': low, 'Normal High': high, 'Sort Order': i, ...o }));
  return {
    codes,
    data: {
      [SHEET.tests]: [test(codes.t1, `Synthetic Lipid Profile ${t}`), test(codes.t2, `Synthetic Glucose ${t}`)],
      [SHEET.params]: [
        par(codes.t1, codes.tg, 'Triglycerides'), par(codes.t1, codes.chol, 'Cholesterol'), par(codes.t1, codes.hdl, 'HDL'),
        par(codes.t1, codes.vldl, 'VLDL', { Equation: `${codes.tg}/5` }), par(codes.t2, codes.glu, 'Glucose'),
      ],
      [SHEET.ranges]: [
        ...both(codes.t1, codes.tg, 0, 150, { 'Critical Low': 0, 'Critical High': 0 }), ...both(codes.t1, codes.chol, 0, 200), ...both(codes.t1, codes.hdl, 40, 90),
        ...both(codes.t1, codes.vldl, 2, 30), ...both(codes.t2, codes.glu, 70, 110, { 'Critical Low': 40, 'Critical High': 450 }),
      ],
      [SHEET.panels]: [
        { 'Panel Code': codes.panel, 'Panel Name': `Synthetic Panel ${t}`, 'Panel Kind': 'clinical', 'Member Kind': 'test', 'Member Code': codes.t1, 'Member Sort Order': 0 },
        { 'Panel Code': codes.panel, 'Panel Name': `Synthetic Panel ${t}`, 'Panel Kind': 'clinical', 'Member Kind': 'test', 'Member Code': codes.t2, 'Member Sort Order': 1 },
      ],
    } as Record<DataSheet, Row[]>,
  };
}
export const GOLDEN_COUNTS = { tests: 2, analytes: 5, ranges: 10, panels: 1, errors: 0 } as const;

// ------------------------------------------------------------------------------------------------ reading a template back
export interface ReadSheet { name: string; state: string; xml: string; header: string[]; rows: string[][]; protectedSheet: boolean; validations: { sqref: string; formula1: string; type: string }[] }
const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');
export function readWorkbook(bytes: Uint8Array): { sheets: Map<string, ReadSheet>; files: Map<string, Buffer> } {
  const files = readZip(bytes); const txt = (n: string) => files.get(n)?.toString('utf8') ?? '';
  const sst = [...txt('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => unesc([...m[1]!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join('')));
  const rels = new Map([...txt('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)].map((m) => [/Id="([^"]+)"/.exec(m[0])![1]!, /Target="([^"]+)"/.exec(m[0])![1]!]));
  const sheets = new Map<string, ReadSheet>();
  for (const m of txt('xl/workbook.xml').matchAll(/<sheet\b[^>]*\/?>/g)) {
    const name = unesc(/name="([^"]*)"/.exec(m[0])![1]!); const state = /state="([^"]*)"/.exec(m[0])?.[1] ?? 'visible';
    const target = rels.get(/r:id="([^"]+)"/.exec(m[0])![1]!)!; const xml = txt(`xl/${target.replace(/^\/?(xl\/)?/, '')}`);
    const rows = [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((r) => {
      const out: string[] = [];
      for (const c of r[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ci = colIndex(/r="([A-Z]+)\d+"/.exec(c[1]!)![1]!); const t = /t="([^"]+)"/.exec(c[1]!)?.[1]; const inner = c[2] ?? '';
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1]; const is = /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/.exec(inner)?.[1];
        out[ci] = t === 's' ? sst[Number(v)] ?? '' : t === 'inlineStr' ? unesc(is ?? '') : unesc(v ?? '');
      }
      return Array.from(out, (x) => x ?? '');
    });
    const validations = [...xml.matchAll(/<dataValidation\b([^>]*)>([\s\S]*?)<\/dataValidation>/g)].map((d) => ({ sqref: /sqref="([^"]*)"/.exec(d[1]!)?.[1] ?? '', type: /type="([^"]*)"/.exec(d[1]!)?.[1] ?? '', formula1: unesc(/<formula1>([\s\S]*?)<\/formula1>/.exec(d[2]!)?.[1] ?? '') }));
    sheets.set(name, { name, state, xml, header: rows[0] ?? [], rows: rows.slice(1), protectedSheet: /<sheetProtection\b/.test(xml), validations });
  }
  return { sheets, files };
}
const colIndex = (s: string): number => [...s].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
export { colIndex };
