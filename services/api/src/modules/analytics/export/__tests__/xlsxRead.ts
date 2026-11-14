// AN-T15 test helper (not a test file): a dependency-free XLSX reader (zip + OOXML) so the tests can OPEN what XlsxWriter produced.
// Returns { sheetName: rows[][] }; numeric cells are numbers, text cells (shared / inline / str) are strings, empty cells null.
import { inflateRawSync } from 'node:zlib';

function unzip(buf: Uint8Array): Map<string, Buffer> {
  const b = Buffer.from(buf);
  let eocd = -1;
  for (let i = b.length - 22; i >= 0; i--) if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('xlsxRead: not a zip file (no end-of-central-directory)');
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error('xlsxRead: bad central directory');
    const method = b.readUInt16LE(p + 10), csize = b.readUInt32LE(p + 20), nameLen = b.readUInt16LE(p + 28), extraLen = b.readUInt16LE(p + 30), commentLen = b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42);
    const name = b.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    const raw = b.subarray(start, start + csize);
    files.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}
const dec = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, '&');
const colIndex = (ref: string): number => [...ref.replace(/\d+/g, '')].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
const textOf = (xml: string): string => [...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => dec(m[1]!)).join('');

export type Cell = string | number | null;
export function readXlsx(bytes: Uint8Array): Record<string, Cell[][]> {
  const files = unzip(bytes);
  const get = (n: string): string => { const f = files.get(n); if (!f) throw new Error(`xlsxRead: missing part ${n}`); return f.toString('utf8'); };
  const shared = files.has('xl/sharedStrings.xml') ? [...get('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]!)) : [];
  const rels = new Map([...get('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b([^>]*?)\/?>/g)].map((m) => {
    const a = m[1]!; return [/Id="([^"]+)"/.exec(a)?.[1] ?? '', /Target="([^"]+)"/.exec(a)?.[1] ?? ''] as const;
  }));
  const out: Record<string, Cell[][]> = {};
  const sheets = [...get('xl/workbook.xml').matchAll(/<sheet\b([^>]*?)\/?>/g)].map((m) => m[1]!);
  for (const attrs of sheets) {
    const name = dec(/name="([^"]*)"/.exec(attrs)?.[1] ?? '');
    const rid = /r:id="([^"]+)"/.exec(attrs)?.[1] ?? '';
    const target = (rels.get(rid) ?? '').replace(/^\//, '');
    const xml = get(target.startsWith('xl/') ? target : `xl/${target}`);
    const rows: Cell[][] = [];
    for (const r of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const rowNo = Number(/\br="(\d+)"/.exec(r[1]!)?.[1] ?? rows.length + 1) - 1;
      const cells: Cell[] = [];
      for (const c of (r[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const at = /\br="([A-Z]+\d+)"/.exec(c[1]!)?.[1] ?? '';
        const t = /\bt="(\w+)"/.exec(c[1]!)?.[1];
        const inner = c[2] ?? '';
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        let val: Cell = null;
        if (t === 's' && v !== undefined) val = shared[Number(v)] ?? null;
        else if (t === 'inlineStr') val = textOf(inner);
        else if (t === 'str' && v !== undefined) val = dec(v);
        else if (t === 'b' && v !== undefined) val = v === '1' ? 1 : 0;
        else if (v !== undefined && v !== '') val = Number(v);
        cells[at ? colIndex(at) : cells.length] = val;
      }
      for (let i = 0; i < cells.length; i++) cells[i] ??= null;
      rows[rowNo] = cells;
    }
    for (let i = 0; i < rows.length; i++) rows[i] ??= [];
    out[name] = rows;
  }
  return out;
}
/** RFC 4180 parser (CRLF or LF records, doubled quotes, embedded newlines). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
    if (c === '"' && f === '') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\r' && text[i + 1] === '\n') { row.push(f); rows.push(row); row = []; f = ''; i++; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}
/** A CSV export split into: BOM-stripped buffer, the leading '#' header lines, the header row (labels) and the data records. */
export const csvParts = (bytes: Uint8Array) => {
  const buf = Buffer.from(bytes);
  const text = buf.toString('utf8').replace(/^﻿/, '');
  const headerLines = text.split(/\r?\n/).filter((_l, i, a) => a.slice(0, i + 1).every((x) => x.startsWith('#')));
  const rest = text.slice(headerLines.join('\r\n').length).replace(/^(\r?\n)+/, '');
  const [head, ...body] = parseCsv(rest);
  return { buf, headerLines, head: head ?? [], body: body.filter((r) => r.length > 1 || r[0] !== '') };
};
export const flat =(rows: Cell[][]): string[] => rows.flat().filter((c): c is string | number => c !== null).map(String);
