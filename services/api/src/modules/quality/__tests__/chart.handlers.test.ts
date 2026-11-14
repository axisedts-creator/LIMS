// C9 T-14 — HTTP wiring of #35 getLeveyJenningsChart (02-TRD §5.5, §7.10; contracts/openapi/quality.yaml). The chart SERVICE is mocked (behaviour: chart.service.test.ts): these tests fix
// req -> service input mapping, 200 + body passthrough, no ETag, fail-closed behaviour, the phase switch and the contract flags the core pipeline enforces.
// Handler lives in handlers/chart.handlers.ts and is merged into handlers/index.ts (wrapped by the phase-switch `gated`); service = createChartService() of service/chart.service.ts.
// Fails now: the T-01 stub answers 501 / common.internal.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { REPO_ROOT } from '../../../core/module.js';
import { makePlanCtx } from './plan.helpers.js';
import { BODY_KEYS, PLAN_KEYS, POINT_KEYS, SERIES_KEYS, STATUSES, TARGET_KEYS, rejection } from './chart.helpers.js';

const svc: Record<string, ReturnType<typeof vi.fn>> = {};
vi.mock('../service/chart.service.js', () => ({ createChartService: () => svc }));
vi.stubEnv('LIMS_QUALITY_ENABLED', 'true');   // read once at module load (handlers/index.ts): enable BEFORE the import
const { manifest } = await import('../index.js');
const h = (op: string): any => (manifest.handlers as any)[op];
const OP = 'getLeveyJenningsChart';

const hctx = () => ({ operationId: OP, clientIp: '203.0.113.9', ...makePlanCtx().ctx });
const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
const BODY = { plan: { id: 'P', instrument_id: 'I', analyte_id: 'A', analyte_code: 'GLU', decimals: 1 }, view: 'level', series: [], truncated: false };
beforeEach(() => { svc['getLeveyJenningsChart'] = vi.fn(async () => ({ status: 200, body: BODY })); });

describe('#35 getLeveyJenningsChart: a real handler, fail closed', () => {
  it('no authenticated context -> auth.unauthenticated (the T-01 stub answers 501 / common.internal); the service is never called', async () => {
    const e = await rejection(h(OP)(req(), { operationId: OP, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } }));
    expect(e?.code).toBe('auth.unauthenticated'); expect(svc['getLeveyJenningsChart']).not.toHaveBeenCalled();
  });
  it('a context without a transaction or actor is refused too (no partial context reaches the service)', async () => {
    for (const bad of [{ tenantId: 'T', actor: { id: 'U' } }, { tenantId: 'T', tx: {} }, { actor: { id: 'U' }, tx: {} }]) expect((await rejection(h(OP)(req(), { operationId: OP, log: { info() {}, warn() {}, error() {} }, ...bad })))?.code).toBe('auth.unauthenticated');
    expect(svc['getLeveyJenningsChart']).not.toHaveBeenCalled();
  });
  it('service errors propagate untouched (common.validation_failed, common.not_found, auth.forbidden) and echo no request input', async () => {
    const planted = 'PLANTED-TOKEN-9f3a';
    for (const c of ['common.validation_failed', 'common.not_found', 'auth.forbidden']) {
      svc['getLeveyJenningsChart']!.mockRejectedValueOnce(Object.assign(new Error(c), { code: c }));
      const e = await rejection(h(OP)(req({ query: { plan_id: planted }, headers: { authorization: planted } }), hctx()));
      expect(e?.code).toBe(c); expect(JSON.stringify({ m: e?.message, d: e?.detail })).not.toContain(planted);
    }
  });
});

describe('#35 phase switch off (ruling C9.T-06 extends to every implemented op)', () => {
  it('LIMS_QUALITY_ENABLED=false: rejects common.feature_disabled before anything else and the service is not called', async () => {
    vi.resetModules(); vi.stubEnv('LIMS_QUALITY_ENABLED', 'false');
    try { const off: any = (await import('../index.js')).manifest; const e = await rejection(off.handlers[OP](req(), hctx())); expect(e?.code).toBe('common.feature_disabled'); expect(svc['getLeveyJenningsChart']).not.toHaveBeenCalled(); }
    finally { vi.stubEnv('LIMS_QUALITY_ENABLED', 'true'); }
  });
});

describe('#35 request -> service mapping', () => {
  it('query -> camelCase input (plan_id, view, level_id, lot_id, observed_at_from, observed_at_to); 200 + the service body UNCHANGED; no ETag (a computed view, not a resource)', async () => {
    const q = { plan_id: 'P', view: 'z', level_id: 'L', lot_id: 'LT', observed_at_from: '2026-10-01T00:00:00.000Z', observed_at_to: '2026-11-01T00:00:00.000Z' };
    const r = await h(OP)(req({ query: q }), hctx());
    expect(svc['getLeveyJenningsChart']).toHaveBeenCalledWith(expect.objectContaining({ tenantId: expect.any(String) }),
      { planId: 'P', view: 'z', levelId: 'L', lotId: 'LT', observedAtFrom: '2026-10-01T00:00:00.000Z', observedAtTo: '2026-11-01T00:00:00.000Z' });
    expect(r.status).toBe(200); expect(r.body).toEqual(BODY); expect(r.headers?.etag).toBeUndefined();
  });
  it('no query: every field reaches the service as undefined (the service owns the defaults and the validation)', async () => {
    await h(OP)(req(), hctx()); const arg = svc['getLeveyJenningsChart']!.mock.calls[0]![1];
    expect(Object.keys(arg).sort()).toEqual(['levelId', 'lotId', 'observedAtFrom', 'observedAtTo', 'planId', 'view']); expect(Object.values(arg).every((v) => v === undefined)).toBe(true);
  });
  it('tenant_id / created_by in query or header never reach the service input; the service gets the request context (tenant, actor, tx), not one rebuilt from request fields', async () => {
    await h(OP)(req({ query: { tenant_id: 'T', created_by: 'U' }, headers: { 'x-tenant-id': 'T' } }), hctx());
    expect(JSON.stringify(svc['getLeveyJenningsChart']!.mock.calls[0]![1])).not.toMatch(/"T"|"U"|tenant/);
    const c = svc['getLeveyJenningsChart']!.mock.calls[0]![0]; expect(c.tenantId).toBeTruthy(); expect(c.actor.id).toBeTruthy(); expect(c.tx).toBeTruthy();
  });
});

