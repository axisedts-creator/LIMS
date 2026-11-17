// T6 loginStaff behaviour (03-APP-FLOW s3.1/3.3, 01-PRD AC-A1.1-7, 07-SECURITY AU-T1/T2/T2a/T2b/T2c/T10/T19/T22/T23, 08 A1/A6.6/A8.1/A19 P-42/A25). Seams: auth.helpers.ts header.
// Expected now: every test fails - ../auth.service.js does not exist.
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { createAuthService } from '../auth.service.js';
import { ACCESS, DB_WRITES, EMAIL, MEMB_A, MEMB_B, PASSWORD, REFRESH, START, STAFF_ID, SUB, TENANT_A, TENANT_B, hmacHex, idN, makeWorld, noMembershipRow, platformRow, rejection, sha256, tenantRow, type WorldT } from './auth.helpers.js';

const FLOOR = 400;
const input = (o: Record<string, unknown> = {}) => ({ email: EMAIL, password: PASSWORD, ...o });
const login = (w: WorldT, i: Record<string, unknown> = input(), c: Record<string, unknown> = {}) => { const { ctx } = w.makeCtx(c); return createAuthService(w.deps as any).loginStaff(ctx, i as any); };
const fail = async (w: WorldT, i: Record<string, unknown> = input(), c: Record<string, unknown> = {}) => { const k = w.makeCtx(c); const e = await rejection(createAuthService(w.deps as any).loginStaff(k.ctx, i as any)); return { e, ...k }; };
const names = (w: WorldT) => w.repo.writes.map((x) => x.m);
const FORBIDDEN_ON_FAILURE = ['insertSession', 'touchMembershipLogin', 'insertPlatformSession', 'platformStaffLogin'];
const user = (n: number) => ({ email: `user${n}@example.test`, sub: idN(0xf000 + n) });

