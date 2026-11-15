// AUTH-MFA-COMPLETE-1 (LD-221, AUTH-SENSITIVE LD-189; C2 03-APP-FLOW SS7, 05-SCHEMA s4.10 / s5.4; 08 A28.1, A25 D-215; contracts/openapi/identity.yaml SessionState; LD-208). Live evidence:
// completeMfaEnrolment 404 x6 (the plain platform_events INSERT as the system actor -> 42501 -> mapDbError 404) and verifyMfaChallenge / completeMfaEnrolment answering 200 SessionState WITHOUT actor.
// Fake tx (mfa.helpers.ts). Seams fixed here (the writer matches them or raises a dispute):
//   repo.recordPlatformMfaEnrolledEvent(tx, { id, userId, platformStaffId, detail: { factor_id }, requestId, clientIp, actorId })  -> the DEFINER; the ONLY platform_events write of the platform branch
//   repo.sessionActor(tx, { userId, tenantId|null, membershipId|null }) read BEFORE the GoTrue code check (a missing actor never consumes a code); body.actor via loadSessionActor (session-actor.ts)
// Expected now: fail (completeMfaEnrolment still calls recordPlatformEvent; verifyMfaChallenge.sessionState has no actor).
import { join } from 'node:path';
import { AjvCompiler } from '@fastify/ajv-compiler';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';
import { AJV_OPTIONS } from '../../../../core/openapi.js';
import { LimsError, MEMB_A, STAFF_ID, SYSTEM_ACTOR, TENANT_A, makeMfaWorld, rejection, totp, type MfaWorld } from './mfa.helpers.js';
import { createCompleteMfaEnrolment } from '../completeMfaEnrolment.js';
import { createStartMfaEnrolment } from '../startMfaEnrolment.js';
import { createVerifyMfaChallenge } from '../verifyMfaChallenge.js';

// ---- the contract validator (same options as core/openapi.ts RESPONSE_AJV_OPTIONS; same recipe as __tests__/session-actor.contract.test.ts) ------------------
const spec: any = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'identity.yaml'));
const factory = AjvCompiler() as unknown as (ext: object, o: { customOptions: object }) => (c: { schema: object }) => ((v: unknown) => boolean) & { errors?: any[] };
const compile = factory({}, { customOptions: { ...AJV_OPTIONS, coerceTypes: false, useDefaults: false, keywords: [...AJV_OPTIONS.keywords, 'components'] } });
function responseSchema(operationId: string): object {
  for (const item of Object.values<any>(spec.paths)) for (const m of ['get', 'put', 'post', 'delete', 'patch']) {
    if (item?.[m]?.operationId === operationId) return { components: spec.components, ...item[m].responses['200'].content['application/json'].schema };
  }
  throw new Error(`no operation ${operationId}`);
}
const violations = (operationId: string, body: unknown): any[] => { const v = compile({ schema: responseSchema(operationId) }); return v(body) ? [] : [...(v.errors ?? [])]; };

const TENANT_ACTOR = { display_name: 'Ana Demo', roles: ['lab_manager', 'technician'], tenant_code: 'lab_a' };
const PLATFORM_ACTOR = { display_name: 'Sam Staff', roles: ['platform_support'] };
const ACTOR_KEYS = ['display_name', 'roles', 'tenant_code'];

const verify = async (w: MfaWorld, token: string, code: string) => { const { hctx } = w.makeHctx({ operationId: 'verifyMfaChallenge' }); return (createVerifyMfaChallenge(w.deps as any) as any)(w.req({ token, body: { code } }), hctx); };
const start = async (w: MfaWorld, token: string) => { const { hctx } = w.makeHctx({ operationId: 'startMfaEnrolment' }); return (createStartMfaEnrolment(w.deps as any) as any)(w.req({ token, body: {} }), hctx); };
const complete = async (w: MfaWorld, token: string, factorId: string, code: string) => {
  const { hctx } = w.makeHctx({ operationId: 'completeMfaEnrolment' }); return (createCompleteMfaEnrolment(w.deps as any) as any)(w.req({ token, body: { code }, params: { factor_id: factorId } }), hctx);
};
/** a platform / tenant world with an unverified factor already started: ready to complete */
async function enrolling(kind: 'platform' | 'tenant_staff', state = 'mfa_enrolment_required') {
  const w = await makeMfaWorld({ kind }); const a = await w.addSession({ state }); const s = await start(w, a.token); return { w, a, s, code: () => totp(s.body.secret_base32) };
}
const gotrueSeq = (w: MfaWorld, seq: string[]) => {
  (w.store.repo as any).sessionActor = ((orig) => async (...x: any[]) => { seq.push('actor'); return orig(...x); })(w.store.repo.sessionActor);
  // replace on the UNDERLYING gateway (w.gw): the recording Proxy w.gotrue looks the method up at call time, so wrapping the proxy's own method would recurse
  (w.gw as any).mfaChallengeAndVerify = ((orig) => async (...x: any[]) => { seq.push('gotrue'); return orig(...x); })((w.gw as any).mfaChallengeAndVerify.bind(w.gw));
};

