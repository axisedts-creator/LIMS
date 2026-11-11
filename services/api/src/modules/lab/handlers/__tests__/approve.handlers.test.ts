// C5 T-17 handlers: #30 approveResult, #31 bulkApproveResults, #32 amendResult, #33 listResultVersions (02-TRD §5.4; PRD AC-16.1–AC-16.3, AC-17.1–AC-17.3; 07-SECURITY S-01..S-04, S-19, P-01/P-02, 08 A13 P-1; REQ-SEC-099 no stub).
// Fails now: handlers/index.ts maps all four to the T-01 stub (common.internal) and result.service.ts has no approve/amend functions.
// Handler contract as verify.handlers.test.ts: (req:{params,query,headers,body}, ctx) -> {status, body}; needs ctx.tenantId + ctx.actor.id + ctx.tx else auth.unauthenticated; a ctx without store/ports fails closed (common.internal).
//   Schema / auth / x-permission / Idempotency-Key are enforced by the core pipeline, NOT here (lab.yaml is read below to pin the contract). If-Match "<n>": missing -> 428, malformed -> 400 /headers/if-match.
//   Request snake_case -> service camelCase (approveResult / bulkApproveResults / amendResult / listResultVersions of service/result.service.ts; seam in service/__tests__/approve.fixtures.ts); rows -> ResultDto via mappers/result.mapper.ts.
//   listResultVersions rows (lab.result_versions columns) -> ResultVersionDto { result_id, version_no, value_*, ordinal_code, unit_code, flag, reference_range_snapshot?, comment_*, amendment_reason_*, recorded_at (ISO), superseded: boolean (superseded_at set) }, allowlist only.
//   amendResult: body fields value_numeric | value_text | ordinal_code -> service value {numeric|text|ordinalCode}; comment_codes/comment_text/amendment_reason_code/amendment_reason_text -> camelCase; a missing amendment_reason_code reaches the service as
//   "no reason" -> 422 lab.amendment_reason_required (AC-17.3); module-only reason codes (module_phase_progression, module_preliminary_update, supplementary_report) -> 400 common.validation_failed at /amendment_reason_code BEFORE any store access (08 A13 P-1);
//   auth.forbidden for lab.result.amend -> 403 lab.amend_requires_pathologist (handler or service); auth.mfa_required passes through.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { handlers } from '../index.js';
import { amendRow, APPROVER, approveRow, CENTRE, fail, forbidden, id, make, mfaRequired, NOW, TENANT } from '../../service/__tests__/approve.fixtures.js';

const spec: any = parse(readFileSync(fileURLToPath(new URL('../../../../../../../contracts/openapi/lab.yaml', import.meta.url)), 'utf8'));
const S = spec.components.schemas;
const LEAK = /tenant_id|created_by|updated_by|patient_id|centre_id|department_id|hold_id|manual_abnormal|order_test_id|EVIL|approved_by_membership_id"/;
const run = (op: string, req: unknown, c: unknown): Promise<any> => (handlers as any)[op](req, c);
const ifm = (n: number | string) => ({ 'if-match': typeof n === 'number' ? `"${n}"` : n });
const one = (rid: string, body: unknown = {}, headers: Record<string, string> = ifm(7)) => ({ params: { result_id: rid }, query: {}, headers, body }) as never;
const bulk = (items: unknown[], extra: Record<string, unknown> = {}) => ({ params: {}, query: {}, headers: { 'idempotency-key': 't17-1' }, body: { items, ...extra } }) as never;
const assertDto = (d: any) => { for (const k of Object.keys(d)) expect(Object.keys(S.ResultDto.properties), k).toContain(k); for (const k of S.ResultDto.required) expect(d, k).toHaveProperty(k); expect(JSON.stringify(d)).not.toMatch(LEAK); };
const amendBody = (over: Record<string, unknown> = {}) => ({ value_numeric: '13.8', amendment_reason_code: 'TRANSCRIPTION_ERROR', amendment_reason_text: 'Synthetic reason', ...over });