describe('AC-A1.1 success (tenant staff, no MFA)', () => {
  it('200 { session_token(43 b64url), session{ state active, kind tenant_staff, aal1 } }; no GoTrue token in the body; commitOnError NOT called', async () => {
    const w = makeWorld(); const k = w.makeCtx();
    const r: any = await createAuthService(w.deps as any).loginStaff(k.ctx, input() as any);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['session', 'session_token']);
    expect(r.body.session_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.body.session).toMatchObject({ kind: 'tenant_staff', state: 'active', aal: 'aal1' });
    expect(JSON.stringify(r)).not.toContain(ACCESS); expect(JSON.stringify(r)).not.toContain(REFRESH); expect(JSON.stringify(r)).not.toContain(PASSWORD);
    expect(k.commitOnError).not.toHaveBeenCalled();
  });
  it('session row: bindTenant(tenant from login_context) BEFORE insert; row bound to ctx.clientIp / UA; token_sha256 = sha256(session_token); raw app token never stored; idle/absolute from tenant settings', async () => {
    const w = makeWorld(); const k = w.makeCtx();
    const r: any = await createAuthService(w.deps as any).loginStaff(k.ctx, input() as any);
    expect(k.tx.bindTenant).toHaveBeenCalledTimes(1); expect(k.tx.bindTenant).toHaveBeenCalledWith(TENANT_A);
    expect(w.repo.order.indexOf('bindTenant')).toBeLessThan(w.repo.order.indexOf('insertSession'));
    const [s] = w.repo.by('insertSession');
    expect(s).toMatchObject({ tenantId: TENANT_A, kind: 'tenant_staff', userId: SUB, membershipId: MEMB_A, state: 'active', aal: 'aal1', clientIp: '203.0.113.9', userAgent: expect.stringContaining('Firefox'), idleTimeoutMinutes: 30 });
    expect(Buffer.from(s.tokenSha256).equals(sha256(r.body.session_token))).toBe(true);
    expect(JSON.stringify(Object.entries(s).filter(([key]) => key !== 'accessToken' && key !== 'refreshToken'))).not.toContain(r.body.session_token);
    expect(JSON.stringify(s)).toContain(ACCESS); expect(JSON.stringify(s)).toContain(REFRESH); // raw GoTrue tokens go to the repo, which seals them (enc columns)
    expect(s.idleExpiresAt.getTime()).toBe(START.getTime() + 30 * 60_000); expect(s.absoluteExpiresAt.getTime()).toBe(START.getTime() + 12 * 3_600_000);
    expect(w.repo.by('touchMembershipLogin')).toHaveLength(1);
    expect(w.repo.by('recordTenant')).toHaveLength(1); expect(w.repo.by('recordTenant')[0]).toMatchObject({ eventType: 'login_succeeded', tenantId: TENANT_A, userId: SUB, membershipId: MEMB_A, clientIp: '203.0.113.9', requestId: idN(0xe1) });
    expect(w.repo.by('recordTenantless')).toHaveLength(0);
  });
  it('SS2 verified factor -> mfa_pending (event login_password_ok, no last_login_at); SS3 mfa required without factor -> mfa_enrolment_required; mfa not required -> active even with aal1 tokens', async () => {
    const a = makeWorld({ rows: { [SUB]: tenantRow({ mfa_required: true, has_verified_factor: true }) } }); const ra: any = await login(a);
    expect(ra.body.session).toMatchObject({ state: 'mfa_pending', aal: 'aal1' }); expect(a.repo.by('recordTenant')[0]).toMatchObject({ eventType: 'login_password_ok' }); expect(a.repo.by('touchMembershipLogin')).toHaveLength(0);
    const b = makeWorld({ rows: { [SUB]: tenantRow({ mfa_required: true, has_verified_factor: false }) } }); const rb: any = await login(b);
    expect(rb.body.session.state).toBe('mfa_enrolment_required'); expect(b.repo.by('recordTenant')[0]).toMatchObject({ eventType: 'login_password_ok' });
    const c = makeWorld({ rows: { [SUB]: tenantRow({ mfa_required: false, has_verified_factor: true }) } }); const rc: any = await login(c);
    expect(rc.body.session.state).toBe('mfa_pending'); // a user who already has a verified factor is always challenged (SS2)
  });
  it('successful login clears the account failure counter (03-APP-FLOW s3.3) and never touches the per-IP failure counter', async () => {
    const w = makeWorld(); await login(w);
    expect(w.limits.calls.filter((c) => c.m === 'clearAccountFailures')).toEqual([{ m: 'clearAccountFailures', key: hmacHex(EMAIL) }]);
    expect(w.limits.calls.some((c) => c.m === 'recordIpFailure' || c.m === 'recordAccountFailure')).toBe(false);
  });
  it('rule 1: email normalised (trim, NFC, lowercase) before GoTrue and before the HMAC; the account key is the HMAC, never the e-mail', async () => {
    const nfd = 'jose\u0301@Example.TEST'; const norm = 'jos\u00e9@example.test';
    const w = makeWorld({ users: { [norm]: { password: PASSWORD, sub: SUB } } });
    const r: any = await login(w, input({ email: `  ${nfd}  ` })); expect(r.status).toBe(200);
    expect(w.gotrue.calls[0]!.email).toBe(norm);
    expect(w.limits.calls.every((c) => !c.key.includes('example') && !c.key.includes('jos'))).toBe(true);
    expect(w.limits.calls.find((c) => c.m === 'consumeAttempt')!.key).toBe(hmacHex(norm));
  });
  it('forged tenant_id / membership_id / kind in the input are ignored: tenant comes from login_context only', async () => {
    const w = makeWorld({ rows: { [SUB]: tenantRow({ tenant_id: TENANT_A, membership_id: MEMB_A }) } }); const k = w.makeCtx();
    await createAuthService(w.deps as any).loginStaff(k.ctx, input({ tenant_id: TENANT_B, membership_id: MEMB_B, kind: 'platform', state: 'active', user_id: idN(0x99) }) as any);
    expect(k.tx.bindTenant).toHaveBeenCalledWith(TENANT_A); expect(k.tx.bindTenant).toHaveBeenCalledTimes(1);
    expect(w.repo.by('insertSession')[0]).toMatchObject({ tenantId: TENANT_A, membershipId: MEMB_A, kind: 'tenant_staff', userId: SUB });
  });
  it('partner BFF key on loginStaff (AU-T14): 401 auth.login_failed, GoTrue never called, no session', async () => {
    const w = makeWorld(); const { e, commitOnError } = await fail(w, input(), { bffKey: 'partner' });
    expect(e.code).toBe('auth.login_failed'); expect(w.gotrue.calls).toHaveLength(0); expect(names(w).filter((n) => FORBIDDEN_ON_FAILURE.includes(n))).toEqual([]); expect(commitOnError).toHaveBeenCalledTimes(1);
  });
});

