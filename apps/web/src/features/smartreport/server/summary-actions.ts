'use server';
// Server actions for SR-02 approve / reject (#31, #32). Ids and the attestation literal are re-checked here (actions are public endpoints); the API re-checks the permission.
// Only ApiError is mapped to { ok:false } (status + code); anything else rethrows to the error boundary.
import 'server-only';
import { ApiError } from '@/core/api/server-fetch';
import { UUID_RE } from '../library';
import * as api from './summary.server';

export type SummaryActionResult = { ok: true } | { ok: false; status: number; code: string };

const CODE = /^[a-z][a-z0-9_]{0,99}$/;
const COMMENT_MAX = 500;
const bad = (): SummaryActionResult => ({ ok: false, status: 400, code: 'common.validation_failed' });
const ver = (n: unknown) => Number.isInteger(n) && (n as number) > 0;

async function run(fn: () => Promise<unknown>): Promise<SummaryActionResult> {
  try {
    await fn();
    return { ok: true };
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    return { ok: false, status: e.status, code: e.problem.code };
  }
}

export async function approveSummaryAction(id: string, version: number): Promise<SummaryActionResult> {
  if (!UUID_RE.test(id) || !ver(version)) return bad();
  return run(() => api.approveSummary(id, version, { attestation: true }));
}

export async function rejectSummaryAction(id: string, version: number, reasonCode: string, comment?: string): Promise<SummaryActionResult> {
  if (!UUID_RE.test(id) || !ver(version) || typeof reasonCode !== 'string' || !CODE.test(reasonCode)) return bad();
  if (comment !== undefined && (typeof comment !== 'string' || comment.length > COMMENT_MAX)) return bad();
  const c = comment?.trim();
  if (reasonCode === 'other' && !c) return bad();
  return run(() => api.rejectSummary(id, version, { reason_code: reasonCode, ...(c ? { comment: c } : {}) }));
}
