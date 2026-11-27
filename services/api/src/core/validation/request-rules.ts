// Request-rule helpers shared by modules (moved from partners/domain/partyset.rules.ts so catalog need not import that module; 02-CONVENTIONS §1.3).
// Every rule failure is common.validation_failed with the JSON pointer of the field; messages are fixed text, no submitted value is echoed.
import { LimsError, type FieldError } from '../errors.js';

export type Obj = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const fe = (path: string, code: string, message: string): FieldError => ({ path, code, message } as FieldError);
export const invalid = (...paths: string[]): LimsError =>
  new LimsError('common.validation_failed', undefined, paths.map((p) => fe(p, 'common.field_invalid', 'Field invalid')));

/** a real calendar date YYYY-MM-DD */
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Collects every field error of one request; done() throws them together. */
export class Checker {
  readonly errors: FieldError[] = [];
  readonly src: Obj;
  constructor(raw: unknown, allowed?: readonly string[]) {
    this.src = isObj(raw) ? raw : {};
    if (!isObj(raw)) this.errors.push(fe('/', 'common.field_invalid', 'Body must be an object'));
    else if (allowed) for (const k of Object.keys(raw)) if (!allowed.includes(k)) this.errors.push(fe(`/${k}`, 'common.unknown_field', 'Unknown field'));
  }
  bad(path: string): undefined { this.errors.push(fe(path, 'common.field_invalid', 'Field invalid')); return undefined; }
  private has(k: string, required: boolean): boolean {
    if (this.src[k] !== undefined) return true;
    if (required) this.errors.push(fe(`/${k}`, 'common.field_required', 'Field required'));
    return false;
  }
  bool(k: string): boolean | undefined { if (!this.has(k, false)) return undefined; const v = this.src[k]; return typeof v === 'boolean' ? v : this.bad(`/${k}`); }
  int(k: string, min: number, max: number, required = false): number | undefined {
    if (!this.has(k, required)) return undefined;
    const v = this.src[k];
    return typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max ? v : this.bad(`/${k}`);
  }
  oneOf<T extends string>(k: string, set: readonly T[], required = false): T | undefined {
    if (!this.has(k, required)) return undefined;
    const v = this.src[k];
    return typeof v === 'string' && (set as readonly string[]).includes(v) ? (v as T) : this.bad(`/${k}`);
  }
  text(k: string, max: number, required = false, re?: RegExp): string | undefined {
    if (!this.has(k, required)) return undefined;
    const v = this.src[k];
    if (typeof v !== 'string' || v.length < 1 || [...v].length > max || v.includes('\u0000') || (re && !re.test(v)) || (!re && v.trim() === '')) return this.bad(`/${k}`);
    return v;
  }
  uuid(k: string, required = false): string | undefined {
    if (!this.has(k, required)) return undefined;
    const v = this.src[k];
    return isUuid(v) ? v.toLowerCase() : this.bad(`/${k}`);
  }
  date(k: string, required = false): string | undefined {
    if (!this.has(k, required)) return undefined;
    const v = this.src[k];
    return isIsoDate(v) ? v : this.bad(`/${k}`);
  }
  done(): void { if (this.errors.length > 0) throw new LimsError('common.validation_failed', undefined, this.errors); }
}

/** If-Match "<n>": missing -> precondition_required, malformed -> validation */
export function ifMatch(headers: unknown, required = true): number | undefined {
  const h = isObj(headers) ? headers['if-match'] : undefined;
  if (h === undefined) { if (required) throw new LimsError('common.precondition_required'); return undefined; }
  const m = typeof h === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(h) : null;
  if (!m || Number(m[1]) > 2147483647) throw invalid('/headers/if-match');
  return Number(m[1]);
}
