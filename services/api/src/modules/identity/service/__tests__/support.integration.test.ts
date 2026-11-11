// T21 integration: AC-E4.1 .. E4.6 across the real pieces - platform support.service (fake repo) -> claimsResolver (T4, fake DEFINER row) -> IdentityPort (T5, fake repo)
// -> a FAKE lab handler guarded by assertRole('lab.result.read'). 02-TRD s7.2/s7.4, 03-APP-FLOW s8, 07-SECURITY E-5/A-8/P-8, plan row T21:
// "support read_only cannot invite; support cannot call lab.result.read (fake lab handler test); expiry". Expected now: fails to load (../support.service.js missing).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { access } from '../../../../core/audit/access.js';
import { REPO_ROOT } from '../../../../core/module.js';
import { createClaimsResolver } from '../../claims/resolver.js';
import { fakeDb, jwt, platformRow, req as rreq, supportRow } from '../../claims/__tests__/helpers.js';
import { createIdentityPort } from '../../ports/IdentityPort.impl.js';
import { makeFakeRepo, TENANTS } from '../../ports/__tests__/helpers.js';
import { createSupportService } from '../support.service.js';
import { NOW, OPEN, PSESSION, REQ_ID, STAFF_ID, STAFF_USER, makeCtx, makeRepo, mins, nextId, rejection, tenant, type FakeRepo } from './support.helpers.js';

const TA = TENANTS.A, TB = TENANTS.B;
const RO = ['audit.log.read', 'identity.centre.read', 'identity.user.read'];
const ADMIN = [...RO, 'identity.centre.manage', 'identity.role.manage', 'identity.session.revoke', 'identity.settings.manage', 'identity.user.manage'];
const inviteUserPermission = (() => {
  const spec = parse(readFileSync(join(REPO_ROOT, 'contracts', 'openapi', 'identity.yaml'), 'utf8'));
  for (const item of Object.values<any>(spec.paths)) for (const op of Object.values<any>(item)) if (op?.operationId === 'inviteUser') return op['x-permission'] as string;
  throw new Error('inviteUser not in contract');
})();

interface World {
  clock: { now: Date }; f: FakeRepo; svc: any; platformCtx: (o?: Record<string, unknown>) => any;
  /** the DEFINER row for the platform session: support_* filled from the repo's bound support session while it is active and unexpired (08 A20.1) */
  definerRow: () => Record<string, unknown>;
  /** resolver -> claims -> tenant request ctx + port; `tenant` = the tenant the request is routed to */
  call: (o?: { tenant?: 'A' | 'B' }) => Promise<{ out: any; claims: any; ctx: any; port: any }>;
  lab: { handler: (ctx: any) => Promise<unknown>; ran: ReturnType<typeof vi.fn> };
}

function world(opts: { mode?: 'notify' | 'approval_required'; role?: 'platform_support' | 'platform_superadmin' } = {}): World {
  const clock = { now: NOW };
  const f = makeRepo({ tenants: [tenant(TA, { supportAccessMode: opts.mode ?? 'notify' }), tenant(TB)] });
  const svc = createSupportService({ repo: f.repo, newId: nextId } as never) as any;
  const platformCtx = (o: Record<string, unknown> = {}) => makeCtx(f, { now: () => clock.now, platformRole: opts.role ?? 'platform_support', ...o }).ctx;
  const bound = () => { const sid = f.binding.get(PSESSION); const r = sid ? f.rows.find((x) => x.id === sid) : undefined; return r && r.status === 'active' && r.expires_at && r.expires_at.getTime() > clock.now.getTime() ? r : undefined; };
  const definerRow = () => {
    const r = bound();
    return r ? supportRow({ platform_staff_id: STAFF_ID, platform_role: opts.role ?? 'platform_support', support_session_id: r.id, support_tenant_id: r.tenant_id, support_scope: r.scope, support_expires_at: r.expires_at, idle_expires_at: mins(600), absolute_expires_at: mins(600) })
      : platformRow({ platform_staff_id: STAFF_ID, platform_role: opts.role ?? 'platform_support', idle_expires_at: mins(600), absolute_expires_at: mins(600) });
  };
  const ran = vi.fn();
  const call: World['call'] = async (o = {}) => {
    const { db } = fakeDb([definerRow()]);
    const out: any = await createClaimsResolver({ db: db as never, now: () => clock.now }).resolve(jwt({ sub: STAFF_USER, aal: 'aal2' }) as never, rreq() as never);
    if (out.kind !== 'platform') throw new Error(`resolver: ${JSON.stringify(out)}`);
    const claims = JSON.parse(out.claimsJson);
    const tenantId = o.tenant === 'B' ? TB : TA;
    const repo = makeFakeRepo({ members: [], support: f.rows.map((r) => {
      const row: any = { tenantId: r.tenant_id, id: r.id, scope: r.scope, staffDisplayName: 'Demo Support' };
      Object.defineProperty(row, 'active', { enumerable: true, get: () => r.status === 'active' && !!r.expires_at && r.expires_at.getTime() > clock.now.getTime() });
      return row;
    }) });
    repo.st.claims.set(STAFF_USER, claims);
    const port: any = createIdentityPort({ repo: repo.repo as never, systemActorPermissions: () => [], nowMs: () => clock.now.getTime() } as never);
    const ctx = { tenantId, actor: out.actor, requestId: REQ_ID, tx: { query: vi.fn(async () => ({ rows: [] })) }, now: () => clock.now, ports: {} };
    return { out, claims, ctx, port };
  };
  return { clock, f, svc, platformCtx, definerRow, call, lab: { ran, handler: async () => undefined } };
}
const labHandler = (w: World, port: any) => async (ctx: any) => { await port.assertRole(ctx, { permission: 'lab.result.read' }); w.lab.ran(); return { status: 200, body: { result: 'synthetic' } }; };
const codeOf = async (p: unknown) => (await rejection(p)).code;

