// CR TENANT-LOGO-1: a tenant's own logo. Two operations:
//   uploadBrandingAssetAsPlatform (tenant.service)  - the platform super admin stores a logo FOR one tenant (Provision tenant);
//   getOwnTenantLogoContent      (settings.service) - any staff member reads the logo of THEIR OWN tenant (staff sidebar).
// The point of every case here is tenant separation: nothing written for, or read by, one tenant may touch another tenant.
// Runs the REAL core pipeline (createUploads magic-byte/size/re-encode/scan + createStorage, which refuses a key outside its tenant
// + createDownload) over in-memory storage; repos are the fakes of settings.helpers.ts and tenant.helpers.ts. Synthetic data only.
import { beforeEach, describe, expect, it } from 'vitest';
import * as S from './settings.helpers.js';
import * as T from './tenant.helpers.js';

const { createSettingsService } = await import('../settings.service.js');
const { createTenantService } = await import('../tenant.service.js');

const A = S.TENANT_A, B = S.TENANT_B;
const UNKNOWN_TENANT = S.idN(0xdead);
const rejection = S.rejection;

// ------------------------------------------------------------------------------------------------ read: getOwnTenantLogoContent
describe('getOwnTenantLogoContent: staff read their own tenant logo only', () => {
  let R: S.Repos; let svc: ReturnType<typeof createSettingsService>;
  const BYTES_A = S.png(6, 6), BYTES_B = S.png(9, 3);
  const make = (assets: S.AssetRow[], pointers: Record<string, string | null>) => {
    R = S.makeRepos({ assets });
    for (const [t, id] of Object.entries(pointers)) R.settingsOf(t)['logo_asset_id'] = id;
    svc = createSettingsService({ repo: R.settingsRepo, flagsRepo: R.flagsRepo } as any);
  };
  /** a request context of `tenantId` whose storage holds that tenant's seeded objects */
  const ctxOf = async (tenantId: string, bytes: Uint8Array) => {
    const k = await S.makeCtx({ tenantId });
    for (const r of R.st.assets.filter((x) => x.tenant_id === tenantId)) await k.ctx.storage.put(r.bucket, r.object_path, bytes, { contentType: r.content_type });
    k.raw.calls.length = 0; return k;
  };
  const both = () => make(
    [S.assetRow({ id: S.ASSET_A1, tenant_id: A, kind: 'logo' }), S.assetRow({ id: S.ASSET_B1, tenant_id: B, kind: 'logo' })],
    { [A]: S.ASSET_A1, [B]: S.ASSET_B1 },
  );

  it('each tenant gets its own logo bytes; every repo call carries the caller tenant; the other tenant asset is never looked up', async () => {
    both();
    const ka = await ctxOf(A, BYTES_A); const ra: any = await svc.getOwnTenantLogoContent(ka.ctx);
    expect(ra.status).toBe(200); expect(Buffer.from(ra.body).equals(BYTES_A)).toBe(true); expect(ra.headers['content-type']).toBe('image/png');
    expect(R.calls.every((c) => c.tenantId === A)).toBe(true);
    expect(R.calls.filter((c) => c.m === 'findAsset').map((c) => c.args[0])).toEqual([S.ASSET_A1]);
    R.calls.length = 0;
    const kb = await ctxOf(B, BYTES_B); const rb: any = await svc.getOwnTenantLogoContent(kb.ctx);
    expect(Buffer.from(rb.body).equals(BYTES_B)).toBe(true); expect(Buffer.from(rb.body).equals(BYTES_A)).toBe(false);
    expect(R.calls.every((c) => c.tenantId === B)).toBe(true);
  });
  it('the operation takes no asset id: extra arguments naming another tenant asset are ignored', async () => {
    both(); const ka = await ctxOf(A, BYTES_A);
    const r: any = await (svc.getOwnTenantLogoContent as any)(ka.ctx, { assetId: S.ASSET_B1, tenantId: B });
    expect(Buffer.from(r.body).equals(BYTES_A)).toBe(true);
    expect(R.calls.filter((c) => c.m === 'findAsset').map((c) => [c.tenantId, c.args[0]])).toEqual([[A, S.ASSET_A1]]);
  });
  it('a pointer that names another tenant asset (the DB foreign key forbids it) still serves nothing: 404, no storage read', async () => {
    make([S.assetRow({ id: S.ASSET_B1, tenant_id: B, kind: 'logo' })], { [A]: S.ASSET_B1 });
    const ka = await ctxOf(A, BYTES_A); const e = await rejection(svc.getOwnTenantLogoContent(ka.ctx));
    expect(e.code).toBe('common.not_found'); expect(ka.raw.calls).not.toContain('get'); expect(ka.access).toEqual([]);
  });
  it('no logo set -> 404 common.not_found, no asset lookup, no access-log row', async () => {
    make([], { [A]: null }); const ka = await ctxOf(A, BYTES_A);
    const e = await rejection(svc.getOwnTenantLogoContent(ka.ctx));
    expect(e.code).toBe('common.not_found'); expect(e.statusCode).toBe(404);
    expect(R.calls.some((c) => c.m === 'findAsset')).toBe(false); expect(ka.access).toEqual([]);
  });
  it.each(['pending', 'quarantined'] as const)('logo with scan_state %s -> 422 common.upload_quarantined, no bytes', async (scan_state) => {
    make([S.assetRow({ id: S.ASSET_A1, tenant_id: A, kind: 'logo', scan_state })], { [A]: S.ASSET_A1 });
    const ka = await ctxOf(A, BYTES_A); const e = await rejection(svc.getOwnTenantLogoContent(ka.ctx));
    expect(e.code).toBe('common.upload_quarantined'); expect(ka.raw.calls).not.toContain('get');
  });
  it('a pointer to a signature image is not served (D-26): 404', async () => {
    make([S.assetRow({ id: S.ASSET_A_SIG, tenant_id: A, kind: 'signature', membership_id: S.MEM })], { [A]: S.ASSET_A_SIG });
    const ka = await ctxOf(A, BYTES_A);
    expect((await rejection(svc.getOwnTenantLogoContent(ka.ctx))).code).toBe('common.not_found');
  });
  it('every served logo is access-logged against the caller tenant asset', async () => {
    both(); const ka = await ctxOf(A, BYTES_A); await svc.getOwnTenantLogoContent(ka.ctx);
    expect(ka.access).toEqual([expect.objectContaining({ action: 'branding_asset.download', entityId: S.ASSET_A1, outcome: 'allowed' })]);
  });
  it.each([undefined, '', 'not-a-uuid'])('a context without a valid tenant (%s) is refused before any read: auth.unauthenticated', async (tenantId) => {
    both(); const ka = await ctxOf(A, BYTES_A);
    const e = await rejection(svc.getOwnTenantLogoContent({ ...ka.ctx, tenantId }));
    expect(e.code).toBe('auth.unauthenticated'); expect(R.calls).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------ write: uploadBrandingAssetAsPlatform
describe('uploadBrandingAssetAsPlatform: the platform super admin sets a logo for ONE tenant', () => {
  let R: S.Repos; let f: T.FakeRepo; let svc: ReturnType<typeof createTenantService>;
  const world = (statusA: T.Status = 'active') => {
    const a = T.seedA(statusA), b = T.seedB(); a.tenant.id = A; b.tenant.id = B;
    f = T.makeRepo({ tenants: [a, b] }); R = S.makeRepos();
    // the real statements run under row level security: outside withTenantScope(target) they would write nothing
    const scopedOnly = (m: string, t: string) => { if (f.state.scope !== t) throw new Error(`fake RLS: ${m} for ${t} outside withTenantScope (scope=${f.state.scope})`); };
    svc = createTenantService({
      repo: f.repo as any, rolePackRepo: undefined as any,
      assets: {
        insertAsset: async (tx, t, r) => { scopedOnly('insertAsset', t); return R.settingsRepo.insertAsset(tx, t, r); },
        setAssetPointer: async (tx, t, c, id, actor) => { scopedOnly('setAssetPointer', t); return R.settingsRepo.setAssetPointer(tx, t, c, id, actor); },
      },
    });
  };
  /** platform request context; uploads + storage are bound to `storageTenant` (the real adapter refuses any key outside it) */
  const ctxFor = async (storageTenant: string, o: Record<string, unknown> = {}, scan?: S.ScanMode) => {
    const k = await S.makeCtx({ tenantId: storageTenant, ...(scan ? { scan } : {}) });
    const p = T.makeCtx(f, { uploads: k.ctx.uploads, storage: k.ctx.storage, ...o });
    return { k, p, ctx: p.ctx };
  };
  const upload = (ctx: any, tenantId: unknown, file: unknown = S.incoming(S.png(40, 12)), kind: unknown = 'logo') =>
    svc.uploadBrandingAssetAsPlatform(ctx, { tenantId, file, kind }) as Promise<any>;
  const nothingStored = (k: Awaited<ReturnType<typeof S.makeCtx>>) => {
    expect(R.st.assets).toEqual([]); expect(R.writes).toEqual([]); expect(k.storageKeys()).toEqual([]);
    expect(R.settingsOf(A)['logo_asset_id']).toBeNull(); expect(R.settingsOf(B)['logo_asset_id']).toBeNull();
  };
  beforeEach(() => world());

  it('201 BrandingAsset; the object, the row and the pointer belong to the target tenant; the other tenant is untouched', async () => {
    const { k, p, ctx } = await ctxFor(A); const r = await upload(ctx, A);
    expect(r.status).toBe(201); expect(Object.keys(r.body).sort()).toEqual(['asset_id', 'height', 'kind', 'scan_state', 'sha256', 'width']);
    expect(r.body).toMatchObject({ kind: 'logo', width: 40, height: 12, scan_state: 'clean' });
    expect(k.storageKeys()).toEqual([`identity-assets|${A}/branding/${r.body.asset_id}.png`]);
    expect(R.st.assets).toHaveLength(1); expect(R.st.assets[0]).toMatchObject({ id: r.body.asset_id, tenant_id: A, kind: 'logo', membership_id: null });
    expect(R.settingsOf(A)['logo_asset_id']).toBe(r.body.asset_id);
    expect(R.settingsOf(B)['logo_asset_id']).toBeNull(); expect(R.st.assets.some((a) => a.tenant_id === B)).toBe(false);
    expect(R.calls.filter((c) => ['insertAsset', 'setAssetPointer'].includes(c.m)).every((c) => c.tenantId === A)).toBe(true);
    expect(p.scopes).toEqual([A]);   // one scope window, for the target only
  });
  it('the tenant sees the change: one settings.change access-log line in the TARGET tenant naming the field, none in the other', async () => {
    const { ctx } = await ctxFor(A); await upload(ctx, A);
    expect(f.data(A).accessLog).toEqual([expect.objectContaining({ action: 'settings.change', entityType: 'tenant_settings', entityId: A, outcome: 'allowed', detail: { fields: 'logo_asset_id' } })]);
    expect(f.data(B).accessLog).toEqual([]);
  });
  it('a logo for tenant B lands under B only (A keeps its own)', async () => {
    const a = await ctxFor(A); const ra = await upload(a.ctx, A);
    const b = await ctxFor(B); const rb = await upload(b.ctx, B, S.incoming(S.png(20, 20)));
    expect(R.settingsOf(A)['logo_asset_id']).toBe(ra.body.asset_id); expect(R.settingsOf(B)['logo_asset_id']).toBe(rb.body.asset_id);
    expect(b.k.storageKeys()).toEqual([`identity-assets|${B}/branding/${rb.body.asset_id}.png`]);
    expect(R.st.assets.map((x) => [x.tenant_id, x.id])).toEqual([[A, ra.body.asset_id], [B, rb.body.asset_id]]);
  });
  it('the object key is built from the path tenant: storage bound to another tenant refuses it and nothing is written', async () => {
    const { k, ctx } = await ctxFor(B);   // storage of B, request names A
    const e = await rejection(upload(ctx, A));
    expect(e).toBeTruthy(); nothingStored(k);
  });
  it('the client filename never reaches the key (traversal into another tenant)', async () => {
    const { k, ctx } = await ctxFor(A); const r = await upload(ctx, A, S.incoming(S.png(), `../../${B}/branding/evil.png`));
    expect(k.storageKeys()).toEqual([`identity-assets|${A}/branding/${r.body.asset_id}.png`]);
  });
  it.each([['unknown tenant', UNKNOWN_TENANT], ['malformed id', `${A}/../${B}`], ['missing id', undefined]])('%s -> 404 common.not_found before any byte is stored', async (_n, id) => {
    const { k, p, ctx } = await ctxFor(A); const e = await rejection(upload(ctx, id));
    expect(e.code).toBe('common.not_found'); nothingStored(k); expect(p.scopes).toEqual([]);
  });
  it('platform_support (no platform.tenant.manage) -> auth.forbidden; nothing read, nothing stored', async () => {
    const { k, p, ctx } = await ctxFor(A, { platformRole: 'platform_support' }); const e = await rejection(upload(ctx, A));
    expect(e.code).toBe('auth.forbidden'); nothingStored(k); expect(f.calls).toEqual([]); expect(p.scopes).toEqual([]);
  });
  it('super admin without MFA (aal1) -> auth.mfa_required; nothing stored', async () => {
    const { k, ctx } = await ctxFor(A, { aal: 'aal1' }); const e = await rejection(upload(ctx, A));
    expect(e.code).toBe('auth.mfa_required'); nothingStored(k);
  });
  it('a tenant staff context (no platform role) cannot use the platform path: auth.forbidden', async () => {
    const { k, ctx } = await ctxFor(A, { platformRole: undefined, tenantId: B });
    expect((await rejection(upload(ctx, A))).code).toBe('auth.forbidden'); nothingStored(k);
  });
  it.each(['signature', 'favicon', '', undefined, 7])('kind %s -> 400 common.validation_failed at /kind; nothing stored', async (kind) => {
    // called directly: the helper's default parameter would turn an explicit `undefined` kind into 'logo'
    const { k, ctx } = await ctxFor(A); const e = await rejection(svc.uploadBrandingAssetAsPlatform(ctx, { tenantId: A, file: S.incoming(S.png()), kind }));
    expect(e.code).toBe('common.validation_failed'); expect(e.errors?.[0]?.path ?? e.fieldErrors?.[0]?.path ?? '/kind').toBe('/kind'); nothingStored(k);
  });
  it('a file that is not an image is refused by the upload pipeline; nothing stored', async () => {
    const { k, ctx } = await ctxFor(A); const e = await rejection(upload(ctx, A, S.incoming(Buffer.from('<svg onload=alert(1)>'), 'logo.png', 'image/png')));
    expect(e).toBeTruthy(); nothingStored(k);
  });
  it('an infected file is refused; nothing stored', async () => {
    const { k, ctx } = await ctxFor(A);
    const e = await rejection(upload(ctx, A, S.incoming(Buffer.concat([S.png(), Buffer.from(S.EICAR, 'latin1')]))));
    expect(e.code).toBe('common.upload_quarantined'); nothingStored(k);
  });
  it('scanner unavailable -> stored as pending and a re-scan job is queued for the TARGET tenant', async () => {
    const { ctx } = await ctxFor(A, {}, 'unavailable'); const r = await upload(ctx, A);
    expect(r.body.scan_state).toBe('pending');
    expect(f.jobs).toEqual([{ identifier: 'identity.rescan_upload', payload: { tenant_id: A, asset_id: r.body.asset_id, kind: 'logo' }, jobKey: `rescan:branding_assets:${r.body.asset_id}` }]);
  });
  it('a refused row leaves no orphan object in storage', async () => {
    const { k, ctx } = await ctxFor(A); R.fail['insertAsset'] = new Error('synthetic insert failure');
    await rejection(upload(ctx, A));
    expect(k.storageKeys()).toEqual([]); expect(R.settingsOf(A)['logo_asset_id']).toBeNull();
  });
  it('an offboarded tenant gets nothing new: 409 common.version_conflict', async () => {
    world('offboarded'); const { k, ctx } = await ctxFor(A);
    expect((await rejection(upload(ctx, A))).code).toBe('common.version_conflict'); nothingStored(k);
  });
});
