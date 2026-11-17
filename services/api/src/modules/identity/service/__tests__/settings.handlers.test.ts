// T16 HTTP wiring of getSettings, updateSettings, uploadBrandingAsset, getBrandingAssetContent, listFeatureFlags, setTenantFeatureFlag, listOwnIrdAnnexes
// (02-TRD s5.6; contracts/openapi/identity.yaml). The SERVICE is mocked (behaviour: settings.service.test.ts / branding.service.test.ts): these tests fix
// req -> service input mapping, status codes, ETag / If-Match, header passthrough, mass-assignment and fail-closed behaviour.
// ASSUMED: multipart layer hands the handler body = { file: { filename, mimeType, bytes }, kind } (same as reporting narrative upload).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { LimsError } from '../../../../core/errors.js';
import { REPO_ROOT } from '../../../../core/module.js';
import { ASSET_A1, TENANT_A, TENANT_B, idN, rejection } from './settings.helpers.js';

const svc: Record<string, ReturnType<typeof vi.fn>> = {};
const OPS = ['getSettings', 'updateSettings', 'uploadBrandingAsset', 'getBrandingAssetContent', 'listFeatureFlags', 'setTenantFeatureFlag', 'listOwnIrdAnnexes'];
vi.mock('../settings.service.js', () => ({ createSettingsService: () => svc }));
const { manifest } = await import('../../index.js');
const h = (op: string): any => (manifest.handlers as any)[op];

const noop = { info() {}, warn() {}, error() {} };
const hctx = (operationId: string) => ({ operationId, clientIp: '203.0.113.9', log: noop, tenantId: TENANT_A, actor: { type: 'user', id: idN(0xd1), membershipId: idN(0xd2) }, requestId: idN(0xe1), tx: { __tx: 1 } });
const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
beforeEach(() => { for (const op of OPS) svc[op] = vi.fn(async () => ({ status: 200, body: { ok: op }, version: 5 })); });
const file = { filename: 'logo.png', mimeType: 'image/png', bytes: new Uint8Array([1, 2, 3]) };

describe('no longer stubs; fail closed without an authenticated request context', () => {
  it.each(OPS)('%s: no context -> auth.unauthenticated (the stub answers common.internal); service never called', async (op) => {
    const e = await rejection(h(op)(req(), { operationId: op, clientIp: '203.0.113.9', log: noop }));
    expect(e?.code).toBe('auth.unauthenticated'); expect(svc[op]).not.toHaveBeenCalled();
  });
  it('service errors propagate unchanged and echo no request input', async () => {
    const planted = 'PLANTED-TOKEN-9f3a'; svc['getBrandingAssetContent']!.mockRejectedValueOnce(new LimsError('common.upload_quarantined'));
    const e = await rejection(h('getBrandingAssetContent')(req({ params: { asset_id: planted }, headers: { authorization: planted } }), hctx('getBrandingAssetContent')));
    expect(e.code).toBe('common.upload_quarantined'); expect(JSON.stringify({ c: e.code, m: e.message, d: e.detail })).not.toContain(planted);
  });
});

