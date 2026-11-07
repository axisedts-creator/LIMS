// Image sanitisation for ctx.uploads.accept images.reencode (REQ-SEC-085, 08 A17 D-67). Pure node:zlib, no image dependency.
// PNG: verify every chunk CRC, IHDR and megapixel cap BEFORE inflating, inflate with a hard output cap, check filter bytes,
// then write a fresh PNG holding only IHDR (+ PLTE/tRNS) + one IDAT + IEND, so all metadata chunks (tEXt, eXIf, iTXt...) are dropped.
// ponytail: JPEG has no decoder here -> refused (422) until an approved image library is pinned (CR T0D-17).
import { crc32, deflateSync, inflateSync } from 'node:zlib';

export class ImageRejected extends Error {}
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS: Readonly<Record<number, readonly number[]>> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

function chunk(type: string, data: Buffer): Buffer {
  const t = Buffer.from(type, 'latin1'); const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
  return Buffer.concat([len, t, data, crc]);
}

export function reencodePng(src: Uint8Array, maxMegapixels: number): { bytes: Buffer; width: number; height: number } {
  const b = Buffer.from(src.buffer, src.byteOffset, src.byteLength);
  if (b.length < 8 || !b.subarray(0, 8).equals(SIG)) throw new ImageRejected();
  let off = 8; let ihdr: Buffer | undefined; let plte: Buffer | undefined; let trns: Buffer | undefined; let ended = false;
  const idat: Buffer[] = [];
  while (off < b.length) {
    if (off + 12 > b.length) throw new ImageRejected();
    const len = b.readUInt32BE(off); const type = b.toString('latin1', off + 4, off + 8);
    if (off + 12 + len > b.length) throw new ImageRejected();
    const data = b.subarray(off + 8, off + 8 + len);
    if ((crc32(b.subarray(off + 4, off + 8 + len)) >>> 0) !== b.readUInt32BE(off + 8 + len)) throw new ImageRejected();
    off += 12 + len;
    if (type === 'IHDR') ihdr = data;
    else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') { ended = true; break; }
    else if ((type.charCodeAt(0) & 0x20) === 0) throw new ImageRejected();   // unknown critical chunk
  }
  if (!ended || !ihdr || ihdr.length !== 13 || idat.length === 0) throw new ImageRejected();
  const width = ihdr.readUInt32BE(0); const height = ihdr.readUInt32BE(4);
  const depth = ihdr[8]!; const color = ihdr[9]!; const interlace = ihdr[12]!;
  if (width < 1 || height < 1 || width * height > maxMegapixels * 1_000_000) throw new ImageRejected();
  if (!DEPTHS[color]?.includes(depth) || ihdr[10] !== 0 || ihdr[11] !== 0 || interlace > 1) throw new ImageRejected();
  if (color === 3 && !plte) throw new ImageRejected();
  // ponytail: interlaced (Adam7) images are refused rather than de-interlaced; add when a module needs them.
  if (interlace !== 0) throw new ImageRejected();
  const stride = Math.ceil((width * CHANNELS[color]! * depth) / 8);
  const expected = height * (stride + 1);
  let raw: Buffer;
  try { raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 1 }); } catch { throw new ImageRejected(); }
  if (raw.length !== expected) throw new ImageRejected();
  for (let y = 0; y < height; y++) if (raw[y * (stride + 1)]! > 4) throw new ImageRejected();
  const out = Buffer.concat([
    SIG, chunk('IHDR', Buffer.from(ihdr)),
    ...(plte ? [chunk('PLTE', Buffer.from(plte))] : []), ...(trns ? [chunk('tRNS', Buffer.from(trns))] : []),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
  return { bytes: out, width, height };
}
