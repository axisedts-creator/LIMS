// Request validation of #1-#13 (defence in depth behind the core's schema check, REQ-SEC-080). Rules = DB CHECKs of 05-SCHEMA §2 / 02-TRD §5.1.
// Fixed messages only: no submitted value is ever echoed. Unknown fields are rejected (mass assignment, 07-SECURITY S-03).
import { LimsError, type FieldError } from '../../../core/errors.js';

type Obj = Record<string, any>;
export const LOT_NO = /^[\x21-\x7E]([\x20-\x7E]{0,62}[\x21-\x7E])?$/;   // = control_lots__lot__ck = quality.yaml ControlLotDto.lot_no
const CODE = /^[A-Z0-9_-]{2,32}$/, LEVEL_CODE = /^[A-Za-z0-9]{1,16}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MSG = { 'common.field_required': 'Field required', 'common.field_invalid': 'Field invalid', 'common.unknown_field': 'Unknown field' } as const;

export class Errs {
  readonly list: FieldError[] = [];
  add(path: string, code: keyof typeof MSG = 'common.field_invalid'): void { this.list.push({ path, code, message: MSG[code] }); }
  done(): void { if (this.list.length) throw new LimsError('common.validation_failed', undefined, this.list); }
}
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const len = (s: string) => [...s].length;                     // char_length counts code points
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
export const isIsoDate = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && v >= '1900-01-01' && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

/** Returns the object, or records a root error. Unknown keys are recorded at `${at}/${key}`. */
function shape(e: Errs, v: unknown, allowed: readonly string[], at = ''): Obj | undefined {
  if (!isObj(v)) { e.add(at || '/'); return undefined; }
  for (const k of Object.keys(v)) if (!allowed.includes(k)) e.add(`${at}/${k}`, 'common.unknown_field');
  return v;
}
const str = (e: Errs, o: Obj, k: string, at: string, p: { min: number; max: number; re?: RegExp; required?: boolean }): string | undefined => {
  const v = o[k];
  if (v === undefined) { if (p.required) e.add(`${at}/${k}`, 'common.field_required'); return undefined; }
  if (typeof v !== 'string' || len(v) < p.min || len(v) > p.max || (p.re && !p.re.test(v))) { e.add(`${at}/${k}`); return undefined; }
  return v;
};
const int = (e: Errs, o: Obj, k: string, at: string, min: number, max: number, required: boolean): number | undefined => {
  const v = o[k];
  if (v === undefined) { if (required) e.add(`${at}/${k}`, 'common.field_required'); return undefined; }
  if (!Number.isInteger(v) || v < min || v > max) { e.add(`${at}/${k}`); return undefined; }
  return v;
};
const bool = (e: Errs, o: Obj, k: string): boolean | undefined => {
  if (o[k] === undefined) return undefined;
  if (typeof o[k] !== 'boolean') { e.add(`/${k}`); return undefined; }
  return o[k];
};

// ---------------------------------------------------------------------------------------------------- bodies
interface LevelIn { level_code: string; display_name: string; sort_order: number }
function levelIn(e: Errs, v: unknown, at: string): LevelIn | undefined {
  const o = shape(e, v, ['level_code', 'display_name', 'sort_order'], at); if (!o) return undefined;
  const level_code = str(e, o, 'level_code', at, { min: 1, max: 16, re: LEVEL_CODE, required: true });
  const display_name = str(e, o, 'display_name', at, { min: 1, max: 60, required: true });
  const sort_order = int(e, o, 'sort_order', at, 0, 99, true);
  return level_code !== undefined && display_name !== undefined && sort_order !== undefined ? { level_code, display_name, sort_order } : undefined;
}

export function materialCreate(body: unknown) {
  const e = new Errs(), o = shape(e, body, ['code', 'name', 'manufacturer', 'matrix', 'levels'])!;
  if (!o) return e.done() as never;
  const code = str(e, o, 'code', '', { min: 2, max: 32, re: CODE, required: true });
  const name = str(e, o, 'name', '', { min: 1, max: 120, required: true });
  const manufacturer = str(e, o, 'manufacturer', '', { min: 1, max: 120 });
  const matrix = str(e, o, 'matrix', '', { min: 1, max: 60 });
  const levels: LevelIn[] = [];
  if (o['levels'] === undefined) e.add('/levels', 'common.field_required');
  else if (!Array.isArray(o['levels']) || o['levels'].length < 1 || o['levels'].length > 6) e.add('/levels');
  else o['levels'].forEach((l, i) => { const x = levelIn(e, l, `/levels/${i}`); if (x) levels.push(x); });
  e.done();
  return { code: code!, name: name!, manufacturer, matrix, levels };
}

