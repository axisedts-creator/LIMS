// PG-T24: consumer contract tests for the three PaymentProviderPort callers on the REAL port (+ callback handlers) over the in-memory DB fake.
//   C4  staff caller            actor user   ctx.ports.BillingPort; returnUrl = cancelUrl = C4 result page (<API>/v1/payments/result, 08 A19 D-113)
//   C16 engagement-worker fake  actor system returnUrl = <PORTAL>/app/payments/<payment_request_id>/done              (PRD US-PG-11, TRD §5.3)
//   C6  reporting-worker fake   actor system returnUrl = cancelUrl = <PORTAL>/r/payments/<portal_payment_request_id>/done (PRD US-PG-11b, 08 A11.1/A19.3)
// ACs: AC-PG-11.1-11.4, AC-PG-11b.1-11b.4 (11b.5 = C0 phase stub, asserted on the shared stub). Security: 08 R8 (patient/portal actor -> auth.forbidden), REQ-SEC-059 (state is server-side),
// ST-14 (tenant isolation through the port). Harness: helpers/callbackHarness.ts + helpers/portHarness.ts (real port, scripted gateways, no network).
// NOT provable here: the core pipeline's x-permission gate for C4 (IdentityPort double), real RLS, a running C16/C6 worker.
import { beforeEach, describe, expect, it } from 'vitest';
import { FIXED_NOW, TENANTS } from '../../../../../../../packages/fakes/src/base';
import { createPaymentProviderPortStub } from '../../../../../../../packages/fakes/src/stubs/PaymentProviderPort.stub';
import { hdr, makeCallbackHarness, RESULT_PAGE, type CallbackHarness, type Res } from '../helpers/callbackHarness';

const A = TENANTS.A, B = TENANTS.B;
const PORTAL = 'https://portal.lims.test';
const PRID = '01900000-0000-7000-8000-0000000c9901'; // the caller's own payment_request id (C16 payment_requests / C6 portal_payment_requests)

interface Caller { name: string; actor: string; actorType: 'user' | 'system'; ret: string; cancel: string }
const CALLERS: Caller[] = [
  { name: 'C4 staff', actor: 'A:user:front_desk', actorType: 'user', ret: RESULT_PAGE, cancel: RESULT_PAGE },
  { name: 'C16 engagement worker', actor: 'A:system:engagement', actorType: 'system', ret: `${PORTAL}/app/payments/${PRID}/done`, cancel: `${PORTAL}/app/payments/${PRID}/done` },
  { name: 'C6 reporting worker', actor: 'A:system:reporting', actorType: 'system', ret: `${PORTAL}/r/payments/${PRID}/done`, cancel: `${PORTAL}/r/payments/${PRID}/done` },
];

let t: CallbackHarness;
beforeEach(async () => { t = await makeCallbackHarness(); });

let n = 0;
async function create(c: Caller, o: { gateway?: 'esewa' | 'khalti'; due?: number; status?: string; key?: string; ret?: string } = {}) {
  const gateway = o.gateway ?? 'esewa', due = o.due ?? 225000;
  const orderId = `01900000-0000-7000-8000-0000000c24${String(++n).padStart(2, '0')}`;
  t.h.setOrder({ id: orderId, tenantId: A, dueAmountPaisa: due, gatewayStatus: o.status ?? (gateway === 'esewa' ? 'PENDING' : 'Pending') });
  const input = { orderId, gateway, idempotencyKey: o.key ?? `c24-${n}`, returnUrl: o.ret ?? c.ret, cancelUrl: c.cancel };
  const r = await t.h.impl.createIntent(t.h.ctxFor(c.actor), input);
  const token = gateway === 'esewa' ? decodeURIComponent(new URL(r.action.launchUrl).pathname.split('/').filter(Boolean).at(-1)!) : (t.h.gateway.initiateInputs.at(-1) as any).callbackToken;
  const row = t.h.db.intents(A).find((x) => x.id === r.intentId)!;
  return { r, orderId, token, input, gateway, intentId: r.intentId as string, row, pidx: row.gateway_txn_ref as string };
}
const made = (m: Awaited<ReturnType<typeof create>>) => ({ intentId: m.intentId, token: m.token, pidx: m.pidx, tenant: 'A' as const });
const redirect = (r: Res) => new URL(hdr(r, 'location')!, 'https://api.lims.test');
const codeOf = (p: Promise<unknown>) => p.then(() => 'resolved', (e: any) => e?.code ?? `non_lims_error:${e?.message}`);
const gatewayCalls = () => t.h.gateway.calls.length;

