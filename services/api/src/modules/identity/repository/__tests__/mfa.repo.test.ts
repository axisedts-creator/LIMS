// T7 repository/mfa.repo.ts: SQL shape + token sealing (05-SCHEMA s4.1/4.2/5.4, 08 A28.1, 07-SECURITY A-11). Seams: handlers/__tests__/mfa.helpers.ts header
// (createMfaRepo({seal?, open?}), openerFromEnv(env) = inverse of sealerFromEnv in auth-events.repo.ts; sealed value = iv(12)||tag(16)||ct, AAD = key id).
// tx.query is a recording fake; live-DB behaviour is NOT covered here (db/tests/identity pgTAP owns RLS). Expected now: fail (repository/mfa.repo.ts does not exist).
import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { sealerFromEnv } from '../auth-events.repo.js';
import { createMfaRepo, openerFromEnv } from '../mfa.repo.js';

const U = '0190a000-0000-7000-8000-0000000000d1', S = '0190a000-0000-7000-8000-0000000000e2', T = '0190a000-0000-7000-8000-0000000000a1', F = '0190a000-0000-7000-8000-0000000000f3', G = '0190a000-0000-7000-8000-0000000000f4', A = '0190a000-0000-7000-8000-000000000001';
const ACCESS = 'ACCESS-PLAIN-SENTINEL-1', REFRESH = 'REFRESH-PLAIN-SENTINEL-2';
const ENV = { LIMS_IDENTITY_TOKEN_ENC_KEYS: JSON.stringify({ k1: randomBytes(32).toString('base64'), k2: randomBytes(32).toString('base64') }) } as NodeJS.ProcessEnv;
const seal = sealerFromEnv(ENV); const open = openerFromEnv(ENV);
const AT = new Date('2026-11-11T04:00:00.000Z');
const SESSION_ALLOWED = ['state', 'aal', 'refresh_token_enc', 'access_token_enc', 'enc_key_id', 'access_expires_at', 'last_seen_at', 'idle_expires_at', 'mfa_failed_attempts', 'support_session_id', 'revoked_at', 'revoked_by', 'revoke_reason', 'updated_by'];
const FACTOR_ALLOWED = ['status', 'verified_at', 'removed_at', 'removed_by', 'removal_reason', 'friendly_name', 'is_active', 'updated_by'];

// DEFINER integer result: whatever column alias the writer reads comes back as n
const defn = (n: number) => new Proxy({ n }, { get: (t, k) => (typeof k === 'string' ? t.n : undefined), ownKeys: () => ['n'] });
function mk(rows: unknown[] = []) {
  const calls: Array<{ sql: string; p: any[] }> = [];
  const tx: any = { query: vi.fn(async (sql: string, p: any[] = []) => { calls.push({ sql, p }); return { rows, rowCount: rows.length }; }) };
  return { tx, calls, repo: createMfaRepo({ seal, open }) };
}
const flat = (p: any[]) => JSON.stringify(p, (_k, v) => (v && v.type === 'Buffer' ? Buffer.from(v.data).toString('hex') : v));
const noPlain = (calls: Array<{ sql: string; p: any[] }>) => { const h = JSON.stringify(calls); expect(h).not.toContain(ACCESS); expect(h).not.toContain(REFRESH); };
const ref = (platform = false) => ({ sessionId: S, tenantId: platform ? null : T, userId: U, kind: platform ? 'platform' : 'tenant_staff' });

