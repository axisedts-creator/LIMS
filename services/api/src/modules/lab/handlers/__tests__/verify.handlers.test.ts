// C5 T-16 handlers: #27 verifyResult, #28 bulkVerifyResults, #29 returnResult (02-TRD §5.4; PRD AC-12.3, AC-15.1–15.4; 07-SECURITY P-01/P-02/P-04, S-03, S-19; REQ-SEC-099 no stub).
// Fails now: handlers/index.ts maps all three to the T-01 stub (common.internal) and result.service.ts has no verify/return functions.
// Handler contract as in resultEntry.handlers.test.ts / critical.handlers.test.ts: (req:{params,query,headers,body}, ctx) -> {status, body}; needs ctx.tenantId + ctx.actor.id + ctx.tx else auth.unauthenticated;
//   a ctx without store/ports fails closed with common.internal. Schema / auth / x-permission / Idempotency-Key are enforced by the core pipeline, NOT here (lab.yaml is read below to pin the contract).
// Single-row ops take the expected version from `If-Match: "<n>"` (headers lower-cased; missing -> 428 common.precondition_required, malformed -> 400 common.validation_failed at /headers/if-match, as specimen.service.ts);
//   bulk takes it per item. Request snake_case -> service camelCase (verifyResult / bulkVerifyResults / returnResult of service/result.service.ts, seam documented in service/__tests__/result.service.verify.test.ts);
//   rows -> ResultDto via mappers/result.mapper.ts. Store/ports come from the ctx (VerifyStore + ports.IdentityPort.assertRole); production SQL wiring comes with the core pipeline (as T-14/T-15).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { handlers } from '../index.js';

const spec: any = parse(readFileSync(fileURLToPath(new URL('../../../../../../../contracts/openapi/lab.yaml', import.meta.url)), 'utf8'));
const S = spec.components.schemas;
const TENANT = '01a1a98a-ac40-7000-8000-00000000a001';
const ACTOR = '01a1b34e-1000-7eee-9d29-d7ca59a102b5', MEMBERSHIP = '01a1b34e-2000-7eee-9d29-d7ca59a102b6';
const NOW = new Date('2026-06-15T05:00:00Z');
const u = (n: number) => `01a1a98a-ac40-7000-8000-${n.toString(16).padStart(12, '0')}`;
const CENTRE = u(0xa201), ORDER = u(0xc1), ITEM = u(0xb1), SPEC = u(0xe1);
const LEAK = /tenant_id|created_by|updated_by|patient_id|centre_id|department_id|hold_id|manual_abnormal|order_test_id|acknowledged|reason_code|EVIL/;

const vrow = (id: string, over: Record<string, unknown> = {}) => ({
  resultId: id, rowVersion: 4, status: 'resulted', onHold: false, unitMismatch: false, deltaStatus: 'pass', isCritical: false, instrumentFlags: [] as string[], origin: 'manual', rangeUnavailableAgeUnknown: false,
  orderId: ORDER, orderItemId: ITEM, specimenId: SPEC, patientId: u(6), testId: u(7), analyteId: u(8), departmentId: u(9), centreId: CENTRE, currentVersionNo: 1, flag: 'N', valueNumeric: '13.4',
  resultedAt: new Date('2026-06-15T04:00:00Z'), ...over,
});

