// SESSION-ACTOR-1 (LD-208): repo.sessionActor on the auth repo (auth-events.repo.ts) AND the session repo (mfa.repo.ts, the SessionRepo of session.service).
// Seam: sessionActor(tx, { userId, tenantId: string|null, membershipId: string|null }) -> the one row of app.identity_session_actor { display_name, role_codes, tenant_code } | undefined.
// One parameterised call through the DEFINER only (no SELECT on identity.platform_staff / core.* from TypeScript), never a write. Live behaviour of the function is pgTAP
// (db/tests/identity/SESSION-ACTOR-1_session_actor.test.sql). Expected now: fails - sessionActor does not exist on either repo.
import { describe, expect, it, vi } from 'vitest';
import { createAuthRepo } from '../auth-events.repo.js';
import { createMfaRepo } from '../mfa.repo.js';
import { idN } from '../../service/__tests__/auth.helpers.js';

const seal = () => ({ keyId: 'k1', enc: Buffer.alloc(40) });
const open = () => '';
const repos: Array<[string, () => any]> = [['createAuthRepo', () => createAuthRepo({ seal })], ['createMfaRepo (session repo)', () => createMfaRepo({ seal, open } as any)]];
const tx = (rows: unknown[] = []) => { const query = vi.fn(async (_t: string, _v?: unknown[]) => ({ rows })); return { query } as any; };
const ROW = { display_name: 'Ana Demo', role_codes: ['admin', 'lab_manager'], tenant_code: 'lab_a' };
const U = idN(0xa300), T = idN(0xa1), M = idN(0xb1);

describe.each(repos)('%s.sessionActor', (_name, make) => {
  it('tenant: ONE query to app.identity_session_actor($1::uuid, $2::uuid, $3::uuid) with [userId, tenantId, membershipId]; returns the row as-is', async () => {
    const t = tx([ROW]); const out = await make().sessionActor(t, { userId: U, tenantId: T, membershipId: M });
    expect(t.query).toHaveBeenCalledTimes(1);
    const [sql, vals] = t.query.mock.calls[0]!;
    expect(sql).toMatch(/app\.identity_session_actor\s*\(\s*\$1(::uuid)?\s*,\s*\$2(::uuid)?\s*,\s*\$3(::uuid)?\s*\)/i);
    expect(vals).toEqual([U, T, M]);
    expect(out).toEqual(ROW);
  });
  it('platform: tenantId and membershipId travel as NULL (null, not "" and not undefined)', async () => {
    const t = tx([{ display_name: 'Sam Staff', role_codes: ['platform_support'], tenant_code: null }]); await make().sessionActor(t, { userId: U, tenantId: null, membershipId: null });
    expect(t.query.mock.calls[0]![1]).toEqual([U, null, null]);
  });
  it('no row -> undefined (the service decides: common.internal); never throws for an empty result', async () => {
    expect(await make().sessionActor(tx([]), { userId: U, tenantId: T, membershipId: M })).toBeUndefined();
  });
  it('only the DEFINER is used: no INSERT / UPDATE / DELETE, no direct read of identity.* or core.* tables; ids only ever as bind parameters', async () => {
    const t = tx([ROW]); await make().sessionActor(t, { userId: `${U}'; DROP TABLE core.users;--`, tenantId: T, membershipId: M });
    const sql = String(t.query.mock.calls[0]![0]);
    expect(sql).not.toMatch(/\b(insert|update|delete|truncate)\b/i); expect(sql).not.toMatch(/\b(from|join)\s+(identity|core)\./i); expect(sql).not.toContain('DROP TABLE');
  });
  it('a database error is not swallowed', async () => {
    const t = { query: vi.fn(async () => { throw new Error('connection reset'); }) } as any;
    await expect(make().sessionActor(t, { userId: U, tenantId: T, membershipId: M })).rejects.toThrow('connection reset');
  });
});
