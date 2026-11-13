// C12.T-04 service/scope.service.ts, unit (02-TRD §5 "Scope" and §6.1 call-site table; 07-SECURITY §6.2 P-B1…P-B8, PRD AC-22.2).
// done_when: visible branches from getActor(); assertStoreAccess order (404 first, then 403); assertTransferAccess.
//
// SEAMS (the spec fixes the names assertStoreAccess / assertTransferAccess / listVisibleBranchIds and the order of checks, not the full signatures):
//   listVisibleBranchIds(ctx): Promise<{ all: boolean; branchIds: readonly string[] }>
//       all = actor.centreScope.all (every branch of the tenant is visible; branchIds then is not consulted); else branchIds = actor.branchIds (R3 grants only).
//   assertStoreAccess(ctx, storeId, permission): Promise<StoreRow>      resolves with the loaded `inventory.stores` row (snake_case, has id + branch_id)
//   assertTransferAccess(ctx, transferId, { permission, end? }): Promise<TransferRow>   end 'from' | 'to' = the end the action acts on (#59 #60 #62 from, #61 to);
//       no `end` = a read (#58): visible when either end's branch is visible. Resolves with the loaded transfer row (from_store_id, to_store_id).
//   ctx = { tenantId, actor: { id }, tx, ports: { IdentityPort } }. Stores and transfers are loaded ONLY through the T-03 repositories
//       getStore(rc, id) (repository/stores.repo.ts) and getTransfer(rc, id) (repository/transfers.repo.ts), rc = { tx: ctx.tx, tenantId: ctx.tenantId, actorId: ctx.actor.id }.
//       (RLS makes another tenant's row come back null; modelled below by the mock returning null on a tenant mismatch.)
//   Branch invisible -> LimsError('common.not_found') (404, no id in detail) BEFORE IdentityPort.assertRole is ever called; visible -> assertRole({ permission, branchId: store.branch_id }).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LimsError } from '../../../../core/errors.js';

const db = vi.hoisted(() => ({
  stores: new Map<string, any>(),
  transfers: new Map<string, any>(),
  rcs: [] as any[],
}));
vi.mock('../../repository/stores.repo.js', () => ({
  getStore: vi.fn(async (rc: any, id: string) => { db.rcs.push(rc); const r = db.stores.get(id); return r && r.tenant_id === rc.tenantId ? r : null; }),
}));
vi.mock('../../repository/transfers.repo.js', () => ({
  getTransfer: vi.fn(async (rc: any, id: string) => { db.rcs.push(rc); const r = db.transfers.get(id); return r && r.tenant_id === rc.tenantId ? r : null; }),
}));
import { assertStoreAccess, assertTransferAccess, listVisibleBranchIds } from '../scope.service.js';

const TA = '01a1a98a-ac40-7000-8000-00000000a001';
const TB = '01a1a98a-ac40-7000-8000-00000000b001';
const BR1 = '01900000-0000-7000-8000-00000000b101';
const BR2 = '01900000-0000-7000-8000-00000000b102';
const BR3 = '01900000-0000-7000-8000-00000000b103';
const BR_OTHER_TENANT = '01900000-0000-7000-8000-00000000bb99';
const S1 = '01900000-0000-7000-8000-0000000051a1'; // tenant A, branch BR1
const S2 = '01900000-0000-7000-8000-0000000051a2'; // tenant A, branch BR2
const S3 = '01900000-0000-7000-8000-0000000051a3'; // tenant A, branch BR3
const SB = '01900000-0000-7000-8000-0000000051b1'; // tenant B, branch BR_OTHER_TENANT
const T12 = '01900000-0000-7000-8000-0000000071a1'; // tenant A transfer S1 -> S2
const T23 = '01900000-0000-7000-8000-0000000071a2'; // tenant A transfer S2 -> S3
const T11 = '01900000-0000-7000-8000-0000000071a3'; // tenant A transfer S1 -> S1 (same branch both ends)
const TDANGLE = '01900000-0000-7000-8000-0000000071a4'; // to_store_id points at nothing
const TXB = '01900000-0000-7000-8000-0000000071b1'; // tenant B
const GHOST = '01900000-0000-7000-8000-0000000099ff';
const ACTOR = '01900000-0000-7000-8000-0000000000a1';
const STOCK = 'inventory.stock.manage';
const READ = 'inventory.item.read';

