// T0B-TESTIMPORT-1 (LD-318, done_when 2 and 4): a minimal xlsx reader and writer on node:zlib, no spreadsheet / zip / XML dependency (choice in docs/ops/CATALOG-IMPORT.md).
// READER safety: ZIP magic, no ZIP64 / encryption / odd methods, entry count, per entry and total uncompressed caps and the expansion ratio are checked on the central
// directory BEFORE inflating, and every inflate is capped again (sizes may lie); macro, external link, embedded object and ActiveX parts and External relationships are
// refused; any DOCTYPE / ENTITY declaration is refused (no XXE, no entity expansion: only the five XML entities and numeric references are decoded); only the named
// sheets are parsed; a formula cell (<f>) anywhere in a named sheet refuses the file. Every refusal is a LimsError (problem+json), nothing is recorded.
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { LimsError } from '../../../core/errors.js';

export const MAX_FILE_BYTES = 5 * 1024 * 1024;       // contract: 5 MB
export const MAX_ROWS = 5000;                         // contract: 5000 data rows per sheet
const MAX_ENTRIES = 1000;
const MAX_ENTRY_BYTES = 40 * 1024 * 1024;            // a 5000 row sheet with every column filled is ~10 MB of XML
const MAX_TOTAL_BYTES = 120 * 1024 * 1024;
const MAX_RATIO = 200;                                // XML compresses ~10-30x; blanks or zeros far more (zip bomb)
const FORBIDDEN_PART = /(^|\/)vbaProject\.bin$|(^|\/)vbaData\.xml$|^xl\/(externalLinks|embeddings|activeX|macrosheets|dialogsheets|ctrlProps)\/|oleObject/i;

const invalid = (why: string): never => { throw new LimsError('catalog.import_invalid_file', why); };

// ------------------------------------------------------------------------------------------------ zip
interface Entry { name: string; method: number; comp: number; size: number; offset: number }
export function readZip(buf: Buffer): Map<string, Entry> {
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) invalid('not a zip container');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) invalid('zip directory missing (truncated file)');
  const count = buf.readUInt16LE(eocd + 10), cdSize = buf.readUInt32LE(eocd + 12), cdOff = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOff === 0xffffffff) invalid('zip64 is not supported');
  if (count > MAX_ENTRIES) invalid('too many zip entries');
  if (cdOff + cdSize > eocd) invalid('zip directory out of range');
  const out = new Map<string, Entry>();
  let p = cdOff, total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) invalid('zip directory damaged');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), comp = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extra = buf.readUInt16LE(p + 30), comment = buf.readUInt16LE(p + 32), offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extra + comment;
    if (flags & 1) invalid('encrypted zip entry');
    if (method !== 0 && method !== 8) invalid('unsupported zip compression');
    if (size > MAX_ENTRY_BYTES || (total += size) > MAX_TOTAL_BYTES) invalid('zip entry too large (zip bomb)');
    if (size > 1024 * 1024 && size > MAX_RATIO * Math.max(comp, 1)) invalid('zip expansion ratio too high (zip bomb)');
    if (name.includes('..') || name.startsWith('/') || out.has(name)) invalid('bad zip entry name');
    out.set(name, { name, method, comp, size, offset });
  }
  return out;
}
function inflate(buf: Buffer, e: Entry): Buffer {
  const o = e.offset;
  if (o + 30 > buf.length || buf.readUInt32LE(o) !== 0x04034b50) invalid('zip entry damaged');
  const start = o + 30 + buf.readUInt16LE(o + 26) + buf.readUInt16LE(o + 28);
  const data = buf.subarray(start, start + e.comp);
  if (data.length !== e.comp) invalid('zip entry truncated');
  let out: Buffer;
  try { out = e.method === 0 ? Buffer.from(data) : inflateRawSync(data, { maxOutputLength: Math.max(e.size, 1) }); } catch { return invalid('zip entry cannot be inflated'); }
  if (out.length !== e.size) invalid('zip entry size mismatch');
  return out;
}