describe('completeMfaEnrolment, platform branch: the audit event goes ONLY through the new DEFINER method (LD-221 item 4)', () => {
  it('calls recordPlatformMfaEnrolledEvent exactly once with the staff identity; the plain recordPlatformEvent is NOT called', async () => {
    const { w, a, s, code } = await enrolling('platform');
    const r = await complete(w, a.token, s.body.factor_id, code());
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ kind: 'platform', state: 'active', aal: 'aal2' });
    expect(w.store.committed('recordPlatformEvent')).toHaveLength(0);
    const ev = w.store.committed('recordPlatformMfaEnrolledEvent').map((x) => x.arg); expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ id: expect.any(String), userId: a.userId, platformStaffId: STAFF_ID, requestId: expect.any(String), clientIp: '203.0.113.9', actorId: SYSTEM_ACTOR });
    expect(ev[0].detail).toEqual({ factor_id: s.body.factor_id });
    expect(ev[0]).not.toHaveProperty('eventType'); expect(ev[0]).not.toHaveProperty('targetType');   // the DEFINER / repo fix event_type and target; the handler cannot ask for another
  });
  it('the event carries no secret, e-mail, otpauth URI, code, session token or GoTrue token', async () => {
    const { w, a, s, code } = await enrolling('platform'); const c = code(); await complete(w, a.token, s.body.factor_id, c);
    const hay = JSON.stringify(w.store.committed('recordPlatformMfaEnrolledEvent').map((x) => x.arg));
    for (const bad of [s.body.secret_base32, s.body.otpauth_uri, a.email, a.token, a.row.accessToken, a.row.refreshToken, c]) expect(hay).not.toContain(bad);
  });
  it('is written after the factor is verified, inside the same request; a tenant-less platform request never binds a tenant', async () => {
    const { w, a, s, code } = await enrolling('platform'); w.store.order.length = 0; await complete(w, a.token, s.body.factor_id, code());
    const o = w.store.order; expect(o.indexOf('recordPlatformMfaEnrolledEvent')).toBeGreaterThan(o.indexOf('markFactorVerified')); expect(w.tx.bindTenant).not.toHaveBeenCalled();
  });
  it('fail closed: when the event write is refused (the live 42501), the request fails, the factor stays unverified, the session stays enrolment-required: never a 200 without the audit row', async () => {
    const { w, a, s, code } = await enrolling('platform');
    (w.deps.repo as any).recordPlatformMfaEnrolledEvent = async () => { throw new LimsError('common.not_found'); };
    const before = w.store.committed().length;
    const e = await rejection(complete(w, a.token, s.body.factor_id, code())); expect(e.code).toBe('common.not_found');
    expect(w.store.factors.find((f) => f.id === s.body.factor_id)!.status).toBe('unverified'); expect(w.store.byId(a.row.sessionId)!.state).toBe('mfa_enrolment_required');
    expect(w.store.committed().length).toBe(before); expect(w.store.committed('markFactorVerified')).toHaveLength(0);
  });
  it('a wrong code writes no platform event (new method not called either)', async () => {
    const { w, a, s } = await enrolling('platform'); await rejection(complete(w, a.token, s.body.factor_id, '000000')).catch(() => undefined);
    expect(w.store.committed('recordPlatformMfaEnrolledEvent')).toHaveLength(0); expect(w.store.committed('recordPlatformEvent')).toHaveLength(0);
  });
  it('tenant staff are unchanged: no platform event of either kind, tenant events as before', async () => {
    const { w, a, s, code } = await enrolling('tenant_staff'); await complete(w, a.token, s.body.factor_id, code());
    expect(w.store.committed('recordPlatformMfaEnrolledEvent')).toHaveLength(0); expect(w.store.committed('recordPlatformEvent')).toHaveLength(0);
    expect(w.store.eventsOf('mfa_enrolled')).toHaveLength(1); expect(w.store.eventsOf('login_succeeded')).toHaveLength(1);
  });
});

