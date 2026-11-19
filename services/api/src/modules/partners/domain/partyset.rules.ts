// T0B-PARTYSET-1 (LD-321) done_when (2): request rules of the party settings, onboarding and penalty operations, checked here BEFORE any SQL.
// Every rule failure is common.validation_failed with the JSON pointer of the field; all bad fields of one request are reported in one answer.
// Messages are fixed text: no submitted value is ever echoed. The DB CHECKs / triggers of migration 20261117220000 are only the concurrent backstop.
import { LimsError, type FieldError } from '../../../core/errors.js';

export type Obj = Record<string, unknown>;
export const PARTY_KINDS = ['partner', 'credit_party', 'doctor', 'referrer'] as const;
export const BILLING_CYCLES = ['daily', 'weekly', 'fortnightly', 'monthly', 'quarterly'] as const;
export const PRIORITIES = ['P1', 'P2', 'P3', 'P4', 'P5'] as const;
export const HEADER_FOOTER_MODES = ['with', 'without', 'both'] as const;
export const ONBOARDING_STATUSES = ['pending', 'approved', 'held', 'rejected'] as const;
export const EVENT_STATUSES = ['raised', 'waived', 'charged'] as const;
export const DECISIONS = ['approve', 'hold', 'reject'] as const;
export const MAX_PAISA = 100_000_000_000;
export const CODE = /^[A-Z0-9_-]{1,20}$/;
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

// ---------------------------------------------------------------- party commercial settings
export const SETTING_FIELDS = ['auto_release_reports', 'whatsapp_enabled', 'insurance_enabled', 'print_exception', 'auto_block_overdue', 'lab_number_scheme_code', 'billing_cycle',
  'invoice_payment_days', 'invoice_blocking_days', 'invoice_warning_days', 'interest_bp_per_day', 'commission_bp', 'tds_bp', 'priority', 'header_footer_mode'] as const;
/** [CONV] the defaults an unsaved party reads and a first save starts from (no lab default is known yet: credit 30 days, warn 45, block 60, interest 0, P3, both). */
export const SETTING_DEFAULTS: Readonly<Obj> = Object.freeze({
  auto_release_reports: false, whatsapp_enabled: false, insurance_enabled: false, print_exception: false, auto_block_overdue: false, lab_number_scheme_code: null,
  billing_cycle: 'monthly', invoice_payment_days: 30, invoice_blocking_days: 60, invoice_warning_days: 45, interest_bp_per_day: 0, commission_bp: 0, tds_bp: 0,
  priority: 'P3', header_footer_mode: 'both',
});

/** the changed values of a PUT body (keys = columns); `null` = unset */
export function settingPatch(raw: unknown): Obj {
  const c = new Checker(raw, [...SETTING_FIELDS, 'unset']);
  const out: Obj = {};
  const put = (k: string, v: unknown): void => { if (v !== undefined) out[k] = v; };
  for (const k of ['auto_release_reports', 'whatsapp_enabled', 'insurance_enabled', 'print_exception', 'auto_block_overdue']) put(k, c.bool(k));
  for (const k of ['invoice_payment_days', 'invoice_blocking_days', 'invoice_warning_days']) put(k, c.int(k, 0, 365));
  for (const k of ['interest_bp_per_day', 'commission_bp', 'tds_bp']) put(k, c.int(k, 0, 10000));
  put('billing_cycle', c.oneOf('billing_cycle', BILLING_CYCLES));
  put('priority', c.oneOf('priority', PRIORITIES));
  put('header_footer_mode', c.oneOf('header_footer_mode', HEADER_FOOTER_MODES));
  put('lab_number_scheme_code', c.text('lab_number_scheme_code', 20, false, CODE));
  const u = c.src['unset'];
  if (u !== undefined) {
    if (!Array.isArray(u) || u.length > 1 || new Set(u).size !== u.length) c.bad('/unset');
    else u.forEach((x, i) => { if (x !== 'lab_number_scheme_code' || c.src[x] !== undefined) c.bad(`/unset/${i}`); else out[x] = null; });
  }
  c.done();
  return out;
}
