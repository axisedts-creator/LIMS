// T6 test helpers (not a test file). Synthetic data only. Fixes the SEAMS the spec leaves open - the writer must match them or raise a dispute.
//
//   ../auth.service.ts   exports `createAuthService(deps)` -> { loginStaff(ctx, input) => Promise<{ status: 200; body: LoginResult }> }. Failures THROW LimsError
//                        (err.code, err.retryAfterSeconds for 429). deps (all optional except gotrue/repo/events/limits):
//        gotrue   Pick<GoTrueGateway,'signInWithPassword'>
//        repo     AuthRepo (below; every method takes the request tx first; no SQL in the service)
//        events   { recordTenantless(tx, e), recordTenant(tx, e) }  = repository/auth-events.repo.ts (DEFINER app.identity_record_auth_event / auth_events__insert__tenant)
//        limits   AuthLimits (below) = the C2 adapter over C0 ctx.rateLimit.consume (`login` tier, keys a:<hmac> / f:<ip>, 02-TRD s4 item 11). The C0 limiter has no
//                 non-consuming read and no `f:` rule yet (core/ratelimit/index.ts RULES) - see notes/T6-tests.md "spec gap"; the service must only use this seam.
//        hmac     (normalisedEmail) => 64-char lowercase hex (HMAC-SHA-256, LIMS_IDENTITY_EMAIL_HMAC_KEY); default built from that env var
//        newId    () => uuid;  newToken () => 43-char base64url app session token
//        sleep    (ms) => Promise<void> (default setTimeout);  floorMs (default 400, 03-APP-FLOW s3.1 rule 2)
//        alert    (code, detail) => void  codes: 'identity_multi_membership' | 'login_ip_throttled' | 'platform_ip_denied' (never carries email/password)
//   ctx (identityAuthTx request context) = { actor{type:'system',id}, requestId, clientIp, userAgent?, bffKey:'staff_web'|'partner', tx, now(), commitOnError(), log }.
//        tx = the identityAuthTx tx: query() and bindTenant(tenantId) (once per tx, D-212). The SERVICE calls tx.bindTenant after the membership is known and BEFORE any
//        tenant write (sessions / tenant auth event / last_login_at); platform staff and tenant-less failures never bind.
//   input = { email, password } only (camel == snake here). The tenant, membership, kind and state come ONLY from app.identity_login_context, never from input.
//   repo.loginContext(tx, sub) -> the one app.identity_login_context row (snake_case); insertSession(tx, s) / insertPlatformSession(tx, s) with
//        s = { id, tenantId|null, kind, userId, membershipId|null, platformStaffId|null, gotrueSessionId, tokenSha256: Buffer (sha256 of the 43-char app token),
//              state, aal, accessToken, refreshToken (RAW GoTrue tokens - the repo seals them into the *_enc columns), accessExpiresAt, idleTimeoutMinutes, idleExpiresAt,
//              absoluteExpiresAt, expiresAt, clientIp, userAgent, actorId };  touchMembershipLogin(tx, {tenantId, membershipId, at, actorId});
//        platformStaffLogin(tx, {platformStaffId, at});  enqueue(tx, taskIdentifier, payload, jobKey) (02-TRD s10, as platform-staff).
//   Every 4xx path: write its auth event (+ enqueue), call ctx.commitOnError() exactly once BEFORE throwing, and write nothing else (P-42).
//   Failure auth events are tenant-less (events.recordTenantless) unless the tenant is known (locked / inactive / suspended -> events.recordTenant after bindTenant).
//   Event shape e = { id, eventType, reasonCode?, userId?, membershipId?, tenantId? (recordTenant only), platformStaffId?, sessionId?, emailHmacHex?, clientIp, userAgent?, requestId, actorId }.
import { createHash, createHmac } from 'node:crypto';
import { vi } from 'vitest';
import { LimsError } from '../../../../core/errors.js';

