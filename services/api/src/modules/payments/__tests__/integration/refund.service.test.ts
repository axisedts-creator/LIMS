// PG-T14 integration: refund request / approve / reject (P8-P10), reads (P6, P7) and the port refund() (TRD §5.1, §5.4, §6.6 steps 1-3, §8; 05-SCHEMA §6 refunds).
// ACs: AC-PG-09.1, 09.2, 09.3, 09.6, 09.8. Security: ST-10 (front_desk 403, aal1 auth.mfa_required, self-approval, bounds, replay), ST-18 (other-centre user -> 404),
// ST-24 (refund operations write NO access-log row; evidence is the row-audit trigger - not modelled by the DB fake, see .orchestra/notes/PG-T14-tests.md),
// REQ-SEC-055, tenant isolation, port-key grammar (08 A19 P-40), actor-type guard (08 R8). Wiring seam: helpers/refundHarness.ts header. Synthetic data only.
// Real-DB parallelism (partial unique index under true interleaving) cannot be proven until the C0 payments DDL exists: here transactions are serialised.
// Fails now: service/refund.service.ts does not exist.
import { beforeEach, describe, expect, it } from 'vitest';
import { FIXED_NOW, TENANTS } from '../../../../../../../packages/fakes/src/base';
import { UUIDV7 } from '../helpers/merchantDb';
import { CENTRE_1, CENTRE_2, M, actorIdOf, makeRefundHarness, uid, type RefundHarness } from '../helpers/refundHarness';

const A = TENANTS.A;
const CAPTURED = 225000;
const REQ = (amount = CAPTURED, o: Record<string, unknown> = {}) => ({ refund_amount_paisa: amount, reason_code: 'test_cancelled', ...o });
const WHEN = new Date(Date.parse(FIXED_NOW) + 60_000).toISOString();

let t: RefundHarness;
const request = (body: unknown = REQ(), o: Parameters<RefundHarness['call']>[2] = {}, intentId?: string) => t.call('createPaymentRefundRequest', { intentId: intentId ?? t.intentId, body }, o);
const approve = (refundId: string, body: unknown = {}, o: Parameters<RefundHarness['call']>[2] = { as: 'B' }) => t.call('approvePaymentRefund', { refundId, body }, o);
const reject = (refundId: string, body: unknown = { reason_code: 'not_eligible' }, o: Parameters<RefundHarness['call']>[2] = { as: 'B' }) => t.call('rejectPaymentRefund', { refundId, body }, o);
const RID = uid(500);
const pending = (o: Partial<Parameters<RefundHarness['addRefund']>[0]> = {}) => t.addRefund({ id: RID, intent: t.intentId, ...o });
const touched = () => t.nothingElseTouched();
beforeEach(async () => { t = await makeRefundHarness(); });

