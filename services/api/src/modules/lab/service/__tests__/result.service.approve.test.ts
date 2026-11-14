// C5 T-17 — approveResult / bulkApproveResults (R6) in result.service (02-TRD §3.3 R6, §4.7, §5.4 #30-#31, §5.5 lifecycle; 03-IC §3.10, §10.2; PRD AC-13.5, AC-16.1–AC-16.3, AC-16.5).
// ACs: AC-16.1 (verified -> approved, approval via store, lab.result.approved.v1 result_version_no 1), AC-16.2 (approver = verifier -> 403 lab.self_approval_forbidden, always),
//      AC-16.3 (aal1 -> auth.mfa_required passes through unchanged), AC-13.5 (critical_notification_blocks_approval + unconfirmed open critical -> 409 lab.critical_ack_required), AC-16.5 (readiness evaluated after approval).
// Security (07-SECURITY): S-01 (no role / aal1), S-02 (self-approval), S-03 (approve carries no value columns), P-01/P-02 (foreign / invisible ids -> per-id common.not_found), REQ-SEC-024 (tenant from ctx), S-19 (no value in errors/events), REQ-SEC-100.
// SEAM: see ./approve.fixtures.ts header. ../result.service.ts must export approveResult(ctx, { resultId, version }) -> ResultRow and
//   bulkApproveResults(ctx, { items: { resultId, version }[] }) -> { results: { resultId, outcome: 'ok'|'error', code?, result? }[] } (input order; per-row LimsError -> error row, never a value; non-LimsError propagates).
// Check order (ASSUMED, as T-16): not found / no role (404, P-02) -> version (common.version_conflict) -> transition table (lab.result_invalid_transition) -> on hold (lab.result_on_hold) -> self-approval -> critical acknowledgement.
// Events: lab.result.approved.v1 aggregate result seq = new row version, key `<result_id>:approved:1`, payload per 03-IC §3.10 (no value, no verified_by); after every approval of an order the readiness is
//   evaluated ONCE per order (evaluateOrderReadiness of order.service.ts; see order.service.readiness.test.ts) — here only that it is triggered after the approvals.
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { approveResult, bulkApproveResults } from '../result.service.js';
import { APPROVER, CENTRE, DEPT, fail, forbidden, id, ITEM, make, mfaRequired, NOW, ORDER, ORDER2, ITEM2, SPEC1, SPEC2, TENANT, approveRow } from './approve.fixtures.js';

const ALLOWED_PAYLOAD = ['result_id', 'result_version_no', 'order_id', 'order_item_id', 'test_id', 'analyte_id', 'department_id', 'approved_at', 'approved_by_membership_id'];
const a = (resultId: string, over: Record<string, unknown> = {}) => ({ resultId, version: 7, ...over });

