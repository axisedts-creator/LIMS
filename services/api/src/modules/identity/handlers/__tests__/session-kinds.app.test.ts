// T31 staff_mobile + patient app sessions: refresh / rotation / reuse revoke, resolve, logout, kind x endpoint family (02-TRD s4 item 10, s5.1; 05-SCHEMA s4.1;
// 07-SECURITY AU-T13, AU-T15, AU-T16, AU-T22; 08 A3.1 / CR-C2-018, A19 P-42, A25 D-212; LD-81 patient access JWT). Seams: kinds.helpers.ts header.
// Expected now: all new-handler cases fail (handlers/{refreshMobileSession,logoutMobileSession,resolvePatientSession,logoutPatientSession}.ts do not exist).
import { describe, expect, it } from 'vitest';
import { createResolveSession } from '../resolveSession.js';
import { createLogoutSession } from '../logoutSession.js';
import { createRefreshMobileSession } from '../refreshMobileSession.js';
import { createLogoutMobileSession } from '../logoutMobileSession.js';
import { createResolvePatientSession } from '../resolvePatientSession.js';
import { createLogoutPatientSession } from '../logoutPatientSession.js';
import { DAY, HOUR, MIN, OLD_ACCESS, OLD_REFRESH, TENANT_A, makeAppWorld, otherWrites, rejection, sha, tokenN, type AppWorld } from './kinds.helpers.js';

const refresh = (w: AppWorld, token: string | undefined, c: Record<string, unknown> = {}) => {
  const { hctx, commitOnError } = w.makeHctx(c);
  return { commitOnError, hctx, run: () => createRefreshMobileSession(w.deps as any)(w.req({ as: 'body', ...(token ? { token } : {}) }) as any, hctx) as Promise<any> };
};
const mobileLogout = (w: AppWorld, token: string) => { const { hctx, commitOnError } = w.makeHctx(); return { commitOnError, run: () => createLogoutMobileSession(w.deps as any)(w.req({ as: 'body', token }) as any, hctx) as Promise<any> }; };
const patientResolve = (w: AppWorld, token: string | undefined, body: unknown = { touch: false }, c: Record<string, unknown> = {}) => {
  const { hctx, commitOnError } = w.makeHctx(c);
  return { commitOnError, hctx, run: () => createResolvePatientSession(w.deps as any)(w.req({ ...(token ? { token, as: 'patient-header' as const } : {}), body }) as any, hctx) as Promise<any> };
};
const patientLogout = (w: AppWorld, token: string | undefined) => { const { hctx, commitOnError } = w.makeHctx(); return { commitOnError, run: () => createLogoutPatientSession(w.deps as any)(w.req({ ...(token ? { token, as: 'patient-header' as const } : {}), body: undefined }) as any, hctx) as Promise<any> }; };
const iso = (d: Date | number) => new Date(d).toISOString();