describe('openerFromEnv: AES-256-GCM, AAD = key id', () => {
  it('round-trips what sealerFromEnv sealed (newest key), and the sealed bytes do not contain the plaintext', () => {
    const s = seal(ACCESS); expect(s.keyId).toBe('k2'); expect(s.enc.includes(Buffer.from(ACCESS))).toBe(false); expect(open(s.enc, s.keyId)).toBe(ACCESS);
  });
  it('an older key id still opens its own values (rotation)', () => {
    const old = sealerFromEnv({ LIMS_IDENTITY_TOKEN_ENC_KEYS: JSON.stringify({ k1: JSON.parse(ENV['LIMS_IDENTITY_TOKEN_ENC_KEYS']!).k1 }) } as NodeJS.ProcessEnv)(REFRESH);
    expect(old.keyId).toBe('k1'); expect(open(old.enc, 'k1')).toBe(REFRESH);
  });
  it('tampered ciphertext, tampered tag, wrong key id (AAD / key) and unknown key id all throw', () => {
    const s = seal(ACCESS); const bad = (i: number) => { const b = Buffer.from(s.enc); b[i] = b[i]! ^ 1; return b; };
    expect(() => open(bad(12), s.keyId)).toThrow(); expect(() => open(bad(s.enc.length - 1), s.keyId)).toThrow(); expect(() => open(s.enc, 'k1')).toThrow(); expect(() => open(s.enc, 'nope')).toThrow();
  });
  it('missing / malformed key env -> throws (fail closed), message carries no key material', () => {
    expect(() => openerFromEnv({} as NodeJS.ProcessEnv)(seal(ACCESS).enc, 'k2')).toThrow(); try { openerFromEnv({ LIMS_IDENTITY_TOKEN_ENC_KEYS: '{"k2":"AAAA"}' } as NodeJS.ProcessEnv)(seal(ACCESS).enc, 'k2'); } catch (e: any) { expect(String(e.message)).not.toMatch(/AAAA/); }
  });
});

