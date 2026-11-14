// C9 T-20 — HTTP wiring of #51-#54 (02-TRD §5.8; contracts/openapi/quality.yaml). The SERVICE is mocked (behaviour: settings.service.test.ts): these tests fix req -> service input mapping,
// status/body passthrough, ETag, fail-closed behaviour, the phase switch and the contract flags the core pipeline enforces.
// Handlers live in handlers/settings.handlers.ts (`settingsHandlers`), merged into handlers/index.ts behind the phase switch. Fails now: the T-01 stubs answer 501 / common.internal.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { REPO_ROOT } from '../../../core/module.js';
import { makePlanCtx } from './plan.helpers.js';
import { CODE_KEYS, MUTABLE, SETTINGS_KEYS, rejection } from './settings.helpers.js';

const svc: Record<string, ReturnType<typeof vi.fn>> = {};
vi.mock('../service/settings.service.js', () => ({ createSettingsService: () => svc }));
vi.stubEnv('LIMS_QUALITY_ENABLED', 'true');   // read once at module load (handlers/index.ts): enable BEFORE the import
const { manifest } = await import('../index.js');
const h = (op: string): any => (manifest.handlers as any)[op];
const OPS = ['getQualitySettings', 'updateQualitySettings', 'listQualityCodedSet', 'upsertQualityCode'] as const;

const hctx = (op: string) => ({ operationId: op, clientIp: '203.0.113.9', ...makePlanCtx().ctx });
const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
const DTO = { version: 3, tat_alerts_enabled: true, tat_warn_pct: 80, default_plan_params: {}, westgard_mode: 'classic', auto_verification_enabled: false };
const CODE = { code: 'recalibrated', display: 'Synthetic recalibration', sort_order: 10, is_active: true, source: 'tenant' };
beforeEach(() => {
  svc['getQualitySettings'] = vi.fn(async () => ({ status: 200, body: DTO, version: 3 }));
  svc['updateQualitySettings'] = vi.fn(async () => ({ status: 200, body: DTO, version: 3 }));
  svc['listQualityCodedSet'] = vi.fn(async () => ({ status: 200, body: { data: [CODE] } }));
  svc['upsertQualityCode'] = vi.fn(async () => ({ status: 200, body: CODE }));
});

describe('#51-#54 are real handlers, fail closed', () => {
  for (const op of OPS) {
    it(`${op}: no authenticated context -> auth.unauthenticated (the stub answers 501 / common.internal); the service is never called`, async () => {
      const e = await rejection(h(op)(req(), { operationId: op, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } }));
      expect(e?.code).toBe('auth.unauthenticated'); expect(svc[op]).not.toHaveBeenCalled();
    });
    it(`${op}: a context without tenant, actor or transaction is refused too`, async () => {
      for (const bad of [{ tenantId: 'T', actor: { id: 'U' } }, { tenantId: 'T', tx: {} }, { actor: { id: 'U' }, tx: {} }]) expect((await rejection(h(op)(req(), { operationId: op, log: { info() {}, warn() {}, error() {} }, ...bad })))?.code).toBe('auth.unauthenticated');
      expect(svc[op]).not.toHaveBeenCalled();
    });
    it(`${op}: service errors propagate untouched (validation, forbidden, conflict, precondition) and echo no request input`, async () => {
      const planted = 'PLANTED-TOKEN-9f3a';
      for (const c of ['common.validation_failed', 'auth.forbidden', 'common.version_conflict', 'common.precondition_required']) {
        svc[op]!.mockRejectedValueOnce(Object.assign(new Error(c), { code: c }));
        const e = await rejection(h(op)(req({ params: { set_name: planted, code: planted }, headers: { authorization: planted } }), hctx(op)));
        expect(e?.code).toBe(c); expect(JSON.stringify({ m: e?.message, d: e?.detail })).not.toContain(planted);
      }
    });
  }
  it('LIMS_QUALITY_ENABLED=false: every one rejects common.feature_disabled before anything else and no service is called', async () => {
    vi.resetModules(); vi.stubEnv('LIMS_QUALITY_ENABLED', 'false');
    try { const off: any = (await import('../index.js')).manifest; for (const op of OPS) { expect((await rejection(off.handlers[op](req(), hctx(op))))?.code, op).toBe('common.feature_disabled'); expect(svc[op]).not.toHaveBeenCalled(); } }
    finally { vi.stubEnv('LIMS_QUALITY_ENABLED', 'true'); }
  });
});

