// T7 test helpers (not a test file). Synthetic data only. Fixes the SEAMS the spec leaves open - the writer must match them or raise a dispute.
//
// Each handler file exports its wired Handler (registered in the manifest) AND a factory taking the seams (no service file: T7 owns only 3 handlers + repository/mfa.repo.ts):
//   handlers/verifyMfaChallenge.ts     verifyMfaChallenge        + createVerifyMfaChallenge(deps)
//   handlers/startMfaEnrolment.ts      startMfaEnrolment         + createStartMfaEnrolment(deps)
//   handlers/completeMfaEnrolment.ts   completeMfaEnrolment      + createCompleteMfaEnrolment(deps)
//   repository/mfa.repo.ts             createMfaRepo({ seal?, open? }), openerFromEnv(env)  (mirror of sealerFromEnv in auth-events.repo.ts)
//   deps = { gotrue: Pick<GoTrueGateway, 'mfaChallengeAndVerify'|'mfaEnrollTotp'|'adminDeleteFactor'>, repo: MfaRepo, events: {recordTenantless, recordTenant} (= createAuthEventsRepo),
//            limits: Pick<AuthLimits,'recordAccountFailure'|'clearAccountFailures'> (T6 adapter; key = hmac(normalised e-mail)), hmac?, newId?, now? }
//   Handler call = (req, hctx): hctx like T6 loginStaff (ctx.db.identityAuthTx, commitOnError, clientIp, requestId, bffKey, actor, log). req.headers.cookie carries `__Host-lims_sid=<43-char token>`
//   (OpenAPI bffSession); the token is hashed (sha256) and looked up through repo.sessionByToken. One ctx.db.identityAuthTx per request, ctl.noRetry(). A 4xx after commitOnError() is
//   RETURNED out of the tx callback (tx COMMITs) and re-thrown by the handler (P-42, same pattern as loginStaff).
//   MfaRepo (every method takes the request tx first; no SQL in the handlers; camelCase):
//     sessionByToken(tx, sha256: Buffer)         -> undefined | { sessionId, kind, state, tenantId|null, userId, membershipId|null, platformStaffId|null, tokenReused }   (app.identity_session_by_token)
//     loadSession(tx, { sessionId, tenantId, userId, kind }) -> { aal, accessToken, refreshToken (RAW, repo unseals), mfaFailedAttempts, email (normalised), accessExpiresAt, idleExpiresAt, absoluteExpiresAt }
//                                                  (row lock inside the repo: parallel wrong codes must not lose an increment)
//     updateSession(tx, ref {sessionId, tenantId, userId, kind}, patch)  patch keys (all optional): state, aal, accessToken, refreshToken, accessExpiresAt, mfaFailedAttempts,
//                                                  revoked { reason:'mfa_failed' }, actorId.  The repo seals tokens and picks the tenant UPDATE or app.identity_platform_auth_write_session_update.
//     factors(tx, { tenantId|null, userId })      -> [{ id, gotrueFactorId, status:'unverified'|'verified', verifiedAt|null, friendlyName|null }]   (own, non-removed rows only)
//     insertFactor(tx, { id, tenantId|null, userId, gotrueFactorId, friendlyName|null, actorId })   (status unverified)
//     markFactorVerified(tx, { id, tenantId|null, userId, at, actorId });  removeFactor(tx, { id, tenantId|null, userId, reason:'re_enrol', at, actorId })
//     touchMembershipLogin(tx, { tenantId, membershipId, at, actorId });   enqueue(tx, taskIdentifier, payload, jobKey);
//     recordPlatformEvent(tx, { id, eventType, targetType, targetId, actorPlatformStaffId, detail, requestId, clientIp, actorId })   (identity.platform_events, 08 A25 D-215)
//   startMfaEnrolment 200 body: { factor_id = the MIRROR row id (not the GoTrue id), otpauth_uri, secret_base32 }.  Auth event shape = auth.helpers.ts (AuthEvent).
import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { createFakeGoTrueGateway } from '../../gotrue/gateway.fake.js';
import type { GoTrueGateway, GoTrueTokens } from '../../gotrue/gateway.js';
import { totp } from '../../gotrue/__tests__/helpers.js';
import { EMAIL, HMAC_KEY, MEMB_A, REQ_ID, START, STAFF_ID, SYSTEM_ACTOR, TENANT_A, hmacHex, idN, makeLimits, rejection } from '../../service/__tests__/auth.helpers.js';

