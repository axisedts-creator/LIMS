// T7 integration: the three real handler factories + a real GoTrue gateway, TOTP generated from the enrolment secret (RFC 6238, gotrue/__tests__/helpers.ts).
//   - always: the in-memory GoTrue fake (passes the shared contract suite);
//   - live:   the pinned GoTrue container through createHttpGoTrueGateway, env-gated exactly like gotrue/__tests__/http.live.test.ts
//             (LIMS_TEST_GOTRUE_URL + LIMS_TEST_GOTRUE_SERVICE_KEY; LIMS_TEST_REQUIRE_LIVE=1 turns a missing env into a failure).
// Persistence is the in-memory store of mfa.helpers.ts (real DB: db/tests/identity + a later live repo test). Expected now: fail (handlers are stubs, no factories).
import { describe, expect, it } from 'vitest';
import { createHttpGoTrueGateway } from '../../gotrue/gateway.http.js';
import type { GoTrueGateway } from '../../gotrue/gateway.js';
import { jwtClaims } from '../../gotrue/__tests__/helpers.js';
import { badCode, rejection, totp, makeMfaWorld } from './mfa.helpers.js';
import { createCompleteMfaEnrolment } from '../completeMfaEnrolment.js';
import { createStartMfaEnrolment } from '../startMfaEnrolment.js';
import { createVerifyMfaChallenge } from '../verifyMfaChallenge.js';

const url = process.env['LIMS_TEST_GOTRUE_URL']; const key = process.env['LIMS_TEST_GOTRUE_SERVICE_KEY'];
const live = Boolean(url && key);
if (process.env['LIMS_TEST_REQUIRE_LIVE'] === '1') describe('live GoTrue required (T7)', () => { it('LIMS_TEST_GOTRUE_URL / _SERVICE_KEY are set', () => { expect(live).toBe(true); }); });

type W = Awaited<ReturnType<typeof makeMfaWorld>>;
const call = (w: W, h: any, o: { token: string; body?: unknown; params?: Record<string, string> }) => { const { hctx } = w.makeHctx(); return h(w.req(o), hctx); };