describe('T-17 AC-16.1 approve (R6)', () => {
  it('verified -> approved: store.approve gets the row version from the lock, the caller membership and the server clock; every store call carries ctx.tx + ctx.tenantId', async () => {
    const m = make({ approveRows: [approveRow(id(1))] });
    const r = await approveResult(m.ctx, a(id(1)));
    expect(r).toMatchObject({ id: id(1), status: 'approved' });
    expect(m.stored('approve')).toEqual([{ resultId: id(1), expectedRowVersion: 7, membershipId: APPROVER, occurredAt: NOW.toISOString() }]);
    for (const l of m.log) { expect(l.tenantId, l.fn).toBe(TENANT); if (l.fn !== 'getTenantSettings') expect(l.tx, l.fn).toBe(m.tx); }
  });
  it('the role lab.result.approve is asked for the result centre, not for anything the request says', async () => {
    const m = make({ approveRows: [approveRow(id(1))] });
    await approveResult(m.ctx, a(id(1)));
    expect(m.asked).toEqual([{ permission: 'lab.result.approve', centreId: CENTRE }]);
  });
  it('lab.result.approved.v1: aggregate result seq = new row version, key <id>:approved:1, payload per 03-IC §3.10 with result_version_no 1, no value, no verifier', async () => {
    const m = make({ approveRows: [approveRow(id(1), { currentVersionNo: 0 })] });
    await approveResult(m.ctx, a(id(1)));
    const [e] = m.approvedEvents();
    expect(m.approvedEvents()).toHaveLength(1);
    expect(e!.input.aggregate).toEqual({ type: 'result', id: id(1), seq: 8 });
    expect(e!.input.idempotencyKey).toBe(`${id(1)}:approved:1`);
    expect(e!.input.payload).toEqual({
      result_id: id(1), result_version_no: 1, order_id: ORDER, order_item_id: ITEM, test_id: 't-cbc', analyte_id: 'a-HB', department_id: DEPT, approved_at: NOW.toISOString(), approved_by_membership_id: APPROVER,
    });
    for (const k of Object.keys(e!.input.payload)) expect(ALLOWED_PAYLOAD).toContain(k);
    expect(JSON.stringify(e!.input.payload)).not.toContain('13.4');
  });
  it('specimen roll-up (S9: approved) runs once for the result specimen after the approval; no roll-up for a specimen-less result', async () => {
    const m = make({ approveRows: [approveRow(id(1))] });
    await approveResult(m.ctx, a(id(1)));
    expect(m.stored('rollupSpecimen')).toEqual([SPEC1]);
    expect(m.log.findIndex((l) => l.fn === 'rollupSpecimen')).toBeGreaterThan(m.log.findIndex((l) => l.fn === 'approve'));
    const n = make({ approveRows: [approveRow(id(2), { specimenId: undefined })] });
    await approveResult(n.ctx, a(id(2)));
    expect(n.of('rollupSpecimen')).toHaveLength(0);
  });
  it('S-03: the approval call carries no value / comment / evaluation columns (approve can never change a value)', async () => {
    const m = make({ approveRows: [approveRow(id(1))] });
    await approveResult(m.ctx, { ...a(id(1)), valueNumeric: '99', value: { numeric: '99' }, flag: 'HH' } as never);
    expect(Object.keys(m.stored('approve')[0]).join(',')).not.toMatch(/value|comment|ordinal|flag|evaluation/i);
  });
  it('R6 closes the open / notified critical events of the result in the same transaction (02-TRD §5.5)', async () => {
    const m = make({ approveRows: [approveRow(id(1))] });
    await approveResult(m.ctx, a(id(1)));
    expect(m.stored('closeOpenCriticalEvents')).toEqual([{ resultId: id(1), closedAt: NOW.toISOString() }]);
  });
  it('AC-16.5: readiness is evaluated after the approval (order locked + inputs read once, after the approve write)', async () => {
    const m = make({ approveRows: [approveRow(id(1))] });
    await approveResult(m.ctx, a(id(1)));
    expect(m.stored('lockReadiness')).toEqual([ORDER]);
    expect(m.stored('listReadinessInputs')).toEqual([ORDER]);
    expect(m.log.findIndex((l) => l.fn === 'listReadinessInputs')).toBeGreaterThan(m.log.findIndex((l) => l.fn === 'approve'));
  });
  it('a stale If-Match version -> common.version_conflict; nothing stored, no event, no readiness', async () => {
    const m = make({ approveRows: [approveRow(id(1))] });
    expect((await fail(approveResult(m.ctx, a(id(1), { version: 6 })))).code).toBe('common.version_conflict');
    expect(m.of('approve')).toHaveLength(0); expect(m.emitted).toHaveLength(0); expect(m.of('lockReadiness')).toHaveLength(0);
  });
  it('a lost race inside the store (version_conflict from approve) is not swallowed and emits nothing', async () => {
    const m = make({ approveRows: [approveRow(id(1))], approveFails: { [id(1)]: new LimsError('common.version_conflict') } });
    expect((await fail(approveResult(m.ctx, a(id(1))))).code).toBe('common.version_conflict');
    expect(m.emitted).toHaveLength(0); expect(m.of('rollupSpecimen')).toHaveLength(0);
  });
});

