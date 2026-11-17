// T16 branding assets: uploadBrandingAsset + getBrandingAssetContent (01-PRD US-C4; 02-TRD s5.6, s10 identity.rescan_upload; 03-APP-FLOW s6.2;
// 08 A13 P-2, A17 P-19; 07-SECURITY D-T20, A-22, REQ-SEC-083..085). Runs the REAL core pipeline (createUploads magic-byte/size/re-encode/scan + createStorage
// + createDownload) over an in-memory raw storage; the scanner is a stub that flags the EICAR string. Repos = fakes of settings.helpers.ts.
// The identity.rescan_upload JOB is another task: "re-scan sets clean" is simulated by flipping scan_state on the fake row.
import { beforeEach, describe, expect, it } from 'vitest';
import { ASSET_A1, ASSET_A_PENDING, ASSET_A_QUAR, ASSET_A_SIG, ASSET_B1, EICAR, TENANT_A, TENANT_B, assetRow, incoming, makeCtx, makeRepos, png, rejection, type Repos } from './settings.helpers.js';
import { pngBomb } from '../../../../core/storage/__tests__/helpers.js';

const { createSettingsService } = await import('../settings.service.js');

let R: Repos; let invalidated: string[]; let svc: ReturnType<typeof createSettingsService>;
const NIL_ID = '0190a000-0000-7000-8000-0000000fffff';
const make = (assets: ReturnType<typeof assetRow>[] = []) => {
  R = makeRepos({ assets }); invalidated = [];
  svc = createSettingsService({ repo: R.settingsRepo, flagsRepo: R.flagsRepo, port: { invalidateTenantSettings: (t: string) => { invalidated.push(t); } } } as any);
};
beforeEach(() => make());
// rest args, not default params: an explicit `undefined` kind must reach the service (a default would swap it for 'logo')
const upload = async (file: ReturnType<typeof incoming>, ...a: [kind?: unknown, c?: Awaited<ReturnType<typeof makeCtx>>]) => {
  const kind = a.length > 0 ? a[0] : 'logo'; const k = a[1] ?? (await makeCtx()); return { k, p: svc.uploadBrandingAsset(k.ctx, { file, kind } as any) as Promise<any> };
};
const nothingPersisted = (k: Awaited<ReturnType<typeof makeCtx>>) => {
  expect(R.st.assets).toHaveLength(0); expect(R.st.jobs).toHaveLength(0); expect(R.writes).toEqual([]); expect(k.storageKeys()).toEqual([]); expect(invalidated).toEqual([]);
};
const withTail = (b: Buffer, tail: string) => Buffer.concat([b, Buffer.from(tail, 'latin1')]);