let w: World;
beforeEach(() => { w = world(); });

describe('AC-E4.1 notify tenant: open -> active; calls carry support_session_id; admins see the event', () => {
  it('opened session resolves to scope=support claims for the TARGET tenant with the support_session_id, no membership', async () => {
    const r = await w.svc.openSupportSession(w.platformCtx(), { ...OPEN, tenantId: TA });
    const { claims, out } = await w.call();
    expect(r.body.status).toBe('active');
    expect(claims).toMatchObject({ scope: 'support', tenant_id: TA, support_session_id: r.body.support_session_id, support_scope: 'read_only', platform_staff_id: STAFF_ID, aal: 'aal2' });
    expect(claims).not.toHaveProperty('membership_id'); expect(out.actor.supportSessionId).toBe(r.body.support_session_id);
  });
  it('the access-log row a handler writes during the session carries support_session_id (CR-C2-010) - real core access() with the resolved actor', async () => {
    const r = await w.svc.openSupportSession(w.platformCtx(), { ...OPEN, tenantId: TA });
    const { ctx } = await w.call();
    await access(ctx, { action: 'user.view', entityType: 'user', outcome: 'allowed' });
    const params = (ctx.tx.query as any).mock.calls[0][1] as unknown[];
    expect(params[6]).toBe(r.body.support_session_id); expect(params[5]).toBeNull();      // support_session_id set, membership_id NULL
  });
  it('tenant admins see the open: access-log support_session.open + notice support_session_started in the target tenant', async () => {
    await w.svc.openSupportSession(w.platformCtx(), { ...OPEN, tenantId: TA });
    expect(w.f.logs.map((l) => [l.tenantId, l.action])).toEqual([[TA, 'support_session.open']]); expect(w.f.notices.map((n) => [n.tenantId, n.kind])).toEqual([[TA, 'support_session_started']]);
  });
});

describe('AC-E4.2 an active read_only support session cannot invite', () => {
  it(`assertRole('${inviteUserPermission}') (the inviteUser x-permission) -> 403 auth.forbidden; read permissions still work`, async () => {
    await w.svc.openSupportSession(w.platformCtx(), { ...OPEN, tenantId: TA });
    const { ctx, port } = await w.call();
    expect(inviteUserPermission).toBe('identity.user.manage');
    expect(await codeOf(port.assertRole(ctx, { permission: inviteUserPermission }))).toBe('auth.forbidden');
    for (const p of RO) await expect(port.assertRole(ctx, { permission: p })).resolves.toBeUndefined();
    expect([...(await port.getActor(ctx)).permissions].sort()).toEqual(RO);
  });
  it('every write permission of the allowlist\'s admin tier is refused at read_only', async () => {
    await w.svc.openSupportSession(w.platformCtx(), { ...OPEN, tenantId: TA });
    const { ctx, port } = await w.call();
    for (const p of ADMIN.filter((x) => !RO.includes(x))) expect(await codeOf(port.assertRole(ctx, { permission: p })), p).toBe('auth.forbidden');
  });
  it('admin scope (superadmin opens it) CAN invite but still never audit.log.export', async () => {
    const a = world({ role: 'platform_superadmin' });
    await a.svc.openSupportSession(a.platformCtx(), { ...OPEN, tenantId: TA, scope: 'admin' });
    const { ctx, port } = await a.call();
    await expect(port.assertRole(ctx, { permission: inviteUserPermission })).resolves.toBeUndefined();
    expect([...(await port.getActor(ctx)).permissions].sort()).toEqual([...ADMIN].sort());
    expect(await codeOf(port.assertRole(ctx, { permission: 'audit.log.export' }))).toBe('auth.forbidden');
  });
});

