// T0B-SYNC-3 done_when (1), (3), (5), (6): billing.record_receipt through the real engine + the real adapter on a real PG17 (RLS on). The billing SERVICE LAYER (createLedgerService().recordPayment)
// is replaced by a recording double with a gap free per tenant counter written through ctx.tx and idempotency by key (./doubles.ts), so the properties under test are the adapter's:
// same transaction, op id as idempotency key, original actor, device time, provisional -> final mapping, replay, rollback of the number on a rejected operation, order of arrival.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../../modules/frontdesk/service/registration.service.js', async (orig) => (await import('./doubles.js')).registrationMock(orig as never));
vi.mock('../../../../modules/billing/service/ledger.service.js', async (orig) => (await import('./doubles.js')).ledgerMock(orig as never));
vi.mock('../../../../modules/lab/service/specimen.service.js', async (orig) => (await import('./doubles.js')).specimenMock(orig as never));
import { A1, A2, B1, TENANT_A, TENANT_B, USER, code, devicePush, engine, ledger, newDevice, okBody, op, ownerRows, uid, NOW, iso } from '../helpers2.js';
import { behave, calls, ensureCounter, lastNo, orderOf, orders, receiptPayload, reset } from './doubles.js';
import { billingRecordReceiptAdapter } from '../../../../modules/billing/sync/receipt.adapter.js';

const T = 240_000;
const H = engine({}, [billingRecordReceiptAdapter]);
const rc = (o: Record<string, unknown> = {}, at?: Date): any => op('billing.record_receipt', { entity_id: uid(), payload: receiptPayload(), ...o }, at);
const one = (o: any): any => okBody(o).results[0];
const finalOf = (r: any): string => r.number_mappings[0].final_number;
const seq = (s: string): number => Number(s.slice(-6));
beforeAll(ensureCounter);
beforeEach(reset);

describe('the adapter calls the billing service layer as the signed in user (done_when 1, 5)', () => {
  it('recordPayment got the order, the money, a manual capture with a receipt number, the original actor, and the op id inside its idempotency key', async () => {
    const dev = await newDevice(A1);
    const r = rc({ payload: receiptPayload({ method_code: 'cash', amount_received_paisa: 2_500, reference: 'SYN-REF-1' }) });
    const res = one(await devicePush(H, A1, dev, [r]));
    expect(res).toMatchObject({ op_id: r.op_id, status: 'accepted', entity_id: r.entity_id });
    expect(calls.recordPayment).toHaveLength(1);
    const { ctx, args: [input] } = calls.recordPayment[0]!;
    expect(ctx.tenantId).toBe(TENANT_A); expect(ctx.actor).toMatchObject({ id: USER.a1, membershipId: USER.a1 });
    expect(input).toMatchObject({ orderId: r.entity_id, methodCode: 'cash', amount: { amountPaisa: 2_500, currency: 'NPR' }, reference: 'SYN-REF-1', captureKind: 'manual', issueReceiptNo: true });
    expect(input.idempotencyKey).toContain(r.op_id);
  }, T);
  it('the device time is stored where the ledger has a captured time field (capturedAt) and is the device time, not the server time', async () => {
    const dev = await newDevice(A1);
    const at = new Date(NOW.getTime() - 5 * 3_600_000);
    const r = rc({}, at);
    await devicePush(H, A1, dev, [r]);
    expect(calls.recordPayment[0]!.args[0].capturedAt).toBe(at.toISOString());   // review T0B-SYNC-3 item 3: the same instant, at most 3 fraction digits (the ledger's capturedAt rule)
    expect((await ledger([r.op_id]))[0].device_created_at.toISOString().replace(/\.\d{3}Z$/, 'Z')).toBe(iso(at));
  }, T);
  it('device time with microseconds (the engine accepts up to 6 fraction digits): accepted, capturedAt reaches the service with exactly 3 (review item 3)', async () => {
    const dev = await newDevice(A1);
    const r = rc({}); r.device_created_at = '2026-11-17T08:30:00.123456Z';
    expect(one(await devicePush(H, A1, dev, [r]))).toMatchObject({ status: 'accepted', entity_id: r.entity_id });
    expect(calls.recordPayment[0]!.args[0].capturedAt).toBe('2026-11-17T08:30:00.123Z');
  }, T);
  it('the body can not attribute money to someone else: collector, capture kind and receipt choice come from the adapter, not the payload', async () => {
    const dev = await newDevice(A1);
    const r = rc({ payload: receiptPayload({ collectedByMembershipId: uid(), captureKind: 'gateway', issueReceiptNo: false }) });
    const res = one(await devicePush(H, A1, dev, [r]));
    // unknown payload keys are refused by the request schema online (RecordPaymentRequest additionalProperties false): the adapter validate() refuses them too, before any write
    expect(res).toMatchObject({ status: 'rejected', error_code: 'common.validation_failed' });
    expect(calls.recordPayment).toHaveLength(0);
  }, T);
  it('permission removed meanwhile: rejected auth.forbidden, the service is never called, no number is used', async () => {
    const dev = await newDevice(A1);
    const before = await lastNo(TENANT_A, 'RC');
    const o = await devicePush(H, A1, dev, [rc()], { grants: { codes: ['sync.use'] } });
    expect(one(o)).toMatchObject({ status: 'rejected', error_code: 'auth.forbidden' });
    expect(o.asserted).toContain('billing.payment.record');
    expect(calls.recordPayment).toHaveLength(0); expect(await lastNo(TENANT_A, 'RC')).toBe(before);
  }, T);
  it('cross tenant: a tenant B user gets tenant B numbers and a tenant B ledger row', async () => {
    const dev = await newDevice(B1);
    const r = rc();
    expect(one(await devicePush(H, B1, dev, [r]))).toMatchObject({ status: 'accepted' });
    expect(calls.recordPayment[0]!.ctx.tenantId).toBe(TENANT_B);
    expect(await lastNo(TENANT_B, 'RC')).toBeGreaterThan(0);
    expect((await ledger([r.op_id])).map((x) => x.tenant_id)).toEqual([TENANT_B]);
  }, T);
});

