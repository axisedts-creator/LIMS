// C9 T-12 — HTTP wiring of #26-#33 (02-TRD §5.5; contracts/openapi/quality.yaml). The review SERVICE is mocked (behaviour: review.service.test.ts): these tests fix req -> service input mapping, status
// codes, ETag, If-Match handling, fail-closed behaviour, the phase switch, and the contract flags the core pipeline enforces (x-idempotency required on #30-#33 incl. #31, If-Match, permissions, DTO allowlists).
// Request shapes as delivered by the core pipeline after schema validation: params {qc_run_id | observation_id}; query already typed; headers lower-case; body parsed JSON.
// Handlers live in handlers/review.handlers.ts and are merged into handlers/index.ts (every op wrapped by the phase-switch `gated`); service in service/review.service.ts (seam: review.helpers.ts).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { REPO_ROOT } from '../../../core/module.js';
import { makePlanCtx } from './plan.helpers.js';
import { CA_KEYS, OBS, OPS, REVIEW_KEYS, RUN, SUMMARY_KEYS, rejection } from './review.helpers.js';

const svc: Record<string, ReturnType<typeof vi.fn>> = {};
vi.mock('../service/review.service.js', () => ({ createReviewService: () => svc }));
// Phase switch (02-TRD:120, :806): the flag is read once at module load (handlers/index.ts), so enable it BEFORE the import.
vi.stubEnv('LIMS_QUALITY_ENABLED', 'true');
const { manifest } = await import('../index.js');
const h = (op: string): any => (manifest.handlers as any)[op];

const hctx = (operationId: string) => ({ operationId, clientIp: '203.0.113.9', ...makePlanCtx().ctx });
const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
const ifm = (v: number | string) => ({ 'if-match': typeof v === 'number' ? `"${v}"` : v });
const RUN_OPS = ['getQcRun', 'evaluateQcRunNow', 'recordCorrectiveAction', 'closeQcRun', 'acknowledgeQcRun'];
beforeEach(() => {
  for (const op of OPS) svc[op] = vi.fn(async () => ({ status: 200, body: { ok: op }, version: 3 }));
  svc['recordCorrectiveAction']!.mockImplementation(async () => ({ status: 201, body: { ok: 'recordCorrectiveAction' } }));
  svc['acknowledgeQcRun']!.mockImplementation(async () => ({ status: 201, body: { ok: 'acknowledgeQcRun' } }));
});

describe('no longer stubs; fail closed without an authenticated request context', () => {
  it.each(OPS)('%s has a real handler: no context -> auth.unauthenticated (the T-01 stub answers 501/common.internal), service never called', async (op) => {
    const e = await rejection(h(op)(req(), { operationId: op, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } }));
    expect(e?.code).toBe('auth.unauthenticated'); expect(svc[op]).not.toHaveBeenCalled();
  });
  it('a context without a transaction or actor is also refused (no partial context reaches the service)', async () => {
    for (const bad of [{ tenantId: 'T', actor: { id: 'U' } }, { tenantId: 'T', tx: {} }, { actor: { id: 'U' }, tx: {} }]) {
      const e = await rejection(h('closeQcRun')(req({ params: { qc_run_id: RUN(1) }, headers: ifm(1), body: {} }), { operationId: 'closeQcRun', log: { info() {}, warn() {}, error() {} }, ...bad }));
      expect(e?.code).toBe('auth.unauthenticated');
    }
    expect(svc['closeQcRun']).not.toHaveBeenCalled();
  });
  it('a failed call echoes no request input in code/message/detail', async () => {
    const planted = 'PLANTED-TOKEN-9f3a'; svc['closeQcRun']!.mockRejectedValueOnce(Object.assign(new Error('common.not_found'), { code: 'common.not_found' }));
    const e = await rejection(h('closeQcRun')(req({ params: { qc_run_id: planted }, headers: { authorization: planted, ...ifm(1) }, body: {} }), hctx('closeQcRun')));
    expect(JSON.stringify({ c: e?.code, m: e?.message, d: e?.detail })).not.toContain(planted);
  });
  it('service errors propagate untouched (the codes of each row of 02-TRD §5.5)', async () => {
    for (const [op, c, extra] of [['listQcObservations', 'common.validation_failed', {}], ['excludeQcObservation', 'quality.qc_run_already_evaluated', { headers: ifm(1) }], ['evaluateQcRunNow', 'quality.qc_run_already_evaluated', { headers: ifm(1) }],
      ['recordCorrectiveAction', 'common.immutable_record', {}], ['closeQcRun', 'quality.corrective_action_required', { headers: ifm(1) }], ['closeQcRun', 'quality.rerun_required', { headers: ifm(1) }], ['acknowledgeQcRun', 'common.immutable_record', {}]] as const) {
      svc[op]!.mockRejectedValueOnce(Object.assign(new Error(c), { code: c }));
      await expect(h(op)(req({ params: { qc_run_id: RUN(1), observation_id: OBS(1) }, body: {}, ...extra }), hctx(op))).rejects.toMatchObject({ code: c });
    }
  });
});