interface Profile { all?: boolean; branchIds?: string[]; permissions?: string[]; mfa?: 'aal1' | 'aal2' }
function world(p: Profile = {}, tenantId = TA) {
  const calls: string[] = [];
  const roleReqs: any[] = [];
  const profile = { centreScope: { all: p.all ?? false, centreIds: [] as string[] }, branchIds: p.branchIds ?? [], permissions: p.permissions ?? [READ, STOCK], mfaLevel: p.mfa ?? 'aal2' };
  const IdentityPort = {
    async getActor() { calls.push('getActor'); return profile; },
    async assertRole(_ctx: unknown, req: { permission: string; branchId?: string }) {
      calls.push('assertRole'); roleReqs.push(req);
      if (!profile.permissions.includes(req.permission)) throw new LimsError('auth.forbidden');
      if (req.permission === 'inventory.stock.adjust' && profile.mfaLevel !== 'aal2') throw new LimsError('auth.mfa_required');
    },
  };
  const ctx: any = { tenantId, actor: { type: 'user', id: ACTOR }, requestId: 'r1', tx: { query: async () => ({ rows: [] }) }, ports: { IdentityPort } };
  return { ctx, calls, roleReqs, profile };
}
async function rej(p: Promise<unknown>): Promise<LimsError> {
  try { await p; } catch (e) { return e as LimsError; }
  throw new Error('expected a rejection, but it resolved');
}

beforeEach(() => {
  db.stores.clear(); db.transfers.clear(); db.rcs.length = 0;
  const store = (id: string, tenant: string, branch: string) => db.stores.set(id, { id, tenant_id: tenant, branch_id: branch, store_code: id.slice(-4), name: 'Store', is_active: true, version: 1 });
  store(S1, TA, BR1); store(S2, TA, BR2); store(S3, TA, BR3); store(SB, TB, BR_OTHER_TENANT);
  const tr = (id: string, tenant: string, from: string, to: string) => db.transfers.set(id, { id, tenant_id: tenant, from_store_id: from, to_store_id: to, status: 'draft', version: 1 });
  tr(T12, TA, S1, S2); tr(T23, TA, S2, S3); tr(T11, TA, S1, S1); tr(TDANGLE, TA, S1, GHOST); tr(TXB, TB, SB, SB);
});

describe('listVisibleBranchIds (visible-branch computation from getActor())', () => {
  it('centreScope.all => every branch (P-B4), regardless of branchIds', async () => {
    for (const branchIds of [[], [BR1]]) {
      const w = world({ all: true, branchIds });
      expect((await listVisibleBranchIds(w.ctx)).all).toBe(true);
    }
  });
  it('restricted actor => exactly the explicit branchIds grants (R3)', async () => {
    const w = world({ all: false, branchIds: [BR1, BR3] });
    const v = await listVisibleBranchIds(w.ctx);
    expect(v.all).toBe(false);
    expect([...v.branchIds].sort()).toEqual([BR1, BR3].sort());
  });
  it('restricted actor with no grants sees no branch (fails closed)', async () => {
    const v = await listVisibleBranchIds(world({ all: false, branchIds: [] }).ctx);
    expect(v.all).toBe(false);
    expect([...v.branchIds]).toEqual([]);
  });
  it('reads the actor through IdentityPort.getActor, never from request input', async () => {
    const w = world({ branchIds: [BR1] });
    await listVisibleBranchIds(w.ctx);
    expect(w.calls).toContain('getActor');
  });
  it('the result is a copy: mutating it cannot widen the actor profile', async () => {
    const w = world({ branchIds: [BR1] });
    const v = await listVisibleBranchIds(w.ctx);
    try { (v.branchIds as string[]).push(BR2); } catch { /* frozen copy is fine */ }
    expect((await listVisibleBranchIds(w.ctx)).branchIds).toEqual([BR1]);
    expect(w.profile.branchIds).toEqual([BR1]);
  });
  it('a getActor failure (auth.*) propagates unchanged; no partial visibility', async () => {
    const w = world();
    w.ctx.ports.IdentityPort.getActor = async () => { throw new LimsError('auth.unauthenticated'); };
    expect((await rej(listVisibleBranchIds(w.ctx))).code).toBe('auth.unauthenticated');
  });
});

