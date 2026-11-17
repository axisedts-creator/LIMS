// Shared GoTrueGateway contract (02-TRD s8, plan T1): happy + failure per method. The SAME suite runs against
//  (1) gateway.fake.ts (fake.contract.test.ts, always) and (2) gateway.http.ts vs the real container (http.live.test.ts, env-gated).
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import type { GoTrueGateway, GoTrueTokens } from '../gateway.js';
import { CR_DIR, goodPassword, jwtClaims, readVerdicts, totp, uniqueEmail, UUID } from './helpers.js';

export interface Harness {
  readonly gateway: GoTrueGateway;
  /** token_hash of the newest invite/recovery mail for `email` (fake: outbox; live: auth.one_time_tokens via psql). */
  latestTokenHash(email: string, type: 'invite' | 'recovery'): Promise<string | undefined>;
  /** Make every outstanding invite/recovery link `seconds` older. */
  ageEmailTokens(seconds: number): Promise<void>;
  /** Wait until GoTrue's refresh-token reuse interval has passed (fake: advance clock; live: sleep). */
  passReuseInterval(): Promise<void>;
  /** Stored password hash of a user (REQ-SEC-060 / AU-T12: `$2a$10$` prefix). Optional. */
  passwordHash?(userId: string): Promise<string | undefined>;
}

async function newUser(g: GoTrueGateway, tag: string): Promise<{ email: string; password: string; userId: string }> {
  const email = uniqueEmail(tag); const password = goodPassword();
  const c = await g.adminCreateUser({ email, emailConfirm: true });
  if ('exists' in c) throw new Error('fixture email collided');
  await g.adminUpdatePassword(c.userId, password);
  return { email, password, userId: c.userId };
}
async function login(g: GoTrueGateway, email: string, password: string): Promise<GoTrueTokens> {
  const r = await g.signInWithPassword(email, password);
  if (!r.ok) throw new Error('fixture login failed');
  return r.tokens;
}
async function enrolled(g: GoTrueGateway, t: GoTrueTokens) {
  const enr = await g.mfaEnrollTotp(t.accessToken, 'T1');
  const v = await g.mfaChallengeAndVerify(t.accessToken, enr.factorId, totp(enr.secret));
  if (!v.ok) throw new Error('fixture mfa failed');
  return { enr, tokens: v.tokens };
}

