// C9 T-17 — HTTP wiring of #42, #43, #46, #47 (02-TRD §5.5; contracts/openapi/quality.yaml) + contract flags (x-permission, x-idempotency, If-Match, aal2 error code, request/response shapes).
// The activation SERVICE is mocked (behaviour: activation.service.test.ts). Request shapes as the core pipeline delivers them: params {version_id|decision_id}, query already typed by the schema, headers lower-case.
// Fails now: the four operationIds are T-01 stubs / no `../service/activation.service.js`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { REPO_ROOT } from '../../../core/module.js';
import { DEC, VER, rejection } from './activation.helpers.js';
import { makeCtx } from './autoverify.helpers.js';

const makeCtxFor = () => makeCtx().ctx;

const OPS = ['getAutoverifySimulationReport', 'activateAutoverifyVersion', 'listAutoverifyDecisions', 'getAutoverifyDecision'] as const;
const svc: Record<string, ReturnType<typeof vi.fn>> = {};
vi.mock('../service/activation.service.js', () => ({ createActivationService: () => svc }));
vi.stubEnv('LIMS_QUALITY_ENABLED', 'true');       // phase switch is read once at module load (ruling C9.T-15)
const { manifest } = await import('../index.js');
const h = (op: string): any => (manifest.handlers as any)[op];

const hctx = (operationId: string) => ({ operationId, clientIp: '203.0.113.9', ...makeCtxFor() });
const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
beforeEach(() => { for (const op of OPS) svc[op] = vi.fn(async () => ({ status: 200, body: { ok: op }, version: 3 })); });