describe('AC-A1.2 wrong password vs unknown e-mail: identical, timing floor, no oracle', () => {
  const both = async () => {
    const wrong = makeWorld({ wrongDelayMs: 90 }); const a = await fail(wrong, input({ password: 'wrong-password-1' }));
    const unknown = makeWorld({ wrongDelayMs: 0 }); const b = await fail(unknown, input({ email: 'nobody@example.test' }));
    return { wrong, unknown, a, b };
  };
  it('401 auth.login_failed with identical code/message/detail', async () => {
    const { a, b } = await both();
    expect(a.e.code).toBe('auth.login_failed'); expect(b.e.code).toBe('auth.login_failed');
    expect([a.e.message, a.e.detail, a.e.errors]).toEqual([b.e.message, b.e.detail, b.e.errors]);
    expect(JSON.stringify([a.e.message, a.e.detail])).not.toContain('wrong-password-1');
  });
  it('rule 2: failure is delayed to a floor of 400 ms from request start - both cases end at the same virtual time (90 ms bcrypt vs 0 ms)', async () => {
    const { wrong, unknown } = await both();
    expect(wrong.clock.ms - START.getTime()).toBe(FLOOR); expect(unknown.clock.ms - START.getTime()).toBe(FLOOR);
    expect(wrong.sleeps.reduce((s, x) => s + x, 0)).toBe(FLOOR - 90); expect(unknown.sleeps.reduce((s, x) => s + x, 0)).toBe(FLOOR);
  });
  it('a slow failure (> floor) is not padded further', async () => {
    const w = makeWorld({ wrongDelayMs: 500 }); await fail(w, input({ password: 'wrong-password-1' }));
    expect(w.clock.ms - START.getTime()).toBe(500); expect(w.sleeps.filter((x) => x > 0)).toEqual([]);
  });
  it('AU-T1 timing: real clock, p95 of |wrong - unknown| response time <= 50 ms over 100 trials each', async () => {
    const floorMs = 60; // injected smaller floor keeps the suite fast; the production floor (400 ms) is asserted above
    const N = 100, mail = (k: string, i: number) => `${k}${i}@example.test`; // distinct account + distinct IP per trial: no per-account / per-IP limit can interfere
    const users: Record<string, { password: string; sub: string }> = {}; for (let i = 0; i < N; i += 1) users[mail('wrong', i)] = { password: PASSWORD, sub: idN(0xe000 + i) };
    const mk = (delay: number) => { const w = makeWorld({ users }); (w.gotrue.gotrue as any).signInWithPassword.mockImplementation(async () => { if (delay) await new Promise((r) => setTimeout(r, delay)); return { ok: false }; });
      const d: any = { ...w.deps, floorMs, sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)) }; return { w, svc: createAuthService(d) }; };
    const wrong = mk(8), unknown = mk(0); // 8 ms = simulated bcrypt on a known account
    const t = async (m: ReturnType<typeof mk>, email: string, i: number) => { const k = m.w.makeCtx({ now: () => new Date(), clientIp: `10.1.${i >> 8}.${i & 255}` }); const s = performance.now(); await rejection(m.svc.loginStaff(k.ctx, { email, password: 'wrong-password-1' } as any)); return performance.now() - s; };
    const A: number[] = [], B: number[] = [];
    for (let batch = 0; batch < 10; batch += 1) {
      const idx = Array.from({ length: 10 }, (_, j) => batch * 10 + j);
      const r = await Promise.all([...idx.map((i) => t(wrong, mail('wrong', i), i)), ...idx.map((i) => t(unknown, mail('nobody', i), i))]);
      A.push(...r.slice(0, 10)); B.push(...r.slice(10));
    }
    const p95 = (x: number[]) => [...x].sort((p, q) => p - q)[Math.floor(x.length * 0.95) - 1]!;
    expect(Math.abs(p95(A) - p95(B))).toBeLessThanOrEqual(50); expect(Math.min(...A, ...B)).toBeGreaterThanOrEqual(floorMs - 2);
  }, 20_000);
  it('failure event is tenant-less login_failed carrying only the e-mail HMAC (REQ-SEC-074) - identical for both cases; the e-mail and password appear in no write, log or alert', async () => {
    const { wrong, unknown } = await both();
    for (const [w, mail] of [[wrong, EMAIL], [unknown, 'nobody@example.test']] as const) {
      expect(w.repo.by('recordTenantless')).toHaveLength(1); expect(w.repo.by('recordTenant')).toHaveLength(0);
      expect(w.repo.by('recordTenantless')[0]).toMatchObject({ eventType: 'login_failed', emailHmacHex: hmacHex(mail), clientIp: '203.0.113.9', requestId: idN(0xe1), userAgent: expect.any(String) });
      const blob = JSON.stringify([w.repo.writes.map((x) => x.arg), w.log.info.mock.calls, w.log.warn.mock.calls, w.log.error.mock.calls, w.alerts]);
      expect(blob).not.toContain(mail); expect(blob).not.toContain('wrong-password-1'); expect(blob).not.toContain(PASSWORD);
    }
    expect(wrong.repo.by('recordTenantless')[0]).not.toHaveProperty('tenantId');
  });
  it('failure: account counter +1 (hmac key) and per-IP failure counter +1 under ctx.clientIp; commitOnError once; no tenant bound', async () => {
    const w = makeWorld(); const { commitOnError, tx } = await fail(w, input({ password: 'wrong-password-1' }), { clientIp: '198.51.100.77' });
    expect(w.limits.calls.filter((c) => c.m === 'recordAccountFailure')).toEqual([{ m: 'recordAccountFailure', key: hmacHex(EMAIL) }]);
    expect(w.limits.calls.filter((c) => c.m === 'recordIpFailure')).toEqual([{ m: 'recordIpFailure', key: '198.51.100.77' }]);
    expect(commitOnError).toHaveBeenCalledTimes(1); expect(tx.bindTenant).not.toHaveBeenCalled();
  });
  it('GoTrue unreachable: the request fails (never 200), no session, and the outage is NOT counted as a credential failure', async () => {
    const w = makeWorld({ gotrueFail: new Error('connect ECONNREFUSED') }); const { e } = await fail(w);
    expect(e).toBeInstanceOf(Error); expect(e.code).not.toBe('auth.login_failed');
    expect(names(w).filter((n) => FORBIDDEN_ON_FAILURE.includes(n))).toEqual([]); expect(w.limits.calls.some((c) => c.m === 'recordAccountFailure' || c.m === 'recordIpFailure')).toBe(false);
  });
});

