// T0B-ACTIVATE-1 / LD-299: repository/mfa.repo.ts acceptInvitation (tenant branch) accepts an invitation in status `sent` ONLY (expiry still checked).
// Review ruling: 03-APP-FLOW §2.6 lists the single accept edge `sent -> accepted` and M2 requires "invitation `sent`, not expired"; domain/invitation.state.ts agrees
// (pending -> sent|failed|revoked). A `pending` invitation is refused; accepting it is raised as a blocking CR (.orchestra/cr/T0B-ACTIVATE-1.nonblocking.md).
// The worker task identity.send_invitation moves pending -> sent; until then staging needs the worker (or the founder SQL workaround).
// The fake tx below EXECUTES the status predicate it finds in the statement text against in-memory rows, so the test fails for the right reason (the SQL), not for a string.
// Finding for the writer (asked in the brief): today the membership activation does NOT run when the invitation update finds no row (acceptInvitation returns false first).
// That stays: an expired or already used invitation must never activate a membership. Platform branch (tenantId null) is untouched: see mfa.repo.platform-password.test.ts.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sealerFromEnv } from '../auth-events.repo.js';
import { createMfaRepo, openerFromEnv } from '../mfa.repo.js';

const T = '0190a000-0000-7000-8000-0000000000a1', M = '0190a000-0000-7000-8000-0000000000b1', U = '0190a000-0000-7000-8000-0000000000d1',
  A = '0190a000-0000-7000-8000-000000000001', OTHER_M = '0190a000-0000-7000-8000-0000000000b2', OTHER_T = '0190a000-0000-7000-8000-0000000000a2';
const ENV = { LIMS_IDENTITY_TOKEN_ENC_KEYS: JSON.stringify({ k1: randomBytes(32).toString('base64') }) } as NodeJS.ProcessEnv;
const AT = new Date('2026-11-17T04:00:00.000Z');
const HOUR = 3_600_000;

interface Inv { tenant_id: string; membership_id: string; user_id: string; status: string; expires_at: Date; accepted_at: Date | null }
interface Mem { tenant_id: string; id: string; status: string; accepted_at: Date | null }

/** statuses named by the statement's own `status = 'x'` / `status IN ('x', 'y')` predicate (the SET clause `status = 'accepted'` is skipped) */
function statuses(sql: string): string[] {
  const where = sql.slice(sql.search(/\bWHERE\b/i));
  const eq = /\bstatus\s*=\s*'(\w+)'/i.exec(where); if (eq) return [eq[1]!];
  const inn = /\bstatus\s+IN\s*\(([^)]*)\)/i.exec(where); return inn ? [...inn[1]!.matchAll(/'(\w+)'/g)].map((m) => m[1]!) : [];
}
function world(inv: Partial<Inv>[] = [], mem: Partial<Mem>[] = [{}]) {
  const invs: Inv[] = inv.map((i) => ({ tenant_id: T, membership_id: M, user_id: U, status: 'sent', expires_at: new Date(AT.getTime() + HOUR), accepted_at: null, ...i }));
  const mems: Mem[] = mem.map((m) => ({ tenant_id: T, id: M, status: 'invited', accepted_at: null, ...m }));
  const calls: Array<{ sql: string; p: any[] }> = [];
  const tx: any = {
    async query(sql: string, p: any[] = []) {
      calls.push({ sql, p });
      if (/UPDATE\s+identity\.invitations/i.test(sql)) {
        const ok = statuses(sql); const hit = invs.filter((r) => r.tenant_id === p[0] && r.membership_id === p[1] && r.user_id === p[2] && ok.includes(r.status) && r.expires_at.getTime() > (p[3] as Date).getTime());
        for (const r of hit) { r.status = 'accepted'; r.accepted_at = p[3]; }
        return { rows: hit.map(() => ({ id: 'x' })), rowCount: hit.length };
      }
      if (/UPDATE\s+core\.memberships/i.test(sql)) {
        const ok = statuses(sql); const hit = mems.filter((r) => r.tenant_id === p[0] && r.id === p[1] && ok.includes(r.status));
        for (const r of hit) { r.status = 'active'; r.accepted_at = p[2]; }
        return { rows: hit.map(() => ({ id: 'x' })), rowCount: hit.length };
      }
      throw new Error(`unexpected statement: ${sql.slice(0, 60)}`);
    },
  };
  return { tx, calls, invs, mems, repo: createMfaRepo({ seal: sealerFromEnv(ENV), open: openerFromEnv(ENV) }) };
}
const accept = (w: ReturnType<typeof world>, o: Partial<{ tenantId: string; membershipId: string; userId: string }> = {}) =>
  w.repo.acceptInvitation(w.tx, { tenantId: T, membershipId: M, userId: U, at: AT, actorId: A, ...o });