describe('AC-E4.3 support cannot call a non-identity permission (fake lab handler)', () => {
  it.each(['read_only', 'admin'] as const)('%s: lab.result.read -> 403 auth.forbidden and the lab handler body never runs', async (scope) => {
    const a = world({ role: 'platform_superadmin' });
    await a.svc.openSupportSession(a.platformCtx(), { ...OPEN, tenantId: TA, scope });
    const { ctx, port } = await a.call();
    expect(await codeOf(labHandler(a, port)(ctx))).toBe('auth.forbidden'); expect(a.lab.ran).not.toHaveBeenCalled();
    for (const p of ['billing.invoice.read', 'reporting.report.read', 'lab.result.enter', 'platform.tenant.read', 'platform.support_session.open']) expect(await codeOf(port.assertRole(ctx, { permission: p })), p).toBe('auth.forbidden');
  });
});

describe('AC-E4.4 approval_required: stays requested until the tenant approves', () => {
  it('requested: the platform user still has NO tenant access (calls -> identity.support_session_required); after approval + activate: allowlist access', async () => {
    w = world({ mode: 'approval_required' });
    const r = await w.svc.openSupportSession(w.platformCtx(), { ...OPEN, tenantId: TA });
    expect(r.body.status).toBe('requested');
    let c = await w.call(); expect(c.claims.scope).toBe('platform');
    expect(await codeOf(c.port.assertRole(c.ctx, { permission: 'identity.user.read' }))).toBe('identity.support_session_required');
    const row = w.f.rows.find((x) => x.id === r.body.support_session_id)!;
    expect(await codeOf(w.svc.activateSupportSession(w.platformCtx(), { supportSessionId: row.id, expectedVersion: row.version }))).toBe('common.version_conflict');
    Object.assign(row, { status: 'approved', decided_at: NOW, version: row.version + 1 });                // tenant admin approval (T17, other side)
    await w.svc.activateSupportSession(w.platformCtx(), { supportSessionId: row.id, expectedVersion: row.version });
    c = await w.call(); expect(c.claims).toMatchObject({ scope: 'support', support_session_id: row.id });
    await expect(c.port.assertRole(c.ctx, { permission: 'identity.user.read' })).resolves.toBeUndefined();
  });
  it('denied or unanswered (the 24 h sweep marks it expired): activation is refused for good', async () => {
    w = world({ mode: 'approval_required' });
    for (const status of ['denied', 'expired'] as const) {
      const r = await w.svc.openSupportSession(w.platformCtx(), { ...OPEN, tenantId: TA }); const row = w.f.rows.find((x) => x.id === r.body.support_session_id)!;
      Object.assign(row, { status, version: row.version + 1 });
      expect(await codeOf(w.svc.activateSupportSession(w.platformCtx(), { supportSessionId: row.id, expectedVersion: row.version }))).toBe('common.version_conflict');
    }
    expect((await w.call()).claims.scope).toBe('platform');
  });
});

