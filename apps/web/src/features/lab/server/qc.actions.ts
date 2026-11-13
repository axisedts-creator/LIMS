'use server';
// C5 T-25 server actions (BFF): #43 listQcResults, #44 captureQcResult, #45 listQcHolds, #46 releaseQcHold (02-TRD §5.7). Errors become { ok:false, status, code, title }
// (a thrown ApiError loses its code across the action boundary). Ids / enums / keys are checked before any network call; the API re-checks every limit. The JWT stays on the server (REQ-SEC-068).
// No QC judgement is read or shown anywhere (AC-19.3): the DTOs carry captured values only.
import 'server-only';
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import type { QcCaptureBody, QcHold, QcHoldStatus, QcResult } from './qc.types';
import { KEY_RE, UUID_RE, type ActionResult, type Page } from './types';

const bad = (): ActionResult<never> => ({ ok: false, status: 400, code: 'common.validation_failed', title: 'Validation failed' });
async function run<T>(f: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await f() };
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    return { ok: false, status: e.status, code: e.problem.code, title: e.problem.title };
  }
}
const JSON_HEADERS = { 'content-type': 'application/json' };
const CURSOR_RE = /^[A-Za-z0-9_-]{1,512}$/;

export async function listQcResultsAction(cursor?: string): Promise<ActionResult<Page<QcResult>>> {
  if (cursor !== undefined && !CURSOR_RE.test(cursor)) return bad();
  return run(() => serverFetch<Page<QcResult>>(`/v1/lab/qc-results${cursor ? `?${new URLSearchParams({ cursor })}` : ''}`));
}

export async function captureQcResultAction(body: QcCaptureBody, key: string): Promise<ActionResult<QcResult>> {
  if (!KEY_RE.test(key) || ![body?.centre_id, body?.instrument_id, body?.analyte_id].every((v) => typeof v === 'string' && UUID_RE.test(v))) return bad();
  return run(() => serverFetch<QcResult>('/v1/lab/qc-results', { method: 'POST', headers: { ...JSON_HEADERS, 'idempotency-key': key }, body: JSON.stringify(body) }));
}

export async function listQcHoldsAction(status: QcHoldStatus): Promise<ActionResult<QcHold[]>> {
  if (status !== 'active' && status !== 'released') return bad();
  return run(async () => (await serverFetch<{ data: QcHold[] }>(`/v1/lab/qc-holds?${new URLSearchParams({ status })}`)).data);
}

export async function releaseQcHoldAction(holdId: string, comment: string): Promise<ActionResult<QcHold>> {
  if (!UUID_RE.test(holdId) || typeof comment !== 'string' || comment.trim() === '' || comment.length > 500) return bad();
  return run(() => serverFetch<QcHold>(`/v1/lab/qc-holds/${holdId}/release`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ comment }) }));
}
