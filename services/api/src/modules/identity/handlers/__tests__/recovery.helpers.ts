// T9 test helpers (not a test file). Synthetic data only. Fixes the SEAMS the spec leaves open - the writer must match them or raise a dispute.
//
// Handler files each export the wired Handler (registered in the manifest) AND a factory taking the seams (same pattern as T7; no service file: T9 owns 3 handlers + 1 worker task):
//   handlers/requestPasswordRecovery.ts  requestPasswordRecovery + createRequestPasswordRecovery(deps{ repo{enqueue}, events{recordTenantless}, limits{consumeAttempt}, hmac?, newId?, now? })
//   handlers/confirmEmailToken.ts        confirmEmailToken        + createConfirmEmailToken(deps{ gotrue{verifyEmailToken}, repo{loginContext,insertSession,insertPlatformSession}, events{recordTenantless,recordTenant}, hmac?, newId?, newToken?, now? })
//   handlers/setPasswordFromSetup.ts     setPasswordFromSetup     + createSetPasswordFromSetup(deps{ gotrue{adminUpdatePassword}, repo, events, limits{clearAccountFailures}, breached{isBreached(tx, sha1 Buffer)}, hmac?, newId?, now? })
//   worker tasks/send_recovery.ts        SEND_RECOVERY = 'identity.send_recovery', sendRecovery: TaskHandler, createSendRecovery(deps{ gotrue{adminFindUserByEmail,sendRecovery}, repo{loginContext(tx, sub)} })
//   Handler call = (req, hctx) -> { status, body } (hctx like T6/T7: ctx.db.identityAuthTx, commitOnError, clientIp, requestId, bffKey, actor, log). ONE identityAuthTx per request, no db.tx/requestTx.
//   Session token = cookie `__Host-lims_sid` (setPasswordFromSetup only), sha256 -> repo.sessionByToken.  Repo = T7 MfaRepo names + these T9 methods (all take the request tx first, camelCase):
//     loginContext(tx, sub)  -> the app.identity_login_context row (snake_case, auth.helpers.ts tenantRow/platformRow)       insertSession / insertPlatformSession(tx, s)  s = T6 shape
//     sessionByToken(tx, sha256) / loadSession(tx, ref) {email, accessToken, ...} / updateSession(tx, ref, patch{state, aal, ...})  (T7)
//     revokeOtherSessions(tx, { tenantId|null, userId, exceptSessionId, reason:'password_change', actorId }) -> [{ sessionId, kind }]  (every OTHER non-terminal session of the user -> revoked)
//     acceptInvitation(tx, { tenantId, membershipId, userId, at, actorId }) -> boolean   (true = a pending invitation was accepted + membership active (M2); false = none -> recovery)
//     enqueue(tx, taskIdentifier, payload, jobKey)
//   Events (auth.helpers.ts AuthEvent shape): recordTenantless for password_reset_requested (+ platform confirm), recordTenant (after bindTenant) for the tenant ones.
import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { createFakeGoTrueGateway, type FakeGoTrueGateway } from '../../gotrue/gateway.fake.js';
import type { GoTrueGateway } from '../../gotrue/gateway.js';
import { EMAIL, HMAC_KEY, MEMB_A, REQ_ID, START, STAFF_ID, SYSTEM_ACTOR, TENANT_A, hmacHex, idN, makeLimits, platformRow, rejection, tenantRow, type LoginRow } from '../../service/__tests__/auth.helpers.js';

export { EMAIL, HMAC_KEY, MEMB_A, REQ_ID, START, STAFF_ID, SYSTEM_ACTOR, TENANT_A, hmacHex, idN, platformRow, rejection, tenantRow, LimsError };
export type { LoginRow };
export const CLIENT_IP = '203.0.113.9';
export const COOKIE = '__Host-lims_sid';
export const GOOD_PW = 'Zq7-correct-horse-battery-Lims!';
export const PW_SENTINEL = 'PW-SENTINEL-never-logged-Zq7!x';
export const sha256 = (s: string) => createHash('sha256').update(s).digest();
export const sha256hex = (s: string) => sha256(s).toString('hex');
export const tokenN = (n: number) => `S${n.toString(36).padStart(42, '0')}`;
export const norm = (e: string) => e.trim().normalize('NFC').toLowerCase();
export const mkEmail = (tag: string) => `t9-${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@lims-test.example`;

