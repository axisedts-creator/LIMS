// Platform console server helpers: session/permission gate and API reads via core serverFetch (REQ-SEC-068: the bearer stays server-side).
import 'server-only';
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { getShellSession } from '@/core/session/server';
import type { Fail, Result } from './shared';

export const P = '/v1/identity/platform';

/** Permissions of a platform session; empty for any other session kind (CR-C2-009: tenant staff never reach platform data). */
export async function platformPermissions(): Promise<ReadonlySet<string>> {
  const s = await getShellSession();
  if (!s || s.kind !== 'platform') return new Set();
  return new Set(s.actor.permissions);
}

export function toFail(e: unknown): Fail {
  if (e instanceof ApiError) {
    return { ok: false, status: e.status, code: e.problem.code, ...(typeof e.problem.request_id === 'string' ? { requestId: e.problem.request_id } : {}) };
  }
  return { ok: false, status: 503, code: 'common.dependency_unavailable' };
}

/** Reads/writes never throw: callers render an ErrorState or an inline alert from the Fail. */
export async function call<T>(path: string, init: RequestInit = {}): Promise<Result<T>> {
  try {
    return { ok: true, data: await serverFetch<T>(path, init) };
  } catch (e) {
    return toFail(e);
  }
}

export const qs = (q: Record<string, string | undefined>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') u.set(k, v);
  const s = u.toString();
  return s ? `?${s}` : '';
};

export type SP = Promise<Record<string, string | string[] | undefined>>;
export const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