describe('403 outcomes after a correct password (AC-A1.3, AC-A1.4, 08 A8.1)', () => {
  const blocked = async (row: Record<string, unknown>, code: string, ev: string) => {
    const w = makeWorld({ rows: { [SUB]: row as any } }); const { e, commitOnError, tx } = await fail(w);
    expect(e.code).toBe(code); expect(commitOnError).toHaveBeenCalledTimes(1);
    expect(tx.bindTenant).toHaveBeenCalledWith(TENANT_A); expect(tx.bindTenant).toHaveBeenCalledTimes(1);
    expect(w.repo.by('recordTenant')).toHaveLength(1); expect(w.repo.by('recordTenant')[0]).toMatchObject({ eventType: ev, tenantId: TENANT_A, userId: SUB, membershipId: MEMB_A });
    expect(w.repo.by('recordTenantless')).toHaveLength(0);
    expect(w.repo.order.indexOf('bindTenant')).toBeLessThan(w.repo.order.indexOf('recordTenant'));
    const so = w.repo.writes.filter((x) => x.m === 'enqueue').map((x) => x.arg); expect(so).toHaveLength(1); expect(so[0].identifier).toBe('identity.gotrue_signout');
    expect(JSON.stringify(so[0])).not.toContain(ACCESS); expect(JSON.stringify(so[0])).not.toContain(REFRESH); expect(JSON.stringify(so[0])).toMatch(new RegExp(`${SUB}|${idN(0x5e55)}`)); expect(so[0].jobKey).toMatch(/^signout:/);
    return w;
  };
  it('AC-A1.3 locked membership -> 403 auth.account_locked, event login_blocked_locked, GoTrue sign-out job, no session row', async () => { await blocked(tenantRow({ membership_locked: true }), 'auth.account_locked', 'login_blocked_locked'); });
  it('AC-A1.4 suspended tenant -> 403 identity.tenant_suspended, event login_blocked_tenant_suspended', async () => { await blocked(tenantRow({ tenant_status: 'suspended' }), 'identity.tenant_suspended', 'login_blocked_tenant_suspended'); });
  it('08 A8.1 only user membership deactivated (count 0) -> 403 identity.membership_inactive (never multi-membership), event login_blocked_inactive', async () => {
    await blocked(tenantRow({ membership_status: 'deactivated', membership_count: 0 }), 'identity.membership_inactive', 'login_blocked_inactive');
  });
  it('an invited (not yet active) membership -> 403 identity.membership_inactive', async () => { await blocked(tenantRow({ membership_status: 'invited', membership_count: 0 }), 'identity.membership_inactive', 'login_blocked_inactive'); });
  it('a correct password on a blocked account does not count as a credential failure (no f:/a: failure recorded, no throttle progress)', async () => {
    const w = makeWorld({ rows: { [SUB]: tenantRow({ membership_locked: true }) } }); await fail(w);
    expect(w.limits.calls.some((c) => c.m === 'recordAccountFailure' || c.m === 'recordIpFailure')).toBe(false);
  });
});

describe('08 A6.6 / A8.1 multi-membership and membership choice (05-SCHEMA s11 tests 19/20 are pgTAP; here the service contract on top of login_context)', () => {
  it('membership_count 2 -> 401 auth.login_failed + alert identity_multi_membership; no session, no 403 leak', async () => {
    const w = makeWorld({ rows: { [SUB]: tenantRow({ membership_count: 2 }) } }); const { e, commitOnError } = await fail(w);
    expect(e.code).toBe('auth.login_failed'); expect(w.alerts.map((a) => a.code)).toContain('identity_multi_membership'); expect(commitOnError).toHaveBeenCalledTimes(1);
    expect(names(w).filter((n) => FORBIDDEN_ON_FAILURE.includes(n))).toEqual([]);
    expect(JSON.stringify(w.alerts)).not.toContain(EMAIL);
  });
  it('user active in tenant B (deactivated in A elsewhere): login_context reports B, count 1 -> 200 and the session is bound to B (08 A8.1 / AU-T19)', async () => {
    const w = makeWorld({ rows: { [SUB]: tenantRow({ tenant_id: TENANT_B, membership_id: MEMB_B, membership_count: 1 }) } }); const k = w.makeCtx();
    const r: any = await createAuthService(w.deps as any).loginStaff(k.ctx, input() as any);
    expect(r.status).toBe(200); expect(k.tx.bindTenant).toHaveBeenCalledWith(TENANT_B); expect(w.repo.by('insertSession')[0]).toMatchObject({ tenantId: TENANT_B, membershipId: MEMB_B });
  });
  it('count 0 + status deactivated is NOT the multi-membership data error (no alert)', async () => {
    const w = makeWorld({ rows: { [SUB]: tenantRow({ membership_count: 0, membership_status: 'deactivated' }) } }); const { e } = await fail(w);
    expect(e.code).toBe('identity.membership_inactive'); expect(w.alerts).toEqual([]);
  });
  it('a user with no user membership and no platform_staff row (e.g. partner-only, AU-T14) -> 401 auth.login_failed, no session', async () => {
    const w = makeWorld({ rows: { [SUB]: noMembershipRow() } }); const { e, commitOnError } = await fail(w);
    expect(e.code).toBe('auth.login_failed'); expect(names(w).filter((n) => FORBIDDEN_ON_FAILURE.includes(n))).toEqual([]); expect(commitOnError).toHaveBeenCalledTimes(1);
  });
});

