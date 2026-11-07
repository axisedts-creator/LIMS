// @lims/shared-ts/errors (02-TRD §3.1; CV §4.6 problem+json; REQ-SEC-095: no internals in responses).
// Needs T0C-02 `contracts/ports/common.ts` + T0C-05 `contracts/ports/generated/error-codes.ts` — see .orchestra/cr/T0A-08.md.
import { LimsError } from '@lims/contracts/ports/common';
import type { ErrorCode, FieldError, Uuidv7 } from '@lims/contracts/ports/common';
import { ERROR_META } from '@lims/contracts/ports/generated/error-codes';

export { LimsError };
export type { ErrorCode, FieldError };

export interface Problem {
  readonly type: string; readonly title: string; readonly status: number; readonly code: ErrorCode;
  readonly detail?: string; readonly instance: string; readonly request_id: string; readonly errors?: readonly FieldError[];
}

/** [CONV] ERROR_META shape `{ http, title }` per errors.yaml row (gen-error-codes, 02-TRD §5.3). */
const META = ERROR_META as Readonly<Record<string, { readonly http: number; readonly title: string }>>;

export const ERROR_HTTP: Readonly<Record<ErrorCode, number>> = Object.freeze(
  Object.fromEntries(Object.entries(META).map(([k, m]) => [k, m.http])),
) as Readonly<Record<ErrorCode, number>>;

export function isLimsError(e: unknown, code?: ErrorCode): e is LimsError {
  return e instanceof LimsError && (code === undefined || e.code === code);
}

/** Any throwable -> CV §4.6 Problem. Non-LimsError (or unregistered code) -> 500 common.internal with request_id only. */
export function toProblem(err: unknown, instance: string, requestId: Uuidv7): Problem {
  const known = isLimsError(err) && Object.hasOwn(META, err.code) ? err : undefined;
  const code = (known ? known.code : 'common.internal') as ErrorCode;
  const m = META[code]!;
  const p: { -readonly [K in keyof Problem]: Problem[K] } = { type: `urn:lims:error:${code}`, title: m.title, status: m.http, code, instance, request_id: requestId };
  if (typeof known?.safeDetail === 'string') p.detail = known.safeDetail;
  if (known?.fieldErrors?.length) p.errors = known.fieldErrors.map((f: FieldError) => ({ path: f.path, code: f.code, message: f.message }));
  return p;
}
