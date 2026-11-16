// Server-side API client for server components / server actions (02-TRD §12.1). Never imported by client code:
// the bearer JWT comes from the session resolved in middleware and must not reach the browser (REQ-SEC-068).
import 'server-only';
import { randomBytes, randomUUID } from 'node:crypto';
import { readBffKey } from '../session/bff-key';
import { getAccessToken } from '../session/server';
import type { Problem } from '../session/types';
import { clientContextHeaders } from './client-context';

let cachedKey: string | undefined;
/** Same cache as c2.ts (LD-174); a failed read (no key in dev/test, or fail-closed env) is not cached and sends no key. */
function bffKey(): string | undefined {
  if (cachedKey) return cachedKey;
  try {
    return (cachedKey = readBffKey());
  } catch {
    return undefined;
  }
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly problem: Problem) {
    super(`${problem.code} (${status})`);
  }
}

export async function serverFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const origin = process.env.LIMS_ORIGIN_API;
  if (!origin) throw new Error('LIMS_ORIGIN_API is not set');
  const token = await getAccessToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  // LD-296: the API honours x-forwarded-for only with a verified BFF key; on 'api' routes the key changes nothing else (notes/T0A-CLIENTIP-1.md).
  for (const [k, v] of Object.entries(await clientContextHeaders())) headers.set(k, v);
  const key = bffKey();
  if (key) headers.set('X-Lims-Bff-Key', key);
  headers.set('x-request-id', randomUUID());
  headers.set('traceparent', `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`);
  headers.set('accept', 'application/json');
  const res = await fetch(new URL(path, origin), { ...init, headers, cache: 'no-store', redirect: 'error' });
  const body = (await res.json().catch(() => undefined)) as unknown;
  if (!res.ok) {
    const p = body as Problem | undefined;
    throw new ApiError(res.status, p?.code ? p : { type: 'urn:lims:error:common.internal', title: 'Internal error', status: res.status, code: 'common.internal' });
  }
  return body as T;
}