describe('platform staff (08 A28.1, AU-T10, AU-T24)', () => {
  it('success: kind platform session through insertPlatformSession + platformStaffLogin only; never bindTenant / tenant writes; MFA always required', async () => {
    const w = makeWorld({ rows: { [SUB]: platformRow({ has_verified_factor: true }) } }); const k = w.makeCtx();
    const r: any = await createAuthService(w.deps as any).loginStaff(k.ctx, input() as any);
    expect(r.body.session).toMatchObject({ kind: 'platform', state: 'mfa_pending' });
    expect(k.tx.bindTenant).not.toHaveBeenCalled();
    expect(names(w).filter((n) => ['insertSession', 'touchMembershipLogin', 'recordTenant'].includes(n))).toEqual([]);
    expect(w.repo.by('insertPlatformSession')[0]).toMatchObject({ kind: 'platform', platformStaffId: STAFF_ID, userId: SUB, state: 'mfa_pending', clientIp: '203.0.113.9' });
    expect(w.repo.by('platformStaffLogin')).toHaveLength(1);
    expect(w.repo.by('recordTenantless')[0]).toMatchObject({ eventType: 'login_password_ok', platformStaffId: STAFF_ID });
    const e = makeWorld({ rows: { [SUB]: platformRow({ has_verified_factor: false }) } }); expect(((await login(e)) as any).body.session.state).toBe('mfa_enrolment_required');
  });
  it('AU-T10 client IP outside allowed_cidrs -> 403 identity.platform_ip_denied, tenant-less login_blocked_ip, sign-out job, alert, no session', async () => {
    const w = makeWorld({ rows: { [SUB]: platformRow({ platform_allowed_cidrs: ['10.0.0.0/8'] }) } }); const { e, commitOnError, tx } = await fail(w);
    expect(e.code).toBe('identity.platform_ip_denied'); expect(tx.bindTenant).not.toHaveBeenCalled(); expect(commitOnError).toHaveBeenCalledTimes(1);
    expect(w.repo.by('recordTenantless')[0]).toMatchObject({ eventType: 'login_blocked_ip', platformStaffId: STAFF_ID });
    expect(w.repo.by('enqueue').map((x: any) => x.identifier)).toEqual(['identity.gotrue_signout']); expect(w.alerts.map((a) => a.code)).toContain('platform_ip_denied');
    expect(names(w).filter((n) => FORBIDDEN_ON_FAILURE.includes(n))).toEqual([]);
  });
  it('allowlist match (v4 /24 and v6 /64) and an empty allowlist admit the login', async () => {
    for (const [cidrs, ip] of [[['203.0.113.0/24'], '203.0.113.9'], [['2001:db8:1::/64'], '2001:db8:1::77'], [[], '198.51.100.1']] as const) {
      const w = makeWorld({ rows: { [SUB]: platformRow({ platform_allowed_cidrs: [...cidrs] }) } }); expect(((await login(w, input(), { clientIp: ip })) as any).status).toBe(200);
    }
  });
});

