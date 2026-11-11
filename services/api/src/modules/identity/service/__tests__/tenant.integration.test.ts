// T22 integration across real pieces: tenant.service (fake repo) -> T8 resolveSession handler (fake session store). Plan row T22: "provision then probe isolation between new tenant and
// tenant_a; activate guard; suspend -> sessions fail; terminate membership columns (07-SECURITY D-T13)". US-E2: "every staff session of that tenant fails on the next request
// (403 identity.tenant_suspended)". Expected now: fails to load (../tenant.service.js missing). Real SQL / RLS is NOT exercised here (no live harness): see .orchestra/notes/C2.T22-tests.md.
import { describe, expect, it } from 'vitest';
import { makeSessionWorld, rejection as srejection, type SessionWorld } from '../../handlers/__tests__/session.helpers.js';
import { createResolveSession } from '../../handlers/resolveSession.js';
import { createTenantService } from '../tenant.service.js';
import { NOW, PROVISION, STAFF_USER, SYS, TENANT_A, TENANT_B, makeCtx, makeGotrue, makeRepo, nextId, rejection, seedA, seedB, type FakeRepo } from './tenant.helpers.js';

function world() {
  const f = makeRepo({ tenants: [seedA('active'), seedB()] }); const gotrue = makeGotrue(f);
  const svc = createTenantService({ repo: f.repo, gotrue, emailHmac: (e: string) => Buffer.from(e), userExists: async () => false, newId: nextId } as never) as any;
  return { f, svc, ctx: () => makeCtx(f).ctx };
}
/** A tenant-staff request after the lifecycle change: the resolver reads core.tenants.status of the session's tenant (T8, session.service); project the fake tenant's status onto the session row. */
async function resolveAs(w: SessionWorld, f: FakeRepo, tenantId: string, row: any, token: string) {
  row.tenantStatus = f.tenant(tenantId)!.status;
  const { hctx } = w.makeHctx(); return createResolveSession(w.deps as never)(w.req({ token, body: { touch: false } }) as never, hctx);
}

describe('suspend -> sessions fail (US-E2, AC-A1.4)', () => {
  it('before: the tenant staff session resolves 200; after suspendTenant: 403 identity.tenant_suspended on the next request; after reactivateTenant: 200 again', async () => {
    const t = world(); const w = await makeSessionWorld(); const { token, row } = w.addSession();
    expect(((await resolveAs(w, t.f, TENANT_A, row, token)) as any).status).toBe(200);
    await t.svc.suspendTenant(t.ctx(), { tenantId: TENANT_A, reasonText: 'Synthetic reason', expectedVersion: 3 });
    expect((await srejection(resolveAs(w, t.f, TENANT_A, row, token))).code).toBe('identity.tenant_suspended');
    await t.svc.reactivateTenant(t.ctx(), { tenantId: TENANT_A, expectedVersion: 4 });
    expect(((await resolveAs(w, t.f, TENANT_A, row, token)) as any).status).toBe(200);
  });
  it('tenant B is unaffected by suspending A: its sessions stay active and its tenant stays active', async () => {
    const t = world(); await t.svc.suspendTenant(t.ctx(), { tenantId: TENANT_A, reasonText: 'Synthetic reason', expectedVersion: 3 });
    expect(t.f.tenant(TENANT_B)!.status).toBe('active'); expect(t.f.data(TENANT_B).sessions.every((s) => s.state === 'active')).toBe(true); expect(t.f.data(TENANT_A).sessions.every((s) => s.state === 'revoked')).toBe(true);
  });
  it('terminate: sessions revoked and the session resolver refuses an offboarded tenant too', async () => {
    const t = world(); const w = await makeSessionWorld(); const { token, row } = w.addSession();
    await t.svc.suspendTenant(t.ctx(), { tenantId: TENANT_A, reasonText: 'Synthetic reason', expectedVersion: 3 });
    await t.svc.terminateTenant(t.ctx(), { tenantId: TENANT_A, confirmCode: 'synthetic_alpha', reasonText: 'Synthetic contract ended', expectedVersion: 4 });
    expect((await srejection(resolveAs(w, t.f, TENANT_A, row, token))).code).toBe('identity.tenant_suspended');
  });
});