function ctxOf(rows: any[], opt: { assertRole?: (r: any) => Promise<void>; tenantId?: string } = {}) {
  const calls: { fn: string; tenantId: unknown; arg: any }[] = [], published: any[] = [], asked: any[] = [];
  const byId = new Map(rows.map((r) => [r.resultId, r]));
  const rec = (fn: string, tenantId: unknown, arg: any) => calls.push({ fn, tenantId, arg });
  const dto = (src: any, status: string, extra: Record<string, unknown> = {}) => ({
    id: src.resultId, version: src.rowVersion + 1, order_id: src.orderId, order_item_id: src.orderItemId, specimen_id: src.specimenId, test_id: src.testId, analyte_id: src.analyteId, analyte_code: 'HB',
    status, origin: src.origin, value_numeric: src.valueNumeric, flag: src.flag, on_hold: false, qc_review_required: false, unit_mismatch: src.unitMismatch, current_version_no: 1, range_unavailable_age_unknown: false,
    tenant_id: TENANT, centre_id: CENTRE, patient_id: u(6), department_id: u(9), created_by: ACTOR, updated_by: ACTOR, ...extra,
  });
  const store = {
    async lockForVerify(_t: unknown, tn: string, ids: string[]) { rec('lockForVerify', tn, ids); return ids.map((i) => byId.get(i)).filter(Boolean); },
    async verify(_t: unknown, tn: string, a: any) { rec('verify', tn, a); return dto(byId.get(a.resultId), 'verified', { verified_at: new Date(a.occurredAt), verified_by_membership_id: a.membershipId }); },
    async applyReturn(_t: unknown, tn: string, a: any) { rec('applyReturn', tn, a); return dto(byId.get(a.resultId), 'resulted'); },
    async returnReasonActive(_t: unknown, tn: string, c: string) { rec('returnReasonActive', tn, c); return c !== 'BAD'; },
    async resolveUnitMismatchException(_t: unknown, tn: string, a: any) { rec('resolveUnitMismatchException', tn, a); },
    async rollupSpecimen(_t: unknown, tn: string, s: string) { rec('rollupSpecimen', tn, s); },
  };
  const ctx = {
    operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} },
    tenantId: opt.tenantId ?? TENANT, actor: { type: 'user', id: ACTOR, membershipId: MEMBERSHIP }, tx: { id: 'tx' }, now: () => NOW, store,
    config: { autoverifyHookEnabled: false },
    events: { async publish(...a: unknown[]) { published.push(a); return { eventId: 'e', duplicate: false }; } },
    audit: { async access() {} },
    ports: { IdentityPort: { async assertRole(_c: unknown, r: any) { asked.push(r); await opt.assertRole?.(r); } } },
  };
  return { ctx: ctx as never, calls, of: (fn: string) => calls.filter((c) => c.fn === fn), published, asked };
}
const run = (op: string, req: unknown, c: unknown): Promise<any> => (handlers as any)[op](req, c);
const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } throw new Error('expected rejection'); };
const ifm = (n: number | string) => ({ 'if-match': typeof n === 'number' ? `"${n}"` : n });
const one = (id: string, body: unknown = {}, headers: Record<string, string> = ifm(4)) => ({ params: { result_id: id }, query: {}, headers, body }) as never;
const bulk = (items: unknown[], extra: Record<string, unknown> = {}) => ({ params: {}, query: {}, headers: { 'idempotency-key': 't16-1' }, body: { items, ...extra } }) as never;
const dtoKeys = (): string[] => Object.keys(S.ResultDto.properties);
const assertDto = (d: any) => { for (const k of Object.keys(d)) expect(dtoKeys(), k).toContain(k); for (const k of S.ResultDto.required) expect(d, k).toHaveProperty(k); expect(JSON.stringify(d)).not.toMatch(LEAK); };

describe('T-16 contract of lab.yaml #27–#29 (the handlers must fit it)', () => {
  const op = (path: string, m: string) => spec.paths[path][m];
  const verify = op('/v1/lab/results/{result_id}/verify', 'post'), bulkOp = op('/v1/lab/results/bulk-verify', 'post'), ret = op('/v1/lab/results/{result_id}/return', 'post');
  it('permissions, idempotency, error codes (lab.flag_ack_required is declared: CR-C5-005)', () => {
    expect(verify).toMatchObject({ operationId: 'verifyResult', 'x-permission': 'lab.result.verify', 'x-idempotency': 'optional' });
    expect(bulkOp).toMatchObject({ operationId: 'bulkVerifyResults', 'x-permission': 'lab.result.verify', 'x-idempotency': 'required' });
    expect(ret).toMatchObject({ operationId: 'returnResult', 'x-permission': 'lab.result.verify', 'x-idempotency': 'optional' });
    for (const o of [verify, bulkOp]) expect(o['x-error-codes']).toEqual(expect.arrayContaining(['lab.flag_ack_required', 'lab.result_invalid_transition', 'lab.result_on_hold']));
    expect(ret['x-error-codes']).toContain('lab.result_invalid_transition');
  });
  it('bodies are closed objects: no value / tenant field can be sent (S-03, REQ-SEC-024)', () => {
    const b = (o: any) => o.requestBody.content['application/json'].schema;
    expect(b(verify).additionalProperties).toBe(false);
    expect(Object.keys(b(verify).properties)).toEqual(['acknowledged_flags']);
    expect(b(verify).properties.acknowledged_flags.items.enum.sort()).toEqual(['critical', 'delta', 'instrument_flag', 'unit_mismatch']);
    expect(b(bulkOp).properties.items).toMatchObject({ minItems: 1, maxItems: 200 });
    expect(Object.keys(b(bulkOp).properties.items.items.properties).sort()).toEqual(['acknowledged_flags', 'id', 'version']);
    expect(b(ret).additionalProperties).toBe(false);
    expect(b(ret).required).toEqual(['reason_code']);
    expect(Object.keys(b(ret).properties).sort()).toEqual(['comment', 'reason_code']);
  });
  it('single ops answer a ResultDto, bulk a ResultBulkResponse {results:[{id,outcome,code?,result?}]}', () => {
    expect(verify.responses['200'].content['application/json'].schema.$ref).toMatch(/ResultDto$/);
    expect(ret.responses['200'].content['application/json'].schema.$ref).toMatch(/ResultDto$/);
    expect(bulkOp.responses['200'].content['application/json'].schema.$ref).toMatch(/ResultBulkResponse$/);
    expect(Object.keys(S.ResultBulkResponse.properties.results.items.properties).sort()).toEqual(['code', 'id', 'outcome', 'result']);
  });
});

