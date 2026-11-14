'use server';
// C9 T-24 server actions: TAT polling (#48) and acknowledge (#50). The JWT stays on the server (REQ-SEC-068); a server action is a public endpoint,
// so permission and every input are re-checked here. POST carries Idempotency-Key + If-Match "<version>". Only ApiError becomes { ok:false, status, code }.
import 'server-only';
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { UUID, permissions } from '../server/quality.server';
import type { ActionResult, ListPage, TatAlert } from '../types';
import { TAT_ACK, TAT_READ, getTatAlerts, tatQuery } from './tat.server';

const KEY = /^[A-Za-z0-9_-]{1,64}$/;
const fail = (status: number, code: string): ActionResult<never> => ({ ok: false, status, code });

async function call<T>(run: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await run() };
  } catch (e) {
    if (e instanceof ApiError) return fail(e.status, e.problem.code);
    throw e;
  }
}

/** Plain search-param object from the client; re-whitelisted by tatQuery exactly like the page render. */
export async function pollTatAction(sp: Record<string, string>): Promise<ActionResult<ListPage<TatAlert>>> {
  if (!(await permissions()).includes(TAT_READ)) return fail(403, 'auth.forbidden');
  const clean = sp && typeof sp === 'object' ? Object.fromEntries(Object.entries(sp).filter(([, v]) => typeof v === 'string')) : {};
  return call(() => getTatAlerts(tatQuery(clean)));
}

/** #50 acknowledgeTatAlert — note optional (max 500); the row version is the If-Match. */
export async function acknowledgeTatAction(tatItemId: string, version: number, note: string, key: string): Promise<ActionResult<unknown>> {
  const n = typeof note === 'string' ? note.trim() : undefined;
  if (typeof tatItemId !== 'string' || !UUID.test(tatItemId) || !Number.isInteger(version) || version < 0 || typeof key !== 'string' || !KEY.test(key) || n === undefined || n.length > 500) {
    return fail(400, 'common.validation_failed');
  }
  if (!(await permissions()).includes(TAT_ACK)) return fail(403, 'auth.forbidden');
  return call(() => serverFetch(`/v1/quality/tat-alerts/${tatItemId}/acknowledge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key, 'if-match': `"${version}"` },
    body: JSON.stringify(n ? { note: n } : {}),
  }));
}