describe('AC-A1.5 hourly cap and 03-APP-FLOW s3.3 backoff / step-up', () => {
  it('11th attempt within an hour -> 429 common.rate_limited with Retry-After (seconds until the oldest leaves the window); GoTrue not called; event login_rate_limited', async () => {
    const w = makeWorld();
    for (let i = 0; i < 10; i += 1) { await login(w); w.advance(60_000); }
    const { e, commitOnError } = await fail(w);
    expect(e.code).toBe('common.rate_limited'); expect(e.retryAfterSeconds).toBe(3600 - 600); expect(w.gotrue.calls).toHaveLength(10);
    expect(commitOnError).toHaveBeenCalledTimes(1); expect(w.repo.by('recordTenantless').at(-1)).toMatchObject({ eventType: 'login_rate_limited', emailHmacHex: hmacHex(EMAIL) });
    w.advance(3_600_000); expect(((await login(w)) as any).status).toBe(200); // window slides
  });
  it('rate-limit backend down (consume fails) -> fails closed: error, no GoTrue call, no session', async () => {
    const w = makeWorld(); (w.deps.limits as any).consumeAttempt = async () => { throw new LimsError('common.dependency_unavailable'); };
    const { e } = await fail(w); expect(e.code).toBe('common.dependency_unavailable'); expect(w.gotrue.calls).toHaveLength(0); expect(names(w).filter((n) => FORBIDDEN_ON_FAILURE.includes(n))).toEqual([]);
  });
  const withFails = async (n: number, lastAgoSec: number) => {
    const w = makeWorld();
    for (let i = 0; i < n; i += 1) await w.deps.limits.recordAccountFailure(hmacHex(EMAIL));
    w.advance(lastAgoSec * 1000); return w;
  };
  it('AC-A1.6 5 failures, backoff elapsed -> 401 auth.step_up_required WITHOUT calling GoTrue (right or wrong password alike); event login_step_up_required', async () => {
    for (const pw of [PASSWORD, 'wrong-password-1']) {
      const w = await withFails(5, 31); const { e, commitOnError } = await fail(w, input({ password: pw }));
      expect(e.code).toBe('auth.step_up_required'); expect(w.gotrue.calls).toHaveLength(0); expect(commitOnError).toHaveBeenCalledTimes(1);
      expect(w.repo.by('recordTenantless')[0]).toMatchObject({ eventType: 'login_step_up_required', emailHmacHex: hmacHex(EMAIL) }); expect(names(w).filter((n) => FORBIDDEN_ON_FAILURE.includes(n))).toEqual([]);
      expect(JSON.stringify([e.message, e.detail])).not.toContain(pw);
    }
  });
  it('4 failures -> the password IS checked (GoTrue called); a wrong one adds the 5th failure', async () => {
    const w = await withFails(4, 5); const { e } = await fail(w, input({ password: 'wrong-password-1' }));
    expect(e.code).toBe('auth.login_failed'); expect(w.gotrue.calls).toHaveLength(1); expect(await w.deps.limits.accountState(hmacHex(EMAIL))).toMatchObject({ failures: 5 });
  });
  it.each([[5, 10, 20], [6, 10, 50], [7, 5, 115], [15, 1, 899], [40, 0, 900]])('backoff: %i failures, last %i s ago -> 429 common.rate_limited, Retry-After %i s (min(30 s * 2^(fails-5), 900 s)); GoTrue not called', async (n, ago, retry) => {
    const w = await withFails(n, ago); const { e, commitOnError } = await fail(w);
    expect(e.code).toBe('common.rate_limited'); expect(e.retryAfterSeconds).toBe(retry); expect(w.gotrue.calls).toHaveLength(0); expect(commitOnError).toHaveBeenCalledTimes(1);
  });
  it('exit paths: window decays below 5 (61 min) -> normal login; success clears the counter; clearAccountFailures (reset / unlock) -> normal login', async () => {
    const a = await withFails(5, 3601); expect(((await login(a)) as any).status).toBe(200);
    const b = await withFails(5, 31); await b.deps.limits.clearAccountFailures(hmacHex(EMAIL)); expect(((await login(b)) as any).status).toBe(200);
  });
  it('step-up is per account: another account is unaffected', async () => {
    const o = user(1); const w = makeWorld({ users: { [EMAIL]: { password: PASSWORD, sub: SUB }, [o.email]: { password: PASSWORD, sub: o.sub } }, rows: { [SUB]: tenantRow(), [o.sub]: tenantRow({ membership_id: MEMB_B }) } });
    for (let i = 0; i < 5; i += 1) await w.deps.limits.recordAccountFailure(hmacHex(EMAIL)); w.advance(40_000);
    expect(((await login(w, input({ email: o.email }))) as any).status).toBe(200);
  });
});