describe('provisional to final receipt number (done_when 3)', () => {
  it('returns one receipt mapping OFF-... -> the final gap free number of the service; the entity id is the order', async () => {
    const dev = await newDevice(A1);
    const before = await lastNo(TENANT_A, 'RC');
    const res = one(await devicePush(H, A1, dev, [rc()]));
    expect(res.number_mappings).toHaveLength(1);
    expect(res.number_mappings[0]).toMatchObject({ document_type: 'receipt', final_number: `RC-2083-${String(before + 1).padStart(6, '0')}` });
    expect(res.number_mappings[0].provisional_number).toMatch(/^OFF-[A-Za-z0-9-]+$/);
  }, T);
  it('the same operation replayed returns the same final number and uses no new number', async () => {
    const dev = await newDevice(A1);
    const r = rc();
    const a = one(await devicePush(H, A1, dev, [r]));
    const after = await lastNo(TENANT_A, 'RC');
    const b = one(await devicePush(H, A1, dev, [r]));
    expect(b.status).toBe('duplicate'); expect(b.number_mappings).toEqual(a.number_mappings);
    expect(await lastNo(TENANT_A, 'RC')).toBe(after); expect(calls.recordPayment).toHaveLength(1);
  }, T);
  it('even when the engine ledger row is gone (lost response, restored backup), the op id as idempotency key makes the SERVICE answer the same final number', async () => {
    const dev = await newDevice(A1);
    const r = rc();
    const a = one(await devicePush(H, A1, dev, [r]));
    await ownerRows('DELETE FROM core.sync_operation WHERE op_id = $1', [r.op_id]).catch(() => undefined);
    const after = await lastNo(TENANT_A, 'RC');
    const b = one(await devicePush(H, A1, dev, [r]));
    expect(['accepted', 'duplicate']).toContain(b.status);
    expect(b.number_mappings[0].final_number).toBe(a.number_mappings[0].final_number);
    expect(b.number_mappings[0].provisional_number).toBe(a.number_mappings[0].provisional_number);
    expect(await lastNo(TENANT_A, 'RC')).toBe(after);
  }, T);
  it('server arrival order, not device order: a batch is numbered in device_created_at order, a later batch continues after it', async () => {
    const dev = await newDevice(A1);
    const t0 = NOW.getTime() - 3_600_000;
    const late = rc({}, new Date(t0 + 2000)), early = rc({}, new Date(t0 + 1000));
    const rs = okBody(await devicePush(H, A1, dev, [late, early])).results;   // sent late first, results in the order sent
    expect(seq(finalOf(rs[1]))).toBe(seq(finalOf(rs[0])) - 1);
    const next = one(await devicePush(H, A1, dev, [rc()]));
    expect(seq(finalOf(next))).toBe(seq(finalOf(rs[0])) + 1);
  }, T);
  it('a rejected operation in the middle consumes no number: the accepted ones around it are consecutive', async () => {
    const dev = await newDevice(A1);
    const t0 = NOW.getTime() - 3_600_000;
    const a = rc({}, new Date(t0)), bad = rc({ payload: receiptPayload({ amount_received_paisa: 9_999_999 }) }, new Date(t0 + 1000)), c = rc({}, new Date(t0 + 2000));
    const rs = okBody(await devicePush(H, A1, dev, [a, bad, c])).results;
    expect(rs[1]).toMatchObject({ status: 'rejected', error_code: 'billing.payment_exceeds_due' });
    expect(seq(finalOf(rs[2]))).toBe(seq(finalOf(rs[0])) + 1);
  }, T);
});

