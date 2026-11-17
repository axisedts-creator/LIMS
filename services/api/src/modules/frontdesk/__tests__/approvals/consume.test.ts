// FD-T07 consumption of an approval by F9 createRegistration (done_when: "Consumption bound to base_fingerprint/discounts/patient/centre"). ACs US-FD-07.1, 07.2 (second half),
// 07.5 ("older than 15 min or already consumed, or the server-recomputed base fingerprint or the discounts differ -> 403 frontdesk.discount_approval_required"),
// 03-APP-FLOW §1.3 (approved -> consumed: base fingerprint, same patient ref, same centre_id, same discounts JSON), 07-SECURITY A2 (reuse of an approval from another patient),
// §6.1 (other tenant's id). Same F9 harness as FD-T06 (real PG17 tx, fake Catalog/BillingCommand/Notification ports).
// Fails now: F9 refuses every approval-required registration (registration.service.ts: "consuming one is FD-T07"), and F15/F18 are stubs.
// NOT TESTED: new-patient (draft_hash) consumption (hash normalisation unspecified), F12 confirmPreRegisteredOrder consumption (FD-T09), line-scope discounts.
import { describe, expect, it } from 'vitest';
import { NOW, TENANT_A, discountRows, ordersOf, orderRow, register, registerFails, storedFor, generatedOrderId, NOTHING, knowRecipient, rworld } from '../registration/helpers.js';
import { APPROVER, APPROVER_B, CENTRE, CENTRE_A2, MIN, REQUESTER, REQUESTER_B, T, TENANT_B, approvalFor, approvalRow, approve, discounted, disc, getApproval, hex64, newApproval, request,
  requestFor, reject, superTx, withApproval, type Discounted } from './helpers.js';

const REQUIRED = 'frontdesk.discount_approval_required';
/** Register `d` carrying approval `id`; options as FD-T06's register(). */
const reg = (d: Discounted, id: string, o: Record<string, unknown> = {}) => register(withApproval(d, id), { w: d.w, ...o });
const regFails = (d: Discounted, id: unknown, o: Record<string, unknown> = {}) => registerFails({ ...d.body, discount_approval_id: id }, { w: d.w, ...o });
async function refused(d: Discounted, id: string, o: Record<string, unknown> = {}) {
  const e = await regFails(d, id, o);
  expect(e.code).toBe(REQUIRED); expect(e.statusCode).toBe(403);
  expect(await ordersOf(d.patient.id)).toHaveLength(0);
  expect(d.w.billingFake.calls('issueOrderInvoice')).toHaveLength(0);
  return e;
}
/** An approved approval whose binding differs from `d` in exactly one respect (override of the F15 body). */
async function approvedWith(d: Discounted, over: Record<string, unknown>): Promise<string> {
  const r = await request({ centre_id: d.centreId, base_fingerprint: d.base, discounts: d.body.discounts, reason_code: 'staff_family', patient_ref: { patient_id: d.patient.id }, ...over });
  await approve(r.body.id, '"1"', {}, APPROVER);
  return r.body.id;
}

