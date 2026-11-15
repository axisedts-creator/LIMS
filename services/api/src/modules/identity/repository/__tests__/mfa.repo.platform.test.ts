// AUTH-PLATFORM-SESSION-1 (LD-216, AUTH-SENSITIVE LD-189; 08 A12.1 app.pre_* GUCs, A28.1, A25 D-212/D-215): repository/mfa.repo.ts platform branches of
// loadSession and factors read through two additive READ DEFINERs instead of a plain SELECT (a plain SELECT under the identityAuthTx system claims
// sees 0 rows: FORCE RLS, owner-only policies need app.pre_user_id, which only a DEFINER sets - live evidence: startMfaEnrolment 401 auth.session_expired).
//   app.identity_platform_auth_load_session(p_user_id uuid, p_session_id uuid)  -> 0..1 row, the 14 columns LOAD_SQL selects (email = platform_staff.email_normalized)
//   app.identity_platform_auth_read_mfa_factors(p_user_id uuid)                 -> id, gotrue_factor_id, status, verified_at, friendly_name
// Seam: ONE parameterised statement per call, `... FROM app.<fn>($1::uuid, $2::uuid)` with params [userId, sessionId] / [userId]. Tenant branches stay as today.
// Live SQL behaviour = pgTAP db/tests/identity/AUTH-PLATFORM-SESSION-1_platform_reads.test.sql (NOT run in the lane). New file; no existing test is edited.
// Expected now: platform tests fail (repo still issues FROM identity.sessions / identity.mfa_factors); the migration + inventory static tests fail (files missing).
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { sealerFromEnv } from '../auth-events.repo.js';
import { createMfaRepo, openerFromEnv, type SessionRef } from '../mfa.repo.js';

const U = '0190a000-0000-7000-8000-0000000000d1', S = '0190a000-0000-7000-8000-0000000000e2', T = '0190a000-0000-7000-8000-0000000000a1',
  F1 = '0190a000-0000-7000-8000-0000000000f1', F2 = '0190a000-0000-7000-8000-0000000000f2', G1 = '0190a000-0000-7000-8000-0000000000a9', G2 = '0190a000-0000-7000-8000-0000000000b9';