describe('real handlers (not T-01 stubs); fail closed without an authenticated request context', () => {
  it.each(OPS)('%s: no context -> auth.unauthenticated, service never called', async (op) => {
    const e = await rejection(h(op)(req(), { operationId: op, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } }));
    expect(e?.code).toBe('auth.unauthenticated'); expect(svc[op]).not.toHaveBeenCalled();
  });
  it('service errors propagate untouched and echo no request input (mfa_required, simulation_incomplete, self_activation_forbidden)', async () => {
    const planted = 'PLANTED-TOKEN-9f3a';
    for (const c of ['auth.mfa_required', 'quality.simulation_incomplete', 'quality.self_activation_forbidden', 'quality.rule_set_invalid_transition']) {
      svc['activateAutoverifyVersion']!.mockRejectedValueOnce(Object.assign(new Error(c), { code: c }));
      const e = await rejection(h('activateAutoverifyVersion')(req({ params: { version_id: VER(2) }, headers: { 'if-match': '"1"', authorization: planted }, body: { confirmation_text: 'ACTIVATE' } }), hctx('activateAutoverifyVersion')));
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
  it('#43 activate: If-Match + path id + body -> service; 200 + ETag "<version>"', async () => {
    const body = { confirmation_text: 'ACTIVATE' };
    const r = await h('activateAutoverifyVersion')(req({ params: { version_id: VER(2) }, headers: { 'if-match': '"4"' }, body }), hctx('activateAutoverifyVersion'));
    expect(svc['activateAutoverifyVersion']).toHaveBeenCalledWith(expect.anything(), { versionId: VER(2), expectedVersion: 4, body }); expect(r.status).toBe(200); expect(r.headers?.etag).toBe('"3"');
  });
  it('#43 absent If-Match -> expectedVersion undefined (the service answers 428); malformed (W/"1", 1, "0", "01", "1x", "") -> 400 common.validation_failed, service not called', async () => {
    await h('activateAutoverifyVersion')(req({ params: { version_id: VER(2) }, body: { confirmation_text: 'ACTIVATE' } }), hctx('activateAutoverifyVersion'));
    expect(svc['activateAutoverifyVersion']).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ expectedVersion: undefined }));
    svc['activateAutoverifyVersion']!.mockClear();
    for (const v of ['W/"1"', '1', '"0"', '"01"', '"1x"', '""']) expect((await rejection(h('activateAutoverifyVersion')(req({ params: { version_id: VER(2) }, headers: { 'if-match': v }, body: {} }), hctx('activateAutoverifyVersion'))))?.code, v).toBe('common.validation_failed');
    expect(svc['activateAutoverifyVersion']).not.toHaveBeenCalled();
  });
  it('#42 report: version_id -> versionId, sample_limit -> sampleLimit (absent -> undefined); 200; no ETag (computed, not a versioned row)', async () => {
    const a = await h('getAutoverifySimulationReport')(req({ params: { version_id: VER(2) }, query: { sample_limit: 25 } }), hctx('getAutoverifySimulationReport'));
    expect(svc['getAutoverifySimulationReport']).toHaveBeenCalledWith(expect.anything(), { versionId: VER(2), sampleLimit: 25 }); expect(a.status).toBe(200); expect(a.headers?.etag).toBeUndefined();
    await h('getAutoverifySimulationReport')(req({ params: { version_id: VER(2) } }), hctx('getAutoverifySimulationReport'));
    expect(svc['getAutoverifySimulationReport']!.mock.calls[1]![1]).toEqual({ versionId: VER(2), sampleLimit: undefined });
  });
  it('#46 list: every query parameter maps snake_case -> camelCase; 200; no ETag', async () => {
    const query = { result_id: VER(1), analyte_id: VER(2), instrument_id: VER(3), version_id: VER(4), mode: 'shadow', decision: 'deny', reason: 'qc_warning', decided_at_from: '2026-11-01T00:00:00.000Z', decided_at_to: '2026-11-05T00:00:00.000Z', sort: '-decided_at', cursor: 'c1', limit: 25 };
    const r = await h('listAutoverifyDecisions')(req({ query }), hctx('listAutoverifyDecisions'));
    expect(svc['listAutoverifyDecisions']).toHaveBeenCalledWith(expect.anything(), {
      resultId: VER(1), analyteId: VER(2), instrumentId: VER(3), versionId: VER(4), mode: 'shadow', decision: 'deny', reason: 'qc_warning', decidedAtFrom: query.decided_at_from, decidedAtTo: query.decided_at_to, sort: '-decided_at', cursor: 'c1', limit: 25,
    });
    expect(r.status).toBe(200); expect(r.headers?.etag).toBeUndefined();
  });
  it('#47 detail: decision_id -> decisionId; 200; no ETag', async () => {
    const r = await h('getAutoverifyDecision')(req({ params: { decision_id: DEC(1) } }), hctx('getAutoverifyDecision'));
    expect(svc['getAutoverifyDecision']).toHaveBeenCalledWith(expect.anything(), { decisionId: DEC(1) }); expect(r.status).toBe(200); expect(r.headers?.etag).toBeUndefined();
  });
  it('tenant and actor reach the service only through the context, never from params/query/headers/body', async () => {
    await h('activateAutoverifyVersion')(req({ params: { version_id: VER(2), tenant_id: 'x' }, query: { tenant_id: 'x' }, headers: { 'if-match': '"1"', 'x-tenant-id': 'evil' }, body: { confirmation_text: 'ACTIVATE' } }), hctx('activateAutoverifyVersion'));
    const [ctxArg, input] = svc['activateAutoverifyVersion']!.mock.calls[0]!;
    expect(JSON.stringify(input)).not.toMatch(/tenant|evil/); expect(ctxArg.tenantId).toBe(makeCtxFor().tenantId);
  });
});