describe('US-FD-07.1 / 07.2 the registration flow', () => {
  it('07.1: 30 % > 10 % limit and no approval -> 403 frontdesk.discount_approval_required, nothing stored', async () => {
    const d = await discounted();
    const e = await registerFails(d.body, { w: d.w });
    expect(e.code).toBe(REQUIRED); expect(e.statusCode).toBe(403);
    expect(await ordersOf(d.patient.id)).toHaveLength(0);
  }, T);

  it('fixture sanity: base_fingerprint from the discounted F8 quote differs from its quote_fingerprint and is 64 hex', async () => {
    const d = await discounted();
    expect(d.base).toMatch(/^[0-9a-f]{64}$/);
    expect(d.base).not.toBe(d.fp);
  }, T);

  it('07.2: finance (aal2) approves, requester registers with discount_approval_id -> 201; discount stored approval_mode approved with approval_id + approver; approval consumed by this order', async () => {
    const d = await discounted();
    const id = await approvalFor(d);
    const r = await reg(d, id);
    expect(r.status).toBe(201);
    const orderId = r.body.order.id as string;
    expect((await orderRow(orderId)).status).toBe('registered');
    const rows = await discountRows(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scope: 'bill', kind: 'percent', percent_bp: 3000, approval_mode: 'approved', approval_id: id, approved_by_membership_id: APPROVER.membershipId, status: 'applied' });
    expect(Number(rows[0].computed_paisa)).toBe(21000);                                        // 30 % of gross 70000
    expect((d.w.billingFake.calls('issueOrderInvoice')[0].input as any).discounts).toHaveLength(1);
    const a = await approvalRow(id);
    expect(a).toMatchObject({ status: 'consumed', consumed_order_id: orderId, decided_by_membership_id: APPROVER.membershipId });
    expect(new Date(a.consumed_at).getTime()).toBe(NOW.getTime());
    const seen = await getApproval(id, REQUESTER);
    expect(seen.body).toMatchObject({ status: 'consumed', consumed_order_id: orderId });
  }, T);

  it('one second before the 15 min TTL the approval is still consumable', async () => {
    const d = await discounted();
    const id = await approvalFor(d);
    expect((await reg(d, id, { now: new Date(NOW.getTime() + 15 * MIN - 1000) })).status).toBe(201);
  }, T);
});

describe('US-FD-07.5 an approval is single-use, short-lived and decided', () => {
  it('already consumed: the second registration with the same id -> 403; exactly one order; the approval still points at the first', async () => {
    const d = await discounted();
    const id = await approvalFor(d);
    const first = await reg(d, id);
    expect(first.status).toBe(201);
    const w2 = rworld(); knowRecipient(w2, TENANT_A, d.patient.id, true, d.patient.phone_e164);
    const e = await registerFails({ ...d.body, discount_approval_id: id }, { w: w2 });
    expect(e.code).toBe(REQUIRED); expect(e.statusCode).toBe(403);
    expect(await ordersOf(d.patient.id)).toHaveLength(1);
    expect((await approvalRow(id)).consumed_order_id).toBe(first.body.order.id);
  }, T);

  it('older than 15 min (now >= expires_at) -> 403, approval not consumed', async () => {
    const d = await discounted();
    const id = await approvalFor(d);
    await refused(d, id, { now: new Date(NOW.getTime() + 15 * MIN) });
    expect((await approvalRow(id)).consumed_order_id).toBeNull();
    expect((await approvalRow(id)).status).not.toBe('consumed');
  }, T);

  it('still pending (never approved) -> 403; rejected -> 403; neither is consumed', async () => {
    const dp = await discounted(), dr = await discounted();
    const pending = (await requestFor(dp)).body.id as string;
    const rejected = (await requestFor(dr)).body.id as string;
    await reject(rejected, '"1"', { note: 'Synthetic' }, APPROVER);
    await refused(dp, pending); await refused(dr, rejected);
    expect((await approvalRow(pending)).status).toBe('pending');
    expect((await approvalRow(rejected)).status).toBe('rejected');
  }, T);

  it('unknown approval id -> 403; malformed id -> 400 /discount_approval_id; both leave nothing stored', async () => {
    const d = await discounted();
    await refused(d, '01a1a98a-ac40-7000-8000-0000ffff0004');
    const e = await regFails(d, 'x');
    expect(e.code).toBe('common.validation_failed'); expect((e.errors ?? []).map((x: any) => x.path)).toContain('/discount_approval_id');
    expect(await ordersOf(d.patient.id)).toHaveLength(0);
  }, T);
});