const ENV = { LIMS_IDENTITY_TOKEN_ENC_KEYS: JSON.stringify({ k1: randomBytes(32).toString('base64') }) } as NodeJS.ProcessEnv;
const seal = sealerFromEnv(ENV);
const ACCESS = 'synthetic-access-token', REFRESH = 'synthetic-refresh-token';
const LOAD_FN = /app\.identity_platform_auth_load_session\s*\(/, FACTORS_FN = /app\.identity_platform_auth_read_mfa_factors\s*\(/;
const DIRECT = /identity\.(sessions|mfa_factors|platform_staff)\b|core\.(users|memberships|tenants)\b/i;   // any direct table read from TypeScript

function mk(rows: unknown[] | ((sql: string) => unknown[])) {
  const calls: Array<{ sql: string; p: any[] }> = [];
  const tx: any = { query: vi.fn(async (sql: string, p: any[] = []) => { calls.push({ sql, p }); const r = typeof rows === 'function' ? rows(sql) : rows; return { rows: r, rowCount: r.length }; }) };
  return { tx, calls, repo: createMfaRepo({ seal, open: openerFromEnv(ENV) }) };
}
const AT = new Date('2026-11-15T10:00:00.000Z'), IDLE = new Date('2026-11-15T10:20:00.000Z'), ABS = new Date('2026-11-15T20:00:00.000Z'), SEEN = new Date('2026-11-15T09:59:00.000Z');
function sessionRow(over: Record<string, unknown> = {}) {
  const a = seal(ACCESS), r = seal(REFRESH);
  return { aal: 'aal1', access_token_enc: a.enc, refresh_token_enc: r.enc, enc_key_id: a.keyId, mfa_failed_attempts: '2', access_expires_at: AT, idle_expires_at: IDLE,
    absolute_expires_at: ABS, email: '  Founder@Example.TEST ', state: 'active', last_seen_at: SEEN, idle_timeout_minutes: '20', app_instance_id: null, app_platform: null, ...over };
}
const platformRef: SessionRef = { sessionId: S, tenantId: null, userId: U, kind: 'platform' };
const tenantRef: SessionRef = { sessionId: S, tenantId: T, userId: U, kind: 'tenant_staff' };

describe('platform loadSession -> app.identity_platform_auth_load_session (DEFINER only)', () => {
  it('issues exactly ONE statement: the DEFINER with [userId, sessionId]; never a direct table text', async () => {
    const { tx, calls, repo } = mk([sessionRow()]); await repo.loadSession(tx, platformRef);
    expect(calls).toHaveLength(1); expect(calls[0]!.sql).toMatch(LOAD_FN); expect(calls[0]!.sql).not.toMatch(DIRECT); expect(calls[0]!.sql).not.toMatch(/FOR\s+UPDATE/i);
    expect(calls[0]!.p).toEqual([U, S]);
  });
  it('maps the columns exactly like the tenant path: Buffers unsealed through the opener, e-mail trimmed + NFC + lower-cased, numbers and dates', async () => {
    const { tx, repo } = mk([sessionRow()]); const s = await repo.loadSession(tx, platformRef);
    expect(s).toEqual({ aal: 'aal1', accessToken: ACCESS, refreshToken: REFRESH, mfaFailedAttempts: 2, email: 'founder@example.test', accessExpiresAt: AT, idleExpiresAt: IDLE,
      absoluteExpiresAt: ABS, state: 'active', lastSeenAt: SEEN, idleTimeoutMinutes: 20, membershipLocked: false, tenantStatus: null, appInstanceId: null, appPlatform: null });
  });
  it('an aal2 / revoked row is returned as stored (the service decides on state; the function never errors for it)', async () => {
    const { tx, repo } = mk([sessionRow({ aal: 'aal2', state: 'revoked' })]); const s = await repo.loadSession(tx, platformRef);
    expect(s).toMatchObject({ aal: 'aal2', state: 'revoked' });
  });
  it('no row (wrong user, other session, tenant session, unknown id: the function returns nothing) -> undefined, not an error', async () => {
    const { tx, calls, repo } = mk([]); expect(await repo.loadSession(tx, platformRef)).toBeUndefined(); expect(calls).toHaveLength(1);
  });
  it('a missing / non-string e-mail (no platform_staff row visible) maps to the empty string, like the tenant path', async () => {
    const { tx, repo } = mk([sessionRow({ email: null })]); expect((await repo.loadSession(tx, platformRef))!.email).toBe('');
  });
  it('NULL token columns map to empty strings (same rule as the tenant path); membershipLocked is false and tenantStatus null for a platform row', async () => {
    const { tx, repo } = mk([sessionRow({ access_token_enc: null, refresh_token_enc: null })]); const s = await repo.loadSession(tx, platformRef);
    expect(s).toMatchObject({ accessToken: '', refreshToken: '', membershipLocked: false, tenantStatus: null });
  });
  it('a DEFINER error propagates (fail closed): the call rejects, no fallback to a plain SELECT', async () => {
    const calls: string[] = []; const tx: any = { query: vi.fn(async (sql: string) => { calls.push(sql); throw Object.assign(new Error('boom'), { code: 'XX000' }); }) };
    await expect(createMfaRepo({ seal, open: openerFromEnv(ENV) }).loadSession(tx, platformRef)).rejects.toThrow('boom');
    expect(calls).toHaveLength(1); expect(calls[0]).toMatch(LOAD_FN);
  });
  it('an unknown enc_key_id fails closed with a LimsError that carries no key or token material', async () => {
    const { tx, repo } = mk([sessionRow({ enc_key_id: 'k-unknown' })]);
    const e = await repo.loadSession(tx, platformRef).then(() => undefined, (x) => x);
    expect(e).toBeInstanceOf(LimsError); expect(String(e.message)).not.toContain(ACCESS); expect(String(e.message)).not.toContain(REFRESH);
  });
  it('a platform kind with a tenant id is NOT a platform lookup: the DEFINER is never called for it (no cross-tenant widening)', async () => {
    const { tx, calls, repo } = mk([sessionRow()]); await repo.loadSession(tx, { ...platformRef, tenantId: T }).catch(() => undefined);
    expect(calls.filter((c) => LOAD_FN.test(c.sql))).toHaveLength(0);
  });
  it('the user id passed is the session user (ref.userId), the session id is ref.sessionId - nothing else is sent (no token, no e-mail)', async () => {
    const { tx, calls, repo } = mk([]); await repo.loadSession(tx, platformRef); expect(calls[0]!.p).toHaveLength(2); expect(calls[0]!.p).not.toContain(null);
  });
});

describe('platform factors -> app.identity_platform_auth_read_mfa_factors (DEFINER only)', () => {
  it('issues exactly ONE statement: the DEFINER with [userId]; never a direct table text', async () => {
    const { tx, calls, repo } = mk([]); await repo.factors(tx, { tenantId: null, userId: U });
    expect(calls).toHaveLength(1); expect(calls[0]!.sql).toMatch(FACTORS_FN); expect(calls[0]!.sql).not.toMatch(DIRECT); expect(calls[0]!.p).toEqual([U]);
  });
  it('maps id, gotrue_factor_id, status, verified_at, friendly_name (null defaults)', async () => {
    const { tx, repo } = mk([{ id: F1, gotrue_factor_id: G1, status: 'unverified', verified_at: null, friendly_name: null },
      { id: F2, gotrue_factor_id: G2, status: 'verified', verified_at: AT, friendly_name: 'Phone' }]);
    expect(await repo.factors(tx, { tenantId: null, userId: U })).toEqual([
      { id: F1, gotrueFactorId: G1, status: 'unverified', verifiedAt: null, friendlyName: null },
      { id: F2, gotrueFactorId: G2, status: 'verified', verifiedAt: AT, friendlyName: 'Phone' }]);
  });
  it('no factors -> an empty list', async () => { const { tx, repo } = mk([]); expect(await repo.factors(tx, { tenantId: null, userId: U })).toEqual([]); });
  it('a DEFINER error propagates (fail closed), no fallback to a plain SELECT', async () => {
    const calls: string[] = []; const tx: any = { query: vi.fn(async (sql: string) => { calls.push(sql); throw new Error('boom'); }) };
    await expect(createMfaRepo({ seal, open: openerFromEnv(ENV) }).factors(tx, { tenantId: null, userId: U })).rejects.toThrow('boom');
    expect(calls).toHaveLength(1); expect(calls[0]).toMatch(FACTORS_FN);
  });
});

describe('tenant branches unchanged (plain SQL under the bound tenant, no DEFINER)', () => {
  it('tenant loadSession: the old LOAD_SQL with [sessionId, userId, tenantId, kind], row lock FOR UPDATE OF s, joins unchanged', async () => {
    const { tx, calls, repo } = mk([sessionRow({ membership_locked: false, tenant_status: 'active' })]); const s = await repo.loadSession(tx, tenantRef);
    expect(calls).toHaveLength(1); expect(calls[0]!.p).toEqual([S, U, T, 'tenant_staff']);
    expect(calls[0]!.sql).toMatch(/FROM identity\.sessions s/); expect(calls[0]!.sql).toMatch(/FOR UPDATE OF s/); expect(calls[0]!.sql).toMatch(/LEFT JOIN core\.users u/);
    expect(calls[0]!.sql).toMatch(/LEFT JOIN core\.tenants t/); expect(calls[0]!.sql).not.toMatch(/identity_platform_auth/);
    expect(s).toMatchObject({ email: 'founder@example.test', tenantStatus: 'active', membershipLocked: false });
  });
  it('tenant loadSession with every other tenant-bound kind (partner, patient, staff_mobile) still uses the plain SQL', async () => {
    for (const kind of ['partner', 'patient', 'staff_mobile']) {
      const { tx, calls, repo } = mk([]); await repo.loadSession(tx, { ...tenantRef, kind }); expect(calls[0]!.sql).toMatch(/FROM identity\.sessions s/); expect(calls[0]!.sql).not.toMatch(/identity_platform_auth/);
    }
  });
  it('tenant factors: the old SELECT with [tenantId, userId], status <> removed filter, no DEFINER', async () => {
    const { tx, calls, repo } = mk([{ id: F2, gotrue_factor_id: G2, status: 'verified', verified_at: AT, friendly_name: null }]);
    expect(await repo.factors(tx, { tenantId: T, userId: U })).toEqual([{ id: F2, gotrueFactorId: G2, status: 'verified', verifiedAt: AT, friendlyName: null }]);
    expect(calls).toHaveLength(1); expect(calls[0]!.p).toEqual([T, U]); expect(calls[0]!.sql).toMatch(/FROM identity\.mfa_factors/); expect(calls[0]!.sql).toMatch(/status <> 'removed'/);
    expect(calls[0]!.sql).not.toMatch(/identity_platform_auth/);
  });
});

// ---- static guards (run in the lane; the SQL itself is NOT run there) ----
const ROOT = fileURLToPath(new URL('../../../../../../../', import.meta.url));
const MIGRATION = `${ROOT}db/migrations/20261115156000_identity__add_platform_mfa_read_definers.sql`;
const read = (p: string) => readFileSync(p, 'utf8');
describe('migration 20261115156000_identity__add_platform_mfa_read_definers.sql (static; NOT executed in the lane)', () => {
  it('exists', () => { expect(existsSync(MIGRATION)).toBe(true); });
  const sql = () => (existsSync(MIGRATION) ? read(MIGRATION) : '');
  const noComments = () => sql().replace(/--[^\n]*/g, '');
  it('creates exactly the two functions, plpgsql SECURITY DEFINER, SET search_path = \'\'', () => {
    const s = noComments();
    expect([...s.matchAll(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+(\S+?)\s*\(/gi)].map((m) => m[2])).toEqual(['app.identity_platform_auth_load_session', 'app.identity_platform_auth_read_mfa_factors']);
    expect((s.match(/SECURITY\s+DEFINER/gi) ?? []).length).toBe(2); expect((s.match(/SET\s+search_path\s*=\s*''/gi) ?? []).length).toBe(2); expect((s.match(/LANGUAGE\s+plpgsql/gi) ?? []).length).toBe(2);
  });
  it('signatures: (uuid, uuid) and (uuid); load_session RETURNS TABLE with the 14 LOAD_SQL columns; factors RETURNS TABLE with the 5 factor columns', () => {
    const s = noComments();
    expect(s).toMatch(/app\.identity_platform_auth_load_session\s*\(\s*p_user_id\s+uuid\s*,\s*p_session_id\s+uuid\s*\)/i);
    expect(s).toMatch(/app\.identity_platform_auth_read_mfa_factors\s*\(\s*p_user_id\s+uuid\s*\)/i);
    for (const c of ['aal', 'access_token_enc', 'refresh_token_enc', 'enc_key_id', 'mfa_failed_attempts', 'access_expires_at', 'idle_expires_at', 'absolute_expires_at', 'email', 'state',
      'last_seen_at', 'idle_timeout_minutes', 'app_instance_id', 'app_platform']) expect(s).toMatch(new RegExp(`\\b${c}\\b`));
    for (const c of ['gotrue_factor_id', 'status', 'verified_at', 'friendly_name']) expect(s).toMatch(new RegExp(`\\b${c}\\b`));
  });
  it('load_session locks the row (FOR UPDATE) and is VOLATILE; platform + tenant-less predicate present', () => {
    const s = noComments(); expect(s).toMatch(/FOR\s+UPDATE/i); expect(s).toMatch(/VOLATILE/i);
    expect(s).toMatch(/kind\s*=\s*'platform'/); expect(s).toMatch(/tenant_id\s+IS\s+NULL/i);
  });
  it('sets app.pre_user_id (both) and app.pre_tenant_id (factors) and resets them to the empty string', () => {
    const s = noComments(); expect((s.match(/set_config\(\s*'app\.pre_user_id'\s*,\s*coalesce\(/gi) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((s.match(/set_config\(\s*'app\.pre_user_id'\s*,\s*''\s*,\s*true\s*\)/gi) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(s).toMatch(/set_config\(\s*'app\.pre_tenant_id'\s*,\s*''\s*,\s*true\s*\)/i);
  });
  it('is read-only and additive: no INSERT/UPDATE/DELETE/TRUNCATE, and no table, column, policy, RLS, trigger or table-grant statement', () => {
    const s = noComments(); expect(s.length).toBeGreaterThan(0);   // bodies are checked too
    expect(s).not.toMatch(/\b(INSERT\s+INTO|DELETE\s+FROM|TRUNCATE)\b/i); expect(s).not.toMatch(/\bUPDATE\s+[a-z_."]+\s+SET\b/i);
    expect(s).not.toMatch(/\b(CREATE|ALTER|DROP)\s+(TABLE|POLICY|TRIGGER|INDEX|VIEW|SCHEMA|ROLE|TYPE)\b/i); expect(s).not.toMatch(/\bALTER\s+FUNCTION\b/i);
    expect(s).not.toMatch(/(ENABLE|DISABLE|NO\s+FORCE|FORCE)\s+ROW\s+LEVEL\s+SECURITY/i); expect(s).not.toMatch(/\bGRANT\b[^;]*\bON\s+(TABLE\s+)?(identity|core)\./i);
    expect(s).not.toMatch(/\bBYPASSRLS\b/i);
  });
  it('EXECUTE: REVOKE from PUBLIC and GRANT to lims_api only (no other role, no PUBLIC, no anon / authenticated)', () => {
    const s = noComments(); const grants = [...s.matchAll(/GRANT\s+EXECUTE\s+ON\s+FUNCTION[^;]*?TO\s+([^;]+);/gi)].map((m) => m[1]!.trim());
    expect(grants.length).toBeGreaterThanOrEqual(1); for (const g of grants) expect(g).toBe('lims_api');
    expect(s).toMatch(/REVOKE\s+ALL\s+ON\s+FUNCTION[^;]*identity_platform_auth_load_session[^;]*FROM\s+PUBLIC/i);
    expect(s).toMatch(/REVOKE\s+ALL\s+ON\s+FUNCTION[^;]*identity_platform_auth_read_mfa_factors[^;]*FROM\s+PUBLIC/i);
    expect(s).toMatch(/identity_platform_auth_load_session\s*\(\s*uuid\s*,\s*uuid\s*\)/i); expect(s).toMatch(/identity_platform_auth_read_mfa_factors\s*\(\s*uuid\s*\)/i);
  });
  it('owner lims_owner (SET LOCAL ROLE lims_owner like the sibling migration, or an explicit OWNER TO) and cites LD-216 in a comment', () => {
    expect(sql()).toMatch(/SET\s+LOCAL\s+ROLE\s+lims_owner|OWNER\s+TO\s+lims_owner/i); expect(sql()).toMatch(/LD-216/);
  });
});

describe('db/meta/definer-inventory.yaml rows for the two functions (static; the equality test T0B-08_inventory.test.sql is pgTAP, NOT run in the lane)', () => {
  const yaml = () => read(`${ROOT}db/meta/definer-inventory.yaml`);
  const row = (name: string) => { const m = yaml().match(new RegExp(`"${name.replace('.', '\\.')}"\\s*:\\s*\\{([\\s\\S]*?)\\n  \\}`)); return m ? m[1]! : ''; };
  for (const [fn, touches, policy] of [['app.identity_platform_auth_load_session', ['identity.sessions SELECT', 'identity.platform_staff SELECT'], ['sessions__select__owner_only', 'platform_staff__select__owner_only']],
    ['app.identity_platform_auth_read_mfa_factors', ['identity.mfa_factors SELECT'], ['mfa_factors__select__owner_only']]] as Array<[string, string[], string[]]>) {
    it(`${fn}: owner lims_owner, execute [lims_api] only, why, touches (SELECT only), policies`, () => {
      const r = row(fn); expect(r).not.toBe('');
      expect(r).toMatch(/"owner"\s*:\s*"lims_owner"/); expect(r).toMatch(/"execute"\s*:\s*\["lims_api"\]/); expect(r).toMatch(/"why"\s*:\s*"[^"]{10,}/);
      for (const t of touches) expect(r).toContain(`"${t}"`); for (const p of policy) expect(r).toContain(`"${p}"`);
      expect(r).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    });
  }
  it('the two rows are the only additions: keys unique and present exactly once', () => {
    for (const fn of ['app.identity_platform_auth_load_session', 'app.identity_platform_auth_read_mfa_factors']) expect(yaml().split(`"${fn}"`).length - 1).toBe(1);
  });
});

describe('scope guard: mfa.repo.ts keeps its write definers and the tenant SQL; the platform branches name the two read definers', () => {
  const src = () => read(fileURLToPath(new URL('../mfa.repo.ts', import.meta.url)));
  it('source names both read DEFINERs, once as a SQL constant each', () => {
    expect(src()).toMatch(/app\.identity_platform_auth_load_session/); expect(src()).toMatch(/app\.identity_platform_auth_read_mfa_factors/);
  });
  it('untouched: sessionByToken definer, the three write definers, tenant LOAD_SQL / FACTORS_SQL texts', () => {
    const s = src(); expect(s).toContain('app.identity_session_by_token($1)'); expect(s).toContain('app.identity_platform_auth_write_session_update($1::uuid, $2::uuid, $3::jsonb)');
    expect(s).toContain('app.identity_platform_auth_write_mfa_factor($1::uuid, $2::uuid, $3::jsonb)'); expect(s).toContain('FOR UPDATE OF s');
    expect(s).toContain("WHERE tenant_id IS NOT DISTINCT FROM $1 AND user_id = $2 AND status <> 'removed'");
  });
  it('recordPlatformEvent is NOT changed by this task (known second gap, non-blocking CR): still the plain INSERT INTO identity.platform_events', () => {
    expect(src()).toMatch(/INSERT INTO identity\.platform_events/);
  });
});
