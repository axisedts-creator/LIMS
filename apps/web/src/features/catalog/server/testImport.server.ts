import 'server-only';
// T0D-TESTIMPORT-1 (LD-318): typed calls of the six Excel test-import operations (contracts/openapi/catalog.yaml, T0C-TESTIMPORT-1). The SERVER parses the
// workbook (no spreadsheet library in the browser bundle); the BFF only re-checks name, size and the declared fields, then forwards. Imports are DRAFTS only.
import { randomUUID } from 'node:crypto';
import { serverFetch } from '@/core/api/server-fetch';
import { IMPORT_KEY_RE } from './createImport.server';
import { proxyDownload } from './proxyDownload';
import { bad, int, oneOf, uuid } from './shared';
import type { Page } from './types';

export const TEST_IMPORT_MODES = ['create_only', 'update'] as const;
export type TestImportMode = (typeof TEST_IMPORT_MODES)[number];
export type TestImportStatus = 'validated' | 'rejected' | 'committed' | 'expired';
export interface TestImportCounts { tests: number; analytes: number; ranges: number; panels: number; errors: number }
export interface TestImportBatch {
  id: string; file_name: string; file_sha256: string; template_version: string; mode: TestImportMode; status: TestImportStatus; counts: TestImportCounts;
  created_by: string; created_at: string; validated_at?: string; committed_at?: string; committed_by?: string; version: number;
}
export interface TestImportError { sheet: string; row: number; column: string; code: string; message: string }
export interface TestImportPreviewTest { code: string; name: string; action: string; analytes: number; ranges: number }
export interface TestImportValidation { batch: TestImportBatch; errors: TestImportError[]; preview: { tests: TestImportPreviewTest[] } }
export interface TestImportCommitResult { batch: TestImportBatch; created: Omit<TestImportCounts, 'errors'> }

const MAX_BYTES = 5 * 1024 * 1024; // validateCatalogImport: at most 5 MB
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const FILE_NAME_RE = /^[^\\/"\u0000-\u001f\u007f;]{1,195}\.xlsx$/i; // ends up inside a Content-Disposition header
const P = '/v1/catalog/test-import-batches';

export const listTestImports = (limit = 50) => serverFetch<Page<TestImportBatch>>(`${P}?limit=${int(1, 200)(limit)}`);

/** validateCatalogImport (dry run). Only `file` and `mode` are forwarded; the multipart body is built by hand like createImport.server.ts. */
export async function validateTestImport(form: FormData, idempotencyKey: string): Promise<TestImportValidation> {
  if (!(form instanceof FormData) || !IMPORT_KEY_RE.test(idempotencyKey)) throw bad();
  const mode = oneOf(...TEST_IMPORT_MODES)(form.get('mode') ?? 'create_only') as TestImportMode;
  const file = form.get('file');
  if (typeof file === 'string' || file === null) throw bad();
  if (file.size < 1 || file.size > MAX_BYTES || !FILE_NAME_RE.test(file.name)) throw bad();
  const boundary = `----lims-${randomUUID()}`;
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="mode"\r\n\r\n${mode}\r\n`
    + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${XLSX}\r\n\r\n`;
  const body = Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from(await file.arrayBuffer()), Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')]);
  return serverFetch<TestImportValidation>('/v1/catalog/test-import-batches', {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'idempotency-key': idempotencyKey },
    body,
  });
}

/** commitCatalogImport: If-Match = the batch version, explicit confirm flag, Idempotency-Key. */
export async function commitTestImport(id: string, version: number, idempotencyKey: string): Promise<TestImportCommitResult> {
  uuid(id);
  int(1, Number.MAX_SAFE_INTEGER)(version);
  if (!IMPORT_KEY_RE.test(idempotencyKey)) throw bad();
  return serverFetch<TestImportCommitResult>(`${P}/${id}/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'If-Match': `"${version}"`, 'idempotency-key': idempotencyKey },
    body: JSON.stringify({ confirm: true }),
  });
}

/** downloadCatalogImportTemplate / downloadCatalogImportErrors through the BFF download proxy; the bytes go back base64 (no new route). */
async function bytesOf(path: string): Promise<{ ok: true; base64: string } | { ok: false; status: number }> {
  const res = await proxyDownload(path);
  if (!res.ok) return { ok: false, status: res.status };
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) return { ok: false, status: 502 };
  return { ok: true, base64: buf.toString('base64') };
}
export const downloadTestImportTemplate = () => bytesOf('/v1/catalog/test-import-template');
export const downloadTestImportErrors = (id: string) => bytesOf(`${P}/${uuid(id) as string}/errors-file`);