describe('AC-PG-09.1 P8 request a refund', () => {
  it('creates a pending_approval manual refund row copied from the intent, key refund:<id>, actor recorded for the row audit', async () => {
    const r = await request(REQ(CAPTURED, { reason_text: 'order cancelled by the lab' }));
    expect(r.code).toBeUndefined();
    expect(r.value).toMatchObject({ status: 'pending_approval' });
    const row = t.refundRow(r.value.id);
    expect(row.id).toMatch(UUIDV7);
    expect(row).toMatchObject({ status: 'pending_approval', mode: 'manual', gateway: 'khalti', intent_id: t.intentId, order_id: t.orderId, centre_id: CENTRE_1, reason_code: 'test_cancelled',
      reason_text: 'order cancelled by the lab', requested_by_membership_id: M.A, idempotency_key: `refund:${row.id}`, version: 1, unconfirmed_run_count: 0,
      created_by: actorIdOf('A'), updated_by: actorIdOf('A') });
    expect(Number(row.amount_paisa)).toBe(CAPTURED);
    expect(new Date(row.requested_at).toISOString()).toBe(FIXED_NOW);
    for (const c of ['approved_by_membership_id', 'rejected_by_membership_id', 'completed_at', 'ledger_entry_id', 'gateway_refund_reference']) expect(row[c]).toBeNull();
  });

  it('a partial amount is allowed; the intent and the money are untouched (no gateway call, no ledger, no job, no refunded_paisa)', async () => {
    const r = await request(REQ(100000));
    expect(Number(t.refundRow(r.value.id).amount_paisa)).toBe(100000);
    expect(touched()).toEqual({ gatewayCalls: 0, ledger: 0, jobs: 0 });
    expect(t.intent()).toMatchObject({ status: 'settled', version: 1 });
    expect(Number(t.intent().refunded_paisa)).toBe(0);
  });

  it('writes no access-log row and never calls ctx.audit (ST-24, 08 A19 D-112)', async () => {
    await request();
    expect(t.access()).toEqual([]);
    expect(t.h.db.stmts.some((s) => /audit\./i.test(s.text))).toBe(false);
  });

  it('mode = api only for a khalti intent whose merchant enabled API refunds; eSewa and default khalti are manual', async () => {
    t = await makeRefundHarness({ apiRefunds: true, intents: [{ gateway: 'khalti' }, { gateway: 'esewa' }] });
    const k = await request(REQ(), {}, t.seeds[0]!.id);
    const e = await request(REQ(), {}, t.seeds[1]!.id);
    expect(t.refundRow(k.value.id).mode).toBe('api');
    expect(t.refundRow(e.value.id).mode).toBe('manual');
    t = await makeRefundHarness();
    expect(t.refundRow((await request()).value.id).mode).toBe('manual');
  });

  it('a partially_refunded intent can be refunded again up to what is left', async () => {
    t = await makeRefundHarness({ intents: [{ status: 'partially_refunded', refundedPaisa: 100000, balanceDue: -125000 }] });
    expect((await request(REQ(125000))).code).toBeUndefined();
  });

  it('the reason code `other` needs reason_text; any other code does not', async () => {
    expect((await request(REQ(CAPTURED, { reason_code: 'other' }))).code).toBe('common.validation_failed');
    expect((await request(REQ(CAPTURED, { reason_code: 'other', reason_text: 'see ticket' }))).code).toBeUndefined();
  });

  it.each([
    ['intent not settled', 'initiated'], ['intent held_for_review', 'held_for_review'], ['intent failed', 'failed'], ['intent expired', 'expired'], ['intent already fully refunded', 'refunded'],
  ])('%s -> 409 payments.refund_not_allowed, no row', async (_n, status) => {
    t = await makeRefundHarness({ intents: [{ status, ...(status === 'refunded' ? { refundedPaisa: CAPTURED } : {}) }] });
    const r = await request();
    expect(r).toMatchObject({ code: 'payments.refund_not_allowed', status: 409 });
    expect(t.refunds()).toHaveLength(0);
  });

  it('unknown intent and an intent of another tenant are 404 common.not_found (RLS), no row', async () => {
    expect((await request(REQ(), {}, uid(7777))).code).toBe('common.not_found');
    t = await makeRefundHarness({ intents: [{ tenant: 'B' }] });
    expect((await request(REQ(), { tenant: 'A' }, t.seeds[0]!.id)).code).toBe('common.not_found');
    expect(t.refunds('A')).toHaveLength(0);
    expect(t.refunds('B')).toHaveLength(0);
  });
});

describe('AC-PG-09.2 bounds (TRD §6.6 step 1)', () => {
  it('amount greater than captured minus already refunded -> 422 payments.refund_exceeds_captured, no row', async () => {
    t = await makeRefundHarness({ intents: [{ status: 'partially_refunded', refundedPaisa: 100000, balanceDue: -999999 }] });
    expect(await request(REQ(125001))).toMatchObject({ code: 'payments.refund_exceeds_captured', status: 422 });
    expect(t.refunds()).toHaveLength(0);
    expect((await request(REQ(125000))).code).toBeUndefined();                          // the boundary itself is allowed
  });

  it('amount greater than max(0, -balanceDue) -> 422 payments.refund_exceeds_captured with detail "exceeds refundable balance"', async () => {
    t.setBalance(-100000);
    const r = await request(REQ(100001));
    expect(r).toMatchObject({ code: 'payments.refund_exceeds_captured', status: 422 });
    expect(r.err.detail).toBe('exceeds refundable balance');
    expect(t.refunds()).toHaveLength(0);
    expect((await request(REQ(100000))).code).toBeUndefined();
  });

  it.each([['zero balance', 0], ['a positive balance (the order is still owed money)', 50000]])('%s: nothing is refundable', async (_n, due) => {
    t.setBalance(due);
    const r = await request(REQ(1));
    expect(r).toMatchObject({ code: 'payments.refund_exceeds_captured', status: 422 });
    expect(r.err.detail).toBe('exceeds refundable balance');
  });

  it('bounds are re-checked at approve (TRD §6.6 step 2): balance shrank -> 422, the refund stays pending_approval', async () => {
    const id = (await request(REQ(CAPTURED))).value.id;
    t.setBalance(-100000);
    expect(await approve(id)).toMatchObject({ code: 'payments.refund_exceeds_captured', status: 422 });
    expect(t.refundRow(id)).toMatchObject({ status: 'pending_approval', approved_by_membership_id: null, version: 1 });
    expect(touched()).toEqual({ gatewayCalls: 0, ledger: 0, jobs: 0 });
  });

  it('bounds are re-checked at approve: the intent was refunded elsewhere meanwhile -> 422, still pending_approval', async () => {
    const id = (await request(REQ(CAPTURED))).value.id;
    const intentRow = t.intent();
    intentRow.status = 'partially_refunded'; intentRow.refunded_paisa = 100000;        // a refund completed after the request (arrange step)
    expect(await approve(id)).toMatchObject({ code: 'payments.refund_exceeds_captured' });
    expect(t.refundRow(id).status).toBe('pending_approval');
  });
});

