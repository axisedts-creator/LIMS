// PG-T14 helper self-test: the refunds model of helpers/merchantDb.ts (05-SCHEMA §6 refunds constraints, in-flight index, mutable-columns + transition triggers) and the
// arrange helpers of helpers/refundHarness.ts behave like the schema. Passes without the writer's code (the service import is lazy).
import { describe, expect, it } from 'vitest';
import { TENANTS } from '../../../../../../../packages/fakes/src/base';
import { M, actorIdOf, makeIdentity, makeRefundHarness, uid, CENTRE_2 } from './refundHarness';

const INS = 'INSERT INTO payments.refunds (id, tenant_id, intent_id, order_id, centre_id, gateway, mode, status, amount_paisa, reason_code, idempotency_key, requested_by_membership_id, requested_at, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), $13, $14) RETURNING *';
const vals = (t: Awaited<ReturnType<typeof makeRefundHarness>>, o: { id?: string; status?: string; key?: string; amount?: number; mode?: string; gateway?: string; tenant?: string } = {}) => {
  const id = o.id ?? uid(600);
  return [id, o.tenant ?? TENANTS.A, t.intentId, t.orderId, t.seeds[0]!.centre, o.gateway ?? 'khalti', o.mode ?? 'manual', o.status ?? 'pending_approval', o.amount ?? 225000, 'test_cancelled', o.key ?? `refund:${id}`, M.A, actorIdOf('A'), actorIdOf('A')];
};
type T = Awaited<ReturnType<typeof makeRefundHarness>>;
/** one transaction for tenant A (the fake's default tenant differs from the fakes-package TENANTS.A the harness seeds) */
const q = (t: T, sql: string, v: unknown[], tenantId: string = TENANTS.A) => t.h.db.run(async (c) => c.tx.query(sql, v), { tenantId });
const sqlState = async (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: any) => `${e.code}:${e.constraint ?? e.message}`);

describe('refunds model of the DB fake', () => {
  it('stores a pending_approval refund, returns bigint as a decimal string, enforces the schema constraints by name', async () => {
    const t = await makeRefundHarness();
    const ok = await q(t, INS, vals(t));
    expect(ok.rows[0]).toMatchObject({ status: 'pending_approval', amount_paisa: '225000', unconfirmed_run_count: 0, version: 1, approved_by_membership_id: null });
    expect(await sqlState(q(t, INS, vals(t, { id: uid(601), amount: 0 })))).toBe('23514:refunds__amount__ck');
    expect(await sqlState(q(t, INS, vals(t, { id: uid(602), key: 'has space' })))).toBe('23514:refunds__idem__ck');
    expect(await sqlState(q(t, INS, vals(t, { id: uid(603), gateway: 'esewa', mode: 'api' })))).toBe('23514:refunds__mode__ck');
    expect(await sqlState(q(t, INS, vals(t, { id: uid(604), status: 'approved' })))).toBe('23514:refunds__approved__ck');
    expect(await sqlState(q(t, INS, vals(t, { id: uid(605), tenant: TENANTS.B })))).toMatch(/^42501/);
  });

  it('in-flight partial unique index (one per intent) and unique idempotency key; completed/rejected/failed do not occupy the slot', async () => {
    const t = await makeRefundHarness();
    t.addRefund({ id: uid(601), intent: t.intentId, status: 'pending_approval' });
    expect(await sqlState(q(t, INS, vals(t, { id: uid(602) })))).toBe('23505:refunds__tenant_id_intent_inflight__p_uq');
    expect(await sqlState(q(t, INS, vals(t, { id: uid(603), key: `refund:${uid(601)}` })))).toMatch(/^23505:refunds__tenant_id_(intent_inflight__p_uq|idempotency_key__uq)$/);
    for (const [i, status] of (['completed', 'rejected', 'failed'] as const).entries()) {
      const t2 = await makeRefundHarness();
      t2.addRefund({ id: uid(610 + i), intent: t2.intentId, status });
      expect(await sqlState(q(t2, INS, vals(t2, { id: uid(620 + i) })))).toBe('ok');
    }
  });

  it('mutable-columns and transition guard triggers; seeded rows get the refund:<id> key', async () => {
    const t = await makeRefundHarness();
    t.addRefund({ id: uid(601), intent: t.intentId, status: 'pending_approval' });
    expect(t.refundRow(uid(601)).idempotency_key).toBe(`refund:${uid(601)}`);
    const upd = (set: string, v: unknown[]) => q(t, `UPDATE payments.refunds SET ${set} WHERE tenant_id = $1 AND id = $2`, [TENANTS.A, uid(601), ...v]);
    expect(await sqlState(upd("status = 'completed'", []))).toBe('P0001:invalid_transition');
    expect(await sqlState(upd('amount_paisa = $3', [1]))).toBe('P0001:immutable_row');
    expect(await sqlState(upd("status = 'approved'", []))).toBe('23514:refunds__approved__ck');   // needs approved_by_membership_id
    expect(await sqlState(upd("status = 'approved', approved_by_membership_id = $3", [M.B]))).toBe('ok');
    expect(await sqlState(upd("status = 'requested'", []))).toBe('ok');
  });

  it('RLS: another tenant sees no rows; the intent FK is enforced', async () => {
    const t = await makeRefundHarness({ intents: [{}, { tenant: 'B' }] });
    t.addRefund({ id: uid(601), intent: t.seeds[0]!.id });
    expect(t.h.db.refunds(TENANTS.B)).toHaveLength(0);
    expect((await q(t, 'SELECT * FROM payments.refunds WHERE tenant_id = $1', [TENANTS.B], TENANTS.B)).rows).toHaveLength(0);
    expect((await q(t, 'SELECT * FROM payments.refunds WHERE tenant_id = $1', [TENANTS.A])).rows).toHaveLength(1);
    const bad = vals(t, { id: uid(650) }); bad[2] = uid(9999);
    expect(await sqlState(q(t, INS, bad))).toBe('23503:refunds__intent__fk');
  });
});