export function materialPatch(body: unknown) {
  const e = new Errs(), o = shape(e, body, ['name', 'manufacturer', 'matrix', 'unset']);
  if (!o) return e.done() as never;
  const patch: Obj = {};
  const name = str(e, o, 'name', '', { min: 1, max: 120 }); if (name !== undefined) patch['name'] = name;
  const manufacturer = str(e, o, 'manufacturer', '', { min: 1, max: 120 }); if (manufacturer !== undefined) patch['manufacturer'] = manufacturer;
  const matrix = str(e, o, 'matrix', '', { min: 1, max: 60 }); if (matrix !== undefined) patch['matrix'] = matrix;
  if (o['unset'] !== undefined) {
    if (!Array.isArray(o['unset'])) e.add('/unset');
    else o['unset'].forEach((k, i) => {
      if ((k !== 'manufacturer' && k !== 'matrix') || k in patch) e.add(`/unset/${i}`); else patch[k] = null;   // null clears the column
    });
  }
  e.done();
  return patch;
}

export function levelCreate(body: unknown): LevelIn {
  const e = new Errs(), x = levelIn(e, body, ''); e.done(); return x!;
}
export function levelPatch(body: unknown) {
  const e = new Errs(), o = shape(e, body, ['display_name', 'sort_order', 'is_active']);
  if (!o) return e.done() as never;
  const patch: Obj = {};
  const dn = str(e, o, 'display_name', '', { min: 1, max: 60 }); if (dn !== undefined) patch['display_name'] = dn;
  const so = int(e, o, 'sort_order', '', 0, 99, false); if (so !== undefined) patch['sort_order'] = so;
  const ia = bool(e, o, 'is_active'); if (ia !== undefined) patch['is_active'] = ia;
  e.done();
  return patch;
}

export function lotCreate(body: unknown) {
  const e = new Errs(), o = shape(e, body, ['lot_no', 'expires_on']);
  if (!o) return e.done() as never;
  const lot_no = str(e, o, 'lot_no', '', { min: 1, max: 64, re: LOT_NO, required: true });
  const expires_on = dateField(e, o, true);
  e.done();
  return { lot_no: lot_no!, expires_on: expires_on! };
}
function dateField(e: Errs, o: Obj, required: boolean): string | undefined {
  if (o['expires_on'] === undefined) { if (required) e.add('/expires_on', 'common.field_required'); return undefined; }
  if (!isIsoDate(o['expires_on'])) { e.add('/expires_on'); return undefined; }
  return o['expires_on'];
}
export function lotPatch(body: unknown) {
  const e = new Errs(), o = shape(e, body, ['expires_on', 'is_active']);
  if (!o) return e.done() as never;
  const patch: Obj = {};
  const x = dateField(e, o, false); if (x !== undefined) patch['expires_on'] = x;
  const ia = bool(e, o, 'is_active'); if (ia !== undefined) patch['is_active'] = ia;
  e.done();
  return patch;
}

export function mapCreate(body: unknown) {
  const e = new Errs(), o = shape(e, body, ['instrument_id', 'control_id_raw', 'control_lot_raw', 'lot_id']);
  if (!o) return e.done() as never;
  const uuid = (k: string) => {
    if (o[k] === undefined) { e.add(`/${k}`, 'common.field_required'); return undefined; }
    if (!isUuid(o[k])) { e.add(`/${k}`); return undefined; }
    return o[k] as string;
  };
  const instrument_id = uuid('instrument_id'), lot_id = uuid('lot_id');
  const control_id_raw = str(e, o, 'control_id_raw', '', { min: 1, max: 64, required: true });
  const control_lot_raw = str(e, o, 'control_lot_raw', '', { min: 1, max: 64 });   // null is not accepted: absent = any lot
  e.done();
  return { instrument_id: instrument_id!, lot_id: lot_id!, control_id_raw: control_id_raw!, control_lot_raw };
}

// ---------------------------------------------------------------------------------------------------- list queries
export interface Paging { limit: number; cursor?: string }
export function paging(e: Errs, q: Obj): Paging {
  let limit = 50;
  if (q['limit'] !== undefined) { if (!Number.isInteger(q['limit']) || q['limit'] < 1 || q['limit'] > 200) e.add('/limit'); else limit = q['limit']; }
  let cursor: string | undefined;
  if (q['cursor'] !== undefined) { if (typeof q['cursor'] !== 'string' || q['cursor'].length < 1 || q['cursor'].length > 512) e.add('/cursor'); else cursor = q['cursor']; }
  return { limit, ...(cursor !== undefined ? { cursor } : {}) };
}
export const qUuid = (e: Errs, q: Obj, k: string, path: string): string | undefined => {
  if (q[k] === undefined) return undefined;
  if (!isUuid(q[k])) { e.add(`/${path}`); return undefined; }
  return q[k];
};
export const qBool = (e: Errs, q: Obj, k: string, path: string): boolean | undefined => {
  if (q[k] === undefined) return undefined;
  if (typeof q[k] !== 'boolean') { e.add(`/${path}`); return undefined; }
  return q[k];
};
export const qEnum = <V extends string>(e: Errs, q: Obj, k: string, allowed: readonly V[]): V => {
  if (q[k] === undefined) return allowed[0]!;
  if (!allowed.includes(q[k])) { e.add(`/${k}`); return allowed[0]!; }
  return q[k];
};
