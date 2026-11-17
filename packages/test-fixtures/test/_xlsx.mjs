// Test helper: minimal XLSX (zip) reader, no dependencies. readZip returns Map<entryName, string>.
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

export function readZip(path) {
  const b = readFileSync(path);
  let e = b.length - 22;
  while (e >= 0 && b.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error(`not a zip: ${path}`);
  const n = b.readUInt16LE(e + 10);
  let p = b.readUInt32LE(e + 16);
  const out = new Map();
  for (let i = 0; i < n; i++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = b.readUInt16LE(p + 10);
    const csize = b.readUInt32LE(p + 20);
    const nl = b.readUInt16LE(p + 28);
    const xl = b.readUInt16LE(p + 30);
    const cl = b.readUInt16LE(p + 32);
    const lho = b.readUInt32LE(p + 42);
    const name = b.toString('utf8', p + 46, p + 46 + nl);
    const lnl = b.readUInt16LE(lho + 26);
    const lxl = b.readUInt16LE(lho + 28);
    const raw = b.subarray(lho + 30 + lnl + lxl, lho + 30 + lnl + lxl + csize);
    out.set(name, (method === 0 ? raw : inflateRawSync(raw)).toString('utf8'));
    p += 46 + nl + xl + cl;
  }
  return out;
}

const unesc = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Sheet names (+hidden flag), all text cells (shared + inline strings), and whether any cell is a formula. */
export function workbookInfo(path) {
  const z = readZip(path);
  const wb = z.get('xl/workbook.xml') ?? '';
  const sheets = [...wb.matchAll(/<sheet\b[^>]*\bname="([^"]*)"([^>]*)>/g)].map((m) => ({
    name: unesc(m[1]),
    hidden: /state="(hidden|veryHidden)"/.test(m[0]),
  }));
  const texts = [];
  for (const [k, v] of z) {
    if (k === 'xl/sharedStrings.xml' || /^xl\/worksheets\/.*\.xml$/.test(k)) {
      for (const m of v.matchAll(/<t\b[^>]*>([^<]*)<\/t>/g)) texts.push(unesc(m[1]));
    }
  }
  const hasFormula = [...z].some(([k, v]) => /^xl\/worksheets\//.test(k) && /<f[ >]/.test(v));
  return { z, sheets, texts, hasFormula };
}