describe('AC-A1.6a / A1.6b / AU-T2a-c / AU-T23 per-client-IP failure throttle (08 Addendum A1, P-61, D-217)', () => {
  const NAT = '203.0.113.50';
  it('AC-A1.6a / AU-T2a: 60 staff behind one public IP all log in successfully within a minute - none rejected, no failure counted, no login_ip_throttled event', async () => {
    const users: Record<string, any> = {}, rows: Record<string, any> = {};
    for (let i = 0; i < 60; i += 1) { const u = user(i); users[u.email] = { password: PASSWORD, sub: u.sub, session: idN(0x7000 + i) }; rows[u.sub] = tenantRow({ membership_id: idN(0xb100 + i) }); }
    const w = makeWorld({ users, rows });
    const rs: any[] = await Promise.all(Array.from({ length: 60 }, (_, i) => login(w, input({ email: user(i).email }), { clientIp: NAT })));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(w.limits.calls.some((c) => c.m === 'recordIpFailure')).toBe(false);
    expect(w.repo.writes.filter((x) => x.arg?.eventType === 'login_ip_throttled')).toHaveLength(0); expect(w.repo.by('enqueue').filter((x: any) => x.identifier === 'identity.notify_ip_throttle')).toHaveLength(0);
  });
  const stuff = async (w: WorldT, n: number, ip: string) => {
    for (let i = 0; i < n; i += 1) { const r = await fail(w, input({ email: `victim${i}@example.test`, password: 'guess-1' }), { clientIp: ip }); expect(r.e.code).toBe('auth.login_failed'); w.advance(5_000); }
  };
  it('AU-T2b: the 10th failure from one IP (mixed accounts) answers 401, engages the throttle: one login_ip_throttled event (tenant-less, client_ip), identity.notify_ip_throttle job {client_ip, window_start}, on-call alert', async () => {
    const w = makeWorld(); await stuff(w, 9, NAT);
    expect(w.repo.writes.filter((x) => x.arg?.eventType === 'login_ip_throttled')).toHaveLength(0);
    const { e, commitOnError } = await fail(w, input({ email: 'victim9@example.test', password: 'guess-1' }), { clientIp: NAT });
    expect(e.code).toBe('auth.login_failed'); expect(commitOnError).toHaveBeenCalledTimes(1);
    const ev = w.repo.writes.filter((x) => x.arg?.eventType === 'login_ip_throttled'); expect(ev).toHaveLength(1); expect(ev[0]!.m).toBe('recordTenantless'); expect(ev[0]!.arg).toMatchObject({ clientIp: NAT, requestId: idN(0xe1) }); expect(ev[0]!.arg).not.toHaveProperty('tenantId');
    const jobs = w.repo.by('enqueue').filter((x: any) => x.identifier === 'identity.notify_ip_throttle'); expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toEqual({ client_ip: NAT, window_start: expect.any(String) }); expect(Number.isNaN(Date.parse(jobs[0].payload.window_start))).toBe(false);
    expect(jobs[0].jobKey).toMatch(new RegExp(`^ipthrottle:${sha256(NAT).toString('hex')}:\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d$`)); // sha256(client_ip) + throttle start, ISO minute (02-TRD s10)
    expect(w.alerts.map((a) => a.code)).toContain('login_ip_throttled'); expect(JSON.stringify(jobs)).not.toMatch(/example\.test/); // no e-mail in the job payload (HMACs are read by the task from the DEFINER)
  });
  it('after the throttle engages: attempts beyond 5/min from that IP -> 429 common.rate_limited + Retry-After, GoTrue not called, event login_rate_limited; the 5 within the minute still reach GoTrue; throttle event written ONCE', async () => {
    const w = makeWorld(); await stuff(w, 10, NAT); w.gotrue.calls.length = 0;
    const codes: string[] = [];
    for (let i = 0; i < 7; i += 1) { const r = await fail(w, input({ password: 'guess-1' }), { clientIp: NAT }); codes.push(r.e.code); w.advance(500); }
    // sleeps for the 400 ms floor already advance the virtual clock: the 7 attempts land inside one minute
    expect(codes.slice(0, 5)).not.toContain('common.rate_limited'); expect(codes.slice(5)).toEqual(['common.rate_limited', 'common.rate_limited']);
    expect(w.gotrue.calls).toHaveLength(5);
    expect(w.repo.writes.filter((x) => x.arg?.eventType === 'login_ip_throttled')).toHaveLength(1);
    expect(w.repo.writes.filter((x) => x.arg?.eventType === 'login_rate_limited').length).toBeGreaterThanOrEqual(2);
  });
  it('429 carries Retry-After >= 1 s and writes survive it (commitOnError once, event written, no other write)', async () => {
    const w = makeWorld(); await stuff(w, 10, NAT); for (let i = 0; i < 5; i += 1) await login(w, input(), { clientIp: NAT }); // 5 per minute are still processed (successes included)
    const { e, commitOnError } = await fail(w, input(), { clientIp: NAT });
    expect(e.code).toBe('common.rate_limited'); expect(e.retryAfterSeconds).toBeGreaterThanOrEqual(1); expect(e.retryAfterSeconds).toBeLessThanOrEqual(60); expect(commitOnError).toHaveBeenCalledTimes(1);
  });
  it('throttle lifts after 30 min (injected clock); a different IP is never affected (AU-T2b, AU-T2c: key = ctx.clientIp)', async () => {
    const users: Record<string, any> = {}, rows: Record<string, any> = {};
    for (let i = 0; i < 30; i += 1) { const u = user(i); users[u.email] = { password: PASSWORD, sub: u.sub, session: idN(0x7000 + i) }; rows[u.sub] = tenantRow({ membership_id: idN(0xb100 + i) }); }
    const w = makeWorld({ users, rows }); await stuff(w, 10, NAT); // distinct accounts: no per-account cap interferes
    expect(((await login(w, input({ email: user(0).email }), { clientIp: '198.51.100.9' })) as any).status).toBe(200); // another public IP behind the same BFF
    expect(w.limits.calls.filter((c) => c.m === 'checkIp').at(-1)!.key).toBe('198.51.100.9');
    for (let i = 1; i <= 5; i += 1) expect(((await login(w, input({ email: user(i).email }), { clientIp: NAT })) as any).status).toBe(200);
    expect((await fail(w, input({ email: user(6).email }), { clientIp: NAT })).e.code).toBe('common.rate_limited');
    w.advance(31 * 60_000);
    for (let i = 10; i < 18; i += 1) expect(((await login(w, input({ email: user(i).email }), { clientIp: NAT })) as any).status).toBe(200); // 8 inside a minute: no limit left
  });
  it('AU-T2c: counters are keyed by ctx.clientIp only - a client-supplied ip in the input / ctx.headers is never used', async () => {
    const w = makeWorld(); await fail(w, input({ password: 'guess-1', client_ip: '10.9.9.9', ip: '10.9.9.9', x_forwarded_for: '10.9.9.9' }), { clientIp: NAT, headers: { 'x-forwarded-for': '10.9.9.9' } });
    expect(w.limits.calls.filter((c) => c.m === 'recordIpFailure').map((c) => c.key)).toEqual([NAT]);
  });
  it('AU-T23 no oracle: an unknown e-mail and a known one drive the IP counter identically (the 10th failure engages the throttle either way)', async () => {
    const w = makeWorld(); for (let i = 0; i < 10; i += 1) await fail(w, i % 2 ? input({ password: 'guess-1' }) : input({ email: `x${i}@example.test`, password: 'guess-1' }), { clientIp: NAT });
    expect(w.repo.writes.filter((x) => x.arg?.eventType === 'login_ip_throttled')).toHaveLength(1);
  });
});

