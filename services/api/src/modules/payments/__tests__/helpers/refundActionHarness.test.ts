// PG-T15 helper self-test (green before the implementation exists): the arrange side of refundActionHarness.ts works, so the red tests fail for the right reason.
import { describe, expect, it } from 'vitest';
import { TENANTS } from '../../../../../../../packages/fakes/src/base';
import { SecretHandle } from '../../service/credentials.js';
import { GW, makeActionHarness } from './refundActionHarness';
import { uid } from './refundHarness';

const RID = uid(500);
describe('refundActionHarness arrange helpers', () => {
  it('script() drives the gateway double for the refund\'s intent; checks() counts the calls; snap() / ifMatch() read the stored row', async () => {
    const t = await makeActionHarness();
    t.addRefund({ id: RID, intent: t.intentId, status: 'requested' });
    const it = t.intent();
    for (const [raw, flag] of [[GW.khalti.full, true], [GW.khalti.partial, false], [GW.khalti.none, false]] as const) {
      t.script(raw);
      const a: any = await t.h.deps.adapters.khalti.check({ intentId: it.id, gatewayTxnRef: it.gateway_txn_ref, amountPaisa: Number(it.amount_paisa) }, new SecretHandle('k'));
      expect(a).toMatchObject({ kind: 'answer', statusRaw: raw, refundedFlag: flag, secondaryRef: 'SYN-TXN-REF-1' });
    }
    expect(t.checks()).toHaveLength(3);
    t.script('code:0');
    expect(await t.h.deps.adapters.khalti.check({ intentId: it.id, gatewayTxnRef: it.gateway_txn_ref, amountPaisa: 1 }, new SecretHandle('k'))).toMatchObject({ kind: 'transient' });
    expect(t.ifMatch(RID)).toEqual({ 'if-match': '"1"' });
    expect(t.snap(RID).refund).toMatchObject({ id: RID, status: 'requested' });
    expect(t.h.ledger.refunds).toEqual([]);
  });

  it('BillingPort.recordGatewayRefund double records the input and answers a ledger entry id; the DB model accepts the P11/P11b columns', async () => {
    const t = await makeActionHarness();
    t.addRefund({ id: RID, intent: t.intentId, status: 'requested' });
    const r = await t.h.ports.BillingPort.recordGatewayRefund({}, { refundId: RID, orderId: t.orderId });
    expect(r).toMatchObject({ ledgerEntryId: '01900000-0000-7000-8000-0000000cc000', duplicate: false });
    expect(t.h.ledger.refunds).toHaveLength(1);
    await t.h.db.run(async (ctx: any) => {
      await ctx.tx.query('UPDATE payments.refunds SET status = $1, failure_reason = $2, failure_note = $3, last_checked_at = $4, version = version + 1 WHERE tenant_id = $5 AND id = $6',
        ['failed', 'gateway_confirmed_not_refunded', 'n', new Date(), TENANTS.A, RID]);
    }, { tenantId: TENANTS.A, now: () => new Date() });
    expect(t.refundRow(RID)).toMatchObject({ status: 'failed', version: 2 });
  });
});