describe('binding: the approval is for THIS patient, centre, lines and discounts only (07-SECURITY A2)', () => {
  it('another patient (same lines, same discounts, same centre) -> 403; the approval stays approved and usable by its own patient', async () => {
    const d1 = await discounted(), d2 = await discounted();
    expect(d2.base).toBe(d1.base);                                                              // only the patient differs
    const id = await approvalFor(d1);
    await refused(d2, id);
    expect(await approvalRow(id)).toMatchObject({ status: 'approved', consumed_order_id: null });
    expect((await reg(d1, id)).status).toBe(201);
  }, T);

  it('another centre (approval for A1, registration at A2) -> 403, no order, no registration_no consumed', async () => {
    const d = await discounted({ centreId: CENTRE_A2 });
    const id = await approvedWith(d, { centre_id: CENTRE.a });
    await refused(d, id, { centreId: CENTRE_A2, centreIds: [CENTRE.a, CENTRE_A2] });
    expect((await approvalRow(id)).status).toBe('approved');
  }, T);

  it('different discounts (approved 35 %, registering 30 %) -> 403; (approved amount, registering percent) -> 403', async () => {
    const d = await discounted();
    await refused(d, await approvedWith(d, { discounts: disc(3500) }));
    await refused(d, await approvedWith(d, { discounts: [{ scope: 'bill', kind: 'amount', amount_paisa: 21000, reason_code: 'staff_family' }] }));
    expect(await ordersOf(d.patient.id)).toHaveLength(0);
  }, T);

  it('different lines (approval bound to another base_fingerprint, even one hex digit off) -> 403', async () => {
    const d = await discounted();
    await refused(d, await approvedWith(d, { base_fingerprint: hex64() }));
    const flipped = (d.base[0] === '0' ? '1' : '0') + d.base.slice(1);
    await refused(d, await approvedWith(d, { base_fingerprint: flipped }));
  }, T);

  it('tenant B\'s approved approval used by tenant A -> 403 required (or 404), never consumed', async () => {
    const d = await discounted();
    const b = await newApproval({ who: REQUESTER_B });
    await approve(b.id, '"1"', {}, APPROVER_B);
    const e = await regFails(d, b.id);
    expect([REQUIRED, 'common.not_found']).toContain(e.code); expect([403, 404]).toContain(e.statusCode);
    expect(await ordersOf(d.patient.id)).toHaveLength(0);
    expect(await approvalRow(b.id)).toMatchObject({ status: 'approved', consumed_order_id: null, tenant_id: TENANT_B });
  }, T);
});

describe('consumption is atomic with the registration (one tx) and race-free', () => {
  it('registration fails after the approval was taken (event publish injected to fail): everything rolls back, the approval is approved again and a retry succeeds', async () => {
    const d = await discounted();
    const id = await approvalFor(d);
    const e = await regFails(d, id, { failEvent: 'frontdesk.order.created.v1' });
    expect(e.code).toBe('common.internal');
    expect(await storedFor(generatedOrderId(d.w)!)).toEqual(NOTHING);
    expect(await approvalRow(id)).toMatchObject({ status: 'approved', consumed_order_id: null, consumed_at: null });
    const w2 = rworld(); knowRecipient(w2, TENANT_A, d.patient.id, true, d.patient.phone_e164);
    const ok = await register({ ...d.body, discount_approval_id: id }, { w: w2 });
    expect(ok.status).toBe(201);
    expect((await approvalRow(id)).consumed_order_id).toBe(ok.body.order.id);
  }, T);

  it('two registrations race for one approval: exactly one 201, the other 403; one order; approval consumed by the winner', async () => {
    const d = await discounted();
    const id = await approvalFor(d);
    const w2 = rworld(); knowRecipient(w2, TENANT_A, d.patient.id, true, d.patient.phone_e164);
    const body ={ ...d.body, discount_approval_id: id };
    const rs = await Promise.allSettled([register(body, { w: d.w }), register(body, { w: w2 })]);
    const ok = rs.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
    const bad = rs.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(1); expect(bad).toHaveLength(1);
    expect(bad[0]!.reason.code).toBe(REQUIRED); expect(bad[0]!.reason.statusCode).toBe(403);
    expect(await ordersOf(d.patient.id)).toHaveLength(1);
    expect((await approvalRow(id)).consumed_order_id).toBe(ok[0]!.value.body.order.id);
  }, T);

  it('lifecycle backstop in the DB: a consumed approval cannot be re-opened even by the owner (immutable_row)', async () => {
    const d = await discounted();
    const id = await approvalFor(d);
    expect((await reg(d, id)).status).toBe(201);
    const err = await superTx(async (tx) => { await tx.query('UPDATE frontdesk.discount_approvals SET status = \'approved\', consumed_order_id = NULL WHERE id = $1', [id]); })
      .then(() => undefined, (e: any) => e);
    expect(err).toBeDefined();
    expect((await approvalRow(id)).status).toBe('consumed');
  }, T);
});
