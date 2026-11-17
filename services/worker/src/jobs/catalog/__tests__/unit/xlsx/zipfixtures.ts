// T-21 (C3) test helpers — synthetic ZIP/XLSX builder and unzip. No library under test is used here, so crafted
// fixtures (bad flags, lying sizes, ZIP64 markers, `..` names) can be produced byte-exactly (02-TRD §8.4).
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..', '..', '..', '..');
export const WORKER_CATALOG_DIR = join(REPO_ROOT, 'services', 'worker', 'src', 'jobs', 'catalog');
export const XLSX_DIR = join(WORKER_CATALOG_DIR, 'xlsx');
export { neutraliseFormula, restoreNeutralised } from '../../../../../../../../packages/shared-ts/src/spreadsheet/index.js';
export const GOLDEN: { input: string; neutralised: string }[] = JSON.parse(
  readFileSync(join(REPO_ROOT, 'packages', 'test-fixtures', 'spreadsheet', 'golden.json'), 'utf8'),
).cases;

// EICAR assembled at runtime so this source file is not itself flagged by a scanner.
export const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$' + 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

export interface ZEntry {
  name: string;
  data?: Uint8Array | string;
  method?: 0 | 8;
  flags?: number;                 // general-purpose bit flags written to local + central header
  claimCompressed?: number;       // central-directory compressed size (lies about the data)
  claimUncompressed?: number;     // central-directory uncompressed size
  zip64Extra?: boolean;           // central entry: sizes = 0xFFFFFFFF + extra field 0x0001
}
export interface ZOpts { comment?: Uint8Array; zip64Eocd?: boolean; noEocd?: boolean }

const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

export function buildZip(entries: ZEntry[], o: ZOpts = {}): Buffer {
  const parts: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const e of entries) {
    const raw = Buffer.from(e.data ?? '');
    const method = e.method ?? 0;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(e.name, 'utf8'); const flags = e.flags ?? 0; const crc = crc32(raw);
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(flags), u16(method), u16(0), u16(0x21), u32(crc),
      u32(body.length), u32(raw.length), u16(name.length), u16(0), name, body]);
    const zip64 = e.zip64Extra === true;
    const extra = zip64 ? Buffer.concat([u16(0x0001), u16(16), Buffer.alloc(16)]) : Buffer.alloc(0);
    central.push(Buffer.concat([u32(0x02014b50), u16(20), u16(zip64 ? 45 : 20), u16(flags), u16(method), u16(0), u16(0x21), u32(crc),
      u32(zip64 ? 0xffffffff : (e.claimCompressed ?? body.length)), u32(zip64 ? 0xffffffff : (e.claimUncompressed ?? raw.length)),
      u16(name.length), u16(extra.length), u16(0), u16(0), u16(0), u32(0), u32(offset), name, extra]));
    parts.push(local); offset += local.length;
  }
  const cd = Buffer.concat(central); const cdOffset = offset; const comment = Buffer.from(o.comment ?? []);
  const z64 = o.zip64Eocd ? Buffer.concat([
    u32(0x06064b50), u32(44), u32(0), u16(45), u16(45), u32(0), u32(0), u32(entries.length), u32(0), u32(entries.length), u32(0), u32(cd.length), u32(0), u32(cdOffset), u32(0),
    u32(0x07064b50), u32(0), u32(cdOffset + cd.length), u32(0), u32(1)]) : Buffer.alloc(0);
  const eocd = o.noEocd ? Buffer.alloc(0) : Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(cd.length), u32(cdOffset), u16(comment.length), comment]);
  return Buffer.concat([...parts, cd, z64, eocd]);
}

/** Entries of a structurally valid minimal xlsx (enough for the inspector; the spreadsheet library is never fed this). */
export function minimalXlsxEntries(): ZEntry[] {
  return [
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    { name: '_rels/.rels', data: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>' },
    { name: 'xl/workbook.xml', data: '<?xml version="1.0"?><workbook><sheets><sheet name="Prices" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/worksheets/sheet1.xml', data: '<?xml version="1.0"?><worksheet><sheetData/></worksheet>' },
  ];
}
export const minimalXlsx = (extra: ZEntry[] = [], o: ZOpts = {}) => buildZip([...minimalXlsxEntries(), ...extra], o);
export const padEntries = (n: number): ZEntry[] => Array.from({ length: n }, (_, i) => ({ name: `xl/worksheets/pad${i}.xml`, data: '' }));

/** Unzip via the central directory (independent of any library). Returns name -> utf8 text. */
export function unzip(buf: Uint8Array): Map<string, string> {
  const b = Buffer.from(buf); const out = new Map<string, string>();
  let e = -1; for (let i = b.length - 22; i >= 0; i--) if (b.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('no EOCD');
  const n = b.readUInt16LE(e + 10); let p = b.readUInt32LE(e + 16);
  for (let i = 0; i < n; i++) {
    const method = b.readUInt16LE(p + 10); const csize = b.readUInt32LE(p + 20); const nlen = b.readUInt16LE(p + 28);
    const elen = b.readUInt16LE(p + 30); const clen = b.readUInt16LE(p + 32); const lo = b.readUInt32LE(p + 42);
    const name = b.toString('utf8', p + 46, p + 46 + nlen);
    const start = lo + 30 + b.readUInt16LE(lo + 26) + b.readUInt16LE(lo + 28);
    const body = b.subarray(start, start + csize);
    out.set(name, (method === 8 ? inflateRawSync(body) : body).toString('utf8'));
    p += 46 + nlen + elen + clen;
  }
  return out;
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const xmlUnescape = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_m, g: string) =>
  g[0] === '#' ? String.fromCodePoint(g[1]!.toLowerCase() === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10)) : ENT[g.toLowerCase()]!);
/** Every text run (`<t>`) in every xl/ part (sharedStrings or inline strings), XML-unescaped. */
export function textRuns(parts: Map<string, string>): string[] {
  const runs: string[] = [];
  for (const [name, xml] of parts) if (name.startsWith('xl/')) for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) runs.push(xmlUnescape(m[1]!));
  return runs;
}
/** code of the error a promise rejects with ('' when it resolves). */
export async function rejectCode(p: Promise<unknown>): Promise<string> {
  try { await p; return ''; } catch (e) { return String((e as { code?: unknown }).code ?? `no-code:${String(e)}`); }
}