describe('settings', () => {
  it('getSettings: 200 body passthrough + ETag "<version>"', async () => {
    const r = await h('getSettings')(req(), hctx('getSettings'));
    expect(svc['getSettings']).toHaveBeenCalledTimes(1); expect(r.status).toBe(200); expect(r.body).toEqual({ ok: 'getSettings' }); expect(r.headers?.etag).toBe('"5"');
  });
  it('updateSettings: If-Match -> expectedVersion; body passed as patch; 200 + new ETag', async () => {
    const body = { idle_timeout_minutes: 20, accent_color: '#1A73E8', unset: ['website'] };
    const r = await h('updateSettings')(req({ headers: { 'if-match': '"4"' }, body }), hctx('updateSettings'));
    expect(svc['updateSettings']).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_A }), { expectedVersion: 4, patch: body }); expect(r.status).toBe(200); expect(r.headers?.etag).toBe('"5"');
  });
  it('updateSettings: the tenant given to the service is the context tenant, never one from body/query', async () => {
    await h('updateSettings')(req({ headers: { 'if-match': '"4"' }, body: { tenant_id: TENANT_B, idle_timeout_minutes: 20 }, query: { tenant_id: TENANT_B } }), hctx('updateSettings'));
    expect(svc['updateSettings']!.mock.calls[0]![0].tenantId).toBe(TENANT_A);
    const input = svc['updateSettings']!.mock.calls[0]![1]; expect(Object.keys(input).sort()).toEqual(['expectedVersion', 'patch']);
  });
  it('updateSettings If-Match: absent -> expectedVersion undefined (service answers 428); malformed -> 0 or undefined (400/428), never a crash', async () => {
    await h('updateSettings')(req({ body: { idle_timeout_minutes: 20 } }), hctx('updateSettings')); expect(svc['updateSettings']!.mock.calls[0]![1].expectedVersion).toBeUndefined();
    for (const bad of ['4', 'W/"4"', '"0"', '"-1"', '"1.5"', '"abc"', '"99999999999"', '*', '']) {
      svc['updateSettings']!.mockClear(); await h('updateSettings')(req({ headers: { 'if-match': bad }, body: {} }), hctx('updateSettings'));
      expect([0, undefined]).toContain(svc['updateSettings']!.mock.calls[0]![1].expectedVersion);
    }
  });
});

describe('branding', () => {
  it('uploadBrandingAsset: file + kind forwarded; 201 body passthrough; no ETag needed', async () => {
    svc['uploadBrandingAsset']!.mockResolvedValueOnce({ status: 201, body: { asset_id: ASSET_A1 } });
    const r = await h('uploadBrandingAsset')(req({ body: { file, kind: 'logo', tenant_id: TENANT_B, membership_id: idN(1) } }), hctx('uploadBrandingAsset'));
    expect(svc['uploadBrandingAsset']).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_A }), { file, kind: 'logo' }); expect(r.status).toBe(201);
    expect(Object.keys(svc['uploadBrandingAsset']!.mock.calls[0]![1]).sort()).toEqual(['file', 'kind']);
  });
  it('getBrandingAssetContent: path asset_id -> assetId; the service result (status, bytes, Content-Disposition / nosniff / no-store headers) is returned UNCHANGED', async () => {
    const headers = { 'content-type': 'image/png', 'content-disposition': 'attachment; filename="x.png"', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'content-length': '3' };
    const bytes = new Uint8Array([1, 2, 3]); svc['getBrandingAssetContent']!.mockResolvedValueOnce({ status: 200, headers, body: bytes });
    const r = await h('getBrandingAssetContent')(req({ params: { asset_id: ASSET_A1 } }), hctx('getBrandingAssetContent'));
    expect(svc['getBrandingAssetContent']).toHaveBeenCalledWith(expect.anything(), { assetId: ASSET_A1 }); expect(r.status).toBe(200); expect(r.body).toBe(bytes);
    expect(r.headers).toMatchObject({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); expect(String(r.headers['content-disposition'])).toMatch(/^attachment/);
  });
  it('getBrandingAssetContent: a handler never loosens the headers (no inline, no cache) even if a service result lacked them -> fails closed or forwards only service headers', async () => {
    svc['getBrandingAssetContent']!.mockResolvedValueOnce({ status: 200, headers: {}, body: new Uint8Array([1]) });
    const r = await h('getBrandingAssetContent')(req({ params: { asset_id: ASSET_A1 } }), hctx('getBrandingAssetContent'));
    expect(String(r.headers?.['content-disposition'] ?? 'attachment')).not.toMatch(/inline/i); expect(String(r.headers?.['cache-control'] ?? 'no-store')).toBe('no-store');
  });
});

