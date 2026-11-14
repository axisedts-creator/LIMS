'use server';
// C9 T-21 server actions: polling reads and run/observation mutations for the client views. The JWT stays on the server (REQ-SEC-068);
// every input is re-validated here because a server action is a public endpoint. Only ApiError becomes { ok:false, status, code }; anything else rethrows.
import 'server-only';
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import type { ActionResult, LjChart, RunDetail, StatusRow } from '../types';
import { UUID, getLjChart, getStatusBoard, ljQuery, statusQuery } from './quality.server';

type SP = Record<string, string | string[] | undefined>;
const KEY = /^[A-Za-z0-9_-]{1,64}$/;
const CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const invalid = (): ActionResult<never> => ({ ok: false, status: 400, code: 'common.validation_failed' });

async function call<T>(run: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await run() };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, status: e.status, code: e.problem.code };
    throw e;
  }
}

/** Plain search-param object from the client; re-whitelisted here exactly like the page render. */
const cleanSp = (sp: unknown): SP => (sp && typeof sp === 'object' ? Object.fromEntries(Object.entries(sp as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as SP : {});

export async function pollStatusAction(sp: SP): Promise<ActionResult<StatusRow[]>> {
  return call(() => getStatusBoard(statusQuery(cleanSp(sp))));
}
export async function pollLjAction(sp: SP): Promise<ActionResult<LjChart>> {
  const q = ljQuery(cleanSp(sp));
  return q ? call(() => getLjChart(q.query)) : invalid();
}

const post = <T>(path: string, key: string, body: unknown, version?: number) =>
  serverFetch<T>(`/v1/quality/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key, ...(version !== undefined ? { 'if-match': `"${version}"` } : {}) },
    body: JSON.stringify(body),
  });
const okRun = (id: string, version: number | undefined, key: string) => UUID.test(id) && KEY.test(key) && (version === undefined || Number.isInteger(version));
const okComment = (c: unknown, min: number) => typeof c === 'string' && c.trim().length >= min && c.length <= 500;

/** #30 evaluateQcRun — comment optional (max 500). */
export async function evaluateRunAction(runId: string, version: number, comment: string, key: string): Promise<ActionResult<RunDetail>> {
  if (!okRun(runId, version, key) || !okComment(comment, 0)) return invalid();
  return call(() => post<RunDetail>(`qc-runs/${runId}/evaluate`, key, comment.trim() ? { comment: comment.trim() } : {}, version));
}

/** #31 recordCorrectiveAction — action_code coded, description 1–1000, performed_at an instant. */
export async function correctiveActionAction(runId: string, input: { action_code: string; description: string; performed_at: string }, key: string): Promise<ActionResult<unknown>> {
  const d = typeof input?.description === 'string' ? input.description.trim() : '';
  if (!okRun(runId, undefined, key) || !CODE.test(String(input?.action_code)) || d.length < 1 || d.length > 1000 || !ISO_UTC.test(String(input?.performed_at))) return invalid();
  return call(() => post(`qc-runs/${runId}/corrective-actions`, key, { action_code: input.action_code, description: d, performed_at: input.performed_at }));
}

/** #32 closeQcRun. */
export async function closeRunAction(runId: string, version: number, key: string): Promise<ActionResult<RunDetail>> {
  if (!okRun(runId, version, key)) return invalid();
  return call(() => post<RunDetail>(`qc-runs/${runId}/close`, key, {}, version));
}

/** #33 acknowledgeQcRun — comment required (1–500). */
export async function acknowledgeRunAction(runId: string, version: number, comment: string, key: string): Promise<ActionResult<RunDetail>> {
  if (!okRun(runId, version, key) || !okComment(comment, 1)) return invalid();
  return call(() => post<RunDetail>(`qc-runs/${runId}/acknowledge`, key, { comment: comment.trim() }, version));
}

/** #27 excludeQcObservation. The chart point carries no row version, so it is read first (same plan, the point's instant) to build the If-Match. */
export async function excludeObservationAction(planId: string, observationId: string, observedAt: string, reasonCode: string, comment: string, key: string): Promise<ActionResult<unknown>> {
  if (!UUID.test(planId) || !okRun(observationId, undefined, key) || !ISO_UTC.test(observedAt) || !CODE.test(String(reasonCode)) || !okComment(comment, 0)) return invalid();
  return call(async () => {
    const at = Date.parse(observedAt);
    const q = new URLSearchParams({ plan_id: planId, observed_at_from: observedAt, observed_at_to: new Date(at + 1000).toISOString(), limit: '50' });
    const list = await serverFetch<{ data: { id: string; version: number }[] }>(`/v1/quality/qc-observations?${q.toString()}`);
    const version = list.data?.find((o) => o.id === observationId)?.version;
    if (version === undefined) throw new ApiError(404, { type: 'urn:lims:error:common.not_found', title: 'Not found', status: 404, code: 'common.not_found' });
    return post(`qc-observations/${observationId}/exclude`, key, { reason_code: reasonCode, ...(comment.trim() ? { comment: comment.trim() } : {}) }, version);
  });
}
