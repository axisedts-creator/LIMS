import 'server-only';
// #20 createAnalyticsExport (BFF write). Sends Idempotency-Key; params pass through verbatim (the UI never converts B.S.<->A.D.).
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';

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