describe.each(CALLERS)('$name: createIntent / getIntent / hosted redirect', (c) => {
  it('AC-PG-11.1 / 11b.1: createIntent is accepted by the allowlist, returns the gateway action, stores the caller\'s URLs and actor type; the amount is C15\'s own balance read', async () => {
    const m = await create(c, { due: 187500 });
    expect(m.r).toMatchObject({ gateway: 'esewa', replayed: false });
    expect(m.row.status).toBe('initiated');
    expect(typeof m.r.action.launchUrl).toBe('string');
    expect(m.row).toMatchObject({ tenant_id: A, return_url: c.ret, cancel_url: c.cancel, created_actor_type: c.actorType, amount_paisa: 187500 });
    const k = await create(c, { gateway: 'khalti' });
    expect(k.r.action).toMatchObject({ kind: 'redirect', url: expect.stringMatching(/^https:\/\//) });
  });

  it('AC-PG-11b.1: there is no amount input — a caller-supplied amount (any spelling) is rejected before any state change', async () => {
    t.h.setOrder({ id: '01900000-0000-7000-8000-0000000c24f1', tenantId: A, dueAmountPaisa: 5000 });
    for (const extra of [{ amountPaisa: 1 }, { amount: { amountPaisa: 1, currency: 'NPR' } }]) {
      const input = { orderId: '01900000-0000-7000-8000-0000000c24f1', gateway: 'esewa', idempotencyKey: 'amt-1', returnUrl: c.ret, cancelUrl: c.cancel, ...extra };
      expect(await codeOf(t.h.impl.createIntent(t.h.ctxFor(c.actor), input))).toBe('common.validation_failed');
    }
    expect(t.h.db.intents(A)).toHaveLength(0);
    expect(gatewayCalls()).toBe(0);
  });

  it('an off-allowlist returnUrl is refused with payments.return_url_not_allowed and nothing is stored', async () => {
    const code = await codeOf(create(c, { ret: 'https://attacker.invalid/r/payments/x/done' }));
    expect(code).toBe('payments.return_url_not_allowed');
    expect(t.h.db.intents(A)).toHaveLength(0);
  });

  it('replaying the same idempotencyKey + input returns the same intent (replayed: true); the same key with another returnUrl -> common.idempotency_key_reused', async () => {
    const m = await create(c, { key: 'replay-1' });
    const again = await t.h.impl.createIntent(t.h.ctxFor(c.actor), m.input);
    expect(again).toMatchObject({ intentId: m.intentId, replayed: true });
    expect(await codeOf(t.h.impl.createIntent(t.h.ctxFor(c.actor), { ...m.input, returnUrl: `${PORTAL}/r/payments/${PRID}/other` }))).toBe('common.idempotency_key_reused');
    expect(t.h.db.intents(A)).toHaveLength(1);
  });

  it('AC-PG-11b.3: getIntent returns the stored status WITHOUT a gateway call (a gateway that now says COMPLETE changes nothing)', async () => {
    const m = await create(c);
    const before = gatewayCalls();
    t.h.setOrder({ id: m.orderId, tenantId: A, dueAmountPaisa: 225000, gatewayStatus: 'COMPLETE' });
    const g = await t.h.impl.getIntent(t.h.ctxFor(c.actor), { intentId: m.intentId });
    expect(g).toMatchObject({ intentId: m.intentId, orderId: m.orderId, gateway: 'esewa', status: 'initiated', amount: { amountPaisa: 225000, currency: 'NPR' } });
    expect(gatewayCalls()).toBe(before);
    expect(t.h.db.intents(A).find((x) => x.id === m.intentId)!.status).toBe('initiated');
    expect(t.h.ledger.calls).toHaveLength(0);
  });

  it('AC-PG-11.2 / 11b.2: payment completes -> server-side verify, ledger call inside the settle tx, 303 to the caller\'s returnUrl with intent_id and outcome=settled; getIntent then reports settled', async () => {
    const m = await create(c, { status: 'COMPLETE' });
    const r = await t.call('esewaSuccessCallback', { token: m.token, query: { data: t.esewaData(m) } });
    expect(r.status).toBe(303);
    const u = redirect(r);
    expect(`${u.origin}${u.pathname}`).toBe(c.ret);
    expect([u.searchParams.get('intent_id'), u.searchParams.get('outcome')]).toEqual([m.intentId, 'settled']);
    expect(t.h.ledger.calls).toHaveLength(1);
    expect(t.h.ledger.calls[0]).toMatchObject({ intentId: m.intentId, gateway: 'esewa' });
    const g = await t.h.impl.getIntent(t.h.ctxFor(c.actor), { intentId: m.intentId });
    expect(g).toMatchObject({ status: 'settled', amount: { amountPaisa: 225000, currency: 'NPR' } });
    expect(typeof g.settledAt).toBe('string');
  });

  it('AC-PG-11.2 / 11b.2: Khalti return lands on the same URL with intent_id and outcome', async () => {
    const m = await create(c, { gateway: 'khalti', status: 'Completed' });
    const r = await t.call('khaltiReturnCallback', { token: m.token, query: { pidx: m.pidx, status: 'Completed', purchase_order_id: m.intentId } });
    const u = redirect(r);
    expect(r.status).toBe(303);
    expect(`${u.origin}${u.pathname}`).toBe(c.ret);
    expect([u.searchParams.get('intent_id'), u.searchParams.get('outcome')]).toEqual([m.intentId, 'settled']);
  });

  it('a cancelled/failed payment redirects to the caller\'s cancelUrl with outcome=failed (C6: same URL as returnUrl)', async () => {
    const m = await create(c, { status: 'CANCELED' });
    const r = await t.call('esewaFailureCallback', { token: m.token, query: { data: t.esewaData(m, { status: 'CANCELED' }) } });
    expect(r.status).toBe(303);
    const u = redirect(r);
    expect(`${u.origin}${u.pathname}`).toBe(c.cancel);
    expect([u.searchParams.get('intent_id'), u.searchParams.get('outcome')]).toEqual([m.intentId, 'failed']);
    expect(t.h.ledger.calls).toHaveLength(0);
  });

  it('AC-PG-11.3 (REQ-SEC-059): editing outcome=settled in the browser URL changes nothing server-side; the caller still reads a non-settled status', async () => {
    const m = await create(c, { status: 'PENDING' });
    const r = await t.call('getPaymentResultPage', { query: { outcome: 'settled', intent_id: m.intentId } });
    expect(r.status).toBe(200);
    const snapshot = JSON.stringify([t.h.db.intents(A), t.h.db.transitions(A)]);
    await t.call('getPaymentResultPage', { query: { outcome: 'settled', intent_id: m.intentId } });
    expect(JSON.stringify([t.h.db.intents(A), t.h.db.transitions(A)])).toBe(snapshot);
    expect(t.h.ledger.calls).toHaveLength(0);
    expect(t.h.events.ofType('payments.intent.settled.v1')).toHaveLength(0);
    expect((await t.h.impl.getIntent(t.h.ctxFor(c.actor), { intentId: m.intentId })).status).not.toBe('settled');
  });

  it('08 R8 / AC-PG-11.4 / 11b.4: patient / portal / anonymous actors are refused with auth.forbidden on every method, before any read, write or gateway call', async () => {
    const m = await create(c);
    const before = JSON.stringify([t.h.db.intents(A), t.h.db.transitions(A)]);
    const calls = gatewayCalls(), jobs = t.h.jobs.length;
    const U = m.intentId, money = { amountPaisa: 1000, currency: 'NPR' };
    for (const type of ['patient', 'portal', 'anonymous', 'service']) {
      const x = () => t.h.ctxFor(`A:${type}`);
      const attempts: [string, Promise<unknown>][] = [
        ['createIntent', t.h.impl.createIntent(x(), m.input)],
        ['getIntent', t.h.impl.getIntent(x(), { intentId: U })],
        ['cancelIntent', t.h.impl.cancelIntent(x(), { intentId: U, reasonCode: 'customer_request' })],
        ['verify', t.h.impl.verify(x(), { intentId: U })],
        ['refund', t.h.impl.refund(x(), { intentId: U, amount: money, reasonCode: 'duplicate_payment', idempotencyKey: 'rf-24', approvalId: U })],
      ];
      for (const [method, p] of attempts) expect([type, method, await codeOf(p)]).toEqual([type, method, 'auth.forbidden']);
    }
    expect(JSON.stringify([t.h.db.intents(A), t.h.db.transitions(A)])).toBe(before);
    expect(gatewayCalls()).toBe(calls);
    expect(t.h.jobs).toHaveLength(jobs);
    expect(t.h.ledger.calls).toHaveLength(0);
  });
});

describe('consumer contract: tenant isolation and the C0 phase stub', () => {
  it('ST-14: a tenant-B worker cannot read or cancel tenant-A\'s intent through the port (common.not_found), whichever caller created it', async () => {
    for (const c of CALLERS.slice(1)) {
      const m = await create(c);
      for (const actor of ['B:system:engagement', 'B:system:reporting', 'B:user:front_desk']) {
        expect(await codeOf(t.h.impl.getIntent(t.h.ctxFor(actor), { intentId: m.intentId }))).toBe('common.not_found');
        expect(await codeOf(t.h.impl.cancelIntent(t.h.ctxFor(actor), { intentId: m.intentId, reasonCode: 'customer_request' }))).toBe('common.not_found');
      }
      expect(t.h.db.intents(B)).toHaveLength(0);
    }
  });

  it('C16 and C6 intents share one open-intent slot per order: a second caller creating for the same order while one is open is refused (payments.intent_open_exists)', async () => {
    const [, c16, c6] = CALLERS as [Caller, Caller, Caller];
    const m = await create(c16);
    const code = await codeOf(t.h.impl.createIntent(t.h.ctxFor(c6.actor), { orderId: m.orderId, gateway: 'khalti', idempotencyKey: 'c6-other', returnUrl: c6.ret, cancelUrl: c6.cancel }));
    expect(code).toBe('payments.intent_open_exists');
    expect(t.h.db.intents(A)).toHaveLength(1);
  });

  it('AC-PG-11b.5: before C15 is deployed the C0 phase stub answers payments.gateway_not_available for createIntent and getIntent (the portal shows no payment button)', async () => {
    const stub: any = createPaymentProviderPortStub();
    const ctx = t.h.ctxFor('A:system:reporting', { now: () => FIXED_NOW as any });
    expect(await codeOf(stub.createIntent(ctx, { orderId: 'x', gateway: 'esewa', idempotencyKey: 'k', returnUrl: `${PORTAL}/r/payments/${PRID}/done`, cancelUrl: `${PORTAL}/r/payments/${PRID}/done` }))).toBe('payments.gateway_not_available');
    expect(await codeOf(stub.getIntent(ctx, { intentId: PRID }))).toBe('payments.gateway_not_available');
  });
});