describe('in-flight uniqueness (one open refund per intent)', () => {
  it.each(['pending_approval', 'approved', 'requested', 'held_for_review'])('an existing %s refund blocks a new request -> 409 payments.refund_not_allowed', async (status) => {
    pending({ status });
    const r = await request();
    expect(r).toMatchObject({ code: 'payments.refund_not_allowed', status: 409 });
    expect(t.refunds()).toHaveLength(1);
  });

  it.each(['completed', 'rejected', 'failed'])('a %s refund frees the slot', async (status) => {
    pending({ status });
    expect((await request(REQ(100000))).code).toBeUndefined();
    expect(t.refunds()).toHaveLength(2);
  });

  it('rejecting the pending refund frees the slot for a new request', async () => {
    const id = (await request()).value.id;
    expect((await request()).code).toBe('payments.refund_not_allowed');
    expect((await reject(id)).code).toBeUndefined();
    expect((await request()).code).toBeUndefined();
  });

  it('another intent of the same tenant is not blocked', async () => {
    t = await makeRefundHarness({ intents: [{}, {}] });
    expect((await request(REQ(), {}, t.seeds[0]!.id)).code).toBeUndefined();
    expect((await request(REQ(), {}, t.seeds[1]!.id)).code).toBeUndefined();
  });
});

describe('P8 input validation and permissions (ST-10)', () => {
  it.each([
    ['zero', 0], ['negative', -5], ['fraction', 1.5], ['numeric string', '225000'], ['null', null], ['above 2^53-1', 9007199254740992], ['NaN', Number.NaN],
  ])('refund_amount_paisa %s -> 400 common.validation_failed, no row', async (_n, v) => {
    expect((await request({ ...REQ(), refund_amount_paisa: v })).code).toBe('common.validation_failed');
    expect(t.refunds()).toHaveLength(0);
  });

  it.each([
    ['missing reason_code', { refund_amount_paisa: 1000 }], ['code outside the refund_reasons set', REQ(1000, { reason_code: 'gateway_confirmed_not_refunded' })],
    ['a code from the reject set', REQ(1000, { reason_code: 'not_eligible' })], ['reason_text over 500', REQ(1000, { reason_text: 'x'.repeat(501) })],
    ['unknown field status', REQ(1000, { status: 'approved' })], ['unknown field mode', REQ(1000, { mode: 'api' })], ['unknown field tenant_id', REQ(1000, { tenant_id: uid(1) })],
    ['unknown field requested_by_membership_id', REQ(1000, { requested_by_membership_id: M.B })], ['body not an object', 'refund'], ['body is an array', [REQ()]],
  ])('%s -> 400 common.validation_failed, no row', async (_n, body) => {
    expect((await request(body)).code).toBe('common.validation_failed');
    expect(t.refunds()).toHaveLength(0);
  });

  it('reason_text of exactly 500 characters is accepted', async () => {
    expect((await request(REQ(1000, { reason_text: 'x'.repeat(500) }))).code).toBeUndefined();
  });

  it('intentId that is not a UUIDv7 -> 400 common.validation_failed', async () => {
    expect((await request(REQ(), {}, 'not-a-uuid')).code).toBe('common.validation_failed');
  });

  it('a tenant-level reason override that deactivated a code refuses it', async () => {
    t.h.db.put('payments.cs_reasons', { id: uid(8900), tenant_id: A, set_name: 'refund_reasons', code: 'overpayment', display: 'Overpayment', is_active: false, created_by: A, updated_by: A });
    expect((await request(REQ(1000, { reason_code: 'overpayment' }))).code).toBe('common.validation_failed');
    expect((await request(REQ(1000, { reason_code: 'test_cancelled' }))).code).toBeUndefined();
  });

  it('front_desk (no payments.refund.request) -> 403 auth.forbidden before any payments row is read; no row', async () => {
    const mark = t.h.db.stmts.length;
    expect(await request(REQ(), { as: 'front_desk' })).toMatchObject({ code: 'auth.forbidden', status: 403 });
    expect(t.idCalls[0]).toMatchObject({ permission: 'payments.refund.request' });
    expect(t.idCalls[0]!.centreId).toBeUndefined();
    expect(t.h.db.stmts.slice(mark).filter((s) => /payments\.(intents|refunds)/i.test(s.text))).toHaveLength(0);
    expect(t.refunds()).toHaveLength(0);
  });

  it('a user without refund.request but with refund.approve or read-only cannot request', async () => {
    expect((await request(REQ(), { as: 'approver_only' })).code).toBe('auth.forbidden');
    expect((await request(REQ(), { as: 'reader' })).code).toBe('auth.forbidden');
  });

  it('aal1 (privileged permission without MFA) -> 403 auth.mfa_required, no row', async () => {
    expect(await request(REQ(), { as: 'A_aal1' })).toMatchObject({ code: 'auth.mfa_required', status: 403 });
    expect(t.refunds()).toHaveLength(0);
  });

  it('assertRole is called again with the intent centre after the load; an other-centre user gets 404 common.not_found (ST-18)', async () => {
    t = await makeRefundHarness({ intents: [{ centre: CENTRE_2 }] });
    expect(await request(REQ(), { as: 'finance_centre1' })).toMatchObject({ code: 'common.not_found', status: 404 });
    expect(t.idCalls.map((c) => c.centreId)).toContain(CENTRE_2);
    expect(t.refunds()).toHaveLength(0);
    expect((await request(REQ(), { as: 'A' })).code).toBeUndefined();                     // a user with all centres is fine
  });

  it.each(['patient', 'portal', 'device'])('actor type %s -> 403 auth.forbidden (08 R8), no row', async (actorType) => {
    expect((await request(REQ(), { actorType })).code).toBe('auth.forbidden');
    expect(t.refunds()).toHaveLength(0);
  });
});

