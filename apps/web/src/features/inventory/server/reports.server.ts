import 'server-only';
// BFF for S17 Reports (TRD #92 GET /reports/{code}, #93 export.csv) plus the all-centres lookup. The bearer stays on the server (REQ-SEC-068).
// LD-140 (2026-11-13): no markup here.
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import { qs } from './read.server';
import { REPORT_CODES, REPORT_QUERY_KEYS, type ActionResult, type FieldProblem, type ReportCode, type ReportQuery, type ReportResult } from './types';

export const isReportCode = (v: unknown): v is ReportCode => typeof v === 'string' && (REPORT_CODES as readonly string[]).includes(v);

/** Keeps only the report filters (whitelist), as strings; anything else (tokens, __proto__, free text) is dropped. */
export function reportQuery(raw: Record<string, unknown>): ReportQuery {
  const out: ReportQuery = {};
  for (const k of REPORT_QUERY_KEYS) {
    const v = Object.hasOwn(raw, k) ? raw[k] : undefined;
    const s = Array.isArray(v) ? v[0] : v;
    if (typeof s === 'string' && s !== '' && s.length <= 64) out[k] = s;
  }
  return out;
}

export function getReport(code: string, q: ReportQuery): Promise<ReportResult> {
  if (!isReportCode(code)) throw new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
  return serverFetch<ReportResult>(`/v1/inventory/reports/${code}${qs(reportQuery(q))}`);
}

/** Path of the CSV the export route proxies (TRD #93). The API writes and neutralises the CSV; this app never builds one. */
export const reportExportPath = (code: ReportCode, q: ReportQuery) => `/v1/inventory/reports/${code}/export.csv${qs(reportQuery(q))}`;

/** C2 GET /v1/identity/me centre_scope.all: the Reconciliation tab is for all-centre users only. Any failure means "not all" (fails closed). */
export async function hasAllCentres(): Promise<boolean> {
  try {
    const me = await serverFetch<{ centre_scope?: { all?: boolean } }>('/v1/identity/me');
    return me.centre_scope?.all === true;
  } catch {
    return false;
  }
}

/** Like the server actions: an ApiError becomes a value (code, title, request id) so the screen can show it inline. */
export async function settle<T>(f: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await f() };
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    const p = e.problem;
    const errors = Array.isArray(p['errors']) ? (p['errors'] as FieldProblem[]) : undefined;
    return { ok: false, status: e.status, code: p.code, title: p.title, ...(p.request_id ? { requestId: p.request_id } : {}), ...(errors ? { errors } : {}) };
  }
}