describe('#35 contract flags the core pipeline enforces (contracts/openapi/quality.yaml, 02-TRD §5.5/§7.10)', () => {
  const doc: any = parse(readFileSync(join(REPO_ROOT, 'contracts', 'openapi', 'quality.yaml'), 'utf8'));
  const found = (() => { for (const [path, item] of Object.entries<any>(doc.paths)) for (const [method, o] of Object.entries<any>(item)) if (o?.operationId === OP) return { path, method, o }; throw new Error('no op'); })();
  const p = (n: string) => found.o.parameters.find((x: any) => x.name === n);
  it('GET /v1/quality/lj-chart, quality.qc_run.read, no idempotency key, no If-Match, tenant context; error codes incl. not_found + validation_failed + feature_disabled', () => {
    expect(found.method).toBe('get'); expect(found.path).toBe('/v1/quality/lj-chart'); expect(found.o['x-permission']).toBe('quality.qc_run.read'); expect(found.o['x-idempotency'] ?? 'none').toBe('none');
    expect(JSON.stringify(found.o.parameters)).not.toContain('IfMatch'); expect(found.o['x-error-codes']).toEqual(expect.arrayContaining(['common.validation_failed', 'common.not_found', 'common.feature_disabled', 'auth.forbidden']));
  });
  it('query: plan_id uuid required; view enum level|z default level; level_id / lot_id uuid optional; observed_at_from / observed_at_to ISO-UTC required (S-16 span cap is enforced by the service)', () => {
    expect(p('plan_id').required).toBe(true); expect(JSON.stringify(p('plan_id'))).toContain('Uuid');
    expect(p('view').schema.enum).toEqual(['level', 'z']); expect(p('view').schema.default).toBe('level'); expect(p('view').required).not.toBe(true);
    for (const n of ['level_id', 'lot_id']) { expect(p(n).required).not.toBe(true); expect(JSON.stringify(p(n))).toContain('Uuid'); }
    for (const n of ['observed_at_from', 'observed_at_to']) { expect(p(n).required).toBe(true); expect(JSON.stringify(p(n))).toContain('IsoUtc'); }
    expect(found.o.parameters.map((x: any) => x.name).sort()).toEqual(['lot_id', 'level_id', 'observed_at_from', 'observed_at_to', 'plan_id', 'view'].sort());
  });
  it('LjChartDto (REQ-SEC-081): additionalProperties false at every level, exactly the §7.10 fields, required set as pinned, no tenant_id / created_by anywhere', () => {
    const d = doc.components.schemas.LjChartDto;
    expect(d.additionalProperties).toBe(false); expect(Object.keys(d.properties).sort()).toEqual(BODY_KEYS); expect([...d.required].sort()).toEqual(['plan', 'series', 'truncated', 'view']);
    expect(Object.keys(d.properties.plan.properties).sort()).toEqual(PLAN_KEYS); expect(d.properties.plan.additionalProperties).toBe(false); expect([...d.properties.plan.required].sort()).toEqual(['analyte_code', 'analyte_id', 'decimals', 'id', 'instrument_id']);
    const s = d.properties.series.items; expect(s.additionalProperties).toBe(false); expect(Object.keys(s.properties).sort()).toEqual(SERIES_KEYS); expect([...s.required].sort()).toEqual(['level_code', 'level_id', 'lot_id', 'lot_no', 'points', 'targets']);
    const pt = s.properties.points.items; expect(pt.additionalProperties).toBe(false); expect(Object.keys(pt.properties).sort()).toEqual(POINT_KEYS); expect([...pt.required].sort()).toEqual(['observation_id', 'observed_at', 'rule_hits', 'status', 'value']);
    expect([...pt.properties.status.enum].sort()).toEqual([...STATUSES].sort());
    const tg = s.properties.targets.items; expect(tg.additionalProperties).toBe(false); expect(Object.keys(tg.properties).sort()).toEqual(TARGET_KEYS); expect([...tg.required].sort()).toEqual(['effective_from', 'mean', 'sd', 'source', 'target_id']);
    expect(d.properties.truncated.type).toBe('boolean'); expect(JSON.stringify(d)).not.toMatch(/tenant_id|created_by|updated_by/);
  });
  it('the 200 response is the bare LjChartDto (no envelope) and the handler map has a function for #35', () => {
    expect(found.o.responses['200'].content['application/json'].schema.$ref).toMatch(/LjChartDto$/); expect(typeof h(OP)).toBe('function');
  });
});