export interface SetupRow {
  sessionId: string; kind: 'tenant_staff' | 'platform'; state: string; tenantId: string | null; userId: string; membershipId: string | null; platformStaffId: string | null; tokenReused: boolean;
  email: string; aal: 'aal1' | 'aal2'; accessToken: string; refreshToken: string; idleExpiresAt: Date; absoluteExpiresAt: Date; revokeReason?: string; mfaFailedAttempts: number;
}
export interface Write { seq: number; m: string; arg: any; committed: boolean }

export function makeStore(clock: { ms: number }) {
  const sessions = new Map<string, SetupRow>(); const writes: Write[] = []; const order: string[] = [];
  let pending: Array<{ w: Write; undo?: () => void }> = []; let seq = 0;
  const rec = (m: string, arg: unknown, undo?: () => void) => { const w: Write = { seq: seq++, m, arg, committed: false }; writes.push(w); pending.push({ w, ...(undo ? { undo } : {}) }); order.push(m); };
  const same = (a: string | null, b: string | null) => (a ?? null) === (b ?? null);
  const byId = (id: string) => [...sessions.values()].find((s) => s.sessionId === id);
  const ctxRows = new Map<string, LoginRow>(); let defaultRow: (sub: string) => LoginRow = () => tenantRow();
  const pendingInvites = new Set<string>();       // membership ids with a pending invitation
  const live = (s: SetupRow) => s.state !== 'revoked' && s.state !== 'expired';

  const repo = {
    async loginContext(_tx: unknown, sub: string) { order.push('loginContext'); return ctxRows.get(sub) ?? defaultRow(sub); },
    async insertSession(_tx: unknown, s: any) {
      const row: SetupRow = { sessionId: s.id, kind: s.kind, state: s.state, tenantId: s.tenantId ?? null, userId: s.userId, membershipId: s.membershipId ?? null, platformStaffId: s.platformStaffId ?? null, tokenReused: false,
        email: '', aal: s.aal, accessToken: s.accessToken, refreshToken: s.refreshToken, idleExpiresAt: s.idleExpiresAt, absoluteExpiresAt: s.absoluteExpiresAt, mfaFailedAttempts: 0 };
      const k = Buffer.from(s.tokenSha256).toString('hex'); sessions.set(k, row); rec('insertSession', s, () => { sessions.delete(k); });
    },
    async insertPlatformSession(_tx: unknown, s: any) {
      const row: SetupRow = { sessionId: s.id, kind: 'platform', state: s.state, tenantId: null, userId: s.userId, membershipId: null, platformStaffId: s.platformStaffId ?? null, tokenReused: false,
        email: '', aal: s.aal, accessToken: s.accessToken, refreshToken: s.refreshToken, idleExpiresAt: s.idleExpiresAt, absoluteExpiresAt: s.absoluteExpiresAt, mfaFailedAttempts: 0 };
      const k = Buffer.from(s.tokenSha256).toString('hex'); sessions.set(k, row); rec('insertPlatformSession', s, () => { sessions.delete(k); });
    },
    async sessionByToken(_tx: unknown, sha: Buffer) {
      order.push('sessionByToken'); const s = sessions.get(Buffer.from(sha).toString('hex'));
      if (!s || !live(s)) return undefined;
      const { sessionId, kind, state, tenantId, userId, membershipId, platformStaffId, tokenReused } = s; return { sessionId, kind, state, tenantId, userId, membershipId, platformStaffId, tokenReused };
    },
    async loadSession(_tx: unknown, ref: { sessionId: string; tenantId: string | null; userId: string }) {
      order.push('loadSession'); const s = byId(ref.sessionId); if (!s || !same(s.tenantId, ref.tenantId) || s.userId !== ref.userId) return undefined;
      return { aal: s.aal, accessToken: s.accessToken, refreshToken: s.refreshToken, mfaFailedAttempts: s.mfaFailedAttempts, email: s.email, accessExpiresAt: new Date(clock.ms + 3_600_000), idleExpiresAt: s.idleExpiresAt, absoluteExpiresAt: s.absoluteExpiresAt };
    },
    async updateSession(_tx: unknown, ref: { sessionId: string }, patch: any) {
      const s = byId(ref.sessionId); const before = s ? { ...s } : undefined; rec('updateSession', { ref, patch }, () => { if (s && before) Object.assign(s, before); });
      if (!s) return; for (const k of ['state', 'aal', 'accessToken', 'refreshToken'] as const) if (patch[k] !== undefined) (s as any)[k] = patch[k];
      if (patch.revoked) { s.state = 'revoked'; s.revokeReason = patch.revoked.reason; }
    },
    async revokeOtherSessions(_tx: unknown, a: { tenantId: string | null; userId: string; exceptSessionId: string; reason: string }) {
      const hit = [...sessions.values()].filter((s) => s.userId === a.userId && s.sessionId !== a.exceptSessionId && live(s) && same(s.tenantId, a.tenantId)); const before = hit.map((s) => ({ ...s }));
      rec('revokeOtherSessions', a, () => { hit.forEach((s, i) => Object.assign(s, before[i])); }); hit.forEach((s) => { s.state = 'revoked'; s.revokeReason = a.reason; });
      return hit.map((s) => ({ sessionId: s.sessionId, kind: s.kind }));
    },
    async acceptInvitation(_tx: unknown, a: { membershipId: string }) { const had = pendingInvites.delete(a.membershipId); rec('acceptInvitation', a, () => { if (had) pendingInvites.add(a.membershipId); }); return had; },
    async enqueue(_tx: unknown, identifier: string, payload: Record<string, unknown>, jobKey: string) { rec('enqueue', { identifier, payload, jobKey }); },
  };
  const events = { async recordTenantless(_tx: unknown, e: any) { rec('recordTenantless', e); }, async recordTenant(_tx: unknown, e: any) { rec('recordTenant', e); } };
  async function envelope<T>(fn: () => Promise<T>): Promise<T> {
    pending = []; try { const r = await fn(); for (const p of pending) p.w.committed = true; return r; } catch (e) { for (const p of [...pending].reverse()) p.undo?.(); throw e; } finally { pending = []; }
  }
  const committed = (m?: string) => writes.filter((w) => w.committed && (!m || w.m === m));
  const eventsOf = (type: string) => committed().filter((w) => (w.m === 'recordTenant' || w.m === 'recordTenantless') && w.arg.eventType === type).map((w) => w.arg);
  return { sessions, writes, order, repo, events, envelope, committed, eventsOf, byId, ctxRows, pendingInvites, setDefaultRow: (f: (sub: string) => LoginRow) => { defaultRow = f; } };
}

