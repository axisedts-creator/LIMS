// C9 T-15 — HTTP wiring of #36-#41, #44, #45 (02-TRD §5.5; contracts/openapi/quality.yaml) + contract flags (x-permission, x-idempotency, If-Match, aal2 error code, 422/409 codes).
// The autoverify SERVICE is mocked (behaviour: autoverify.service.test.ts). Request shapes as the core pipeline delivers them: params {version_id}, headers lower-case, body parsed JSON.
// Needs the T-01 `../index.js` manifest merged into this lane (as T-06); the writer adds the eight handlers to it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { REPO_ROOT } from '../../../core/module.js';
import { DEF1, OPS, RETIRE_BODY, VER, makeCtx, rejection } from './autoverify.helpers.js';

const svc: Record<string, ReturnType<typeof vi.fn>> = {};
vi.mock('../service/autoverify.service.js', () => ({ createAutoverifyService: () => svc }));
// Phase switch (02-TRD:120, :806): the flag is read once at module load (handlers/index.ts), so enable it BEFORE the import (ruling C9.T-15).
vi.stubEnv('LIMS_QUALITY_ENABLED', 'true');
const { manifest } = await import('../index.js');
const h =(op: string): any => (manifest.handlers as any)[op];

const hctx = (operationId: string) => ({ operationId, clientIp: '203.0.113.9', ...makeCtx().ctx });
const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
const ifm = (v: number) => ({ 'if-match': `"${v}"` });
beforeEach(() => { for (const op of OPS) svc[op] = vi.fn(async () => ({ status: 200, body: { ok: op }, version: 3 })); });

describe('real handlers (not T-01 stubs); fail closed without an authenticated request context', () => {
  it.each(OPS)('%s: no context -> auth.unauthenticated, service never called', async (op) => {
    const e = await rejection(h(op)(req(), { operationId: op, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } }));
    expect(e?.code).toBe('auth.unauthenticated'); expect(svc[op]).not.toHaveBeenCalled();
  });
  it('service errors propagate untouched and echo no request input (mfa_required, rule_set_invalid, rule_set_invalid_transition)', async () => {
    const planted = 'PLANTED-TOKEN-9f3a';
    for (const c of ['auth.mfa_required', 'quality.rule_set_invalid', 'quality.rule_set_invalid_transition']) {
      svc['createAutoverifyVersion']!.mockRejectedValueOnce(Object.assign(new Error(c), { code: c }));
      const e = await rejection(h('createAutoverifyVersion')(req({ body: { definition: DEF1 }, headers: { authorization: planted } }), hctx('createAutoverifyVersion')));
      expect(e?.code).toBe(c); expect(JSON.stringify({ m: e?.message, d: e?.detail })).not.toContain(planted);
    }
  });
});

describe('phase switch off (ruling C9.T-15)', () => {
  it.each(OPS)('LIMS_QUALITY_ENABLED=false: %s rejects common.feature_disabled and the service is not called', async (op) => {
    vi.resetModules(); vi.stubEnv('LIMS_QUALITY_ENABLED', 'false');
    try {
      const off: any = (await import('../index.js')).manifest;
      const e = await rejection(off.handlers[op](req(), hctx(op)));
      expect(e?.code).toBe('common.feature_disabled'); expect(svc[op]).not.toHaveBeenCalled();
    } finally { vi.stubEnv('LIMS_QUALITY_ENABLED', 'true'); }
  });
});