describe('sessionByToken (DEFINER app.identity_session_by_token)', () => {
  it('calls the DEFINER with the 32-byte hash only and maps the row to camelCase', async () => {
    const { tx, calls, repo } = mk([{ session_id: S, kind: 'tenant_staff', state: 'mfa_pending', tenant_id: T, user_id: U, membership_id: A, platform_staff_id: null, support_session_id: null, token_reused: false }]);
    const sha = randomBytes(32); const r = await repo.sessionByToken(tx, sha);
    expect(calls).toHaveLength(1); expect(calls[0]!.sql).toMatch(/app\.identity_session_by_token\s*\(\s*\$1/); expect(Buffer.from(calls[0]!.p[0]).equals(sha)).toBe(true); expect(calls[0]!.p).toHaveLength(1);
    expect(r).toMatchObject({ sessionId: S, kind: 'tenant_staff', state: 'mfa_pending', tenantId: T, userId: U, membershipId: A, platformStaffId: null, tokenReused: false });
  });
  it('no row -> undefined', async () => { const { tx, repo } = mk([]); expect(await repo.sessionByToken(tx, randomBytes(32))).toBeUndefined(); });
  it('rejects a hash that is not 32 bytes before querying', async () => { const { tx, calls, repo } = mk(); await expect(repo.sessionByToken(tx, Buffer.alloc(31))).rejects.toThrow(); expect(calls).toHaveLength(0); });
});

describe('loadSession', () => {
  const row = () => { const a = seal(ACCESS), r = seal(REFRESH); return { access_token_enc: a.enc, refresh_token_enc: r.enc, enc_key_id: a.keyId, aal: 'aal1', mfa_failed_attempts: 3, email: 'Ana.Demo@Example.test', access_expires_at: AT, idle_expires_at: AT, absolute_expires_at: AT }; };
  it('returns UNSEALED tokens, attempts, normalised-source e-mail; row-locks the session (FOR UPDATE) scoped by session id AND user id', async () => {
    const { tx, calls, repo } = mk([row()]); const r = await repo.loadSession(tx, ref());
    expect(r).toMatchObject({ accessToken: ACCESS, refreshToken: REFRESH, aal: 'aal1', mfaFailedAttempts: 3 }); expect(typeof r!.email).toBe('string'); expect(r!.accessExpiresAt).toEqual(AT);
    expect(calls[0]!.sql).toMatch(/FOR UPDATE/i); expect(calls[0]!.sql).toMatch(/identity\.sessions/); expect(flat(calls[0]!.p)).toContain(S); expect(flat(calls[0]!.p)).toContain(U);
  });
  it('no row -> undefined', async () => { const { tx, repo } = mk([]); expect(await repo.loadSession(tx, ref())).toBeUndefined(); });
  it('a corrupt sealed value surfaces as an error, never as an empty token', async () => { const r = row(); r.access_token_enc = Buffer.alloc(40); const { tx, repo } = mk([r]); await expect(repo.loadSession(tx, ref())).rejects.toThrow(); });
});

describe('updateSession', () => {
  it('tenant: UPDATE identity.sessions bound by tenant id + session id; sealed tokens only; attempts and aal/state written; updated_by = actor', async () => {
    const { tx, calls, repo } = mk([{}]);
    await repo.updateSession(tx, ref(), { state: 'active', aal: 'aal2', accessToken: ACCESS, refreshToken: REFRESH, accessExpiresAt: AT, mfaFailedAttempts: 0, actorId: A });
    expect(calls).toHaveLength(1); const { sql, p } = calls[0]!; expect(sql).toMatch(/UPDATE\s+identity\.sessions/i); expect(sql).toMatch(/mfa_failed_attempts/); expect(sql).toMatch(/version\s*=\s*\S*version\s*\+\s*1/i);
    expect(flat(p)).toContain(S); expect(flat(p)).toContain(T); expect(flat(p)).toContain(A); expect(p).toContain('active'); expect(p).toContain('aal2'); noPlain(calls); expect(p.some((x) => Buffer.isBuffer(x))).toBe(true);
  });
  it('tenant, attempts only: a partial patch does not touch tokens/state (no sealing, no state in params)', async () => {
    const { tx, calls, repo } = mk([{}]); await repo.updateSession(tx, ref(), { mfaFailedAttempts: 2, actorId: A });
    expect(calls[0]!.p).toContain(2); expect(calls[0]!.p.some((x) => Buffer.isBuffer(x))).toBe(false); expect(calls[0]!.sql).not.toMatch(/access_token_enc|refresh_token_enc/); expect(calls[0]!.sql).not.toMatch(/\bstate\s*=/);
  });
  it('tenant revoke: state revoked + revoked_at + revoke_reason mfa_failed + revoked_by in ONE statement (sessions__revoke__ck pairs them)', async () => {
    const { tx, calls, repo } = mk([{}]); await repo.updateSession(tx, ref(), { mfaFailedAttempts: 5, revoked: { reason: 'mfa_failed' }, actorId: A });
    expect(calls).toHaveLength(1); const { sql, p } = calls[0]!; expect(sql).toMatch(/revoked_at/); expect(sql).toMatch(/revoke_reason/); expect(sql).toMatch(/\bstate\b/); expect(p).toContain('mfa_failed'); expect(p).toContain('revoked'); expect(p).toContain(5);
  });
  it('platform: only app.identity_platform_auth_write_session_update(user, session, jsonb) - keys inside the DEFINER allowlist, tokens sealed (bytea text form), no direct UPDATE', async () => {
    const { tx, calls, repo } = mk([defn(1)]);
    await repo.updateSession(tx, ref(true), { state: 'active', aal: 'aal2', accessToken: ACCESS, refreshToken: REFRESH, accessExpiresAt: AT, mfaFailedAttempts: 0, actorId: A });
    expect(calls).toHaveLength(1); const { sql, p } = calls[0]!; expect(sql).toMatch(/app\.identity_platform_auth_write_session_update/); expect(sql).not.toMatch(/UPDATE\s+identity\.sessions/i);
    expect(p[0]).toBe(U); expect(p[1]).toBe(S); const j = JSON.parse(p[2]); expect(Object.keys(j).filter((k) => !SESSION_ALLOWED.includes(k))).toEqual([]);
    expect(j).toMatchObject({ state: 'active', aal: 'aal2', mfa_failed_attempts: 0, updated_by: A }); expect(String(j.access_token_enc)).toMatch(/^\\x[0-9a-f]+$/); noPlain(calls);
  });
  it('platform revoke: revoked_at + revoke_reason mfa_failed + state revoked in the jsonb', async () => {
    const { tx, calls, repo } = mk([{}]); await repo.updateSession(tx, ref(true), { mfaFailedAttempts: 5, revoked: { reason: 'mfa_failed' }, actorId: A });
    const j = JSON.parse(calls[0]!.p[2]); expect(j).toMatchObject({ state: 'revoked', revoke_reason: 'mfa_failed', mfa_failed_attempts: 5 }); expect(j.revoked_at).toBeTruthy();
  });
  it('platform session that the DEFINER did not update (0 rows) -> throws (never a silent success on a failed state change)', async () => {
    const { tx, repo } = mk([defn(0)]); await expect(repo.updateSession(tx, ref(true), { state: 'active', actorId: A })).rejects.toThrow();
  });
  it('tenant session that matched 0 rows (rowCount 0 / no returned row) -> throws', async () => {
    const tx: any = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }; await expect(createMfaRepo({ seal, open }).updateSession(tx, ref(), { state: 'active', actorId: A })).rejects.toThrow();
  });
});

