import 'server-only';
// Shared BFF plumbing for the C11 T-19 server functions (02-CONVENTIONS §2.4): every id is validated here (isUuid) so tampered values never
// reach an API path (REQ-SEC-026/027); only declared fields are forwarded (no mass assignment).
// LD-140 (2026-11-13): no UI in this file.
import { ApiError } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import { IDEMPOTENCY_KEY_RE, UUID_RE, type ActionResult, type FieldError } from './types';

export const bad = () => new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));

export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
export const uuid = (v: unknown): string => {
  if (!isUuid(v)) throw bad();
  return v;
};
export const version = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw bad();
  return v;
};
export const idemKey = (v: unknown): string => {
  if (typeof v !== 'string' || !IDEMPOTENCY_KEY_RE.test(v)) throw bad();
  return v;
};
/** If-Match header value for a row version (strong ETag form, `"5"`). */
export const ifMatch = (v: unknown) => `"${version(v)}"`;

export const jsonInit = (method: 'POST' | 'PUT', body: unknown, headers: Record<string, string>): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

/** Pages (server components): 403 → null (render the "no access" state); every other failure throws to error.tsx. */
export async function orForbidden<T>(f: () => Promise<T>): Promise<T | null> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) return null;
    throw e;
  }
}
/** Detail pages: unknown / malformed id (404, 400) → undefined (the page calls notFound()). */
export async function orMissing<T>(f: () => Promise<T>): Promise<T | undefined> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 400)) return undefined;
    throw e;
  }
}

/** Server-action wrapper: only ApiError is mapped to data; anything else rethrows. */
export async function run<T>(f: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await f() };
  } catch (e) {
    if (e instanceof ApiError) {
      const errors = e.problem['errors'];
      const requestId = e.problem.request_id;
      const detail = e.problem['detail']; // T-23: validation messages of the configuration forms (plain text, never HTML)
      return {
        ok: false, status: e.status, code: e.problem.code,
        ...(typeof requestId === 'string' ? { requestId } : {}),
        ...(typeof detail === 'string' && detail ? { detail: detail.slice(0, 300) } : {}),
        ...(Array.isArray(errors) ? { errors: errors as FieldError[] } : {}),
      };
    }
    throw e;
  }
}
