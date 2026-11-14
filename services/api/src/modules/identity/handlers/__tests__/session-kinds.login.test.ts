// T31 loginPartner + openMobileSession (02-TRD s4 items 10/11, s5.1; 05-SCHEMA s4.1; 07-SECURITY AU-T13, AU-T14, AU-T17, AU-T22, AU-T2c/d; 08 A19 P-42, A25 D-212/P-61).
// Seams: kinds.helpers.ts header. Expected now: all fail (handlers/loginPartner.ts and handlers/openMobileSession.ts do not exist; the manifest holds the stub).
import { afterEach, describe, expect, it } from 'vitest';
import { createAuthService } from '../../service/auth.service.js';
import { createLoginPartner } from '../loginPartner.js';
import { createOpenMobileSession } from '../openMobileSession.js';
import { ACCESS, EMAIL, PASSWORD, SUB } from '../../service/__tests__/auth.helpers.js';
import { APP_INSTANCE, CLIENT_IP, HOUR, MEMB_A, MIN, TENANT_A, loginRunner, makeWorld, partnerRow, rejection, sha, staffRow } from './kinds.helpers.js';

const GOOD = { email: EMAIL, password: PASSWORD };
const MOBILE_BODY = { ...GOOD, app_instance_id: APP_INSTANCE, app_platform: 'android' };
const DB_WRITES_OK = ['insertSession', 'touchMembershipLogin', 'recordTenant'];

function partnerWorld(row = partnerRow()) { return makeWorld({ rows: { [SUB]: row } }); }
function mobileWorld(o: { row?: Record<string, unknown>; permitted?: boolean } = {}) {
  const w = makeWorld({ rows: { [SUB]: o.row ?? staffRow() } });
  const checks: any[] = [];
  const deps = { ...w.deps, now: () => new Date(w.clock.ms), repo: { ...w.deps.repo, async membershipHasPermission(_tx: unknown, a: unknown) { checks.push(a); return o.permitted ?? true; } } };
  return { w, deps, checks };
}
const runPartner = (w: ReturnType<typeof makeWorld>, a: { body?: unknown; key?: string | undefined } = {}) => {
  const r = loginRunner(w, 'key' in a ? a.key : 'partner');
  return { ...r, call: () => createLoginPartner(w.deps as any)(r.req('body' in a ? a.body : GOOD) as any, r.hctx) };
};
const runMobile = (w: ReturnType<typeof makeWorld>, deps: any, a: { body?: unknown; key?: string } = {}) => {
  const r = loginRunner(w, a.key);
  return { ...r, call: () => createOpenMobileSession(deps)(r.req('body' in a ? a.body : MOBILE_BODY) as any, r.hctx) };
};
afterEach(() => { delete process.env['LIMS_IDENTITY_MOBILE_ABSOLUTE_HOURS']; });

