// C9 T-13 — HTTP wiring of #34 getQcStatusBoard (02-TRD §5.5, §5.10; contracts/openapi/quality.yaml). The status SERVICE is mocked (behaviour: status.service.test.ts): these tests fix req -> service input
// mapping, 200 + body passthrough, no ETag, fail-closed behaviour, the phase switch and the contract flags the core pipeline enforces.
// Handler lives in handlers/status.handlers.ts and is merged into handlers/index.ts (wrapped by the phase-switch `gated`); service = createStatusService() of service/status.service.ts.
// Fails now: the T-01 stub answers 501 / common.internal.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { REPO_ROOT } from '../../../core/module.js';
import { makePlanCtx } from './plan.helpers.js';
import { BOARD_KEYS, BOARD_REQUIRED, rejection } from './status.helpers.js';

const svc: Record<string, ReturnType<typeof vi.fn>> = {};
vi.mock('../service/status.service.js', () => ({ createStatusService: () => svc }));
vi.stubEnv('LIMS_QUALITY_ENABLED', 'true');   // read once at module load (handlers/index.ts): enable BEFORE the import
const { manifest } = await import('../index.js');
const h = (op: string): any => (manifest.handlers as any)[op];
const OP = 'getQcStatusBoard';

const hctx = () => ({ operationId: OP, clientIp: '203.0.113.9', ...makePlanCtx().ctx });
const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
const BODY = { data: [], page: { limit: 50 }, generated_at: '2026-11-05T15:00:00.000Z' };
beforeEach(() => { svc['getQcStatusBoard'] = vi.fn(async () => ({ status: 200, body: BODY })); });

describe('#34 getQcStatusBoard: a real handler, fail closed', () => {
  it('no authenticated context -> auth.unauthenticated (the T-01 stub answers 501 / common.internal); the service is never called', async () => {
    const e = await rejection(h(OP)(req(), { operationId: OP, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } }));
    expect(e?.code).toBe('auth.unauthenticated'); expect(svc['getQcStatusBoard']).not.toHaveBeenCalled();
  });
  it('a context without a transaction or actor is refused too (no partial context reaches the service)', async () => {
    for (const bad of [{ tenantId: 'T', actor: { id: 'U' } }, { tenantId: 'T', tx: {} }, { actor: { id: 'U' }, tx: {} }]) expect((await rejection(h(OP)(req(), { operationId: OP, log: { info() {}, warn() {}, error() {} }, ...bad })))?.code).toBe('auth.unauthenticated');
    expect(svc['getQcStatusBoard']).not.toHaveBeenCalled();
  });
  it('service errors propagate untouched (common.invalid_cursor, common.validation_failed, auth.forbidden) and echo no request input', async () => {
    const planted = 'PLANTED-TOKEN-9f3a';
    for (const c of ['common.invalid_cursor', 'common.validation_failed', 'auth.forbidden']) {
      svc['getQcStatusBoard']!.mockRejectedValueOnce(Object.assign(new Error(c), { code: c }));
      const e = await rejection(h(OP)(req({ query: { cursor: planted }, headers: { authorization: planted } }), hctx()));
      expect(e?.code).toBe(c); expect(JSON.stringify({ m: e?.message, d: e?.detail })).not.toContain(planted);
    }
  });
});

describe('#34 phase switch off (ruling C9.T-06 extends to every implemented op)', () => {
  it('LIMS_QUALITY_ENABLED=false: rejects common.feature_disabled before anything else and the service is not called', async () => {
    vi.resetModules(); vi.stubEnv('LIMS_QUALITY_ENABLED', 'false');
    try { const off: any = (await import('../index.js')).manifest; const e = await rejection(off.handlers[OP](req(), hctx())); expect(e?.code).toBe('common.feature_disabled'); expect(svc['getQcStatusBoard']).not.toHaveBeenCalled(); }
    finally { vi.stubEnv('LIMS_QUALITY_ENABLED', 'true'); }
  });
});