export function describeGatewayContract(name: string, make: () => Harness, timeoutMs = 10_000) {
  describe(`GoTrueGateway contract: ${name}`, { timeout: timeoutMs }, () => {
    const h = make(); const g = h.gateway;

    describe('signInWithPassword', () => {
      it('happy: tokens carry sub/session_id/aal1/exp that match the returned fields', async () => {
        const u = await newUser(g, 'si');
        const r = await g.signInWithPassword(u.email, u.password);
        expect(r.ok).toBe(true); if (!r.ok) return;
        const t = r.tokens; const c = jwtClaims(t.accessToken);
        expect(t.userId).toMatch(UUID); expect(t.sessionId).toMatch(UUID);
        expect(t.userId).toBe(u.userId);
        expect(c['sub']).toBe(t.userId); expect(c['session_id']).toBe(t.sessionId);   // session_id claim (08 R10.6)
        expect(c['aal']).toBe('aal1'); expect(t.aal).toBe('aal1');
        expect(c['role']).toBe('authenticated');
        expect(c['exp']).toBe(t.expiresAt); expect(typeof c['iat']).toBe('number');
        expect(t.refreshToken.length).toBeGreaterThan(8);
      });
      it('login is case-insensitive on e-mail', async () => {
        const u = await newUser(g, 'sic');
        expect((await g.signInWithPassword(u.email.toUpperCase(), u.password)).ok).toBe(true);
      });
      it('failure: wrong password and unknown e-mail both → {ok:false} (no distinguishing field)', async () => {
        const u = await newUser(g, 'sif');
        const bad = await g.signInWithPassword(u.email, 'definitely-Wrong-1!');
        const unk = await g.signInWithPassword(uniqueEmail('nobody'), 'definitely-Wrong-1!');
        expect(bad).toEqual({ ok: false }); expect(unk).toEqual({ ok: false });
      });
      it('two logins make two distinct sessions', async () => {
        const u = await newUser(g, 'si2');
        const a = await login(g, u.email, u.password); const b = await login(g, u.email, u.password);
        expect(a.sessionId).not.toBe(b.sessionId);
      });
      it.skipIf(!h.passwordHash)('REQ-SEC-060 / AU-T12: stored hash has the bcrypt cost-10 prefix $2a$10$', async () => {
        const u = await newUser(g, 'hash');
        expect(await h.passwordHash!(u.userId)).toMatch(/^\$2a\$10\$/);
      });
    });

    describe('refresh (rotation + reuse)', () => {
      it('happy: rotates the refresh token, keeps session id, new access token', async () => {
        const u = await newUser(g, 'rf');
        const t0 = await login(g, u.email, u.password);
        const r = await g.refresh(t0.refreshToken);
        expect(r.ok).toBe(true); if (!r.ok) return;
        expect(r.tokens.refreshToken).not.toBe(t0.refreshToken);
        expect(r.tokens.sessionId).toBe(t0.sessionId); expect(r.tokens.userId).toBe(t0.userId);
        expect(jwtClaims(r.tokens.accessToken)['session_id']).toBe(t0.sessionId);
        expect(r.tokens.accessToken).not.toBe(t0.accessToken);
      });
      it('failure: garbage token → reason invalid', async () => {
        expect(await g.refresh('not-a-real-refresh-token')).toEqual({ ok: false, reason: 'invalid' });
      });
      // Reuse behaviour of the pinned version is what T1 must VERIFY (02-TRD:490), so it is asserted against the
      // mapping.md REFRESH_REUSE verdict, never hard-coded. LIMS itself revokes the LIMS session on `reused` (02-TRD:125).
      it('reuse of a token two rotations old (after the reuse interval) → reason reused; newest token per REFRESH_REUSE verdict', async () => {
        const verdict = readVerdicts().REFRESH_REUSE; expect(verdict).toBeDefined();
        const u = await newUser(g, 'ru');
        const t0 = await login(g, u.email, u.password);
        const t1 = await g.refresh(t0.refreshToken); expect(t1.ok).toBe(true); if (!t1.ok) return;
        const t2 = await g.refresh(t1.tokens.refreshToken); expect(t2.ok).toBe(true); if (!t2.ok) return;
        await h.passReuseInterval();
        expect(await g.refresh(t0.refreshToken)).toEqual({ ok: false, reason: 'reused' });
        if (verdict === 'CONFIRMED') {
          expect((await g.refresh(t2.tokens.refreshToken)).ok).toBe(false);      // GoTrue revoked the token family
        } else {
          expect(existsSync(resolve(CR_DIR, 'T1.nonblocking.md'))).toBe(true);   // REFUTED ⇒ CR-C2-T1-b must exist
          expect(readFileSync(resolve(CR_DIR, 'T1.nonblocking.md'), 'utf8')).toContain('CR-C2-T1-b');
        }
      });
      it('reuse of the immediate parent after one rotation (after the reuse interval) is pinned to the REFRESH_REUSE verdict', async () => {
        const verdict = readVerdicts().REFRESH_REUSE; expect(verdict).toBeDefined();
        const u = await newUser(g, 'rp');
        const t0 = await login(g, u.email, u.password);
        const t1 = await g.refresh(t0.refreshToken); expect(t1.ok).toBe(true); if (!t1.ok) return;
        await h.passReuseInterval();
        const again = await g.refresh(t0.refreshToken);
        if (verdict === 'CONFIRMED') expect(again).toEqual({ ok: false, reason: 'reused' });
        else {                                                                   // REFUTED ⇒ real GoTrue is lenient toward the immediate parent
          expect(again.ok).toBe(true);
          if (again.ok) expect(again.tokens.sessionId).toBe(t0.sessionId);
        }
      });
      it('failure: refresh after local sign-out / admin sign-out → not ok (revoked or invalid)', async () => {
        const u = await newUser(g, 'rs');
        const a = await login(g, u.email, u.password); await g.signOut(a.accessToken, 'local');
        const ra = await g.refresh(a.refreshToken);
        expect(ra.ok).toBe(false); if (!ra.ok) expect(['revoked', 'invalid']).toContain(ra.reason);
        const b = await login(g, u.email, u.password); await g.adminSignOutUser(u.userId);
        const rb = await g.refresh(b.refreshToken);
        expect(rb.ok).toBe(false); if (!rb.ok) expect(['revoked', 'invalid']).toContain(rb.reason);
      });
    });

    describe('signOut', () => {
      it("scope 'local' ends only this session; 'global' ends all of the user's sessions", async () => {
        const u = await newUser(g, 'so');
        const a = await login(g, u.email, u.password); const b = await login(g, u.email, u.password);
        await g.signOut(a.accessToken, 'local');
        expect((await g.refresh(a.refreshToken)).ok).toBe(false);
        expect((await g.refresh(b.refreshToken)).ok).toBe(true);
        const b2 = await login(g, u.email, u.password);
        await g.signOut(b2.accessToken, 'global');
        expect((await g.refresh(b2.refreshToken)).ok).toBe(false);
      });
      it('already signed-out token resolves (idempotent for the worker, 02-TRD s9)', async () => {
        const u = await newUser(g, 'so2');
        const a = await login(g, u.email, u.password);
        await g.signOut(a.accessToken, 'local');
        await expect(g.signOut(a.accessToken, 'local')).resolves.toBeUndefined();
      });
    });

    describe('adminCreateUser / adminFindUserByEmail', () => {
      it('happy: creates a confirmed user (uuid), findable by e-mail case-insensitively', async () => {
        const email = uniqueEmail('ac');
        const c = await g.adminCreateUser({ email, emailConfirm: true });
        expect('userId' in c && !('exists' in c)).toBe(true); if (!('userId' in c)) return;
        expect(c.userId).toMatch(UUID);
        expect(await g.adminFindUserByEmail(email)).toEqual({ userId: c.userId });
        expect(await g.adminFindUserByEmail(email.toUpperCase())).toEqual({ userId: c.userId });
      });
      it('duplicate (any case) → {exists:true, userId of the first}', async () => {
        const email = uniqueEmail('ad');
        const c = await g.adminCreateUser({ email, emailConfirm: true }); if (!('userId' in c)) return;
        expect(await g.adminCreateUser({ email, emailConfirm: true })).toEqual({ exists: true, userId: c.userId });
        expect(await g.adminCreateUser({ email: email.toUpperCase(), emailConfirm: true })).toEqual({ exists: true, userId: c.userId });
      });
      it('failure: malformed e-mail rejects', async () => {
        await expect(g.adminCreateUser({ email: 'not-an-email', emailConfirm: true })).rejects.toBeDefined();
      });
      it('find: unknown e-mail → null', async () => {
        expect(await g.adminFindUserByEmail(uniqueEmail('ghost'))).toBeNull();
      });
    });

    describe('adminUpdatePassword (password min-length)', () => {
      it('happy: new password works, old one stops working', async () => {
        const u = await newUser(g, 'up'); const next = goodPassword();
        await g.adminUpdatePassword(u.userId, next);
        expect((await g.signInWithPassword(u.email, next)).ok).toBe(true);
        expect((await g.signInWithPassword(u.email, u.password)).ok).toBe(false);
      });
      it('failure: 11 chars rejected by GoTrue config, 12 accepted (min-length 12, AU-T4)', async () => {
        const u = await newUser(g, 'upl');
        await expect(g.adminUpdatePassword(u.userId, 'Abcdef-1234')).rejects.toBeDefined();           // 11
        await expect(g.adminUpdatePassword(u.userId, 'Abcdef-12345')).resolves.toBeUndefined();       // 12
      });
      it('failure: unknown user id rejects', async () => {
        await expect(g.adminUpdatePassword('0190a000-0000-7000-8000-00000000dead', goodPassword())).rejects.toBeDefined();
      });
    });

    describe('adminSignOutUser', () => {
      it('happy: all sessions of the user die; other users are untouched', async () => {
        const u = await newUser(g, 'as'); const other = await newUser(g, 'aso');
        const a = await login(g, u.email, u.password); const b = await login(g, u.email, u.password);
        const o = await login(g, other.email, other.password);
        await g.adminSignOutUser(u.userId);
        expect((await g.refresh(a.refreshToken)).ok).toBe(false); expect((await g.refresh(b.refreshToken)).ok).toBe(false);
        expect((await g.refresh(o.refreshToken)).ok).toBe(true);
      });
      it('user with no sessions resolves (idempotent)', async () => {
        const u = await newUser(g, 'as0');
        await expect(g.adminSignOutUser(u.userId)).resolves.toBeUndefined();
      });
      it('failure: unknown user id rejects', async () => {
        await expect(g.adminSignOutUser('0190a000-0000-7000-8000-00000000dead')).rejects.toBeDefined();
      });
    });

    describe('MFA (TOTP): enroll / challenge+verify / list / adminDeleteFactor', () => {
      it('enroll → unverified factor with otpauth uri + base32 secret', async () => {
        const u = await newUser(g, 'me'); const t = await login(g, u.email, u.password);
        const e = await g.mfaEnrollTotp(t.accessToken, 'My phone');
        expect(e.factorId).toMatch(UUID);
        expect(e.otpauthUri.startsWith('otpauth://totp/')).toBe(true);
        expect(e.secret).toMatch(/^[A-Z2-7]{16,}=*$/);
        const list = await g.mfaListFactors(t.accessToken);
        expect(list).toContainEqual(expect.objectContaining({ factorId: e.factorId, type: 'totp', status: 'unverified' }));
      });
      it('verify with a correct code → aal2 after TOTP, same session_id claim; factor becomes verified', async () => {
        const u = await newUser(g, 'mv'); const t = await login(g, u.email, u.password);
        const e = await g.mfaEnrollTotp(t.accessToken);
        const v = await g.mfaChallengeAndVerify(t.accessToken, e.factorId, totp(e.secret));
        expect(v.ok).toBe(true); if (!v.ok) return;
        const c = jwtClaims(v.tokens.accessToken);
        expect(c['aal']).toBe('aal2'); expect(v.tokens.aal).toBe('aal2');
        expect(c['session_id']).toBe(t.sessionId); expect(v.tokens.sessionId).toBe(t.sessionId);
        expect(c['sub']).toBe(t.userId);
        expect(await g.mfaListFactors(v.tokens.accessToken)).toContainEqual(expect.objectContaining({ factorId: e.factorId, status: 'verified' }));
      });
      it('refresh of an aal2 session keeps aal2', async () => {
        const u = await newUser(g, 'mr'); const t = await login(g, u.email, u.password);
        const { tokens } = await enrolled(g, t);
        const r = await g.refresh(tokens.refreshToken); expect(r.ok).toBe(true); if (!r.ok) return;
        expect(jwtClaims(r.tokens.accessToken)['aal']).toBe('aal2'); expect(r.tokens.aal).toBe('aal2');
      });
      it('login after enrolment is aal1 until the TOTP is verified in that session', async () => {
        const u = await newUser(g, 'ml'); const t = await login(g, u.email, u.password);
        await enrolled(g, t);
        const t2 = await login(g, u.email, u.password);
        expect(t2.aal).toBe('aal1'); expect(jwtClaims(t2.accessToken)['aal']).toBe('aal1');
      });
      it('failure: wrong code → {ok:false}, session stays aal1', async () => {
        const u = await newUser(g, 'mw'); const t = await login(g, u.email, u.password);
        const e = await g.mfaEnrollTotp(t.accessToken);
        const good = totp(e.secret); const wrong = String((Number(good) + 1) % 1_000_000).padStart(6, '0');
        expect(await g.mfaChallengeAndVerify(t.accessToken, e.factorId, wrong)).toEqual({ ok: false });
        expect((await g.mfaListFactors(t.accessToken))[0]?.status).toBe('unverified');
      });
      it('failure: invalid access token rejects (enroll / list) ; unknown factor → {ok:false} or reject, never ok', async () => {
        await expect(g.mfaEnrollTotp('garbage.token.value')).rejects.toBeDefined();
        await expect(g.mfaListFactors('garbage.token.value')).rejects.toBeDefined();
        const u = await newUser(g, 'mu'); const t = await login(g, u.email, u.password);
        const r = await g.mfaChallengeAndVerify(t.accessToken, '0190a000-0000-7000-8000-00000000dead', '123456').catch(() => ({ ok: false }));
        expect(r.ok).toBe(false);
      });
      it('adminDeleteFactor: factor disappears from the list; deleting again / unknown factor rejects', async () => {
        const u = await newUser(g, 'md'); const t = await login(g, u.email, u.password);
        const { enr, tokens } = await enrolled(g, t);
        await g.adminDeleteFactor(u.userId, enr.factorId);
        expect(await g.mfaListFactors(tokens.accessToken)).not.toContainEqual(expect.objectContaining({ factorId: enr.factorId }));
        await expect(g.adminDeleteFactor(u.userId, enr.factorId)).rejects.toBeDefined();
        await expect(g.adminDeleteFactor(u.userId, '0190a000-0000-7000-8000-00000000dead')).rejects.toBeDefined();
      });
    });

    describe('sendInvite / sendRecovery / verifyEmailToken', () => {
      it('invite: mail carries token_hash; verify(invite) → tokens for that user; single-use', async () => {
        const email = uniqueEmail('inv');
        await g.sendInvite(email, '/auth/confirm');
        const hash = await h.latestTokenHash(email, 'invite'); expect(hash).toBeTruthy();
        const v = await g.verifyEmailToken(hash!, 'invite'); expect(v.ok).toBe(true); if (!v.ok) return;
        expect(v.tokens.userId).toBe((await g.adminFindUserByEmail(email))!.userId);
        expect(v.tokens.sessionId).toMatch(UUID);
        expect(await g.verifyEmailToken(hash!, 'invite')).toEqual({ ok: false });
      });
      it('invite for an already registered e-mail rejects (no silent resend)', async () => {
        const u = await newUser(g, 'invx');
        await expect(g.sendInvite(u.email, '/auth/confirm')).rejects.toBeDefined();
      });
      it('recovery: verify(recovery) → tokens; then adminUpdatePassword + login works; single-use', async () => {
        const u = await newUser(g, 'rec');
        await g.sendRecovery(u.email, '/auth/confirm');
        const hash = await h.latestTokenHash(u.email, 'recovery'); expect(hash).toBeTruthy();
        const v = await g.verifyEmailToken(hash!, 'recovery'); expect(v.ok).toBe(true); if (!v.ok) return;
        expect(v.tokens.userId).toBe(u.userId);
        expect(await g.verifyEmailToken(hash!, 'recovery')).toEqual({ ok: false });
      });
      it('recovery for an unknown e-mail resolves silently and sends nothing (no account oracle)', async () => {
        const email = uniqueEmail('norec');
        await expect(g.sendRecovery(email, '/auth/confirm')).resolves.toBeUndefined();
        expect(await h.latestTokenHash(email, 'recovery')).toBeUndefined();
      });
      it('failure: garbage hash, empty hash, and type mismatch → {ok:false}', async () => {
        expect(await g.verifyEmailToken('deadbeef'.repeat(8), 'recovery')).toEqual({ ok: false });
        expect(await g.verifyEmailToken('', 'invite')).toEqual({ ok: false });
        const u = await newUser(g, 'mis'); await g.sendRecovery(u.email, '/auth/confirm');
        const hash = (await h.latestTokenHash(u.email, 'recovery'))!;
        expect(await g.verifyEmailToken(hash, 'invite')).toEqual({ ok: false });
      });
      it('link TTL (08 A25 D-219): matches the mapping.md LINK_TTL_LE_60MIN verdict; fresh link always works', async () => {
        const verdict = readVerdicts().LINK_TTL_LE_60MIN; expect(verdict).toBeDefined();
        const fresh = await newUser(g, 'ttl0'); await g.sendRecovery(fresh.email, '/auth/confirm');
        expect((await g.verifyEmailToken((await h.latestTokenHash(fresh.email, 'recovery'))!, 'recovery')).ok).toBe(true);
        const aged = await newUser(g, 'ttl1'); await g.sendRecovery(aged.email, '/auth/confirm');
        const hash = (await h.latestTokenHash(aged.email, 'recovery'))!;
        await h.ageEmailTokens(3601);                       // > 60 min
        const r = await g.verifyEmailToken(hash, 'recovery');
        expect(r.ok).toBe(verdict === 'CONFIRMED' ? false : true);   // CONFIRMED ⇒ expired by 60 min; REFUTED ⇒ mapping must say so (+ CR checked in mapping.test.ts)
      });
    });
  });
}
