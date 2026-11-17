// Server-only API access for admin pages and server actions (02-TRD §12.1). Bearer stays on the server (REQ-SEC-068).
import 'server-only';
import { randomUUID } from 'node:crypto';
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { getShellSession } from '@/core/session/server';

export interface Fail { ok: false; status: number; code: string; requestId?: string; pointers: string[] }
export type Result<T> = { ok: true; data: T } | Fail;

export interface Upload { file: Blob; filename: string; fields?: Record<string, string> }
export interface CallOpts { query?: Record<string, string | undefined>; body?: unknown; upload?: Upload; version?: number; idempotent?: boolean }

/** multipart/form-data from bytes (one file part named "file" + text fields); avoids depending on the runtime's FormData/Blob streaming. */
async function multipart(u: Upload): Promise<{ body: Uint8Array<ArrayBuffer>; type: string }> {
  const boundary = `----lims${randomUUID().replace(/-/g, '')}`;
  const enc = new TextEncoder();
  const safe = (s: string) => s.replace(/["\r\n\\]/g, '_');
  const head = Object.entries(u.fields ?? {}).map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${safe(k)}"\r\n\r\n${v}\r\n`).join('');
  const fileHead = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safe(u.filename)}"\r\nContent-Type: ${safe(u.file.type || 'application/octet-stream')}\r\n\r\n`;
  const parts = [enc.encode(head + fileHead), new Uint8Array(await u.file.arrayBuffer()), enc.encode(`\r\n--${boundary}--\r\n`)];
  const body = new Uint8Array(new ArrayBuffer(parts.reduce((n, p) => n + p.length, 0)));
  let at = 0;
  for (const p of parts) { body.set(p, at); at += p.length; }
  return { body, type: `multipart/form-data; boundary=${boundary}` };
}

export async function call<T>(method: string, path: string, o: CallOpts = {}): Promise<Result<T>> {
  const url = new URL(path, 'http://x');
  for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined && v !== '') url.searchParams.set(k, v);
  const headers: Record<string, string> = {};
  if (o.version !== undefined) headers['if-match'] = `"${o.version}"`;
  if (o.idempotent) headers['idempotency-key'] = randomUUID();
  let body: BodyInit | undefined;
  if (o.upload) { const m = await multipart(o.upload); headers['content-type'] = m.type; body = m.body; }
  else if (o.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(o.body); }
  try {
    const data = await serverFetch<T>(url.pathname + url.search, { method, headers, ...(body !== undefined ? { body } : {}) });
    return { ok: true, data };
  } catch (e) {
    if (e instanceof ApiError) {
      const p = e.problem;
      const errs = Array.isArray(p['errors']) ? (p['errors'] as Array<{ pointer?: unknown }>) : [];
      return { ok: false, status: e.status, code: p.code, ...(p.request_id ? { requestId: p.request_id } : {}), pointers: errs.map((x) => String(x.pointer ?? '')).filter(Boolean) };
    }
    return { ok: false, status: 503, code: 'common.dependency_unavailable', pointers: [] };
  }
}

/** Page gate (04-UI-UX §1): permissions of the signed-in actor; checked before any API call. */
export async function permissions(): Promise<Set<string>> {
  const s = (await getShellSession()) as { actor?: { permissions?: readonly string[]; membershipId?: string } } | null;
  return new Set(s?.actor?.permissions ?? []);
}
export async function actorMembershipId(): Promise<string | undefined> {
  const s = (await getShellSession()) as { actor?: { membershipId?: string } } | null;
  return s?.actor?.membershipId;
}