describe('acceptInvitation (tenant): which invitations are accepted', () => {
  it('an unexpired sent invitation -> true; invitation accepted with accepted_at = at; membership invited -> active with accepted_at = at', async () => {
    const w = world([{ status: 'sent' }]);
    expect(await accept(w)).toBe(true);
    expect(w.invs[0]).toMatchObject({ status: 'accepted', accepted_at: AT });
    expect(w.mems[0]).toMatchObject({ status: 'active', accepted_at: AT });
  });
  it('an unexpired PENDING invitation (worker has not sent it) -> false; invitation stays pending, membership stays invited, no membership update is issued', async () => {
    const w = world([{ status: 'pending' }]);
    expect(await accept(w)).toBe(false);
    expect(w.invs[0]).toMatchObject({ status: 'pending', accepted_at: null });
    expect(w.mems[0]).toMatchObject({ status: 'invited', accepted_at: null });
    expect(w.calls.filter((c) => /UPDATE\s+core\.memberships/i.test(c.sql))).toHaveLength(0);
  });
  it('an EXPIRED sent invitation (expires_at <= at) -> false; the invitation and the membership are not touched', async () => {
    for (const expires_at of [new Date(AT.getTime() - 1000), new Date(AT.getTime())]) {
      const w = world([{ status: 'sent', expires_at }]);
      expect(await accept(w)).toBe(false);
      expect(w.invs[0]!.status).toBe('sent'); expect(w.mems[0]).toMatchObject({ status: 'invited', accepted_at: null });
    }
  });
  it.each(['accepted', 'revoked', 'expired', 'superseded'])('an invitation already %s is never accepted again and never activates the membership', async (status) => {
    const w = world([{ status }]);
    expect(await accept(w)).toBe(false);
    expect(w.invs[0]!.status).toBe(status); expect(w.mems[0]!.status).toBe('invited');
  });
  it('NO invitation row at all -> false and NO membership update is issued (activation only follows an accepted invitation)', async () => {
    const w = world([]);
    expect(await accept(w)).toBe(false);
    expect(w.calls.filter((c) => /UPDATE\s+core\.memberships/i.test(c.sql))).toHaveLength(0);
  });
  it('the membership update still only moves an INVITED membership (a deactivated membership is never reactivated by an invitation)', async () => {
    const w = world([{ status: 'sent' }], [{ status: 'deactivated' }]);
    await accept(w);
    expect(w.mems[0]).toMatchObject({ status: 'deactivated', accepted_at: null });
  });
});

describe('acceptInvitation (tenant): scoping and statement shape (security)', () => {
  it('only the invitation of THIS tenant, membership and user: another membership, another tenant or another user is not accepted', async () => {
    const mine = { status: 'sent' }; const w = world([mine, { ...mine, membership_id: OTHER_M }, { ...mine, tenant_id: OTHER_T }, { ...mine, user_id: A }], [{}, { id: OTHER_M }]);
    expect(await accept(w)).toBe(true);
    expect(w.invs.map((i) => i.status)).toEqual(['accepted', 'sent', 'sent', 'sent']);
    expect(w.mems.map((m) => m.status)).toEqual(['active', 'invited']);
  });
  it('a second accept of the same invitation is false (single use) and changes nothing', async () => {
    const w = world([{ status: 'sent' }]);
    expect(await accept(w)).toBe(true);
    const at2 = w.invs[0]!.accepted_at; expect(await accept(w)).toBe(false); expect(w.invs[0]!.accepted_at).toBe(at2);
  });
  it('statement parameters are unchanged: invitation update gets [tenant, membership, user, at, actor]; membership update [tenant, membership, at, actor]; no DEFINER on the tenant branch', async () => {
    const w = world([{ status: 'sent' }]); await accept(w);
    expect(w.calls).toHaveLength(2);
    expect(w.calls[0]!.p).toEqual([T, M, U, AT, A]); expect(w.calls[1]!.p).toEqual([T, M, AT, A]);
    expect(w.calls.map((c) => c.sql).join('\n')).not.toMatch(/identity_platform_auth_write/);
  });
  it('the accept statement lists ONLY sent (not a blanket UPDATE, not pending) and keeps the expiry guard', async () => {
    const w = world([{ status: 'sent' }]); await accept(w);
    const sql = w.calls[0]!.sql;
    expect(statuses(sql)).toEqual(['sent']);
    expect(sql).toMatch(/expires_at\s*>\s*\$4/);
    expect(sql).toMatch(/tenant_id\s*=\s*\$1/); expect(sql).toMatch(/membership_id\s*=\s*\$2/); expect(sql).toMatch(/user_id\s*=\s*\$3/);
  });
  it('a malformed call (tenant without membership) is false with no query; a DB error propagates (fail closed)', async () => {
    const w = world([{ status: 'sent' }]);
    expect(await w.repo.acceptInvitation(w.tx, { tenantId: T, membershipId: null, userId: U, at: AT, actorId: A })).toBe(false); expect(w.calls).toHaveLength(0);
    const bad: any = { query: async () => { throw new Error('boom'); } };
    await expect(w.repo.acceptInvitation(bad, { tenantId: T, membershipId: M, userId: U, at: AT, actorId: A })).rejects.toThrow('boom');
  });
});