describe('T-16 are real handlers, not the T-01 stub (REQ-SEC-099)', () => {
  const REQS: Record<string, unknown> = { verifyResult: one(u(1)), bulkVerifyResults: bulk([{ id: u(1), version: 4 }]), returnResult: one(u(1), { reason_code: 'RECHECK' }) };
  for (const opId of Object.keys(REQS)) {
    it(`${opId}: ctx without tenantId/actor/tx -> auth.unauthenticated (the stub answers common.internal)`, async () => {
      const bare = { operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } };
      expect((await fail(run(opId, REQS[opId], bare))).code).toBe('auth.unauthenticated');
    });
    it(`${opId}: authenticated ctx without store/ports -> common.internal (fail closed, never a 200)`, async () => {
      const c: any = ctxOf([vrow(u(1))]).ctx; delete c.store;
      expect((await fail(run(opId, REQS[opId], c))).code).toBe('common.internal');
    });
  }
  it('mapped to functions distinct from the shared stub', () => {
    const stub = (handlers as any).getResultHistory;
    for (const opId of Object.keys(REQS)) expect((handlers as any)[opId], opId).not.toBe(stub);
  });
});

describe('T-16 verifyResult (#27) request -> service -> response (AC-15.1, AC-12.3)', () => {
  it('200 ResultDto status verified, allowlist keys only, ISO verified_at and verified_by = caller membership; version from If-Match goes to the store', async () => {
    const c = ctxOf([vrow(u(1))]);
    const r = await run('verifyResult', one(u(1)), c.ctx);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: u(1), status: 'verified', version: 5, verified_at: NOW.toISOString(), verified_by: MEMBERSHIP });
    assertDto(r.body);
    expect(c.of('verify')[0]).toMatchObject({ tenantId: TENANT, arg: { resultId: u(1), expectedRowVersion: 4, mode: 'manual', membershipId: MEMBERSHIP, acknowledgedFlags: [] } });
  });
  it('AC-12.3: delta failure without acknowledged_flags -> lab.flag_ack_required (409); with ["delta"] -> 200 and the flag is stored on the verification', async () => {
    const c = ctxOf([vrow(u(1), { deltaStatus: 'fail' })]);
    const e = await fail(run('verifyResult', one(u(1), {}), c.ctx));
    expect(e.code).toBe('lab.flag_ack_required');
    expect(e.statusCode).toBe(409);
    expect(c.of('verify')).toHaveLength(0);
    const r = await run('verifyResult', one(u(1), { acknowledged_flags: ['delta'] }), c.ctx);
    expect(r.body.status).toBe('verified');
    expect(c.of('verify')[0]!.arg.acknowledgedFlags).toEqual(['delta']);
  });
  it('unit_mismatch acknowledged -> the open unit_mismatch exception of the result is resolved (finding C5 #42)', async () => {
    const c = ctxOf([vrow(u(1), { unitMismatch: true })]);
    await run('verifyResult', one(u(1), { acknowledged_flags: ['unit_mismatch'] }), c.ctx);
    expect(c.of('resolveUnitMismatchException')[0]).toMatchObject({ tenantId: TENANT, arg: { resultId: u(1), resolverMembershipId: MEMBERSHIP, resolution: 'assigned' } });
  });
  it('AC-15.3: pending result -> 409 lab.result_invalid_transition; on hold -> 409 lab.result_on_hold', async () => {
    const c = ctxOf([vrow(u(1), { status: 'pending' }), vrow(u(2), { onHold: true })]);
    const a = await fail(run('verifyResult', one(u(1)), c.ctx));
    expect([a.code, a.statusCode]).toEqual(['lab.result_invalid_transition', 409]);
    expect((await fail(run('verifyResult', one(u(2)), c.ctx))).code).toBe('lab.result_on_hold');
  });
  it('If-Match: missing -> 428 common.precondition_required; malformed / non-positive -> common.validation_failed; nothing is read or written', async () => {
    const c = ctxOf([vrow(u(1))]);
    const m = await fail(run('verifyResult', one(u(1), {}, {}), c.ctx));
    expect([m.code, m.statusCode]).toEqual(['common.precondition_required', 428]);
    for (const bad of ['4', 'W/"4"', '"0"', '"-1"', '"4x"', '""']) {
      const e = await fail(run('verifyResult', one(u(1), {}, ifm(bad)), c.ctx));
      expect(e.code, bad).toBe('common.validation_failed');
    }
    expect(c.of('verify')).toHaveLength(0);
  });
  it('stale If-Match -> 409 common.version_conflict', async () => {
    const c = ctxOf([vrow(u(1))]);
    expect((await fail(run('verifyResult', one(u(1), {}, ifm(3)), c.ctx))).code).toBe('common.version_conflict');
  });
  it('P-01/P-02: unknown id and a centre the caller lacks both answer 404 common.not_found, no body data, nothing written', async () => {
    const c = ctxOf([vrow(u(1))], { assertRole: async () => { throw new LimsError('auth.forbidden'); } });
    const a = await fail(run('verifyResult', one(u(9)), c.ctx));
    const b = await fail(run('verifyResult', one(u(1)), c.ctx));
    expect([a.code, a.statusCode, b.code, b.statusCode]).toEqual(['common.not_found', 404, 'common.not_found', 404]);
    expect(c.of('verify')).toHaveLength(0);
  });
  it('S-03 / REQ-SEC-024: value, tenant, status or verified_by fields smuggled in the body are never read; tenant comes from ctx', async () => {
    const c = ctxOf([vrow(u(1))]);
    await run('verifyResult', one(u(1), { value_numeric: '987.65', status: 'approved', verified_by: 'EVIL', tenant_id: 'EVIL', membership_id: 'EVIL', centre_id: 'EVIL' }), c.ctx);
    expect(JSON.stringify(c.calls)).not.toContain('EVIL');
    expect(JSON.stringify(c.calls)).not.toContain('987.65');
    expect(c.of('verify')[0]!.arg.membershipId).toBe(MEMBERSHIP);
    expect(c.calls.every((x) => x.tenantId === TENANT)).toBe(true);
  });
  it('the role asked for is lab.result.verify at the result centre (authz after the object load)', async () => {
    const c = ctxOf([vrow(u(1))]);
    await run('verifyResult', one(u(1)), c.ctx);
    expect(c.asked).toEqual([{ permission: 'lab.result.verify', centreId: CENTRE }]);
  });
  it('lab.result.verified.v1 is published through ctx.events.publish exactly once, mode manual', async () => {
    const c = ctxOf([vrow(u(1))]);
    await run('verifyResult', one(u(1)), c.ctx);
    const ev = c.published.filter((a) => a.includes('lab.result.verified.v1'));
    expect(ev).toHaveLength(1);
    expect(ev[0]![ev[0]!.length - 1].payload).toMatchObject({ result_id: u(1), mode: 'manual', verified_by_membership_id: MEMBERSHIP });
  });
});