describe('request -> service mapping', () => {
  it('#51: no input; 200, body unchanged, ETag "<version>"', async () => {
    const r = await h('getQualitySettings')(req(), hctx('getQualitySettings'));
    expect(svc['getQualitySettings']).toHaveBeenCalledWith(expect.objectContaining({ tenantId: expect.any(String) }), {}); expect(r.status).toBe(200); expect(r.body).toEqual(DTO); expect(r.headers?.etag).toBe('"3"');
  });
  it('#52: If-Match "2" -> expectedVersion 2 and the body untouched; 200 + new ETag', async () => {
    const b = { tat_warn_pct: 85 }; const r = await h('updateQualitySettings')(req({ headers: { 'if-match': '"2"' }, body: b }), hctx('updateQualitySettings'));
    expect(svc['updateQualitySettings']).toHaveBeenCalledWith(expect.anything(), { expectedVersion: 2, body: b }); expect(r.status).toBe(200); expect(r.headers?.etag).toBe('"3"');
  });
  it('#52: no If-Match -> expectedVersion undefined (the service answers 428); malformed If-Match (W/"2", 2, "0", "-1", "abc", "99999999999") -> 400 here, the service is not called', async () => {
    await h('updateQualitySettings')(req({ body: {} }), hctx('updateQualitySettings')); expect(svc['updateQualitySettings']!.mock.calls[0]![1].expectedVersion).toBeUndefined();
    svc['updateQualitySettings']!.mockClear();
    for (const v of ['W/"2"', '2', '"0"', '"-1"', '"abc"', '"99999999999"', '""']) { const e = await rejection(h('updateQualitySettings')(req({ headers: { 'if-match': v }, body: {} }), hctx('updateQualitySettings'))); expect(e?.code, v).toBe('common.validation_failed'); }
    expect(svc['updateQualitySettings']).not.toHaveBeenCalled();
  });
  it('#53: path set_name -> setName; 200; the list carries no ETag', async () => {
    const r = await h('listQualityCodedSet')(req({ params: { set_name: 'exclusion_reasons' } }), hctx('listQualityCodedSet'));
    expect(svc['listQualityCodedSet']).toHaveBeenCalledWith(expect.anything(), { setName: 'exclusion_reasons' }); expect(r.status).toBe(200); expect(r.body).toEqual({ data: [CODE] }); expect(r.headers?.etag).toBeUndefined();
  });
  it('#54: path set_name + code + body -> { setName, code, body }; 200 + the code; no ETag (QualityCode has no version)', async () => {
    const b = { display: 'Synthetic recalibration', sort_order: 10, is_active: true };
    const r = await h('upsertQualityCode')(req({ params: { set_name: 'corrective_actions', code: 'recalibrated' }, body: b }), hctx('upsertQualityCode'));
    expect(svc['upsertQualityCode']).toHaveBeenCalledWith(expect.anything(), { setName: 'corrective_actions', code: 'recalibrated', body: b }); expect(r.status).toBe(200); expect(r.body).toEqual(CODE); expect(r.headers?.etag).toBeUndefined();
  });
  it('tenant_id / created_by in query, header or params never reach a service input; the service gets the request context (tenant, actor, tx)', async () => {
    for (const op of OPS) {
      await h(op)(req({ query: { tenant_id: 'TQ', created_by: 'UQ' }, headers: { 'x-tenant-id': 'TH', 'if-match': '"1"' }, params: { set_name: 'corrective_actions', code: 'abc' }, body: { display: 'x', sort_order: 1, is_active: true } }), hctx(op));
      const [c, input] = svc[op]!.mock.calls[0]!; expect(JSON.stringify(input)).not.toMatch(/"TQ"|"UQ"|"TH"|tenant/); expect(c.tenantId).toBeTruthy(); expect(c.actor.id).toBeTruthy(); expect(c.tx).toBeTruthy();
    }
  });
});