describe('SessionState.actor on BOTH code steps, tenant and platform paths (LD-208 / LD-221 item 5; the second live defect: response_contract_violation 500)', () => {
  it('verifyMfaChallenge, tenant: 200 body.actor = { display_name, roles, tenant_code }; looked up for (user, tenant, membership)', async () => {
    const w = await makeMfaWorld(); const a = await w.addSession({ verifiedFactor: true }); const r = await verify(w, a.token, totp(a.secret!));
    expect(r.status).toBe(200); expect(r.body.actor).toEqual(TENANT_ACTOR); expect(Object.keys(r.body.actor).every((k) => ACTOR_KEYS.includes(k))).toBe(true);
    expect(w.store.actor.keys).toEqual([{ userId: a.userId, tenantId: TENANT_A, membershipId: MEMB_A }]);
  });
  it('verifyMfaChallenge, platform: actor = { display_name, roles }, NO tenant_code; looked up for (user, null, null)', async () => {
    const w = await makeMfaWorld({ kind: 'platform' }); const a = await w.addSession({ verifiedFactor: true }); const r = await verify(w, a.token, totp(a.secret!));
    expect(r.body).toMatchObject({ kind: 'platform', state: 'active', aal: 'aal2' }); expect(r.body.actor).toEqual(PLATFORM_ACTOR); expect(r.body.actor).not.toHaveProperty('tenant_code');
    expect(w.store.actor.keys).toEqual([{ userId: a.userId, tenantId: null, membershipId: null }]);
  });
  it('completeMfaEnrolment, tenant (login enrolment) and voluntary (active session): actor present', async () => {
    for (const state of ['mfa_enrolment_required', 'active']) {
      const { w, a, s, code } = await enrolling('tenant_staff', state); const r = await complete(w, a.token, s.body.factor_id, code());
      expect(r.body.actor, state).toEqual(TENANT_ACTOR); expect(w.store.actor.keys.at(-1)).toEqual({ userId: a.userId, tenantId: TENANT_A, membershipId: MEMB_A });
    }
  });
  it('completeMfaEnrolment, platform: actor = { display_name, roles }, no tenant_code; looked up for (user, null, null)', async () => {
    const { w, a, s, code } = await enrolling('platform'); const r = await complete(w, a.token, s.body.factor_id, code());
    expect(r.body.actor).toEqual(PLATFORM_ACTOR); expect(w.store.actor.keys).toEqual([{ userId: a.userId, tenantId: null, membershipId: null }]);
  });
  it('a platform row that (wrongly) carries a tenant_code, or extra columns, leaks nothing into the body', async () => {
    const w = await makeMfaWorld({ kind: 'platform' }); const a = await w.addSession({ verifiedFactor: true });
    w.store.actor.impl = () => ({ display_name: 'Sam Staff', role_codes: ['platform_support'], tenant_code: 'lab_a', email: 'leak@example.test', user_id: 'USER-LEAK', access_token: 'TOKEN-LEAK' });
    const r = await verify(w, a.token, totp(a.secret!)); expect(r.body.actor).toEqual(PLATFORM_ACTOR); expect(JSON.stringify(r.body)).not.toMatch(/leak|LEAK/);
  });
  it('all four 200 bodies validate against SessionState of contracts/openapi/identity.yaml (actor required; the staging violation is real)', async () => {
    expect(violations('verifyMfaChallenge', { session_id: '0190a000-0000-7000-8000-000000000001', kind: 'platform', state: 'active', aal: 'aal2', idle_expires_at: '2026-11-15T07:00:00.000Z', absolute_expires_at: '2026-11-15T15:00:00.000Z' })
      .some((e) => e.keyword === 'required' && e.params?.missingProperty === 'actor')).toBe(true);   // guards against a vacuous pass: the pre-fix body is rejected
    for (const kind of ['tenant_staff', 'platform'] as const) {
      const w = await makeMfaWorld({ kind }); const a = await w.addSession({ verifiedFactor: true }); const v = await verify(w, a.token, totp(a.secret!));
      expect(violations('verifyMfaChallenge', v.body), `verify ${kind}`).toEqual([]);
      const e = await enrolling(kind); const c = await complete(e.w, e.a.token, e.s.body.factor_id, e.code()); expect(violations('completeMfaEnrolment', c.body), `complete ${kind}`).toEqual([]);
    }
  });
  it('the 200 body is exactly SessionState: session_id, kind, state, aal, idle_expires_at, absolute_expires_at, actor (no tokens, no e-mail)', async () => {
    const w = await makeMfaWorld(); const a = await w.addSession({ verifiedFactor: true }); const r = await verify(w, a.token, totp(a.secret!));
    expect(Object.keys(r.body).sort()).toEqual(['aal', 'absolute_expires_at', 'actor', 'idle_expires_at', 'kind', 'session_id', 'state']);
    expect(JSON.stringify(r.body)).not.toMatch(/access_token|refresh_token|eyJ|@/);
  });
});