export { EMAIL, HMAC_KEY, MEMB_A, REQ_ID, STAFF_ID, SYSTEM_ACTOR, TENANT_A, hmacHex, idN, rejection, totp };
export const CLIENT_IP = '203.0.113.9';
export const COOKIE = '__Host-lims_sid';
export const sha256 = (s: string) => createHash('sha256').update(s).digest();
export const tokenN = (n: number) => `S${n.toString(36).padStart(42, '0')}`;      // 43 chars base64url-safe
export const SECRET_RE = /^[A-Z2-7]{16,}=*$/;

/** a code that is wrong at every step the fake / real GoTrue accepts (+-1) */
export function badCode(secret: string): string {
  const ok = new Set([-1, 0, 1].map((o) => totp(secret, Date.now(), o)));
  for (let i = 0; i < 1000; i++) { const c = String(100_000 + i * 7).padStart(6, '0'); if (!ok.has(c)) return c; }
  throw new Error('unreachable');
}

export interface SessionRow {
  sessionId: string; kind: 'tenant_staff' | 'platform'; state: string; tenantId: string | null; userId: string; membershipId: string | null; platformStaffId: string | null;
  tokenReused: boolean; aal: 'aal1' | 'aal2'; accessToken: string; refreshToken: string; mfaFailedAttempts: number; email: string;
  accessExpiresAt: Date; idleExpiresAt: Date; absoluteExpiresAt: Date; revokeReason?: string;
}
export interface FactorRow { id: string; tenantId: string | null; userId: string; gotrueFactorId: string; status: 'unverified' | 'verified'; verifiedAt: Date | null; friendlyName: string | null; removedReason?: string }
export interface Write { seq: number; m: string; arg: any; committed: boolean }

/** In-memory MfaRepo + events + a tx envelope with REAL commit/rollback semantics (P-42 oracle): a write is `committed` only when the identityAuthTx callback RETURNS. */
export function makeStore(clock: { ms: number }) {
  const sessions = new Map<string, SessionRow>();                       // key: sha256 hex of the cookie token
  const factors: FactorRow[] = [];
  const writes: Write[] = []; const order: string[] = [];
  let pending: Array<{ w: Write; undo?: () => void }> = []; let seq = 0;
  const rec = (m: string, arg: unknown, undo?: () => void) => { const w: Write = { seq: seq++, m, arg, committed: false }; writes.push(w); pending.push({ w, ...(undo ? { undo } : {}) }); order.push(m); };
  const same = (a: string | null, b: string | null) => (a ?? null) === (b ?? null);
  const byId = (id: string) => [...sessions.values()].find((s) => s.sessionId === id);

  const repo = {
    async sessionByToken(_tx: unknown, sha: Buffer) {
      order.push('sessionByToken'); const s = sessions.get(sha.toString('hex'));
      if (!s || s.state === 'revoked' || s.state === 'expired') return undefined;
      const { sessionId, kind, state, tenantId, userId, membershipId, platformStaffId, tokenReused } = s;
      return { sessionId, kind, state, tenantId, userId, membershipId, platformStaffId, tokenReused };
    },
    async loadSession(_tx: unknown, ref: { sessionId: string; tenantId: string | null; userId: string; kind: string }) {
      order.push('loadSession'); const s = byId(ref.sessionId);
      if (!s || !same(s.tenantId, ref.tenantId) || s.userId !== ref.userId) return undefined;
      return { aal: s.aal, accessToken: s.accessToken, refreshToken: s.refreshToken, mfaFailedAttempts: s.mfaFailedAttempts, email: s.email, accessExpiresAt: s.accessExpiresAt, idleExpiresAt: s.idleExpiresAt, absoluteExpiresAt: s.absoluteExpiresAt };
    },
    async updateSession(_tx: unknown, ref: { sessionId: string; tenantId: string | null; userId: string; kind: string }, patch: any) {
      const s = byId(ref.sessionId); const before = s ? { ...s } : undefined;
      rec('updateSession', { ref, patch }, () => { if (s && before) Object.assign(s, before); });
      if (!s) return;
      for (const k of ['state', 'aal', 'accessToken', 'refreshToken', 'accessExpiresAt', 'mfaFailedAttempts'] as const) if (patch[k] !== undefined) (s as any)[k] = patch[k];
      if (patch.revoked) { s.state = 'revoked'; s.revokeReason = patch.revoked.reason; }
    },
    async factors(_tx: unknown, q: { tenantId: string | null; userId: string }) {
      order.push('factors');
      return factors.filter((f) => !f.removedReason && f.userId === q.userId && same(f.tenantId, q.tenantId)).map((f) => ({ id: f.id, gotrueFactorId: f.gotrueFactorId, status: f.status, verifiedAt: f.verifiedAt, friendlyName: f.friendlyName }));
    },
    async insertFactor(_tx: unknown, a: any) {
      const row: FactorRow = { id: a.id, tenantId: a.tenantId ?? null, userId: a.userId, gotrueFactorId: a.gotrueFactorId, status: 'unverified', verifiedAt: null, friendlyName: a.friendlyName ?? null };
      factors.push(row); rec('insertFactor', a, () => { factors.splice(factors.indexOf(row), 1); });
    },
    async markFactorVerified(_tx: unknown, a: any) {
      const f = factors.find((x) => x.id === a.id && x.userId === a.userId && same(x.tenantId, a.tenantId ?? null)); const before = f ? { ...f } : undefined;
      rec('markFactorVerified', a, () => { if (f && before) Object.assign(f, before); }); if (f) { f.status = 'verified'; f.verifiedAt = a.at; }
    },
    async removeFactor(_tx: unknown, a: any) {
      const f = factors.find((x) => x.id === a.id && x.userId === a.userId && same(x.tenantId, a.tenantId ?? null)); const before = f ? { ...f } : undefined;
      rec('removeFactor', a, () => { if (f && before) Object.assign(f, before); }); if (f) f.removedReason = a.reason;
    },
    async touchMembershipLogin(_tx: unknown, a: any) { rec('touchMembershipLogin', a); },
    async enqueue(_tx: unknown, identifier: string, payload: Record<string, unknown>, jobKey: string) { rec('enqueue', { identifier, payload, jobKey }); },
    async recordPlatformEvent(_tx: unknown, e: any) { rec('recordPlatformEvent', e); },
  };
  const events = {
    async recordTenantless(_tx: unknown, e: any) { rec('recordTenantless', e); },
    async recordTenant(_tx: unknown, e: any) { rec('recordTenant', e); },
  };
  /** the identityAuthTx envelope: commit on return, roll back (undo) on throw */
  async function envelope<T>(fn: () => Promise<T>): Promise<T> {
    pending = [];
    try { const r = await fn(); for (const p of pending) p.w.committed = true; return r; } catch (e) { for (const p of [...pending].reverse()) p.undo?.(); throw e; } finally { pending = []; }
  }
  const committed = (m?: string) => writes.filter((w) => w.committed && (!m || w.m === m));
  const eventsOf = (type: string) => committed().filter((w) => (w.m === 'recordTenant' || w.m === 'recordTenantless') && w.arg.eventType === type).map((w) => w.arg);
  return { sessions, factors, writes, order, repo, events, envelope, committed, eventsOf, byId, now: () => clock.ms };
}