describe('AC-PG-09.3 P9 approve - two-person rule', () => {
  it('threshold 0 (default, no settings row): the requester approving their own request -> 403 payments.refund_self_approval_forbidden, nothing changes', async () => {
    const id = (await request()).value.id;
    const r = await approve(id, {}, { as: 'A' });
    expect(r).toMatchObject({ code: 'payments.refund_self_approval_forbidden', status: 403 });
    expect(t.refundRow(id)).toMatchObject({ status: 'pending_approval', approved_by_membership_id: null, version: 1 });
    expect(touched()).toEqual({ gatewayCalls: 0, ledger: 0, jobs: 0 });
  });

  it('finance B at aal2 approves: refund -> requested (manual mode), approver + time recorded, port refund() returned requested', async () => {
    const id = (await request()).value.id;
    const r = await approve(id, { note: 'checked with the patient' }, { as: 'B', now: WHEN });
    expect(r.code).toBeUndefined();
    expect(r.value).toMatchObject({ id, status: 'requested' });
    const row = t.refundRow(id);
    expect(row).toMatchObject({ status: 'requested', mode: 'manual', approved_by_membership_id: M.B, requested_by_membership_id: M.A, decision_note: 'checked with the patient',
      idempotency_key: `refund:${id}`, updated_by: actorIdOf('B') });
    expect(new Date(row.approved_at).toISOString()).toBe(WHEN);
    expect(row.version).toBeGreaterThan(1);
    expect(Number(t.intent().refunded_paisa)).toBe(0);                                         // completion (ledger, refunded_paisa) is PG-T15
    expect(touched()).toEqual({ gatewayCalls: 0, ledger: 0, jobs: 0 });                     // manual mode: no gateway call, no job, no ledger row
    expect(t.access()).toEqual([]);
  });

  it('api mode approve enqueues payments.execute_refund {tenant_id, refund_id} and makes no gateway call itself', async () => {
    t = await makeRefundHarness({ apiRefunds: true });
    const id = (await request()).value.id;
    expect(t.refundRow(id).mode).toBe('api');
    expect((await approve(id)).value).toMatchObject({ status: 'requested' });
    expect(t.h.jobs.filter((j) => j.task === 'payments.execute_refund').map((j) => j.payload)).toEqual([{ tenant_id: A, refund_id: id }]);
    expect(t.h.gateway.calls).toHaveLength(0);
    expect(t.h.ledger.refunds).toHaveLength(0);
  });

  it('threshold > 0: a self-approval of an amount at or below the threshold is allowed, above it is not', async () => {
    t = await makeRefundHarness({ thresholdPaisa: 100000 });
    const low = (await request(REQ(100000))).value.id;
    expect((await approve(low, {}, { as: 'A' })).value).toMatchObject({ status: 'requested' });
    expect(t.refundRow(low).approved_by_membership_id).toBe(M.A);
  });

  it('threshold > 0: above the threshold the second person is still required', async () => {
    t = await makeRefundHarness({ thresholdPaisa: 100000 });
    const id = (await request(REQ(100001))).value.id;
    expect((await approve(id, {}, { as: 'A' })).code).toBe('payments.refund_self_approval_forbidden');
    expect((await approve(id, {}, { as: 'B' })).value).toMatchObject({ status: 'requested' });
  });

  it('the threshold of tenant A does not apply to tenant B (tenant isolation of settings)', async () => {
    t = await makeRefundHarness({ intents: [{ tenant: 'B' }] });
    t.h.db.put('payments.settings', { tenant_id: A, refund_two_person_threshold_paisa: 999999999, created_by: A, updated_by: A });
    const id = (await request(REQ(), { tenant: 'B', as: 'A' }, t.seeds[0]!.id)).value.id;
    expect((await approve(id, {}, { tenant: 'B', as: 'A' })).code).toBe('payments.refund_self_approval_forbidden');
  });

  it.each(['approved', 'requested', 'held_for_review', 'completed', 'rejected', 'failed'])('approving a %s refund -> 409 payments.refund_not_allowed, row unchanged', async (status) => {
    pending({ status });
    const before = { ...t.refundRow(RID) };
    expect(await approve(RID)).toMatchObject({ code: 'payments.refund_not_allowed', status: 409 });
    expect(t.refundRow(RID)).toEqual(before);
  });

  it('a second approve of the same refund is refused (no double refund() call)', async () => {
    const id = (await request()).value.id;
    expect((await approve(id)).value).toMatchObject({ status: 'requested' });
    expect((await approve(id)).code).toBe('payments.refund_not_allowed');
    expect(t.refundRow(id).status).toBe('requested');
  });

  it('unknown refund and a refund of another tenant are 404 common.not_found', async () => {
    expect((await approve(uid(7777))).code).toBe('common.not_found');
    const id = (await request()).value.id;
    expect((await approve(id, {}, { tenant: 'B', as: 'B' })).code).toBe('common.not_found');
    expect(t.refundRow(id).status).toBe('pending_approval');
  });

  it.each([
    ['note over 500', { note: 'x'.repeat(501) }], ['unknown field', { status: 'requested' }], ['unknown field amount', { refund_amount_paisa: 1 }], ['note not a string', { note: 5 }],
  ])('approve body %s -> 400 common.validation_failed', async (_n, body) => {
    const id = (await request()).value.id;
    expect((await approve(id, body)).code).toBe('common.validation_failed');
    expect(t.refundRow(id).status).toBe('pending_approval');
  });

  it('a body-less approve (empty object) is accepted', async () => {
    const id = (await request()).value.id;
    expect((await approve(id, {})).code).toBeUndefined();
  });

  it('refundId that is not a UUIDv7 -> 400 common.validation_failed', async () => {
    expect((await approve('nope')).code).toBe('common.validation_failed');
  });
});