describe('the actor is loaded BEFORE the GoTrue code check: a missing actor never consumes a code (LD-221 item 5)', () => {
  it('verifyMfaChallenge: sessionActor is read first, then GoTrue', async () => {
    const w = await makeMfaWorld(); const a = await w.addSession({ verifiedFactor: true }); const seq: string[] = []; gotrueSeq(w, seq);
    await verify(w, a.token, totp(a.secret!)); expect(seq).toEqual(['actor', 'gotrue']);
  });
  it('completeMfaEnrolment (tenant and platform): sessionActor is read first, then GoTrue', async () => {
    for (const kind of ['tenant_staff', 'platform'] as const) {
      const { w, a, s, code } = await enrolling(kind); const seq: string[] = []; gotrueSeq(w, seq); await complete(w, a.token, s.body.factor_id, code()); expect(seq, kind).toEqual(['actor', 'gotrue']);
    }
  });
  it.each([['no row', () => undefined], ['empty display_name', () => ({ display_name: '', role_codes: [] })], ['display_name not a string', () => ({ display_name: 7, role_codes: [] })], ['no role_codes', () => ({ display_name: 'X' })]])(
    'verifyMfaChallenge with %s: 500 common.internal, GoTrue NOT called, nothing committed, attempts untouched', async (_n, impl) => {
      for (const kind of ['tenant_staff', 'platform'] as const) {
        const w = await makeMfaWorld({ kind }); const a = await w.addSession({ verifiedFactor: true }); w.store.actor.impl = impl as any; const g = w.calls.length;
        const e = await rejection(verify(w, a.token, totp(a.secret!))); expect(e.code, kind).toBe('common.internal'); expect(e.statusCode).toBe(500);
        expect(w.calls.slice(g).filter((c) => c.method === 'mfaChallengeAndVerify')).toHaveLength(0); expect(w.store.committed()).toEqual([]);
        expect(w.store.byId(a.row.sessionId)!.state).toBe('mfa_pending'); expect(w.store.byId(a.row.sessionId)!.mfaFailedAttempts).toBe(0);
      }
    });
  it.each([['no row', () => undefined], ['empty display_name', () => ({ display_name: '', role_codes: [] })]])(
    'completeMfaEnrolment with %s: 500 common.internal, GoTrue verify NOT called, the factor stays unverified, nothing committed', async (_n, impl) => {
      for (const kind of ['tenant_staff', 'platform'] as const) {
        const { w, a, s, code } = await enrolling(kind); w.store.actor.impl = impl as any; const g = w.calls.length; const n = w.store.committed().length;
        const e = await rejection(complete(w, a.token, s.body.factor_id, code())); expect(e.code, kind).toBe('common.internal');
        expect(w.calls.slice(g).filter((c) => c.method === 'mfaChallengeAndVerify')).toHaveLength(0); expect(w.store.committed().length).toBe(n);
        expect(w.store.factors.find((f) => f.id === s.body.factor_id)!.status).toBe('unverified'); expect(w.store.committed('recordPlatformMfaEnrolledEvent')).toHaveLength(0);
      }
    });
  it('a WRONG code still answers 401 auth.mfa_invalid with the counter committed (the actor read changes nothing about P-42)', async () => {
    const w = await makeMfaWorld(); const a = await w.addSession({ verifiedFactor: true }); const { hctx, commitOnError } = w.makeHctx({ operationId: 'verifyMfaChallenge' });
    const e = await rejection((createVerifyMfaChallenge(w.deps as any) as any)(w.req({ token: a.token, body: { code: '000000' } }), hctx));
    expect(e.code).toBe('auth.mfa_invalid'); expect(commitOnError).toHaveBeenCalledTimes(1); expect(w.store.byId(a.row.sessionId)!.mfaFailedAttempts).toBe(1);
  });
  it('the actor read is a read: it is not recorded as a write and the display name / roles appear in no log line', async () => {
    const w = await makeMfaWorld(); const a = await w.addSession({ verifiedFactor: true }); await verify(w, a.token, totp(a.secret!));
    expect(w.store.writes.map((x) => x.m)).not.toContain('sessionActor');
    expect(JSON.stringify([w.log.info.mock.calls, w.log.warn.mock.calls, w.log.error.mock.calls])).not.toContain('Ana Demo');
  });
});
