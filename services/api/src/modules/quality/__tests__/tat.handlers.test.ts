// C9 T-19 — HTTP wiring of #48-#50 (02-TRD §5.7; contracts/openapi/quality.yaml; AC-14.6-14.8; 07-SECURITY S-02, S-03). The tat SERVICE is mocked (behaviour: tat.service.test.ts): these tests fix the req -> service input
// mapping, status codes, ETag, If-Match handling, fail-closed behaviour, the phase switch and the contract flags the core pipeline enforces (x-idempotency required on #50, If-Match, permissions, DTO allowlists).
// Handlers live in handlers/tat.handlers.ts, merged into handlers/index.ts behind the phase-switch `gated`; service in service/tat.service.ts (seam: tat.helpers.ts). Request shape as in review.handlers.test.ts.
// Fails now: the three operations still answer with the T-01 stub (501 / common.internal), not auth.unauthenticated.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { REPO_ROOT } from '../../../core/module.js';
import { makePlanCtx } from './plan.helpers.js';
import { DETAIL_EXTRA, DTO_KEYS, TAT, rejection } from './tat.helpers.js';

const svc: Record<string, ReturnType<typeof vi.fn>> = {};
vi.mock('../service/tat.service.js', () => ({ createTatService: () => svc }));
vi.stubEnv('LIMS_QUALITY_ENABLED', 'true');   // read once at module load (handlers/index.ts)
const { manifest } = await import('../index.js');
const h = (op: string): any => (manifest.handlers as any)[op];
const OPS = ['listTatAlerts', 'getTatAlert', 'acknowledgeTatAlert'] as const;
const hctx = (operationId: string) => ({ operationId, clientIp: '203.0.113.9', ...makePlanCtx().ctx });
const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
const ifm = (v: number | string) => ({ 'if-match': typeof v === 'number' ? `"${v}"` : v });
beforeEach(() => { for (const op of OPS) svc[op] = vi.fn(async () => ({ status: 200, body: { ok: op }, version: 3 })); });

describe('no longer stubs; fail closed without an authenticated request context', () => {
  it.each(OPS)('%s has a real handler: no context -> auth.unauthenticated, service never called', async (op) => {
    const e = await rejection(h(op)(req(), { operationId: op, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } })); expect(e?.code).toBe('auth.unauthenticated'); expect(svc[op]).not.toHaveBeenCalled();
  });
  it('a context without a transaction or actor is also refused', async () => {
    for (const bad of [{ tenantId: 'T', actor: { id: 'U' } }, { tenantId: 'T', tx: {} }, { actor: { id: 'U' }, tx: {} }]) expect((await rejection(h('getTatAlert')(req({ params: { tat_item_id: TAT(1) } }), { operationId: 'getTatAlert', log: { info() {}, warn() {}, error() {} }, ...bad })))?.code).toBe('auth.unauthenticated');
    expect(svc['getTatAlert']).not.toHaveBeenCalled();
  });
  it('a failed call echoes no request input in code/message/detail; service errors propagate untouched', async () => {
    const planted = 'PLANTED-TOKEN-9f3a'; svc['getTatAlert']!.mockRejectedValueOnce(Object.assign(new Error('common.not_found'), { code: 'common.not_found' }));
    const e = await rejection(h('getTatAlert')(req({ params: { tat_item_id: planted }, headers: { authorization: planted } }), hctx('getTatAlert'))); expect(e?.code).toBe('common.not_found'); expect(JSON.stringify({ c: e?.code, m: e?.message, d: e?.detail })).not.toContain(planted);
    for (const [op, c, extra] of [['listTatAlerts', 'common.validation_failed', {}], ['acknowledgeTatAlert', 'common.immutable_record', { headers: ifm(1) }], ['acknowledgeTatAlert', 'common.version_conflict', { headers: ifm(1) }]] as const) {
      svc[op]!.mockRejectedValueOnce(Object.assign(new Error(c), { code: c })); await expect(h(op)(req({ params: { tat_item_id: TAT(1) }, body: {}, ...extra }), hctx(op))).rejects.toMatchObject({ code: c });
    }
  });
});

describe('phase switch off (ruling C9.T-06 extends to #48-#50)', () => {
  it('LIMS_QUALITY_ENABLED=false: every TAT op rejects common.feature_disabled and the service is not called', async () => {
    vi.resetModules(); vi.stubEnv('LIMS_QUALITY_ENABLED', 'false');
    try { const off: any = (await import('../index.js')).manifest; for (const op of OPS) { const e = await rejection(off.handlers[op](req(), hctx(op))); expect(e?.code, op).toBe('common.feature_disabled'); expect(svc[op], op).not.toHaveBeenCalled(); } } finally { vi.stubEnv('LIMS_QUALITY_ENABLED', 'true'); }
  });
});

