'use server';
// C16.T-Q4 server actions behind the W6/W7 client components. Actions are public endpoints: the session permission, ids, keys and body shapes are
// re-checked here before anything reaches the API (which re-checks the permission again). Only ApiError is mapped to { ok:false }; anything else rethrows.
// Pairing (03-APP-FLOW §7.2): Q8 → T-Q5 setDisplayCookie → redirect('/queue-display'). The one-time secret never leaves the server.
import 'server-only';
import { redirect } from 'next/navigation';
import { ApiError } from '@/core/api/server-fetch';
import { setDisplayCookie } from '@/app/(display)/queue-display/pairing';
import type { QueueToken } from '../components/queue-model';
import * as api from './queue.server';

export type ActionResult<T = unknown> = { ok: true; data: T } | { ok: false; status: number; code: string };

const KEY = /^[A-Za-z0-9_-]{8,64}$/;
const CODE = /^[a-z0-9_]{1,32}$/;
const PREFIX = /^[A-Z]{1,2}$/;
const bad = (): ActionResult<never> => ({ ok: false, status: 400, code: 'common.validation_failed' });
const denied = (): ActionResult<never> => ({ ok: false, status: 403, code: 'auth.forbidden' });
const ver = (n: unknown) => Number.isInteger(n) && (n as number) > 0;
const uuid = (s: unknown): s is string => typeof s === 'string' && api.UUID_RE.test(s);
const obj = (b: unknown): b is Record<string, unknown> => !!b && typeof b === 'object' && !Array.isArray(b);
const order = (n: unknown) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 999;
const text = (s: unknown, max: number) => typeof s === 'string' && s.trim().length >= 1 && s.length <= max;

async function run<T>(perm: string, fn: () => Promise<T>): Promise<ActionResult<T>> {
  if (!(await api.has(perm))) return denied();
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    return { ok: false, status: e.status, code: e.problem.code };
  }
}

// ---- W6 (engagement.queue.operate) ----
export async function listTokensAction(centreId: string) {
  if (!uuid(centreId)) return bad();
  return run(api.OPERATE, () => api.listTokens(centreId));
}
export async function callNextAction(queueId: string, counterId: string) {
  if (!uuid(queueId) || !uuid(counterId)) return bad();
  return run(api.OPERATE, () => api.callNext(queueId, counterId));
}
const tokenArgs = (id: string, version: number) => uuid(id) && ver(version);
export async function recallAction(id: string, version: number): Promise<ActionResult<QueueToken>> {
  return tokenArgs(id, version) ? run(api.OPERATE, () => api.recallToken(id, version)) : bad();
}
export async function serveAction(id: string, version: number, counterId: string): Promise<ActionResult<QueueToken>> {
  return tokenArgs(id, version) && uuid(counterId) ? run(api.OPERATE, () => api.serveToken(id, version, counterId)) : bad();
}
export async function completeAction(id: string, version: number): Promise<ActionResult<QueueToken>> {
  return tokenArgs(id, version) ? run(api.OPERATE, () => api.completeToken(id, version)) : bad();
}
export async function skipAction(id: string, version: number): Promise<ActionResult<QueueToken>> {
  return tokenArgs(id, version) ? run(api.OPERATE, () => api.skipToken(id, version)) : bad();
}
export async function transferAction(id: string, version: number, toQueueId: string, key: string) {
  return tokenArgs(id, version) && uuid(toQueueId) && KEY.test(key) ? run(api.OPERATE, () => api.transferToken(id, version, toQueueId, key)) : bad();
}
export async function issueAction(input: { queueId: string; priority: string }, key: string) {
  if (!obj(input) || !uuid(input.queueId) || !['normal', 'priority'].includes(input.priority) || !KEY.test(key)) return bad();
  return run(api.OPERATE, () => api.issueToken({ queue_id: input.queueId, priority: input.priority as 'normal' | 'priority' }, key));
}

// ---- W7 (engagement.queue.manage) ----
const queueBody = (b: unknown) =>
  obj(b) && uuid(b['centre_id']) && typeof b['code'] === 'string' && CODE.test(b['code']) && text(b['display_name'], 60) && typeof b['token_prefix'] === 'string' && PREFIX.test(b['token_prefix']) && order(b['sort_order']) && typeof b['is_active'] === 'boolean'
    ? { centre_id: b['centre_id'], code: b['code'], display_name: b['display_name'], token_prefix: b['token_prefix'], sort_order: b['sort_order'], is_active: b['is_active'] }
    : undefined;
const counterBody = (b: unknown) =>
  obj(b) && uuid(b['centre_id']) && text(b['display_name'], 40) && order(b['sort_order']) && typeof b['is_active'] === 'boolean'
    ? { centre_id: b['centre_id'], display_name: b['display_name'], sort_order: b['sort_order'], is_active: b['is_active'] }
    : undefined;

export async function createQueueAction(body: unknown, key: string) {
  const b = queueBody(body);
  return b && KEY.test(key) ? run(api.MANAGE, () => api.createQueue(b, key)) : bad();
}
export async function updateQueueAction(id: string, version: number, body: unknown) {
  const b = queueBody(body);
  return b && tokenArgs(id, version) ? run(api.MANAGE, () => api.updateQueue(id, version, b)) : bad();
}
export async function createCounterAction(body: unknown, key: string) {
  const b = counterBody(body);
  return b && KEY.test(key) ? run(api.MANAGE, () => api.createCounter(b, key)) : bad();
}
export async function updateCounterAction(id: string, version: number, body: unknown) {
  const b = counterBody(body);
  return b && tokenArgs(id, version) ? run(api.MANAGE, () => api.updateCounter(id, version, b)) : bad();
}
export async function revokeDisplayAction(id: string, version: number) {
  return tokenArgs(id, version) ? run(api.MANAGE, () => api.revokeDisplay(id, version)) : bad();
}

/** Pair this screen. On success the cookie is set on THIS browser (the TV) and the browser is sent to the board; on failure a result is returned. */
export async function pairDisplayAction(centreId: string, body: { display_name: string; queue_ids: string[] }): Promise<ActionResult<never>> {
  const ids = obj(body) && Array.isArray(body.queue_ids) ? body.queue_ids : [];
  if (!uuid(centreId) || !obj(body) || !text(body.display_name, 40) || ids.length < 1 || ids.length > 10 || !ids.every(uuid) || new Set(ids).size !== ids.length) return bad();
  if (!(await api.has(api.MANAGE))) return denied();
  let secret: string;
  try {
    secret = (await api.pairDisplayRaw({ centre_id: centreId, display_name: body.display_name, queue_ids: ids })).display_token;
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    return { ok: false, status: e.status, code: e.problem.code };
  }
  await setDisplayCookie(secret);
  redirect('/queue-display');
}
