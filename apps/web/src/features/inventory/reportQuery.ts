// S17 filters <-> report query (TRD #92). Shared by the server page (first load) and the client view (tab / filter changes), so both ask the API the same question.
// No secrets, no markup: safe to import from client components. LD-140 (2026-11-13): UI is built from @lims/ui only; this file holds no markup.
import type { ReportCode, ReportQuery } from './server/types';

export interface ReportFilters { from?: string; to?: string; store?: string; analyser?: string; test?: string; item?: string | undefined; within_days?: string; as_of?: string }

/** Reports that are about a period (the others are "now": expiry horizon, valuation as of). */
export const DATED: ReadonlySet<ReportCode> = new Set<ReportCode>(['daily_consumption', 'analyser_consumption', 'cost_per_test', 'wastage', 'consumption_reconciliation']);
export const MAX_DAYS = 366;

const day = (d: Date) => d.toISOString().slice(0, 10);
/** Default period: the last 30 days (UTC calendar days). */
export const defaultPeriod = (now = new Date()) => ({ from: day(new Date(now.getTime() - 30 * 86_400_000)), to: day(now) });

const YMD = /^\d{4}-\d{2}-\d{2}$/;
/** YYYY-MM-DD shifted by n calendar days (pure date arithmetic, no time zone). */
export const addDays = (ymd: string, n: number) => (YMD.test(ymd) ? day(new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000)) : undefined);
/** Asia/Kathmandu calendar date of an instant (contract #92/#93 `as_of` is an IsoDate, not a datetime). */
export function kathmanduDate(iso: string): string | undefined {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kathmandu' }).format(new Date(t));
}

/** Contract x-error-codes of GET /v1/inventory/reports/{report_code}/export.csv (#93). The export route only ever reports one of these; anything else is common.internal. */
export const EXPORT_ERROR_CODES: ReadonlySet<string> = new Set([
  'common.validation_failed', 'common.not_found', 'auth.forbidden', 'auth.unauthenticated', 'common.rate_limited', 'common.internal',
  'inventory.export_too_large', 'inventory.range_too_large', 'auth.mfa_required',
]);
/** Banner title per export failure (02-TRD error catalogue titles where they exist). */
export const EXPORT_ERROR_TITLE: Readonly<Record<string, string>> = {
  'inventory.export_too_large': 'Export too large — more than 50,000 rows. Narrow the period or filters.',
  'inventory.range_too_large': `Date range too large — choose a period of at most ${MAX_DAYS} days.`,
  'auth.forbidden': 'You do not have permission to export this report.',
  'auth.unauthenticated': 'Your session has ended. Sign in again, then export.',
  'common.not_found': 'This report could not be found.',
  'common.rate_limited': 'Too many exports. Wait a moment, then try again.',
  'common.validation_failed': 'The export filters are not valid.',
};

export function toReportQuery(code: ReportCode, f: ReportFilters): ReportQuery {
  const q: ReportQuery = {};
  if (DATED.has(code)) {
    if (f.from) q.business_date_from = f.from;
    // Contract: business_date_to is EXCLUSIVE (CV §4.4); the user picks an inclusive end date, so send the day after.
    const to = f.to ? addDays(f.to, 1) : undefined;
    if (to) q.business_date_to = to;
  }
  if (f.store) q.store_id = f.store;
  if (f.analyser) q.instrument_id = f.analyser;
  if (f.test) q.test_id = f.test;
  if (f.item) q.item_id = f.item;
  if (code === 'expiry' && f.within_days) q.within_days = f.within_days;
  const asOf = code === 'stock_valuation' && f.as_of ? kathmanduDate(f.as_of) : undefined;
  if (asOf) q.as_of = asOf;
  return q;
}

/** Inverse of toReportQuery for the export route's failure redirect: API query -> page filters (business_date_to back to the inclusive end date). */
export function fromReportQuery(q: ReportQuery): ReportFilters {
  const f: ReportFilters = {};
  if (q.business_date_from) f.from = q.business_date_from;
  const to = q.business_date_to ? addDays(q.business_date_to, -1) : undefined;
  if (to) f.to = to;
  if (q.store_id) f.store = q.store_id;
  if (q.instrument_id) f.analyser = q.instrument_id;
  if (q.test_id) f.test = q.test_id;
  if (q.item_id) f.item = q.item_id;
  if (q.within_days) f.within_days = q.within_days;
  if (q.as_of) f.as_of = q.as_of;
  return f;
}

/** Page URL for the same filters (shareable); defaults are left out only when unset. */
export function toPageQuery(code: ReportCode, f: ReportFilters): string {
  const p = new URLSearchParams();
  p.set('report', code);
  for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
  return p.toString();
}
