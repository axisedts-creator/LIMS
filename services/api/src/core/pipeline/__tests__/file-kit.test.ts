// CR TENANT-LOGO-1 (storage wiring): which storage a request gets. REAL pipeline buildCtx (helpers.ts rig, fake pg); the kit factory is a
// recorder standing in for boot.ts (createStorage / createUploads / createDownload bound to one module and one tenant).
// The rule under test: the tenant of ctx.storage / ctx.uploads / ctx.download is the VERIFIED claims tenant and nothing else; only a
// platform session can ask for another tenant's kit (ctx.tenantFiles), and only by a UUID.
import { describe, expect, it } from 'vitest';
import { markAsserted } from '../../ports/authz-guard.js';   // the handlers here do no work: stage 9 (authz asserted) is not what is under test
import { claimsA, claimsB, claimsDevice, makeRig, op, REQ_ID, SUB, TENANT_A, TENANT_B } from './helpers.js';

const platformClaims = { sub: SUB, actor_type: 'user', scope: 'platform', platform_staff_id: '0190a000-0000-7000-8000-00000000c001', platform_role: 'platform_superadmin', aal: 'aal2', lims_session_id: REQ_ID } as any;
const platformOp = op({ module: 'identity', operationId: 'uploadBrandingAssetAsPlatform', context: 'platform' });

const asserted = async (c: any) => { if (c.platformRole) markAsserted(c); else await c.ports.IdentityPort.assertRole(c, { permission: 'synthetic.permission' }); };

function rigWithKit() {
  let ctx: any; const asked: Array<{ module: string; tenantId: string; audit: unknown }> = [];
  const rig = makeRig({ handler: async (_req, c) => { ctx = c; await asserted(c); return { status: 200, body: {} }; } });
  (rig.shared as any).fileKit = (i: { module: string; tenantId: string; audit: unknown }) => {
    asked.push(i);
    return { storage: { kit: 'storage', tenantId: i.tenantId, module: i.module }, uploads: { kit: 'uploads', tenantId: i.tenantId }, download: { kit: 'download', tenantId: i.tenantId } };
  };
  return { rig, asked, ctx: () => ctx };
}

describe('tenant request', () => {
  it('ctx.storage / uploads / download are bound to the claims tenant and the operation module', async () => {
    const w = rigWithKit(); await w.rig.run({ claims: claimsA });
    expect(w.asked.map((a) => [a.module, a.tenantId])).toEqual([[op().module, TENANT_A]]);
    expect(w.ctx().storage).toMatchObject({ kit: 'storage', tenantId: TENANT_A }); expect(w.ctx().uploads.tenantId).toBe(TENANT_A); expect(w.ctx().download.tenantId).toBe(TENANT_A);
    expect(w.asked[0]!.audit).toBe(w.ctx().audit);   // downloads are access-logged through THIS request
  });
  it('another tenant gets its own kit; nothing of tenant A is reachable from it', async () => {
    const w = rigWithKit(); await w.rig.run({ claims: claimsB });
    expect(w.asked.map((a) => a.tenantId)).toEqual([TENANT_B]); expect(JSON.stringify([w.ctx().storage, w.ctx().uploads, w.ctx().download])).not.toContain(TENANT_A);
  });
  it.each([['staff', claimsA], ['device', claimsDevice]] as const)('a %s session has NO ctx.tenantFiles (it cannot ask for another tenant)', async (_n, claims) => {
    const w = rigWithKit(); await w.rig.run({ claims });
    expect('tenantFiles' in w.ctx()).toBe(false);
  });
  it('tenant claims carrying stray platform keys still get no ctx.tenantFiles', async () => {
    const w = rigWithKit(); await w.rig.run({ claims: { ...claimsA, scope: 'platform', platform_role: 'platform_superadmin' } as any });
    expect('tenantFiles' in w.ctx()).toBe(false); expect(w.asked.map((a) => a.tenantId)).toEqual([TENANT_A]);
  });
  it('a tenant id that is not a UUID gets the unbound members (which answer 503 in production), never a kit', async () => {
    const w = rigWithKit(); await w.rig.run({ claims: { ...claimsA, tenant_id: `${TENANT_A}/../${TENANT_B}` } as any }).catch(() => undefined);
    expect(w.asked).toEqual([]);
  });
  it('no storage provider configured: the shared members are passed on unchanged', async () => {
    let ctx: any; const rig = makeRig({ handler: async (_r, c) => { ctx = c; await asserted(c); return { status: 200, body: {} }; } });
    await rig.run({ claims: claimsA });
    expect(ctx.storage).toBe((rig.shared as any).storage); expect(ctx.uploads).toBe((rig.shared as any).uploads); expect(ctx.download).toBe((rig.shared as any).download);
  });
});

describe('platform request', () => {
  it('has no tenant-bound storage of its own; ctx.tenantFiles(tenant) builds the kit of exactly that tenant', async () => {
    const w = rigWithKit(); await w.rig.run({ claims: platformClaims, op: platformOp });
    expect(w.asked).toEqual([]); expect(w.ctx().storage).toBe((w.rig.shared as any).storage);
    const kit = w.ctx().tenantFiles(TENANT_B);
    expect(w.asked.map((a) => [a.module, a.tenantId])).toEqual([['identity', TENANT_B]]); expect(kit.storage.tenantId).toBe(TENANT_B); expect(kit.uploads.tenantId).toBe(TENANT_B);
  });
  it.each([undefined, '', 'platform', `${TENANT_A}/../${TENANT_B}`, `${TENANT_A} `, 7, { toString: () => TENANT_A }])('ctx.tenantFiles(%s) is refused (common.internal), no kit is built', async (bad) => {
    const w = rigWithKit(); await w.rig.run({ claims: platformClaims, op: platformOp });
    let code: unknown; try { w.ctx().tenantFiles(bad); } catch (e: any) { code = e?.code; }
    expect(code).toBe('common.internal'); expect(w.asked).toEqual([]);
  });
  it('without a configured provider ctx.tenantFiles returns the unbound members', async () => {
    let ctx: any; const rig = makeRig({ handler: async (_r, c) => { ctx = c; await asserted(c); return { status: 200, body: {} }; } });
    await rig.run({ claims: platformClaims, op: platformOp });
    expect(ctx.tenantFiles(TENANT_A).uploads).toBe((rig.shared as any).uploads);
  });
});
