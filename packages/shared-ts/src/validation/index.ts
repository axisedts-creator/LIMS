// @lims/shared-ts/validation (02-TRD §3.1; CV §4.7; REQ-SEC-080 unknown fields rejected, REQ-SEC-095 no value echo).
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import { LimsError, type FieldError, type ErrorCode } from '../errors/index.ts';

const ajv = new Ajv({ strict: true, allErrors: true, removeAdditional: false, coerceTypes: false, useDefaults: false });
const cache = new WeakMap<object, ValidateFunction>();
/** [CONV] cap on reported field errors (bounded response size). */
const MAX_FIELD_ERRORS = 100;

function compiled(schema: object): ValidateFunction {
  let fn = cache.get(schema);
  if (!fn) { fn = ajv.compile(schema); cache.set(schema, fn); }
  return fn;
}

export function compileSchema<T>(schema: object): (v: unknown) => v is T {
  const fn = compiled(schema);
  return (v: unknown): v is T => fn(v) === true;
}

const esc = (k: string) => k.replace(/~/g, '~0').replace(/\//g, '~1');

function toFieldError(e: ErrorObject, prefix: string): FieldError {
  const p = e.params as { missingProperty?: string; additionalProperty?: string };
  if (e.keyword === 'required' && p.missingProperty !== undefined)
    return { path: `${prefix}${e.instancePath}/${esc(p.missingProperty)}`, code: 'common.field_required' as ErrorCode, message: 'is required' };
  if (e.keyword === 'additionalProperties' && p.additionalProperty !== undefined)
    return { path: `${prefix}${e.instancePath}/${esc(p.additionalProperty)}`, code: 'common.unknown_field' as ErrorCode, message: 'is not allowed' };
  // ajv messages describe the constraint (never the rejected value).
  return { path: `${prefix}${e.instancePath}`, code: 'common.field_invalid' as ErrorCode, message: e.message ?? 'is invalid' };
}

/** Returns `v` when valid; else throws LimsError('common.validation_failed', …, fieldErrors). `path` is a JSON-pointer prefix. */
export function assertValid<T>(schema: object, v: unknown, path = ''): T {
  const fn = compiled(schema);
  if (fn(v)) return v as T;
  const fieldErrors = (fn.errors ?? []).slice(0, MAX_FIELD_ERRORS).map((e) => toFieldError(e, path));
  throw new LimsError('common.validation_failed' as ErrorCode, 'Request validation failed', fieldErrors);
}