describe('#34 request -> service mapping', () => {
  it('query -> camelCase input; the status csv reaches the service as sent; 200 + the service body UNCHANGED; a list has no ETag', async () => {
    const r = await h(OP)(req({ query: { instrument_id: 'I', status: 'warning,out_of_control', overdue_only: true, cursor: 'C1', limit: 25 } }), hctx());
    expect(svc['getQcStatusBoard']).toHaveBeenCalledWith(expect.objectContaining({ tenantId: expect.any(String) }), { instrumentId: 'I', status: 'warning,out_of_control', overdueOnly: true, cursor: 'C1', limit: 25 });
    expect(r.status).toBe(200); expect(r.body).toEqual(BODY); expect(r.headers?.etag).toBeUndefined();
  });
  it('no query: every filter reaches the service as undefined (the service owns the defaults)', async () => {
    await h(OP)(req(), hctx()); const arg = svc['getQcStatusBoard']!.mock.calls[0]![1];
    expect(Object.keys(arg).sort()).toEqual(['cursor', 'instrumentId', 'limit', 'overdueOnly', 'status']); expect(Object.values(arg).every((v) => v === undefined)).toBe(true);
  });
  it('overdue_only=false is passed as false (not dropped, not coerced to undefined)', async () => {
    await h(OP)(req({ query: { overdue_only: false } }), hctx()); expect(svc['getQcStatusBoard']!.mock.calls[0]![1].overdueOnly).toBe(false);
  });
  it('tenant_id / created_by in query or header never reach the service input; the service gets the request context (tenant, actor, tx), not one rebuilt from request fields', async () => {
    await h(OP)(req({ query: { tenant_id: 'T', created_by: 'U' }, headers: { 'x-tenant-id': 'T' } }), hctx());
    expect(JSON.stringify(svc['getQcStatusBoard']!.mock.calls[0]![1])).not.toMatch(/"T"|"U"|tenant/);
    const c = svc['getQcStatusBoard']!.mock.calls[0]![0]; expect(c.tenantId).toBeTruthy(); expect(c.actor.id).toBeTruthy(); expect(c.tx).toBeTruthy();
  });
});

describe('#34 contract flags the core pipeline enforces (contracts/openapi/quality.yaml, 02-TRD §5.5/§5.10)', () => {
  const doc: any = parse(readFileSync(join(REPO_ROOT, 'contracts', 'openapi', 'quality.yaml'), 'utf8'));
  const found = (() => { for (const [path, item] of Object.entries<any>(doc.paths)) for (const [method, o] of Object.entries<any>(item)) if (o?.operationId === OP) return { path, method, o }; throw new Error('no op'); })();
  it('GET /v1/quality/qc-status, quality.qc_run.read, no idempotency key, no If-Match, tenant context; error codes incl. invalid_cursor + feature_disabled', () => {
    expect(found.method).toBe('get'); expect(found.path).toBe('/v1/quality/qc-status'); expect(found.o['x-permission']).toBe('quality.qc_run.read'); expect(found.o['x-idempotency'] ?? 'none').toBe('none');
    expect(JSON.stringify(found.o.parameters)).not.toContain('IfMatch'); expect(found.o['x-error-codes']).toEqual(expect.arrayContaining(['common.invalid_cursor', 'common.validation_failed', 'common.feature_disabled', 'auth.forbidden']));
  });
  it('query: instrument_id uuid, status = anchored csv of the four statuses, overdue_only boolean, Cursor + Limit (<= 200) from _common', () => {
    const p = (n: string) => found.o.parameters.find((x: any) => x.name === n);
    expect(p('status').schema.pattern).toMatch(/^\^\(in_control\|warning\|out_of_control\|no_qc_data\)/); expect(p('overdue_only').schema.type).toBe('boolean');
    expect(JSON.stringify(found.o.parameters)).toContain('Limit'); expect(JSON.stringify(found.o.parameters)).toContain('Cursor'); expect(JSON.stringify(p('instrument_id'))).toContain('Uuid');
  });
  it('QcStatusRowDto (REQ-SEC-081): additionalProperties false, exactly the allowlisted fields, required set as pinned, no tenant_id; body = { data (<= 200), page, generated_at }', () => {
    const d = doc.components.schemas.QcStatusRowDto;
    expect(d.additionalProperties).toBe(false); expect(Object.keys(d.properties).sort()).toEqual([...BOARD_KEYS].sort()); expect([...d.required].sort()).toEqual([...BOARD_REQUIRED].sort());
    expect(Object.keys(d.properties)).not.toContain('tenant_id');
    const body = found.o.responses['200'].content['application/json'].schema; expect(body.additionalProperties).toBe(false); expect([...body.required].sort()).toEqual(['data', 'generated_at', 'page']); expect(body.properties.data.maxItems).toBe(200);
  });
  it('the handler map has a function for #34', () => { expect(typeof h(OP)).toBe('function'); });
});