describe('P9 / P10 permissions (ST-10)', () => {
  beforeEach(() => { pending(); });

  it.each([['approve', approve], ['reject', reject]] as const)('front_desk %s -> 403 auth.forbidden, row unchanged', async (_n, op) => {
    const before = { ...t.refundRow(RID) };
    expect(await op(RID, undefined, { as: 'front_desk' })).toMatchObject({ code: 'auth.forbidden', status: 403 });
    expect(t.refundRow(RID)).toEqual(before);
  });

  it.each([['approve', approve], ['reject', reject]] as const)('a requester without payments.refund.approve cannot %s', async (_n, op) => {
    expect((await op(RID, undefined, { as: 'requester_only' })).code).toBe('auth.forbidden');
    expect(t.refundRow(RID).status).toBe('pending_approval');
  });

  it.each([['approve', approve], ['reject', reject]] as const)('aal1 %s -> 403 auth.mfa_required, row unchanged', async (_n, op) => {
    const before = { ...t.refundRow(RID) };
    expect(await op(RID, undefined, { as: 'B_aal1' })).toMatchObject({ code: 'auth.mfa_required', status: 403 });
    expect(t.refundRow(RID)).toEqual(before);
    expect(touched()).toEqual({ gatewayCalls: 0, ledger: 0, jobs: 0 });
  });

  it.each([['approve', approve], ['reject', reject]] as const)('an other-centre user gets 404 on %s (assertRole with the refund centre, ST-18)', async (_n, op) => {
    t.refundRow(RID).centre_id = CENTRE_2;
    expect(await op(RID, undefined, { as: 'finance_centre1' })).toMatchObject({ code: 'common.not_found', status: 404 });
    expect(t.idCalls.at(-1)).toMatchObject({ centreId: CENTRE_2 });
    expect(t.refundRow(RID).status).toBe('pending_approval');
  });

  it.each([['approve', approve], ['reject', reject]] as const)('patient actor %s -> 403 auth.forbidden', async (_n, op) => {
    expect((await op(RID, undefined, { as: 'B', actorType: 'patient' })).code).toBe('auth.forbidden');
  });
});

