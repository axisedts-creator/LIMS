// T9 / LD-99 / 08 A38-1: repository/mfa.repo.ts platform branches of revokeOtherSessions and acceptInvitation call the two new DEFINERs
// (app.identity_platform_auth_write_revoke_other_sessions(user, except, reason) -> uuid[]; ..._invitation_accept_by_user(user) -> integer) instead of failing closed.
// Seam: the DEFINER result comes back as ONE row whose (any-named) column holds the uuid[] / the integer (the tests answer for every column name).
// Tenant branches are untouched; any other error still fails closed. New file; mfa.repo.test.ts is not edited. Expected now: platform tests fail (repo throws common.internal).
import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { sealerFromEnv } from '../auth-events.repo.js';
import { createMfaRepo, openerFromEnv } from '../mfa.repo.js';

const U = '0190a000-0000-7000-8000-0000000000d1', S = '0190a000-0000-7000-8000-0000000000e2', T = '0190a000-0000-7000-8000-0000000000a1', M = '0190a000-0000-7000-8000-0000000000b1',
  A = '0190a000-0000-7000-8000-000000000001', X1 = '0190a000-0000-7000-8000-0000000000c1', X2 = '0190a000-0000-7000-8000-0000000000c2';
const ENV = { LIMS_IDENTITY_TOKEN_ENC_KEYS: JSON.stringify({ k1: randomBytes(32).toString('base64') }) } as NodeJS.ProcessEnv;
const any = (v: unknown) => new Proxy({}, { get: (_t, k) => (typeof k === 'string' ? v : undefined), ownKeys: () => ['n'], getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: v }) });
function mk(rows: unknown[]) {
  const calls: Array<{ sql: string; p: any[] }> = [];
  const tx: any = { query: vi.fn(async (sql: string, p: any[] = []) => { calls.push({ sql, p }); return { rows, rowCount: rows.length }; }) };
  return { tx, calls, repo: createMfaRepo({ seal: sealerFromEnv(ENV), open: openerFromEnv(ENV) }) };
}
const revokeArgs = (tenantId: string | null) => ({ tenantId, userId: U, exceptSessionId: S, reason: 'password_change' as const, actorId: A });
const AT = new Date('2026-11-11T04:00:00.000Z');
const acceptArgs = (tenantId: string | null, membershipId: string | null) => ({ tenantId, membershipId, userId: U, at: AT, actorId: A });

describe('platform revokeOtherSessions -> app.identity_platform_auth_write_revoke_other_sessions', () => {
  it('one DEFINER call (user, except-session, reason), no direct UPDATE; returns [{sessionId, kind: platform}] for the returned ids', async () => {
    const { tx, calls, repo } = mk([any([X1, X2])]); const r = await repo.revokeOtherSessions(tx, revokeArgs(null));
    expect(calls).toHaveLength(1); expect(calls[0]!.sql).toMatch(/app\.identity_platform_auth_write_revoke_other_sessions/); expect(calls[0]!.sql).not.toMatch(/UPDATE\s+identity\.sessions/i);
    expect(calls[0]!.p).toEqual([U, S, 'password_change']);
    expect(r).toEqual([{ sessionId: X1, kind: 'platform' }, { sessionId: X2, kind: 'platform' }]);
  });
  it('an empty array is a valid result (nothing to revoke), not an error', async () => { const { tx, repo } = mk([any([])]); expect(await repo.revokeOtherSessions(tx, revokeArgs(null))).toEqual([]); });
  it('a DEFINER error (e.g. P0001 identity_platform_auth_write_invalid_input) fails closed: the call rejects', async () => {
    const tx: any = { query: vi.fn(async () => { throw Object.assign(new Error('identity_platform_auth_write_invalid_input'), { code: 'P0001' }); }) };
    await expect(createMfaRepo({ seal: sealerFromEnv(ENV), open: openerFromEnv(ENV) }).revokeOtherSessions(tx, revokeArgs(null))).rejects.toThrow();
  });
  it('the reason is passed as the literal password_change; the user id is the session user (never taken from elsewhere)', async () => {
    const { tx, calls, repo } = mk([any([])]); await repo.revokeOtherSessions(tx, revokeArgs(null)); expect(calls[0]!.p[0]).toBe(U); expect(calls[0]!.p[2]).toBe('password_change');
  });
  it('tenant branch unchanged: plain UPDATE under the bound tenant, no DEFINER', async () => {
    const { tx, calls, repo } = mk([{ id: X1, kind: 'tenant_staff' }]); const r = await repo.revokeOtherSessions(tx, revokeArgs(T));
    expect(calls).toHaveLength(1); expect(calls[0]!.sql).toMatch(/UPDATE\s+identity\.sessions/i); expect(calls[0]!.sql).not.toMatch(/identity_platform_auth_write/); expect(calls[0]!.p[0]).toBe(T); expect(r).toEqual([{ sessionId: X1, kind: 'tenant_staff' }]);
  });
});

describe('platform acceptInvitation -> app.identity_platform_auth_write_invitation_accept_by_user', () => {
  it('one DEFINER call with the user id only; no direct UPDATE; the two-argument invitation_accept is not used; count >= 1 -> true', async () => {
    const { tx, calls, repo } = mk([any(1)]); expect(await repo.acceptInvitation(tx, acceptArgs(null, null))).toBe(true);
    expect(calls).toHaveLength(1); expect(calls[0]!.sql).toMatch(/app\.identity_platform_auth_write_invitation_accept_by_user/); expect(calls[0]!.sql).not.toMatch(/invitation_accept\s*\(/);
    expect(calls[0]!.sql).not.toMatch(/UPDATE\s+identity\.invitations/i); expect(calls[0]!.p).toEqual([U]);
  });
  it('count 0 (no sent, unexpired platform invitation: a recovery) -> false, not an error', async () => { const { tx, repo } = mk([any(0)]); expect(await repo.acceptInvitation(tx, acceptArgs(null, null))).toBe(false); });
  it('a DEFINER error fails closed: the call rejects', async () => {
    const tx: any = { query: vi.fn(async () => { throw new Error('boom'); }) };
    await expect(createMfaRepo({ seal: sealerFromEnv(ENV), open: openerFromEnv(ENV) }).acceptInvitation(tx, acceptArgs(null, null))).rejects.toThrow();
  });
  it('tenant branch unchanged: INVITE_ACCEPT then membership activation under the bound tenant, no DEFINER', async () => {
    const { tx, calls, repo } = mk([{ id: X1 }]); expect(await repo.acceptInvitation(tx, acceptArgs(T, M))).toBe(true);
    expect(calls).toHaveLength(2); expect(calls.map((c) => c.sql).join('\n')).not.toMatch(/identity_platform_auth_write/); expect(calls[0]!.sql).toMatch(/UPDATE\s+identity\.invitations/i);
  });
  it('a tenant id without a membership id (malformed) is not a platform call: false with no query', async () => {
    const { tx, calls, repo } = mk([any(1)]); expect(await repo.acceptInvitation(tx, acceptArgs(T, null))).toBe(false); expect(calls).toHaveLength(0);
  });
});