describe('T-17 contract of lab.yaml #30–#33 (the handlers must fit it)', () => {
  const op = (path: string, m: string) => spec.paths[path][m];
  const approve = op('/v1/lab/results/{result_id}/approve', 'post'), bulkOp = op('/v1/lab/results/bulk-approve', 'post'), amend = op('/v1/lab/results/{result_id}/amend', 'post'), versions = op('/v1/lab/results/{result_id}/versions', 'get');
  it('permissions, idempotency, error codes', () => {
    expect(approve).toMatchObject({ operationId: 'approveResult', 'x-permission': 'lab.result.approve', 'x-idempotency': 'optional' });
    expect(bulkOp).toMatchObject({ operationId: 'bulkApproveResults', 'x-permission': 'lab.result.approve', 'x-idempotency': 'required' });
    expect(amend).toMatchObject({ operationId: 'amendResult', 'x-permission': 'lab.result.amend', 'x-idempotency': 'required' });
    expect(versions).toMatchObject({ operationId: 'listResultVersions', 'x-permission': 'lab.result.read' });
    for (const o of [approve, bulkOp]) expect(o['x-error-codes']).toEqual(expect.arrayContaining(['lab.self_approval_forbidden', 'lab.critical_ack_required', 'auth.mfa_required', 'lab.result_invalid_transition', 'lab.result_on_hold']));
    expect(amend['x-error-codes']).toEqual(expect.arrayContaining(['lab.amend_requires_pathologist', 'lab.amendment_reason_required', 'auth.mfa_required', 'lab.result_value_invalid']));
  });
  it('bodies are closed objects: approve takes {} (no value / tenant / approver field), amend only the documented fields', () => {
    const b = (o: any) => o.requestBody.content['application/json'].schema;
    expect(b(approve).additionalProperties).toBe(false);
    expect(Object.keys(b(approve).properties)).toEqual([]);
    expect(b(amend).additionalProperties).toBe(false);
    expect(Object.keys(b(amend).properties).sort()).toEqual(['amendment_reason_code', 'amendment_reason_text', 'comment_codes', 'comment_text', 'ordinal_code', 'value_numeric', 'value_text']);
    expect(Object.keys(b(bulkOp).properties.items.items.properties).sort()).toEqual(['id', 'version']);
    expect(b(bulkOp).properties.items).toMatchObject({ minItems: 1, maxItems: 200 });
  });
});

describe('T-17 are real handlers, not the T-01 stub (REQ-SEC-099)', () => {
  const REQS: Record<string, unknown> = {
    approveResult: one(id(1)), bulkApproveResults: bulk([{ id: id(1), version: 7 }]), amendResult: one(id(1), amendBody(), ifm(9)), listResultVersions: { params: { result_id: id(1) }, query: {}, headers: {}, body: undefined },
  };
  for (const opId of Object.keys(REQS)) {
    it(`${opId}: ctx without tenantId/actor/tx -> auth.unauthenticated (the stub answers common.internal)`, async () => {
      const bare = { operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } };
      expect((await fail(run(opId, REQS[opId], bare))).code).toBe('auth.unauthenticated');
    });
    it(`${opId}: authenticated ctx without store/ports -> common.internal (fail closed, never a 200)`, async () => {
      const c: any = make({ approveRows: [approveRow(id(1))] }).ctx; delete c.store;
      expect((await fail(run(opId, REQS[opId], c))).code).toBe('common.internal');
    });
  }
  it('mapped to functions distinct from the shared stub', () => {
    const stub = (handlers as any).getResultHistory;
    for (const opId of Object.keys(REQS)) expect((handlers as any)[opId], opId).not.toBe(stub);
  });
});