describe('factors / insertFactor / markFactorVerified / removeFactor', () => {
  it('factors tenant: identity.mfa_factors filtered by tenant_id, user_id, status <> removed; maps camelCase', async () => {
    const { tx, calls, repo } = mk([{ id: F, gotrue_factor_id: G, status: 'verified', verified_at: AT, friendly_name: 'Work' }]); const r = await repo.factors(tx, { tenantId: T, userId: U });
    expect(calls[0]!.sql).toMatch(/identity\.mfa_factors/); expect(calls[0]!.sql).toMatch(/removed/); expect(flat(calls[0]!.p)).toContain(T); expect(flat(calls[0]!.p)).toContain(U);
    expect(r).toEqual([{ id: F, gotrueFactorId: G, status: 'verified', verifiedAt: AT, friendlyName: 'Work' }]);
  });
  it('factors platform (tenantId null): the query matches tenant_id IS NULL (not "= NULL") for that user', async () => {
    const { tx, calls, repo } = mk([]); await repo.factors(tx, { tenantId: null, userId: U }); expect(calls[0]!.sql).toMatch(/tenant_id\s+IS\s+(NOT\s+DISTINCT\s+FROM|NULL)/i); expect(calls[0]!.sql).not.toMatch(/tenant_id\s*=\s*\$\d[^)]*NULL/i);
  });
  it('insertFactor tenant: INSERT INTO identity.mfa_factors status unverified, factor_type totp, created_by/updated_by = actor; no secret column', async () => {
    const { tx, calls, repo } = mk([{}]); await repo.insertFactor(tx, { id: F, tenantId: T, userId: U, gotrueFactorId: G, friendlyName: 'Work', actorId: A });
    expect(calls[0]!.sql).toMatch(/INSERT\s+INTO\s+identity\.mfa_factors/i); expect(calls[0]!.sql).not.toMatch(/secret|otpauth/i); expect(calls[0]!.sql).toMatch(/unverified/); expect(flat(calls[0]!.p)).toContain(F); expect(flat(calls[0]!.p)).toContain(G); expect(flat(calls[0]!.p)).toContain(A);
  });
  it('insertFactor platform: app.identity_platform_auth_write_mfa_factor(user, NULL, row) with tenant_id null and status unverified; no direct INSERT', async () => {
    const { tx, calls, repo } = mk([defn(1)]); await repo.insertFactor(tx, { id: F, tenantId: null, userId: U, gotrueFactorId: G, friendlyName: null, actorId: A });
    const { sql, p } = calls[0]!; expect(sql).toMatch(/app\.identity_platform_auth_write_mfa_factor/); expect(sql).not.toMatch(/INSERT\s+INTO\s+identity\.mfa_factors/i); expect(p[0]).toBe(U); expect(p[1]).toBeNull();
    const j = JSON.parse(p[2]); expect(j).toMatchObject({ id: F, tenant_id: null, user_id: U, gotrue_factor_id: G, factor_type: 'totp', status: 'unverified', created_by: A, updated_by: A }); expect(j.is_active).toBe(true); expect(j.version).toBe(1);
  });
  it('markFactorVerified tenant: UPDATE identity.mfa_factors SET status verified, verified_at, version+1 WHERE tenant_id/id/user_id', async () => {
    const { tx, calls, repo } = mk([{}]); await repo.markFactorVerified(tx, { id: F, tenantId: T, userId: U, at: AT, actorId: A });
    expect(calls[0]!.sql).toMatch(/UPDATE\s+identity\.mfa_factors/i); expect(calls[0]!.sql).toMatch(/version\s*=\s*\S*version\s*\+\s*1/i); expect(calls[0]!.p).toContain('verified'); expect(flat(calls[0]!.p)).toContain(F); expect(flat(calls[0]!.p)).toContain(T);
  });
  it('markFactorVerified platform: DEFINER (user, factor id, jsonb ⊆ allowlist with status verified + verified_at)', async () => {
    const { tx, calls, repo } = mk([defn(1)]); await repo.markFactorVerified(tx, { id: F, tenantId: null, userId: U, at: AT, actorId: A });
    const { sql, p } = calls[0]!; expect(sql).toMatch(/app\.identity_platform_auth_write_mfa_factor/); expect(p[0]).toBe(U); expect(p[1]).toBe(F); const j = JSON.parse(p[2]);
    expect(Object.keys(j).filter((k) => !FACTOR_ALLOWED.includes(k))).toEqual([]); expect(j).toMatchObject({ status: 'verified' }); expect(j.verified_at).toBeTruthy();
  });
  it('removeFactor platform / tenant: status removed + removal_reason re_enrol + removed_at (mfa_factors__removal__ck), rows kept (no DELETE)', async () => {
    for (const tenantId of [T, null]) {
      const { tx, calls, repo } = mk([defn(1)]); await repo.removeFactor(tx, { id: F, tenantId, userId: U, reason: 're_enrol', at: AT, actorId: A });
      const all = flat(calls[0]!.p) + calls[0]!.sql; expect(all).toContain('removed'); expect(all).toContain('re_enrol'); expect(calls[0]!.sql).not.toMatch(/DELETE\s+FROM/i);
      if (tenantId === null) expect(Object.keys(JSON.parse(calls[0]!.p[2])).filter((k) => !FACTOR_ALLOWED.includes(k))).toEqual([]);
    }
  });
  it('a factor write that changed 0 rows (platform DEFINER returns 0) -> throws', async () => {
    const { tx, repo } = mk([defn(0)]); await expect(repo.markFactorVerified(tx, { id: F, tenantId: null, userId: U, at: AT, actorId: A })).rejects.toThrow();
  });
});