describe('refreshMobileSession: rotation (AU-T15, CR-C2-018)', () => {
  it('200: a NEW opaque token; token_sha256 = sha256(new), previous_token_sha256 = sha256(old) after commit; ONE identityAuthTx; bindTenant once from the row; response shape per MobileSession', async () => {
    const w = await makeAppWorld(); const { token, row } = w.addSession();
    const r = refresh(w, token); const out = await r.run();
    expect(out.status).toBe(200);
    expect(Object.keys(out.body).sort()).toEqual(['access_expires_at', 'access_token', 'session', 'session_expires_at', 'session_token']);
    expect(out.body.session_token).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(out.body.session_token).not.toBe(token);
    expect(row.tokenHex).toBe(sha(out.body.session_token).toString('hex')); expect(row.prevHex).toBe(sha(token).toString('hex'));
    expect(out.body.session).toMatchObject({ session_id: row.sessionId, kind: 'staff_mobile', state: 'active' });
    expect(out.body.session_expires_at).toBe(iso(row.absoluteExpiresAt));
    expect(new Date(out.body.access_expires_at).getTime()).toBeGreaterThan(w.clock.ms + 120_000);   // never hands out a JWT about to expire
    expect(w.txCalls).toHaveLength(1); expect(w.txCalls[0]).toMatchObject({ operation: { module: 'identity', operationId: 'refreshMobileSession', context: 'identity_auth' } });
    expect(w.order.filter((x) => x.startsWith('bindTenant'))).toEqual([`bindTenant:${TENANT_A}`]);
    expect(r.commitOnError).not.toHaveBeenCalled();
  });
  it('the new token works for the next refresh; the previous token of the FIRST rotation is then a reuse (only the immediately previous token is kept)', async () => {
    const w = await makeAppWorld(); const { token: t0, row } = w.addSession();
    const t1 = (await refresh(w, t0).run()).body.session_token; const t2 = (await refresh(w, t1).run()).body.session_token;
    expect(row.prevHex).toBe(sha(t1).toString('hex')); expect(row.tokenHex).toBe(sha(t2).toString('hex'));
    expect(row.state).toBe('active');
  });
  it('AU-T15: the token from TWO rotations ago matches neither column -> 401 auth.session_expired, session state UNCHANGED, no event, no write', async () => {
    const w = await makeAppWorld(); const { token: t0, row } = w.addSession();
    const t1 = (await refresh(w, t0).run()).body.session_token; const t2 = (await refresh(w, t1).run()).body.session_token;
    const before = w.committed().length; const snap = { ...row };
    const r = refresh(w, t0); const e = await rejection(r.run());
    expect(e.code).toBe('auth.session_expired');
    expect(row.state).toBe('active'); expect(row.tokenHex).toBe(snap.tokenHex); expect(row.prevHex).toBe(snap.prevHex);
    expect(w.committed().length).toBe(before); expect(w.eventsOf('session_token_reused')).toHaveLength(0);
    expect((await refresh(w, t2).run()).status).toBe(200);   // the live token still works
  });
  it('AU-T15 + AU-T22 / P-42: the previous token again -> 401, session revoked (token_reuse), session_token_reused event, commitOnError, all KEPT; the NEW token then stops working too', async () => {
    const w = await makeAppWorld(); const { token: t0, row } = w.addSession();
    const t1 = (await refresh(w, t0).run()).body.session_token;
    const r = refresh(w, t0); const e = await rejection(r.run());
    expect(e.code).toBe('auth.session_expired');
    expect(r.commitOnError).toHaveBeenCalledTimes(1);
    expect(row.state).toBe('revoked'); expect(row.revokeReason).toBe('token_reuse');
    const ev = w.eventsOf('session_token_reused'); expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ sessionId: row.sessionId, userId: row.userId, tenantId: TENANT_A, membershipId: row.membershipId });
    expect(otherWrites(w, ['rotateToken', 'updateSession', 'recordTenant', 'enqueue'])).toEqual([]);   // rotateToken = the earlier, successful refresh
    const last = w.committed().filter((x) => x.seq > w.committed('rotateToken')[0]!.seq);   // this request's own writes: only revoke + event + sign-out job
    expect(last.map((x) => x.m).filter((m) => m !== 'updateSession' && m !== 'recordTenant' && m !== 'enqueue')).toEqual([]);
    expect(w.committed('enqueue').map((x) => x.arg.identifier)).toEqual(['identity.gotrue_signout']);   // staff_mobile HAS a GoTrue session
    expect((await rejection(refresh(w, t1).run())).code).toBe('auth.session_expired');
    expect((await rejection(refresh(w, t0).run())).code).toBe('auth.session_expired');
  });
  it('AU-T15 lost race: the rotate guard matches 0 rows (a parallel refresh already rotated) -> 401 auth.session_expired, NOT 500; revoke (token_reuse) + session_token_reused + sign-out job kept via commitOnError; no GoTrue refresh spent', async () => {
    const w = await makeAppWorld(); const { token, row } = w.addSession({ accessExpiresAt: new Date(START_PLUS(w, 60_000)) });   // GoTrue refresh would be due
    w.rot.miss = true;
    const r = refresh(w, token); const e = await rejection(r.run());
    expect(e.code).toBe('auth.session_expired'); expect(r.commitOnError).toHaveBeenCalledTimes(1);
    expect(row.state).toBe('revoked'); expect(row.revokeReason).toBe('token_reuse');
    expect(w.eventsOf('session_token_reused')).toHaveLength(1);
    expect(w.committed('enqueue').map((x) => x.arg.identifier)).toEqual(['identity.gotrue_signout']);
    expect(w.committed('rotateToken')).toHaveLength(0); expect(w.gt.calls).toHaveLength(0);
    expect(otherWrites(w, ['updateSession', 'recordTenant', 'enqueue'])).toEqual([]);
  });
  it('the reuse is also detected when the old token is presented to the PATIENT resolve path (patient row): revoke + event + 401, and NO GoTrue sign-out job (LD-81)', async () => {
    const w = await makeAppWorld(); const { token: cur, row } = w.addSession({ kind: 'patient' }); const old = tokenN(0x7777);
    row.prevHex = sha(old).toString('hex');
    const r = patientResolve(w, old); const e = await rejection(r.run());
    expect(e.code).toBe('auth.session_expired'); expect(r.commitOnError).toHaveBeenCalledTimes(1);
    expect(row.state).toBe('revoked'); expect(row.revokeReason).toBe('token_reuse'); expect(w.eventsOf('session_token_reused')).toHaveLength(1);
    expect(w.committed('enqueue')).toHaveLength(0); expect(w.mint).not.toHaveBeenCalled();
    expect((await rejection(patientResolve(w, cur).run())).code).toBe('auth.session_expired');   // the current token dies with the session
  });
  it('GoTrue access refresh for staff_mobile: access JWT with <= 120 s left is refreshed with the STORED refresh token and the new tokens are persisted', async () => {
    const w = await makeAppWorld(); const { token, row } = w.addSession({ accessExpiresAt: new Date(START_PLUS(w, 60_000)) });
    const out = await refresh(w, token).run();
    expect(w.gt.calls).toEqual([OLD_REFRESH]); expect(out.body.access_token).toBe('ACCESS-NEW-1'); expect(row.accessToken).toBe('ACCESS-NEW-1'); expect(row.refreshToken).toBe('REFRESH-NEW-1');
  });
  it('GoTrue refuses the refresh -> 401, session revoked (refresh_failed) + event + sign-out job, kept through the 401', async () => {
    const w = await makeAppWorld(); const { token, row } = w.addSession({ accessExpiresAt: new Date(START_PLUS(w, 60_000)) }); w.gt.st.refuse = true;
    const r = refresh(w, token); expect((await rejection(r.run())).code).toBe('auth.session_expired');
    expect(r.commitOnError).toHaveBeenCalledTimes(1); expect(row.state).toBe('revoked'); expect(row.revokeReason).toBe('refresh_failed');
    expect(w.eventsOf('refresh_failed')).toHaveLength(1); expect(otherWrites(w, ['rotateToken', 'updateSession', 'recordTenant', 'enqueue'])).toEqual([]);
  });
  it('absolute lifetime passed -> 401 and the expiry (reason absolute) + event are kept; no rotation, no GoTrue call', async () => {
    const w = await makeAppWorld(); const { token, row } = w.addSession(); w.advance(12 * HOUR + MIN);
    const r = refresh(w, token); expect((await rejection(r.run())).code).toBe('auth.session_expired');
    expect(row.state).toBe('expired'); expect(row.expiredReason).toBe('absolute'); expect(r.commitOnError).toHaveBeenCalledTimes(1);
    expect(w.eventsOf('session_expired_absolute')).toHaveLength(1); expect(w.gt.calls).toHaveLength(0); expect(w.committed('rotateToken')).toHaveLength(0);
  });
  it('locked membership -> 403 auth.account_locked, suspended tenant -> 403 identity.tenant_suspended; nothing rotated', async () => {
    for (const [o, code] of [[{ membershipLocked: true }, 'auth.account_locked'], [{ tenantStatus: 'suspended' }, 'identity.tenant_suspended']] as const) {
      const w = await makeAppWorld(); const { token } = w.addSession(o);
      expect((await rejection(refresh(w, token).run())).code, code).toBe(code); expect(w.committed('rotateToken')).toHaveLength(0);
    }
  });
  it('unknown token -> 401 auth.session_expired with no write; revoked / expired session -> 401 with no write (E-9 timing class)', async () => {
    const w = await makeAppWorld(); const a = w.addSession({ state: 'revoked' }); const b = w.addSession({ state: 'expired' });
    for (const t of [tokenN(0xdead), a.token, b.token]) expect((await rejection(refresh(w, t).run())).code).toBe('auth.session_expired');
    expect(w.committed()).toHaveLength(0);
  });
  it('body hygiene: missing / malformed session_token, unknown fields -> 400 common.validation_failed BEFORE any identityAuthTx', async () => {
    const w = await makeAppWorld(); w.addSession();
    for (const body of [{}, { session_token: 'short' }, { session_token: tokenN(1), tenant_id: TENANT_A }, { session_token: 42 }, null]) {
      const { hctx } = w.makeHctx(); const e = await rejection(createRefreshMobileSession(w.deps as any)({ params: {}, query: {}, body, headers: {} } as any, hctx));
      expect(e.code).toBe('common.validation_failed');
    }
    expect(w.txCalls).toHaveLength(0);
  });
  it('the raw session token and the GoTrue tokens never reach a log call or an event', async () => {
    const w = await makeAppWorld(); const { token } = w.addSession(); const r = refresh(w, token); await r.run();
    const s = JSON.stringify([r.hctx.log.info.mock.calls, r.hctx.log.warn.mock.calls, r.hctx.log.error.mock.calls, w.writes.filter((x) => x.m.startsWith('record')).map((x) => x.arg)]);
    for (const secret of [token, OLD_REFRESH, OLD_ACCESS]) expect(s).not.toContain(secret);
  });
});

