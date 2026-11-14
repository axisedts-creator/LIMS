// PG-T08 integration: createIntent / getIntent / cancelIntent / verify on the real port (TRD §6.1-§6.4, §5.3, §8.1) over the in-memory DB fake.
// ACs: AC-PG-01.1-01.10, 02.1-02.4, 05.1-05.2 (05.3 sweep = PG-T11), 06.1-06.4, 13.1-13.2. Security: ST-01, ST-03, ST-05, ST-06, ST-08, REQ-SEC-046/047/053, tenant isolation,
// actor-type guard (TRD §5.3), secrets/tokens never stored in clear. Wiring seam: helpers/portHarness.ts header. Synthetic data only.
// Real-DB parallelism (row lock / partial unique index under true interleaving) cannot be proven until the C0 payments DDL exists: here transactions are serialised.
// Fails now: ports/PaymentProviderPort.impl.ts does not export createPaymentProviderPort.
import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { FIXED_NOW, TENANTS } from '../../../../../../../packages/fakes/src/base';
import { KHALTI_WEBSITE, PRODUCT_CODE, SECRET, makePortHarness, type PortHarness } from '../helpers/portHarness';

const A = TENANTS.A, B = TENANTS.B;
const O1 = '01900000-0000-7000-8000-0000000c1501';
const O2 = '01900000-0000-7000-8000-0000000c1502';
const DUE = 225000;
const URLS = { returnUrl: 'https://app.lims.test/pay/done', cancelUrl: 'https://app.lims.test/pay/cancel' };
const at = (seconds: number): string => new Date(Date.parse(FIXED_NOW) + seconds * 1000).toISOString();
const npr = (amountPaisa: number) => ({ amountPaisa, currency: 'NPR' });
const code = (p: Promise<unknown>): Promise<string> => p.then(() => 'resolved', (e: any) => e?.code ?? `non_lims_error:${e?.message}`);

let h: PortHarness;
const sys = (now?: string, key = 'A:system') => h.ctxFor(key, now ? { now: () => now as any } : {});
const create = (o: Record<string, unknown> = {}, ctx = sys()) =>
  h.impl.createIntent(ctx, { orderId: O1, gateway: 'esewa', idempotencyKey: 'k1', ...URLS, ...o });
const verify = (intentId: string, now?: string, ctx = sys(now)) => h.impl.verify(ctx, { intentId });
const rows = (tenant = A) => h.db.intents(tenant);
const row = (id: string) => rows().find((r) => r.id === id)!;
const settledEvents = () => h.events.ofType('payments.intent.settled.v1');
const checks = () => h.gateway.calls.filter((c) => c.op === 'check');
const initiates = () => h.gateway.calls.filter((c) => c.op === 'initiate');

const arrange = async (o: { status?: string; amount?: number; amountPaisa?: number } = {}) => h.seed({
  orders: [{ id: O1, tenantId: A, dueAmountPaisa: o.amount ?? DUE, gatewayStatus: o.status ?? 'PENDING', ...(o.amountPaisa !== undefined ? { gatewayAmountPaisa: o.amountPaisa } : {}) }],
  returnUrlHosts: ['app.lims.test'],
});
beforeEach(async () => { h = await makePortHarness(); await arrange(); });

