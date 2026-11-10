'use server';
// Server action for the analytics client components. Only ApiError is mapped to { ok:false, code } (a thrown ApiError loses its code
// across the action boundary in production); anything else rethrows to the error boundary.
import 'server-only';
import { ApiError } from '@/core/api/server-fetch';
import { createAnalyticsExport, type AnalyticsExportFormat } from './exports.server';
import { requestRefresh } from './dashboard.server';

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