describe('T-17 approveResult (#30) (AC-16.1–AC-16.3)', () => {
  it('AC-16.1: 200 ResultDto status approved, allowlist keys only, approved_by = caller membership, version from If-Match goes to the store', async () => {
    const m = make({ approveRows: [approveRow(id(1))] });
    const r = await run('approveResult', one(id(1)), m.ctx);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: id(1), status: 'approved', approved_at: NOW.toISOString(), approved_by: APPROVER });
    assertDto(r.body);
    expect(m.stored('approve')[0]).toMatchObject({ resultId: id(1), expectedRowVersion: 7, membershipId: APPROVER });
  });
  it('AC-16.2: approver = verifier -> 403 lab.self_approval_forbidden', async () => {
    const m = make({ approveRows: [approveRow(id(1), { verifiedByMembershipId: APPROVER })] });
    const e = await fail(run('approveResult', one(id(1)), m.ctx));
    expect([e.code, e.statusCode]).toEqual(['lab.self_approval_forbidden', 403]);
  });
  it('AC-16.3: aal1 -> auth.mfa_required passes through; nothing approved', async () => {
    const m = make({ approveRows: [approveRow(id(1))], assertRole: mfaRequired });
    expect((await fail(run('approveResult', one(id(1)), m.ctx))).code).toBe('auth.mfa_required');
    expect(m.of('approve')).toHaveLength(0);
  });
  it('AC-13.5: unconfirmed critical -> 409 lab.critical_ack_required; wrong status -> 409 lab.result_invalid_transition; on hold -> 409 lab.result_on_hold', async () => {
    const m = make({ approveRows: [approveRow(id(1)), approveRow(id(2), { status: 'resulted' }), approveRow(id(3), { onHold: true })], unconfirmed: { [id(1)]: true } });
    const a = await fail(run('approveResult', one(id(1)), m.ctx));
    expect([a.code, a.statusCode]).toEqual(['lab.critical_ack_required', 409]);
    expect((await fail(run('approveResult', one(id(2)), m.ctx))).code).toBe('lab.result_invalid_transition');
    expect((await fail(run('approveResult', one(id(3)), m.ctx))).code).toBe('lab.result_on_hold');
  });
  it('P-01 / P-02: unknown id and a centre without approve role -> 404 common.not_found', async () => {
    expect((await fail(run('approveResult', one(id(9)), make({}).ctx))).code).toBe('common.not_found');
    expect((await fail(run('approveResult', one(id(1)), make({ approveRows: [approveRow(id(1))], assertRole: forbidden }).ctx))).code).toBe('common.not_found');
  });
  it('S-03 / REQ-SEC-024: body fields (value, approver, tenant) never reach the service', async () => {
    const m = make({ approveRows: [approveRow(id(1))] });
    await run('approveResult', one(id(1), { value_numeric: '99', approved_by_membership_id: 'EVIL', tenant_id: 'EVIL' }), m.ctx);
    expect(JSON.stringify(m.stored('approve'))).not.toMatch(/99|EVIL/);
    for (const l of m.log) expect(l.tenantId, l.fn).toBe(TENANT);
  });
  it('If-Match: missing -> 428 common.precondition_required; malformed -> common.validation_failed; nothing approved', async () => {
    const m = make({ approveRows: [approveRow(id(1))] });
    const e = await fail(run('approveResult', one(id(1), {}, {}), m.ctx));
    expect([e.code, e.statusCode]).toEqual(['common.precondition_required', 428]);
    for (const bad of ['7', 'W/"7"', '"0"', '"-1"', '""']) expect((await fail(run('approveResult', one(id(1), {}, ifm(bad)), m.ctx))).code, bad).toBe('common.validation_failed');
    expect(m.of('approve')).toHaveLength(0);
  });
  it('a non-uuid / empty result_id path value -> common.validation_failed, no store access', async () => {
    const m = make({ approveRows: [approveRow(id(1))] });
    expect((await fail(run('approveResult', one(''), m.ctx))).code).toBe('common.validation_failed');
    expect(m.log).toHaveLength(0);
  });
});

describe('T-17 bulkApproveResults (#31)', () => {
  it('200 { results: [{ id, outcome, code?, result? }] } in input order; ResultDto allowlist for ok rows; error rows carry the code only', async () => {
    const m = make({ approveRows: [approveRow(id(1)), approveRow(id(2), { verifiedByMembershipId: APPROVER })] });
    const r = await run('bulkApproveResults', bulk([{ id: id(1), version: 7 }, { id: id(2), version: 7 }, { id: id(3), version: 7 }]), m.ctx);
    expect(r.status).toBe(200);
    expect(r.body.results.map((x: any) => [x.id, x.outcome, x.code])).toEqual([[id(1), 'ok', undefined], [id(2), 'error', 'lab.self_approval_forbidden'], [id(3), 'error', 'common.not_found']]);
    assertDto(r.body.results[0].result);
    for (const x of r.body.results.slice(1)) expect(x).not.toHaveProperty('result');
    for (const k of Object.keys(r.body.results[0])) expect(Object.keys(S.ResultBulkResponse.properties.results.items.properties)).toContain(k);
  });
  it('REQ-SEC-100: 0 or 201 items -> common.validation_failed; 200 accepted; a malformed item (no id / version < 1) -> common.validation_failed; nothing stored', async () => {
    const m = make({ approveRows: [approveRow(id(1))] });
    expect((await fail(run('bulkApproveResults', bulk([]), m.ctx))).code).toBe('common.validation_failed');
    expect((await fail(run('bulkApproveResults', bulk(Array.from({ length: 201 }, (_, i) => ({ id: id(i + 1), version: 1 }))), m.ctx))).code).toBe('common.validation_failed');
    expect((await fail(run('bulkApproveResults', bulk([{ version: 7 }]), m.ctx))).code).toBe('common.validation_failed');
    expect((await fail(run('bulkApproveResults', bulk([{ id: id(1), version: 0 }]), m.ctx))).code).toBe('common.validation_failed');
    expect(m.of('approve')).toHaveLength(0);
    const ok = await run('bulkApproveResults', bulk(Array.from({ length: 200 }, (_, i) => ({ id: id(i + 1), version: 7 }))), m.ctx);
    expect(ok.body.results).toHaveLength(200);
  });
  it('body smuggling (tenant_id, approver) is ignored', async () => {
    const m = make({ approveRows: [approveRow(id(1))] });
    await run('bulkApproveResults', bulk([{ id: id(1), version: 7, approved_by_membership_id: 'EVIL' }], { tenant_id: 'EVIL' }), m.ctx);
    expect(JSON.stringify(m.stored('approve'))).not.toContain('EVIL');
    for (const l of m.log) expect(l.tenantId, l.fn).toBe(TENANT);
  });
});