describe('assertStoreAccess: order is load -> visibility (404) -> assertRole with branchId (403)  [TRD §5 Scope, P-B1, P-B2, P-B8]', () => {
  it('visible branch + permission held: resolves with the store row; assertRole got { permission, branchId }', async () => {
    const w = world({ branchIds: [BR1] });
    const s = await assertStoreAccess(w.ctx, S1, STOCK);
    expect(s).toMatchObject({ id: S1, branch_id: BR1 });
    expect(w.roleReqs).toEqual([{ permission: STOCK, branchId: BR1 }]);
  });
  it('unknown store id: 404 common.not_found, assertRole never called', async () => {
    const w = world({ all: true });
    const e = await rej(assertStoreAccess(w.ctx, GHOST, STOCK));
    expect([e.code, e.statusCode]).toEqual(['common.not_found', 404]);
    expect(w.calls).not.toContain('assertRole');
  });
  it('another tenant\'s store id (RLS returns nothing): the same 404, even for an all-centres actor', async () => {
    const w = world({ all: true });
    const e = await rej(assertStoreAccess(w.ctx, SB, STOCK));
    expect(e.code).toBe('common.not_found');
    expect(w.calls).not.toContain('assertRole');
  });
  it('tenant comes from ctx, never from the argument: the repository is called with rc.tenantId = ctx.tenantId and actorId = ctx.actor.id', async () => {
    const w = world({ all: true });
    await assertStoreAccess(w.ctx, S1, STOCK);
    expect(db.rcs).toHaveLength(1);
    expect(db.rcs[0]).toMatchObject({ tenantId: TA, actorId: ACTOR, tx: w.ctx.tx });
  });
  it('branch not visible, permission HELD: 404 and assertRole not called', async () => {
    const w = world({ branchIds: [BR1] });
    const e = await rej(assertStoreAccess(w.ctx, S2, STOCK));
    expect([e.code, e.statusCode]).toEqual(['common.not_found', 404]);
    expect(w.calls).not.toContain('assertRole');
  });
  it('P-B8: branch not visible AND permission missing: still 404, never 403', async () => {
    const w = world({ branchIds: [BR1], permissions: [READ] });
    const e = await rej(assertStoreAccess(w.ctx, S2, STOCK));
    expect(e.code).toBe('common.not_found');
    expect(w.calls).not.toContain('assertRole');
  });
  it('P-B8: branch visible, permission missing: 403 auth.forbidden (from assertRole, with the store\'s branchId)', async () => {
    const w = world({ branchIds: [BR1], permissions: [READ] });
    const e = await rej(assertStoreAccess(w.ctx, S1, STOCK));
    expect([e.code, e.statusCode]).toEqual(['auth.forbidden', 403]);
    expect(w.roleReqs).toEqual([{ permission: STOCK, branchId: BR1 }]);
  });
  it('assertRole is the LAST step: visibility is decided (and the store loaded) before it runs', async () => {
    const w = world({ branchIds: [BR1] });
    await assertStoreAccess(w.ctx, S1, STOCK);
    expect(w.calls.at(-1)).toBe('assertRole');
    expect(w.calls.indexOf('getActor')).toBeLessThan(w.calls.indexOf('assertRole'));
    expect(db.rcs.length).toBeGreaterThan(0); // the store was loaded before the role check, too (otherwise there is no branchId to pass)
  });
  it('auth.mfa_required from assertRole passes through unchanged (privileged operation at aal1)', async () => {
    const w = world({ branchIds: [BR1], permissions: ['inventory.stock.adjust'], mfa: 'aal1' });
    const e = await rej(assertStoreAccess(w.ctx, S1, 'inventory.stock.adjust'));
    expect([e.code, e.statusCode]).toEqual(['auth.mfa_required', 403]);
  });
  it('mfa_required is not leaked for an invisible branch (404 wins)', async () => {
    const w = world({ branchIds: [BR1], permissions: ['inventory.stock.adjust'], mfa: 'aal1' });
    expect((await rej(assertStoreAccess(w.ctx, S2, 'inventory.stock.adjust'))).code).toBe('common.not_found');
  });
  it('centreScope.all: every branch of the tenant is visible (P-B4); assertRole still runs with that store\'s branchId', async () => {
    for (const [sid, br] of [[S1, BR1], [S2, BR2], [S3, BR3]] as const) {
      const w = world({ all: true, branchIds: [] });
      await assertStoreAccess(w.ctx, sid, STOCK);
      expect(w.roleReqs).toEqual([{ permission: STOCK, branchId: br }]);
    }
  });
  it('centreScope.all but permission missing: 403 (visible object, missing permission)', async () => {
    const w = world({ all: true, permissions: [READ] });
    expect((await rej(assertStoreAccess(w.ctx, S3, STOCK))).code).toBe('auth.forbidden');
  });
  it('restricted actor with no grants: every store is 404', async () => {
    for (const sid of [S1, S2, S3]) expect((await rej(assertStoreAccess(world({ branchIds: [] }).ctx, sid, STOCK))).code).toBe('common.not_found');
  });
  it('a grant on a branch of ANOTHER tenant never makes this tenant\'s store visible, nor B\'s store reachable', async () => {
    const w = world({ branchIds: [BR_OTHER_TENANT] });
    expect((await rej(assertStoreAccess(w.ctx, S1, STOCK))).code).toBe('common.not_found');
    expect((await rej(assertStoreAccess(w.ctx, SB, STOCK))).code).toBe('common.not_found');
  });
  it('tenant B ctx, tenant A store id: 404 (AC-22.1 side of the same helper)', async () => {
    const w = world({ all: true }, TB);
    expect((await rej(assertStoreAccess(w.ctx, S1, STOCK))).code).toBe('common.not_found');
    expect(w.calls).not.toContain('assertRole');
  });
  it('the 404 is one shape: unknown id, invisible branch and foreign tenant are indistinguishable, and no id is echoed', async () => {
    const shapes = [] as unknown[];
    for (const [prof, sid] of [[{ all: true }, GHOST], [{ branchIds: [BR1] }, S2], [{ all: true }, SB]] as [Profile, string][]) {
      const e = await rej(assertStoreAccess(world(prof).ctx, sid, STOCK));
      shapes.push([e.code, e.statusCode, e.detail, e.errors, e.message]);
      const text = JSON.stringify([e.message, e.detail, e.errors]);
      for (const secret of [sid, BR1, BR2, BR3, BR_OTHER_TENANT]) expect(text).not.toContain(secret);
    }
    expect(shapes[1]).toEqual(shapes[0]);
    expect(shapes[2]).toEqual(shapes[0]);
  });
  it('hostile ids are only ever bound values for the repository: a non-uuid id is a plain 404 (no throw of another kind)', async () => {
    for (const id of ["'; DROP TABLE inventory.stores; --", '', '../../etc/passwd', 'x'.repeat(5000)]) {
      const e = await rej(assertStoreAccess(world({ all: true }).ctx, id, STOCK));
      expect(e.code).toBe('common.not_found');
    }
  });
  it('a getActor failure propagates (fail closed) and the permission check is not reached', async () => {
    const w = world({ all: true });
    w.ctx.ports.IdentityPort.getActor = async () => { throw new LimsError('auth.unauthenticated'); };
    expect((await rej(assertStoreAccess(w.ctx, S1, STOCK))).code).toBe('auth.unauthenticated');
    expect(w.calls).not.toContain('assertRole');
  });
  it('20 parallel checks with different actors do not bleed state (no module-level actor cache across ctx objects)', async () => {
    const res = await Promise.all(Array.from({ length: 20 }, async (_v, i) => {
      const w = world({ branchIds: i % 2 === 0 ? [BR1] : [BR2] });
      try { await assertStoreAccess(w.ctx, S1, STOCK); return 'ok'; } catch (e) { return (e as LimsError).code; }
    }));
    expect(res).toEqual(Array.from({ length: 20 }, (_v, i) => (i % 2 === 0 ? 'ok' : 'common.not_found')));
  });
});

