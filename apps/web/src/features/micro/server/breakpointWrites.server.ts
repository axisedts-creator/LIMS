import 'server-only';
// Breakpoint set writes (TRD §5 M42, M46–M48). Everything is re-checked here (REQ-SEC-083): standard, field lengths, .csv name, 1 byte … 5 MiB.
// [CONV] Same hand-assembled multipart as catalog createImport (RFC 7578): independent of which realm's FormData/File the caller used, boundary is ours.
// The CSV bytes are forwarded untouched; this layer never parses or evaluates them (REQ-SEC-088, S-13).
import { randomUUID } from 'node:crypto';
import { serverFetch } from '@/core/api/server-fetch';
import { bad, idemKey, oneOf, pick, text, uuid, version } from './shared';
import { STANDARDS, type BreakpointSetDto } from './types';

export const MAX_CSV_BYTES = 5_242_880;
// No path separators, quotes, control characters or `;` in the name: it ends up inside a Content-Disposition header.
const FILE_NAME_RE = /^[^\\/"\u0000-\u001f\u007f;]{1,195}\.csv$/i;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export async function createBreakpointImport(form: FormData, idempotencyKey: string): Promise<BreakpointSetDto> {
  if (!(form instanceof FormData)) throw bad();
  const field = (k: string) => { const v = form.get(k); return typeof v === 'string' ? v : undefined; };
  const meta = pick(
    { standard: field('standard'), standard_version: field('standard_version'), title: field('title'), licence_attestation_text: field('licence_attestation_text'), intended_effective_from: field('intended_effective_from') || undefined },
    {
      standard: (v) => oneOf(STANDARDS, v),
      standard_version: text(1, 32),
      title: text(1, 120),
      licence_attestation_text: (v) => { if (typeof v !== 'string' || v.length < 20 || v.length > 500) throw bad(); return v; },
      intended_effective_from: (v) => { if (typeof v !== 'string' || !ISO_UTC_RE.test(v)) throw bad(); return v; },
    },
    ['standard', 'standard_version', 'title', 'licence_attestation_text'],
  );
  const file = form.get('file');
  if (typeof file === 'string' || file === null) throw bad();
  if (file.size < 1 || file.size > MAX_CSV_BYTES || !FILE_NAME_RE.test(file.name)) throw bad();
  idemKey(idempotencyKey);

  const boundary = `----lims-${randomUUID()}`;
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(meta)}\r\n`
    + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: text/csv\r\n\r\n`;
  const body = Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from(await file.arrayBuffer()), Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')]);
  return serverFetch<BreakpointSetDto>('/v1/micro/breakpoint-sets', {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'idempotency-key': idempotencyKey },
    body,
  });
}

export type BreakpointTransition = 'activate' | 'retire' | 'discard';

/** activate / retire / discard: If-Match "<version>" (stale → 412 common.version_conflict). Only activate takes a body field (effective_from). */
export async function transitionBreakpointSet(id: string, action: BreakpointTransition, v: number, input: { effective_from?: string } = {}): Promise<BreakpointSetDto> {
  const act = oneOf(['activate', 'retire', 'discard'] as const, action);
  const body = act === 'activate' ? pick(input, { effective_from: (x) => { if (typeof x !== 'string' || !ISO_UTC_RE.test(x)) throw bad(); return x; } }) : {};
  return serverFetch<BreakpointSetDto>(`/v1/micro/breakpoint-sets/${uuid(id)}/${act}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'if-match': `"${version(v)}"` },
    body: JSON.stringify(body),
  });
}