describe('touchMembershipLogin / enqueue / recordPlatformEvent', () => {
  it('touchMembershipLogin: UPDATE core.memberships SET last_login_at only (never is_active), by tenant + membership id', async () => {
    const { tx, calls, repo } = mk([{}]); await repo.touchMembershipLogin(tx, { tenantId: T, membershipId: A, at: AT, actorId: A });
    expect(calls[0]!.sql).toMatch(/UPDATE\s+core\.memberships\s+SET\s+last_login_at/i); expect(calls[0]!.sql).not.toMatch(/is_active/i); expect(flat(calls[0]!.p)).toContain(T); expect(flat(calls[0]!.p)).toContain(A);
  });
  it('enqueue: app.enqueue_job(identifier, jsonb payload, job_key) parameterised', async () => {
    const { tx, calls, repo } = mk([{}]); await repo.enqueue(tx, 'identity.gotrue_signout', { user_id: U }, `signout:${U}:mfa_failed`);
    expect(calls[0]!.sql).toMatch(/app\.enqueue_job/); expect(calls[0]!.p[0]).toBe('identity.gotrue_signout'); expect(JSON.parse(calls[0]!.p[1])).toEqual({ user_id: U }); expect(calls[0]!.p[2]).toBe(`signout:${U}:mfa_failed`);
  });
  it('recordPlatformEvent: INSERT INTO identity.platform_events with event_type platform_mfa_enrolled, target platform_staff, actor staff id, request id, ip, detail jsonb', async () => {
    const { tx, calls, repo } = mk([{}]); await repo.recordPlatformEvent(tx, { id: F, eventType: 'platform_mfa_enrolled', targetType: 'platform_staff', targetId: S, actorPlatformStaffId: S, detail: {}, requestId: T, clientIp: '203.0.113.9', actorId: A });
    expect(calls[0]!.sql).toMatch(/INSERT\s+INTO\s+identity\.platform_events/i); expect(calls[0]!.p).toContain('platform_mfa_enrolled'); expect(calls[0]!.p).toContain('platform_staff'); expect(flat(calls[0]!.p)).toContain(S); expect(flat(calls[0]!.p)).toContain('203.0.113.9');
  });
  it.each(['sessionByToken', 'loadSession', 'updateSession', 'factors', 'insertFactor', 'markFactorVerified', 'removeFactor', 'touchMembershipLogin', 'enqueue', 'recordPlatformEvent'])('%s is exported on the repo (seam present)', (m) => {
    expect(typeof (createMfaRepo({ seal, open }) as any)[m]).toBe('function');
  });
});