describe('logoutMobileSession / logoutPatientSession', () => {
  it('mobile: 204, session revoked (logout), logout event, GoTrue sign-out job; a repeat on the same token is a 204 no-op; unknown token -> 401', async () => {
    const w = await makeAppWorld(); const { token, row } = w.addSession();
    expect((await mobileLogout(w, token).run()).status).toBe(204);
    expect(row.state).toBe('revoked'); expect(row.revokeReason).toBe('logout'); expect(w.eventsOf('logout')).toHaveLength(1);
    expect(w.committed('enqueue').map((x) => x.arg.identifier)).toEqual(['identity.gotrue_signout']);
    const n = w.committed().length; expect((await mobileLogout(w, token).run()).status).toBe(204); expect(w.committed().length).toBe(n);
    expect((await rejection(mobileLogout(w, tokenN(0xbeef)).run())).code).toBe('auth.session_expired');
  });
  it('patient: 204, revoked (logout), logout event, NO GoTrue sign-out job (the patient kind has no GoTrue session, LD-81); repeat is a no-op; unknown -> 401', async () => {
    const w = await makeAppWorld(); const { token, row } = w.addSession({ kind: 'patient' });
    expect((await patientLogout(w, token).run()).status).toBe(204);
    expect(row.state).toBe('revoked'); expect(row.revokeReason).toBe('logout'); expect(w.eventsOf('logout')).toHaveLength(1); expect(w.committed('enqueue')).toHaveLength(0);
    const n = w.committed().length; expect((await patientLogout(w, token).run()).status).toBe(204); expect(w.committed().length).toBe(n);
    expect((await rejection(patientLogout(w, tokenN(0xbeef)).run())).code).toBe('auth.session_expired');
  });
});

