// AUTH-MFA-PERSIST-1 (LD-248, founder report 2026-11-16: "everytime i login i have to get new authenticator integration"; AUTH-SENSITIVE LD-189).
// Proves, with in-memory repositories that share ONE store, that a factor written as verified by completeMfaEnrolment is found by the NEXT login for each account type:
//   platform staff with no tenant membership (tenant_id NULL), tenant staff with an mfa_required role, and a user with a platform row AND a tenant membership (tenant path).
// The fake login context mirrors app.identity_login_context (20261105000800 l.113): has_verified_factor = a verified, non-removed factor of the user with
// f.tenant_id IS NOT DISTINCT FROM the chosen membership tenant (NULL for platform-only staff); the SQL itself is pinned by the static tests at the end.
// Real: createAuthService (loginStaff), createStartMfaEnrolment / createCompleteMfaEnrolment / createVerifyMfaChallenge, createResolveSession, the fake GoTrue with real TOTP maths.
// Not provable here (no database in the lane): the SQL actually running -> db/tests pgTAP + the founder's sign-in after push-cloud + one deploy (see the notes file).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createAuthService } from '../../service/auth.service.js';
import { createMfaRepo } from '../../repository/mfa.repo.js';
import { createResolveSession } from '../resolveSession.js';
import { createCompleteMfaEnrolment } from '../completeMfaEnrolment.js';
import { createStartMfaEnrolment } from '../startMfaEnrolment.js';
import { createVerifyMfaChallenge } from '../verifyMfaChallenge.js';
import { platformRow, tenantRow, idN } from '../../service/__tests__/auth.helpers.js';
import { makeMfaWorld, rejection, sha256, totp, REQ_ID, STAFF_ID, SYSTEM_ACTOR, TENANT_A, MEMB_A, type MfaWorld } from './mfa.helpers.js';

type Kind = 'platform' | 'tenant' | 'platform_and_tenant';
const same = (a: string | null, b: string | null) => (a ?? null) === (b ?? null);

/** the login seams of auth.service.ts over the shared store; loginContext mirrors the SQL function (see header) */
function makeLogin(w: MfaWorld, acct: { kind: Kind; userId: string; email: string }) {
  const { store } = w;
  const chosenTenant = acct.kind === 'platform' ? null : TENANT_A;
  const insert = (_tx: unknown, s: any) => {
    store.sessions.set(s.tokenSha256.toString('hex'), { sessionId: s.id, kind: s.kind, state: s.state, tenantId: s.tenantId, userId: s.userId, membershipId: s.membershipId,
      platformStaffId: s.platformStaffId, tokenReused: false, aal: s.aal, accessToken: s.accessToken, refreshToken: s.refreshToken, mfaFailedAttempts: 0, email: acct.email,
      accessExpiresAt: s.accessExpiresAt, idleExpiresAt: s.idleExpiresAt, absoluteExpiresAt: s.absoluteExpiresAt });
  };
  const contextReads: Array<{ sub: string; hasVerifiedFactor: boolean }> = [];
  const repo = {
    async loginContext(_tx: unknown, sub: string) {
      if (sub !== acct.userId) return undefined;
      const has = store.factors.some((f) => !f.removedReason && f.userId === sub && f.status === 'verified' && same(f.tenantId, chosenTenant));
      contextReads.push({ sub, hasVerifiedFactor: has });
      if (acct.kind === 'platform') return platformRow({ has_verified_factor: has });
      return tenantRow({ mfa_required: true, has_verified_factor: has, ...(acct.kind === 'platform_and_tenant' ? { platform_staff_id: STAFF_ID, platform_role: 'platform_support', platform_active: true, platform_allowed_cidrs: [] } : {}) });
    },
    sessionActor: store.repo.sessionActor, membershipPermissions: store.repo.membershipPermissions, enqueue: store.repo.enqueue,
    touchMembershipLogin: store.repo.touchMembershipLogin,
    insertSession: async (tx: unknown, s: any) => insert(tx, s), insertPlatformSession: async (tx: unknown, s: any) => insert(tx, s),
    async platformStaffLogin() { /* last_login bookkeeping only */ },
  };
  let n = 0xc000;
  const svc = createAuthService({ gotrue: w.gw as any, repo: repo as any, events: store.events as any, limits: w.deps.limits as any, hmac: w.deps.hmac, newId: () => idN(n++),
    newToken: () => `T${(n++).toString(36).padStart(42, '0')}`, sleep: async () => undefined, floorMs: 0, platformAllowedCidrs: [], platformIdleMinutes: 15, platformAbsoluteHours: 8 });
  async function loginStaff(password: string) {
    w.tx.bindTenant.mockClear();
    const ctx: any = { actor: { type: 'system', id: SYSTEM_ACTOR }, requestId: REQ_ID, clientIp: '203.0.113.9', userAgent: 'Mozilla/5.0 Firefox/130.0', bffKey: 'staff_web', tx: w.tx,
      now: () => new Date(w.clock.ms), commitOnError: vi.fn(), log: w.log };
    return store.envelope(() => svc.loginStaff(ctx, { email: acct.email, password })) as Promise<{ body: { session_token: string; session: any } }>;
  }
  return { loginStaff, contextReads };
}

