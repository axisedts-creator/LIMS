import 'server-only';
// #1 getAnalyticsDashboard + #19 requestAnalyticsRefresh (BFF). Only whitelisted, well-formed search params reach the API (REQ-SEC: nothing else is forwarded).
import { serverFetch } from '@/core/api/server-fetch';

export interface Tile { value: number; previous?: number; delta?: number; delta_bp?: number; unit: 'count' | 'paisa' | 'seconds' }
export interface Freshness { family: string; refreshed_at?: string; is_stale: boolean; stale_reason?: 'refresh_lagging' | 'refresh_failed' | 'never_refreshed'; live: boolean }
export interface DashboardDto {
  report_code: string;
  period: { business_date_from: string; business_date_to: string; days: number; label_ad: string; label_bs: string; timezone: string };
  scope: { all_centres: boolean; centre_ids: string[]; tenant_wide_sections_hidden: string[] };
  freshness: Freshness[];
  generated_at: string;
  tiles: Record<string, Tile | undefined>;
  series: { days: { business_date: string; net_sales_paisa: number; patient_visits: number; net_orders: number }[] };
  department_top: { department_id?: string; label: string; is_multiple: boolean; net_paisa: number; share_bp: number }[];
}
export interface RefreshResult { next_allowed_at?: string }

type SP = Record<string, string | string[] | undefined>;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERIOD: Record<string, RegExp> = {
  business_date_from: ISO_DATE,
  business_date_to: ISO_DATE,
  bs_month: /^[0-9]{4}-(0[1-9]|1[0-2])$/,
  fiscal_year_bs: /^[0-9]{4}\/[0-9]{2}$/,
};
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Whitelisted query (period + comma-joined centre/branch uuids ≤ 20). Malformed values are dropped, never forwarded. */
export function dashboardQuery(sp: SP): URLSearchParams {
  const q = new URLSearchParams();
  for (const [k, re] of Object.entries(PERIOD)) {
    const v = first(sp[k]);
    if (v && re.test(v)) q.set(k, v);
  }
  for (const k of ['centre_id', 'branch_id']) {
    const ids = (first(sp[k]) ?? '').split(',').filter(Boolean);
    if (ids.length > 0 && ids.length <= 20 && ids.every((i) => UUID.test(i))) q.set(k, ids.join(','));
  }
  return q;
}

export function getDashboard(sp: SP) {
  const qs = dashboardQuery(sp).toString();
  return serverFetch<DashboardDto>(`/v1/analytics/dashboard${qs ? `?${qs}` : ''}`);
}

export function requestRefresh() {
  return serverFetch<RefreshResult>('/v1/analytics/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
}