describe('assertTransferAccess: visible when the from OR to branch is visible (404 otherwise), then the acting end\'s branch is asserted (403)  [TRD §5, P-B3]', () => {
  const act = (end: 'from' | 'to') => ({ permission: STOCK, end });

  it('both ends visible: every action resolves with the transfer row', async () => {
    for (const end of ['from', 'to'] as const) {
      const w = world({ branchIds: [BR1, BR2] });
      expect(await assertTransferAccess(w.ctx, T12, act(end))).toMatchObject({ id: T12, from_store_id: S1, to_store_id: S2 });
    }
  });
  it('assertRole gets the branch of the ACTING end: from -> source branch (#59 #60 #62), to -> destination branch (#61)', async () => {
    const f = world({ branchIds: [BR1, BR2] });
    await assertTransferAccess(f.ctx, T12, act('from'));
    expect(f.roleReqs).toEqual([{ permission: STOCK, branchId: BR1 }]);
    const t = world({ branchIds: [BR1, BR2] });
    await assertTransferAccess(t.ctx, T12, act('to'));
    expect(t.roleReqs).toEqual([{ permission: STOCK, branchId: BR2 }]);
  });
  it('P-B3 source-side user (BR1 only): can act on the from end, but receive (to end) is 403 auth.forbidden, not 404', async () => {
    const ok = world({ branchIds: [BR1] });
    await expect(assertTransferAccess(ok.ctx, T12, act('from'))).resolves.toMatchObject({ id: T12 });
    const e = await rej(assertTransferAccess(world({ branchIds: [BR1] }).ctx, T12, act('to')));
    expect([e.code, e.statusCode]).toEqual(['auth.forbidden', 403]);
  });
  it('P-B3 destination-side user (BR2 only): can receive, but dispatch / replace / cancel (from end) is 403', async () => {
    await expect(assertTransferAccess(world({ branchIds: [BR2] }).ctx, T12, act('to'))).resolves.toMatchObject({ id: T12 });
    for (const _op of ['dispatch', 'replace', 'cancel']) {
      const e = await rej(assertTransferAccess(world({ branchIds: [BR2] }).ctx, T12, act('from')));
      expect([e.code, e.statusCode]).toEqual(['auth.forbidden', 403]);
    }
  });
  it('a read (no end) is allowed from either side', async () => {
    for (const b of [BR1, BR2]) {
      await expect(assertTransferAccess(world({ branchIds: [b] }).ctx, T12, { permission: READ })).resolves.toMatchObject({ id: T12 });
    }
  });
  it('neither end visible: 404 (reads and actions alike), assertRole never reached, even with the permission missing (P-B8)', async () => {
    for (const opts of [{ permission: READ }, act('from'), act('to'), { permission: 'inventory.master.manage', end: 'from' as const }]) {
      const w = world({ branchIds: [BR3], permissions: [READ] });
      const e = await rej(assertTransferAccess(w.ctx, T12, opts));
      expect([e.code, e.statusCode]).toEqual(['common.not_found', 404]);
      expect(w.calls).not.toContain('assertRole');
    }
  });
  it('actor with no grants: 404 everywhere', async () => {
    expect((await rej(assertTransferAccess(world({ branchIds: [] }).ctx, T12, { permission: READ }))).code).toBe('common.not_found');
  });
  it('unknown id and another tenant\'s transfer: the same 404; no id or branch echoed', async () => {
    const shapes = [] as unknown[];
    for (const id of [GHOST, TXB]) {
      const e = await rej(assertTransferAccess(world({ all: true }).ctx, id, { permission: READ }));
      shapes.push([e.code, e.statusCode, e.detail, e.errors, e.message]);
      const text = JSON.stringify([e.message, e.detail, e.errors]);
      for (const secret of [id, S1, S2, SB, BR1, BR2]) expect(text).not.toContain(secret);
    }
    expect(shapes[1]).toEqual(shapes[0]);
  });
  it('a visible end with the permission missing: 403 (visible object, missing permission)', async () => {
    const e = await rej(assertTransferAccess(world({ branchIds: [BR1], permissions: [READ] }).ctx, T12, act('from')));
    expect(e.code).toBe('auth.forbidden');
  });
  it('centreScope.all: both ends visible, both actions pass', async () => {
    for (const end of ['from', 'to'] as const) await expect(assertTransferAccess(world({ all: true }).ctx, T23, act(end))).resolves.toMatchObject({ id: T23 });
  });
  it('same branch on both ends: one grant is enough for both actions', async () => {
    for (const end of ['from', 'to'] as const) await expect(assertTransferAccess(world({ branchIds: [BR1] }).ctx, T11, act(end))).resolves.toMatchObject({ id: T11 });
  });
  it('a transfer whose store row cannot be loaded (dangling end) is not exposed: 404 for a restricted actor', async () => {
    const e = await rej(assertTransferAccess(world({ branchIds: [BR2] }).ctx, TDANGLE, { permission: READ }));
    expect(e.code).toBe('common.not_found');
  });
  it('both stores are loaded through the repository with the ctx tenant (rc.tenantId = ctx.tenantId)', async () => {
    const w = world({ branchIds: [BR1, BR2] });
    await assertTransferAccess(w.ctx, T12, act('from'));
    expect(db.rcs.length).toBeGreaterThanOrEqual(3); // transfer + from store + to store
    for (const rc of db.rcs) expect(rc).toMatchObject({ tenantId: TA, actorId: ACTOR });
  });
  it('mfa_required passes through unchanged when the acting end is visible', async () => {
    const w = world({ branchIds: [BR1], permissions: ['inventory.stock.adjust'], mfa: 'aal1' });
    expect((await rej(assertTransferAccess(w.ctx, T12, { permission: 'inventory.stock.adjust', end: 'from' }))).code).toBe('auth.mfa_required');
  });
});
