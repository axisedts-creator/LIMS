import 'server-only';
// Shared by the WEB-T03 server functions: local validation failure (thrown BEFORE any network call) and the If-Match header.
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { getShellSession } from '@/core/session/server';
import { problem } from '@/core/session/types';
import { IDEMPOTENCY_KEY_RE, UUID_RE, type Instrument } from './types';

export const badRequest = () => new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
export const notFound = () => new ApiError(404, problem('common.not_found', 'Not found', 404));

/** Throws 400 unless the id is a UUID and the version a positive integer; returns the If-Match header value. */
export function ifMatch(id: string, version: number): string {
  if (typeof id !== 'string' || !UUID_RE.test(id) || !Number.isInteger(version) || version < 1) throw badRequest();
  return `"${version}"`;
}

export const JSON_HEADERS = { 'content-type': 'application/json' } as const;

/** WEB-T04 D-39 / S-04: C3 code-map calls need the SESSION permission (exact match); otherwise 403 before any network call. */
export async function requirePermission(permission: string): Promise<void> {
  const s = await getShellSession();
  if (!s?.actor.permissions?.includes(permission)) throw new ApiError(403, problem('auth.forbidden', 'Forbidden', 403));
}

/** Idempotency-Key header value or 400 (a retry must reuse the caller's key, so none is minted here). */
export function idemKey(k: unknown): string {
  if (typeof k !== 'string' || !IDEMPOTENCY_KEY_RE.test(k)) throw badRequest();
  return k;
}

/** E27–E31: POST /v1/instruments/instruments/{id}/{action} with If-Match. Id/version are checked before any network call. */
export function postTransition(id: string, version: number, action: 'start-commissioning' | 'go-live' | 'suspend' | 'resume' | 'retire', body: object = {}): Promise<Instrument> {
  const match = ifMatch(id, version);
  return serverFetch<Instrument>(`/v1/instruments/instruments/${id}/${action}`, { method: 'POST', headers: { ...JSON_HEADERS, 'if-match': match }, body: JSON.stringify(body) });
}

/** Free-text reason for suspend/retire: 3–300 characters (04-UI-UX SCR-07). Returns the trimmed text or throws 400. */
export function reasonText(v: unknown): string {
  const t = typeof v === 'string' ? v.trim() : '';
  if (t.length < 3 || t.length > 300) throw badRequest();
  return t;
}