describe('P10 reject', () => {
  it('pending_approval -> rejected with code, note, rejecting membership and time; no port call, no gateway, no ledger', async () => {
    const id = (await request()).value.id;
    const r = await reject(id, { reason_code: 'wrong_amount', note: 'amount does not match the receipt' }, { as: 'B', now: WHEN });
    expect(r.code).toBeUndefined();
    expect(r.value).toMatchObject({ id, status: 'rejected' });
    const row = t.refundRow(id);
    expect(row).toMatchObject({ status: 'rejected', reject_reason_code: 'wrong_amount', decision_note: 'amount does not match the receipt', rejected_by_membership_id: M.B,
      approved_by_membership_id: null, updated_by: actorIdOf('B') });
    expect(new Date(row.rejected_at).toISOString()).toBe(WHEN);
    expect(touched()).toEqual({ gatewayCalls: 0, ledger: 0, jobs: 0 });
    expect(t.intent()).toMatchObject({ status: 'settled' });
    expect(t.access()).toEqual([]);
  });

  it.each(['approved', 'requested', 'held_for_review', 'completed', 'rejected', 'failed'])('rejecting a %s refund -> 409 payments.refund_not_allowed, row unchanged', async (status) => {
    pending({ status });
    const before = { ...t.refundRow(RID) };
    expect(await reject(RID)).toMatchObject({ code: 'payments.refund_not_allowed', status: 409 });
    expect(t.refundRow(RID)).toEqual(before);
  });

  it.each([
    ['missing reason_code', {}], ['code outside refund_reject_reasons', { reason_code: 'test_cancelled' }], ['unknown code', { reason_code: 'because' }],
    ['`other` without a note', { reason_code: 'other' }], ['note over 500', { reason_code: 'not_eligible', note: 'x'.repeat(501) }], ['unknown field', { reason_code: 'not_eligible', status: 'approved' }],
  ])('reject body %s -> 400 common.validation_failed, still pending_approval', async (_n, body) => {
    pending();
    expect((await reject(RID, body)).code).toBe('common.validation_failed');
    expect(t.refundRow(RID).status).toBe('pending_approval');
  });

  it('`other` with a note is accepted', async () => {
    pending();
    expect((await reject(RID, { reason_code: 'other', note: 'see ticket 4411' })).value).toMatchObject({ status: 'rejected' });
  });

  it('unknown refund and a refund of another tenant are 404', async () => {
    expect((await reject(uid(7777))).code).toBe('common.not_found');
    pending();
    expect((await reject(RID, undefined, { tenant: 'B' })).code).toBe('common.not_found');
    expect(t.refundRow(RID).status).toBe('pending_approval');
  });
});

describe('P6 / P7 reads (payments.reconciliation.read floor)', () => {
  it('getPaymentRefund returns the refund; unknown, other-tenant and other-centre refunds are 404; no read permission -> 403; reads need no aal2', async () => {
    pending();
    expect((await t.call('getPaymentRefund', { refundId: RID }, { as: 'reader' })).value).toMatchObject({ id: RID, status: 'pending_approval' });
    expect((await t.call('getPaymentRefund', { refundId: uid(7777) })).code).toBe('common.not_found');
    expect((await t.call('getPaymentRefund', { refundId: RID }, { tenant: 'B' })).code).toBe('common.not_found');
    expect((await t.call('getPaymentRefund', { refundId: RID }, { as: 'front_desk' })).code).toBe('auth.forbidden');
    t.refundRow(RID).centre_id = CENTRE_2;
    expect((await t.call('getPaymentRefund', { refundId: RID }, { as: 'finance_centre1' })).code).toBe('common.not_found');
    expect(t.access()).toEqual([]);
  });

  it('listPaymentRefunds filters by status and intent_id, shows only the caller tenant, bounds the page', async () => {
    t = await makeRefundHarness({ intents: [{}, {}, { tenant: 'B' }] });
    t.addRefund({ id: uid(501), intent: t.seeds[0]!.id, status: 'rejected' });
    t.addRefund({ id: uid(502), intent: t.seeds[0]!.id, status: 'requested' });
    t.addRefund({ id: uid(503), intent: t.seeds[1]!.id, status: 'requested' });
    t.addRefund({ id: uid(504), intent: t.seeds[2]!.id, status: 'requested', tenant: 'B' });
    const ids = async (q: Record<string, unknown>) => ((await t.call('listPaymentRefunds', q, { as: 'reader' })).value?.data ?? []).map((r: any) => r.id).sort();
    expect(await ids({})).toEqual([uid(501), uid(502), uid(503)]);
    expect(await ids({ status: ['requested'] })).toEqual([uid(502), uid(503)]);
    expect(await ids({ intent_id: t.seeds[0]!.id })).toEqual([uid(501), uid(502)]);
    expect(await ids({ status: ['requested'], intent_id: t.seeds[1]!.id })).toEqual([uid(503)]);
    expect((await t.call('listPaymentRefunds', { status: ['nonsense'] }, { as: 'reader' })).code).toBe('common.validation_failed');
    expect((await t.call('listPaymentRefunds', {}, { as: 'front_desk' })).code).toBe('auth.forbidden');
  });
});

