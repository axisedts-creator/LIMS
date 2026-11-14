import 'server-only';
// Shared BFF plumbing for the catalog server functions (02-CONVENTIONS §2.4). Input is validated here so tampered
// values never reach the API; only the known fields of each operation are forwarded (no mass assignment).
import { randomUUID } from 'node:crypto';
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import { CODE_RE, IDEMPOTENCY_KEY_RE, UUID_RE, type ListQuery, type Page } from './types';

export const bad = () => new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));

/** Pages: 403 → null (render the "no access" page); every other failure throws to error.tsx. */
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

export type V =(v: unknown) => unknown;
export const str = (min: number, max: number): V => (v) => {
  if (typeof v !== 'string' || v.trim().length < min || v.length > max) throw bad();
  return v;
};
export const int = (min: number, max: number): V => (v) => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw bad();
  return v;
};
export const bool: V = (v) => {
  if (typeof v !== 'boolean') throw bad();
  return v;
};
export const uuid: V = (v) => {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw bad();
  return v;
};
/** Trim + upper-case, then match (codes are upper-case in the catalog). */
export const upperCode = (re: RegExp = CODE_RE): V => (v) => {
  const c = typeof v === 'string' ? v.trim().toUpperCase() : '';
  if (!re.test(c)) throw bad();
  return c;
};
export const exactCode = (re: RegExp): V => (v) => {
  if (typeof v !== 'string' || !re.test(v)) throw bad();
  return v;
};
export const oneOf = (...vals: readonly string[]): V => (v) => {
  if (typeof v !== 'string' || !vals.includes(v)) throw bad();
  return v;
};
export const list = (max: number, item: (v: unknown) => unknown): V => (v) => {
  if (!Array.isArray(v) || v.length > max) throw bad();
  return v.map(item);
};

/** Copies only the fields named in `spec`, each validated; `required` ones must be present. */
export function pick(input: unknown, spec: Record<string, V>, required: readonly string[] = []): Record<string, unknown> {
  if (typeof input !== 'object' || input === null) throw bad();
  const o = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, check] of Object.entries(spec)) {
    if (o[k] === undefined) {
      if (required.includes(k)) throw bad();
      continue;
    }
    out[k] = check(o[k]);
  }
  return out;
}

export function listQs(q: ListQuery & { scope?: unknown }, scopes?: readonly string[]): string {
  const p = new URLSearchParams();
  if (q.scope !== undefined) {
    if (typeof q.scope !== 'string' || !scopes?.includes(q.scope)) throw bad();
    p.set('scope', q.scope);
  }
  if (q.isActive !== undefined) p.set('is_active', q.isActive === 'all' ? 'all' : String(bool(q.isActive))); // 'all' = include inactive (API default is "true")
  if (q.limit !== undefined) p.set('limit', String(int(1, 200)(q.limit)));
  if (q.cursor !== undefined) p.set('cursor', String(str(1, 512)(q.cursor)));
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** `listQs` plus extra, already-validated params (undefined skipped). */
export function qsOf(q: ListQuery, extra: Record<string, unknown> = {}): string {
  const p = new URLSearchParams(listQs(q).slice(1));
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}
export const opt = (check: V, v: unknown) => (v === undefined ? undefined : check(v));

/** Same as `createOf`, but a blank optional string field (e.g. the auto-assigned code) is dropped instead of validated. */
export function dropBlank(input: unknown, key: string): unknown {
  if (typeof input !== 'object' || input === null) return input;
  const o = input as Record<string, unknown>;
  if (typeof o[key] !== 'string' || (o[key] as string).trim() !== '') return input;
  const { [key]: _, ...rest } = o;
  return rest;
}

export const listOf =<T>(seg: string) => async (q: ListQuery = {}) => serverFetch<Page<T>>(`/v1/catalog/${seg}${listQs(q)}`);

export function createOf<T>(seg: string, spec: Record<string, V>, required: readonly string[]) {
  return async (input: unknown, idempotencyKey?: string): Promise<T> => {
    const body = pick(input, spec, required);
    if (idempotencyKey !== undefined && !(typeof idempotencyKey === 'string' && IDEMPOTENCY_KEY_RE.test(idempotencyKey))) throw bad();
    return serverFetch<T>(`/v1/catalog/${seg}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey ?? randomUUID() },
      body: JSON.stringify(body),
    });
  };
}

export function updateOf<T>(seg: string, spec: Record<string, V>) {
  return async (id: string, version: number, input: unknown): Promise<T> => {
    uuid(id);
    int(1, Number.MAX_SAFE_INTEGER)(version);
    const body = pick(input, spec);
    return serverFetch<T>(`/v1/catalog/${seg}/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': `"${version}"` },
      body: JSON.stringify(body),
    });
  };
}
