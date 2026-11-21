// T0B-SALES-1 (LD-321): request rules of the sales hierarchy, checked here BEFORE any SQL write (done_when (2)); the DB CHECKs / triggers of
// 20261117210000_partners__add_sales_hierarchy.sql are only the concurrent backstop. A failure = common.validation_failed with a JSON-pointer field path;
// messages are fixed text, so no submitted value (phone, e-mail, name) is ever echoed.
import { LimsError, type FieldError } from '../../../core/errors.js';

export type Obj = Record<string, unknown>;
export const PARTY_KINDS = ['partner', 'credit_party', 'doctor', 'referrer'] as const;
export type PartyKind = (typeof PARTY_KINDS)[number];
export const MAX_TREE_DEPTH = 8;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PHONE = /^\+[1-9][0-9]{7,14}$/;   // contract pattern (E.164)

export const invalid = (path: string, code: 'common.field_invalid' | 'common.unknown_field' | 'common.field_required' = 'common.field_invalid'): LimsError =>
  new LimsError('common.validation_failed', undefined, [{ path, code, message: code === 'common.unknown_field' ? 'Unknown field' : code === 'common.field_required' ? 'Field required' : 'Field invalid' } as FieldError]);
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

export function bodyOf(raw: unknown, allowed: readonly string[], opts: { optional?: boolean } = {}): Obj {
  if (raw === undefined && opts.optional) return {};
  if (!isObj(raw)) throw invalid('');
  for (const k of Object.keys(raw)) if (!allowed.includes(k)) throw invalid(`/${k}`, 'common.unknown_field');
  return raw;
}

/** trimmed text 1..max (no NUL); undefined when absent and not required */
export function text(b: Obj, k: string, max: number, required: boolean): string | undefined {
  const v = b[k];
  if (v === undefined) { if (required) throw invalid(`/${k}`, 'common.field_required'); return undefined; }
  if (typeof v !== 'string' || v.includes('\u0000') || v.trim() === '' || [...v].length > max) throw invalid(`/${k}`);
  return v.trim();
}
export function uuid(b: Obj, k: string, required: boolean): string | undefined {
  const v = b[k];
  if (v === undefined) { if (required) throw invalid(`/${k}`, 'common.field_required'); return undefined; }
  if (!isUuid(v)) throw invalid(`/${k}`);
  return v;
}
/** a real calendar date YYYY-MM-DD (2026-02-30 is refused) */
export function isoDate(v: unknown, path: string): string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw invalid(path);
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw invalid(path);
  return v;
}
export const optDate = (b: Obj, k: string): string | undefined => (b[k] === undefined ? undefined : isoDate(b[k], `/${k}`));
/** designation level: integer 1..8 (no strings, no fractions) */
export function level(v: unknown, path = '/level'): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 8) throw invalid(path);
  return v;
}
export function phone(b: Obj): string | undefined {
  const v = b['phone'];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !PHONE.test(v)) throw invalid('/phone');
  return v;
}
export function email(b: Obj): string | undefined {
  const v = b['email'];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length < 3 || v.length > 254 || /\s/.test(v)) throw invalid('/email');
  return v;
}
export function partyKind(v: unknown, path = '/party_kind'): PartyKind {
  if (typeof v !== 'string' || !(PARTY_KINDS as readonly string[]).includes(v)) throw invalid(path);
  return v as PartyKind;
}
/** `unset` list: unique names out of `allowed`, none of them also sent with a value */
export function unsetList(b: Obj, allowed: readonly string[]): string[] {
  const u = b['unset'];
  if (u === undefined) return [];
  if (!Array.isArray(u) || new Set(u).size !== u.length) throw invalid('/unset');
  u.forEach((x, i) => { if (typeof x !== 'string' || !allowed.includes(x) || b[x] !== undefined) throw invalid(`/unset/${i}`); });
  return u as string[];
}

// ---- query values (the core coerces query strings; direct calls may pass strings or native values) ----
export function qBool(q: Obj, k: string): boolean | undefined {
  const v = q[k];
  if (v === undefined) return undefined;
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  throw invalid(`/${k}`);
}
export function qInt(q: Obj, k: string, min: number, max: number): number | undefined {
  const v = q[k];
  if (v === undefined) return undefined;
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d{1,10}$/.test(v) ? Number(v) : Number.NaN;
  if (!Number.isInteger(n) || n < min || n > max) throw invalid(`/${k}`);
  return n;
}
export function qText(q: Obj, k: string, max: number): string | undefined {
  const v = q[k];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v === '' || v.includes('\u0000') || [...v].length > max) throw invalid(`/${k}`);
  return v;
}
export const qUuid = (q: Obj, k: string): string | undefined => (q[k] === undefined ? undefined : isUuid(q[k]) ? (q[k] as string) : (() => { throw invalid(`/${k}`); })());

/** If-Match "<n>": missing -> 428, malformed -> 400 (partner.service [CONV]) */
export function ifMatch(headers: unknown): number {
  const h = isObj(headers) ? headers['if-match'] : undefined;
  if (h === undefined) throw new LimsError('common.precondition_required');
  const m = typeof h === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(h) : null;
  if (!m || Number(m[1]) > 2147483647) throw invalid('/headers/if-match');
  return Number(m[1]);
}

/** windows are inclusive; NULL end = open */
export const windowOrdered = (from: string, to: string | null | undefined): boolean => to === null || to === undefined || to >= from;