/** One world: GoTrue (fake or HTTP), store, limits on a virtual clock, deps for the three handlers, hctx factory. */
export async function makeWorld(o: { gateway?: GoTrueGateway; breached?: (sha1: Buffer) => boolean } = {}) {
  const clock = { ms: START.getTime() };
  const fake = o.gateway ? undefined : createFakeGoTrueGateway(); const gw: GoTrueGateway = o.gateway ?? (fake as unknown as GoTrueGateway);
  const store = makeStore(clock); const lim = makeLimits({ clock }); const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const gotrue = new Proxy(gw, { get: (t, p: string) => (typeof (t as any)[p] === 'function' ? (...a: unknown[]) => { calls.push({ method: p, args: a }); return (t as any)[p](...a); } : (t as any)[p]) }) as GoTrueGateway;
  let n = 0xf100; const breachedSeen: Buffer[] = [];
  const breached = { isBreached: vi.fn(async (_tx: unknown, sha1: Buffer) => { breachedSeen.push(sha1); return o.breached?.(sha1) ?? false; }) };
  const deps = { gotrue, repo: store.repo, events: store.events, limits: lim.limits, breached, hmac: (e: string) => hmacHex(e), newId: () => idN(n++), newToken: () => tokenN(n++), now: () => new Date(clock.ms) };
  const tx = { query: vi.fn(async (..._a: unknown[]) => ({ rows: [] })), bindTenant: vi.fn(async (id: string) => { if (tx.bindTenant.mock.calls.length > 1) throw new Error('bindTenant called twice (D-212)'); store.order.push(`bindTenant:${id}`); }) };
  const txCalls: any[] = [];
  function makeHctx(c: Record<string, unknown> = {}) {
    tx.bindTenant.mockClear(); tx.query.mockClear();
    const commitOnError = vi.fn(() => { store.order.push('commitOnError'); });
    const forbidden = (nm: string) => () => { throw new Error(`T9 handlers must not use ctx.db.${nm}`); };
    const hctx: any = { operationId: 'x', clientIp: CLIENT_IP, requestId: REQ_ID, bffKey: 'staff_web', actor: { type: 'system', id: SYSTEM_ACTOR }, log, commitOnError, rateLimit: { consume: vi.fn(async () => undefined) },
      db: { identityAuthTx: (input: any, fn: any) => { txCalls.push(input); return store.envelope(() => fn(tx, { noRetry: () => undefined })); }, tx: forbidden('tx'), requestTx: forbidden('requestTx'), withTenantScope: forbidden('withTenantScope') }, ...c };
    return { hctx, commitOnError };
  }
  const req = (a: { token?: string; body?: unknown } = {}) => ({ params: {}, query: {}, body: a.body, headers: { ...(a.token ? { cookie: `theme=dark; ${COOKIE}=${a.token}; other=1` } : {}), 'user-agent': 'Mozilla/5.0 Firefox/130.0' } });
  const call = (h: any, a: { token?: string; body?: unknown } = {}, c: Record<string, unknown> = {}) => { const x = makeHctx(c); return h(req(a), x.hctx); };

  /** a GoTrue user that exists with a password (and a login-context row = active tenant staff unless `row`) */
  async function addUser(a: { email?: string; row?: LoginRow } = {}) {
    const email = a.email ?? mkEmail('u'); const u = await gw.adminCreateUser({ email, emailConfirm: true }); const userId = (u as any).userId as string;
    const password = `Old-${Math.random().toString(36).slice(2, 10)}-Lims!9`; await gw.adminUpdatePassword(userId, password);
    store.ctxRows.set(userId, a.row ?? tenantRow()); return { email, userId, password };
  }
  /** an existing session of that user (other device), live, tenant A */
  async function addOtherSession(userId: string, email: string, password: string, a: { state?: string; kind?: 'tenant_staff' | 'platform' } = {}) {
    const r = await gw.signInWithPassword(email, password); if (!r.ok) throw new Error('signin'); const kind = a.kind ?? 'tenant_staff';
    const row: SetupRow = { sessionId: idN(n++), kind, state: a.state ?? 'active', tenantId: kind === 'platform' ? null : TENANT_A, userId, membershipId: kind === 'platform' ? null : MEMB_A, platformStaffId: kind === 'platform' ? STAFF_ID : null, tokenReused: false,
      email, aal: 'aal1', accessToken: r.tokens.accessToken, refreshToken: r.tokens.refreshToken, idleExpiresAt: new Date(clock.ms + 1_800_000), absoluteExpiresAt: new Date(clock.ms + 43_200_000), mfaFailedAttempts: 0 };
    store.sessions.set(sha256(tokenN(n++)).toString('hex'), row); return row;
  }
  /** a password_setup session as confirmEmailToken leaves it (seeded directly: set-password tests do not depend on the confirm handler) */
  async function addSetupSession(a: { email?: string; row?: LoginRow; kind?: 'tenant_staff' | 'platform'; state?: string; absoluteInMs?: number; invite?: boolean; token?: string } = {}) {
    const u = await addUser({ email: a.email, row: a.row ?? (a.kind === 'platform' ? platformRow() : tenantRow()) }); const r = await gw.signInWithPassword(u.email, u.password); if (!r.ok) throw new Error('signin');
    const kind = a.kind ?? 'tenant_staff'; const token = a.token ?? tokenN(n++);
    const row: SetupRow = { sessionId: idN(n++), kind, state: a.state ?? 'password_setup', tenantId: kind === 'platform' ? null : TENANT_A, userId: u.userId, membershipId: kind === 'platform' ? null : MEMB_A, platformStaffId: kind === 'platform' ? STAFF_ID : null, tokenReused: false,
      email: u.email, aal: 'aal1', accessToken: r.tokens.accessToken, refreshToken: r.tokens.refreshToken, idleExpiresAt: new Date(clock.ms + 900_000), absoluteExpiresAt: new Date(clock.ms + (a.absoluteInMs ?? 900_000)), mfaFailedAttempts: 0 };
    store.sessions.set(sha256(token).toString('hex'), row); if (a.invite && kind === 'tenant_staff') store.pendingInvites.add(MEMB_A);
    return { ...u, token, row };
  }
  return { gw, fake, gotrue, calls, store, lim, deps, log, tx, txCalls, makeHctx, req, call, addUser, addOtherSession, addSetupSession, breached, breachedSeen, clock, advance: (ms: number) => { clock.ms += ms; fake?.advanceTime(ms / 1000); } };
}
export type World = Awaited<ReturnType<typeof makeWorld>>;
export const otherWrites = (s: ReturnType<typeof makeStore>, allowed: string[]) => s.committed().filter((w) => !allowed.includes(w.m)).map((w) => w.m);

/** what a client sees of an error: everything enumerable + message + status (the "body" of the problem) */
export const errBody = (e: any) => JSON.stringify({ code: e.code, message: e.message, detail: e.detail ?? null, errors: e.errors ?? null, status: e.statusCode, retry: e.retryAfterSeconds ?? null });
export type { FakeGoTrueGateway };