describe('AC-PG-09.6 port refund() - needs an approved approval id', () => {
  const input = (id: string, o: Record<string, unknown> = {}) => ({ intentId: t.intentId, amount: { amountPaisa: CAPTURED, currency: 'NPR' }, reasonCode: 'test_cancelled',
    idempotencyKey: `refund:${id}`, approvalId: id, ...o });

  it('an approval id that is a pending_approval refund -> 403 payments.refund_requires_approval, nothing changes', async () => {
    pending();
    const before = { ...t.refundRow(RID) };
    expect(await t.port(input(RID))).toMatchObject({ code: 'payments.refund_requires_approval', status: 403 });
    expect(t.refundRow(RID)).toEqual(before);
    expect(touched()).toEqual({ gatewayCalls: 0, ledger: 0, jobs: 0 });
  });

  it.each(['rejected', 'failed', 'completed'])('an approval id that is a %s refund -> 403 payments.refund_requires_approval', async (status) => {
    pending({ status });
    expect((await t.port(input(RID, { idempotencyKey: `refund:${RID}x` }))).code).toBe('payments.refund_requires_approval');
  });

  it('an unknown approval id, an approval of another tenant, and a malformed approval id are refused (no existence oracle)', async () => {
    expect((await t.port(input(uid(7777)))).code).toBe('payments.refund_requires_approval');
    pending({ status: 'approved' });
    expect((await t.port(input(RID), { tenant: 'B' })).code).toBe('payments.refund_requires_approval');
    expect((await t.port({ ...input(RID), approvalId: undefined })).code).toMatch(/^(payments\.refund_requires_approval|common\.validation_failed)$/);
    expect((await t.port({ ...input(RID), approvalId: '' })).code).toMatch(/^(payments\.refund_requires_approval|common\.validation_failed)$/);
    expect(t.refundRow(RID).status).toBe('approved');
  });

  it('an approved refund presented with a different intent, amount, reason or key is refused and stays approved', async () => {
    t = await makeRefundHarness({ intents: [{}, {}] });
    t.addRefund({ id: RID, intent: t.seeds[0]!.id, status: 'approved' });
    const base = { ...input(RID), intentId: t.seeds[0]!.id };
    for (const bad of [{ intentId: t.seeds[1]!.id }, { amount: { amountPaisa: 1000, currency: 'NPR' } }, { reasonCode: 'overpayment' }, { idempotencyKey: 'refund:some-other-key' }]) {
      expect((await t.port({ ...base, ...bad })).code).toBe('payments.refund_requires_approval');
      expect(t.refundRow(RID).status).toBe('approved');
    }
  });

  it('an approved refund with the matching body -> { status: requested, replayed: false }, row requested, no gateway call / ledger row', async () => {
    pending({ status: 'approved' });
    const r = await t.port(input(RID));
    expect(r.code).toBeUndefined();
    expect(r.value).toEqual({ refundId: RID, status: 'requested', replayed: false });
    expect(t.refundRow(RID).status).toBe('requested');
    expect(touched()).toEqual({ gatewayCalls: 0, ledger: 0, jobs: 0 });
  });

  it('the port refund() is not callable by a patient / portal actor (08 R8)', async () => {
    pending({ status: 'approved' });
    expect((await t.port(input(RID), { actorType: 'patient' })).code).toBe('auth.forbidden');
    expect((await t.port(input(RID), { actorType: 'portal' })).code).toBe('auth.forbidden');
    expect(t.refundRow(RID).status).toBe('approved');
  });
});