describe('AC-PG-01.1 eSewa createIntent', () => {
  it('stores an initiated intent for exactly the order due and returns the signed form action', async () => {
    const r = await create();
    expect(r).toMatchObject({ gateway: 'esewa', amount: npr(DUE), replayed: false });
    expect(r.intentId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(rows()).toHaveLength(1);
    const x = row(r.intentId);
    expect(x).toMatchObject({ status: 'initiated', gateway: 'esewa', environment: 'uat', currency: 'NPR', order_id: O1, gateway_txn_ref: r.intentId, idempotency_key: 'k1',
      return_url: URLS.returnUrl, cancel_url: URLS.cancelUrl, created_actor_type: 'system', check_count: 0 });
    expect(Number(x.amount_paisa)).toBe(DUE);
    expect(x.branch_id).toBeTruthy(); expect(x.centre_id).toBeTruthy();                       // from FrontdeskPort.getOrderSummary
    expect(Buffer.isBuffer(x.callback_token_sha256) && x.callback_token_sha256.length === 32).toBe(true);
    expect(new Date(x.expires_at).toISOString()).toBe(at(h.config.esewaIntentTtlMinutes * 60));
    expect(r.expiresAt).toBe(at(h.config.esewaIntentTtlMinutes * 60));
    expect(x.initiated_at).toBeInstanceOf(Date);

    const f = r.action.fields;
    expect(r.action).toMatchObject({ kind: 'form_post', url: h.config.esewaFormUrl });
    expect(f).toMatchObject({ amount: '2250', total_amount: '2250', tax_amount: '0', product_service_charge: '0', product_delivery_charge: '0', transaction_uuid: r.intentId,
      product_code: PRODUCT_CODE, signed_field_names: 'total_amount,transaction_uuid,product_code' });
    expect(f.signature).toBe(createHmac('sha256', SECRET.esewa).update(`total_amount=2250,transaction_uuid=${r.intentId},product_code=${PRODUCT_CODE}`).digest('base64'));
    expect(r.action.launchUrl).toMatch(/^https:\/\//);
    expect(h.gateway.calls.filter((c) => c.op === 'initiate')).toHaveLength(0);              // eSewa: local signing only, no network
    expect(h.gateway.secretsSeen.length === 0 || h.gateway.secretsSeen.every((s) => s === SECRET.esewa)).toBe(true);
  });

  it('writes the transition rows (create -> initiated) as the calling actor type, and nothing else', async () => {
    const r = await create();
    const t = h.db.transitions(A).filter((x) => x.intent_id === r.intentId);
    expect(t.map((x) => x.to_status)).toEqual(expect.arrayContaining(['initiated']));
    expect(t.at(-1)).toMatchObject({ from_status: 'created', to_status: 'initiated', cause: 'create', actor_type: 'system' });
    expect(t.every((x) => x.actor_type === 'system')).toBe(true);
  });

  it('never stores the raw callback token or any secret (only its sha256)', async () => {
    const r = await create();
    const token = decodeURIComponent(new URL(r.action.launchUrl).pathname.split('/').filter(Boolean).at(-1)!);
    expect(token.length).toBeGreaterThanOrEqual(32);
    const stored = JSON.stringify([rows(), h.db.transitions(A), h.db.gatewayCalls(A)]) + h.db.sentText();
    expect(stored).not.toContain(token);
    expect(stored).not.toContain(SECRET.esewa);
    expect(JSON.stringify(r)).not.toContain(SECRET.esewa);
  });

  it('two intents never share a callback token hash', async () => {
    await h.seed({ orders: [{ id: O1, tenantId: A, dueAmountPaisa: DUE }, { id: O2, tenantId: A, dueAmountPaisa: DUE }], returnUrlHosts: ['app.lims.test'] });
    const a = await create(), b = await create({ orderId: O2, idempotencyKey: 'k2' });
    expect(row(a.intentId).callback_token_sha256.equals(row(b.intentId).callback_token_sha256)).toBe(false);
  });
});

describe('AC-PG-01.2 replay', () => {
  it('same key -> same intent, replayed:true, one row, same signed action, no second set of jobs', async () => {
    const a = await create();
    const jobsAfterFirst = h.jobs.length;
    const b = await create();
    expect(b.intentId).toBe(a.intentId);
    expect(b.replayed).toBe(true);
    expect(rows()).toHaveLength(1);
    expect(b.amount).toEqual(a.amount);
    expect(b.expiresAt).toBe(a.expiresAt);
    expect(b.action.kind).toBe('form_post');
    expect(b.action.url).toBe(a.action.url);
    for (const k of ['amount', 'total_amount', 'transaction_uuid', 'product_code', 'signed_field_names', 'signature']) expect(b.action.fields[k], k).toBe(a.action.fields[k]);
    expect(h.jobs).toHaveLength(jobsAfterFirst);
    expect(h.db.transitions(A).filter((t) => t.to_status === 'initiated')).toHaveLength(1);
  });

  it('same key with a different order, gateway, returnUrl or cancelUrl -> common.idempotency_key_reused, nothing changes', async () => {
    await h.seed({ orders: [{ id: O1, tenantId: A, dueAmountPaisa: DUE }, { id: O2, tenantId: A, dueAmountPaisa: DUE }], returnUrlHosts: ['app.lims.test', 'portal.lims.test'] });
    await create();
    for (const diff of [{ orderId: O2 },{ gateway: 'khalti' }, { returnUrl: 'https://portal.lims.test/x' }, { cancelUrl: 'https://portal.lims.test/x' }]) {
      expect(await code(create(diff)), JSON.stringify(diff)).toBe('common.idempotency_key_reused');
    }
    expect(rows()).toHaveLength(1);
  });

  it('replay of a Khalti intent returns the same redirect without calling Khalti again', async () => {
    const a = await create({ gateway: 'khalti' });
    const b = await create({ gateway: 'khalti' });
    expect(b).toMatchObject({ intentId: a.intentId, replayed: true, action: a.action, expiresAt: a.expiresAt });
    expect(initiates()).toHaveLength(1);
  });

  it('replay is tenant-scoped: another tenant using the same key gets its own intent', async () => {
    const a = await create();
    const b = await create({}, sys(undefined, 'B:system'));
    expect(b.intentId).not.toBe(a.intentId);
    expect(b.replayed).toBe(false);
    expect(rows(A)).toHaveLength(1); expect(rows(B)).toHaveLength(1);
  });
});

describe('AC-PG-01.3 / ST-08 one open intent per order', () => {
  it('a different key while an intent is open -> payments.intent_open_exists, no extra row, no gateway call', async () => {
    await create({ gateway: 'khalti' });
    const before = initiates().length;
    expect(await code(create({ gateway: 'khalti', idempotencyKey: 'k2' }))).toBe('payments.intent_open_exists');
    expect(await code(create({ gateway: 'esewa', idempotencyKey: 'k3' }))).toBe('payments.intent_open_exists');
    expect(rows()).toHaveLength(1);
    expect(initiates()).toHaveLength(before);
  });

  it('ST-08: 20 concurrent creates with different keys -> exactly one open intent, the rest intent_open_exists, Khalti initiated once', async () => {
    const out = await Promise.all(Array.from({ length: 20 }, (_, i) => code(create({ gateway: 'khalti', idempotencyKey: `race-${i}` }))));
    expect(out.filter((c) => c === 'resolved')).toHaveLength(1);
    expect(out.filter((c) => c === 'payments.intent_open_exists')).toHaveLength(19);
    expect(rows().filter((r) => ['created', 'initiated', 'pending'].includes(r.status))).toHaveLength(1);
    expect(initiates()).toHaveLength(1);
  });

  it('ST-05: 50 concurrent creates with the same key -> one row, one initiated intent, 49 replays', async () => {
    const out = await Promise.all(Array.from({ length: 50 }, () => create({ gateway: 'khalti' })));
    expect(new Set(out.map((o) => o.intentId)).size).toBe(1);
    expect(out.filter((o) => o.replayed)).toHaveLength(49);
    expect(rows()).toHaveLength(1);
    expect(initiates()).toHaveLength(1);
  });

  it('a settled/failed intent frees the slot', async () => {
    const a = await create();
    await h.impl.cancelIntent(sys(at(30)), { intentId: a.intentId, reasonCode: 'customer_cancelled' });
    expect((await create({ idempotencyKey: 'k2' })).intentId).not.toBe(a.intentId);
  });
});

describe('AC-PG-01.4 / 01.5 nothing due', () => {
  it.each([0, -100])('balanceDue %i -> payments.nothing_due, no row, no job', async (due) => {
    await arrange({ amount: due });
    expect(await code(create())).toBe('payments.nothing_due');
    expect(rows()).toHaveLength(0); expect(h.jobs).toHaveLength(0);
  });
  it('cancelled order -> payments.nothing_due even with a positive balance', async () => {
    h.setOrder({ id: O1, tenantId: A, dueAmountPaisa: DUE, status: 'cancelled' });
    expect(await code(create())).toBe('payments.nothing_due');
    expect(rows()).toHaveLength(0);
  });
  it('unknown order -> common.not_found', async () => {
    expect(await code(create({ orderId: '01900000-0000-7000-8000-0000000c15ff' }))).toBe('common.not_found');
  });
});

describe('AC-PG-01.6 / 02.x gateway availability', () => {
  it.each(['esewa', 'khalti'] as const)('%s account disabled -> payments.gateway_not_available, no row', async (gw) => {
    h.disableAccount(gw);
    expect(await code(create({ gateway: gw }))).toBe('payments.gateway_not_available');
    expect(rows()).toHaveLength(0); expect(initiates()).toHaveLength(0);
  });
  it('account without a secret is not available even if flagged enabled', async () => {
    const acc = h.db.accounts(A).find((a) => a.gateway === 'esewa')!;
    Object.assign(acc, { secret_ciphertext: null, secret_nonce: null, secret_auth_tag: null, secret_kek_id: null, secret_fingerprint: null });
    expect(await code(create())).toBe('payments.gateway_not_available');
  });
  it('only the CALLING tenant\'s account counts', async () => {
    h.disableAccount('esewa', 'B');
    expect((await create()).intentId).toBeTruthy();
    expect(await code(create({}, sys(undefined, 'B:system')) as Promise<unknown>)).toBe('payments.gateway_not_available');
  });
  it('fonepay -> payments.gateway_not_available (B8), nothing stored', async () => {
    expect(await code(create({ gateway: 'fonepay' }))).toBe('payments.gateway_not_available');
    expect(rows()).toHaveLength(0);
  });
});

describe('AC-PG-01.7 / 02.2 amount rules', () => {
  it('eSewa fractional rupee (225050) with the flag off -> payments.amount_not_supported, no row', async () => {
    expect(h.config.esewaAllowFractionalRupees).toBe(false);
    await arrange({ amount: 225050 });
    expect(await code(create())).toBe('payments.amount_not_supported');
    expect(rows()).toHaveLength(0);
  });
  it.each([900, 999])('Khalti due %i paisa -> payments.amount_not_supported without any Khalti call, no row', async (due) => {
    await arrange({ amount: due });
    expect(await code(create({ gateway: 'khalti' }))).toBe('payments.amount_not_supported');
    expect(initiates()).toHaveLength(0); expect(rows()).toHaveLength(0);
  });
  it('Khalti due 1000 paisa is the smallest accepted amount', async () => {
    await arrange({ amount: 1000 });
    expect((await create({ gateway: 'khalti' })).amount).toEqual(npr(1000));
  });
});

describe('AC-PG-01.8 return URL allowlist', () => {
  it.each([
    ['off-allowlist host', { returnUrl: 'https://attacker.invalid/steal' }],
    ['off-allowlist cancelUrl', { cancelUrl: 'https://attacker.invalid/steal' }],
    ['http scheme', { returnUrl: 'http://app.lims.test/pay/done' }],
    ['userinfo', { returnUrl: 'https://app.lims.test@attacker.invalid/x' }],
    ['lookalike host', { returnUrl: 'https://app.lims.test.attacker.invalid/x' }],
    ['fragment', { returnUrl: 'https://app.lims.test/pay/done#x' }],
    ['over 2000 chars', { returnUrl: `https://app.lims.test/${'a'.repeat(2000)}` }],
    ['not a URL', { returnUrl: 'not a url' }],
    ['javascript scheme', { returnUrl: 'javascript:alert(1)' }],
  ])('%s -> payments.return_url_not_allowed, no row, no job', async (_n, diff) => {
    expect(await code(create(diff))).toBe('payments.return_url_not_allowed');
    expect(rows()).toHaveLength(0); expect(h.jobs).toHaveLength(0);
  });
});

describe('AC-PG-01.9 / ST-01 / REQ-SEC-046 no caller amount', () => {
  it.each([{ amount: { amountPaisa: 1, currency: 'NPR' } }, { amountPaisa: 1 }, { amount_paisa: 1 }, { unknownField: 'x' }])('input with %j -> common.validation_failed, no row', async (extra) => {
    expect(await code(create(extra))).toBe('common.validation_failed');
    expect(rows()).toHaveLength(0);
  });
  it('the amount is the balanceDue read at creation, whatever the order total was', async () => {
    await arrange({ amount: 31000 });
    expect((await create()).amount).toEqual(npr(31000));
  });
});

describe('AC-PG-01.10 idempotency key grammar (08 A19 P-40)', () => {
  it.each(['eng:01900000-0000-7000-8000-0000000c1501', 'a', 'A_b.c:d-e', 'x'.repeat(200)])('accepts %s', async (key) => {
    expect((await create({ idempotencyKey: key })).replayed).toBe(false);
  });
  it.each(['', 'has space', 'a/b', 'x'.repeat(201), 'ünï', 'a\nb', 123, null, undefined])('rejects %j with common.validation_failed, no row', async (key) => {
    expect(await code(create({ idempotencyKey: key }))).toBe('common.validation_failed');
    expect(rows()).toHaveLength(0);
  });
  it('rejects an unknown gateway and a non-uuid order id', async () => {
    expect(await code(create({ gateway: 'stripe' }))).toBe('common.validation_failed');
    expect(await code(create({ orderId: 'not-a-uuid' }))).toBe('common.validation_failed');
  });
});

describe('AC-PG-02.1 / 02.4 Khalti createIntent', () => {
  it('initiates server-side with the 5 documented inputs only, stores pidx/payment_url/expires_at, returns a redirect', async () => {
    h.db.put('payments.settings', { tenant_id: A, purchase_order_label: 'Acme Labs', created_by: A, updated_by: A });
    const r = await create({ gateway: 'khalti' });
    expect(h.gateway.initiateInputs).toHaveLength(1);
    const i = h.gateway.initiateInputs[0];
    expect(Object.keys(i).sort()).toEqual(['amountPaisa', 'callbackToken', 'intentId', 'purchaseOrderName', 'websiteUrl']);   // no patient / order / test data can ride along
    expect(i).toMatchObject({ intentId: r.intentId, amountPaisa: DUE, websiteUrl: KHALTI_WEBSITE, purchaseOrderName: 'Acme Labs' });
    expect(typeof i.callbackToken).toBe('string');
    expect(h.gateway.secretsSeen).toEqual([SECRET.khalti]);                                    // the right merchant account's secret was opened
    expect(r.action).toEqual({ kind: 'redirect', url: 'https://pay.khalti.test/1' });
    const x = row(r.intentId);
    expect(x).toMatchObject({ status: 'initiated', gateway: 'khalti', gateway_txn_ref: 'SYN-PIDX-1', gateway_payment_url: 'https://pay.khalti.test/1' });
    expect(r.expiresAt).toBe(at(3600));
    expect(new Date(x.expires_at).toISOString()).toBe(at(3600));
    expect(JSON.stringify(i)).not.toContain(SECRET.khalti);
  });
  it('uses the default label "Lab payment" when the tenant has no settings row', async () => {
    await create({ gateway: 'khalti' });
    expect(h.gateway.initiateInputs[0].purchaseOrderName).toBe('Lab payment');
  });
  it('the raw callback token handed to the adapter is not stored (sha256 only)', async () => {
    await create({ gateway: 'khalti' });
    expect(JSON.stringify(rows()) + h.db.sentText()).not.toContain(h.gateway.initiateInputs[0].callbackToken);
  });
});

describe('AC-PG-02.3 initiate failure rolls everything back', () => {
  it.each([true, 'generic'] as const)('initiate failure (%s) -> payments.gateway_not_available, no intent, no transition, no job, no event', async (mode) => {
    h.gateway.initiateFails = mode;
    expect(await code(create({ gateway: 'khalti' }))).toBe('payments.gateway_not_available');
    expect(rows()).toHaveLength(0); expect(h.db.transitions(A)).toHaveLength(0);
    expect(h.jobs).toHaveLength(0); expect(h.events.published).toHaveLength(0);
  });
  it('the order can be paid after the gateway recovers (the failed attempt did not burn the key or the open slot)', async () => {
    h.gateway.initiateFails = true;
    await code(create({ gateway: 'khalti' }));
    h.gateway.initiateFails = false;
    expect((await create({ gateway: 'khalti' })).replayed).toBe(false);
  });
});

describe('AC-PG-05.1 poll schedule (TRD §6.1 step 11, §8.3)', () => {
  it('enqueues payments.poll_intent at +120/300/600/1200/2400 s and a final check at expires_at + grace, unique keys poll:<intent>:<n>', async () => {
    const r = await create();
    const polls = h.jobs.filter((j) => j.task === 'payments.poll_intent');
    expect(polls).toHaveLength(h.config.pollScheduleSeconds.length + 1);
    expect(new Set(polls.map((j) => j.key)).size).toBe(polls.length);
    for (const j of polls) {
      expect(j.key).toMatch(new RegExp(`^poll:${r.intentId}:\\d+$`));
      expect(j.payload).toMatchObject({ tenant_id: A, intent_id: r.intentId });
    }
    const runAt = polls.map((j) => j.runAt!.toISOString()).sort();
    expect(runAt).toEqual([...h.config.pollScheduleSeconds.map((s) => at(s)), at(h.config.esewaIntentTtlMinutes * 60 + h.config.expiryGraceMinutes * 60)].sort());
    expect(h.config.pollScheduleSeconds).toEqual([120, 300, 600, 1200, 2400]);
  });
  it('Khalti: the final check is at the returned expires_at + grace', async () => {
    await create({ gateway: 'khalti' });
    const last = h.jobs.map((j) => j.runAt!.getTime()).sort((a, b) => a - b).at(-1);
    expect(last).toBe(Date.parse(at(3600)) + h.config.expiryGraceMinutes * 60_000);
  });
});

describe('AC-PG-05.2 final check closes an unpaid intent', () => {
  it('Khalti "Expired" after expires_at + grace -> expired (failure_reason set, closed_at set, no ledger, no event)', async () => {
    await h.seed({ orders: [{ id: O1, tenantId: A, dueAmountPaisa: DUE, gatewayStatus: 'Expired' }], returnUrlHosts: ['app.lims.test'],
      intents: [{ id: '01900000-0000-7000-8000-0000000c1504', tenantId: A, orderId: O1, gateway: 'khalti', status: 'pending', amountPaisa: DUE, refundedPaisa: 0,
        gatewayTxnRef: 'SYN-PIDX-9', idempotencyKey: 'seeded-1', expiresAt: '2026-11-05T04:00:00.000Z' }] });
    expect((await verify('01900000-0000-7000-8000-0000000c1504', '2026-11-05T06:00:00.000Z')).status).toBe('expired');
    const x = row('01900000-0000-7000-8000-0000000c1504');
    expect(x.status).toBe('expired'); expect(x.failure_reason).toBeTruthy(); expect(x.closed_at).toBeInstanceOf(Date);
    expect(h.ledger.calls).toHaveLength(0); expect(settledEvents()).toHaveLength(0);
    expect(h.db.transitions(A).at(-1)).toMatchObject({ from_status: 'pending', to_status: 'expired' });
  });
});

describe('verify (TRD §6.2)', () => {
  it('settles on COMPLETE with the exact amount: row, ledger call, event, transition', async () => {
    await arrange({ status: 'COMPLETE' });
    const r = await create();
    const v = await verify(r.intentId, at(60));
    expect(v).toMatchObject({ intentId: r.intentId, status: 'settled', gatewayStatusRaw: 'COMPLETE', verifiedAmount: npr(DUE) });
    const x = row(r.intentId);
    expect(x).toMatchObject({ status: 'settled', verification_method: 'esewa_status_check', last_gateway_status_raw: 'COMPLETE', gateway_secondary_ref: 'SYN-TXN-REF-1', check_count: 1 });
    expect(Number(x.verified_amount_paisa)).toBe(DUE);
    expect(x.settled_at.toISOString()).toBe(at(60)); expect(x.ledger_entry_id).toBeTruthy();
    expect(h.ledger.calls).toEqual([{ intentId: r.intentId, orderId: O1, gateway: 'esewa', gatewayTxnRef: r.intentId, amount: npr(DUE), verifiedAt: at(60) }]);
    expect(h.db.transitions(A).at(-1)).toMatchObject({ from_status: 'initiated', to_status: 'settled', actor_type: 'system' });
  });

  it('AC-PG-06.4 / 8.1: one event, key <gateway>:<gateway_txn_ref>:settled, aggregate payment_intent seq = version, snake_case payload with the ledger entry id', async () => {
    await arrange({ status: 'Completed' });
    const r = await create({ gateway: 'khalti' });
    await verify(r.intentId, at(60));
    const x = row(r.intentId);
    expect(x.gateway_txn_ref).toBe('SYN-PIDX-1');
    expect(settledEvents()).toHaveLength(1);
    expect(settledEvents()[0]).toMatchObject({ tenantId: A, idempotencyKey: 'khalti:SYN-PIDX-1:settled', aggregate: { type: 'payment_intent', id: r.intentId, seq: x.version },
      payload: { intent_id: r.intentId, order_id: O1, gateway: 'khalti', gateway_txn_ref: 'SYN-PIDX-1', amount: { amount_paisa: DUE, currency: 'NPR' },
        verification_method: 'khalti_lookup', ledger_entry_id: x.ledger_entry_id } });
    expect(typeof (settledEvents()[0]!.payload as any).verified_at).toBe('string');
    expect(JSON.stringify(settledEvents()[0])).not.toMatch(/callback|token|secret|payment_url/i);
  });

  it('AC-PG-06.4: eSewa gateway_txn_ref is the transaction_uuid = intent id', async () => {
    await arrange({ status: 'COMPLETE' });
    const r = await create(); await verify(r.intentId, at(60));
    expect(h.ledger.calls[0].gatewayTxnRef).toBe(r.intentId);
    expect(settledEvents()[0]!.idempotencyKey).toBe(`esewa:${r.intentId}:settled`);
  });

  it('AC-PG-06.2: ledger duplicate:true still settles once and the event carries the returned ledger_entry_id', async () => {
    await arrange({ status: 'COMPLETE' });
    const r = await create();
    const LEDGER = '01900000-0000-7000-8000-0000000c8abc';
    const BillingPort = { getOrderBalance: async (_c: any, i: any) => ({ orderId: i.orderId, balanceDue: npr(DUE), invoiced: npr(DUE), paid: npr(0), credited: npr(0), balanceVersion: 1, asOf: FIXED_NOW }),
      recordGatewayPayment: async () => ({ ledgerEntryId: LEDGER, duplicate: true, balance: {} }) };
    await verify(r.intentId, at(60), h.ctxFor('A:system', { now: () => at(60) as any, ports: { BillingPort } as any }));
    expect(row(r.intentId)).toMatchObject({ status: 'settled', ledger_entry_id: LEDGER });
    expect(settledEvents()).toHaveLength(1);
    expect((settledEvents()[0]!.payload as any).ledger_entry_id).toBe(LEDGER);
  });

  describe('AC-PG-06.1 atomicity: a failure after the status update leaves no status change, no ledger call, no event', () => {
    it('event publish throws -> error surfaces, intent still open, ledger spy and event spy empty', async () => {
      await arrange({ status: 'COMPLETE' });
      const r = await create();
      h.faults.events.error = Object.assign(new Error('event insert failed'), { code: 'common.internal' });
      expect(await code(verify(r.intentId, at(60)))).toBe('common.internal');
      expect(row(r.intentId).status).toBe('initiated'); expect(row(r.intentId).ledger_entry_id).toBeNull();
      expect(h.ledger.calls).toHaveLength(0); expect(settledEvents()).toHaveLength(0);
      expect(h.db.transitions(A).filter((t) => t.to_status === 'settled')).toHaveLength(0);
      h.faults.events = {};
      expect((await verify(r.intentId, at(120))).status).toBe('settled');                  // and the next attempt succeeds once
      expect(h.ledger.calls).toHaveLength(1); expect(settledEvents()).toHaveLength(1);
    });
    it('BillingPort throws billing.payment_exceeds_due -> the error reaches the caller, intent unchanged, no event', async () => {
      await arrange({ status: 'COMPLETE' });
      const r = await create();
      h.faults.ledger.error = Object.assign(new Error('x'), { code: 'billing.payment_exceeds_due' });
      expect(await code(verify(r.intentId, at(60)))).toBe('billing.payment_exceeds_due');
      expect(row(r.intentId).status).toBe('initiated');
      expect(settledEvents()).toHaveLength(0); expect(h.ledger.calls).toHaveLength(0);
    });
  });

  it('AC-PG-06.3: due fell below the intent amount -> held_for_review exceeds_due, no ledger write, no event', async () => {
    await arrange({ status: 'COMPLETE' });
    const r = await create();
    h.setOrder({ id: O1, tenantId: A, dueAmountPaisa: 100000, gatewayStatus: 'COMPLETE' });
    expect((await verify(r.intentId, at(60))).status).toBe('held_for_review');
    expect(row(r.intentId)).toMatchObject({ status: 'held_for_review', hold_reason: 'exceeds_due' });
    expect(h.ledger.calls).toHaveLength(0); expect(settledEvents()).toHaveLength(0);
  });

  describe('ST-03 / REQ-SEC-047 amount mismatch', () => {
    it.each([1, -1, -100, 225000])('gateway amount off by %i paisa -> held_for_review amount_mismatch, no ledger, no event, one critical log with ids only', async (delta) => {
      await arrange({ status: 'COMPLETE', amountPaisa: DUE + delta });
      const r = await create();
      expect((await verify(r.intentId, at(60))).status).toBe('held_for_review');
      expect(row(r.intentId).hold_reason).toBe('amount_mismatch');
      expect(h.ledger.calls).toHaveLength(0); expect(settledEvents()).toHaveLength(0);
      expect(h.alerts.filter((a) => a.event === 'payment_amount_mismatch')).toHaveLength(1);
      expect(h.alerts[0]!.fields).toMatchObject({ intentId: r.intentId });
      expect(JSON.stringify(h.alerts)).not.toMatch(/secret|token|https?:/i);
    });
  });

  it('REQ-SEC-047: only COMPLETE/Completed settle: PENDING / unknown strings never reach the ledger', async () => {
    for (const raw of ['PENDING', 'AMBIGUOUS', 'SOMETHING_NEW', 'complete', 'COMPLETE ']) {
      const hh = await makePortHarness();
      await hh.seed({ orders: [{ id: O1, tenantId: A, dueAmountPaisa: DUE, gatewayStatus: raw }], returnUrlHosts: ['app.lims.test'] });
      const r = await hh.impl.createIntent(hh.ctxFor('A:system'), { orderId: O1, gateway: 'esewa', idempotencyKey: 'k', ...URLS });
      const v = await hh.impl.verify(hh.ctxFor('A:system', { now: () => at(60) as any }), { intentId: r.intentId });
      expect(v.status, raw).not.toBe('settled');
      expect(hh.ledger.calls, raw).toHaveLength(0); expect(hh.events.ofType('payments.intent.settled.v1'), raw).toHaveLength(0);
    }
  });

  it('calls within VERIFY_MIN_INTERVAL of the last gateway check return the stored status with no gateway call; later calls check again', async () => {
    const r = await create();
    expect((await verify(r.intentId, at(60))).status).toBe('pending');
    expect(checks()).toHaveLength(1);
    await verify(r.intentId, at(60 + h.config.verifyMinIntervalSeconds - 1));
    expect(checks()).toHaveLength(1);
    await verify(r.intentId, at(60 + h.config.verifyMinIntervalSeconds + 1));
    expect(checks()).toHaveLength(2);
  });

  it('transient gateway answer (eSewa code 0) never throws and leaves the status unchanged', async () => {
    await arrange({ status: 'code:0' });
    const r = await create();
    expect(await verify(r.intentId, at(60))).toMatchObject({ intentId: r.intentId, status: 'initiated' });
    expect(row(r.intentId).status).toBe('initiated'); expect(h.ledger.calls).toHaveLength(0);
  });

  it('PENDING moves initiated -> pending (transition row) and the secret opened for the check is the tenant\'s eSewa secret', async () => {
    const r = await create();
    expect((await verify(r.intentId, at(60))).status).toBe('pending');
    expect(h.db.transitions(A).at(-1)).toMatchObject({ from_status: 'initiated', to_status: 'pending' });
    expect(h.gateway.secretsSeen).toEqual([SECRET.esewa]);
  });

  it('every verify writes check bookkeeping only (no state change) when the answer is "stay"', async () => {
    const r = await create();
    await verify(r.intentId, at(60)); await verify(r.intentId, at(200));
    const x = row(r.intentId);
    expect(x.check_count).toBe(2); expect(x.last_gateway_status_raw).toBe('PENDING'); expect(x.last_checked_at.toISOString()).toBe(at(200));
  });

  it('ST-06: 10 concurrent verifies on a paying intent -> one settle transition, one ledger call, one event, every caller sees settled', async () => {
    await arrange({ status: 'COMPLETE' });
    const r = await create();
    const out = await Promise.all(Array.from({ length: 10 }, (_, i) => verify(r.intentId, at(60 + i * 11))));
    expect(out.every((o) => o.status === 'settled')).toBe(true);
    expect(h.ledger.calls).toHaveLength(1); expect(settledEvents()).toHaveLength(1);
    expect(h.db.transitions(A).filter((t) => t.to_status === 'settled')).toHaveLength(1);
    expect(row(r.intentId).version).toBeGreaterThan(1);
  });

  it('verify after the merchant account was disabled -> payments.gateway_not_available, state unchanged', async () => {
    const r = await create();
    h.disableAccount('esewa');
    expect(await code(verify(r.intentId, at(60)))).toBe('payments.gateway_not_available');
    expect(row(r.intentId).status).toBe('initiated');
  });

  it('verify on an already settled intent is a no-op (no second ledger call, no second event)', async () => {
    await arrange({ status: 'COMPLETE' });
    const r = await create(); await verify(r.intentId, at(60));
    expect((await verify(r.intentId, at(600))).status).toBe('settled');
    expect(h.ledger.calls).toHaveLength(1); expect(settledEvents()).toHaveLength(1);
  });

  it('every gateway answer is logged (payments.gateway_calls) without secrets', async () => {
    const r = await create({ gateway: 'khalti' });
    await verify(r.intentId, at(60));
    const g = h.db.gatewayCalls(A);
    expect(g.length).toBeGreaterThanOrEqual(1);
    expect(g.some((c) => c.intent_id === r.intentId && c.operation === 'khalti_lookup')).toBe(true);
    expect(JSON.stringify(g)).not.toContain(SECRET.khalti);
  });
});

describe('getIntent (CR-C15-001): read-only, no gateway call', () => {
  it('returns the stored fields; action only while open; refundedAmount 0', async () => {
    const r = await create();
    const before = h.db.stmts.length, calls = h.gateway.calls.length;
    const g = await h.impl.getIntent(sys(), { intentId: r.intentId });
    expect(g).toMatchObject({ intentId: r.intentId, orderId: O1, gateway: 'esewa', status: 'initiated', amount: npr(DUE), refundedAmount: npr(0), expiresAt: r.expiresAt });
    expect(g.action.kind).toBe('form_post');
    expect(g.settledAt).toBeUndefined();
    expect(h.db.stmts.slice(before).every((s) => /^\s*select/i.test(s.text))).toBe(true);   // no write at all
    expect(h.gateway.calls.length).toBe(calls);
  });
  it('settled: status, settledAt, no action', async () => {
    await arrange({ status: 'COMPLETE' });
    const r = await create(); await verify(r.intentId, at(60));
    const g = await h.impl.getIntent(sys(), { intentId: r.intentId });
    expect(g).toMatchObject({ status: 'settled', settledAt: at(60) });
    expect(g.action).toBeUndefined();
  });
  it('unknown id -> common.not_found; malformed id -> common.validation_failed', async () => {
    expect(await code(h.impl.getIntent(sys(), { intentId: '01900000-0000-7000-8000-0000000c15ee' }))).toBe('common.not_found');
    expect(await code(h.impl.getIntent(sys(), { intentId: 'nope' }))).toBe('common.validation_failed');
  });
  it('Khalti: the action is the stored redirect', async () => {
    const r = await create({ gateway: 'khalti' });
    expect((await h.impl.getIntent(sys(), { intentId: r.intentId })).action).toEqual({ kind: 'redirect', url: 'https://pay.khalti.test/1' });
  });
});

describe('AC-PG-13.1 / 13.2 cancelIntent (TRD §6.4)', () => {
  it('open, unpaid at the gateway: looks up first, then failed(abandoned) with the caller reason; final-check job stays queued; slot freed', async () => {
    const r = await create({ gateway: 'khalti' });
    const jobsBefore = h.jobs.length;
    const c = await h.impl.cancelIntent(sys(at(30)), { intentId: r.intentId, reasonCode: 'customer_cancelled' });
    expect(c).toEqual({ intentId: r.intentId, status: 'failed' });
    expect(checks().length).toBeGreaterThanOrEqual(1);                                        // verified before cancelling
    expect(row(r.intentId)).toMatchObject({ status: 'failed', failure_reason: 'abandoned' });
    expect(h.db.transitions(A).at(-1)).toMatchObject({ to_status: 'failed', cause: 'cancel', reason_code: 'customer_cancelled', actor_type: 'system' });
    expect(h.jobs).toHaveLength(jobsBefore);                                                  // Khalti link stays payable: deadline check not cancelled
    expect(h.ledger.calls).toHaveLength(0);
    expect((await create({ gateway: 'khalti', idempotencyKey: 'k2' }, sys(at(40)))).replayed).toBe(false);   // AC-PG-13.2
  });
  it('the gateway reports it paid -> settles instead (ledger once, event once)', async () => {
    await arrange({ status: 'Completed' });
    const r = await create({ gateway: 'khalti' });
    expect(await h.impl.cancelIntent(sys(at(30)), { intentId: r.intentId, reasonCode: 'customer_cancelled' })).toEqual({ intentId: r.intentId, status: 'settled' });
    expect(h.ledger.calls).toHaveLength(1); expect(settledEvents()).toHaveLength(1);
  });
  it('cancel ignores the verify min interval (always checks the gateway)', async () => {
    const r = await create();
    await verify(r.intentId, at(60));
    const n = checks().length;
    await h.impl.cancelIntent(sys(at(61)), { intentId: r.intentId, reasonCode: 'customer_cancelled' });
    expect(checks().length).toBe(n + 1);
  });
  it.each(['settled', 'failed', 'expired', 'held_for_review'])('a %s intent -> payments.intent_invalid_transition, unchanged', async (status) => {
    await h.seed({ orders: [{ id: O1, tenantId: A, dueAmountPaisa: DUE, gatewayStatus: 'PENDING' }], returnUrlHosts: ['app.lims.test'],
      intents: [{ id: '01900000-0000-7000-8000-0000000c1504', tenantId: A, orderId: O1, gateway: 'esewa', status, amountPaisa: DUE, refundedPaisa: 0, idempotencyKey: 's1', expiresAt: at(1800) }] });
    expect(await code(h.impl.cancelIntent(sys(at(30)), { intentId: '01900000-0000-7000-8000-0000000c1504', reasonCode: 'customer_cancelled' }))).toBe('payments.intent_invalid_transition');
    expect(row('01900000-0000-7000-8000-0000000c1504').status).toBe(status);
  });
  it('a payment that lands after the cancel is held for review, never settled silently (I13)', async () => {
    const r = await create({ gateway: 'khalti' });
    await h.impl.cancelIntent(sys(at(30)), { intentId: r.intentId, reasonCode: 'customer_cancelled' });
    h.setOrder({ id: O1, tenantId: A, dueAmountPaisa: DUE, gatewayStatus: 'Completed' });
    expect((await verify(r.intentId, at(300))).status).toBe('held_for_review');
    expect(row(r.intentId).hold_reason).toBe('late_payment_found');
    expect(h.ledger.calls).toHaveLength(0); expect(settledEvents()).toHaveLength(0);
  });
  it('missing / empty reasonCode -> common.validation_failed, intent untouched', async () => {
    const r = await create();
    for (const reasonCode of [undefined, '', 5]) expect(await code(h.impl.cancelIntent(sys(at(30)), { intentId: r.intentId, reasonCode }))).toBe('common.validation_failed');
    expect(row(r.intentId).status).toBe('initiated');
  });
});

describe('tenant isolation and actor guard', () => {
  it('another tenant cannot read, verify or cancel an intent -> common.not_found, no gateway call, no change', async () => {
    const r = await create();
    const calls = h.gateway.calls.length;
    const b = (now?: string) => sys(now, 'B:system');
    expect(await code(h.impl.getIntent(b(), { intentId: r.intentId }))).toBe('common.not_found');
    expect(await code(verify(r.intentId, at(60), b(at(60))))).toBe('common.not_found');
    expect(await code(h.impl.cancelIntent(b(at(60)), { intentId: r.intentId, reasonCode: 'customer_cancelled' }))).toBe('common.not_found');
    expect(h.gateway.calls.length).toBe(calls);
    expect(row(r.intentId).status).toBe('initiated');
  });
  it.each(['patient', 'portal', 'device'])('actor type %s -> auth.forbidden on every method, nothing written', async (type) => {
    const r = await create();
    const ctx = h.ctxFor(`A:${type}`, { now: () => at(60) as any });
    const stmts = h.db.stmts.length;
    for (const [m, input] of [['createIntent', { orderId: O1, gateway: 'esewa', idempotencyKey: 'z', ...URLS }], ['verify', { intentId: r.intentId }], ['getIntent', { intentId: r.intentId }],
      ['cancelIntent', { intentId: r.intentId, reasonCode: 'customer_cancelled' }]] as const) {
      expect(await code((h.impl as any)[m](ctx, input)), m).toBe('auth.forbidden');
    }
    expect(h.db.stmts.length).toBe(stmts);
  });
  it.each(['A:user', 'A:system'])('actor %s is accepted', async (key) => {
    expect((await create({}, sys(undefined, key))).intentId).toBeTruthy();
  });
});
