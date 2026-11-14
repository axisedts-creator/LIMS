// S17 filters <-> report query (TRD #92). Shared by the server page (first load) and the client view (tab / filter changes), so both ask the API the same question.
// No secrets, no markup: safe to import from client components. LD-140 (2026-11-13): UI is built from @lims/ui only; this file holds no markup.
import type { ReportCode, ReportQuery } from './server/types';

export interface ReportFilters { from?: string; to?: string; store?: string; analyser?: string; test?: string; item?: string; within_days?: string; as_of?: string }

/** Reports that are about a period (the others are "now": expiry horizon, valuation as of). */
export const DATED: ReadonlySet<ReportCode> = new Set<ReportCode>(['daily_consumption', 'analyser_consumption', 'cost_per_test', 'wastage', 'consumption_reconciliation']);
export const MAX_DAYS = 366;

const day = (d: Date) => d.toISOString().slice(0, 10);
/** Default period: the last 30 days (UTC calendar days). */
export const defaultPeriod = (now = new Date()) => ({ from: day(new Date(now.getTime() - 30 * 86_400_000)), to: day(now) });

export function toReportQuery(code: ReportCode, f: ReportFilters): ReportQuery {
  const q: ReportQuery = {};
  if (DATED.has(code)) {
    if (f.from) q.business_date_from = f.from;
    if (f.to) q.business_date_to = f.to;
  }
  if (f.store) q.store_id = f.store;
  if (f.analyser) q.instrument_id = f.analyser;
  if (f.test) q.test_id = f.test;
  if (f.item) q.item_id = f.item;
  if (code === 'expiry' && f.within_days) q.within_days = f.within_days;
  if (code === 'stock_valuation' && f.as_of) q.as_of = f.as_of;
  return q;
}

/** Page URL for the same filters (shareable); defaults are left out only when unset. */
export function toPageQuery(code: ReportCode, f: ReportFilters): string {
  const p = new URLSearchParams();
  p.set('report', code);
  for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
  return p.toString();
}