describe('US-C4 upload of a clean PNG', () => {
  it('201 BrandingAsset {asset_id, kind, width, height, sha256 hex64, scan_state clean}; no extra keys', async () => {
    const { p } = await upload(incoming(png(40, 12)), 'logo'); const r = await p;
    expect(r.status).toBe(201); expect(Object.keys(r.body).sort()).toEqual(['asset_id', 'height', 'kind', 'scan_state', 'sha256', 'width']);
    expect(r.body).toMatchObject({ kind: 'logo', width: 40, height: 12, scan_state: 'clean' }); expect(r.body.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.asset_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it('row: bucket identity-assets, object_path <tenant>/branding/<asset_id>.png, image/png, clean, no job; object is stored once under that key', async () => {
    const { k, p } = await upload(incoming(png(40, 12))); const r = await p; const row = R.st.assets[0]!;
    expect(row).toMatchObject({ id: r.body.asset_id, tenant_id: TENANT_A, kind: 'logo', membership_id: null, bucket: 'identity-assets', content_type: 'image/png', width_px: 40, height_px: 12, scan_state: 'clean' });
    expect(row.object_path).toBe(`${TENANT_A}/branding/${r.body.asset_id}.png`); expect(row.sha256).toBe(r.body.sha256);
    expect(k.storageKeys()).toEqual([`identity-assets|${row.object_path}`]); expect(R.st.jobs).toEqual([]);
    expect(R.calls.find((c) => c.m === 'insertAsset')!).toMatchObject({ tenantId: TENANT_A, tx: k.ctx.tx });
  });
  it.each([['logo', 'logo_asset_id'], ['letterhead_header', 'letterhead_header_asset_id'], ['letterhead_footer', 'letterhead_footer_asset_id']])(
    'kind %s updates tenant_settings.%s to the new asset (old asset kept) and invalidates the settings cache', async (kind, col) => {
      const old = assetRow({ id: ASSET_A1, tenant_id: TENANT_A, kind }); make([old]); R.settingsOf(TENANT_A)[col] = ASSET_A1;
      const { p } = await upload(incoming(png()), kind); const r = await p;
      expect(R.settingsOf(TENANT_A)[col]).toBe(r.body.asset_id); expect(R.st.assets.map((a) => a.id)).toContain(ASSET_A1); expect(R.st.assets.find((a) => a.id === ASSET_A1)!.scan_state).toBe('clean');
      expect(invalidated).toEqual([TENANT_A]); expect(R.settingsOf(TENANT_B)['logo_asset_id']).toBeNull();
    });
  it('stored bytes are the RE-ENCODED image: still a PNG, planted tEXt metadata gone, bytes differ from the upload', async () => {
    const original = png(8, 8, 'GPS-SENTINEL-4471'); const { k, p } = await upload(incoming(original)); await p;
    const stored = await k.ctx.storage.read('identity-assets', R.st.assets[0]!.object_path);
    expect(Buffer.from(stored).subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    expect(Buffer.from(stored).includes(Buffer.from('GPS-SENTINEL-4471'))).toBe(false); expect(Buffer.from(stored).equals(original)).toBe(false);
  });
  it('the client filename never reaches the key (traversal / unicode names)', async () => {
    const { k, p } = await upload(incoming(png(), '../../other-tenant/evil.png')); await p;
    for (const key of k.storageKeys()) expect(key).toMatch(new RegExp(`^identity-assets\\|${TENANT_A}/branding/[0-9a-f-]{36}\\.png$`));
  });
  it('tenant comes from ctx only: a TENANT_B ctx writes under B and touches no A row', async () => {
    const k = await makeCtx({ tenantId: TENANT_B }); const { p } = await upload(incoming(png()), 'logo', k); await p;
    expect(R.st.assets[0]!.tenant_id).toBe(TENANT_B); expect(R.st.assets[0]!.object_path.startsWith(`${TENANT_B}/`)).toBe(true); expect(R.settingsOf(TENANT_A)['logo_asset_id']).toBeNull();
  });
  it.each(['signature', 'avatar', '', null, undefined, 7])('kind %j -> 400 common.validation_failed at /kind; nothing stored', async (kind) => {
    const { k, p } = await upload(incoming(png()), kind); const e = await rejection(p);
    expect(e.code).toBe('common.validation_failed'); expect(e.errors?.map((x: any) => x.path)).toEqual(['/kind']); nothingPersisted(k);
  });
});

describe('upload rejection corpus - every rejection stores nothing, queues nothing, changes no setting', () => {
  const big = Buffer.concat([png(), Buffer.alloc(2 * 1024 * 1024 + 1, 7)]);
  const cases: Array<[string, () => ReturnType<typeof incoming>, string, number]> = [
    ['SVG named .svg', () => incoming(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'logo.svg', 'image/svg+xml'), 'common.unsupported_media_type', 415],
    ['SVG renamed .png with image/png', () => incoming(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), 'common.unsupported_media_type', 415],
    ['HTML renamed .png', () => incoming(Buffer.from('<html><script>alert(1)</script></html>')), 'common.unsupported_media_type', 415],
    ['PDF bytes named .png', () => incoming(Buffer.from('%PDF-1.7\n%%EOF\n')), 'common.unsupported_media_type', 415],
    ['PDF polyglot: %PDF header + PNG inside, named .png', () => incoming(Buffer.concat([Buffer.from('%PDF-1.7\n'), png()])), 'common.unsupported_media_type', 415],
    ['declared mime lies (png bytes, image/svg+xml)', () => incoming(png(), 'logo.png', 'image/svg+xml'), 'common.unsupported_media_type', 415],
    ['double extension logo.png.html', () => incoming(png(), 'logo.png.html', 'image/png'), 'common.unsupported_media_type', 415],
    ['empty file', () => incoming(Buffer.alloc(0)), 'common.unsupported_media_type', 415],
    ['oversize (> 2 MB)', () => incoming(big), 'common.payload_too_large', 413],
    ['decompression bomb (50000 x 50000 claimed)', () => incoming(pngBomb(50000, 50000)), 'common.upload_quarantined', 422],
    ['EICAR appended to a valid PNG', () => incoming(withTail(png(), EICAR)), 'common.upload_quarantined', 422],
    ['EICAR in a tEXt-free polyglot tail after IEND', () => incoming(withTail(png(4, 4), `\n${EICAR}\n<script>1</script>`)), 'common.upload_quarantined', 422],
  ];
  it.each(cases)('%s', async (_n, mk, code, status) => {
    const { k, p } = await upload(mk()); const e = await rejection(p);
    expect(e.code).toBe(code); expect(e.statusCode).toBe(status); nothingPersisted(k); expect(R.settingsOf(TENANT_A)['logo_asset_id']).toBeNull();
  });
  it('width or height above 4000 px (the DB dims CHECK) is refused, never stored, never a 5xx', async () => {
    const { k, p } = await upload(incoming(png(4001, 1))); const e = await rejection(p);
    expect(['common.payload_too_large', 'common.validation_failed', 'common.upload_quarantined']).toContain(e.code); expect(e.statusCode).toBeLessThan(500); nothingPersisted(k);
  });
  it('polyglot PNG + trailing <script>/HTML (clean scan) is either refused or stored SANITISED: no script text survives in the stored object', async () => {
    const k = await makeCtx(); const { p } = await upload(incoming(withTail(png(), '<script>alert(document.cookie)</script><html>')), 'logo', k);
    const e = await p.then(() => undefined, (x: any) => x);
    if (e) { expect(e.statusCode).toBeLessThan(500); nothingPersisted(k); return; }
    const stored = Buffer.from(await k.ctx.storage.read('identity-assets', R.st.assets[0]!.object_path));
    expect(stored.includes(Buffer.from('<script'))).toBe(false); expect(stored.includes(Buffer.from('<html'))).toBe(false);
  });
  it('a rejected upload writes no access-log row and does not call the pointer update', async () => {
    const k = await makeCtx(); await rejection(upload(incoming(withTail(png(), EICAR)), 'logo', k).then((x) => x.p)); expect(k.access).toEqual([]);
    expect(R.calls.filter((c) => c.m === 'setAssetPointer')).toEqual([]);
  });
});

describe('P-19 scanner down: stored as pending, content 422 until the re-scan sets clean', () => {
  it.each(['unavailable', 'throw'] as const)('scanner %s -> 201 scan_state pending, row pending, object stored, identity.rescan_upload enqueued with job_key rescan:branding_assets:<asset_id>', async (mode) => {
    const k = await makeCtx({ scan: mode }); const { p } = await upload(incoming(png()), 'logo', k); const r = await p;
    expect(r.status).toBe(201); expect(r.body.scan_state).toBe('pending'); const row = R.st.assets[0]!; expect(row.scan_state).toBe('pending');
    expect(k.storageKeys()).toEqual([`identity-assets|${row.object_path}`]);
    expect(R.st.jobs).toHaveLength(1); const j = R.st.jobs[0]!;
    expect(j.taskIdentifier).toBe('identity.rescan_upload'); expect(j.jobKey).toBe(`rescan:branding_assets:${r.body.asset_id}`);
    expect(JSON.stringify(j.payload)).toContain(r.body.asset_id); expect(JSON.stringify(j.payload)).toContain(TENANT_A);
    expect(JSON.stringify(j.payload)).not.toMatch(/base64|bytes/i);   // payload carries ids, never file content
    expect(R.calls.find((c) => c.m === 'enqueueJob')!.tx).toBe(k.ctx.tx);   // same tx as the row: committed together
    // 03-APP-FLOW s6.2: the pointer is updated on upload even while pending (content stays 422 until clean); the re-scan job only sets scan_state
    const ptr = R.calls.filter((c) => c.m === 'setAssetPointer'); expect(ptr).toHaveLength(1);
    expect(ptr[0]!).toMatchObject({ tx: k.ctx.tx, tenantId: TENANT_A }); expect(ptr[0]!.args.slice(0, 2)).toEqual(['logo_asset_id', r.body.asset_id]);
    expect(R.settingsOf(TENANT_A)['logo_asset_id']).toBe(r.body.asset_id); expect(invalidated).toEqual([TENANT_A]);
  });
  it('end to end: upload (scanner down) -> content 422 (pending, any number of times) -> job result clean -> content 200 with the stored bytes', async () => {
    const k = await makeCtx({ scan: 'unavailable' }); const r = await (await upload(incoming(png(6, 6)), 'logo', k)).p; const id = r.body.asset_id;
    for (let i = 0; i < 2; i++) { const e = await rejection(svc.getBrandingAssetContent(k.ctx, { assetId: id } as any)); expect(e.code).toBe('common.upload_quarantined'); expect(e.statusCode).toBe(422); }
    R.st.assets[0]!.scan_state = 'clean';   // what identity.rescan_upload does on a clean re-scan
    const ok: any = await svc.getBrandingAssetContent(k.ctx, { assetId: id } as any); expect(ok.status).toBe(200);
    expect(Buffer.from(ok.body).equals(Buffer.from(await k.ctx.storage.read('identity-assets', R.st.assets[0]!.object_path)))).toBe(true);
  });
  it('a re-scan result infected -> quarantined (terminal) -> content stays 422', async () => {
    const k = await makeCtx({ scan: 'unavailable' }); const r = await (await upload(incoming(png()), 'logo', k)).p;
    R.st.assets[0]!.scan_state = 'quarantined'; expect((await rejection(svc.getBrandingAssetContent(k.ctx, { assetId: r.body.asset_id } as any))).code).toBe('common.upload_quarantined');
  });
  it('a clean scan enqueues no re-scan job; an infected one enqueues none either (rejected outright)', async () => {
    await (await upload(incoming(png()))).p; expect(R.st.jobs).toEqual([]);
  });
});

describe('getBrandingAssetContent per P-2', () => {
  const seed = async (rows: ReturnType<typeof assetRow>[] = [assetRow({ id: ASSET_A1, tenant_id: TENANT_A })]) => {
    make(rows); const k = await makeCtx(); const bytes = png(5, 5);
    for (const r of rows.filter((x) => x.tenant_id === TENANT_A)) await k.ctx.storage.put(r.bucket, r.object_path, bytes, { contentType: r.content_type });
    k.raw.calls.length = 0; return { k, bytes };
  };
  it('200 streams the stored bytes with attachment + nosniff + no-store and the stored content type', async () => {
    const { k, bytes } = await seed(); const r: any = await svc.getBrandingAssetContent(k.ctx, { assetId: ASSET_A1 } as any);
    expect(r.status).toBe(200); expect(Buffer.from(r.body).equals(bytes)).toBe(true);
    expect(r.headers['content-disposition']).toMatch(/^attachment/); expect(r.headers['x-content-type-options']).toBe('nosniff'); expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['content-type']).toBe('image/png'); expect(r.headers['content-disposition']).not.toMatch(/^inline/);
  });
  it('never exposes a signed URL: raw storage sign() is not called, no header/body mentions a URL', async () => {
    const { k } = await seed(); const r: any = await svc.getBrandingAssetContent(k.ctx, { assetId: ASSET_A1 } as any);
    expect(k.raw.calls).not.toContain('sign'); expect(JSON.stringify(r.headers)).not.toMatch(/https?:|token=|storage\.invalid/);
  });
  it('EVERY successful call writes branding_asset.download / branding_asset / entityId=asset / allowed', async () => {
    const { k } = await seed(); for (let i = 0; i < 3; i++) await svc.getBrandingAssetContent(k.ctx, { assetId: ASSET_A1 } as any);
    expect(k.access).toHaveLength(3);
    for (const a of k.access) expect(a).toMatchObject({ action: 'branding_asset.download', entityType: 'branding_asset', entityId: ASSET_A1, outcome: 'allowed' });
  });
  it.each([['pending', ASSET_A_PENDING], ['quarantined', ASSET_A_QUAR]] as const)('scan_state %s -> 422 common.upload_quarantined, NO bytes read, a denied access-log row is written and commitOnError() keeps it', async (state, id) => {
    const { k } = await seed([assetRow({ id, tenant_id: TENANT_A, scan_state: state })]);
    const e = await rejection(svc.getBrandingAssetContent(k.ctx, { assetId: id } as any));
    expect(e.code).toBe('common.upload_quarantined'); expect(e.statusCode).toBe(422); expect(k.raw.calls).not.toContain('get');
    expect(k.access).toHaveLength(1); expect(k.access[0]).toMatchObject({ action: 'branding_asset.download', entityType: 'branding_asset', entityId: id, outcome: 'denied' });
    expect(k.ctx.commitOnError).toHaveBeenCalled();
  });
  it.each([
    ['unknown id', NIL_ID], ['another tenant\'s asset (P-2/P-3 probe)', ASSET_B1], ['a staff signature image (D-26: not a branding kind)', ASSET_A_SIG], ['malformed id', 'not-a-uuid'], ['path-like id', '../../etc/passwd'],
  ])('%s -> 404 common.not_found, no storage read, no bytes', async (_n, id) => {
    const { k } = await seed([assetRow({ id: ASSET_A1, tenant_id: TENANT_A }), assetRow({ id: ASSET_B1, tenant_id: TENANT_B }),
      assetRow({ id: ASSET_A_SIG, tenant_id: TENANT_A, kind: 'signature', membership_id: NIL_ID, object_path: `${TENANT_A}/signatures/${NIL_ID}/${ASSET_A_SIG}.png` })]);
    const e = await rejection(svc.getBrandingAssetContent(k.ctx, { assetId: id } as any));
    expect(e.code).toBe('common.not_found'); expect(e.statusCode).toBe(404); expect(k.raw.calls).not.toContain('get');
    expect(k.access.filter((a) => a.outcome === 'allowed')).toEqual([]);
  });
  it('looks the asset up with the context tenant and ctx.tx', async () => {
    const { k } = await seed(); await svc.getBrandingAssetContent(k.ctx, { assetId: ASSET_A1 } as any);
    expect(R.calls.find((c) => c.m === 'findAsset')).toMatchObject({ tenantId: TENANT_A, tx: k.ctx.tx });
  });
  it('previous (inactive) assets stay readable for re-rendering old reports', async () => {
    const { k } = await seed([assetRow({ id: ASSET_A1, tenant_id: TENANT_A, is_active: false })]);
    expect(((await svc.getBrandingAssetContent(k.ctx, { assetId: ASSET_A1 } as any)) as any).status).toBe(200);
  });
});