export const idN = (n: number) => `0190a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
export const SYSTEM_ACTOR = idN(0x1), TENANT_A = idN(0xa1), TENANT_B = idN(0xa2), MEMB_A = idN(0xb1), MEMB_B = idN(0xb2), STAFF_ID = idN(0xd2), REQ_ID = idN(0xe1);
export const START = new Date('2026-11-11T04:00:00.000Z');
export const ACCESS = 'ACCESS-TOKEN-SENTINEL-a1b2', REFRESH = 'REFRESH-TOKEN-SENTINEL-c3d4', PASSWORD = 'Pw-SENTINEL-correct-horse-9';
export const HMAC_KEY = 'test-identity-email-hmac-key';
export const hmacHex = (email: string) => createHmac('sha256', HMAC_KEY).update(email).digest('hex');
export const sha256 = (s: string) => createHash('sha256').update(s).digest();
export const rejection = async (p: unknown): Promise<any> => { try { await (typeof p === 'function' ? (p as () => unknown)() : p); } catch (e) { return e; } throw new Error('expected rejection, got success'); };

/** One row of app.identity_login_context (05-SCHEMA s6, snake_case verbatim). */
export type LoginRow = Record<string, unknown>;
export const tenantRow = (o: LoginRow = {}): LoginRow => ({
  platform_staff_id: null, platform_role: null, platform_active: null, platform_allowed_cidrs: null, membership_count: 1, tenant_id: TENANT_A, tenant_status: 'active',
  membership_id: MEMB_A, membership_status: 'active', membership_locked: false, mfa_required: false, has_verified_factor: false, idle_timeout_minutes: 30, absolute_session_hours: 12, ...o,
});
export const platformRow = (o: LoginRow = {}): LoginRow => tenantRow({
  platform_staff_id: STAFF_ID, platform_role: 'platform_support', platform_active: true, platform_allowed_cidrs: [], membership_count: 0, tenant_id: null, tenant_status: null,
  membership_id: null, membership_status: null, membership_locked: null, mfa_required: true, has_verified_factor: true, idle_timeout_minutes: null, absolute_session_hours: null, ...o,
});
/** user exists in GoTrue but has no `user` membership and no platform_staff row (e.g. partner-only user): function returns all-null facts, count 0. */
export const noMembershipRow = (): LoginRow => tenantRow({ membership_count: 0, tenant_id: null, tenant_status: null, membership_id: null, membership_status: null, membership_locked: null,
  idle_timeout_minutes: null, absolute_session_hours: null });

export interface World { clock: { ms: number }; [k: string]: any }

/** In-memory GoTrue: users keyed by normalised email. Unknown email and wrong password are both { ok: false } (no oracle at the seam). `delayMs` advances the virtual clock or really waits. */
export function makeGotrue(w: { clock: { ms: number } }, users: Record<string, { password: string; sub: string; session?: string; aal?: 'aal1' | 'aal2' }>, o: { wrongDelayMs?: number; real?: boolean; fail?: Error } = {}) {
  const calls: Array<{ email: string; password: string }> = [];
  const gotrue = {
    signInWithPassword: vi.fn(async (email: string, password: string) => {
      calls.push({ email, password });
      if (o.fail) throw o.fail;
      const u = users[email];
      const ok = !!u && u.password === password;
      const d = ok ? 0 : (o.wrongDelayMs ?? 0);
      if (d) { if (o.real) await new Promise((r) => setTimeout(r, d)); else w.clock.ms += d; }
      if (!ok) return { ok: false as const };
      return { ok: true as const, tokens: { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: Math.floor(w.clock.ms / 1000) + 3600, sessionId: u!.session ?? idN(0x5e55), userId: u!.sub, aal: u!.aal ?? 'aal1' } };
    }),
  };
  return { gotrue, calls };
}

/** In-memory AuthLimits with REAL window semantics on the virtual clock (the contract the C2 adapter over C0 consume() must honour):
 *   consumeAttempt(accountKey)  a:<hmac>  10 attempts / sliding 60 min; the 11th throws common.rate_limited, retryAfterSeconds = seconds until the oldest leaves the window
 *   accountState(accountKey)    { failures (sliding 60 min: login + MFA failures), lastFailureAt }
 *   recordAccountFailure / clearAccountFailures(accountKey)
 *   checkIp(ip)                 throws common.rate_limited only while the throttle is engaged AND the IP already made 5 attempts in the last 60 s (counts this one)
 *   recordIpFailure(ip)         f:<ip> failures only; 10 within 10 min engages a 30-min throttle; returns { engaged: true, windowStart } ONLY on the call that engages it */
export function makeLimits(w: { clock: { ms: number } }) {
  const att = new Map<string, number[]>(), fails = new Map<string, number[]>(), ipFails = new Map<string, number[]>(), ipAtt = new Map<string, number[]>(), until = new Map<string, number>();
  const calls: Array<{ m: string; key: string }> = [];
  const prune = (m: Map<string, number[]>, k: string, win: number) => { const a = (m.get(k) ?? []).filter((t) => t > w.clock.ms - win); m.set(k, a); return a; };
  const limited = (retryMs: number) => Object.assign(new LimsError('common.rate_limited'), { retryAfterSeconds: Math.max(1, Math.ceil(retryMs / 1000)) });
  const limits = {
    async consumeAttempt(k: string) {
      calls.push({ m: 'consumeAttempt', key: k });
      const a = prune(att, k, 3_600_000);
      if (a.length >= 10) throw limited(a[0]! + 3_600_000 - w.clock.ms);
      a.push(w.clock.ms);
    },
    async accountState(k: string) { calls.push({ m: 'accountState', key: k }); const a = prune(fails, k, 3_600_000); return { failures: a.length, lastFailureAt: a.length ? new Date(a[a.length - 1]!) : null }; },
    async recordAccountFailure(k: string) { calls.push({ m: 'recordAccountFailure', key: k }); prune(fails, k, 3_600_000).push(w.clock.ms); },
    async clearAccountFailures(k: string) { calls.push({ m: 'clearAccountFailures', key: k }); fails.set(k, []); },
    async checkIp(ip: string) {
      calls.push({ m: 'checkIp', key: ip });
      if ((until.get(ip) ?? 0) <= w.clock.ms) return;
      const a = prune(ipAtt, ip, 60_000);
      if (a.length >= 5) throw limited(a[0]! + 60_000 - w.clock.ms);
      a.push(w.clock.ms);
    },
    async recordIpFailure(ip: string) {
      calls.push({ m: 'recordIpFailure', key: ip });
      const a = prune(ipFails, ip, 600_000); a.push(w.clock.ms);
      if (a.length >= 10 && (until.get(ip) ?? 0) <= w.clock.ms) { until.set(ip, w.clock.ms + 1_800_000); return { engaged: true as const, windowStart: new Date(a[0]!) }; }
      return { engaged: false as const, windowStart: new Date(a[0]!) };
    },
  };
  return { limits, calls, throttledUntil: (ip: string) => until.get(ip) };
}

/** In-memory AuthRepo + events + enqueue. `writes` = every DB write in call order (the P-42 "no other write survives" oracle). */
export const DB_WRITES = ['insertSession', 'touchMembershipLogin', 'insertPlatformSession', 'platformStaffLogin', 'recordTenantless', 'recordTenant', 'enqueue'] as const;
export function makeRepo(rows: Record<string, LoginRow> | ((sub: string) => LoginRow)) {
  const writes: Array<{ m: string; tx: unknown; arg: any }> = [];
  const order: string[] = [];
  const rec = (m: string, tx: unknown, arg: unknown) => { writes.push({ m, tx, arg }); order.push(m); };
  const repo = {
    async loginContext(_tx: unknown, sub: string) { order.push('loginContext'); return typeof rows === 'function' ? rows(sub) : (rows[sub] ?? noMembershipRow()); },
    async insertSession(tx: unknown, s: any) { rec('insertSession', tx, s); },
    async touchMembershipLogin(tx: unknown, a: any) { rec('touchMembershipLogin', tx, a); },
    async insertPlatformSession(tx: unknown, s: any) { rec('insertPlatformSession', tx, s); },
    async platformStaffLogin(tx: unknown, a: any) { rec('platformStaffLogin', tx, a); },
    async enqueue(tx: unknown, identifier: string, payload: Record<string, unknown>, jobKey: string) { rec('enqueue', tx, { identifier, payload, jobKey }); },
  };
  const events = {
    async recordTenantless(tx: unknown, e: any) { rec('recordTenantless', tx, e); },
    async recordTenant(tx: unknown, e: any) { rec('recordTenant', tx, e); },
  };
  return { repo, events, writes, order, by: (m: string) => writes.filter((x) => x.m === m).map((x) => x.arg) };
}

export const EMAIL = 'ana.demo@example.test';
export const SUB = idN(0xa300);

/** Whole world for one test: users, login-context rows keyed by sub, virtual clock, limits, ctx factory. */
export function makeWorld(o: { users?: Record<string, { password: string; sub: string; session?: string; aal?: 'aal1' | 'aal2' }>; rows?: Record<string, LoginRow> | ((sub: string) => LoginRow);
  wrongDelayMs?: number; gotrueFail?: Error } = {}) {
  const clock = { ms: START.getTime() };
  const w: World = { clock };
  const g = makeGotrue(w, o.users ?? { [EMAIL]: { password: PASSWORD, sub: SUB } }, { wrongDelayMs: o.wrongDelayMs ?? 0, ...(o.gotrueFail ? { fail: o.gotrueFail } : {}) });
  const r = makeRepo(o.rows ?? { [SUB]: tenantRow() });
  const l = makeLimits(w);
  const alerts: Array<{ code: string; detail: unknown }> = [];
  const sleeps: number[] = [];
  let n = 0xc000;
  const deps = {
    gotrue: g.gotrue, repo: r.repo, events: r.events, limits: l.limits,
    hmac: (e: string) => hmacHex(e), newId: () => idN(n++), newToken: () => `T${(n++).toString(36).padStart(42, '0')}`,
    sleep: async (ms: number) => { sleeps.push(ms); clock.ms += ms; }, alert: (code: string, detail: unknown) => { alerts.push({ code, detail }); },
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const makeCtx = (c: Record<string, unknown> = {}) => {
    const order: string[] = [];
    const tx = { query: vi.fn(async (..._a: unknown[]) => ({ rows: [] })), bindTenant: vi.fn(async (id: string) => { order.push(`bindTenant:${id}`); r.order.push('bindTenant'); }) };
    const commitOnError = vi.fn(() => { r.order.push('commitOnError'); });
    const ctx: any = { actor: { type: 'system', id: SYSTEM_ACTOR }, requestId: REQ_ID, clientIp: '203.0.113.9', userAgent: 'Mozilla/5.0 (Windows NT 10.0) Firefox/130.0', bffKey: 'staff_web',
      tx, now: () => new Date(clock.ms), commitOnError, log, ...c };
    return { ctx, tx, commitOnError };
  };
  return { w, clock, deps, makeCtx, log, alerts, sleeps, gotrue: g, repo: r, limits: l, advance: (ms: number) => { clock.ms += ms; } };
}
export type WorldT = ReturnType<typeof makeWorld>;
