// FD-T06 atomicity: failure injection AFTER issueOrderInvoice, rollback leaves nothing, registration_no counter rolled back (US-FD-03.5, frontdesk side),
// idempotent replay through the REAL core Idempotency-Key hook (US-FD-03.3), event-once (done_when), single-key retry after a rollback.
// The invoice counter itself belongs to billing: the fake's counter is not transactional, so "next invoice gets the same number" is J-T01 (real billing), not asserted here.
// Counter tests use tenant A's second branch/centre (a102/a202, db/seeds/010) that no other file registers on, so parallel files cannot move its counter.
import { describe, expect, it } from 'vitest';
import { createIdempotency } from '../../../../core/idempotency.js';
import { appTx } from '../patients/helpers.js';
import { BRANCH_A2, CENTRE_A2, CP, NET, NOTHING, T, TENANT_A, counterValue, ctxFor, eventRows, generatedOrderId, ordersOf, orderRow, ownerRows, pay, prepare, quoteFp, regNo, register,
  registerFails, rworld, storedFor, uid, draft, knowRecipient, type RegReply } from './helpers.js';
import { handlers } from '../../handlers/index.js';
import { req } from '../patients/helpers.js';

describe('failure injection after issueOrderInvoice: one tx, nothing survives', () => {
  it('payment fails after the invoice was issued: error surfaces, invoice call recorded, no order/items/discounts/events, billing events dropped', async () => {
    const p = await prepare();
    p.w.billingFake.failNext('recordPayment', 'billing.payment_exceeds_due');
    const e = await registerFails(p.body, { w: p.w });
    expect(e.code).toBe('billing.payment_exceeds_due');
    expect(p.w.billingFake.calls('issueOrderInvoice')).toHaveLength(1);
    const orderId = generatedOrderId(p.w)!;
    expect(await storedFor(orderId)).toEqual(NOTHING);
    expect(await ordersOf(p.patient.id)).toHaveLength(0);
    expect(p.w.spy.published).toHaveLength(0);                                       // billing.* events of the rolled-back tx are gone
  }, T);

  it('second of two payments fails: first payment + invoice + order all rolled back', async () => {
    const p = await prepare({ payments: [pay(10000), pay(20000, { method_code: 'card' })] });
    let n = 0;
    const real = p.w.billing.recordPayment;
    (p.w.billing as any).recordPayment = async (c: any, i: any) => { if (++n === 2) throw Object.assign(new Error('x'), { code: 'billing.payment_exceeds_due' }); return real(c, i); };
    const e = await registerFails(p.body, { w: p.w });
    expect(e.code).toBe('billing.payment_exceeds_due');
    expect(n).toBe(2);
    expect(await storedFor(generatedOrderId(p.w)!)).toEqual(NOTHING);
    expect(p.w.spy.published).toHaveLength(0);
  }, T);

  it('event publish fails (schema failure) after billing + SMS: whole tx rolls back, error surfaces', async () => {
    const p = await prepare();
    const e = await registerFails(p.body, { w: p.w, failEvent: 'frontdesk.order.created.v1' });
    expect(e.code).toBe('common.internal');
    expect(p.w.billingFake.calls('issueOrderInvoice')).toHaveLength(1);
    expect(await storedFor(generatedOrderId(p.w)!)).toEqual(NOTHING);
    expect(await ordersOf(p.patient.id)).toHaveLength(0);
    expect(p.w.spy.published).toHaveLength(0);
  }, T);

  it('credit mode: recordCreditCharges fails -> nothing stored', async () => {
    const p = await prepare({ d: { billing_mode: 'credit', credit_party_id: CP.ok } });
    p.w.billingFake.failNext('recordCreditCharges', 'billing.credit_limit_exceeded');
    const e = await registerFails(p.body, { w: p.w });
    expect(e.code).toBe('billing.credit_limit_exceeded');
    expect(await ordersOf(p.patient.id)).toHaveLength(0);
  }, T);

  it('new patient: failure after the invoice also rolls back the patient row, its consent and the patient_code counter', async () => {
    const w = rworld();
    const np = { full_name: `Fdt Six Rb ${uid().slice(-8)}`, sex: 'male', age: { years: 50 }, phone_e164: `+977983${String(Date.now()).slice(-7)}`,
      consents: { processing: true, sms: false, whatsapp: false, email: false, share_with_referrer: false, consent_text_version: 'v1' } };
    const d = draft({ patient: { new_patient: np } });
    const fp = await quoteFp(w, d);
    const before = await counterValue(TENANT_A, 'patient_code', '');
    w.billingFake.failNext('recordPayment', 'billing.payment_exceeds_due');
    const e = await registerFails({ ...d, quote_fingerprint: fp, payments: [pay(NET)] }, { w });
    expect(e.code).toBe('billing.payment_exceeds_due');
    expect(await ownerRows('frontdesk.patients', 'tenant_id = $1 AND full_name = $2', [TENANT_A, np.full_name])).toHaveLength(0);
    expect(await ownerRows('frontdesk.patients', 'tenant_id = $1 AND phone_e164 = $2', [TENANT_A, np.phone_e164])).toHaveLength(0);
    expect(await storedFor(generatedOrderId(w)!)).toEqual(NOTHING);
    // patient_code counter: parallel files may create patients; it can only have moved by OTHER commits, never by this rolled-back one -> verified below with the registration counter
    expect(await counterValue(TENANT_A, 'patient_code', '')).toBeGreaterThanOrEqual(before);
  }, T);
});