describe('request -> service mapping; status; ETag', () => {
  it('#36 getAutoverifyRuleSet: no input; 200; no ETag (a summary, not a versioned row)', async () => {
    const r = await h('getAutoverifyRuleSet')(req(), hctx('getAutoverifyRuleSet'));
    expect(svc['getAutoverifyRuleSet']).toHaveBeenCalledWith(expect.objectContaining({ tenantId: expect.any(String) }), {}); expect(r.status).toBe(200); expect(r.headers?.etag).toBeUndefined();
  });
  it('#37 createAutoverifyVersion: body passes through untouched; service status (201) and ETag are returned', async () => {
    svc['createAutoverifyVersion']!.mockResolvedValueOnce({ status: 201, body: { id: VER(1) }, version: 1 });
    const body = { definition: DEF1, tenant_id: 'must-reach-the-service-validator-not-be-stripped' };
    const r = await h('createAutoverifyVersion')(req({ body }), hctx('createAutoverifyVersion'));
    expect(svc['createAutoverifyVersion']).toHaveBeenCalledWith(expect.anything(), { body }); expect(r.status).toBe(201); expect(r.headers?.etag).toBe('"1"');
  });
  it('#38 getAutoverifyVersion: version_id -> versionId; 200 + ETag "<version>"', async () => {
    const r = await h('getAutoverifyVersion')(req({ params: { version_id: VER(3) } }), hctx('getAutoverifyVersion'));
    expect(svc['getAutoverifyVersion']).toHaveBeenCalledWith(expect.anything(), { versionId: VER(3) }); expect(r.status).toBe(200); expect(r.headers?.etag).toBe('"3"');
  });
  const body = { definition: DEF1 };
  const cases: Array<[string, unknown]> = [
    ['replaceAutoverifyDraft', body], ['startAutoverifySimulation', {}], ['stopAutoverifySimulation', {}], ['retireAutoverifyVersion', RETIRE_BODY], ['discardAutoverifyDraft', {}],
  ];
  it.each(cases)('%s: If-Match + path + body -> service; 200 + ETag', async (op, b) => {
    const r = await h(op)(req({ params: { version_id: VER(1) }, headers: ifm(2), body: b }), hctx(op));
    expect(svc[op]).toHaveBeenCalledWith(expect.anything(), { versionId: VER(1), expectedVersion: 2, body: b }); expect(r.status).toBe(200); expect(r.headers?.etag).toBe('"3"');
  });
  it.each(cases)('%s: absent If-Match -> service gets expectedVersion undefined (it answers 428)', async (op, b) => {
    await h(op)(req({ params: { version_id: VER(1) }, body: b }), hctx(op));
    expect(svc[op]).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ expectedVersion: undefined }));
  });
  it.each(cases)('%s: malformed If-Match (W/"1", 1, "0", "01", "1x", "") -> 400 common.validation_failed, service not called', async (op, b) => {
    for (const v of ['W/"1"', '1', '"0"', '"01"', '"1x"', '""']) expect((await rejection(h(op)(req({ params: { version_id: VER(1) }, headers: { 'if-match': v }, body: b }), hctx(op))))?.code, v).toBe('common.validation_failed');
    expect(svc[op]).not.toHaveBeenCalled();
  });
  it('tenant and actor reach the service only through the context, never from params/headers/body', async () => {
    await h('discardAutoverifyDraft')(req({ params: { version_id: VER(1), tenant_id: 'x' }, headers: { ...ifm(1), 'x-tenant-id': 'evil' }, body: {} }), hctx('discardAutoverifyDraft'));
    const [ctxArg, input] = svc['discardAutoverifyDraft']!.mock.calls[0]!;
    expect(JSON.stringify(input)).not.toMatch(/tenant|evil/); expect(ctxArg.tenantId).toBe(makeCtx().ctx.tenantId);
  });
});