export interface MfaWorld extends Awaited<ReturnType<typeof makeMfaWorld>> {}

/** One whole world: a GoTrue gateway (fake by default; pass the HTTP gateway for the live run), a store, limits on a virtual clock, deps, ctx factory. */
export async function makeMfaWorld(o: { gateway?: GoTrueGateway; kind?: 'tenant_staff' | 'platform'; state?: string; verifiedFactor?: boolean; attempts?: number; email?: string; users?: number; live?: boolean } = {}) {
  const clock = { ms: START.getTime() };
  const gw: GoTrueGateway = o.gateway ?? (createFakeGoTrueGateway() as unknown as GoTrueGateway);
  const store = makeStore(clock);
  const lim = makeLimits({ clock });
  const kind = o.kind ?? 'tenant_staff';
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  let n = 0xf000;
  const calls: Array<{ method: string; args: unknown[] }> = [];
  // record every gateway call the handler makes (the real gateway object is untouched)
  const gotrue = new Proxy(gw, { get: (t, p: string) => (typeof (t as any)[p] === 'function' ? (...a: unknown[]) => { calls.push({ method: p, args: a }); return (t as any)[p](...a); } : (t as any)[p]) }) as GoTrueGateway;
  const deps = { gotrue, repo: store.repo, events: store.events, limits: lim.limits, hmac: (e: string) => hmacHex(e), newId: () => idN(n++), now: () => new Date(clock.ms) };

  /** create a GoTrue user (optionally with a VERIFIED TOTP factor, then a fresh aal1 session) and the matching identity.sessions row */
  async function addSession(a: { email?: string; state?: string; verifiedFactor?: boolean; kind?: 'tenant_staff' | 'platform'; attempts?: number; tenantId?: string | null; token?: string } = {}) {
    const email = a.email ?? o.email ?? `t7-${Date.now().toString(36)}-${(n++).toString(36)}@lims-test.example`;
    const password = `Zq7-${Math.random().toString(36).slice(2, 10)}-Lims!`;
    const u = await gw.adminCreateUser({ email, emailConfirm: true }); const userId = (u as any).userId as string;
    await gw.adminUpdatePassword(userId, password);
    let secret: string | undefined; let gotrueFactorId: string | undefined;
    if (a.verifiedFactor) {
      const s0 = await gw.signInWithPassword(email, password); if (!s0.ok) throw new Error('signin');
      const enr = await gw.mfaEnrollTotp(s0.tokens.accessToken, 'seed'); secret = enr.secret; gotrueFactorId = enr.factorId;
      const v = await gw.mfaChallengeAndVerify(s0.tokens.accessToken, enr.factorId, totp(enr.secret)); if (!v.ok) throw new Error('seed verify');
    }
    const r = await gw.signInWithPassword(email, password); if (!r.ok) throw new Error('signin');
    const t: GoTrueTokens = r.tokens; const k = a.kind ?? kind; const tenantId = k === 'platform' ? null : (a.tenantId === undefined ? TENANT_A : a.tenantId);
    const token = a.token ?? tokenN(n++);
    const row: SessionRow = { sessionId: idN(n++), kind: k, state: a.state ?? o.state ?? 'mfa_pending', tenantId, userId: t.userId, membershipId: k === 'platform' ? null : MEMB_A, platformStaffId: k === 'platform' ? STAFF_ID : null,
      tokenReused: false, aal: 'aal1', accessToken: t.accessToken, refreshToken: t.refreshToken, mfaFailedAttempts: a.attempts ?? o.attempts ?? 0, email,
      accessExpiresAt: new Date(t.expiresAt * 1000), idleExpiresAt: new Date(clock.ms + 30 * 60_000), absoluteExpiresAt: new Date(clock.ms + 12 * 3_600_000) };
    store.sessions.set(sha256(token).toString('hex'), row);
    let factorRowId: string | undefined;
    if (a.verifiedFactor && gotrueFactorId) { factorRowId = idN(n++); store.factors.push({ id: factorRowId, tenantId, userId: t.userId, gotrueFactorId, status: 'verified', verifiedAt: new Date(clock.ms - 86_400_000), friendlyName: 'seed' }); }
    return { email, password, userId: t.userId, token, row, secret, gotrueFactorId, factorRowId, tenantId };
  }

  const tx = { query: vi.fn(async (..._a: unknown[]) => ({ rows: [] })), bindTenant: vi.fn(async (id: string) => { if (tx.bindTenant.mock.calls.length > 1) throw new Error('bindTenant called twice (D-212)'); store.order.push(`bindTenant:${id}`); }) };
  const txCalls: any[] = [];
  /** hctx as the C0 core builds it for an identity_auth operation (T6 helper shape) */
  function makeHctx(c: Record<string, unknown> = {}) {
    tx.bindTenant.mockClear(); tx.query.mockClear();
    const commitOnError = vi.fn(() => { store.order.push('commitOnError'); });
    const forbidden = (nm: string) => () => { throw new Error(`MFA handlers must not use ctx.db.${nm}`); };
    const hctx: any = { operationId: 'verifyMfaChallenge', clientIp: CLIENT_IP, requestId: REQ_ID, bffKey: 'staff_web', actor: { type: 'system', id: SYSTEM_ACTOR }, log, commitOnError,
      rateLimit: { consume: vi.fn(async () => undefined) },
      db: { identityAuthTx: (input: any, fn: any) => { txCalls.push(input); return store.envelope(() => fn(tx, { noRetry: () => undefined })); }, tx: forbidden('tx'), requestTx: forbidden('requestTx'), withTenantScope: forbidden('withTenantScope') }, ...c };
    return { hctx, commitOnError };
  }
  const req = (a: { token?: string; body?: unknown; params?: Record<string, string>; headers?: Record<string, string> } = {}) => ({ params: a.params ?? {}, query: {}, body: a.body,
    headers: { ...(a.token ? { cookie: `theme=dark; ${COOKIE}=${a.token}; other=1` } : {}), 'user-agent': 'Mozilla/5.0 Firefox/130.0', ...(a.headers ?? {}) } });
  const advance = (ms: number) => { clock.ms += ms; };
  return { gw, gotrue, calls, store, lim, deps, log, tx, txCalls, makeHctx, req, addSession, clock, advance, kind };
}

/** the writes of `store.committed()` that are NOT in `allowed` (P-42: "no other write of that request survives") */
export const otherWrites = (s: ReturnType<typeof makeStore>, allowed: string[]) => s.committed().filter((w) => !allowed.includes(w.m)).map((w) => w.m);
export { LimsError };