describe('T-16 bulkVerifyResults (#28) (AC-15.2, P-04)', () => {
  it('50 ids of which 5 belong to another tenant/centre -> 200 with per-id outcomes in input order; foreign ids are common.not_found with no result', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => u(0x100 + i));
    const foreign = new Set(ids.filter((_, i) => i % 10 === 4));
    const c = ctxOf(ids.filter((x) => !foreign.has(x)).map((x) => vrow(x)));
    const r = await run('bulkVerifyResults', bulk(ids.map((x) => ({ id: x, version: 4 }))), c.ctx);
    expect(r.status).toBe(200);
    expect(r.body.results.map((x: any) => x.id)).toEqual(ids);
    for (const x of r.body.results) {
      expect(Object.keys(x).every((k) => ['id', 'outcome', 'code', 'result'].includes(k))).toBe(true);
      if (foreign.has(x.id)) expect(x).toEqual({ id: x.id, outcome: 'error', code: 'common.not_found' });
      else { expect(x.outcome).toBe('ok'); expect(x.result.status).toBe('verified'); assertDto(x.result); }
    }
    expect(c.of('verify')).toHaveLength(45);
    expect(JSON.stringify(r.body)).not.toMatch(LEAK);
  });
  it('per-item version and acknowledged_flags reach the service (snake_case -> camelCase); a flagged row without the ack fails alone with lab.flag_ack_required', async () => {
    const c = ctxOf([vrow(u(1), { isCritical: true }), vrow(u(2), { isCritical: true }), vrow(u(3))]);
    const r = await run('bulkVerifyResults', bulk([{ id: u(1), version: 4, acknowledged_flags: ['critical'] }, { id: u(2), version: 4 }, { id: u(3), version: 2 }]), c.ctx);
    expect(r.body.results.map((x: any) => [x.outcome, x.code])).toEqual([['ok', undefined], ['error', 'lab.flag_ack_required'], ['error', 'common.version_conflict']]);
    expect(c.of('verify')).toHaveLength(1);
    expect(c.of('verify')[0]!.arg).toMatchObject({ resultId: u(1), expectedRowVersion: 4, acknowledgedFlags: ['critical'] });
  });
  it('items outside 1..200 -> 400 common.validation_failed at /items, nothing read or written', async () => {
    const c = ctxOf([vrow(u(1))]);
    for (const items of [[], Array.from({ length: 201 }, (_, i) => ({ id: u(0x100 + i), version: 1 })), undefined, 'x']) {
      const e = await fail(run('bulkVerifyResults', { params: {}, query: {}, headers: {}, body: { items } } as never, c.ctx));
      expect(e.code).toBe('common.validation_failed');
      expect(e.errors?.[0]?.path).toBe('/items');
    }
    expect(c.calls).toHaveLength(0);
  });
  it('REQ-SEC-024: tenant / centre / verified_by in the body or items are never read', async () => {
    const c = ctxOf([vrow(u(1))]);
    await run('bulkVerifyResults', bulk([{ id: u(1), version: 4, tenant_id: 'EVIL', verified_by: 'EVIL', value_numeric: '771.7' }], { tenant_id: 'EVIL' }), c.ctx);
    expect(JSON.stringify(c.calls)).not.toMatch(/EVIL|771\.7/);
  });
});