/** one account of the given kind, in the fake GoTrue, with an empty mirror */
async function setup(kind: Kind) {
  const w = await makeMfaWorld({ kind: kind === 'platform' ? 'platform' : 'tenant_staff' });
  const email = `persist-${kind}@lims-test.example`; const password = 'Zq7-persist-Lims!';
  const u: any = await w.gw.adminCreateUser({ email, emailConfirm: true }); await w.gw.adminUpdatePassword(u.userId, password);
  const login = makeLogin(w, { kind, userId: u.userId, email });
  const startH: any = createStartMfaEnrolment(w.deps as any); const completeH: any = createCompleteMfaEnrolment(w.deps as any); const verifyH: any = createVerifyMfaChallenge(w.deps as any);
  const resolveH: any = createResolveSession({ gotrue: { refresh: async () => { throw new Error('GoTrue refresh must not be needed'); } } as any, repo: {
    ...w.store.repo,
    async loadSession(tx: unknown, ref: any) {
      const r = await w.store.repo.loadSession(tx, ref); const s = w.store.byId(ref.sessionId);
      return r && s ? { ...r, state: s.state, lastSeenAt: new Date(w.clock.ms), idleTimeoutMinutes: 30, membershipLocked: false, tenantStatus: 'active', appInstanceId: null, appPlatform: null } : undefined;
    },
    async touchSession() { throw new Error('touch=false must not touch'); }, async expireSession() { throw new Error('session must not lapse'); },
  } as any, events: w.store.events as any, hmac: w.deps.hmac, newId: w.deps.newId, now: w.deps.now });
  const call = (h: any, o: { token: string; body?: unknown; params?: Record<string, string> }) => { const { hctx } = w.makeHctx(); return h(w.req(o), hctx); };
  const resolve = (token: string) => call(resolveH, { token, body: { touch: false } });
  return { w, email, password, userId: u.userId as string, ...login, startH, completeH, verifyH, resolve, call, tenantId: kind === 'platform' ? null : TENANT_A };
}

