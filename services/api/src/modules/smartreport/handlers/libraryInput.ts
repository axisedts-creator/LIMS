// Request parsing for the library operations #1-#21: a closed-shape body checker (unknown field = 400, mass assignment), If-Match, DB-error mapping.
// Error paths are JSON pointers; messages are fixed text, so no submitted value is ever echoed.
import { LimsError, type FieldError } from '../../../core/errors.js';
import type { Handler } from '../../../core/module.js';
import { mapDbError } from '../library.service.js';
import { invalidField, isObj } from './shared.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_KEY = /^[A-Za-z0-9_]{1,64}$/;
const len = (s: string): number => [...s].length;

export type Field =
  | { t: 'str'; max: number; min?: number; re?: RegExp; req?: boolean }
  | { t: 'int'; min: number; max: number; req?: boolean }
  | { t: 'bool' | 'true' | 'uuid'; req?: boolean }
  | { t: 'enum'; of: readonly string[]; req?: boolean }
  | { t: 'obj'; fields: Schema; req?: boolean };
export type Schema = Readonly<Record<string, Field>>;

export const fieldError = (path: string, code = 'common.field_invalid', message = 'Field invalid'): FieldError => ({ path, code, message });
export const validationFailed = (errors: readonly FieldError[]): LimsError => new LimsError('common.validation_failed', undefined, errors);

/** Every violation of `schema` by `input` (closed shape: keys outside the schema are refused). */
export function check(input: unknown, schema: Schema, base = ''): FieldError[] {
  if (!isObj(input)) return [fieldError(base === '' ? '/' : base)];
  const errs: FieldError[] = [];
  for (const k of Object.keys(input)) if (!Object.hasOwn(schema, k)) errs.push(fieldError(`${base}/${SAFE_KEY.test(k) ? k : ''}`, 'common.unknown_field', 'Unknown field'));
  for (const [k, f] of Object.entries(schema)) {
    const v = input[k];
    const p = `${base}/${k}`;
    if (v === undefined) { if (f.req) errs.push(fieldError(p, 'common.field_required', 'Field required')); continue; }
    if (f.t === 'obj') { errs.push(...check(v, f.fields, p)); continue; }
    const ok = f.t === 'str' ? typeof v === 'string' && len(v) <= f.max && len(v) >= (f.min ?? 0) && ((f.min ?? 0) === 0 || v.trim() !== '') && (f.re === undefined || f.re.test(v))
      : f.t === 'int' ? typeof v === 'number' && Number.isInteger(v) && v >= f.min && v <= f.max
      : f.t === 'bool' ? typeof v === 'boolean'
      : f.t === 'true' ? v === true
      : f.t === 'enum' ? typeof v === 'string' && f.of.includes(v)
      : typeof v === 'string' && UUID.test(v);
    if (!ok) errs.push(fieldError(p));
  }
  return errs;
}

/** Body that must satisfy `schema`, else 400 common.validation_failed with every violation. */
export function parseBody<T = Record<string, any>>(body: unknown, schema: Schema, extra?: (b: Record<string, any>, errs: FieldError[]) => void): T {
  const errs = check(body, schema);
  if (errs.length === 0 && extra) extra(body as Record<string, any>, errs);
  if (errs.length > 0) throw validationFailed(errs);
  return body as T;
}

/** `{}` or no body (validate / submit take no input). */
export function assertNoBody(body: unknown): void {
  if (body !== undefined && body !== null && !(isObj(body) && Object.keys(body).length === 0)) throw validationFailed([fieldError('/')]);
}

/** If-Match "<version>" (02-CV §4.2): absent -> 428 when required (else undefined); malformed -> 400. */
export function ifMatch(headers: unknown, required = true): number | undefined {
  const h = isObj(headers) ? headers['if-match'] : undefined;
  if (h === undefined) { if (required) throw new LimsError('common.precondition_required'); return undefined; }
  const m = typeof h === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(h) : null;
  if (!m || Number(m[1]) > 2_147_483_647) throw invalidField('If-Match');
  return Number(m[1]);
}

export const param = (req: { params: unknown }, name: string): unknown => (isObj(req.params) ? req.params[name] : undefined);
export const query = (req: { query: unknown }): Record<string, unknown> => (isObj(req.query) ? req.query : {});
export const nfc = (s: string | undefined): string | undefined => s?.normalize('NFC');

/** Runs a handler and maps DB errors (triggers, unique indexes, FKs) to API errors. */
export const mapped = (h: Handler): Handler => async (req, ctx) => {
  try { return await h(req, ctx); } catch (e) { throw mapDbError(e); }
};