describe('held or reversed entries behave as online (done_when 3)', () => {
  it('payment above the due amount: billing.payment_exceeds_due; order without invoice: billing.order_not_invoiced; both rejected, never an overpayment', async () => {
    const dev = await newDevice(A1);
    const over = rc({ payload: receiptPayload({ amount_received_paisa: 100_001 }) });
    const none = rc(); orderOf(none.entity_id).invoiceCount = 0;
    const rs = okBody(await devicePush(H, A1, dev, [over, none])).results;
    expect(rs[0]).toMatchObject({ status: 'rejected', error_code: 'billing.payment_exceeds_due' });
    expect(rs[1]).toMatchObject({ status: 'rejected', error_code: 'billing.order_not_invoiced' });
    expect(orders.get(over.entity_id)!.paid).toBe(0);
  }, T);
  it('two receipts that together exceed the due: the first is accepted, the second rejected (arrival order decides, as online)', async () => {
    const dev = await newDevice(A1);
    const order = uid(); const t0 = NOW.getTime() - 3_600_000;
    const a = rc({ entity_id: order, payload: receiptPayload({ amount_received_paisa: 80_000 }) }, new Date(t0)), b = rc({ entity_id: order, payload: receiptPayload({ amount_received_paisa: 30_000 }) }, new Date(t0 + 1000));
    const rs = okBody(await devicePush(H, A1, dev, [a, b])).results;
    expect([rs[0].status, rs[1].status, rs[1].error_code]).toEqual(['accepted', 'rejected', 'billing.payment_exceeds_due']);
  }, T);
  it('after the payment was reversed online the due is back: the offline receipt for the full amount is accepted', async () => {
    const dev = await newDevice(A1);
    const order = uid(); const o = orderOf(order);
    const first = rc({ entity_id: order, payload: receiptPayload({ amount_received_paisa: 100_000 }) });
    expect(one(await devicePush(H, A1, dev, [first])).status).toBe('accepted');
    const second = rc({ entity_id: order, payload: receiptPayload({ amount_received_paisa: 100_000 }) });
    expect(one(await devicePush(H, A1, dev, [second])).error_code).toBe('billing.payment_exceeds_due');
    o.paid = 0;   // the reversal of the first entry (B9) restores the due
    const third = rc({ entity_id: order, payload: receiptPayload({ amount_received_paisa: 100_000 }) });
    expect(one(await devicePush(H, A1, dev, [third])).status).toBe('accepted');
  }, T);
  it('a service error outside the closed list never reaches the device: common.internal, no detail', async () => {
    const dev = await newDevice(A1);
    behave.recordPayment = async () => { throw new Error('secret-card-4111111111111111'); };
    const o = await devicePush(H, A1, dev, [rc()]);
    expect(one(o)).toMatchObject({ status: 'rejected', error_code: 'common.internal' });
    expect(JSON.stringify(o.reply!.body) + o.logs.join('\n')).not.toContain('4111');
  }, T);
});

describe('100 receipts from 5 devices keep the number series gap free and unique (done_when 6)', () => {
  it('concurrent batches: 100 accepted, final numbers are exactly the next 100 in the series, provisional numbers unique, every op on its own device', async () => {
    const devs = await Promise.all([A1, A1, A1, A2, A2].map((u) => newDevice(u)));
    const who = [A1, A1, A1, A2, A2];
    const start = await lastNo(TENANT_A, 'RC');
    const batches = devs.map((_, d) => Array.from({ length: 20 }, (_, i) => rc({}, new Date(NOW.getTime() - 3_600_000 + (d * 20 + i) * 1000))));
    const outs = await Promise.all(devs.map((dev, d) => devicePush(H, who[d]!, dev, batches[d]!)));
    const results = outs.flatMap((o) => okBody(o).results);
    expect(results).toHaveLength(100);
    expect(results.every((r: any) => r.status === 'accepted')).toBe(true);
    const finals = results.map((r: any) => seq(finalOf(r))).sort((x: number, y: number) => x - y);
    expect(finals).toEqual(Array.from({ length: 100 }, (_, i) => start + 1 + i));          // gap free and unique
    expect(new Set(results.map((r: any) => r.number_mappings[0].provisional_number)).size).toBe(100);
    expect(await lastNo(TENANT_A, 'RC')).toBe(start + 100);
    expect((await ledger(batches.flat().map((x: any) => x.op_id))).filter((l) => l.status === 'accepted')).toHaveLength(100);
  }, T);
  it('the same 20 receipts sent twice at once from two requests: each is numbered once', async () => {
    const dev = await newDevice(A1);
    const start = await lastNo(TENANT_A, 'RC');
    const ops = Array.from({ length: 20 }, (_, i) => rc({}, new Date(NOW.getTime() - 3_600_000 + i * 1000)));
    const dev2 = await newDevice(A1);
    const [x, y] = await Promise.all([devicePush(H, A1, dev, ops), devicePush(H, A1, dev2, ops)]);
    const all = [...(x.reply ? okBody(x).results : []), ...(y.reply ? okBody(y).results : [])];
    expect(all.filter((r: any) => r.status === 'accepted').length).toBeLessThanOrEqual(20);
    expect(await lastNo(TENANT_A, 'RC')).toBe(start + 20);
  }, T);
});
