'use server';
// Server actions for the intent detail buttons. Only ApiError is mapped to { ok:false, status, code, latest? } (a thrown ApiError loses its
// code across the action boundary in production); anything else rethrows to the error boundary. Nothing but a status string goes back to the browser.
import 'server-only';
import { ApiError } from '@/core/api/server-fetch';
import { cancelIntent, recheckIntent, resolveIntent, type Resolution } from './write.server';

export type ActionResult = { ok: true; status?: string } | { ok: false; status: number; code: string; latest?: string };

const SAFE_ANSWER = /^[A-Za-z0-9 _.-]{1,40}$/;
async function run(call: () => Promise<{ status?: string }>): Promise<ActionResult> {
  try {
    const r = await call();
    return { ok: true, ...(typeof r?.status === 'string' ? { status: r.status } : {}) };
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    const raw = e.problem['latest_status'] ?? e.problem['gateway_status_raw'];
    return { ok: false, status: e.status, code: e.problem.code, ...(typeof raw === 'string' && SAFE_ANSWER.test(raw) ? { latest: raw } : {}) };
  }
}

export const recheckAction = (id: string) => run(() => recheckIntent(id));
export const resolveAction = (id: string, version: number, resolution: Resolution, reasonCode: string, note: string | undefined, key: string) =>
  run(() => resolveIntent(id, version, resolution, reasonCode, note, key));
export const cancelAction = (id: string, reasonCode: string, key: string) => run(() => cancelIntent(id, reasonCode, key));