describe('contract flags the core pipeline enforces (contracts/openapi/quality.yaml, 02-TRD §5.0/§5.5)', () => {
  const doc: any = parse(readFileSync(join(REPO_ROOT, 'contracts', 'openapi', 'quality.yaml'), 'utf8'));
  const op = (id: string) => { for (const [path, item] of Object.entries<any>(doc.paths)) for (const [method, o] of Object.entries<any>(item)) if (o?.operationId === id) return { path, method, o }; throw new Error(`no ${id}`); };
  const M = 'quality.autoverify.manage', R = 'quality.autoverify.read';
  // [operationId, method, path, x-permission, x-idempotency, takes If-Match, extra error codes]
  const T: Array<[string, string, string, string, string, boolean, string[]]> = [
    ['getAutoverifySimulationReport', 'get', '/v1/quality/autoverify/versions/{version_id}/simulation-report', R, 'none', false, []],
    ['activateAutoverifyVersion', 'post', '/v1/quality/autoverify/versions/{version_id}/activate', M, 'optional', true, ['quality.simulation_incomplete', 'quality.self_activation_forbidden', 'quality.rule_set_invalid_transition', 'auth.mfa_required']],
    ['listAutoverifyDecisions', 'get', '/v1/quality/autoverify/decisions', R, 'none', false, ['common.invalid_cursor']],
    ['getAutoverifyDecision', 'get', '/v1/quality/autoverify/decisions/{decision_id}', R, 'none', false, []],
  ];
  it('the table covers exactly the T-17 operations', () => { expect(T.map((t) => t[0]).sort()).toEqual([...OPS].sort()); });
  it.each(T)('%s: method/path, permission, idempotency, If-Match, error codes', (id, method, path, perm, idem, ifMatch, extra) => {
    const r = op(id); expect(r.method).toBe(method); expect(r.path).toBe(path);
    expect(r.o['x-permission']).toBe(perm); expect(r.o['x-idempotency'] ?? 'none').toBe(idem);
    expect(JSON.stringify(r.o.parameters ?? []).includes('IfMatch')).toBe(ifMatch);
    expect(r.o['x-error-codes']).toEqual(expect.arrayContaining(extra));
    if (ifMatch) expect(r.o['x-error-codes']).toEqual(expect.arrayContaining(['common.version_conflict', 'common.precondition_required']));
  });
  it('AC-12.3 #43 lists auth.mfa_required and a 403 response; the reads do not claim it', () => {
    expect(op('activateAutoverifyVersion').o['x-error-codes']).toContain('auth.mfa_required'); expect(Object.keys(op('activateAutoverifyVersion').o.responses)).toContain('403');
    for (const id of ['getAutoverifySimulationReport', 'listAutoverifyDecisions', 'getAutoverifyDecision']) expect(op(id).o['x-error-codes'], id).not.toContain('auth.mfa_required');
  });
  it('#43 body is exactly { confirmation_text: "ACTIVATE" }, additionalProperties false, required', () => {
    const s = op('activateAutoverifyVersion').o.requestBody.content['application/json'].schema;
    expect(s.additionalProperties).toBe(false); expect(s.required).toEqual(['confirmation_text']); expect(s.properties.confirmation_text.enum).toEqual(['ACTIVATE']);
  });
  it('#42 sample_limit is an integer 0..200 defaulting to 50; the report schema is closed and its sample is capped at 200 with live_decision', () => {
    const p = op('getAutoverifySimulationReport').o.parameters.find((x: any) => x.name === 'sample_limit');
    expect(p.schema).toMatchObject({ type: 'integer', minimum: 0, maximum: 200, default: 50 });
    const r = doc.components.schemas.SimulationReportDto; expect(r.additionalProperties).toBe(false); expect(r.properties.sample.maxItems).toBe(200);
    expect(r.properties.sample.items.properties.live_decision.enum).toEqual(['allow', 'deny']); expect(r.properties.sample.items.additionalProperties).toBe(false);
  });
  it('#46 requires decided_at_from and decided_at_to; the list items are the closed AutoverifyDecisionDto', () => {
    const ps: any[] = op('listAutoverifyDecisions').o.parameters;
    for (const n of ['decided_at_from', 'decided_at_to']) expect(ps.find((x) => x.name === n)?.required, n).toBe(true);
    expect(doc.components.schemas.AutoverifyDecisionDto.additionalProperties).toBe(false);
  });
  it('the handler map has an entry for every T-17 operationId and each is a function', () => { for (const id of OPS) expect(typeof h(id), id).toBe('function'); });
});