describe('phase switch off (ruling C9.T-06 extends to #26-#33)', () => {
  it('LIMS_QUALITY_ENABLED=false: every review op rejects common.feature_disabled and the service is not called', async () => {
    vi.resetModules(); vi.stubEnv('LIMS_QUALITY_ENABLED', 'false');
    try {
      const off: any = (await import('../index.js')).manifest;
      for (const op of OPS) { const e = await rejection(off.handlers[op](req(), hctx(op))); expect(e?.code, op).toBe('common.feature_disabled'); expect(svc[op], op).not.toHaveBeenCalled(); }
    } finally { vi.stubEnv('LIMS_QUALITY_ENABLED', 'true'); }
  });
});

describe('request -> service mapping', () => {
  it('#26 listQcObservations: query -> camelCase input, the status csv reaches the service as sent; 200; a list has no ETag', async () => {
    const q = { plan_id: 'P', instrument_id: 'I', analyte_id: 'A', level_id: 'L', lot_id: 'LT', status: 'assigned,excluded', observed_at_from: 'F', observed_at_to: 'T', sort: 'observed_at', cursor: 'C1', limit: 25 };
    const r = await h('listQcObservations')(req({ query: q }), hctx('listQcObservations'));
    expect(svc['listQcObservations']).toHaveBeenCalledWith(expect.objectContaining({ tenantId: expect.any(String) }), { planId: 'P', instrumentId: 'I', analyteId: 'A', levelId: 'L', lotId: 'LT', status: 'assigned,excluded', observedAtFrom: 'F', observedAtTo: 'T', sort: 'observed_at', cursor: 'C1', limit: 25 });
    expect(r.status).toBe(200); expect(r.headers?.etag).toBeUndefined(); expect(r.body).toEqual({ ok: 'listQcObservations' });
  });
  it('#28 listQcRuns: query -> camelCase input (needs_action boolean as typed by the pipeline); no ETag', async () => {
    const q = { plan_id: 'P', instrument_id: 'I', analyte_id: 'A', status: 'evaluated', outcome: 'rejected', needs_action: true, run_at_from: 'F', run_at_to: 'T', sort: '-run_at', cursor: 'C1', limit: 10 };
    const r = await h('listQcRuns')(req({ query: q }), hctx('listQcRuns'));
    expect(svc['listQcRuns']).toHaveBeenCalledWith(expect.anything(), { planId: 'P', instrumentId: 'I', analyteId: 'A', status: 'evaluated', outcome: 'rejected', needsAction: true, runAtFrom: 'F', runAtTo: 'T', sort: '-run_at', cursor: 'C1', limit: 10 });
    expect(r.headers?.etag).toBeUndefined();
  });
  it.each([['listQcObservations'], ['listQcRuns']])('#26/#28 %s with no query: every filter reaches the service as undefined (the service owns the 92-day defaults)', async (op) => {
    await h(op)(req(), hctx(op)); const arg = svc[op]!.mock.calls[0]![1]; expect(Object.values(arg).every((v) => v === undefined)).toBe(true); expect(Object.keys(arg).length).toBeGreaterThan(5);
  });
  it('#27 excludeQcObservation: path + If-Match + body -> service; 200 + ETag of the new version; body passed UNCHANGED (a smuggled tenant_id / status is rejected by the service, not dropped here)', async () => {
    const b = { reason_code: 'wrong_material', comment: 'x', tenant_id: 'T', status: 'assigned' };
    const r = await h('excludeQcObservation')(req({ params: { observation_id: OBS(2) }, headers: ifm(2), body: b }), hctx('excludeQcObservation'));
    expect(svc['excludeQcObservation']).toHaveBeenCalledWith(expect.anything(), { observationId: OBS(2), expectedVersion: 2, body: b }); expect(r.status).toBe(200); expect(r.headers?.etag).toBe('"3"');
  });
  it('#29 getQcRun: path -> {runId}; 200 + ETag of the run version (the client needs it for If-Match on #30/#32 — pinned beyond the contract text)', async () => {
    const r = await h('getQcRun')(req({ params: { qc_run_id: RUN(1) } }), hctx('getQcRun')); expect(svc['getQcRun']).toHaveBeenCalledWith(expect.anything(), { runId: RUN(1) }); expect(r.status).toBe(200); expect(r.headers?.etag).toBe('"3"');
  });
  it.each([['evaluateQcRunNow'], ['closeQcRun']])('#30/#32 %s: If-Match + path + body -> service; 200 + ETag of the new version', async (op) => {
    const r = await h(op)(req({ params: { qc_run_id: RUN(2) }, headers: ifm(4), body: { comment: 'c' } }), hctx(op));
    expect(svc[op]).toHaveBeenCalledWith(expect.anything(), { runId: RUN(2), expectedVersion: 4, body: { comment: 'c' } }); expect(r.status).toBe(200); expect(r.headers?.etag).toBe('"3"');
  });
  it.each([['evaluateQcRunNow'], ['closeQcRun']])('%s: absent If-Match -> service gets expectedVersion undefined (it answers 428)', async (op) => {
    await h(op)(req({ params: { qc_run_id: RUN(2) }, body: {} }), hctx(op)); expect(svc[op]).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ expectedVersion: undefined }));
  });
  it.each([['evaluateQcRunNow'], ['closeQcRun'], ['excludeQcObservation']])('%s: malformed If-Match (W/"1", 1, "0", "01", "1x", "") -> 400 common.validation_failed, service not called', async (op) => {
    for (const v of ['W/"1"', '1', '"0"', '"01"', '"1x"', '""']) expect((await rejection(h(op)(req({ params: { qc_run_id: RUN(2), observation_id: OBS(2) }, headers: { 'if-match': v }, body: {} }), hctx(op))))?.code, v).toBe('common.validation_failed');
    expect(svc[op]).not.toHaveBeenCalled();
  });
  it('#31 recordCorrectiveAction: path + body -> service; 201; no ETag (the log row has no version); no If-Match is read', async () => {
    const b = { action_code: 'recalibration', description: 'd', performed_at: '2026-11-13T08:30:00.000Z', tenant_id: 'T' };
    const r = await h('recordCorrectiveAction')(req({ params: { qc_run_id: RUN(1) }, headers: ifm('garbage'), body: b }), hctx('recordCorrectiveAction'));
    expect(svc['recordCorrectiveAction']).toHaveBeenCalledWith(expect.anything(), { runId: RUN(1), body: b }); expect(r.status).toBe(201); expect(r.headers?.etag).toBeUndefined();
  });
  it('#33 acknowledgeQcRun: path + body -> service; 201; no ETag', async () => {
    const r = await h('acknowledgeQcRun')(req({ params: { qc_run_id: RUN(3) }, body: { comment: 'ok' } }), hctx('acknowledgeQcRun'));
    expect(svc['acknowledgeQcRun']).toHaveBeenCalledWith(expect.anything(), { runId: RUN(3), body: { comment: 'ok' } }); expect(r.status).toBe(201); expect(r.headers?.etag).toBeUndefined();
  });
  it('tenant_id / created_by in a path, query or header never reach the service input', async () => {
    await h('listQcRuns')(req({ query: { tenant_id: 'T' }, headers: { 'x-tenant-id': 'T' } }), hctx('listQcRuns'));
    await h('getQcRun')(req({ params: { qc_run_id: RUN(1), tenant_id: 'T' }, query: { tenant_id: 'T' }, headers: { 'x-tenant-id': 'T' } }), hctx('getQcRun'));
    expect(JSON.stringify([svc['listQcRuns']!.mock.calls[0]![1], svc['getQcRun']!.mock.calls[0]![1]])).not.toMatch(/"T"|tenant/);
  });
  it('the service is handed the request context (tenant, actor, tx), not a copy built from request fields', async () => {
    await h('getQcRun')(req({ params: { qc_run_id: RUN(1) } }), hctx('getQcRun')); const c = svc['getQcRun']!.mock.calls[0]![0]; expect(c.tenantId).toBeTruthy(); expect(c.actor.id).toBeTruthy(); expect(c.tx).toBeTruthy();
  });
});