describe('P-42 / AU-T22 / D-202: failure writes survive the 4xx, nothing else does', () => {
  const scenarios: Array<[string, (w: WorldT) => Promise<void> | void, Record<string, unknown>, string]> = [
    ['wrong password', () => undefined, { password: 'wrong-password-1' }, 'auth.login_failed'],
    ['unknown e-mail', () => undefined, { email: 'nobody@example.test' }, 'auth.login_failed'],
    ['step-up', async (w) => { for (let i = 0; i < 5; i += 1) await w.deps.limits.recordAccountFailure(hmacHex(EMAIL)); w.advance(40_000); }, {}, 'auth.step_up_required'],
    ['backoff 429', async (w) => { for (let i = 0; i < 5; i += 1) await w.deps.limits.recordAccountFailure(hmacHex(EMAIL)); w.advance(1_000); }, {}, 'common.rate_limited'],
    ['hourly cap 429', async (w) => { for (let i = 0; i < 10; i += 1) await w.deps.limits.consumeAttempt(hmacHex(EMAIL)); }, {}, 'common.rate_limited'],
    ['multi-membership', () => undefined, {}, 'auth.login_failed'],
  ];
  it.each(scenarios)('%s: exactly one commitOnError, only auth-event / job writes, and the event is written before the throw', async (name, prep, over, code) => {
    const w = makeWorld(name === 'multi-membership' ? { rows: { [SUB]: tenantRow({ membership_count: 2 }) } } : {}); await prep(w);
    const { e, commitOnError } = await fail(w, input(over));
    expect(e.code).toBe(code); expect(commitOnError).toHaveBeenCalledTimes(1);
    expect(names(w).filter((n) => FORBIDDEN_ON_FAILURE.includes(n))).toEqual([]);
    expect(names(w).every((n) => (DB_WRITES as readonly string[]).includes(n))).toBe(true);
    expect(w.repo.by('recordTenantless').length + w.repo.by('recordTenant').length).toBeGreaterThanOrEqual(name === 'multi-membership' ? 0 : 1);
  });
  it('locked / inactive / suspended / ip-denied also commit exactly once and write no session (see the 403 blocks); idempotency table is never touched by login (D-202: x-idempotency none, no key row for a 4xx)', async () => {
    const w = makeWorld({ rows: { [SUB]: tenantRow({ membership_locked: true }) } }); const { tx } = await fail(w);
    expect(tx.query.mock.calls.every((c) => !String(c[0]).includes('idempotency_keys'))).toBe(true);
    const ok = makeWorld(); const k = ok.makeCtx(); await createAuthService(ok.deps as any).loginStaff(k.ctx, input() as any); expect(k.tx.query.mock.calls.every((c) => !String(c[0]).includes('idempotency_keys'))).toBe(true);
  });
  it('commitOnError is called BEFORE the error leaves the service on every failure, and never on success', async () => {
    const w = makeWorld(); const { e, commitOnError } = await fail(w, input({ password: 'wrong-password-1' })); expect(e).toBeTruthy(); expect(commitOnError).toHaveBeenCalledTimes(1);
    const ok = makeWorld(); const k = ok.makeCtx(); await createAuthService(ok.deps as any).loginStaff(k.ctx, input() as any); expect(k.commitOnError).not.toHaveBeenCalled();
  });
});

describe('input hardening', () => {
  it.each([[{ email: 5 }], [{ password: ['x'] }], [{ email: '' }], [{ password: '' }], [{ password: 'p'.repeat(129) }], [{ email: `${'a'.repeat(250)}@example.test` }], [{ email: null }]])('invalid %j -> common.validation_failed, GoTrue not called, nothing written', async (bad) => {
    const w = makeWorld(); const { e } = await fail(w, input(bad as Record<string, unknown>));
    expect(e.code).toBe('common.validation_failed'); expect(w.gotrue.calls).toHaveLength(0); expect(w.repo.writes).toEqual([]);
  });
  it('a 128-char password is accepted by validation (boundary) and reaches GoTrue', async () => {
    const w = makeWorld(); await fail(w, input({ password: 'p'.repeat(128) })); expect(w.gotrue.calls).toHaveLength(1); expect(w.gotrue.calls[0]!.password).toHaveLength(128);
  });
});