describe('contract flags the core pipeline enforces (contracts/openapi/quality.yaml, 02-TRD §5.8, 05-SCHEMA §2)', () => {
  const doc: any = parse(readFileSync(join(REPO_ROOT, 'contracts', 'openapi', 'quality.yaml'), 'utf8'));
  const find = (op: string) => { for (const [path, item] of Object.entries<any>(doc.paths)) for (const [method, o] of Object.entries<any>(item)) if (o?.operationId === op) return { path, method, o }; throw new Error(`no op ${op}`); };
  const sch = doc.components.schemas;
  it('paths, methods, permissions (read vs quality.config.manage), idempotency, If-Match only on #52', () => {
    const want: Record<string, [string, string, string, string]> = {
      getQualitySettings: ['get', '/v1/quality/settings', 'quality.qc_run.read', 'none'], updateQualitySettings: ['put', '/v1/quality/settings', 'quality.config.manage', 'none'],
      listQualityCodedSet: ['get', '/v1/quality/coded-sets/{set_name}', 'quality.qc_run.read', 'none'], upsertQualityCode: ['put', '/v1/quality/coded-sets/{set_name}/codes/{code}', 'quality.config.manage', 'optional'],
    };
    for (const op of OPS) { const f = find(op); const [m, p, perm, idem] = want[op]!; expect([f.method, f.path, f.o['x-permission'], f.o['x-idempotency'] ?? 'none'], op).toEqual([m, p, perm, idem]); expect(typeof h(op)).toBe('function'); }
    expect(JSON.stringify(find('updateQualitySettings').o.parameters)).toContain('IfMatch');
    for (const op of ['getQualitySettings', 'listQualityCodedSet', 'upsertQualityCode']) expect(JSON.stringify(find(op).o.parameters ?? [])).not.toContain('IfMatch');
    expect(find('updateQualitySettings').o['x-error-codes']).toEqual(expect.arrayContaining(['common.version_conflict', 'common.precondition_required', 'common.validation_failed', 'common.feature_disabled', 'auth.forbidden']));
  });
  it('set_name is the closed enum {corrective_actions, exclusion_reasons}; code is the shared Code type', () => {
    const p = doc.components.parameters; expect(p.SetName.schema.enum).toEqual(['corrective_actions', 'exclusion_reasons']); expect(JSON.stringify(p.CodeParam)).toContain('Code');
  });
  it('#52 request body (REQ-SEC-080): additionalProperties false, exactly the nine mutable fields all required, ranges as §12.1; no tenant_id / version / activated_at / westgard_mode', () => {
    const s = find('updateQualitySettings').o.requestBody.content['application/json'].schema;
    expect(s.additionalProperties).toBe(false); expect(Object.keys(s.properties).sort()).toEqual([...MUTABLE].sort()); expect([...s.required].sort()).toEqual([...MUTABLE].sort());
    const r = (k: string) => [s.properties[k].minimum, s.properties[k].maximum];
    expect([r('tat_warn_pct'), r('tat_escalate_pct'), r('tat_orphan_close_hours'), r('target_min_points'), r('sim_min_days'), r('sim_min_decisions'), r('reprocess_window_days')])
      .toEqual([[50, 99], [101, 1000], [1, 720], [2, 500], [1, 90], [10, 100000], [1, 30]]);
  });
  it('QualitySettingsDto (REQ-SEC-081): closed, exactly the §5.10 fields, same ranges as the request, no tenant_id / created_by / id; westgard_mode classic|modern', () => {
    const d = sch.QualitySettingsDto; expect(d.additionalProperties).toBe(false); expect(Object.keys(d.properties).sort()).toEqual([...SETTINGS_KEYS].sort());
    expect([...d.required]).toEqual(expect.arrayContaining(['version', 'activated_at', 'westgard_mode', 'auto_verification_enabled', 'default_plan_params', ...MUTABLE.filter((k) => k !== 'default_plan_params')]));
    expect(d.properties.westgard_mode.enum).toEqual(['classic', 'modern']); expect(JSON.stringify(d)).not.toMatch(/tenant_id|created_by|updated_by"|"id"/);
    const req52 = find('updateQualitySettings').o.requestBody.content['application/json'].schema; for (const k of MUTABLE.filter((x) => x !== 'default_plan_params')) expect([d.properties[k].minimum, d.properties[k].maximum], k).toEqual([req52.properties[k].minimum, req52.properties[k].maximum]);
  });
  it('QualityCode: closed, code/display/sort_order/is_active/source all required, source global|tenant, display 1..120, sort_order 0..999; #53 data maxItems 500; #53/#54/#52/#51 answer the bare DTO (no envelope except {data})', () => {
    const c = sch.QualityCode; expect(c.additionalProperties).toBe(false); expect(Object.keys(c.properties).sort()).toEqual(CODE_KEYS); expect([...c.required].sort()).toEqual(CODE_KEYS);
    expect(c.properties.source.enum).toEqual(['global', 'tenant']); expect([c.properties.display.minLength, c.properties.display.maxLength, c.properties.sort_order.minimum, c.properties.sort_order.maximum]).toEqual([1, 120, 0, 999]);
    const l = find('listQualityCodedSet').o.responses['200'].content['application/json'].schema; expect(l.additionalProperties).toBe(false); expect(l.properties.data.maxItems).toBe(500);
    expect(find('upsertQualityCode').o.responses['200'].content['application/json'].schema.$ref).toMatch(/QualityCode$/);
    for (const op of ['getQualitySettings', 'updateQualitySettings']) expect(find(op).o.responses['200'].content['application/json'].schema.$ref).toMatch(/QualitySettingsDto$/);
  });
  it('#54 body: closed, display / sort_order / is_active required', () => {
    const s = find('upsertQualityCode').o.requestBody.content['application/json'].schema; expect(s.additionalProperties).toBe(false); expect([...s.required].sort()).toEqual(['display', 'is_active', 'sort_order']);
  });
});