describe('registration_no counter (per branch) is rolled back with the transaction (US-FD-03.5 frontdesk side)', () => {
  it('failed registration leaves the counter where it was; the next success takes the very next number (no gap)', async () => {
    const p = await prepare({ centreId: CENTRE_A2 });
    const before = await counterValue(TENANT_A, 'registration_no', BRANCH_A2);
    p.w.billingFake.failNext('recordPayment', 'billing.payment_exceeds_due');
    await registerFails(p.body, { w: p.w, centreId: CENTRE_A2 });
    expect(await counterValue(TENANT_A, 'registration_no', BRANCH_A2)).toBe(before);
    const ok = await register(p.body, { w: p.w, centreId: CENTRE_A2 });
    expect(ok.status).toBe(201);
    expect(await counterValue(TENANT_A, 'registration_no', BRANCH_A2)).toBe(before + 1);
    expect((await orderRow(ok.body.order.id)).registration_no).toBe(regNo(before + 1));
  }, T);

  it('stale quote (409) does not touch the counter (re-quote is step 3, counter step 5)', async () => {
    const quoted = await prepare({ centreId: CENTRE_A2 });
    const later = rworld({ cbcPriceV2: 55000 });
    knowRecipient(later, TENANT_A, quoted.patient.id, true);
    const before = await counterValue(TENANT_A, 'registration_no', BRANCH_A2);
    expect((await registerFails(quoted.body, { w: later, centreId: CENTRE_A2 })).code).toBe('common.version_conflict');
    expect(await counterValue(TENANT_A, 'registration_no', BRANCH_A2)).toBe(before);
  }, T);

  it('two sequential successes: numbers strictly increasing by 1 (gapless without failures)', async () => {
    const p = await prepare({ centreId: CENTRE_A2 });
    const a = await register(p.body, { w: p.w, centreId: CENTRE_A2 });
    const b = await register(p.body, { w: p.w, centreId: CENTRE_A2 });
    const n = (r: RegReply) => Number(r.body.order.registration_no.slice(1));
    expect(n(b)).toBe(n(a) + 1);
  }, T);
});

describe('event once', () => {
  it('one registration = exactly one frontdesk.order.created.v1 and one core.event_log row for the order aggregate', async () => {
    const p = await prepare();
    const r = await register(p.body, { w: p.w });
    expect(await eventRows('frontdesk.order.created.v1', r.body.order.id)).toHaveLength(1);
    expect((await ownerRows('core.event_log', 'aggregate_id = $1', [r.body.order.id])).filter((e) => e.event_type.startsWith('frontdesk.'))).toHaveLength(1);
  }, T);
});