describe.each<[string, Kind]>([
  ['platform staff with no tenant membership (factor tenant_id NULL)', 'platform'],
  ['tenant staff with an mfa_required role (factor tenant_id = the membership tenant)', 'tenant'],
  ['a user with a platform row AND a tenant membership (tenant path, tenant factor)', 'platform_and_tenant'],
])('LD-248 a verified factor is found at the NEXT login: %s', (_label, kind) => {
  it('login -> start -> complete -> resolve active; SECOND login = mfa_pending (not mfa_enrolment_required); verify activates; third login = mfa_pending again', async () => {
    const a = await setup(kind); const { w } = a;
    // 1. first login: no factor yet
    const l1 = await a.loginStaff(a.password); expect(l1.body.session).toMatchObject({ state: 'mfa_enrolment_required', kind: kind === 'platform' ? 'platform' : 'tenant_staff' });
    expect(a.contextReads.at(-1)).toMatchObject({ hasVerifiedFactor: false });
    // 2. start: the mirror row is unverified and carries the account type's tenant (NULL for platform-only staff)
    const s = await a.call(a.startH, { token: l1.body.session_token, body: {} }); expect(s.status).toBe(200);
    expect(w.store.factors).toHaveLength(1); expect(w.store.factors[0]).toMatchObject({ status: 'unverified', userId: a.userId, tenantId: a.tenantId });
    // 3. complete: GoTrue verified AND the mirror row read back as verified (the very row the next login context reads)
    const c = await a.call(a.completeH, { token: l1.body.session_token, body: { code: totp(s.body.secret_base32) }, params: { factor_id: s.body.factor_id } });
    expect(c.body).toMatchObject({ state: 'active', aal: 'aal2' });
    expect(w.store.factors[0]).toMatchObject({ id: s.body.factor_id, status: 'verified', tenantId: a.tenantId }); expect(w.store.factors[0]!.verifiedAt).toBeInstanceOf(Date);
    expect((await a.resolve(l1.body.session_token)).body.session).toMatchObject({ state: 'active', aal: 'aal2' });
    expect(w.store.committed('markFactorVerified')).toHaveLength(1);
    // 4. SECOND login: the login context finds the verified factor -> mfa_pending, a NEW session, no new enrolment
    const l2 = await a.loginStaff(a.password);
    expect(a.contextReads.at(-1)).toEqual({ sub: a.userId, hasVerifiedFactor: true });
    expect(l2.body.session).toMatchObject({ state: 'mfa_pending', aal: 'aal1' }); expect(l2.body.session_token).not.toBe(l1.body.session_token);
    // a pending session cannot start a new enrolment, and nothing is deleted or re-enrolled at GoTrue
    expect((await rejection(a.call(a.startH, { token: l2.body.session_token, body: {} }))).code).toBe('common.version_conflict');
    // 5. verifyMfaChallenge with the code of the SAME authenticator secret activates the session
    const v = await a.call(a.verifyH, { token: l2.body.session_token, body: { code: totp(s.body.secret_base32) } });
    expect(v.body).toMatchObject({ state: 'active', aal: 'aal2' });
    expect((await a.resolve(l2.body.session_token)).body.session).toMatchObject({ state: 'active', aal: 'aal2' });
    // 6. and again (a third login): still pending, still the one factor
    expect((await a.loginStaff(a.password)).body.session).toMatchObject({ state: 'mfa_pending' });
    expect(w.store.factors.filter((f) => !f.removedReason)).toHaveLength(1); expect(w.store.committed('insertFactor')).toHaveLength(1); expect(w.store.committed('removeFactor')).toHaveLength(0);
    expect(w.calls.filter((x) => x.method === 'mfaEnrollTotp')).toHaveLength(1); expect(w.calls.filter((x) => x.method === 'adminDeleteFactor')).toHaveLength(0);
    expect(w.store.eventsOf('mfa_enrolled')).toHaveLength(1); expect(w.store.eventsOf('mfa_verified')).toHaveLength(1);
  }, 30_000);

  it('a wrong code at the second login is refused and the factor stays: the next login is mfa_pending again (no re-enrolment)', async () => {
    const a = await setup(kind); const { w } = a;
    const l1 = await a.loginStaff(a.password); const s = await a.call(a.startH, { token: l1.body.session_token, body: {} });
    await a.call(a.completeH, { token: l1.body.session_token, body: { code: totp(s.body.secret_base32) }, params: { factor_id: s.body.factor_id } });
    const l2 = await a.loginStaff(a.password);
    expect((await rejection(a.call(a.verifyH, { token: l2.body.session_token, body: { code: '000000' === totp(s.body.secret_base32) ? '111111' : '000000' } }))).code).toBe('auth.mfa_invalid');
    expect(w.store.factors[0]).toMatchObject({ status: 'verified' }); expect((await a.loginStaff(a.password)).body.session.state).toBe('mfa_pending');
  }, 30_000);
});