describe('request -> service mapping', () => {
  it('#48 listTatAlerts: query -> camelCase input, the level csv reaches the service as sent; 200; a list has no ETag', async () => {
    const q = { level: 'breached,escalated', acknowledged: false, segment: 'total', department_id: 'D', centre_id: 'C', priority: 'urgent', sort: '-pct_of_target', cursor: 'C1', limit: 25 };
    const r = await h('listTatAlerts')(req({ query: q }), hctx('listTatAlerts'));
    expect(svc['listTatAlerts']).toHaveBeenCalledWith(expect.objectContaining({ tenantId: expect.any(String) }), { level: 'breached,escalated', acknowledged: false, segment: 'total', departmentId: 'D', centreId: 'C', priority: 'urgent', sort: '-pct_of_target', cursor: 'C1', limit: 25 });
    expect(r.status).toBe(200); expect(r.headers?.etag).toBeUndefined(); expect(r.body).toEqual({ ok: 'listTatAlerts' });
  });
  it('#48 with no query: every filter reaches the service as undefined (the service owns the defaults)', async () => {
    await h('listTatAlerts')(req(), hctx('listTatAlerts')); const arg = svc['listTatAlerts']!.mock.calls[0]![1]; expect(Object.values(arg).every((v) => v === undefined)).toBe(true); expect(Object.keys(arg).length).toBeGreaterThanOrEqual(8);
  });
  it('#49 getTatAlert: path -> {tatItemId}; 200 + ETag of the item version (the client needs it for If-Match on #50)', async () => {
    const r = await h('getTatAlert')(req({ params: { tat_item_id: TAT(1) } }), hctx('getTatAlert')); expect(svc['getTatAlert']).toHaveBeenCalledWith(expect.anything(), { tatItemId: TAT(1) }); expect(r.status).toBe(200); expect(r.headers?.etag).toBe('"3"');
  });
  it('#50 acknowledgeTatAlert: path + If-Match + body -> service; 200 + ETag of the new version; body passed UNCHANGED (a smuggled tenant_id / status is rejected by the service, not dropped here)', async () => {
    const b = { note: 'Synthetic: queue cleared', tenant_id: 'T', status: 'resolved' }; const r = await h('acknowledgeTatAlert')(req({ params: { tat_item_id: TAT(2) }, headers: ifm(2), body: b }), hctx('acknowledgeTatAlert'));
    expect(svc['acknowledgeTatAlert']).toHaveBeenCalledWith(expect.anything(), { tatItemId: TAT(2), expectedVersion: 2, body: b }); expect(r.status).toBe(200); expect(r.headers?.etag).toBe('"3"');
  });
  it('#50: absent If-Match -> the service gets expectedVersion undefined (it answers 428)', async () => {
    await h('acknowledgeTatAlert')(req({ params: { tat_item_id: TAT(2) }, body: {} }), hctx('acknowledgeTatAlert')); expect(svc['acknowledgeTatAlert']).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ expectedVersion: undefined }));
  });
  it('#50: malformed If-Match (W/"1", 1, "0", "01", "1x", "") -> 400 common.validation_failed, service not called', async () => {
    for (const v of ['W/"1"', '1', '"0"', '"01"', '"1x"', '""']) expect((await rejection(h('acknowledgeTatAlert')(req({ params: { tat_item_id: TAT(2) }, headers: { 'if-match': v }, body: {} }), hctx('acknowledgeTatAlert'))))?.code, v).toBe('common.validation_failed');
    expect(svc['acknowledgeTatAlert']).not.toHaveBeenCalled();
  });
  it('tenant_id / created_by in a path, query or header never reach the service input', async () => {
    await h('listTatAlerts')(req({ query: { tenant_id: 'T' }, headers: { 'x-tenant-id': 'T' } }), hctx('listTatAlerts')); await h('getTatAlert')(req({ params: { tat_item_id: TAT(1), tenant_id: 'T' }, query: { tenant_id: 'T' }, headers: { 'x-tenant-id': 'T' } }), hctx('getTatAlert'));
    expect(JSON.stringify([svc['listTatAlerts']!.mock.calls[0]![1], svc['getTatAlert']!.mock.calls[0]![1]])).not.toMatch(/"T"|tenant/);
  });
  it('the service is handed the request context (tenant, actor, tx), not a copy built from request fields', async () => {
    await h('getTatAlert')(req({ params: { tat_item_id: TAT(1) } }), hctx('getTatAlert')); const c = svc['getTatAlert']!.mock.calls[0]![0]; expect(c.tenantId).toBeTruthy(); expect(c.actor.id).toBeTruthy(); expect(c.tx).toBeTruthy();
  });
});