describe('AC-PG-09.8 port refund() idempotency and key grammar (08 A19 P-40)', () => {
  const input = (id: string, o: Record<string, unknown> = {}) => ({ intentId: t.intentId, amount: { amountPaisa: CAPTURED, currency: 'NPR' }, reasonCode: 'test_cancelled',
    idempotencyKey: `refund:${id}`, approvalId: id, ...o });

  it('the same key and body again -> the same refund, replayed: true, no second state change or job', async () => {
    pending({ status: 'approved' });
    const first = await t.port(input(RID));
    const again = await t.port(input(RID));
    expect(again.value).toEqual({ refundId: first.value.refundId, status: 'requested', replayed: true });
    expect(t.refunds()).toHaveLength(1);
    expect(t.refundRow(RID)).toMatchObject({ status: 'requested' });
    expect(touched()).toEqual({ gatewayCalls: 0, ledger: 0, jobs: 0 });
  });

  it.each([
    ['another amount', { amount: { amountPaisa: 100000, currency: 'NPR' } }], ['another reason', { reasonCode: 'overpayment' }],
  ])('the same key with %s -> 422 common.idempotency_key_reused, the refund is unchanged', async (_n, other) => {
    pending({ status: 'approved' });
    await t.port(input(RID));
    const before = { ...t.refundRow(RID) };
    expect(await t.port(input(RID, other))).toMatchObject({ code: 'common.idempotency_key_reused', status: 422 });
    expect(t.refundRow(RID)).toEqual(before);
  });

  it('the same key for another intent -> 422 common.idempotency_key_reused', async () => {
    t = await makeRefundHarness({ intents: [{}, {}] });
    t.addRefund({ id: RID, intent: t.seeds[0]!.id, status: 'requested' });
    expect((await t.port({ ...input(RID), intentId: t.seeds[1]!.id })).code).toBe('common.idempotency_key_reused');
  });

  it('a key stored by tenant A is not a replay for tenant B', async () => {
    pending({ status: 'requested' });
    const r = await t.port(input(RID), { tenant: 'B' });
    expect(r.code).toBe('payments.refund_requires_approval');
    expect(r.value).toBeUndefined();
    expect(t.refunds('B')).toHaveLength(0);
  });

  it.each([
    ['a space', 'refund 1'], ['a slash', 'refund/1'], ['201 characters', 'k'.repeat(201)], ['empty', ''], ['non-ascii', 'refünd:1'], ['a newline', 'refund:1\n'], ['a percent escape', 'refund:%41'],
  ])('idempotencyKey with %s -> 400 common.validation_failed before any lookup', async (_n, key) => {
    pending({ status: 'approved' });
    const mark = t.h.db.stmts.length;
    expect(await t.port(input(RID, { idempotencyKey: key }))).toMatchObject({ code: 'common.validation_failed', status: 400 });
    expect(t.h.db.stmts.slice(mark).filter((s) => /payments\.refunds/i.test(s.text))).toHaveLength(0);
    expect(t.refundRow(RID).status).toBe('approved');
  });

  it('idempotencyKey refund:<uuid> passes the grammar and the approved refund goes to requested', async () => {
    pending({ status: 'approved' });
    expect((await t.port(input(RID))).value).toMatchObject({ refundId: RID, status: 'requested' });
  });

  it.each([['a key with a dot', `refund:${RID}.1`], ['a 200 character key', 'k'.repeat(200)]])('idempotencyKey %s passes the grammar (then fails the key match, not validation)', async (_n, key) => {
    pending({ status: 'approved' });
    expect((await t.port(input(RID, { idempotencyKey: key }))).code).toBe('payments.refund_requires_approval');
    expect(t.refundRow(RID).status).toBe('approved');
  });

  it.each([
    ['amount 0', { amount: { amountPaisa: 0, currency: 'NPR' } }], ['negative amount', { amount: { amountPaisa: -1, currency: 'NPR' } }], ['fractional amount', { amount: { amountPaisa: 10.5, currency: 'NPR' } }],
    ['currency USD', { amount: { amountPaisa: CAPTURED, currency: 'USD' } }], ['missing reasonCode', { reasonCode: undefined }], ['intentId not a uuid', { intentId: 'x' }],
    ['unknown field', { mode: 'api' }], ['missing idempotencyKey', { idempotencyKey: undefined }],
  ])('malformed input (%s) -> 400 common.validation_failed, refund unchanged', async (_n, bad) => {
    pending({ status: 'approved' });
    expect((await t.port(input(RID, bad))).code).toBe('common.validation_failed');
    expect(t.refundRow(RID).status).toBe('approved');
  });
});

describe('end to end: request -> approve through the port, then nothing else can start', () => {
  it('the approved refund holds the in-flight slot (requested), so a second request is refused until it ends', async () => {
    const id = (await request()).value.id;
    expect((await approve(id)).value).toMatchObject({ status: 'requested' });
    expect(await request()).toMatchObject({ code: 'payments.refund_not_allowed' });
    expect(t.refunds()).toHaveLength(1);
  });

  it('a failure while approving rolls the whole unit back (the refund is not left `approved` without the port call)', async () => {
    const id = (await request()).value.id;
    t.refundRow(id).idempotency_key = 'refund:tampered';                                  // the port call then cannot match the stored key (arrange step)
    const r = await approve(id);
    expect(r.code).toBeDefined();
    expect(t.refundRow(id).status).toBe('pending_approval');
    expect(touched()).toEqual({ gatewayCalls: 0, ledger: 0, jobs: 0 });
  });
});