describe('LD-248 the live cause: GoTrue verified the code but the mirror transaction rolled back (2026-11-15 platform_events RLS failure)', () => {
  // CHARACTERISATION, not a fix: with the mirror row left unverified the login context cannot see a verified factor, so every login re-enrols.
  // AUTH-MFA-COMPLETE-1 (migration 20261115157000 + a deploy) removes the failure; no TypeScript change can repair a database that never received it.
  it('platform staff: complete fails after GoTrue accepted the code -> mirror row stays unverified, GoTrue holds it verified, the NEXT login is mfa_enrolment_required and start enrols a NEW authenticator', async () => {
    const a = await setup('platform'); const { w } = a;
    const l1 = await a.loginStaff(a.password); const s1 = await a.call(a.startH, { token: l1.body.session_token, body: {} });
    const rls = Object.assign(new Error('new row violates row-level security policy for table "platform_events"'), { code: '42501' });
    const realEvent = w.store.repo.recordPlatformMfaEnrolledEvent; w.store.repo.recordPlatformMfaEnrolledEvent = async () => { throw rls; };
    await expect(a.call(a.completeH, { token: l1.body.session_token, body: { code: totp(s1.body.secret_base32) }, params: { factor_id: s1.body.factor_id } })).rejects.toBe(rls);
    w.store.repo.recordPlatformMfaEnrolledEvent = realEvent;
    expect(w.store.factors[0]).toMatchObject({ status: 'unverified' }); expect(w.store.committed('markFactorVerified')).toHaveLength(0);
    expect((await w.gw.mfaListFactors(w.store.byId(w.store.sessions.values().next().value!.sessionId)!.accessToken)).filter((f) => f.status === 'verified')).toHaveLength(1);   // GoTrue: verified
    const l2 = await a.loginStaff(a.password);
    expect(l2.body.session.state).toBe('mfa_enrolment_required'); expect(a.contextReads.at(-1)).toMatchObject({ hasVerifiedFactor: false });
    const s2 = await a.call(a.startH, { token: l2.body.session_token, body: {} });
    expect(s2.body.secret_base32).not.toBe(s1.body.secret_base32); expect(w.calls.filter((x) => x.method === 'adminDeleteFactor')).toHaveLength(1);   // the old factor was deleted at GoTrue
    expect(w.store.committed('removeFactor')).toHaveLength(1);
  }, 30_000);
});

// ---------- the SQL and the repo, read against the TypeScript (per query: how NULL tenant_id is matched) ----------
const ROOT = fileURLToPath(new URL('../../../../../../../', import.meta.url));
const migration = (f: string) => readFileSync(`${ROOT}db/migrations/${f}`, 'utf8');
const fnBody = (sql: string, name: string) => { const i = sql.indexOf(`FUNCTION ${name}(`); expect(i, `${name} present`).toBeGreaterThan(-1); const j = sql.indexOf('END $$;', i); return sql.slice(i, j); };
const squash = (s: string) => s.replace(/\s+/g, ' ');