describe('T-17 amendResult (#32) (AC-17.1–AC-17.3, AC-09.5)', () => {
  it('AC-17.1: 200 ResultDto with the new current_version_no; body snake_case -> service value / reason; version from If-Match', async () => {
    const m = make({ amendRows: [amendRow(id(1))] });
    const r = await run('amendResult', one(id(1), amendBody(), ifm(9)), m.ctx);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: id(1), status: 'approved', current_version_no: 2 });
    assertDto(r.body);
    expect(m.stored('amendResult')[0]).toMatchObject({ resultId: id(1), expectedRowVersion: 9, value: { numeric: '13.8' }, reasonCode: 'TRANSCRIPTION_ERROR', reasonText: 'Synthetic reason' });
  });
  it('value_text and ordinal_code map to value.text / value.ordinalCode', async () => {
    const t = make({ amendRows: [amendRow(id(1), { analyte: { id: 'a-X', code: 'X', resultType: 'text', formula: null }, currentValue: { text: 'old' } })] });
    await run('amendResult', one(id(1), { value_text: 'new text', amendment_reason_code: 'TRANSCRIPTION_ERROR' }, ifm(9)), t.ctx);
    expect(t.stored('amendResult')[0].value).toEqual({ text: 'new text' });
    const o = make({ amendRows: [amendRow(id(1), { analyte: { id: 'a-X', code: 'X', resultType: 'ordinal', formula: null, ordinalSetValues: [{ code: 'POS', display: 'Positive', sortOrder: 1 }, { code: 'NEG', display: 'Negative', sortOrder: 2 }] }, currentValue: { ordinalCode: 'NEG' } })] });
    await run('amendResult', one(id(1), { ordinal_code: 'POS', amendment_reason_code: 'TRANSCRIPTION_ERROR' }, ifm(9)), o.ctx);
    expect(o.stored('amendResult')[0].value).toEqual({ ordinalCode: 'POS' });
  });
  it('AC-17.2 / S-04: no lab.result.amend -> 403 lab.amend_requires_pathologist', async () => {
    const m = make({ amendRows: [amendRow(id(1))], assertRole: forbidden });
    const e = await fail(run('amendResult', one(id(1), amendBody(), ifm(9)), m.ctx));
    expect([e.code, e.statusCode]).toEqual(['lab.amend_requires_pathologist', 403]);
    expect(m.of('amendResult')).toHaveLength(0);
  });
  it('S-01: aal1 -> auth.mfa_required passes through (not mapped to amend_requires_pathologist)', async () => {
    const m = make({ amendRows: [amendRow(id(1))], assertRole: mfaRequired });
    expect((await fail(run('amendResult', one(id(1), amendBody(), ifm(9)), m.ctx))).code).toBe('auth.mfa_required');
  });
  it('AC-17.3: no amendment_reason_code -> 422 lab.amendment_reason_required', async () => {
    const m = make({ amendRows: [amendRow(id(1))] });
    const e = await fail(run('amendResult', one(id(1), { value_numeric: '13.8' }, ifm(9)), m.ctx));
    expect([e.code, e.statusCode]).toEqual(['lab.amendment_reason_required', 422]);
    expect(m.of('amendResult')).toHaveLength(0);
  });
  it.each(['module_phase_progression', 'module_preliminary_update', 'supplementary_report'])('08 A13 P-1 / S-21: module-only reason %s -> 400 common.validation_failed at /amendment_reason_code, no store access', async (code) => {
    const m = make({ amendRows: [amendRow(id(1))] });
    const e = await fail(run('amendResult', one(id(1), amendBody({ amendment_reason_code: code }), ifm(9)), m.ctx));
    expect([e.code, e.statusCode]).toEqual(['common.validation_failed', 400]);
    expect(JSON.stringify(e.fieldErrors ?? e.detail ?? [])).toContain('/amendment_reason_code');
    expect(m.log).toHaveLength(0);
  });
  it('If-Match: missing -> 428; wrong status -> 409 lab.result_invalid_transition; invalid value -> 422 lab.result_value_invalid', async () => {
    const m = make({ amendRows: [amendRow(id(1)), amendRow(id(2), { status: 'verified' })] });
    expect((await fail(run('amendResult', one(id(1), amendBody(), {}), m.ctx))).statusCode).toBe(428);
    expect((await fail(run('amendResult', one(id(2), amendBody(), ifm(9)), m.ctx))).code).toBe('lab.result_invalid_transition');
    expect((await fail(run('amendResult', one(id(1), amendBody({ value_numeric: 'abc' }), ifm(9)), m.ctx))).code).toBe('lab.result_value_invalid');
  });
  it('REQ-SEC-024: tenant / approver / version fields in the body never reach the service', async () => {
    const m = make({ amendRows: [amendRow(id(1))] });
    await run('amendResult', one(id(1), amendBody({ tenant_id: 'EVIL', approved_by_membership_id: 'EVIL', new_version_no: 99 }), ifm(9)), m.ctx);
    expect(JSON.stringify(m.stored('amendResult'))).not.toMatch(/EVIL|99/);
    for (const l of m.log) expect(l.tenantId, l.fn).toBe(TENANT);
  });
});