describe('full lifecycle: provision -> activate guard -> activate -> suspend -> reactivate -> suspend -> terminate (T1-T5)', () => {
  it('the guard opens only once the invited admin has accepted; every transition bumps the version; the end state is terminal', async () => {
    const t = world(); const p = await t.svc.provisionTenant(t.ctx(), PROVISION); const id = p.body.tenant_id; let v = p.version;
    expect((await rejection(t.svc.activateTenant(t.ctx(), { tenantId: id, expectedVersion: v }))).code).toBe('identity.tenant_not_ready');          // admin only invited
    t.f.data(id).members[0]!.status = 'active'; t.f.data(id).members[0]!.accepted = true;                                                              // admin accepts (C2 T-accept path, simulated)
    const steps: Array<[string, Record<string, unknown>, string]> = [['activateTenant', {}, 'active'], ['suspendTenant', { reasonText: 'r1' }, 'suspended'], ['reactivateTenant', {}, 'active'],
      ['suspendTenant', { reasonText: 'r2' }, 'suspended'], ['terminateTenant', { confirmCode: 'synthetic_gamma', reasonText: 'r3' }, 'offboarded']];
    for (const [op, extra, status] of steps) { const r = await t.svc[op](t.ctx(), { tenantId: id, expectedVersion: v, ...extra }); expect(r.body.status).toBe(status); expect(r.version).toBe(v + 1); v = r.version; }
    for (const op of ['activateTenant', 'suspendTenant', 'reactivateTenant']) expect((await rejection(t.svc[op](t.ctx(), { tenantId: id, expectedVersion: v, reasonText: 'x' }))).code).toBe('common.version_conflict');
    expect((await rejection(t.svc.terminateTenant(t.ctx(), { tenantId: id, expectedVersion: v, confirmCode: 'synthetic_gamma', reasonText: 'again' }))).code).toBe('common.version_conflict');
  });
  it('a replayed provisionTenant with the same code (Idempotency-Key replay is the core store\'s; a plain retry without it) is 409 identity.code_duplicate and leaves exactly one tenant bundle', async () => {
    const t = world(); await t.svc.provisionTenant(t.ctx(), PROVISION); const before = t.f.by('insertBranch').length;
    expect((await rejection(t.svc.provisionTenant(t.ctx(), PROVISION))).code).toBe('identity.code_duplicate'); expect(t.f.by('insertBranch')).toHaveLength(before); expect(t.f.by('insert')).toHaveLength(1);
  });
});

describe('terminate membership columns end to end (07-SECURITY D-T13, 08 A8.3 / A9.5)', () => {
  it('after provision + terminate: the invited admin and every other non-deactivated member carry deactivated_at/by/reason_code; by = the platform staff USER, never the system actor', async () => {
    const t = world(); await t.svc.suspendTenant(t.ctx(), { tenantId: TENANT_A, reasonText: 'Synthetic reason', expectedVersion: 3 });
    const r = await t.svc.terminateTenant(t.ctx(), { tenantId: TENANT_A, confirmCode: 'synthetic_alpha', reasonText: 'Synthetic contract ended', expectedVersion: 4 });
    expect(r.body).toMatchObject({ status: 'offboarded', status_reason: 'Synthetic contract ended' });
    const ms = t.f.data(TENANT_A).members; expect(ms.every((m) => m.status === 'deactivated')).toBe(true);
    for (const m of ms.filter((x) => x.deactivation_reason_code === 'other')) { expect(m.deactivated_at).toEqual(NOW); expect(m.deactivated_by).toBe(STAFF_USER); expect(m.deactivated_by).not.toBe(SYS); }
    expect(ms.filter((m) => m.deactivation_reason_code === 'other')).toHaveLength(2); expect(ms.find((m) => m.deactivation_reason_code === 'security_concern')).toBeDefined();
  });
});