describe('refund harness arrange helpers', () => {
  it('seeds a settled khalti intent overpaid by its amount; setBalance re-points getOrderBalance', async () => {
    const t = await makeRefundHarness({ thresholdPaisa: 5 });
    expect(t.intent()).toMatchObject({ status: 'settled', gateway: 'khalti', amount_paisa: 225000, refunded_paisa: 0 });   // t.intent() = raw store row (numbers)
    const bal = () => t.h.ports.BillingPort.getOrderBalance({}, { orderId: t.orderId });
    expect((await bal()).balanceDue.amountPaisa).toBe(-225000);
    t.setBalance(-100);
    expect((await bal()).balanceDue.amountPaisa).toBe(-100);
    expect(t.h.db.settings(TENANTS.A)[0]!.refund_two_person_threshold_paisa).toBe(5);
    const g = q(t, "SELECT code FROM payments.g_cs_reasons WHERE set_name = $1 ORDER BY sort_order ASC", ['refund_reject_reasons']);
    expect((await g).rows.map((r: any) => r.code)).toEqual(['not_eligible', 'wrong_amount', 'duplicate_request', 'other']);
  });

  it('other-centre intents, esewa intents and apiRefunds are seeded as asked', async () => {
    const t = await makeRefundHarness({ apiRefunds: true, intents: [{ gateway: 'esewa', centre: CENTRE_2 }, { gateway: 'khalti', status: 'partially_refunded', refundedPaisa: 100000 }] });
    expect(t.intent(t.seeds[0]!.id).centre_id).toBe(CENTRE_2);
    expect(t.intent(t.seeds[1]!.id)).toMatchObject({ status: 'partially_refunded', refunded_paisa: 100000 });
    expect(t.h.db.accounts(TENANTS.A).find((a) => a.gateway === 'khalti')!.api_refunds_enabled).toBe(true);
  });

  it('identity double: privileged permissions need aal2, centre-limited persona is forbidden elsewhere, membership ids differ between A and B', async () => {
    const t = await makeRefundHarness();
    const calls: any[] = [];
    const as = (p: any) => makeIdentity(p, calls, t.h).assertRole({}, { permission: 'payments.refund.approve' });
    await expect(as('B')).resolves.toBeUndefined();
    await expect(as('B_aal1')).rejects.toMatchObject({ code: 'auth.mfa_required' });
    await expect(as('front_desk')).rejects.toMatchObject({ code: 'auth.forbidden' });
    await expect(makeIdentity('finance_centre1', calls, t.h).assertRole({}, { permission: 'payments.refund.approve', centreId: CENTRE_2 })).rejects.toMatchObject({ code: 'auth.forbidden' });
    expect(M.A).not.toBe(M.B);
  });
});