// ------------------------------------------------------------------------------------------------ xml helpers
const ENT: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
export const unxml = (s: string): string => s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|lt|gt|amp|quot|apos);/g, (_, e: string) => {
  if (e[0] !== '#') return ENT[e]!;
  const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
  return n <= 0x10ffff ? String.fromCodePoint(n) : '';
});
const attr = (s: string, name: string): string | undefined => { const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(s); return m ? unxml(m[1]!) : undefined; };
const colIndex = (ref: string): number => { let n = 0; for (const ch of ref) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
const texts = (xml: string): string => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unxml(m[1]!)).join('');

/** `types` (T0B-PRICETOOLS-1, additive): per cell 's' text (shared / inline / formula string), 'n' number, 'b' boolean, 'e' error; a number cell is never a formula injection. */
export interface ReadSheet { rows: { row: number; cells: string[]; types: string[] }[]; dataRows: number }
export interface Workbook { sheets: Map<string, ReadSheet>; names: string[] }

/** Reads the named sheets of an xlsx ('*' = every sheet, so a formula in a hidden sheet refuses the file too; T0B-PRICETOOLS-1).
 *  Cells as raw strings: shared, inline, boolean 1/0, number text. File-level problems throw catalog.import_invalid_file / import_too_large. */
export function readWorkbook(bytes: Uint8Array, wanted: readonly string[] | '*'): Workbook {
  if (bytes.length > MAX_FILE_BYTES) throw new LimsError('catalog.import_too_large');
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const zip = readZip(buf);
  for (const n of zip.keys()) if (FORBIDDEN_PART.test(n)) invalid(`forbidden part ${n.slice(0, 80)}`);
  const cache = new Map<string, string>();
  const xml = (name: string): string | undefined => {
    if (cache.has(name)) return cache.get(name);
    const e = zip.get(name);
    if (!e) return undefined;
    const s = inflate(buf, e).toString('utf8');
    if (/<!DOCTYPE|<!ENTITY/i.test(s)) invalid('XML declarations (DOCTYPE / ENTITY) are not allowed');
    cache.set(name, s);
    return s;
  };
  const types = xml('[Content_Types].xml') ?? invalid('not an OOXML package');
  if (/macroEnabled|vbaProject|ms-excel\.(addin|template)/i.test(types)) invalid('macro enabled workbook');
  for (const n of zip.keys()) if (n.endsWith('.rels') && /TargetMode\s*=\s*"External"/i.test(xml(n)!)) invalid('external link');
  const root = xml('_rels/.rels') ?? invalid('package relationships missing');
  const officeDoc = [...root.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((r) => /\/officeDocument"/.test(r));
  const wbPath = (officeDoc && attr(officeDoc, 'Target')?.replace(/^\//, '')) || 'xl/workbook.xml';
  const wb = xml(wbPath) ?? invalid('workbook part missing');
  if (!/<workbook\b/.test(wb)) invalid('not a spreadsheet workbook');
  const dir = wbPath.includes('/') ? wbPath.slice(0, wbPath.lastIndexOf('/') + 1) : '';
  const relsXml = xml(`${dir}_rels/${wbPath.slice(dir.length)}.rels`) ?? '';
  const rels = new Map([...relsXml.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [attr(m[0], 'Id') ?? '', m[0]] as const));
  const target = (r: string) => { const t = attr(r, 'Target') ?? ''; return t.startsWith('/') ? t.slice(1) : dir + t; };
  const sstRel = [...rels.values()].find((r) => /\/sharedStrings"/.test(r));
  const sstXml = sstRel ? xml(target(sstRel)) ?? '' : '';
  const sst = [...sstXml.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map((m) => texts(m[1] ?? ''));

  const names: string[] = [];
  const sheets = new Map<string, ReadSheet>();
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(m[0], 'name') ?? '';
    names.push(name);
    if (wanted !== '*' && !wanted.includes(name)) continue;                                                // done_when 4: read only the named sheets
    const rel = rels.get(attr(m[0], 'r:id') ?? '');
    const sx = rel ? xml(target(rel)) : undefined;
    if (sx === undefined) invalid(`sheet ${name} has no part`);
    if (/<f[\s>/]/.test(sx!)) invalid(`a cell of sheet ${name} holds a formula`);         // a formula cell, hidden sheet or not
    sheets.set(name, parseSheet(sx!, sst));
  }
  return { sheets, names };
}

function parseSheet(xml: string, sst: readonly string[]): ReadSheet {
  const rows: { row: number; cells: string[]; types: string[] }[] = [];
  let next = 1, dataRows = 0;
  for (const r of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowNo = Number(attr(r[1]!, 'r') ?? next); next = rowNo + 1;
    const cells: string[] = []; const types: string[] = [];
    let col = 0;
    for (const c of (r[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(c[1]!, 'r'); const ci = ref ? colIndex(/^[A-Z]+/.exec(ref)?.[0] ?? 'A') : col; col = ci + 1;
      if (ci > 200) continue;                                                              // far beyond any template column
      const t = attr(c[1]!, 't'), inner = c[2] ?? '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      cells[ci] = t === 's' ? sst[Number(v)] ?? '' : t === 'inlineStr' ? texts(inner) : unxml(v ?? '');
      types[ci] = t === 's' || t === 'inlineStr' || t === 'str' ? 's' : t === 'b' ? 'b' : t === 'e' ? 'e' : 'n';
    }
    const filled = Array.from(cells, (x) => x ?? '');
    if (rowNo > 1 && filled.some((x) => x.trim() !== '')) dataRows++;
    if (dataRows > MAX_ROWS) throw new LimsError('catalog.import_too_large');
    rows.push({ row: rowNo, cells: filled, types: Array.from(types, (x) => x ?? 's') });
  }
  return { rows, dataRows };
}

// ------------------------------------------------------------------------------------------------ writer
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
export const colName = (i: number): string => { let n = i + 1, s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

export interface OutSheet { name: string; rows: string[][]; state?: 'hidden' | 'veryHidden'; protect?: boolean; inputCols?: number; validations?: { col: number; formula: string }[] }

/** xlsx with inline strings only: style 0 locked, 1 unlocked input, 2 bold locked header. No formula is ever written (data validation lists are not cell formulas). */
export function writeWorkbook(sheets: readonly OutSheet[]): Buffer {
  const files: Record<string, string> = {};
  sheets.forEach((s, i) => {
    const body = s.rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) =>
      `<c r="${colName(ci)}${ri + 1}" t="inlineStr"${s.protect && ri === 0 ? ' s="2"' : ''}><is><t xml:space="preserve">${esc(v)}</t></is></c>`).join('')}</row>`).join('');
    const cols = s.inputCols ? `<cols><col min="1" max="${s.inputCols}" width="22" style="1" customWidth="1"/></cols>` : '';
    const prot = s.protect ? '<sheetProtection sheet="1" objects="1" scenarios="1" formatCells="0" formatColumns="0" formatRows="0" insertRows="0" deleteRows="0" sort="0" autoFilter="0"/>' : '';
    const dv = s.validations?.length ? `<dataValidations count="${s.validations.length}">${s.validations.map((v) =>
      `<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="${colName(v.col)}2:${colName(v.col)}${MAX_ROWS + 1}"><formula1>${esc(v.formula)}</formula1></dataValidation>`).join('')}</dataValidations>` : '';
    files[`xl/worksheets/sheet${i + 1}.xml`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${body}</sheetData>${prot}${dv}</worksheet>`;
  });
  files['[Content_Types].xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`;
  files['_rels/.rels'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
  files['xl/workbook.xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ''} r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`;
  files['xl/_rels/workbook.xml.rels'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  files['xl/styles.xml'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyProtection="1"><protection locked="0"/></xf><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyProtection="1"><protection locked="1"/></xf></cellXfs></styleSheet>';
  return zip(files);
}

function zip(entries: Record<string, string>): Buffer {
  const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(entries)) {
    const nameB = Buffer.from(name, 'utf8'), body = Buffer.from(data, 'utf8'), comp = deflateRawSync(body), crc = crc32(body);
    const head = [u16(20), u16(0x0800), u16(8), u16(0), u16(0x21), u32(crc), u32(comp.length), u32(body.length), u16(nameB.length), u16(0)];
    const local = Buffer.concat([u32(0x04034b50), ...head, nameB, comp]);
    central.push(Buffer.concat([u32(0x02014b50), u16(20), ...head, u16(0), u16(0), u16(0), u32(0), u32(offset), nameB]));
    locals.push(local); offset += local.length;
  }
  const cd = Buffer.concat(central);
  return Buffer.concat([...locals, cd, u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(cd.length), u32(offset), u16(0)]);
}
