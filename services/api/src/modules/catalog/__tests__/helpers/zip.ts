// T-20 (C3) test helper: tiny ZIP writer (stored entries) + reader (stored/deflate) so tests can build and open
// xlsx-shaped archives without a spreadsheet library. Synthetic content only.
import { crc32, inflateRawSync } from 'node:zlib';

const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

/** ZIP with stored (method 0) entries. First 4 bytes are 50 4B 03 04, like a real xlsx. */
export function makeZip(entries: Record<string, string | Uint8Array>): Uint8Array {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(entries)) {
    const nameB = Buffer.from(name, 'utf8');
    const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    const crc = crc32(body);
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0x21), u32(crc), u32(body.length), u32(body.length), u16(nameB.length), u16(0), nameB, body]);
    central.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0x21), u32(crc), u32(body.length), u32(body.length), u16(nameB.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameB]));
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(cd.length), u32(offset), u16(0)]);
  return new Uint8Array(Buffer.concat([...locals, cd, eocd]));
}

/** Entry name -> bytes. Supports stored and deflate entries; throws on anything else (so a bad archive fails loudly). */
export function readZip(bytes: Uint8Array): Map<string, Buffer> {
  const b = Buffer.from(bytes);
  let e = b.length - 22;
  while (e >= 0 && b.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('zip: no end-of-central-directory record');
  const count = b.readUInt16LE(e + 10);
  let p = b.readUInt32LE(e + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error('zip: bad central entry');
    const method = b.readUInt16LE(p + 10);
    const csize = b.readUInt32LE(p + 20);
    const nlen = b.readUInt16LE(p + 28), xlen = b.readUInt16LE(p + 30), clen = b.readUInt16LE(p + 32);
    const lho = b.readUInt32LE(p + 42);
    const name = b.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const dataStart = lho + 30 + b.readUInt16LE(lho + 26) + b.readUInt16LE(lho + 28);
    const raw = b.subarray(dataStart, dataStart + csize);
    if (method === 0) out.set(name, Buffer.from(raw));
    else if (method === 8) out.set(name, inflateRawSync(raw));
    else throw new Error(`zip: unsupported method ${method}`);
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

/** A minimal xlsx-shaped archive; `tag` makes the bytes (and so the sha256) unique. */
export function fakeXlsx(tag = 'a', extra: Record<string, string | Uint8Array> = {}): Uint8Array {
  return makeZip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'xl/workbook.xml': `<?xml version="1.0"?><workbook><sheets><sheet name="Prices" sheetId="1"/></sheets></workbook><!-- ${tag} -->`,
    ...extra,
  });
}
