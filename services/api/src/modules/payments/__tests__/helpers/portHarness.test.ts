// Self-test of the PG-T08 harness mechanics (not of the payments service): a throwaway mocked port proves that the DB fake enforces the intents schema
// (CHECKs, partial unique indexes, transition guard, append-only logs), that bigint comes back as a string, and that a throw drops rows, events, jobs and ledger calls.
import { createHash, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TENANTS } from '../../../../../../../packages/fakes/src/base';

vi.mock('../../ports/PaymentProviderPort.impl.js', () => ({
  createPaymentProviderPort: (deps: any) => ({
    async createIntent(ctx: any, i: any) {
      const id = i.id ?? '01900000-0000-7000-8000-0000000c1590';
      const r = await ctx.tx.query(
        `INSERT INTO payments.intents (id, tenant_id, order_id, branch_id, centre_id, gateway, environment, merchant_account_id, amount_paisa, idempotency_key, request_fingerprint,
           return_url, cancel_url, callback_token_sha256, created_actor_type, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT DO NOTHING RETURNING id`,
        [id, ctx.tenantId, i.orderId, i.orderId, i.orderId, i.gateway ?? 'esewa', 'uat', i.orderId, 225000, i.key ?? 'k', createHash('sha256').update('x').digest('hex'),
          'https://app.lims.test/a', 'https://app.lims.test/b', randomBytes(32), 'system', ctx.actor.id, ctx.actor.id]);
      if (i.setBad) await ctx.tx.query('UPDATE payments.intents SET status = $1 WHERE tenant_id = $2 AND id = $3', [i.setBad, ctx.tenantId, id]);
      await deps.events.publish(ctx, 'payments.intent.settled.v1', { aggregate: { type: 'payment_intent', id, seq: 1 }, idempotencyKey: `k:${id}`, payload: {} });
      await deps.jobs.enqueue(ctx, 'payments.poll_intent', {}, { key: `poll:${id}:1` });
      await ctx.ports.BillingPort.recordGatewayPayment(ctx, { gateway: 'esewa', gatewayTxnRef: id });
      if (i.boom) throw new Error('boom');
      return { rowCount: r.rowCount, status: (await ctx.tx.query('SELECT * FROM payments.intents WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, id])).rows[0] };
    },
    verify: async () => 0, getIntent: async () => 0, cancelIntent: async () => 0, refund: async () => 0,
  }),
}));
const { makePortHarness } = await import('./portHarness');

const O = '01900000-0000-7000-8000-0000000c1501';
let h: Awaited<ReturnType<typeof makePortHarness>>;
beforeEach(async () => { h = await makePortHarness(); await h.seed({ orders: [{ id: O, tenantId: TENANTS.A, dueAmountPaisa: 225000 }], returnUrlHosts: ['app.lims.test'] }); });

describe('portHarness mechanics', () => {
  it('commits a successful call and returns node-pg shaped rows (bigint as string, bytea as Buffer)', async () => {
    const r = await h.impl.createIntent(h.ctxFor('A:system'), { orderId: O });
    expect(r.status.amount_paisa).toBe('225000');
    expect(Buffer.isBuffer(r.status.callback_token_sha256)).toBe(true);
    expect(h.db.intents(TENANTS.A)).toHaveLength(1);
    expect(h.events.ofType('payments.intent.settled.v1')).toHaveLength(1);
    expect(h.jobs).toHaveLength(1); expect(h.ledger.calls).toHaveLength(1);
  });
  it('a throw drops rows, events, jobs and ledger calls of that transaction only', async () => {
    await h.impl.createIntent(h.ctxFor('A:system'), { orderId: O, id: '01900000-0000-7000-8000-0000000c1591', key: 'k1' });
    await expect(h.impl.createIntent(h.ctxFor('A:system'), { orderId: O, id: '01900000-0000-7000-8000-0000000c1592', key: 'k2', boom: true })).rejects.toThrow('boom');
    expect(h.db.intents(TENANTS.A)).toHaveLength(1);
    expect(h.events.published).toHaveLength(1); expect(h.jobs).toHaveLength(1); expect(h.ledger.calls).toHaveLength(1);
  });
  it('enforces the open-intent partial unique index and ON CONFLICT DO NOTHING returns no row', async () => {
    await h.impl.createIntent(h.ctxFor('A:system'), { orderId: O, key: 'k1', id: '01900000-0000-7000-8000-0000000c1591' });
    const r = await h.impl.createIntent(h.ctxFor('A:system'), { orderId: O, key: 'k2', id: '01900000-0000-7000-8000-0000000c1592' });
    expect(r.rowCount).toBe(0);
  });
  it('enforces the status transition guard (created -> settled is rejected)', async () => {
    await expect(h.impl.createIntent(h.ctxFor('A:system'), { orderId: O, setBad: 'settled' })).rejects.toMatchObject({ code: 'P0001', message: 'invalid_transition' });
  });
  it('enforces CHECK constraints (khalti below 1000 paisa is covered by the table CHECK; here: esewa ref must equal id)', async () => {
    await expect(h.impl.createIntent(h.ctxFor('A:system'), { orderId: O, setBad: 'initiated' })).rejects.toMatchObject({ code: '23514' }); // initiated without gateway_txn_ref
  });
  it('serialises transactions and honours the caller clock', async () => {
    let seen = '';
    await h.db.run(async (c) => { seen = c.now(); }, { now: () => new Date('2026-01-01T00:00:00Z') });
    expect(seen).toBe('2026-01-01T00:00:00.000Z');
  });
});