describe('contract flags the core pipeline enforces (contracts/openapi/quality.yaml, 02-TRD §5.0/§5.5)', () => {
  const doc: any = parse(readFileSync(join(REPO_ROOT, 'contracts', 'openapi', 'quality.yaml'), 'utf8'));
  const op = (id: string) => { for (const [path, item] of Object.entries<any>(doc.paths)) for (const [method, o] of Object.entries<any>(item)) if (o?.operationId === id) return { path, method, o }; throw new Error(`no ${id}`); };
  const M = 'quality.autoverify.manage', R = 'quality.autoverify.read';
  // [operationId, method, path, x-permission, x-idempotency, takes If-Match, extra error codes]
  const T: Array<[string, string, string, string, string, boolean, string[]]> = [
    ['getAutoverifyRuleSet', 'get', '/v1/quality/autoverify/rule-set', R, 'none', false, []],
    ['createAutoverifyVersion', 'post', '/v1/quality/autoverify/versions', M, 'required', false, ['quality.rule_set_invalid']],
    ['getAutoverifyVersion', 'get', '/v1/quality/autoverify/versions/{version_id}', R, 'none', false, []],
    ['replaceAutoverifyDraft', 'put', '/v1/quality/autoverify/versions/{version_id}', M, 'none', true, ['quality.rule_set_invalid', 'quality.rule_set_invalid_transition']],
    ['startAutoverifySimulation', 'post', '/v1/quality/autoverify/versions/{version_id}/start-simulation', M, 'optional', true, ['quality.rule_set_invalid_transition']],
    ['stopAutoverifySimulation', 'post', '/v1/quality/autoverify/versions/{version_id}/stop-simulation', M, 'optional', true, ['quality.rule_set_invalid_transition']],
    ['retireAutoverifyVersion', 'post', '/v1/quality/autoverify/versions/{version_id}/retire', M, 'optional', true, ['quality.rule_set_invalid_transition']],
    ['discardAutoverifyDraft', 'post', '/v1/quality/autoverify/versions/{version_id}/discard', M, 'optional', true, ['quality.rule_set_invalid_transition']],
  ];
  it('the table covers exactly the T-15 operations', () => { expect(T.map((t) => t[0]).sort()).toEqual([...OPS].sort()); });
  it.each(T)('%s: method/path, permission, idempotency, If-Match, error codes', (id, method, path, perm, idem, ifMatch, extra) => {
    const r = op(id); expect(r.method).toBe(method); expect(r.path).toBe(path);
    expect(r.o['x-permission']).toBe(perm); expect(r.o['x-idempotency'] ?? 'none').toBe(idem);
    expect(JSON.stringify(r.o.parameters ?? []).includes('IfMatch')).toBe(ifMatch);
    expect(r.o['x-error-codes']).toEqual(expect.arrayContaining(extra));
    if (ifMatch) expect(r.o['x-error-codes']).toEqual(expect.arrayContaining(['common.version_conflict', 'common.precondition_required']));
    if (idem === 'required') expect(r.o['x-error-codes']).toEqual(expect.arrayContaining(['common.idempotency_key_required', 'common.idempotency_key_reused', 'common.idempotency_in_progress']));
  });
  it.each(T.filter((t) => t[3] === M))('AC-12.3 %s lists auth.mfa_required (403) — every quality.autoverify.manage operation is privileged', (id) => {
    const { o } = op(id); expect(o['x-error-codes']).toContain('auth.mfa_required'); expect(Object.keys(o.responses)).toContain('403');
  });
  it.each(T.filter((t) => t[3] === R))('%s (read) does not claim auth.mfa_required', (id) => { expect(op(id).o['x-error-codes']).not.toContain('auth.mfa_required'); });
  it('#37 body is exactly one of copy_from_version_id / definition, additionalProperties false; retire reason 1..500', () => {
    const s = op('createAutoverifyVersion').o.requestBody.content['application/json'].schema;
    expect(s.additionalProperties).toBe(false); expect(s.oneOf).toEqual([{ required: ['copy_from_version_id'] }, { required: ['definition'] }]);
    const r = JSON.stringify(op('retireAutoverifyVersion').o.requestBody);
    expect(r).toContain('"reason"'); expect(r).toContain('500');
  });
  it('AutoverifyVersionDto status enum includes `stopped` (D-55) and DSL rules are closed (additionalProperties false)', () => {
    expect(doc.components.schemas.AutoverifyVersionDto.properties.status.enum).toEqual(['draft', 'simulating', 'stopped', 'active', 'retired', 'discarded']);
    expect(doc.components.schemas.AutoverifyRule.additionalProperties).toBe(false); expect(doc.components.schemas.RuleSetDefinition.additionalProperties).toBe(false);
  });
  it('the handler map has an entry for every T-15 operationId and each is a function', () => { for (const id of OPS) expect(typeof h(id), id).toBe('function'); });
});