describe('resolvePatientSession (LD-81, 03-APP-FLOW s3.5a)', () => {
  it('200 ResolvedSession: kind patient, aal1, access JWT minted by LIMS for (sub = row user id, session_id = row id, aal1) with lifetime exactly 1 h; no GoTrue call; bindTenant once from the row; header X-Lims-Patient-Session', async () => {
    const w = await makeAppWorld(); const { token, row } = w.addSession({ kind: 'patient' });
    const r = patientResolve(w, token); const out = await r.run();
    expect(out.status).toBe(200);
    expect(w.mint).toHaveBeenCalledTimes(1);
    const c = w.mint.mock.calls[0]![0];
    expect(Object.keys(c).sort()).toEqual(['aal', 'expiresAt', 'issuedAt', 'sessionId', 'sub']);   // claims sub / session_id / aal / exp / iat and nothing else (no tenant_id / membership_id / actor_type)
    expect(c).toMatchObject({ sub: row.userId, sessionId: row.sessionId, aal: 'aal1' }); expect(c.expiresAt.getTime() - c.issuedAt.getTime()).toBe(HOUR); expect(c.issuedAt.getTime()).toBe(w.clock.ms);
    expect(out.body.access_token).toBe(w.mint.mock.results[0]!.value); expect(out.body.access_expires_at).toBe(iso(c.expiresAt));
    expect(out.body.session).toMatchObject({ session_id: row.sessionId, kind: 'patient', state: 'active', aal: 'aal1', idle_expires_at: iso(row.idleExpiresAt), absolute_expires_at: iso(row.absoluteExpiresAt) });
    expect(w.gt.calls).toHaveLength(0);
    expect(w.txCalls).toHaveLength(1); expect(w.txCalls[0]).toMatchObject({ operation: { module: 'identity', operationId: 'resolvePatientSession', context: 'identity_auth' } });
    expect(w.order.filter((x) => x.startsWith('bindTenant'))).toEqual([`bindTenant:${TENANT_A}`]);
    expect(w.committed()).toHaveLength(0);
  });
  it('the access JWT never outlives the session: absolute expiry in 10 min -> exp = that expiry (<= 1 h cap)', async () => {
    const w = await makeAppWorld(); const { token } = w.addSession({ kind: 'patient', absoluteExpiresAt: new Date(START_PLUS(w, 10 * MIN)) });
    await patientResolve(w, token).run(); const c = w.mint.mock.calls[0]![0]; expect(c.expiresAt.getTime() - c.issuedAt.getTime()).toBe(10 * MIN);
  });
  it('touch: one touch per 60 s, idle_expires_at = now + idle_timeout (14 d); touch=false never extends idle', async () => {
    const w = await makeAppWorld(); const { token } = w.addSession({ kind: 'patient' });
    await patientResolve(w, token, { touch: false }).run(); expect(w.committed('touchSession')).toHaveLength(0);
    w.advance(61_000); await patientResolve(w, token, { touch: true }).run(); expect(w.committed('touchSession')).toHaveLength(1);
    expect(w.committed('touchSession')[0]!.arg.idleExpiresAt).toEqual(new Date(w.clock.ms + 14 * DAY));
    w.advance(10_000); await patientResolve(w, token, { touch: true }).run(); expect(w.committed('touchSession')).toHaveLength(1);
  });
  it('idle / absolute expiry -> 401 with the expiry and event kept (P-42), no JWT minted', async () => {
    const w = await makeAppWorld(); const { token, row } = w.addSession({ kind: 'patient' }); w.advance(14 * DAY + MIN);
    const r = patientResolve(w, token); expect((await rejection(r.run())).code).toBe('auth.session_expired');
    expect(row.state).toBe('expired'); expect(row.expiredReason).toBe('idle'); expect(r.commitOnError).toHaveBeenCalledTimes(1); expect(w.mint).not.toHaveBeenCalled();
  });
  it('lookup keyed on (id, sub): a row whose user does not match the DEFINER answer yields 401 and no JWT', async () => {
    const w = await makeAppWorld(); const { token, row } = w.addSession({ kind: 'patient' }); const real = w.repo.sessionByToken.bind(w.repo);
    (w.repo as any).sessionByToken = async (tx: unknown, h: Buffer) => { const s = await real(tx, h); return s ? { ...s, userId: '0190a000-0000-7000-8000-00000000ffff' } : s; };
    expect((await rejection(patientResolve(w, token).run())).code).toBe('auth.session_expired'); expect(w.mint).not.toHaveBeenCalled(); expect(row.state).toBe('active');
  });
  it('AU-T16: forged tenant_id / membership_id / actor_type in the Authorization JWT, extra headers and cookies are IGNORED; the body rejects unknown fields; resolved ids come from the row', async () => {
    const w = await makeAppWorld(); const { token, row } = w.addSession({ kind: 'patient' });
    const forged = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ tenant_id: '0190a000-0000-7000-8000-0000000000ff', membership_id: '0190a000-0000-7000-8000-0000000000fe', actor_type: 'user', sub: 'attacker' })).toString('base64url')}.x`;
    const { hctx } = w.makeHctx();
    const out = await createResolvePatientSession(w.deps as any)(w.req({ token, as: 'patient-header', body: { touch: false },
      headers: { authorization: `Bearer ${forged}`, 'x-tenant-id': '0190a000-0000-7000-8000-0000000000ff', cookie: `tenant_id=0190a000-0000-7000-8000-0000000000ff` } }) as any, hctx) as any;
    expect(out.status).toBe(200); expect(w.order.filter((x) => x.startsWith('bindTenant'))).toEqual([`bindTenant:${TENANT_A}`]);
    expect(w.mint.mock.calls[0]![0]).toMatchObject({ sub: row.userId, sessionId: row.sessionId });
    for (const body of [{ touch: false, tenant_id: TENANT_A }, { touch: false, membership_id: row.membershipId }, { touch: 'yes' }, {}]) {
      const e = await rejection(patientResolve(w, token, body).run()); expect(e.code).toBe('common.validation_failed');
    }
  });
  it('the token is taken ONLY from X-Lims-Patient-Session: the same token in a cookie or in the body is not accepted; a malformed header (not 43 chars) -> 400 or 401, never 200', async () => {
    const w = await makeAppWorld(); const { token } = w.addSession({ kind: 'patient' });
    const { hctx } = w.makeHctx();
    const e = await rejection(createResolvePatientSession(w.deps as any)(w.req({ token, as: 'cookie', body: { touch: false } }) as any, hctx)); expect(['common.validation_failed', 'auth.session_expired']).toContain(e.code);
    for (const bad of ['short', `${token}x`, '']) { const e2 = await rejection(patientResolve(w, bad || undefined).run()); expect(['common.validation_failed', 'auth.session_expired']).toContain(e2.code); }
    expect(w.mint).not.toHaveBeenCalled();
  });
  it('a locked membership -> 403 auth.account_locked and a suspended tenant -> 403 identity.tenant_suspended; no JWT', async () => {
    for (const [o, code] of [[{ membershipLocked: true }, 'auth.account_locked'], [{ tenantStatus: 'suspended' }, 'identity.tenant_suspended']] as const) {
      const w = await makeAppWorld(); const { token } = w.addSession({ kind: 'patient', ...o });
      expect((await rejection(patientResolve(w, token).run())).code, code).toBe(code); expect(w.mint).not.toHaveBeenCalled();
    }
  });
});

describe('AU-T13: session kind x endpoint family (08 R10): a kind mismatch is 401 auth.session_expired and changes NOTHING', () => {
  const resolveStaff = (w: AppWorld, token: string, key: string | undefined) => {
    const { hctx } = w.makeHctx(key ? { bffKey: key } : { bffKey: undefined });
    return createResolveSession(w.deps as any)(w.req({ token, as: 'cookie', body: { touch: false } }) as any, hctx) as Promise<any>;
  };
  const untouched = (w: AppWorld, row: { state: string; tokenHex: string; prevHex: string | null }, snap: { state: string; tokenHex: string; prevHex: string | null }) => {
    expect(w.committed()).toHaveLength(0); expect(row.state).toBe(snap.state); expect(row.tokenHex).toBe(snap.tokenHex); expect(row.prevHex).toBe(snap.prevHex);
  };
  it('a patient token on /v1/identity/auth/* (resolveSession, staff key) -> 401; a staff_mobile token the same; no write', async () => {
    for (const kind of ['patient', 'staff_mobile'] as const) for (const key of ['staff_web', 'partner']) {
      const w = await makeAppWorld(); const { token, row } = w.addSession({ kind }); const snap = { ...row };
      expect((await rejection(resolveStaff(w, token, key))).code, `${kind}/${key}`).toBe('auth.session_expired'); untouched(w, row, snap);
    }
  });
  it('a tenant_staff session resolved with the partner key -> 401; a partner session with the staff_web key -> 401', async () => {
    for (const [kind, key] of [['tenant_staff', 'partner'], ['partner', 'staff_web']] as const) {
      const w = await makeAppWorld(); const { token, row } = w.addSession({ kind, appInstanceId: null, appPlatform: null }); const snap = { ...row };
      expect((await rejection(resolveStaff(w, token, key))).code, `${kind}/${key}`).toBe('auth.session_expired'); untouched(w, row, snap);
    }
  });
  it('a staff_mobile token on /auth/patient/* (resolve + logout) -> 401', async () => {
    const w = await makeAppWorld(); const { token, row } = w.addSession({ kind: 'staff_mobile' }); const snap = { ...row };
    expect((await rejection(patientResolve(w, token).run())).code).toBe('auth.session_expired');
    expect((await rejection(patientLogout(w, token).run())).code).toBe('auth.session_expired'); untouched(w, row, snap); expect(w.mint).not.toHaveBeenCalled();
  });
  it('a patient token on /mobile/sessions/* (refresh + logout) -> 401, NOT treated as reuse, not rotated', async () => {
    const w = await makeAppWorld(); const { token, row } = w.addSession({ kind: 'patient' }); const snap = { ...row };
    expect((await rejection(refresh(w, token).run())).code).toBe('auth.session_expired');
    expect((await rejection(mobileLogout(w, token).run())).code).toBe('auth.session_expired'); untouched(w, row, snap);
  });
  it('tenant_staff and partner tokens on both app families -> 401, no write', async () => {
    for (const kind of ['tenant_staff', 'partner'] as const) {
      const w = await makeAppWorld(); const { token, row } = w.addSession({ kind, appInstanceId: null, appPlatform: null }); const snap = { ...row };
      for (const run of [() => patientResolve(w, token).run(), () => patientLogout(w, token).run(), () => refresh(w, token).run(), () => mobileLogout(w, token).run()]) expect((await rejection(run())).code).toBe('auth.session_expired');
      untouched(w, row, snap);
    }
  });
  it('a request without a valid X-Lims-Bff-Key on any bffSession operation -> 401 (resolveSession, logoutSession)', async () => {
    const w = await makeAppWorld(); const { token } = w.addSession({ kind: 'tenant_staff', appInstanceId: null, appPlatform: null });
    for (const key of [undefined, 'portal', 'bogus']) expect((await rejection(resolveStaff(w, token, key))).code, String(key)).toBe('auth.session_expired');
    const { hctx } = w.makeHctx({ bffKey: undefined });
    expect((await rejection(createLogoutSession(w.deps as any)(w.req({ token, as: 'cookie', body: undefined }) as any, hctx))).code).toBe('auth.session_expired');
    expect(w.committed()).toHaveLength(0);
  });
});

function START_PLUS(w: AppWorld, ms: number) { return w.clock.ms + ms; }