describe('T-16 returnResult (#29) (AC-15.4)', () => {
  it('verified -> 200 ResultDto status resulted; reason_code + comment reach the store; the specimen roll-up runs', async () => {
    const c = ctxOf([vrow(u(1), { status: 'verified' })]);
    const r = await run('returnResult', one(u(1), { reason_code: 'RECHECK', comment: 'check dilution' }), c.ctx);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: u(1), status: 'resulted' });
    assertDto(r.body);
    expect(c.of('applyReturn')[0]).toMatchObject({ tenantId: TENANT, arg: { resultId: u(1), expectedRowVersion: 4, reasonCode: 'RECHECK', comment: 'check dilution', membershipId: MEMBERSHIP } });
    expect(c.of('rollupSpecimen').map((x) => x.arg)).toEqual([SPEC]);
  });
  it('not verified -> 409 lab.result_invalid_transition; inactive reason -> 400 common.validation_failed; nothing written', async () => {
    const c = ctxOf([vrow(u(1), { status: 'resulted' }), vrow(u(2), { status: 'verified' })]);
    expect((await fail(run('returnResult', one(u(1), { reason_code: 'RECHECK' }), c.ctx))).code).toBe('lab.result_invalid_transition');
    expect((await fail(run('returnResult', one(u(2), { reason_code: 'BAD' }), c.ctx))).code).toBe('common.validation_failed');
    expect(c.of('applyReturn')).toHaveLength(0);
  });
  it('If-Match missing -> 428; stale -> 409 common.version_conflict; foreign id -> 404', async () => {
    const c = ctxOf([vrow(u(1), { status: 'verified' })]);
    expect((await fail(run('returnResult', one(u(1), { reason_code: 'RECHECK' }, {}), c.ctx))).code).toBe('common.precondition_required');
    expect((await fail(run('returnResult', one(u(1), { reason_code: 'RECHECK' }, ifm(1)), c.ctx))).code).toBe('common.version_conflict');
    expect((await fail(run('returnResult', one(u(9), { reason_code: 'RECHECK' }), c.ctx))).code).toBe('common.not_found');
  });
  it('S-03 / REQ-SEC-024: value or tenant fields in the body are never read; no event is published', async () => {
    const c = ctxOf([vrow(u(1), { status: 'verified' })]);
    await run('returnResult', one(u(1), { reason_code: 'RECHECK', value_numeric: '555.5', tenant_id: 'EVIL', membership_id: 'EVIL' }), c.ctx);
    expect(JSON.stringify(c.calls)).not.toMatch(/EVIL|555\.5/);
    expect(c.published).toHaveLength(0);
  });
});