describe('loginPartner: session kind partner (AU-T14, 03-APP-FLOW s3.5a)', () => {
  it('partner credential + partner BFF key -> 200 LoginResult, kind partner, session row bound to the DEFINER membership tenant, auth event, one identityAuthTx', async () => {
    const w = partnerWorld(); const r = runPartner(w);
    const out: any = await r.call();
    expect(out.status).toBe(200);
    expect(out.body.session_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(out.body.session).toMatchObject({ kind: 'partner', state: 'active' });
    expect(r.txCalls).toHaveLength(1); expect(r.txCalls[0]).toMatchObject({ operation: { module: 'identity', operationId: 'loginPartner', context: 'identity_auth' }, clientIp: CLIENT_IP });
    const ins = w.repo.by('insertSession'); expect(ins).toHaveLength(1);
    expect(ins[0]).toMatchObject({ kind: 'partner', tenantId: TENANT_A, membershipId: MEMB_A, platformStaffId: null, state: 'active' });
    expect(Buffer.from(ins[0].tokenSha256).equals(sha(out.body.session_token))).toBe(true);   // only the hash is stored
    expect(ins[0].idleTimeoutMinutes).toBeGreaterThanOrEqual(15); expect(ins[0].idleTimeoutMinutes).toBeLessThanOrEqual(30);   // sessions__idle__ck partner
    expect(ins[0]).not.toHaveProperty('appInstanceId');
    expect(w.repo.order.filter((x) => x === 'bindTenant')).toHaveLength(1);
    expect(w.repo.order.indexOf('loginContext')).toBeLessThan(w.repo.order.indexOf('bindTenant')); expect(w.repo.order.indexOf('bindTenant')).toBeLessThan(w.repo.order.indexOf('insertSession'));
    expect(w.repo.by('recordTenant').map((e: any) => e.eventType)).toContain('login_succeeded');
    expect(r.hctx.commitOnError).not.toHaveBeenCalled();
  });
  it('AU-T14: a staff credential (actor_type user) on loginPartner -> 401 auth.login_failed, NO session row, only the failure event survives (P-42)', async () => {
    const w = partnerWorld(staffRow()); const r = runPartner(w);
    const e = await rejection(r.call()); expect(e.code).toBe('auth.login_failed');
    expect(w.repo.by('insertSession')).toHaveLength(0); expect(w.repo.by('insertPlatformSession')).toHaveLength(0);
    expect(r.hctx.commitOnError).toHaveBeenCalledTimes(1);
    expect(r.committed().map((x) => x.m).filter((m) => m !== 'recordTenantless' && m !== 'recordTenant')).toEqual([]);
    expect(JSON.stringify(e)).not.toContain(PASSWORD);
  });
  it('AU-T14: the staff_web BFF key on loginPartner -> 401 auth.login_failed without checking the password, no session row', async () => {
    const w = partnerWorld(); const r = runPartner(w, { key: 'staff_web' });
    expect((await rejection(r.call())).code).toBe('auth.login_failed');
    expect(w.gotrue.calls).toHaveLength(0); expect(w.repo.by('insertSession')).toHaveLength(0); expect(r.hctx.commitOnError).toHaveBeenCalledTimes(1);
  });
  it('AU-T13: no X-Lims-Bff-Key at all -> 401 auth.login_failed, password not checked, no session row', async () => {
    const w = partnerWorld(); const r = runPartner(w, { key: undefined });
    expect((await rejection(r.call())).code).toBe('auth.login_failed'); expect(w.gotrue.calls).toHaveLength(0); expect(w.repo.by('insertSession')).toHaveLength(0);
  });
  it('AU-T14 (other direction, already true for loginStaff): the partner BFF key on loginStaff -> 401 auth.login_failed, no session row', async () => {
    const w = makeWorld({ rows: { [SUB]: staffRow() } }); const { ctx, commitOnError } = w.makeCtx({ bffKey: 'partner' });
    const e = await rejection(createAuthService(w.deps as any).loginStaff(ctx, GOOD)); expect(e.code).toBe('auth.login_failed');
    expect(w.repo.by('insertSession')).toHaveLength(0); expect(commitOnError).toHaveBeenCalledTimes(1);
  });
  it('wrong password -> 401 auth.login_failed with the failure writes kept: event, f:<ip> counter, ctx.commitOnError() once, no session (AU-T22)', async () => {
    const w = partnerWorld(); const r = runPartner(w, { body: { email: EMAIL, password: 'wrong-password-1' } });
    expect((await rejection(r.call())).code).toBe('auth.login_failed');
    expect(r.hctx.commitOnError).toHaveBeenCalledTimes(1);
    expect(w.limits.calls.filter((c) => c.m === 'recordIpFailure').map((c) => c.key)).toEqual([CLIENT_IP]);   // ctx.clientIp (P-61)
    expect(w.repo.by('recordTenantless').map((e: any) => e.eventType)).toEqual(['login_failed']);
    expect(w.repo.by('insertSession')).toHaveLength(0);
    expect(r.committed().map((x) => x.m)).toEqual(['recordTenantless']);
  });
  it('AU-T2d: the 10th failed login from one client IP engages the throttle: login_ip_throttled event + identity.notify_ip_throttle job, kept through the 401', async () => {
    const w = partnerWorld(); let last: ReturnType<typeof runPartner> | undefined;
    for (let i = 0; i < 10; i++) { w.advance(1_000); last = runPartner(w, { body: { email: `user${i}@example.test`, password: 'wrong-password-1' } }); await rejection(last.call()); }
    expect(w.repo.by('recordTenantless').filter((e: any) => e.eventType === 'login_ip_throttled')).toHaveLength(1);
    expect(w.repo.by('enqueue').filter((j: any) => j.identifier === 'identity.notify_ip_throttle')).toHaveLength(1);
    expect(last!.committed().map((x) => x.m).sort()).toEqual(['enqueue', 'recordTenantless', 'recordTenantless']);
  });
  it('input hygiene: unknown body fields (tenant_id, kind, role) -> 400 common.validation_failed before any DB work', async () => {
    for (const body of [{ ...GOOD, tenant_id: TENANT_A }, { ...GOOD, kind: 'partner' }, { email: EMAIL }, null, []]) {
      const w = partnerWorld(); const r = runPartner(w, { body });
      expect((await rejection(r.call())).code).toBe('common.validation_failed'); expect(r.txCalls).toHaveLength(0); expect(w.gotrue.calls).toHaveLength(0);
    }
  });
  it('a suspended tenant / locked / deactivated partner membership is refused like loginStaff, no session row', async () => {
    for (const [o, code] of [[{ tenant_status: 'suspended' }, 'identity.tenant_suspended'], [{ membership_locked: true }, 'auth.account_locked'], [{ membership_status: 'deactivated' }, 'identity.membership_inactive']] as const) {
      const w = partnerWorld(partnerRow(o)); const r = runPartner(w);
      expect((await rejection(r.call())).code, code).toBe(code); expect(w.repo.by('insertSession')).toHaveLength(0);
    }
  });
});

describe('openMobileSession: session kind staff_mobile (AU-T17, AU-T22, 05-SCHEMA s4.1)', () => {
  it('permitted membership -> 200 MobileSession, kind staff_mobile row with app_instance_id / app_platform, no idle timeout (idle = absolute = 12 h = 720 min), GoTrue tokens stored', async () => {
    const m = mobileWorld(); const r = runMobile(m.w, m.deps);
    const out: any = await r.call();
    expect(out.status).toBe(200);
    expect(Object.keys(out.body).sort()).toEqual(['access_expires_at', 'access_token', 'session', 'session_expires_at', 'session_token']);
    expect(out.body.session_token).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(out.body.access_token).toBe(ACCESS);
    expect(out.body.session).toMatchObject({ kind: 'staff_mobile', state: 'active' });
    const ins: any = m.w.repo.by('insertSession')[0];
    expect(ins).toMatchObject({ kind: 'staff_mobile', tenantId: TENANT_A, membershipId: MEMB_A, appInstanceId: APP_INSTANCE, appPlatform: 'android', idleTimeoutMinutes: 720 });
    expect(ins.absoluteExpiresAt.getTime() - m.w.clock.ms).toBe(12 * HOUR); expect(ins.idleExpiresAt.getTime()).toBe(ins.absoluteExpiresAt.getTime());
    expect(Buffer.from(ins.tokenSha256).equals(sha(out.body.session_token))).toBe(true);
    expect(out.body.session_expires_at).toBe(ins.absoluteExpiresAt.toISOString());
    expect(r.txCalls[0]).toMatchObject({ operation: { module: 'identity', operationId: 'openMobileSession', context: 'identity_auth' } });
    expect(m.checks).toEqual([{ tenantId: TENANT_A, membershipId: MEMB_A, permission: 'homecollection.sync.upload' }]);
    expect(m.w.repo.order.indexOf('bindTenant')).toBeLessThan(m.w.repo.order.indexOf('insertSession'));
  });
  it('LIMS_IDENTITY_MOBILE_ABSOLUTE_HOURS sets both lifetimes (idle CHECK 60..720 min): 8 h -> 480 min', async () => {
    process.env['LIMS_IDENTITY_MOBILE_ABSOLUTE_HOURS'] = '8';
    const m = mobileWorld(); await runMobile(m.w, m.deps).call();
    const ins: any = m.w.repo.by('insertSession')[0]; expect(ins.idleTimeoutMinutes).toBe(480); expect(ins.absoluteExpiresAt.getTime() - m.w.clock.ms).toBe(8 * HOUR);
  });
  it('AU-T17: membership WITHOUT homecollection.sync.upload -> 403 auth.forbidden, no session row, no token in the response; any write is kept via commitOnError', async () => {
    const m = mobileWorld({ permitted: false }); const r = runMobile(m.w, m.deps);
    const e = await rejection(r.call()); expect(e.code).toBe('auth.forbidden');
    expect(m.w.repo.by('insertSession')).toHaveLength(0); expect(m.w.repo.by('touchMembershipLogin')).toHaveLength(0);
    if (m.w.repo.writes.length > 0) expect(r.hctx.commitOnError).toHaveBeenCalledTimes(1);
    expect(r.committed().map((x) => x.m).filter((x) => !['recordTenant', 'recordTenantless', 'enqueue'].includes(x))).toEqual([]);
  });
  it('the permission is read AFTER the password is verified and the tenant is bound (no oracle for unknown accounts)', async () => {
    const m = mobileWorld({ permitted: false });
    const r = runMobile(m.w, m.deps, { body: { ...MOBILE_BODY, password: 'wrong-password-1' } });
    expect((await rejection(r.call())).code).toBe('auth.login_failed'); expect(m.checks).toHaveLength(0);
  });
  it('wrong password -> 401 auth.login_failed, failure event + f:<ip> counter kept (commitOnError once), no session (AU-T22); IP key is ctx.clientIp (AU-T2c)', async () => {
    const m = mobileWorld(); const r = runMobile(m.w, m.deps, { body: { ...MOBILE_BODY, password: 'wrong-password-1' } });
    expect((await rejection(r.call())).code).toBe('auth.login_failed');
    expect(r.hctx.commitOnError).toHaveBeenCalledTimes(1);
    expect(m.w.limits.calls.filter((c) => c.m === 'recordIpFailure').map((c) => c.key)).toEqual([CLIENT_IP]);
    expect(m.w.repo.by('insertSession')).toHaveLength(0);
  });
  it('no BFF: a request carrying the partner or staff_web key is not special-cased and a request without any key is served (public route)', async () => {
    for (const key of [undefined, 'partner', 'staff_web']) { const m = mobileWorld(); const out: any = await runMobile(m.w, m.deps, key ? { key } : {}).call(); expect(out.status, String(key)).toBe(200); }
  });
  it('a platform-staff or partner-only user cannot open a mobile session -> 401 auth.login_failed, no session', async () => {
    for (const row of [partnerRow(), platformStaffRow()]) {
      const m = mobileWorld({ row }); expect((await rejection(runMobile(m.w, m.deps).call())).code).toBe('auth.login_failed'); expect(m.w.repo.by('insertSession')).toHaveLength(0);
    }
  });
  it('input hygiene: app_platform outside android|ios, non-uuid app_instance_id, missing fields, unknown fields -> 400 common.validation_failed before any DB work', async () => {
    for (const body of [{ ...MOBILE_BODY, app_platform: 'windows' }, { ...MOBILE_BODY, app_instance_id: 'not-a-uuid' }, GOOD, { ...MOBILE_BODY, tenant_id: TENANT_A }, { ...MOBILE_BODY, kind: 'tenant_staff' }]) {
      const m = mobileWorld(); const r = runMobile(m.w, m.deps, { body });
      expect((await rejection(r.call())).code).toBe('common.validation_failed'); expect(r.txCalls).toHaveLength(0); expect(m.w.gotrue.calls).toHaveLength(0);
    }
  });
  it('a suspended tenant / locked membership is refused like loginStaff, no session row', async () => {
    for (const [o, code] of [[{ tenant_status: 'suspended' }, 'identity.tenant_suspended'], [{ membership_locked: true }, 'auth.account_locked']] as const) {
      const m = mobileWorld({ row: staffRow(o) }); expect((await rejection(runMobile(m.w, m.deps).call())).code, code).toBe(code); expect(m.w.repo.by('insertSession')).toHaveLength(0);
    }
  });
  it('the 10th failed mobile login from one IP engages the throttle exactly like loginStaff (AU-T2d)', async () => {
    const m = mobileWorld();
    for (let i = 0; i < 10; i++) { m.w.advance(1_000); await rejection(runMobile(m.w, m.deps, { body: { ...MOBILE_BODY, email: `u${i}@example.test`, password: 'wrong-password-1' } }).call()); }
    expect(m.w.repo.by('recordTenantless').filter((e: any) => e.eventType === 'login_ip_throttled')).toHaveLength(1);
  });
  it('success writes only the allowed set (session, last_login_at, auth event)', async () => {
    const m = mobileWorld(); const r = runMobile(m.w, m.deps); await r.call();
    expect(r.committed().map((x) => x.m).filter((x) => !DB_WRITES_OK.includes(x))).toEqual([]); expect(MIN).toBeGreaterThan(0);
  });
});

function platformStaffRow() {
  return { ...staffRow(), membership_count: 0, tenant_id: null, membership_id: null, membership_status: null, membership_locked: null, tenant_status: null,
    platform_staff_id: '0190a000-0000-7000-8000-0000000000d2', platform_active: true, platform_allowed_cidrs: [] };
}
