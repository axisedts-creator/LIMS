import 'server-only';
// #20 createAnalyticsExport (BFF write). Sends Idempotency-Key; params pass through verbatim (the UI never converts B.S.<->A.D.).
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';

// ---- S5 My exports (AN-T20): #21 listAnalyticsExports. Only whitelisted status values / cursor reach the API; limit is fixed.
type SP = Record<string, string | string[] | undefined>;
export const EXPORT_STATUSES = ['queued', 'building', 'ready', 'failed', 'expired'] as const;
export interface ExportRow {
  id: string; report_code: string; format: string; status: string; params?: Record<string, unknown>;
  requested_at: string; ready_at?: string; expires_at?: string; row_count?: number; size_bytes?: number;
  downloads_used?: number; downloads_allowed?: number; failure_code?: string;
}
export interface ExportList { data: ExportRow[]; page?: { limit?: number; next_cursor?: string } }
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export function exportsQuery(sp: SP): URLSearchParams {
  const q = new URLSearchParams();
  const status = (first(sp['status']) ?? '').split(',').filter((s) => (EXPORT_STATUSES as readonly string[]).includes(s));
  if (status.length > 0) q.set('status', [...new Set(status)].join(','));
  const cursor = first(sp['cursor']);
  if (cursor && cursor.length <= 512 && /^[A-Za-z0-9_-]+$/.test(cursor)) q.set('cursor', cursor);
  q.set('limit', '20');
  return q;
}
export const listAnalyticsExports = (q: URLSearchParams) => serverFetch<ExportList>(`/v1/analytics/exports?${q.toString()}`);

export type AnalyticsExportFormat = 'xlsx' | 'csv' | 'pdf';
export interface AnalyticsExportJob { id: string; report_code: string; format: string; status: string }

const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CODE_RE = /^[a-z][a-z0-9_]*$/;
const FORMATS: readonly string[] = ['xlsx', 'csv', 'pdf'];
const bad = () => new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));

export function createAnalyticsExport(reportCode: string, format: AnalyticsExportFormat, params: Record<string, unknown>, key: string) {
  if (!KEY_RE.test(key) || !CODE_RE.test(reportCode) || !FORMATS.includes(format)) throw bad();
  return serverFetch<AnalyticsExportJob>('/v1/analytics/exports', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({ report_code: reportCode, format, params }),
  });
}
