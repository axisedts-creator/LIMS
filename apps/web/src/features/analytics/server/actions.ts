'use server';
// Server action for the analytics client components. Only ApiError is mapped to { ok:false, code } (a thrown ApiError loses its code
// across the action boundary in production); anything else rethrows to the error boundary.
import 'server-only';
import { ApiError } from '@/core/api/server-fetch';
import { createAnalyticsExport, type AnalyticsExportFormat } from './exports.server';
import { requestRefresh } from './dashboard.server';
import { searchReferrers } from './reports.server';

export type ActionResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string };

export async function createExportAction(reportCode: string, format: AnalyticsExportFormat, params: Record<string, unknown>, key: string): Promise<ActionResult<{ id: string; status: string }>> {
  try {
    const j = await createAnalyticsExport(reportCode, format, params, key);
    return { ok: true, data: { id: j.id, status: j.status } };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, status: e.status, code: e.problem.code };
    throw e;
  }
}

/** #19 requestAnalyticsRefresh. 202 -> next_allowed_at; 429 is a normal outcome (UI shows "Refresh available at"). */
export async function refreshAction(): Promise<ActionResult<{ nextAllowedAt?: string }>> {
  try {
    const r = await requestRefresh();
    return { ok: true, data: { ...(r?.next_allowed_at ? { nextAllowedAt: r.next_allowed_at } : {}) } };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, status: e.status, code: e.problem.code };
    throw e;
  }
}

/** #17 searchAnalyticsReferrers. 2..60 chars (analytics.yaml); anything else returns no rows without an API call. Max 20 rows. */
export async function searchReferrersAction(query: string): Promise<{ id: string; label: string; isActive: boolean }[]> {
  const q = typeof query === 'string' ? query.trim() : '';
  if (q.length < 2 || q.length > 60) return [];
  const r = await searchReferrers(q);
  return (Array.isArray(r?.data) ? r.data : []).slice(0, 20).map((x) => ({ id: String(x.referrer_id), label: String(x.label), isActive: x.is_active === true }));
}
