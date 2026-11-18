// XLSX export (02-TRD §10.2 step 6; PRD US-17.1/17.2/17.3): sheet "Report" (labels row + rows) and sheet "About" (the header block).
// write-excel-file 4.1.1 (node entry). Every text cell passes the shared neutraliseFormula; counts/paisa/seconds/bp are real numbers.
import { crc32 } from 'node:zlib';
import writeXlsxFile from 'write-excel-file/node';
import { neutraliseFormula } from '../../../../../../packages/shared-ts/src/spreadsheet/index.js';
import { headerLines, numericCell, withNprColumns, type ExportTable } from './layout.js';

const XML_BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g; // not allowed in XML 1.0: would corrupt the workbook
const MAX_CELL = 32_767; // Excel's cell text limit
const text = (s: string): string => neutraliseFormula(s.replace(XML_BAD, '')).slice(0, MAX_CELL);

export async function writeXlsx(table: ExportTable): Promise<Uint8Array> {
  const t = withNprColumns(table);
  const report = [
    t.columns.map((c) => ({ value: text(c.label), fontWeight: 'bold' as const })),
    ...t.rows.map((r) => t.columns.map((c) => {
      if (c.kind === 'text') return { value: text(String(r[c.key] ?? '')) };
      const n = numericCell(r[c.key], c.key);
      return n === '' ? null : { value: n };
    })),
  ];
  const about = headerLines(t.meta).map((l) => [{ value: text(l) }]);
  const buf = await writeXlsxFile([
    { data: report as never, sheet: 'Report', stickyRowsCount: 1 },
    { data: about as never, sheet: 'About', columns: [{ width: 90 }] },
  ]).toBuffer();
  return new Uint8Array(buf);
}

// ------------------------------------------------------------------ T0B-MISREPORTS-1 done_when (3): streamed workbook
// The same sheets and cells as writeXlsx ("Report": bold label row, frozen; "About": the header block), written as a ZIP whose sheet part is produced row chunk by
// row chunk (local headers with data descriptors, CRC-32 accumulated), so the rows are never held together. Inline strings, no shared string table.
// ponytail: entries are STORED (no deflate), so files are ~5-8x larger than writeXlsx; switch to a zlib DeflateRaw stream with sync flush if exportMaxBytes bites.
const enc = (s: string): Buffer => Buffer.from(s, 'utf8');
const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colRef = (i: number): string => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const strCell = (ref: string, s: string, style = ''): string => `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xml(text(s))}</t></is></c>`;
type Cells = ReadonlyArray<{ s: string } | { n: number } | null>;
const rowXml = (r: number, cells: Cells, style = ''): string =>
  `<row r="${r}">${cells.map((c, i) => (c === null ? '' : 's' in c ? strCell(`${colRef(i)}${r}`, c.s, style) : `<c r="${colRef(i)}${r}"><v>${c.n}</v></c>`)).join('')}</row>`;

const STATIC: ReadonlyArray<[string, string]> = [
  ['[Content_Types].xml', `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
  ['_rels/.rels', `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
  ['xl/workbook.xml', `${HEAD}<workbook ${NS}><sheets><sheet name="Report" sheetId="1" r:id="rId1"/><sheet name="About" sheetId="2" r:id="rId2"/></sheets></workbook>`],
  ['xl/_rels/workbook.xml.rels', `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
  ['xl/styles.xml', `${HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`],
];

/** Minimal streaming ZIP (STORED entries, bit 3 data descriptors, UTF-8 names). */
class ZipOut {
  private offset = 0;
  private readonly central: Buffer[] = [];
  private cur: { name: Buffer; at: number; crc: number; size: number } | undefined;
  private emit(b: Buffer): Buffer { this.offset += b.length; return b; }
  begin(name: string): Buffer {
    const n = enc(name), h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0808, 6); h.writeUInt16LE(0, 8); h.writeUInt32LE(0x00210000, 10); h.writeUInt16LE(n.length, 26);
    this.cur = { name: n, at: this.offset, crc: 0, size: 0 };
    return this.emit(Buffer.concat([h, n]));
  }
  data(b: Buffer): Buffer { const c = this.cur!; c.crc = crc32(b, c.crc); c.size += b.length; if (c.size > 0xffffffff) throw new RangeError('xlsx: part too large'); return this.emit(b); }
  end(): Buffer {
    const c = this.cur!, d = Buffer.alloc(16);
    d.writeUInt32LE(0x08074b50, 0); d.writeUInt32LE(c.crc, 4); d.writeUInt32LE(c.size, 8); d.writeUInt32LE(c.size, 12);
    const e = Buffer.alloc(46);
    e.writeUInt32LE(0x02014b50, 0); e.writeUInt16LE(20, 4); e.writeUInt16LE(20, 6); e.writeUInt16LE(0x0808, 8); e.writeUInt16LE(0, 10); e.writeUInt32LE(0x00210000, 12);
    e.writeUInt32LE(c.crc, 16); e.writeUInt32LE(c.size, 20); e.writeUInt32LE(c.size, 24); e.writeUInt16LE(c.name.length, 28); e.writeUInt32LE(c.at, 42);
    this.central.push(Buffer.concat([e, c.name]));
    this.cur = undefined;
    return this.emit(d);
  }
  finish(): Buffer {
    const cd = Buffer.concat(this.central), eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(this.central.length, 8); eocd.writeUInt16LE(this.central.length, 10);
    eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(this.offset, 16);
    return this.emit(Buffer.concat([cd, eocd]));
  }
}

export async function* writeXlsxStream(table: Omit<ExportTable, 'rows'>, chunks: AsyncIterable<ExportTable['rows']>): AsyncGenerator<Uint8Array> {
  const z = new ZipOut();
  const out = (...bs: Buffer[]): Uint8Array => new Uint8Array(Buffer.concat(bs));
  for (const [name, body] of STATIC) yield out(z.begin(name), z.data(enc(body)), z.end());

  const cols = withNprColumns({ ...table, rows: [] }).columns;
  yield out(z.begin('xl/worksheets/sheet1.xml'), z.data(enc(`${HEAD}<worksheet ${NS}><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${
    rowXml(1, cols.map((c) => ({ s: c.label })), ' s="1"')}`)));
  let r = 1;
  for await (const rows of chunks) {
    if (rows.length === 0) continue;
    const t = withNprColumns({ ...table, rows });
    const part = t.rows.map((row) => rowXml(++r, t.columns.map((c) => {
      if (c.kind === 'text') return { s: String(row[c.key] ?? '') };
      const n = numericCell(row[c.key], c.key);
      return n === '' ? null : { n };
    }))).join('');
    yield out(z.data(enc(part)));
  }
  yield out(z.data(enc('</sheetData></worksheet>')), z.end());

  const about = headerLines(table.meta).map((l, i) => rowXml(i + 1, [{ s: l }])).join('');
  yield out(z.begin('xl/worksheets/sheet2.xml'), z.data(enc(`${HEAD}<worksheet ${NS}><cols><col min="1" max="1" width="90" customWidth="1"/></cols><sheetData>${about}</sheetData></worksheet>`)), z.end());
  yield out(z.finish());
}
