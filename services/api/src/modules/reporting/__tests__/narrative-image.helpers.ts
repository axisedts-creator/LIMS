// C6-T11 test helpers (not a test file). Synthetic data only. Builds real PNGs (valid CRCs) so the REAL core re-encoder (createUploads) is exercised.
import { crc32, deflateSync } from 'node:zlib';
import { EICAR, CENTRE_1, ORDER_1, ITEM_1, TENANT_A, TENANT_B, idN, fileRow, type Row } from './outsourced.helpers.js';

export const NARR_1 = idN(0x3001);          // draft narrative of tenant A
export const NARR_SIGNED = idN(0x3002);     // signed narrative of tenant A
export const NARR_B = idN(0x30b1);          // narrative of tenant B
export const SENTINEL_META = 'SENTINEL-Sita-Karki-scanner-station-7';   // metadata planted in ancillary PNG chunks: must never survive re-encode

const enc = new TextEncoder();
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function chunk(type: string, data: Buffer): Buffer {
  const t = Buffer.from(type, 'latin1'); const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
  return Buffer.concat([len, t, data, crc]);
}
/** RGBA8 PNG. `ancillary` chunks (tEXt, iTXt, eXIf...) go between IHDR and IDAT. `declared` lies about the IHDR size (decompression-bomb header). */
export function pngBytes(o: { width?: number; height?: number; ancillary?: Array<[string, Buffer]>; declared?: { width: number; height: number }; trailing?: Buffer } = {}): Uint8Array {
  const width = o.width ?? 3; const height = o.height ?? 2;
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(o.declared?.width ?? width, 0); ihdr.writeUInt32BE(o.declared?.height ?? height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 4, 0x7f)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return new Uint8Array(Buffer.concat([SIG, chunk('IHDR', ihdr), ...(o.ancillary ?? []).map(([t, d]) => chunk(t, d)),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)), ...(o.trailing ? [o.trailing] : [])]));
}
export const tEXt = (key: string, text: string): [string, Buffer] => ['tEXt', Buffer.from(`${key}\0${text}`, 'latin1')];
export const withMetadata = (): Uint8Array => pngBytes({ ancillary: [tEXt('Author', SENTINEL_META), tEXt('Comment', '<svg onload="alert(1)"><script>x</script></svg>'), ['eXIf', Buffer.from(`II*\0${SENTINEL_META}`, 'latin1')]] });
export const infectedPng = (): Uint8Array => pngBytes({ ancillary: [tEXt('Comment', EICAR)] });   // signature only in an ancillary chunk the re-encoder drops
export const SVG = enc.encode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>fetch("//x")</script></svg>');
export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
export const has = (b: Uint8Array | undefined, needle: string) => !!b && Buffer.from(b).includes(needle);
export const isPng = (b: Uint8Array | undefined) => !!b && Buffer.from(b).subarray(0, 8).equals(SIG);

/** Tenant-A narratives (draft + signed) and one of tenant B. */
export function narratives(): Row[] {
  const n = (tenant: string, id: string, o: Row = {}) => ({ tenant_id: tenant, id, centre_id: CENTRE_1, report_id: idN(0x0e01), order_id: ORDER_1, order_item_id: ITEM_1, test_id: idN(0x7001), template_kind: 'xray', ...o });
  return [n(TENANT_A, NARR_1), n(TENANT_A, NARR_SIGNED, { status: 'signed', signed_version_no: 1 }), n(TENANT_B, NARR_B)];
}
/** A seeded narrative_image input_files row (tenant A, NARR_1 by default). */
export function imageRow(o: Row = {}): Row {
  return fileRow({ kind: 'narrative_image', order_item_id: null, external_lab_name: null, declared_mime: 'image/png', original_filename: 'synthetic-scan.png', narrative_report_id: NARR_1, ...o });
}
export const imagePath = (tenant: string, id: string) => `${tenant}/narrative-images/2026/11/${id}.png`;
