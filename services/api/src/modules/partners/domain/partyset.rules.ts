// T0B-PARTYSET-1 (LD-321) done_when (2): request rules of the party settings, onboarding and penalty operations, checked here BEFORE any SQL.
// Every rule failure is common.validation_failed with the JSON pointer of the field; all bad fields of one request are reported in one answer.
// Messages are fixed text: no submitted value is ever echoed. The DB CHECKs / triggers of migration 20261117220000 are only the concurrent backstop.
import { Checker, ifMatch, invalid, isIsoDate, isObj, isUuid, type Obj } from '../../../core/validation/request-rules.js';
export { Checker, ifMatch, invalid, isIsoDate, isObj, isUuid, type Obj };   // generic helpers live in core; re-exported for this module's importers

export const PARTY_KINDS = ['partner', 'credit_party', 'doctor', 'referrer'] as const;
export const BILLING_CYCLES = ['daily', 'weekly', 'fortnightly', 'monthly', 'quarterly'] as const;
export const PRIORITIES = ['P1', 'P2', 'P3', 'P4', 'P5'] as const;
export const HEADER_FOOTER_MODES = ['with', 'without', 'both'] as const;
export const ONBOARDING_STATUSES = ['pending', 'approved', 'held', 'rejected'] as const;
export const EVENT_STATUSES = ['raised', 'waived', 'charged'] as const;
export const DECISIONS = ['approve', 'hold', 'reject'] as const;
export const MAX_PAISA = 100_000_000_000;
export const CODE = /^[A-Z0-9_-]{1,20}$/;

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