function suite(label: string, gateway: () => GoTrueGateway | undefined, skip = false) {
  describe.skipIf(skip)(`MFA flows vs ${label}`, () => {
    const verify = (w: W) => createVerifyMfaChallenge(w.deps as any) as any;
    const startH = (w: W) => createStartMfaEnrolment(w.deps as any) as any;
    const completeH = (w: W) => createCompleteMfaEnrolment(w.deps as any) as any;
    const T = 90_000;

    it('AC-A3.1/A3.2/SS7: enrolment_required session -> start -> TOTP from the secret -> complete: factor verified in GoTrue AND mirror, session active at aal2 (JWT aal claim = aal2), events mfa_enrolled + login_succeeded', async () => {
      const w = await makeMfaWorld(gateway() ? { gateway: gateway()! } : {}); const a = await w.addSession({ state: 'mfa_enrolment_required' });
      const s = await call(w, startH(w), { token: a.token, body: { friendly_name: 'Work phone' } });
      expect(s.body.secret_base32).toMatch(/^[A-Z2-7]+=*$/);
      expect((await w.gw.mfaListFactors(a.row.accessToken)).filter((f) => f.status === 'unverified')).toHaveLength(1);
      const sid = jwtClaims(a.row.accessToken)['session_id'];
      const r = await call(w, completeH(w), { token: a.token, body: { code: totp(s.body.secret_base32) }, params: { factor_id: s.body.factor_id } });
      expect(r.body).toMatchObject({ state: 'active', aal: 'aal2' });
      const row = w.store.byId(a.row.sessionId)!; expect(jwtClaims(row.accessToken)['aal']).toBe('aal2'); expect(jwtClaims(row.accessToken)['session_id']).toBe(sid);
      expect((await w.gw.mfaListFactors(row.accessToken)).filter((f) => f.status === 'verified')).toHaveLength(1);
      expect(w.store.factors.filter((f) => f.status === 'verified')).toHaveLength(1);
      expect(w.store.eventsOf('mfa_enrolled')).toHaveLength(1); expect(w.store.eventsOf('login_succeeded')).toHaveLength(1);
    }, T);

    it('AC-A2.1/A2.2/SS5: user with a verified factor -> fresh aal1 session in mfa_pending -> wrong code 401 (counted) -> right code -> active aal2', async () => {
      const w = await makeMfaWorld(gateway() ? { gateway: gateway()! } : {}); const a = await w.addSession({ state: 'mfa_pending', verifiedFactor: true });
      expect(jwtClaims(a.row.accessToken)['aal']).toBe('aal1');
      const e = await rejection(call(w, verify(w), { token: a.token, body: { code: badCode(a.secret!) } })); expect(e.code).toBe('auth.mfa_invalid');
      expect(w.store.byId(a.row.sessionId)!.mfaFailedAttempts).toBe(1); expect(w.store.eventsOf('mfa_challenge_failed')).toHaveLength(1);
      const r = await call(w, verify(w), { token: a.token, body: { code: totp(a.secret!) } }); expect(r.body).toMatchObject({ state: 'active', aal: 'aal2' });
      expect(jwtClaims(w.store.byId(a.row.sessionId)!.accessToken)['aal']).toBe('aal2');
    }, T);

    it('AC-A2.3/SS6/AU-T3: five wrong codes -> 5 x 401, 5 committed counter increments + events, session revoked (mfa_failed), sign-out job; the 6th request -> 401 auth.session_expired', async () => {
      const w = await makeMfaWorld(gateway() ? { gateway: gateway()! } : {}); const a = await w.addSession({ state: 'mfa_pending', verifiedFactor: true });
      for (let i = 1; i <= 5; i++) { const e = await rejection(call(w, verify(w), { token: a.token, body: { code: badCode(a.secret!) } })); expect(e.code).toBe('auth.mfa_invalid'); expect(w.store.byId(a.row.sessionId)!.mfaFailedAttempts).toBe(i); }
      expect(w.store.byId(a.row.sessionId)).toMatchObject({ state: 'revoked', revokeReason: 'mfa_failed' }); expect(w.store.eventsOf('mfa_challenge_failed')).toHaveLength(5); expect(w.store.committed('enqueue')).toHaveLength(1);
      expect((await rejection(call(w, verify(w), { token: a.token, body: { code: totp(a.secret!) } }))).code).toBe('auth.session_expired');
    }, T);

    it('D-215: platform staff enrolment end to end writes platform_mfa_enrolled (tenant-less factor row, no bindTenant)', async () => {
      const w = await makeMfaWorld({ ...(gateway() ? { gateway: gateway()! } : {}), kind: 'platform' }); const a = await w.addSession({ state: 'mfa_enrolment_required' });
      const s = await call(w, startH(w), { token: a.token, body: {} });
      const r = await call(w, completeH(w), { token: a.token, body: { code: totp(s.body.secret_base32) }, params: { factor_id: s.body.factor_id } });
      expect(r.body).toMatchObject({ kind: 'platform', state: 'active', aal: 'aal2' }); expect(w.tx.bindTenant).not.toHaveBeenCalled();
      expect(w.store.committed('recordPlatformEvent').map((x) => x.arg.eventType)).toEqual(['platform_mfa_enrolled']);
    }, T);

    it('re-enrolment: a second start deletes the unverified GoTrue factor of the first; only the new secret verifies', async () => {
      const w = await makeMfaWorld(gateway() ? { gateway: gateway()! } : {}); const a = await w.addSession({ state: 'mfa_enrolment_required' });
      const s1 = await call(w, startH(w), { token: a.token, body: {} }); const s2 = await call(w, startH(w), { token: a.token, body: {} });
      expect((await w.gw.mfaListFactors(a.row.accessToken)).filter((f) => f.status === 'unverified')).toHaveLength(1);
      const e = await rejection(call(w, completeH(w), { token: a.token, body: { code: totp(s2.body.secret_base32) }, params: { factor_id: s1.body.factor_id } })); expect(e.code).toBe('common.not_found');
      const r = await call(w, completeH(w), { token: a.token, body: { code: totp(s2.body.secret_base32) }, params: { factor_id: s2.body.factor_id } }); expect(r.body.aal).toBe('aal2');
    }, T);
  });
}

suite('in-memory GoTrue fake (real TOTP maths)', () => undefined);
suite('real GoTrue container (LIMS_TEST_GOTRUE_*)', () => (live ? createHttpGoTrueGateway({ url: url!, serviceKey: key! }) : undefined), !live);