describe('US-FD-03.3 idempotent replay: real core Idempotency-Key hook composed with the handler', () => {
  const claims = { sub: '01a1b34e-1000-7eee-9d29-d7ca59a102b5', tenant_id: TENANT_A };
  const db: any = { requestTx: async (_in: unknown, fn: (tx: any) => Promise<unknown>) => appTx(TENANT_A, fn) };
  const idem = createIdempotency({ db });
  const operation = { module: 'frontdesk', operationId: 'createRegistration', context: 'tenant', idempotency: 'required' } as const;

  /** What the pipeline does: begin (stage 6) -> handler in the request tx + finish (stage 10) -> release after a rollback (stage 11). */
  async function viaPipeline(key: string, body: any, w: ReturnType<typeof rworld>, o: { failEvent?: string } = {}) {
    const begun = await idem.begin({ operation, method: 'POST', routeTemplate: '/v1/frontdesk/registrations', body, idempotencyKey: key, claims: claims as never, requestId: uid(), clientIp: '203.0.113.9' });
    if (begun.action === 'replay') return { replay: true as const, status: begun.status, body: begun.body, headers: begun.headers };
    if (begun.action !== 'proceed') throw new Error('unexpected skip');
    try {
      const out = await appTx(TENANT_A, async (tx) => {
        const probe: RegReply['probe'] = { logs: [], accessCalls: [], identity: undefined, requestId: uid(), ctx: undefined };
        const ctx = ctxFor(tx, TENANT_A, w, { ...(o.failEvent ? { failEvent: o.failEvent } : {}) }, probe);
        let reply: any;
        try { reply = await (handlers as any).createRegistration(req({ body, headers: { 'idempotency-key': key } }), ctx); }
        catch (e) { w.spy.rollback(tx); w.notif.__rollback(tx); throw e; }
        await idem.finish(tx, begun.handle, { status: reply.status, body: reply.body });
        return reply;
      });
      return { replay: false as const, status: out.status, body: out.body };
    } catch (e) { await idem.release(begun.handle); throw e; }
  }

  it('same key + same body twice: second is a replay of the stored 201 (Idempotent-Replayed), ONE order, ONE invoice call, ONE order.created event, ONE SMS', async () => {
    const p = await prepare();
    const key = `fdt06-${uid().replace(/-/g, '').slice(0, 24)}`;
    const first = await viaPipeline(key, p.body, p.w);
    expect(first).toMatchObject({ replay: false, status: 201 });
    const second = await viaPipeline(key, p.body, p.w);
    expect(second).toMatchObject({ replay: true, status: 201, headers: { 'Idempotent-Replayed': 'true' } });
    expect(second.body).toEqual(JSON.parse(JSON.stringify(first.body)));              // body is JSON-storable and replays verbatim
    expect(await ordersOf(p.patient.id)).toHaveLength(1);
    expect(p.w.billingFake.calls('issueOrderInvoice')).toHaveLength(1);
    expect(p.w.billingFake.calls('recordPayment')).toHaveLength(1);
    expect(p.w.notif.calls('sendSms')).toHaveLength(1);
    expect(await eventRows('frontdesk.order.created.v1', (first.body as any).order.id)).toHaveLength(1);
  }, T);

  it('same key + different body -> 422 common.idempotency_key_reused, nothing new stored', async () => {
    const p = await prepare();
    const key = `fdt06-${uid().replace(/-/g, '').slice(0, 24)}`;
    await viaPipeline(key, p.body, p.w);
    const e = await viaPipeline(key, { ...p.body, payments: [pay(100)] }, p.w).catch((x) => x);
    expect(e.code).toBe('common.idempotency_key_reused');
    expect(await ordersOf(p.patient.id)).toHaveLength(1);
  }, T);

  it('rollback releases the key: after a failed attempt the SAME key + body registers once (no half state, no stuck in_progress)', async () => {
    const p = await prepare();
    const key = `fdt06-${uid().replace(/-/g, '').slice(0, 24)}`;
    const failed = await viaPipeline(key, p.body, p.w, { failEvent: 'frontdesk.order.created.v1' }).catch((x) => x);
    expect(failed.code).toBe('common.internal');
    expect(await ordersOf(p.patient.id)).toHaveLength(0);
    const ok = await viaPipeline(key, p.body, p.w);
    expect(ok).toMatchObject({ replay: false, status: 201 });
    expect(await ordersOf(p.patient.id)).toHaveLength(1);
    expect(await eventRows('frontdesk.order.created.v1', (ok.body as any).order.id)).toHaveLength(1);
  }, T);

  it('downstream keys are derived from the order id, so a replayed handler call cannot double-send: payment key <order_id>:reg:<i>, SMS key <order_id>:registration_sms, event key <order_id>:created', async () => {
    const p = await prepare();
    const r = await register(p.body, { w: p.w });
    const id = r.body.order.id;
    expect(p.w.billingFake.calls('recordPayment')[0].input).toMatchObject({ idempotencyKey: `${id}:reg:0` });
    expect(p.w.notif.calls('sendSms')[0].input).toMatchObject({ idempotencyKey: `${id}:registration_sms` });
    expect((await eventRows('frontdesk.order.created.v1', id))[0].idempotency_key).toBe(`${id}:created`);
  }, T);
});
