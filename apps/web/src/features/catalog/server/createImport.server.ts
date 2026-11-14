import 'server-only';
// #97 createImport (multipart). Everything is re-checked here (REQ-SEC-083): kind, target, .xlsx name, 1 byte … 15 MB. Only the declared
// form fields are forwarded (no mass assignment). [CONV] The multipart body is assembled by hand (RFC 7578) instead of forwarding the incoming
// FormData: it does not depend on which realm's FormData/File the caller used, and the boundary is always ours, never the browser's.
import { randomUUID } from 'node:crypto';
import { serverFetch } from '@/core/api/server-fetch';
import { bad, oneOf, uuid } from './shared';
import { IMPORT_KINDS, type Import } from './types';

const MAX_BYTES = 15 * 1024 * 1024;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** [CONV] import/export keys are ≥ 16 chars (generated ones are UUIDs). */
export const IMPORT_KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;
// No path separators, quotes, control characters or `;` in the name: it ends up inside a Content-Disposition header.
const FILE_NAME_RE = /^[^\\/"\u0000-\u001f\u007f;]{1,195}\.xlsx$/i;

export async function createImport(form: FormData, idempotencyKey?: string): Promise<Import> {
  if (!(form instanceof FormData)) throw bad();
  const kind = oneOf(...IMPORT_KINDS)(form.get('kind')) as string;
  const target = kind === 'price_list' ? (uuid(form.get('target_price_list_id')) as string) : undefined;
  const file = form.get('file');
  if (typeof file === 'string' || file === null) throw bad();
  if (file.size < 1 || file.size > MAX_BYTES || !FILE_NAME_RE.test(file.name)) throw bad();
  if (idempotencyKey !== undefined && !IMPORT_KEY_RE.test(idempotencyKey)) throw bad();

  const boundary = `----lims-${randomUUID()}`;
  const text = (name: string, value: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const head = text('kind', kind) + (target ? text('target_price_list_id', target) : '')
    + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${XLSX}\r\n\r\n`;
  const body = Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from(await file.arrayBuffer()), Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')]);
  return serverFetch<Import>('/v1/catalog/imports', {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'idempotency-key': idempotencyKey ?? randomUUID() },
    body,
  });
}