describe('AC-E4.5 expiry: the next call after expires_at returns identity.support_session_required', () => {
  it('29:59 into a 30 min session still works; at exactly expires_at the resolver drops the support binding and the tenant call is refused', async () => {
    await w.svc.openSupportSession(w.platformCtx(), { ...OPEN, tenantId: TA, durationMinutes: 30 });
    w.clock.now = new Date(mins(30).getTime() - 1000);
    let c = await w.call(); expect(c.claims.scope).toBe('support'); await expect(c.port.assertRole(c.ctx, { permission: 'identity.user.read' })).resolves.toBeUndefined();
    w.clock.now = mins(30);
    c = await w.call(); expect(c.claims.scope).toBe('platform'); expect(c.claims).not.toHaveProperty('support_session_id'); expect(c.claims).not.toHaveProperty('tenant_id');
    expect(await codeOf(c.port.assertRole(c.ctx, { permission: 'identity.user.read' }))).toBe('identity.support_session_required');
    expect(await codeOf(labHandler(w, c.port)(c.ctx))).toBe('identity.support_session_required'); expect(w.lab.ran).not.toHaveBeenCalled();
  });
  it('a request that resolved just before expiry but runs a privileged check after it (expiry mid-request) -> identity.support_session_required', async () => {
    const a = world({ role: 'platform_superadmin' });
    await a.svc.openSupportSession(a.platformCtx(), { ...OPEN, tenantId: TA, scope: 'admin', durationMinutes: 5 });
    a.clock.now = mins(4); const c = await a.call();
    a.clock.now = mins(6);
    expect(await codeOf(c.port.assertRole(c.ctx, { permission: 'identity.settings.manage' }))).toBe('identity.support_session_required');
  });
  it('ending the session (endSupportSession) has the same effect as expiry for the very next call', async () => {
    const r = await w.svc.openSupportSession(w.platformCtx(), { ...OPEN, tenantId: TA });
    const sup = w.platformCtx({ actor: { type: 'user', id: STAFF_USER, supportSessionId: r.body.support_session_id } });
    await w.svc.endSupportSession(sup, { supportSessionId: r.body.support_session_id });
    const c = await w.call(); expect(c.claims.scope).toBe('platform');
    expect(await codeOf(c.port.assertRole(c.ctx, { permission: 'identity.user.read' }))).toBe('identity.support_session_required');
    expect(w.f.logs.map((l) => l.action)).toEqual(['support_session.open', 'support_session.close']);
  });
  it('a long session is capped at 60 minutes by input validation, so no session can outlive the platform maximum', async () => {
    expect(await codeOf(w.svc.openSupportSession(w.platformCtx(), { ...OPEN, tenantId: TA, durationMinutes: 61 }))).toBe('common.validation_failed');
    expect(await codeOf(w.svc.openSupportSession(w.platformCtx(), { ...OPEN, tenantId: TA, durationMinutes: 24 * 60 }))).toBe('common.validation_failed');
  });
});

describe('AC-E4.6 / P-8: a platform user with no active support session calling a tenant endpoint', () => {
  it('-> 403 identity.support_session_required for every permission (identity, lab, platform alike), handler body never runs', async () => {
    const { ctx, port, claims } = await w.call();
    expect(claims.scope).toBe('platform');
    for (const p of ['identity.user.read', 'identity.user.manage', 'audit.log.read', 'lab.result.read', 'billing.invoice.read']) expect(await codeOf(port.assertRole(ctx, { permission: p })), p).toBe('identity.support_session_required');
    expect(await codeOf(labHandler(w, port)(ctx))).toBe('identity.support_session_required'); expect(w.lab.ran).not.toHaveBeenCalled();
  });
  it('platform.* is refused by IdentityPort for a platform actor too (PlatformAuthz is the only check for it)', async () => {
    const { ctx, port } = await w.call();
    expect(await codeOf(port.assertRole(ctx, { permission: 'platform.tenant.read' }))).toMatch(/^(auth\.forbidden|identity\.support_session_required)$/);
  });
});

describe('P-6 support session of tenant A is worthless against tenant B', () => {
  it('same claims, request routed to tenant B -> no allowlist (support_session_required or forbidden), never access', async () => {
    await w.svc.openSupportSession(w.platformCtx(), { ...OPEN, tenantId: TA });
    const { ctx, port } = await w.call({ tenant: 'B' });
    expect(await codeOf(port.assertRole(ctx, { permission: 'identity.user.read' }))).toMatch(/^(auth\.forbidden|identity\.support_session_required)$/);
  });
  it('the session row of A is never listed/readable as B\'s: opening for A writes the access-log and notice in A only', async () => {
    await w.svc.openSupportSession(w.platformCtx(), { ...OPEN, tenantId: TA });
    expect(w.f.logs.every((l) => l.tenantId === TA)).toBe(true); expect(w.f.notices.every((n) => n.tenantId === TA)).toBe(true);
  });
});