describe('T-17 listResultVersions (#33) (AC-17.4)', () => {
  const rows = [
    { tenant_id: TENANT, centre_id: CENTRE, result_id: id(1), version_no: 1, origin: 'manual', value_numeric: '13.4', flag: 'N', unit_code: 'g/dL', approved_at: '2026-06-15T04:00:00.000Z', approved_by_membership_id: APPROVER, superseded_at: '2026-06-15T05:00:00.000Z', superseded_by_version_no: 2, created_by: APPROVER, updated_by: APPROVER },
    { tenant_id: TENANT, centre_id: CENTRE, result_id: id(1), version_no: 2, origin: 'manual', value_numeric: '13.8', flag: 'N', unit_code: 'g/dL', approved_at: '2026-06-15T05:00:00.000Z', approved_by_membership_id: APPROVER, previous_version_no: 1, amendment_reason_code: 'TRANSCRIPTION_ERROR', amendment_reason_text: 'Synthetic reason', superseded_at: null, created_by: APPROVER, updated_by: APPROVER },
  ];
  it('200 { data: ResultVersionDto[] } in version order; v1 superseded, v2 current with its amendment reason; allowlist only, no internals', async () => {
    const m = make({ versions: rows });
    const r = await run('listResultVersions', { params: { result_id: id(1) }, query: {}, headers: {}, body: undefined }, m.ctx);
    expect(r.status).toBe(200);
    expect(r.body.data.map((v: any) => [v.version_no, v.superseded])).toEqual([[1, true], [2, false]]);
    expect(r.body.data[1]).toMatchObject({ result_id: id(1), value_numeric: '13.8', amendment_reason_code: 'TRANSCRIPTION_ERROR', amendment_reason_text: 'Synthetic reason' });
    for (const v of r.body.data) {
      for (const k of Object.keys(v)) expect(Object.keys(S.ResultVersionDto.properties), k).toContain(k);
      for (const k of S.ResultVersionDto.required) expect(v, k).toHaveProperty(k);
      expect(v.recorded_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    expect(JSON.stringify(r.body)).not.toMatch(/tenant_id|centre_id|created_by|updated_by|approved_by_membership_id|superseded_at/);
  });
  it('P-01: unknown result -> 404 common.not_found', async () => {
    expect((await fail(run('listResultVersions', { params: { result_id: id(9) }, query: {}, headers: {}, body: undefined }, make({}).ctx))).code).toBe('common.not_found');
  });
});
