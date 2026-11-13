import 'server-only';
// Shared BFF plumbing for the C10 T-24 server functions (02-CONVENTIONS §2.4): every id / code is validated here so tampered values never
// reach an API path (REQ-SEC-026/027); only declared fields are forwarded (no mass assignment).
import { ApiError } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import { IDEMPOTENCY_KEY_RE, MICRO_CODE_RE, UUID_RE, type ActionResult, type FieldError } from './types';

export const bad = () => new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));

export const uuid = (v: unknown): string => {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw bad();
  return v;
};
export const microCode = (v: unknown): string => {
  if (typeof v !== 'string' || !MICRO_CODE_RE.test(v)) throw bad();
  return v;
};
export const oneOf = <T extends string>(vals: readonly T[], v: unknown): T => {
  if (typeof v !== 'string' || !(vals as readonly string[]).includes(v)) throw bad();
  return v as T;
};
export const version = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw bad();
  return v;
};
export const idemKey = (v: unknown): string => {
  if (typeof v !== 'string' || !IDEMPOTENCY_KEY_RE.test(v)) throw bad();
  return v;
};
/** Strict JSON body: `spec` lists the allowed keys with a checker each; unknown keys are dropped, `required` ones must be present. */
export function pick(input: unknown, spec: Record<string, (v: unknown) => unknown>, required: readonly string[] = []): Record<string, unknown> {
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
export const text = (min: number, max: number) => (v: unknown) => {
  if (typeof v !== 'string' || v.trim().length < min || v.length > max) throw bad();
  return v;
};
export const intIn = (min: number, max: number) => (v: unknown) => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw bad();
  return v;
};
export const flag = (v: unknown) => {
  if (typeof v !== 'boolean') throw bad();
  return v;
};
export const arrayOf = (max: number, item: (v: unknown) => unknown, min = 0) => (v: unknown) => {
  if (!Array.isArray(v) || v.length < min || v.length > max) throw bad();
  return v.map(item);
};

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
      return { ok: false, status: e.status, code: e.problem.code, ...(Array.isArray(errors) ? { errors: errors as FieldError[] } : {}) };
    }
    throw e;
  }
}