describe('flags and IRD', () => {
  it('listFeatureFlags / listOwnIrdAnnexes: 200 passthrough, no ETag', async () => {
    for (const op of ['listFeatureFlags', 'listOwnIrdAnnexes']) { const r = await h(op)(req(), hctx(op)); expect(svc[op]).toHaveBeenCalledTimes(1); expect(r.status).toBe(200); expect(r.headers?.etag).toBeUndefined(); }
  });
  it('setTenantFeatureFlag: path flag_code + If-Match + is_enabled -> service input; other body keys dropped; 200 + ETag', async () => {
    const r = await h('setTenantFeatureFlag')(req({ params: { flag_code: 'referral_incentive_report' }, headers: { 'if-match': '"1"' }, body: { is_enabled: true, approval_ref: 'FOUNDER-1', tenant_id: TENANT_B } }), hctx('setTenantFeatureFlag'));
    expect(svc['setTenantFeatureFlag']).toHaveBeenCalledWith(expect.anything(), { flagCode: 'referral_incentive_report', isEnabled: true, expectedVersion: 1 }); expect(r.status).toBe(200); expect(r.headers?.etag).toBe('"5"');
  });
  it('setTenantFeatureFlag If-Match absent -> expectedVersion undefined (service 428)', async () => {
    await h('setTenantFeatureFlag')(req({ params: { flag_code: 'smart_report' }, body: { is_enabled: true } }), hctx('setTenantFeatureFlag'));
    expect(svc['setTenantFeatureFlag']!.mock.calls[0]![1].expectedVersion).toBeUndefined();
  });
});

describe('contract (contracts/openapi/identity.yaml)', () => {
  const spec = parse(readFileSync(join(REPO_ROOT, 'contracts', 'openapi', 'identity.yaml'), 'utf8'));
  const ops: Record<string, any> = {};
  for (const item of Object.values<any>(spec.paths)) for (const m of ['get', 'post', 'put', 'delete', 'patch']) if (item[m]?.operationId) ops[item[m].operationId] = item[m];
  it.each([
    ['getSettings', 'none', []], ['updateSettings', 'optional', ['identity.setting_out_of_range', 'auth.forbidden', 'common.version_conflict', 'common.precondition_required']],
    ['uploadBrandingAsset', 'required', ['common.payload_too_large', 'common.unsupported_media_type', 'common.upload_quarantined']], ['getBrandingAssetContent', 'none', ['common.upload_quarantined']],
    ['listFeatureFlags', 'none', []], ['setTenantFeatureFlag', 'optional', ['auth.forbidden', 'common.version_conflict', 'common.precondition_required']], ['listOwnIrdAnnexes', 'none', []],
  ])('%s: x-permission identity.settings.manage, x-idempotency %s, x-error-codes include %j', (op, idem, codes) => {
    expect(ops[op]['x-permission']).toBe('identity.settings.manage'); expect(ops[op]['x-idempotency']).toBe(idem);
    for (const c of codes) expect(ops[op]['x-error-codes']).toContain(c);
  });
  it('upload accepts only image/png + image/jpeg; the content route is a GET with attachment/nosniff/no-store response headers', () => {
    expect(ops['uploadBrandingAsset']['x-upload']).toEqual(['image/png', 'image/jpeg']);
    const hs = ops['getBrandingAssetContent'].responses['200'].headers; expect(Object.keys(hs).sort()).toEqual(['Cache-Control', 'Content-Disposition', 'X-Content-Type-Options']);
    expect(hs['Cache-Control'].schema.enum).toEqual(['no-store']);
  });
  it('registered error codes exist in contracts/errors.yaml with the right status (422 setting_out_of_range / upload_quarantined, 403 forbidden)', () => {
    const errs: Array<{ code: string; http: number }> = parse(readFileSync(join(REPO_ROOT, 'contracts', 'errors.yaml'), 'utf8'));
    const http = (c: string) => errs.find((e) => e.code === c)?.http;
    expect([http('identity.setting_out_of_range'), http('common.upload_quarantined'), http('auth.forbidden'), http('common.payload_too_large'), http('common.unsupported_media_type')]).toEqual([422, 422, 403, 413, 415]);
  });
});
