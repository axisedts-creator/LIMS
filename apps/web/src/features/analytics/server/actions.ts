'use server';
// Server action for the analytics client components. Only ApiError is mapped to { ok:false, code } (a thrown ApiError loses its code
// across the action boundary in production); anything else rethrows to the error boundary.
import 'server-only';
import { ApiError } from '@/core/api/server-fetch';
import { createAnalyticsExport, type AnalyticsExportFormat } from './exports.server';
import { requestRefresh } from './dashboard.server';
import { searchReferrers } from './reports.server';
import { createSchedule, deactivateSchedule, updateSchedule, type ScheduleInput } from './schedules.server';

/** `paths` = JSON pointers of problem.errors[] (field-level failures), when the API names them. */
export type ActionResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string; paths?: string[] };

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

// ---- AN-T20 schedules. Each action maps only ApiError to { ok:false, status, code }; the page already checked analytics.schedule.manage and the API re-checks it.
const SCHEDULE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9_-]{1,64}$/;
const reject = (): ActionResult<never> => ({ ok: false, status: 400, code: 'common.validation_failed' });
async function api<T>(run: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await run() };
  } catch (e) {
    if (e instanceof ApiError) {
      const errs = Array.isArray(e.problem['errors']) ? (e.problem['errors'] as unknown[]) : [];
      const paths = errs.map((x) => (x && typeof x === 'object' ? (x as { path?: unknown }).path : undefined)).filter((p): p is string => typeof p === 'string').slice(0, 20);
      return { ok: false, status: e.status, code: e.problem.code, ...(paths.length ? { paths } : {}) };
    }
    throw e;
  }
}

export async function createScheduleAction(input: ScheduleInput, key: string): Promise<ActionResult<{ id: string }>> {
  if (!KEY.test(key)) return reject();
  return api(async () => ({ id: (await createSchedule(input, key)).id }));
}
export async function updateScheduleAction(id: string, version: number, input: ScheduleInput): Promise<ActionResult<{ id: string }>> {
  if (!SCHEDULE_ID.test(id) || !Number.isInteger(version)) return reject();
  return api(async () => ({ id: (await updateSchedule(id, version, input)).id }));
}
export async function deactivateScheduleAction(id: string, version: number): Promise<ActionResult<{ id: string }>> {
  if (!SCHEDULE_ID.test(id) || !Number.isInteger(version)) return reject();
  return api(async () => ({ id: (await deactivateSchedule(id, version)).id }));
}

/** #17 searchAnalyticsReferrers. 2..60 chars (analytics.yaml); anything else returns no rows without an API call. Max 20 rows. */
export async function searchReferrersAction(query: string): Promise<{ id: string; label: string; isActive: boolean }[]> {
  const q = typeof query === 'string' ? query.trim() : '';
  if (q.length < 2 || q.length > 60) return [];
  const r = await searchReferrers(q);
  return (Array.isArray(r?.data) ? r.data : []).slice(0, 20).map((x) => ({ id: String(x.referrer_id), label: String(x.label), isActive: x.is_active === true }));
}
