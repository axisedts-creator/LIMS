// 02-TRD §8.4 ZIP inspection — in-house, no library, never decompresses. Reads the EOCD record and walks the
// central directory (PKWARE APPNOTE). Pure: the verdict depends only on the bytes. Only a file that passes is
// handed to read-excel-file (07-SECURITY AB-11, S-7).

export type ZipVerdict =
  | { ok: true; entryCount: number; uncompressedBytes: number }
  | { ok: false; code: 'file.not_xlsx' | 'file.zip_unsafe' | 'file.macro_present' | 'file.external_links' };

const MAX_ENTRIES = 200;                    // [CONV] 02-TRD §8.4
const MAX_UNCOMPRESSED = 50 * 1024 * 1024;  // [CONV] 50 MB
const MAX_RATIO = 100;                      // [CONV] compressed -> uncompressed

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_DESCRIPTOR = 0x08074b50;
const EOCD_LEN = 22;

const notXlsx = { ok: false, code: 'file.not_xlsx' } as const;
const unsafe = { ok: false, code: 'file.zip_unsafe' } as const;

/** `..`, absolute (`/x`, `C:x`) or any backslash (also covers UNC). */
const unsafeName = (n: string) => n.includes('..') || n.includes('\\') || n.startsWith('/') || /^[A-Za-z]:/.test(n);

export function inspectZip(bytes: Uint8Array): ZipVerdict {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = bytes.byteLength;
  const u16 = (o: number) => v.getUint16(o, true);
  const u32 = (o: number) => v.getUint32(o, true);

  // An xlsx starts with a local file header; anything in front of it (HTML polyglot, PDF, OLE .xls) is refused.
  if (len < 4 + EOCD_LEN || u32(0) !== SIG_LOCAL) return notXlsx;

  // EOCD: last record, followed only by its comment (≤ 65,535 bytes).
  let eocd = -1;
  for (let i = len - EOCD_LEN; i >= Math.max(0, len - EOCD_LEN - 0xffff); i--) {
    if (u32(i) === SIG_EOCD && i + EOCD_LEN + u16(i + 20) === len) { eocd = i; break; }
  }
  if (eocd < 0) return notXlsx;

  const total = u16(eocd + 10);
  const cdSize = u32(eocd + 12);
  const cdOffset = u32(eocd + 16);
  // ZIP64: sentinel values in the EOCD, a ZIP64 locator in front of it, or a ZIP64 EOCD record anywhere before it.
  if (total === 0xffff || u16(eocd + 8) === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return unsafe;
  if (eocd >= 20 && u32(eocd - 20) === SIG_ZIP64_LOCATOR) return unsafe;
  if (cdOffset + cdSize > eocd) return notXlsx;
  if (cdOffset + cdSize >= 56 && cdOffset + cdSize + 4 <= eocd && u32(cdOffset + cdSize) === SIG_ZIP64_EOCD) return unsafe;
  if (total > MAX_ENTRIES) return unsafe;

  const names = new Set<string>();
  const spans: [number, number][] = [];
  let sum = 0;
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (p + 46 > cdOffset + cdSize || u32(p) !== SIG_CENTRAL) return notXlsx;
    const flags = u16(p + 8);
    const csize = u32(p + 20);
    const usize = u32(p + 24);
    const nlen = u16(p + 28);
    const elen = u16(p + 30);
    const clen = u16(p + 32);
    const localOffset = u32(p + 42);
    const end = p + 46 + nlen + elen + clen;
    if (end > cdOffset + cdSize) return notXlsx;
    if (csize === 0xffffffff || usize === 0xffffffff || localOffset === 0xffffffff) return unsafe;
    for (let x = p + 46 + nlen; x + 4 <= p + 46 + nlen + elen; x += 4 + u16(x + 2)) if (u16(x) === 0x0001) return unsafe;
    if (flags & 0x0001) return unsafe;                                   // encrypted
    if (usize > 0 && (csize === 0 || usize / csize > MAX_RATIO)) return unsafe;
    if (sum + usize > MAX_UNCOMPRESSED) return unsafe;                   // JS number: no uint32 wrap
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nlen));
    if (unsafeName(name)) return unsafe;

    // read-excel-file unzips by streaming the LOCAL headers, so they must say what the central directory says:
    // same name, not encrypted, same limits, and together they must tile [0, cdOffset) with nothing hidden.
    if (localOffset + 30 > cdOffset || u32(localOffset) !== SIG_LOCAL) return notXlsx;
    const lflags = u16(localOffset + 6);
    const lnlen = u16(localOffset + 26);
    const lelen = u16(localOffset + 28);
    if (localOffset + 30 + lnlen + lelen > cdOffset) return notXlsx;
    if (lflags & 0x0001) return unsafe;
    if (new TextDecoder().decode(bytes.subarray(localOffset + 30, localOffset + 30 + lnlen)) !== name) return unsafe;
    const descriptor = (lflags & 0x0008) !== 0;                          // sizes follow the data
    const lcsize = descriptor ? csize : u32(localOffset + 18);
    const lusize = descriptor ? usize : u32(localOffset + 22);
    if (lcsize === 0xffffffff || lusize === 0xffffffff) return unsafe;
    if (lusize > 0 && (lcsize === 0 || lusize / lcsize > MAX_RATIO)) return unsafe;
    sum += Math.max(usize, lusize);
    if (sum > MAX_UNCOMPRESSED) return unsafe;
    let extent = localOffset + 30 + lnlen + lelen + lcsize;
    if (descriptor) extent += extent + 4 <= cdOffset && u32(extent) === SIG_DESCRIPTOR ? 16 : 12;
    spans.push([localOffset, extent]);

    names.add(name.toLowerCase());
    p = end;
  }
  spans.sort((a, b) => a[0] - b[0]);
  let at = 0;
  for (const [start, stop] of spans) { if (start !== at) return unsafe; at = stop; }
  if (at !== cdOffset) return unsafe;

  if (!names.has('[content_types].xml') || !names.has('xl/workbook.xml')) return notXlsx;
  if (names.has('xl/vbaproject.bin')) return { ok: false, code: 'file.macro_present' };
  for (const n of names) if (n.startsWith('xl/externallinks/')) return { ok: false, code: 'file.external_links' };
  return { ok: true, entryCount: total, uncompressedBytes: sum };
}