describe('T-17 AC-16.2 self-approval, AC-16.3 mfa, guards', () => {
  it('AC-16.2 / S-02: approver membership = verifier membership -> 403 lab.self_approval_forbidden; nothing stored, no event', async () => {
    const m = make({ approveRows: [approveRow(id(1), { verifiedByMembershipId: APPROVER })] });
    const e = await fail(approveResult(m.ctx, a(id(1))));
    expect([e.code, e.statusCode]).toEqual(['lab.self_approval_forbidden', 403]);
    expect(m.of('approve')).toHaveLength(0); expect(m.emitted).toHaveLength(0);
  });
  it('the rule is not configurable and does not depend on the role: a "pathologist" who verified cannot approve either (07 abuse case 3)', async () => {
    const m = make({ approveRows: [approveRow(id(1), { verifiedByMembershipId: APPROVER })], blocks: false, assertRole: async () => undefined });
    expect((await fail(approveResult(m.ctx, a(id(1))))).code).toBe('lab.self_approval_forbidden');
  });
  it('AC-16.3 / S-01: an aal1 session -> auth.mfa_required passes through UNCHANGED (not turned into not_found / forbidden); nothing stored', async () => {
    const m = make({ approveRows: [approveRow(id(1))], assertRole: mfaRequired });
    const e = await fail(approveResult(m.ctx, a(id(1))));
    expect([e.code, e.statusCode]).toEqual(['auth.mfa_required', 403]);
    expect(m.of('approve')).toHaveLength(0); expect(m.emitted).toHaveLength(0);
  });
  it('P-01: unknown / other tenant / invisible id -> common.not_found (the role is never asked for it)', async () => {
    const m = make({ approveRows: [] });
    expect((await fail(approveResult(m.ctx, a(id(9))))).code).toBe('common.not_found');
    expect(m.asked).toHaveLength(0);
  });
  it('P-02: a caller without lab.result.approve at the result centre gets common.not_found, never auth.forbidden; nothing stored', async () => {
    const m = make({ approveRows: [approveRow(id(1))], assertRole: forbidden });
    expect((await fail(approveResult(m.ctx, a(id(1))))).code).toBe('common.not_found');
    expect(m.of('approve')).toHaveLength(0); expect(m.emitted).toHaveLength(0);
  });
  it('an infrastructure error from the role check is not turned into not_found', async () => {
    const m = make({ approveRows: [approveRow(id(1))], assertRole: async () => { throw new Error('identity down'); } });
    await expect(approveResult(m.ctx, a(id(1)))).rejects.toThrow('identity down');
  });
  it.each(['pending', 'resulted', 'approved', 'cancelled'])('status %s -> 409 lab.result_invalid_transition, nothing stored', async (status) => {
    const m = make({ approveRows: [approveRow(id(1), { status })] });
    expect((await fail(approveResult(m.ctx, a(id(1))))).code).toBe('lab.result_invalid_transition');
    expect(m.of('approve')).toHaveLength(0); expect(m.emitted).toHaveLength(0);
  });
  it('on_hold -> 409 lab.result_on_hold (before the self-approval and critical checks)', async () => {
    const m = make({ approveRows: [approveRow(id(1), { onHold: true, verifiedByMembershipId: APPROVER })], unconfirmed: { [id(1)]: true } });
    expect((await fail(approveResult(m.ctx, a(id(1))))).code).toBe('lab.result_on_hold');
    expect(m.of('approve')).toHaveLength(0);
  });
});

describe('T-17 AC-13.5 critical acknowledgement blocks approval', () => {
  it('setting true (default) + open critical event without a reached + read-back-confirmed notification -> 409 lab.critical_ack_required; nothing stored, no event, events not closed', async () => {
    const m = make({ approveRows: [approveRow(id(1))], unconfirmed: { [id(1)]: true }, blocks: true });
    const e = await fail(approveResult(m.ctx, a(id(1))));
    expect([e.code, e.statusCode]).toEqual(['lab.critical_ack_required', 409]);
    expect(m.of('approve')).toHaveLength(0); expect(m.emitted).toHaveLength(0); expect(m.of('closeOpenCriticalEvents')).toHaveLength(0);
    expect(m.stored('hasUnconfirmedCritical')).toEqual([id(1)]);
  });
  it('setting true and the critical event is confirmed (or there is none) -> approved', async () => {
    const m = make({ approveRows: [approveRow(id(1))], unconfirmed: { [id(1)]: false }, blocks: true });
    expect((await approveResult(m.ctx, a(id(1)))).status).toBe('approved');
  });
  it('setting false -> an unconfirmed critical event does not block the approval (and is closed by it)', async () => {
    const m = make({ approveRows: [approveRow(id(1))], unconfirmed: { [id(1)]: true }, blocks: false });
    expect((await approveResult(m.ctx, a(id(1)))).status).toBe('approved');
    expect(m.stored('closeOpenCriticalEvents')).toHaveLength(1);
  });
  it('the error never carries a value or a notification detail (S-19)', async () => {
    const m = make({ approveRows: [approveRow(id(1))], unconfirmed: { [id(1)]: true } });
    const e = await fail(approveResult(m.ctx, a(id(1))));
    expect(JSON.stringify({ message: e.message, detail: e.detail, fieldErrors: e.fieldErrors })).not.toContain('13.4');
  });
});

