// C2-T11 shared test doubles (synthetic data only). Seams are ASSUMED where the spec is silent: see the header of each T11 test file.
import { vi } from 'vitest';
import { createFakeGoTrueGateway } from '../../../../../api/src/modules/identity/gotrue/gateway.fake.js';
import { GoTrueError } from '../../../../../api/src/modules/identity/gotrue/gateway.js';
import { LimsError } from '../../../../../api/src/core/errors.js';

export const idN = (n: number) => `0190a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
export const TENANT = idN(0xa1), OTHER_TENANT = idN(0xa2), MEMB = idN(0xb1), STAFF = idN(0xd2), ACTOR = idN(0x11);
export const NOW = '2026-11-11T04:00:00.000Z';
export const mk = (tag: string) => `t11-${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@lims-test.example`;
export { GoTrueError, LimsError };

/** JobContext double. `tenantId` undefined = platform task. `attempt`/`maxAttempts` are the queue's counters. */
export function makeCtx(o: { tenantId?: string | undefined; attempt?: number; maxAttempts?: number } = {}) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const tx = { query: vi.fn(async () => ({ rows: [] })) };
  const ctx: any = { tenantId: o.tenantId, actor: { type: 'system', id: ACTOR }, requestId: idN(0xe1), tx, log, attempt: o.attempt ?? 1, maxAttempts: o.maxAttempts ?? 10, jobId: '1', now: () => NOW };
  const logged = () => JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls, log.debug.mock.calls]);
  return { ctx, tx, log, logged };
}

/** Fake GoTrue + a call recorder (method + args). `fail` makes the named methods throw `err` (forever, or `times` times). */
export function makeGotrue(fail: Partial<Record<string, { err: () => unknown; times?: number }>> = {}) {
  const gw: any = createFakeGoTrueGateway(); const calls: Array<{ m: string; a: unknown[] }> = []; const left: Record<string, number> = {};
  const gotrue: any = new Proxy(gw, { get: (t, p: string) => {
    if (typeof t[p] !== 'function') return t[p];
    return async (...a: unknown[]) => {
      calls.push({ m: p, a }); const f = fail[p];
      if (f) { left[p] ??= f.times ?? Infinity; if (left[p]! > 0) { left[p]! -= 1; throw f.err(); } }
      return t[p](...a);
    };
  } });
  return { gw, gotrue, calls, of: (m: string) => calls.filter((c) => c.m === m) };
}
/** A confirmed GoTrue user with a password and one live session. */
export async function signedInUser(gw: any, tag = 'u') {
  const email = mk(tag); const u: any = await gw.adminCreateUser({ email, emailConfirm: true }); await gw.adminUpdatePassword(u.userId, 'Old-pass-Lims!9xyz');
  const r: any = await gw.signInWithPassword(email, 'Old-pass-Lims!9xyz');
  return { email, userId: u.userId as string, tokens: r.tokens as { accessToken: string; refreshToken: string; sessionId: string } };
}
export const alive = async (gw: any, accessToken: string) => gw.mfaListFactors(accessToken).then(() => true, () => false);

export const down = () => new LimsError('common.dependency_unavailable');
export const gt = (method: string, status: number, code: string) => new GoTrueError(method, status, code);
/** The outcome of a promise: the rejection (or undefined if it resolved). */
export const err = (p: Promise<unknown>): Promise<any> => p.then(() => undefined, (e) => e);