describe('contract flags the core pipeline enforces (contracts/openapi/quality.yaml, 02-TRD §5.0/§5.5)', () => {
  const doc: any = parse(readFileSync(join(REPO_ROOT, 'contracts', 'openapi', 'quality.yaml'), 'utf8'));
  const op = (id: string) => { for (const [path, item] of Object.entries<any>(doc.paths)) for (const [method, o] of Object.entries<any>(item)) if (o?.operationId === id) return { path, method, o }; throw new Error(`no ${id}`); };
  // [operationId, METHOD, path, x-permission, x-idempotency, takes If-Match, success status, extra error codes]
  const T: Array<[string, string, string, string, string, boolean, string, string[]]> = [
    ['listQcObservations', 'get', '/v1/quality/qc-observations', 'quality.qc_run.read', 'none', false, '200', ['common.validation_failed', 'common.invalid_cursor']],
    ['excludeQcObservation', 'post', '/v1/quality/qc-observations/{observation_id}/exclude', 'quality.qc.manage', 'optional', true, '200', ['quality.qc_run_already_evaluated']],
    ['listQcRuns', 'get', '/v1/quality/qc-runs', 'quality.qc_run.read', 'none', false, '200', ['common.validation_failed', 'common.invalid_cursor']],
    ['getQcRun', 'get', '/v1/quality/qc-runs/{qc_run_id}', 'quality.qc_run.read', 'none', false, '200', ['common.not_found']],
    ['evaluateQcRunNow', 'post', '/v1/quality/qc-runs/{qc_run_id}/evaluate', 'quality.qc_run.review', 'required', true, '200', ['quality.qc_run_already_evaluated']],
    ['recordCorrectiveAction', 'post', '/v1/quality/qc-runs/{qc_run_id}/corrective-actions', 'quality.qc_run.review', 'required', false, '201', ['common.immutable_record']],
    ['closeQcRun', 'post', '/v1/quality/qc-runs/{qc_run_id}/close', 'quality.qc_run.review', 'required', true, '200', ['quality.corrective_action_required', 'quality.rerun_required', 'common.immutable_record']],
    ['acknowledgeQcRun', 'post', '/v1/quality/qc-runs/{qc_run_id}/acknowledge', 'quality.qc_run.review', 'required', false, '201', ['common.immutable_record']],
  ];
  it('the table covers exactly #26-#33', () => { expect(T.map((t) => t[0]).sort()).toEqual([...OPS].sort()); });
  it.each(T)('%s: method/path, permission, idempotency, If-Match, success status, error codes', (id, method, path, perm, idem, ifMatch, ok, extra) => {
    const r = op(id); expect(r.method).toBe(method); expect(r.path).toBe(path);
    expect(r.o['x-permission']).toBe(perm); expect(r.o['x-idempotency'] ?? 'none').toBe(idem);
    expect(JSON.stringify(r.o.parameters ?? []).includes('IfMatch')).toBe(ifMatch); expect(Object.keys(r.o.responses)).toContain(ok);
    expect(r.o['x-error-codes']).toEqual(expect.arrayContaining(extra)); expect(r.o['x-error-codes']).toEqual(expect.arrayContaining(['common.feature_disabled']));
    if (ifMatch) expect(r.o['x-error-codes']).toEqual(expect.arrayContaining(['common.version_conflict', 'common.precondition_required']));
    if (idem === 'required') { expect(JSON.stringify(r.o.parameters)).toContain('IdempotencyKey'); expect(r.o['x-error-codes']).toEqual(expect.arrayContaining(['common.idempotency_key_required', 'common.idempotency_key_reused', 'common.idempotency_in_progress'])); }
  });
  it('done_when: #30, #32 and #33 are x-idempotency: required (and so is #31)', () => { for (const id of ['evaluateQcRunNow', 'closeQcRun', 'acknowledgeQcRun']) expect(op(id).o['x-idempotency'], id).toBe('required'); });
  it('#26 / #28 take bounded filters only: observed_at_from/_to and run_at_from/_to are IsoUtc; status/outcome are anchored csv enums; sort enums; limit/cursor from _common', () => {
    const p = (id: string, n: string) => op(id).o.parameters.find((x: any) => x.name === n);
    for (const [id, a, b] of [['listQcObservations', 'observed_at_from', 'observed_at_to'], ['listQcRuns', 'run_at_from', 'run_at_to']]) for (const n of [a!, b!]) expect(JSON.stringify(p(id!, n).schema), `${id} ${n}`).toContain('IsoUtc');
    expect(p('listQcRuns', 'status').schema.pattern).toMatch(/^\^\(collecting\|evaluated\|closed\)/); expect(p('listQcRuns', 'outcome').schema.pattern).toContain('accepted_warning'); expect(p('listQcRuns', 'sort').schema.enum).toEqual(['-run_at']);
    expect(p('listQcObservations', 'sort').schema.enum).toEqual(['-observed_at', 'observed_at']);
    expect(JSON.stringify(op('listQcRuns').o.parameters)).toContain('Limit'); expect(JSON.stringify(op('listQcObservations').o.parameters)).toContain('Cursor');
  });
  it('request schemas: #27 reason_code (coded set quality.exclusion_reasons) + comment <= 500; #30/#32 only comment <= 500; #31 action_code (quality.corrective_actions), description 1..1000, performed_at IsoUtc; #33 comment 1..500 required; all additionalProperties false', () => {
    const s = (id: string) => op(id).o.requestBody.content['application/json'].schema;
    for (const id of ['excludeQcObservation', 'evaluateQcRunNow', 'recordCorrectiveAction', 'closeQcRun', 'acknowledgeQcRun']) expect(s(id).additionalProperties, id).toBe(false);
    expect(s('excludeQcObservation').required).toEqual(['reason_code']); expect(s('excludeQcObservation').properties.reason_code['x-coded-set']).toBe('quality.exclusion_reasons'); expect(s('excludeQcObservation').properties.comment.maxLength).toBe(500);
    for (const id of ['evaluateQcRunNow', 'closeQcRun']) { expect(Object.keys(s(id).properties), id).toEqual(['comment']); expect(s(id).properties.comment.maxLength).toBe(500); expect(s(id).required ?? []).toEqual([]); }
    expect(s('recordCorrectiveAction').required).toEqual(expect.arrayContaining(['action_code', 'description', 'performed_at'])); expect(s('recordCorrectiveAction').properties.action_code['x-coded-set']).toBe('quality.corrective_actions');
    expect(s('recordCorrectiveAction').properties.description).toMatchObject({ minLength: 1, maxLength: 1000 }); expect(JSON.stringify(s('recordCorrectiveAction').properties.performed_at)).toContain('IsoUtc');
    expect(s('acknowledgeQcRun').required).toEqual(['comment']); expect(s('acknowledgeQcRun').properties.comment).toMatchObject({ minLength: 1, maxLength: 500 });
  });
  it('response DTOs (TRD §5.10, REQ-SEC-081): QcRunSummaryDto / QcRunDto / CorrectiveActionDto / QcRunReviewDto are additionalProperties:false with exactly the allowlisted fields; none carries tenant_id or a user id', () => {
    const d = doc.components.schemas;
    expect(Object.keys(d.QcRunSummaryDto.properties).sort()).toEqual([...SUMMARY_KEYS, 'needs_action_reason'].sort()); expect(d.QcRunSummaryDto.additionalProperties).toBe(false);
    expect(Object.keys(d.CorrectiveActionDto.properties).sort()).toEqual(CA_KEYS); expect(Object.keys(d.QcRunReviewDto.properties).sort()).toEqual(REVIEW_KEYS);
    expect(Object.keys(d.QcRunDto.properties)).toEqual(expect.arrayContaining([...SUMMARY_KEYS, 'needs_action_reason', 'plan_version_no', 'observations', 'rule_detail', 'hold', 'corrective_actions', 'reviews', 'evaluated_at', 'evaluated_by']));
    for (const k of ['QcRunSummaryDto', 'QcRunDto', 'CorrectiveActionDto', 'QcRunReviewDto', 'QcObservationDto']) { expect(d[k].additionalProperties, k).toBe(false); expect(Object.keys(d[k].properties), k).not.toContain('tenant_id'); expect(Object.keys(d[k].properties), k).not.toContain('created_by'); }
  });
  it('needs_action_reason enum is exactly corrective_action | rerun', () => { expect(doc.components.schemas.QcRunSummaryDto.properties.needs_action_reason.enum).toEqual(['corrective_action', 'rerun']); });
  it('AB-10 / S-09 by construction: there is NO route that edits or deletes a run, a corrective action or a review (no PUT/PATCH/DELETE on /qc-runs, /qc-observations)', () => {
    for (const p of Object.keys(doc.paths).filter((x) => /\/(qc-runs|qc-observations)/.test(x))) expect(Object.keys(doc.paths[p]).filter((m) => ['put', 'patch', 'delete'].includes(m)), p).toEqual([]);
    expect(Object.keys(doc.paths).filter((p) => p.includes('/qc-runs')).sort()).toEqual(['/v1/quality/qc-runs', '/v1/quality/qc-runs/{qc_run_id}', '/v1/quality/qc-runs/{qc_run_id}/acknowledge', '/v1/quality/qc-runs/{qc_run_id}/close',
      '/v1/quality/qc-runs/{qc_run_id}/corrective-actions', '/v1/quality/qc-runs/{qc_run_id}/evaluate']);
  });
  it('the handler map has an entry for every one of the 8 operationIds and each is a function', () => { for (const id of OPS) expect(typeof h(id), id).toBe('function'); expect(RUN_OPS.every((x) => (OPS as readonly string[]).includes(x))).toBe(true); });
});