describe('T-17 bulkApproveResults (#31): per-id outcomes (REQ-SEC-100)', () => {
  it('two ok rows -> results in input order with the saved row; one roll-up per distinct specimen after every approval, ascending; one readiness evaluation per distinct order', async () => {
    const m = make({ approveRows: [approveRow(id(1), { specimenId: SPEC2 }), approveRow(id(2), { specimenId: SPEC1 }), approveRow(id(3), { specimenId: SPEC1, orderId: ORDER2, orderItemId: ITEM2 })] });
    const out = await bulkApproveResults(m.ctx, { items: [a(id(2)), a(id(1)), a(id(3))] });
    expect(out.results.map((r) => [r.resultId, r.outcome])).toEqual([[id(2), 'ok'], [id(1), 'ok'], [id(3), 'ok']]);
    expect(m.stored('lockForApprove')).toEqual([[id(1), id(2), id(3)]]);                  // ids unique + ascending, locked once
    expect(m.stored('rollupSpecimen')).toEqual([SPEC1, SPEC2]);
    expect(m.stored('lockReadiness').sort()).toEqual([ORDER, ORDER2].sort());
    const lastApprove = m.log.map((l) => l.fn).lastIndexOf('approve');
    expect(m.log.findIndex((l) => l.fn === 'rollupSpecimen')).toBeGreaterThan(lastApprove);
    expect(m.log.findIndex((l) => l.fn === 'lockReadiness')).toBeGreaterThan(lastApprove);
    expect(m.approvedEvents()).toHaveLength(3);
  });
  it('mixed batch: self-approval / invalid transition / foreign id / version conflict become error rows with the code only; the others are approved', async () => {
    const m = make({ approveRows: [approveRow(id(1)), approveRow(id(2), { verifiedByMembershipId: APPROVER }), approveRow(id(3), { status: 'resulted' }), approveRow(id(5))] });
    const out = await bulkApproveResults(m.ctx, { items: [a(id(1)), a(id(2)), a(id(3)), a(id(4)), a(id(5), { version: 1 })] });
    expect(out.results.map((r) => [r.resultId, r.outcome, r.code])).toEqual([
      [id(1), 'ok', undefined], [id(2), 'error', 'lab.self_approval_forbidden'], [id(3), 'error', 'lab.result_invalid_transition'], [id(4), 'error', 'common.not_found'], [id(5), 'error', 'common.version_conflict'],
    ]);
    expect(m.stored('approve').map((x: any) => x.resultId)).toEqual([id(1)]);
    expect(JSON.stringify(out.results.filter((r) => r.outcome === 'error'))).not.toContain('13.4');
    expect(m.approvedEvents()).toHaveLength(1);
  });
  it('aal1 -> every row reports auth.mfa_required (per id, as #30); nothing stored', async () => {
    const m = make({ approveRows: [approveRow(id(1)), approveRow(id(2))], assertRole: mfaRequired });
    const out = await bulkApproveResults(m.ctx, { items: [a(id(1)), a(id(2))] });
    expect(out.results.map((r) => [r.outcome, r.code])).toEqual([['error', 'auth.mfa_required'], ['error', 'auth.mfa_required']]);
    expect(m.of('approve')).toHaveLength(0); expect(m.emitted).toHaveLength(0);
  });
  it('P-02: a result of a centre the caller has no approve role for is common.not_found for that row only', async () => {
    const m = make({ approveRows: [approveRow(id(1)), approveRow(id(2), { centreId: '01a1a98a-ac40-7000-8000-00000000a202' })], assertRole: async (r) => { if (r.centreId.endsWith('a202')) throw new LimsError('auth.forbidden'); } });
    const out = await bulkApproveResults(m.ctx, { items: [a(id(1)), a(id(2))] });
    expect(out.results.map((r) => [r.outcome, r.code])).toEqual([['ok', undefined], ['error', 'common.not_found']]);
  });
  it('AC-13.5 per id: an unconfirmed critical row fails with lab.critical_ack_required, the rest are approved', async () => {
    const m = make({ approveRows: [approveRow(id(1)), approveRow(id(2))], unconfirmed: { [id(2)]: true } });
    const out = await bulkApproveResults(m.ctx, { items: [a(id(1)), a(id(2))] });
    expect(out.results.map((r) => [r.outcome, r.code])).toEqual([['ok', undefined], ['error', 'lab.critical_ack_required']]);
  });
  it('a second item for an id already approved in the batch is common.version_conflict (as T-14/T-16), never a second approval', async () => {
    const m = make({ approveRows: [approveRow(id(1))] });
    const out = await bulkApproveResults(m.ctx, { items: [a(id(1)), a(id(1))] });
    expect(out.results.map((r) => [r.outcome, r.code])).toEqual([['ok', undefined], ['error', 'common.version_conflict']]);
    expect(m.stored('approve')).toHaveLength(1);
  });
  it('a non-LimsError from the store after the write started is NOT turned into an error row (the caller rolls the whole batch back)', async () => {
    const m = make({ approveRows: [approveRow(id(1)), approveRow(id(2))], approveFails: { [id(2)]: new Error('connection reset') } });
    await expect(bulkApproveResults(m.ctx, { items: [a(id(1)), a(id(2))] })).rejects.toThrow('connection reset');
  });
  it('REQ-SEC-024: the tenant of every call is ctx.tenantId, whatever the items carry', async () => {
    const m = make({ approveRows: [approveRow(id(1))] });
    await bulkApproveResults(m.ctx, { items: [{ ...a(id(1)), tenantId: 'other' } as never] });
    for (const l of m.log) expect(l.tenantId, l.fn).toBe(TENANT);
  });
});