describe('SQL read against TypeScript: NULL tenant_id matching of every factor query (AUTH-MFA-PERSIST-1)', () => {
  it('app.identity_login_context (20261105000800): factor EXISTS uses tenant_id IS NOT DISTINCT FROM the chosen tenant (NULL for platform-only), never "="', () => {
    const body = squash(fnBody(migration('20261105000800_app__create_identity_definers.sql'), 'app.identity_login_context'));
    expect(body).toMatch(/FROM identity\.mfa_factors f WHERE f\.user_id = p_user_id AND f\.status = 'verified' AND f\.tenant_id IS NOT DISTINCT FROM v_one\.tenant_id/);
    expect(body).not.toMatch(/f\.tenant_id = v_one\.tenant_id/);
    expect(body).toMatch(/set_config\('app\.pre_tenant_id', coalesce\(v_one\.tenant_id::text, ''\), true\)/);   // '' (NULL) when the user has no user membership
  });
  it('policy mfa_factors__select__owner_only (20261105001300) matches the same way: tenant_id IS NOT DISTINCT FROM nullif(app.pre_tenant_id, \'\')', () => {
    const p = squash(migration('20261105001300_identity__create_identity_schema.sql'));
    expect(p).toContain("CREATE POLICY mfa_factors__select__owner_only ON identity.mfa_factors FOR SELECT TO lims_owner USING (user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid AND tenant_id IS NOT DISTINCT FROM nullif(current_setting('app.pre_tenant_id', true), '')::uuid)");
  });
  it('app.identity_platform_auth_read_mfa_factors (20261115156000): tenant-less factors only, f.tenant_id IS NULL, pre_tenant_id = \'\', removed rows excluded', () => {
    const body = squash(fnBody(migration('20261115156000_identity__add_platform_mfa_read_definers.sql'), 'app.identity_platform_auth_read_mfa_factors'));
    expect(body).toMatch(/WHERE f\.tenant_id IS NULL AND f\.user_id = p_user_id AND f\.status <> 'removed'/); expect(body).toContain("set_config('app.pre_tenant_id', '', true)"); expect(body).not.toMatch(/tenant_id = NULL/);
  });
  it('app.identity_platform_auth_write_mfa_factor (20261105000800): insert only with tenant_id NULL; update matches f.tenant_id IS NULL', () => {
    const body = squash(fnBody(migration('20261105000800_app__create_identity_definers.sql'), 'app.identity_platform_auth_write_mfa_factor'));
    expect(body).toContain('IF v.tenant_id IS NOT NULL OR v.user_id IS DISTINCT FROM p_user_id THEN'); expect(body).toMatch(/WHERE f\.id = p_factor_id AND f\.user_id = p_user_id AND f\.tenant_id IS NULL FOR UPDATE/);
  });

  // The repo: which SQL each account type reaches (a query with `= NULL` would never match; the repo must never send NULL to a `=` predicate).
  const repo = () => { const seen: Array<{ sql: string; p: unknown[] }> = []; const tx = { query: vi.fn(async (sql: string, p: unknown[] = []) => { seen.push({ sql: squash(sql), p }); return { rows: sql.includes('mfa_factors') || sql.includes('app.identity_platform_auth_read_mfa_factors') ? [{ id: idN(9), gotrue_factor_id: idN(8), status: 'verified', verified_at: new Date(), friendly_name: null }] : [{ n: 1, id: idN(9) }] }; }) };
    return { r: createMfaRepo({ seal: () => ({ keyId: 'k1', enc: Buffer.alloc(40) }), open: () => '' }), tx, seen }; };
  const USER = idN(0x77);
  it('factors(): platform-only (tenantId null) reads through the DEFINER with the user id only; tenant reads FACTORS_SQL with IS NOT DISTINCT FROM and a non-null tenant', async () => {
    const { r, tx, seen } = repo();
    expect(await r.factors(tx as any, { tenantId: null, userId: USER })).toMatchObject([{ status: 'verified' }]);
    expect(seen[0]).toMatchObject({ p: [USER] }); expect(seen[0]!.sql).toContain('app.identity_platform_auth_read_mfa_factors($1::uuid)');
    await r.factors(tx as any, { tenantId: TENANT_A, userId: USER });
    expect(seen[1]!.p).toEqual([TENANT_A, USER]); expect(seen[1]!.sql).toContain('WHERE tenant_id IS NOT DISTINCT FROM $1 AND user_id = $2 AND status <> \'removed\'');
  });
  it('markFactorVerified(): tenant -> FACTOR_VERIFY_SQL with "tenant_id = $1" and a NON-null tenant; platform (null) -> the DEFINER, never an "= NULL" predicate', async () => {
    const { r, tx, seen } = repo(); const at = new Date('2026-11-16T00:00:00Z');
    await r.markFactorVerified(tx as any, { id: idN(9), tenantId: TENANT_A, userId: USER, at, actorId: SYSTEM_ACTOR });
    expect(seen[0]!.sql).toContain("WHERE tenant_id = $1 AND id = $2 AND user_id = $3 AND status = 'unverified'"); expect(seen[0]!.p[0]).toBe(TENANT_A);
    await r.markFactorVerified(tx as any, { id: idN(9), tenantId: null, userId: USER, at, actorId: SYSTEM_ACTOR });
    expect(seen[1]!.sql).toContain('app.identity_platform_auth_write_mfa_factor($1::uuid, $2::uuid, $3::jsonb)'); expect(seen[1]!.sql).not.toContain('tenant_id = $1');
    expect(seen[1]!.p.slice(0, 2)).toEqual([USER, idN(9)]); expect(JSON.parse(seen[1]!.p[2] as string)).toMatchObject({ status: 'verified', verified_at: at.toISOString() });
    expect(seen.every((q) => !/= NULL/i.test(q.sql))).toBe(true);
  });
  it('insertFactor(): platform row is written with tenant_id null and status unverified through the DEFINER; tenant row with the tenant id', async () => {
    const { r, tx, seen } = repo();
    await r.insertFactor(tx as any, { id: idN(9), tenantId: null, userId: USER, gotrueFactorId: idN(8), friendlyName: null, actorId: SYSTEM_ACTOR });
    expect(JSON.parse(seen[0]!.p[2] as string)).toMatchObject({ tenant_id: null, user_id: USER, status: 'unverified', factor_type: 'totp' });
    await r.insertFactor(tx as any, { id: idN(10), tenantId: TENANT_A, userId: USER, gotrueFactorId: idN(8), friendlyName: 'x', actorId: SYSTEM_ACTOR });
    expect(seen[1]!.p.slice(0, 3)).toEqual([idN(10), TENANT_A, USER]);
  });
  void MEMB_A; void sha256;
});
