// PHLEBO-UI-FULL-1: applicant documents on the API server's disk (founder decision 2026-11-26: server HDD, 2 MB per file,
// stored compressed). Root = LIMS_HOMECOLLECTION_APPLICATION_DIR; without it every call fails closed.
// Layout: <root>/<tenant_id>/<application_id>/<document_id>.gz  (+ .part<N> while pieces arrive). Every path segment is a
// validated UUID, so nothing a caller sends can leave the root. Nothing here is logged.
// ponytail: local disk + gzip, no virus scan and one API host. Move to core uploads/storage (scan, buckets) when SP-1 wires them.
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { LimsError } from '../../core/errors.js';

export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
export const MAX_PIECE_BYTES = 512 * 1024;
export const MAX_PIECES = 8;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const rootDir = (): string => {
  const dir = process.env['LIMS_HOMECOLLECTION_APPLICATION_DIR'];
  if (!dir || dir.trim() === '') throw new LimsError('common.service_unavailable');
  return dir;
};
const seg = (v: string): string => { if (!UUID.test(v)) throw new LimsError('common.validation_failed'); return v; };
const appDir = (tenantId: string, applicationId: string): string => join(rootDir(), seg(tenantId), seg(applicationId));

/** What the bytes really are (declared types are never trusted). */
export function sniff(bytes: Uint8Array): 'image/jpeg' | 'image/png' | 'application/pdf' | null {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return 'application/pdf';
  return null;
}

/** Stores piece `index`. Pieces must arrive in order: index = number of pieces already on disk. Returns bytes so far. */
export async function writePiece(tenantId: string, applicationId: string, documentId: string, index: number, bytes: Uint8Array): Promise<number> {
  if (bytes.length === 0 || bytes.length > MAX_PIECE_BYTES || !Number.isInteger(index) || index < 0 || index >= MAX_PIECES) throw new LimsError('common.payload_too_large');
  const dir = appDir(tenantId, applicationId);
  await mkdir(dir, { recursive: true });
  const prefix = `${seg(documentId)}.part`;
  const have = (await readdir(dir)).filter((f) => f.startsWith(prefix));
  if (have.length !== index) throw new LimsError('common.validation_failed');
  let total = bytes.length;
  for (const f of have) total += (await stat(join(dir, f))).size;
  if (total > MAX_DOCUMENT_BYTES) { await discardPieces(tenantId, applicationId, documentId); throw new LimsError('common.payload_too_large'); }
  await writeFile(join(dir, `${prefix}${index}`), bytes, { flag: 'wx' });
  return total;
}

export async function discardPieces(tenantId: string, applicationId: string, documentId: string): Promise<void> {
  const dir = appDir(tenantId, applicationId);
  const prefix = `${seg(documentId)}.part`;
  for (const f of await readdir(dir).catch(() => [] as string[])) if (f.startsWith(prefix)) await rm(join(dir, f), { force: true });
}

/** Joins the pieces, checks the real type, writes <document_id>.gz and removes the pieces. */
export async function finishDocument(tenantId: string, applicationId: string, documentId: string, pieces: number,
  declaredType: string): Promise<{ byteSize: number; storedSize: number; sha256: Buffer; storagePath: string }> {
  const dir = appDir(tenantId, applicationId);
  const parts: Buffer[] = [];
  for (let i = 0; i < pieces; i++) parts.push(await readFile(join(dir, `${seg(documentId)}.part${i}`)));
  const bytes = Buffer.concat(parts);
  await discardPieces(tenantId, applicationId, documentId);
  if (bytes.length === 0 || bytes.length > MAX_DOCUMENT_BYTES) throw new LimsError('common.payload_too_large');
  if (sniff(bytes) !== declaredType) throw new LimsError('common.unsupported_media_type');
  const stored = gzipSync(bytes, { level: 9 });
  await writeFile(join(dir, `${documentId}.gz`), stored, { flag: 'wx' });
  return { byteSize: bytes.length, storedSize: stored.length, sha256: createHash('sha256').update(bytes).digest(), storagePath: `${tenantId}/${applicationId}/${documentId}.gz` };
}

export async function removeDocument(tenantId: string, applicationId: string, documentId: string): Promise<void> {
  await rm(join(appDir(tenantId, applicationId), `${seg(documentId)}.gz`), { force: true });
}

/** The original bytes; throws common.not_found when the file is gone or does not match the recorded hash. */
export async function readDocument(tenantId: string, applicationId: string, documentId: string, sha256: Uint8Array): Promise<Buffer> {
  let bytes: Buffer;
  try {
    bytes = gunzipSync(await readFile(join(appDir(tenantId, applicationId), `${seg(documentId)}.gz`)), { maxOutputLength: MAX_DOCUMENT_BYTES });
  } catch (e) {
    if (e instanceof LimsError) throw e;
    throw new LimsError('common.not_found');
  }
  if (!createHash('sha256').update(bytes).digest().equals(Buffer.from(sha256))) throw new LimsError('common.not_found');
  return bytes;
}