describe('contract flags the core pipeline enforces (contracts/openapi/quality.yaml, 02-TRD §5.7)', () => {
  const doc: any = parse(readFileSync(join(REPO_ROOT, 'contracts', 'openapi', 'quality.yaml'), 'utf8'));
  const op = (id: string) => { for (const [path, item] of Object.entries<any>(doc.paths)) for (const [method, o] of Object.entries<any>(item)) if (o?.operationId === id) return { path, method, o }; throw new Error(`no ${id}`); };
  const T: Array<[string, string, string, string, string, boolean, string, string[]]> = [   // [operationId, METHOD, path, x-permission, x-idempotency, takes If-Match, success status, extra error codes]
    ['listTatAlerts', 'get', '/v1/quality/tat-alerts', 'quality.tat_alert.read', 'none', false, '200', ['common.validation_failed', 'common.invalid_cursor']],
    ['getTatAlert', 'get', '/v1/quality/tat-alerts/{tat_item_id}', 'quality.tat_alert.read', 'none', false, '200', ['common.not_found']],
    ['acknowledgeTatAlert', 'post', '/v1/quality/tat-alerts/{tat_item_id}/acknowledge', 'quality.tat_alert.ack', 'required', true, '200', ['common.immutable_record', 'common.not_found']],
  ];
  it.each(T)('%s: method/path, permission, idempotency, If-Match, success status, error codes', (id, method, path, perm, idem, ifMatch, ok, extra) => {
    const r = op(id); expect(r.method).toBe(method); expect(r.path).toBe(path); expect(r.o['x-permission']).toBe(perm); expect(r.o['x-idempotency'] ?? 'none').toBe(idem);
    expect(JSON.stringify(r.o.parameters ?? []).includes('IfMatch')).toBe(ifMatch); expect(Object.keys(r.o.responses)).toContain(ok); expect(r.o['x-error-codes']).toEqual(expect.arrayContaining([...extra, 'common.feature_disabled']));
    if (ifMatch) expect(r.o['x-error-codes']).toEqual(expect.arrayContaining(['common.version_conflict', 'common.precondition_required']));
    if (idem === 'required') { expect(JSON.stringify(r.o.parameters)).toContain('IdempotencyKey'); expect(r.o['x-error-codes']).toEqual(expect.arrayContaining(['common.idempotency_key_required', 'common.idempotency_key_reused', 'common.idempotency_in_progress'])); }
  });
  it('done_when: #50 acknowledgeTatAlert is x-idempotency: required', () => { expect(op('acknowledgeTatAlert').o['x-idempotency']).toBe('required'); });
  it('#48 takes bounded filters only: level is an anchored csv enum, segment / priority / sort enums, ids are Uuid, limit/cursor from _common', () => {
    const p = (n: string) => op('listTatAlerts').o.parameters.find((x: any) => x.name === n);
    expect(p('level').schema.pattern).toMatch(/^\^\(warning\|breached\|escalated\)/); expect(p('segment').schema.enum).toEqual(['within_lab', 'total']); expect(p('priority').schema.enum).toEqual(['routine', 'urgent']);
    expect(p('sort').schema.enum).toEqual(['-alert_level_rank', '-pct_of_target', 'started_at']); for (const n of ['department_id', 'centre_id']) expect(JSON.stringify(p(n).schema), n).toContain('Uuid');
    expect(JSON.stringify(op('listTatAlerts').o.parameters)).toContain('Limit'); expect(JSON.stringify(op('listTatAlerts').o.parameters)).toContain('Cursor');
  });
  it('#50 request schema: only note <= 500, additionalProperties false (mass assignment, S-03)', () => {
    const s = op('acknowledgeTatAlert').o.requestBody.content['application/json'].schema; expect(s.additionalProperties).toBe(false); expect(Object.keys(s.properties)).toEqual(['note']); expect(s.properties.note.maxLength).toBe(500);
  });
  it('response DTOs (TRD §5.10, REQ-SEC-081): TatAlertDto / TatAlertDetailDto are additionalProperties:false with exactly the allowlisted fields; none carries tenant_id or a user id', () => {
    const d = doc.components.schemas; expect(Object.keys(d.TatAlertDto.properties).sort()).toEqual([...DTO_KEYS].sort()); expect(Object.keys(d.TatAlertDetailDto.properties).sort()).toEqual([...DTO_KEYS, ...DETAIL_EXTRA].sort());
    for (const k of ['TatAlertDto', 'TatAlertDetailDto']) { expect(d[k].additionalProperties, k).toBe(false); for (const bad of ['tenant_id', 'created_by', 'updated_by', 'acknowledged_by', 'last_seen_sweep_at']) expect(Object.keys(d[k].properties), `${k} ${bad}`).not.toContain(bad); }
  });
  it('AB-10 / S-09 by construction: no PUT / PATCH / DELETE on /tat-alerts and exactly the three routes', () => {
    for (const p of Object.keys(doc.paths).filter((x) => x.includes('/tat-alerts'))) expect(Object.keys(doc.paths[p]).filter((m) => ['put', 'patch', 'delete'].includes(m)), p).toEqual([]);
    expect(Object.keys(doc.paths).filter((p) => p.includes('/tat-alerts')).sort()).toEqual(['/v1/quality/tat-alerts', '/v1/quality/tat-alerts/{tat_item_id}', '/v1/quality/tat-alerts/{tat_item_id}/acknowledge']);
  });
  it('the handler map has an entry for each of the 3 operationIds and each is a function', () => { for (const id of OPS) expect(typeof h(id), id).toBe('function'); });
});
