// FD-T06 Registration F9 createRegistration: US-FD-03.1-7, 04.1-4, 05.1-2, 08.1 (+ 08.3 overpay), 14.1; 02-TRD §5.1 F9 / §8.1 / §7; 03-APP-FLOW §2.3; 07-SECURITY F9 row (re-quote + fingerprint,
// second assert billing.invoice.issue). Ports = real fakes; DB = real PG17 under RLS. Rollback / idempotency / failure injection: rollback.test.ts. LD-25 downtime: downtime.test.ts.
// Fails now: createRegistration is a stub (common.service_unavailable).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schemaErrors } from '../patients/helpers.js';
import { REFERRER } from '../quote/helpers.js';
import { BRANCH, CENTRE, CP, INVOICE_PERM, LAB_NAME, NET, NOTHING, NOW, O, PERM, T, TENANT_A, TENANT_B, discountRows, draft, eventRows, generatedOrderId, itemRows, ordersOf, orderRow,
  pay, prepare, quoteFp, register, registerFails, rworld, seedLimits, storedFor, superTx, uid, knowRecipient, ownerRows, seedPatient } from './helpers.js';

beforeAll(seedLimits, T);
const money = (n: number) => ({ amount_paisa: n, currency: 'NPR' });

describe('US-FD-03.1 cash walk-in: one transaction creates order, items, invoice, payment, events', () => {
  it('201; order registered with snapshots; invoice via the port (purpose registration, quote fingerprint, last); payment with key <order_id>:reg:0, no receipt number', async () => {
    const p = await prepare();
    const r = await register(p.body, { w: p.w });
    expect(r.status).toBe(201);
    const orderId = r.body.order.id as string;
    const o = await orderRow(orderId);
    expect(o).toMatchObject({ tenant_id: TENANT_A, status: 'registered', billing_mode: 'cash', visit_type: 'opd', patient_id: p.patient.id, centre_id: CENTRE.a, branch_id: BRANCH.a,
      source: 'front_desk', is_first_order_of_patient: true, items_version: 1, catalog_revision: 1, age_years: 43 });
    expect(new Date(o.registered_at).toISOString()).toBe(NOW.toISOString());
    expect(o.registration_no).toMatch(/^A-B1R\d{6}$/);                               // numbering.registrationNoPattern '{branch}R{seq:6}' (REG_PATTERN), branch A-B1
    expect(o.credit_party_id).toBeNull();
    expect(r.body.order.registration_no).toBe(o.registration_no);

    const items = await itemRows(orderId);
    expect(items).toHaveLength(2);
    const cbc = items.find((i) => i.code === 'CBC')!, glu = items.find((i) => i.orderable_id === O.glu)!;
    expect(cbc).toMatchObject({ orderable_id: O.cbc, orderable_kind: 'test', status: 'active', priority: 'routine', unit_price_paisa: '50000', price_source: 'tenant_default', price_list_version: 1, vat_treatment: 'exempt', centre_id: CENTRE.a });
    expect(glu).toMatchObject({ unit_price_paisa: '20000', vat_treatment: 'taxable' });
    expect(cbc.test_ids.length).toBeGreaterThan(0);
    expect(cbc.urgent_surcharge_paisa).toBeNull();

    const inv = p.w.billingFake.calls('issueOrderInvoice');
    expect(inv).toHaveLength(1);
    expect((inv[0].input as any)).toMatchObject({ orderId, patientId: p.patient.id, branchId: BRANCH.a, centreId: CENTRE.a, purpose: 'registration', expectedFingerprint: p.fp, discounts: [] });
    expect((inv[0].input as any).buyer.name).toBe(p.patient.full_name);
    expect((inv[0].input as any).lines.map((l: any) => l.orderableId).sort()).toEqual([O.cbc, O.glu].sort());
    const pays = p.w.billingFake.calls('recordPayment');
    expect(pays).toHaveLength(1);
    expect(pays[0].input).toMatchObject({ orderId, captureKind: 'manual', methodCode: 'cash', idempotencyKey: `${orderId}:reg:0` });
    expect((pays[0].input as any).amount.amountPaisa).toBe(NET);
    expect((pays[0].input as any).issueReceiptNo).toBeFalsy();                        // 03-APP-FLOW §2.3 step 6: the invoice is the receipt
    expect(p.w.billingFake.calls('issueOrderInvoice')[0]).toBeDefined();
    expect(generatedOrderId(p.w)).toBe(orderId);
  }, T);

  it('result: invoice, one ledger entry, balance 0, print ids, notifications + label_print blocks', async () => {
    const p = await prepare();
    const r = await register(p.body, { w: p.w });
    expect(r.body.invoice).toBeTruthy();
    expect(r.body.ledger_entries).toHaveLength(1);
    expect(r.body.balance).toMatchObject({ order_id: r.body.order.id, invoiced: money(NET), paid: money(NET), balance_due: money(0) });
    expect(r.body.print.invoice_id).toBe(r.body.invoice.id);
    expect(Array.isArray(r.body.print.receipt_ledger_entry_ids)).toBe(true);
    expect(r.body.label_print).toEqual({ autoprint: true });                          // frontdesk.settings.label_autoprint default true
    expect(schemaErrors('OrderBalanceDto', r.body.balance)).toEqual([]);
    expect(r.body).not.toHaveProperty('credit_charges');
  }, T);

  it('frontdesk.order.created.v1: stored ONCE in core.event_log, key <order_id>:created, aggregate order seq = orders.version, producer frontdesk, payload per IC §3.1 (no PHI)', async () => {
    const p = await prepare();
    const r = await register(p.body, { w: p.w });
    const orderId = r.body.order.id as string;
    const rows = await eventRows('frontdesk.order.created.v1', orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0].idempotency_key).toBe(`${orderId}:created`);
    expect(rows[0].producer).toBe('frontdesk');
    expect(Number(rows[0].aggregate_seq)).toBe((await orderRow(orderId)).version);
    const e = rows[0].envelope;
    expect(e.aggregate).toMatchObject({ type: 'order', id: orderId });
    expect(e.payload).toMatchObject({ order_id: orderId, patient_id: p.patient.id, branch_id: BRANCH.a, centre_id: CENTRE.a, visit_type: 'opd', billing_mode: 'cash', collection_mode: 'walk_in', source: 'front_desk' });
    expect(new Date(e.payload.registered_at).toISOString()).toBe(NOW.toISOString());
    expect(e.payload.items).toHaveLength(2);
    const items = await itemRows(orderId);
    expect(e.payload.items.map((i: any) => i.order_item_id).sort()).toEqual(items.map((i) => i.id).sort());
    for (const it of e.payload.items) expect(Object.keys(it).sort()).toEqual(expect.arrayContaining(['order_item_id', 'orderable_id', 'orderable_kind', 'priority', 'test_ids']));
    const text = JSON.stringify(e.payload);
    for (const phi of [p.patient.full_name, p.patient.phone_e164, p.patient.patient_code, r.body.order.registration_no, 'Complete Blood Count']) expect(text).not.toContain(phi);   // 02-TRD §8.1: no names/phones/registration no
  }, T);

  it('billing events once each: invoice.issued x1, balance.changed x(1 + payments) with strictly increasing balance_version', async () => {
    const p = await prepare({ payments: [pay(40000), pay(NET - 40000, { method_code: 'card' })] });
    const r = await register(p.body, { w: p.w });
    const orderId = r.body.order.id as string;
    const issued = p.w.spy.ofType('billing.invoice.issued.v1').filter((e) => (e.payload as any).order_id === orderId);
    expect(issued).toHaveLength(1);
    const bal = p.w.spy.ofType('billing.balance.changed.v1').filter((e) => (e.payload as any).order_id === orderId).map((e) => (e.payload as any).balance_version as number);
    expect(bal).toHaveLength(3);
    expect(bal).toEqual([...bal].sort((a, b) => a - b));
    expect(new Set(bal).size).toBe(3);
    expect(p.w.billingFake.calls('recordPayment').map((c: any) => c.input.idempotencyKey)).toEqual([`${orderId}:reg:0`, `${orderId}:reg:1`]);
    expect(r.body.ledger_entries).toHaveLength(2);
  }, T);

  it('existing patient is loaded, not duplicated; patient.last_visit_at is not required here but the order links the existing id', async () => {
    const p = await prepare();
    const before = (await ownerRows('frontdesk.patients', 'id = $1', [p.patient.id])).length;
    await register(p.body, { w: p.w });
    expect(before).toBe(1);
    expect(await ordersOf(p.patient.id)).toHaveLength(1);
    expect((await ownerRows('frontdesk.patients', 'tenant_id = $1 AND full_name = $2', [TENANT_A, p.patient.full_name]))).toHaveLength(1);
  }, T);

  it('is_first_order_of_patient is false when the patient already has an order', async () => {
    const p = await prepare();
    const first = await register(p.body, { w: p.w });
    const second = await register(p.body, { w: p.w });                               // no Idempotency hook here: a second, distinct order
    expect(first.status).toBe(201);
    expect((await orderRow(first.body.order.id)).is_first_order_of_patient).toBe(true);
    expect((await orderRow(second.body.order.id)).is_first_order_of_patient).toBe(false);
  }, T);
});

describe('new patient inside the registration (US-FD-03.1 "or new")', () => {
  it('creates patient + consent + order atomically; patient_code allocated; patient_id on the order; consent processing=false -> 422 frontdesk.consent_required and nothing stored', async () => {
    const w = rworld();
    const np = { full_name: `Fdt Six ${uid().slice(-8)}`, sex: 'female', age: { years: 30 }, phone_e164: `+977981${String(Date.now()).slice(-7)}`,
      consents: { processing: true, sms: false, whatsapp: false, email: false, share_with_referrer: false, consent_text_version: 'v1' } };
    const d = draft({ patient: { new_patient: np } });
    const fp = await quoteFp(w, d);
    const r = await register({ ...d, quote_fingerprint: fp, payments: [pay(NET)] }, { w });
    expect(r.status).toBe(201);
    const pid = (await orderRow(r.body.order.id)).patient_id;
    const rows = await ownerRows('frontdesk.patients', 'id = $1', [pid]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ full_name: np.full_name, source: 'front_desk', registered_centre_id: CENTRE.a });
    expect(rows[0].patient_code).toMatch(/^MP\d{8}$/);
    expect(await ownerRows('frontdesk.patient_consents', 'patient_id = $1', [pid])).toHaveLength(1);

    const w2 = rworld();
    const bad = { ...np, full_name: `Fdt Six ${uid().slice(-8)}`, phone_e164: `+977982${String(Date.now()).slice(-7)}`, consents: { ...np.consents, processing: false } };
    const d2 = draft({ patient: { new_patient: bad } });
    const e = await registerFails({ ...d2, quote_fingerprint: await quoteFp(w2, d2), payments: [pay(NET)] }, { w: w2 });
    expect(e.code).toBe('frontdesk.consent_required');
    expect(e.statusCode).toBe(422);
    expect(await ownerRows('frontdesk.patients', 'tenant_id = $1 AND full_name = $2', [TENANT_A, bad.full_name])).toHaveLength(0);
    expect(w2.billingFake.calls('issueOrderInvoice')).toHaveLength(0);
  }, T);
});

describe('US-FD-03.4 stale quote -> 409 common.version_conflict, nothing stored, no invoice number consumed', () => {
  it('price list changed between quote and submit', async () => {
    const quoted = await prepare();                                                   // fingerprint from the OLD price list
    const later = rworld({ cbcPriceV2: 55000 });                                      // submit against a world whose CBC price moved
    knowRecipient(later, TENANT_A, quoted.patient.id, true);
    const e = await registerFails(quoted.body, { w: later });
    expect(e.code).toBe('common.version_conflict');
    expect(e.statusCode).toBe(409);
    expect(e.detail).toBe('Prices changed');
    expect(later.billingFake.calls('issueOrderInvoice')).toHaveLength(0);             // counter never touched: re-quote is step 3, invoice is step 6
    expect(later.billingFake.calls('recordPayment')).toHaveLength(0);
    expect(await ordersOf(quoted.patient.id)).toHaveLength(0);
    expect(later.spy.published).toHaveLength(0);
  }, T);

  it('tampered fingerprint, or a discount added after quoting, is stale too (fingerprint covers lines + discounts + totals)', async () => {
    const a = await prepare({ fp: 'a'.repeat(64) });
    expect((await registerFails(a.body, { w: a.w })).code).toBe('common.version_conflict');
    const b = await prepare();
    const withDiscount = { ...b.body, discounts: [{ scope: 'bill', reason_code: 'staff_family', kind: 'percent', percent_bp: 500 }] };
    expect((await registerFails(withDiscount, { w: b.w })).code).toBe('common.version_conflict');
    expect(await ordersOf(b.patient.id)).toHaveLength(0);
    expect(await ordersOf(a.patient.id)).toHaveLength(0);
  }, T);
});

describe('US-FD-03.7 referrer + settings', () => {
  it('a valid referrer is stored on the order and on the event; SELF = NULL / absent', async () => {
    const p = await prepare({ d: { referrer_id: ID_REF() } });
    const r = await register(p.body, { w: p.w });
    expect((await orderRow(r.body.order.id)).referrer_id).toBe(ID_REF());
    expect((await eventRows('frontdesk.order.created.v1', r.body.order.id))[0].envelope.payload.referrer_id).toBe(ID_REF());
    const s = await prepare();
    const r2 = await register(s.body, { w: s.w });
    expect((await orderRow(r2.body.order.id)).referrer_id).toBeNull();
    expect((await eventRows('frontdesk.order.created.v1', r2.body.order.id))[0].envelope.payload).not.toHaveProperty('referrer_id');
  }, T);

  describe('tenant B settings toggles (this file is the only user of tenant B registrations; always reset)', () => {
    const set = (cols: string) => superTx(async (tx) => { await tx.query(`UPDATE frontdesk.settings SET ${cols} WHERE tenant_id = $1`, [TENANT_B]); }, TENANT_B);
    afterAll(() => set('require_referrer = false, registration_sms_enabled = true'), T);
    it('require_referrer = true and no referrer -> 422 frontdesk.referrer_required, nothing stored, no billing call', async () => {
      await set('require_referrer = true');
      const p = await prepare({ side: 'b' });
      const e = await registerFails(p.body, { w: p.w, tenant: TENANT_B });
      expect(e.code).toBe('frontdesk.referrer_required');
      expect(e.statusCode).toBe(422);
      expect(p.w.billingFake.calls('issueOrderInvoice')).toHaveLength(0);
      expect(await ordersOf(p.patient.id)).toHaveLength(0);
      await set('require_referrer = false');
    }, T);
    it('settings registration_sms_enabled = false -> registration succeeds, SMS not queued', async () => {
      await set('registration_sms_enabled = false');
      const p = await prepare({ side: 'b' });
      const r = await register(p.body, { w: p.w, tenant: TENANT_B });
      expect(r.status).toBe(201);
      expect(r.body.notifications.registration_sms).not.toBe('queued');
      for (const c of p.w.notif.calls('sendSms')) throw new Error(`sendSms must not be called when registration_sms_enabled = false: ${JSON.stringify(c.input)}`);
    }, T);
  });
});
const ID_REF = () => REFERRER;   // the catalog fake's tenant-A referrer

describe('US-FD-04 credit registration', () => {
  const credit = (party: string) => ({ billing_mode: 'credit', credit_party_id: party });
  it('04.1 no invoice; credit charges via recordCreditCharges (same fingerprint, party, no payments); order credit_party_id set; event billing_mode credit', async () => {
    const p = await prepare({ d: credit(CP.ok) });
    const r = await register(p.body, { w: p.w });
    expect(r.status).toBe(201);
    expect(p.w.billingFake.calls('issueOrderInvoice')).toHaveLength(0);
    expect(p.w.billingFake.calls('recordPayment')).toHaveLength(0);
    const c = p.w.billingFake.calls('recordCreditCharges');
    expect(c).toHaveLength(1);
    expect(c[0].input).toMatchObject({ orderId: r.body.order.id, creditPartyId: CP.ok, branchId: BRANCH.a, centreId: CENTRE.a, expectedFingerprint: p.fp });
    expect(r.body).not.toHaveProperty('invoice');
    expect(r.body.credit_charges.length).toBeGreaterThan(0);
    // review item 3: period_month = first day of the A.D. month (05-SCHEMA.md:1049), status default 'uninvoiced' (:1050), amounts sum to the order net
    for (const cc of r.body.credit_charges) {
      expect(cc.period_month).toMatch(/^\d{4}-(0[1-9]|1[0-2])(-01)?$/);
      expect(cc.period_month.slice(0, 4)).toBe(String(new Date(NOW as never).getUTCFullYear()));
      expect(cc.status).toBe('uninvoiced');
    }
    expect(r.body.credit_charges.reduce((s: number, cc: any) => s + cc.amount.amount_paisa, 0)).toBe(NET);
    expect(r.body.ledger_entries).toEqual([]);
    expect(await orderRow(r.body.order.id)).toMatchObject({ billing_mode: 'credit', credit_party_id: CP.ok });
    const ev = (await eventRows('frontdesk.order.created.v1', r.body.order.id))[0].envelope.payload;
    expect(ev).toMatchObject({ billing_mode: 'credit', credit_party_id: CP.ok });
    expect(p.w.spy.ofType('billing.invoice.issued.v1')).toHaveLength(0);
  }, T);

  it('04.1 a user WITHOUT billing.invoice.issue can register credit orders (07 §7: second assert is for cash only)', async () => {
    const p = await prepare({ d: credit(CP.ok) });
    expect((await register(p.body, { w: p.w, grants: [PERM] })).status).toBe(201);
  }, T);

  it('04.2 locked / not allowsCredit party -> 409 billing.credit_party_locked; over the limit -> 409 billing.credit_limit_exceeded; nothing stored', async () => {
    for (const [party, code] of [[CP.locked, 'billing.credit_party_locked'], [CP.noCredit, 'billing.credit_party_locked'], [CP.over, 'billing.credit_limit_exceeded']] as const) {
      const p = await prepare({ d: credit(party) });
      const e = await registerFails(p.body, { w: p.w });
      expect(e.code).toBe(code);
      expect(e.statusCode).toBe(409);
      expect(await ordersOf(p.patient.id)).toHaveLength(0);
      expect(p.w.billingFake.calls('issueOrderInvoice')).toHaveLength(0);
    }
  }, T);

  it('04.3 credit without credit_party_id -> 400 common.validation_failed; payments on a credit order -> 400 at /payments', async () => {
    const p = await prepare({ d: { billing_mode: 'credit' }, fp: 'b'.repeat(64) });
    const e = await registerFails(p.body, { w: p.w });
    expect(e.code).toBe('common.validation_failed'); expect(e.statusCode).toBe(400);
    const q = await prepare({ d: credit(CP.ok), payments: [pay(1000)] });
    const e2 = await registerFails(q.body, { w: q.w });
    expect(e2.code).toBe('common.validation_failed');
    expect((e2.errors ?? []).map((x: any) => x.path)).toContain('/payments');
    expect(await ordersOf(q.patient.id)).toHaveLength(0);
  }, T);

  it("04.4 the first credit order reaches BillingCommandPort.recordCreditCharges (which upserts billing.credit_accounts from CatalogPort.getCreditParty) in the same call, not in C4 SQL", async () => {
    const p = await prepare({ d: credit(CP.ok) });
    await register(p.body, { w: p.w });
    expect(p.w.billingFake.calls('recordCreditCharges')).toHaveLength(1);
    expect(await ownerRows('information_schema.tables', "table_schema = 'frontdesk' AND table_name = 'credit_accounts'")).toHaveLength(0);
  }, T);
});

describe('US-FD-05 urgent', () => {
  it('05.1 urgent item with a C3 surcharge: surcharge goes to billing, item + event carry priority urgent, snapshot has the surcharge', async () => {
    const p = await prepare({ d: { items: [{ orderable_id: O.cbc, priority: 'urgent' }] }, payments: [pay(60000)] });
    const r = await register(p.body, { w: p.w });
    expect(r.status).toBe(201);
    const [it] = await itemRows(r.body.order.id);
    expect(it).toMatchObject({ priority: 'urgent', unit_price_paisa: '50000', urgent_surcharge_paisa: '10000' });
    const line = (p.w.billingFake.calls('issueOrderInvoice')[0].input as any).lines[0];
    expect(line).toMatchObject({ priority: 'urgent', urgentSurcharge: { amountPaisa: 10000 } });
    expect(r.body.balance.invoiced).toEqual(money(60000));
    expect((await eventRows('frontdesk.order.created.v1', r.body.order.id))[0].envelope.payload.items[0].priority).toBe('urgent');
  }, T);
  it('05.2 urgent without a surcharge rule: urgent item, no surcharge', async () => {
    const p = await prepare({ d: { items: [{ orderable_id: O.glu, priority: 'urgent' }] }, payments: [pay(22600)] });
    const r = await register(p.body, { w: p.w });
    const [it] = await itemRows(r.body.order.id);
    expect(it.priority).toBe('urgent');
    expect(it.urgent_surcharge_paisa).toBeNull();
    expect((p.w.billingFake.calls('issueOrderInvoice')[0].input as any).lines[0].urgentSurcharge).toBeUndefined();
    expect((await eventRows('frontdesk.order.created.v1', r.body.order.id))[0].envelope.payload.items[0].priority).toBe('urgent');
  }, T);
});

describe('US-FD-08 part payment, dues, overpayment', () => {
  it('08.1 part payment: invoice issued in full, balance_due = net - paid, no error', async () => {
    const p = await prepare({ payments: [pay(30000)] });
    const r = await register(p.body, { w: p.w });
    expect(r.status).toBe(201);
    expect(r.body.balance).toMatchObject({ invoiced: money(NET), paid: money(30000), balance_due: money(NET - 30000) });
    const last = p.w.spy.ofType('billing.balance.changed.v1').filter((e) => (e.payload as any).order_id === r.body.order.id).at(-1)!.payload as any;
    expect(last.release_eligible).toBe(false);
  }, T);
  it('no payments at all is allowed (full balance due)', async () => {
    const p = await prepare({ payments: [] });
    const r = await register(p.body, { w: p.w });
    expect(r.status).toBe(201);
    expect(r.body.ledger_entries).toEqual([]);
    expect(r.body.balance.balance_due).toEqual(money(NET));
    expect(p.w.billingFake.calls('recordPayment')).toHaveLength(0);
  }, T);
  it('08.3 overpayment -> 422 billing.payment_exceeds_due and the WHOLE tx rolls back (order, items, event)', async () => {
    const p = await prepare({ payments: [pay(NET + 100)] });
    const e = await registerFails(p.body, { w: p.w });
    expect(e.code).toBe('billing.payment_exceeds_due'); expect(e.statusCode).toBe(422);
    expect(p.w.billingFake.calls('issueOrderInvoice')).toHaveLength(1);              // it WAS issued inside the tx...
    expect(await storedFor(generatedOrderId(p.w)!)).toEqual(NOTHING);               // ...and nothing of it survived
    expect(await ordersOf(p.patient.id)).toHaveLength(0);
  }, T);
});

describe('discount authority at registration (US-FD-06.1 / US-FD-07.1 slices; consumption of approvals is FD-T07)', () => {
  const disc = (bp: number) => [{ scope: 'bill', reason_code: 'staff_family', kind: 'percent', percent_bp: bp }];
  it('within limit (5 % <= 10 %): stored with approval_mode within_limit; fingerprint covers it; billing gets the discount', async () => {
    const d = { discounts: disc(500) };
    const p = await prepare({ d, payments: [pay(1000)] });
    const r = await register(p.body, { w: p.w });
    expect(r.status).toBe(201);
    const rows = await discountRows(r.body.order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scope: 'bill', kind: 'percent', percent_bp: 500, reason_code: 'staff_family', approval_mode: 'within_limit', approval_id: null, status: 'applied' });
    expect(Number(rows[0].computed_paisa)).toBe(3500);                               // 5 % of gross 70000
    expect((p.w.billingFake.calls('issueOrderInvoice')[0].input as any).discounts).toHaveLength(1);
  }, T);
  it('above the self limit (30 % > 10 %) without discount_approval_id -> 403 frontdesk.discount_approval_required, nothing stored', async () => {
    const p = await prepare({ d: { discounts: disc(3000) }, payments: [] });
    const e = await registerFails(p.body, { w: p.w });
    expect(e.code).toBe('frontdesk.discount_approval_required'); expect(e.statusCode).toBe(403);
    expect(await ordersOf(p.patient.id)).toHaveLength(0);
    expect(p.w.billingFake.calls('issueOrderInvoice')).toHaveLength(0);
  }, T);
  it('above the absolute maximum (60 % > 50 %) -> 422 frontdesk.discount_exceeds_limit', async () => {
    // F8 already answers 422 above discount_absolute_max_bp (03-APP-FLOW:78), so prepare() must not quote it: hand F9 a dummy fingerprint (ruling FD-T06 #4).
    const p = await prepare({ d: { discounts: disc(6000) }, fp: 'a'.repeat(64), payments: [] });
    const e = await registerFails(p.body, { w: p.w });
    expect(e.code).toBe('frontdesk.discount_exceeds_limit'); expect(e.statusCode).toBe(422);
  }, T);
});

describe('US-FD-14.1 registration SMS via NotificationPort (spy = fake.calls)', () => {
  it('exactly one sendSms: purpose, template, key <order_id>:registration_sms, related order, recipient patient, params only {lab_name, registered_time_hhmm}; status queued', async () => {
    const p = await prepare();
    const r = await register(p.body, { w: p.w });
    const calls = p.w.notif.calls('sendSms');
    expect(calls).toHaveLength(1);
    const i = calls[0].input as any;
    expect(i).toMatchObject({ templateCode: 'frontdesk.registration_confirmation', purpose: 'registration_confirmation', recipient: { kind: 'patient', patientId: p.patient.id },
      idempotencyKey: `${r.body.order.id}:registration_sms`, related: { entityType: 'order', entityId: r.body.order.id } });
    expect(Object.keys(i.params).sort()).toEqual(['lab_name', 'registered_time_hhmm']);
    expect(i.params).toEqual({ lab_name: LAB_NAME, registered_time_hhmm: '11:45' });       // NOW = 06:00Z = 11:45 Asia/Kathmandu
    const wire = JSON.stringify(i);
    for (const phi of [p.patient.full_name, p.patient.phone_e164, r.body.order.registration_no, 'CBC', 'Complete Blood Count', 'Glucose']) expect(wire).not.toContain(phi);
    expect(i).not.toHaveProperty('phone');
    expect(r.body.notifications.registration_sms).toBe('queued');
  }, T);
  it('no SMS consent -> registration still 201, SMS not queued', async () => {
    const p = await prepare({ consent: { sms: false }, sms: false });
    const r = await register(p.body, { w: p.w });
    expect(r.status).toBe(201);
    expect(['suppressed_no_consent', 'not_attempted']).toContain(r.body.notifications.registration_sms);
  }, T);
  it('tenant channel smsEnabled = false -> 201, SMS not queued', async () => {
    const p = await prepare();
    const r = await register(p.body, { w: p.w, smsEnabled: false });
    expect(r.status).toBe(201);
    expect(['suppressed_channel_disabled', 'not_attempted']).toContain(r.body.notifications.registration_sms);
  }, T);
  it('port error is caught: 201, not_attempted, order committed, the code is logged, no PHI in the log line', async () => {
    const p = await prepare();
    p.w.notif.failNext('sendSms', 'reporting.notification_params_invalid');
    const r = await register(p.body, { w: p.w });
    expect(r.status).toBe(201);
    expect(r.body.notifications.registration_sms).toBe('not_attempted');
    expect((await orderRow(r.body.order.id)).status).toBe('registered');
    const log = r.probe.logs.join('\n');
    expect(log).toContain('reporting.notification_params_invalid');
    for (const phi of [p.patient.full_name, p.patient.phone_e164]) expect(log).not.toContain(phi);
  }, T);
});

describe('authorisation, scope, tenant isolation, input', () => {
  it('without frontdesk.registration.create -> 403 auth.forbidden, nothing stored', async () => {
    const p = await prepare();
    const e = await registerFails(p.body, { w: p.w, grants: [INVOICE_PERM] });
    expect(e.code).toBe('auth.forbidden');
    expect(await ordersOf(p.patient.id)).toHaveLength(0);
  }, T);
  it('cash without billing.invoice.issue -> 403 auth.forbidden ("invoice issue permission required"), checked before any write', async () => {
    const p = await prepare();
    const e = await registerFails(p.body, { w: p.w, grants: [PERM] });
    expect(e.code).toBe('auth.forbidden');
    expect(e.statusCode).toBe(403);
    expect(p.w.billingFake.calls('issueOrderInvoice')).toHaveLength(0);
    expect(await ordersOf(p.patient.id)).toHaveLength(0);
  }, T);
  it('centre outside the actor centre scope -> 404 common.not_found (does not confirm the centre exists)', async () => {
    const p = await prepare();
    const e = await registerFails(p.body, { w: p.w, centreIds: [uid()] });
    expect(e.code).toBe('common.not_found');
    expect(await ordersOf(p.patient.id)).toHaveLength(0);
  }, T);
  it('another tenant\'s patient id -> 404; unknown patient id -> 404; nothing stored for either tenant', async () => {
    const pb = await seedPatient('b', {}, { sms: true });
    const w = rworld();
    const d = draft({ patient: { patient_id: pb.id } });
    const fp = await quoteFp(w, d);
    const e = await registerFails({ ...d, quote_fingerprint: fp, payments: [pay(NET)] }, { w });
    expect(e.code).toBe('common.not_found');
    const d2 = draft({ patient: { patient_id: uid() } });
    const e2 = await registerFails({ ...d2, quote_fingerprint: fp, payments: [] }, { w });
    expect(e2.code).toBe('common.not_found');
    expect(await ordersOf(pb.id)).toHaveLength(0);
  }, T);
  it('malformed: missing quote_fingerprint, non-hex fingerprint, payment amount 0, unknown item -> 400/404 and nothing stored', async () => {
    const p = await prepare();
    const { quote_fingerprint: _q, ...noFp } = p.body;
    expect((await registerFails(noFp, { w: p.w })).code).toBe('common.validation_failed');
    expect((await registerFails({ ...p.body, quote_fingerprint: 'zz' }, { w: p.w })).code).toBe('common.validation_failed');
    expect((await registerFails({ ...p.body, payments: [pay(0)] }, { w: p.w })).code).toBe('common.validation_failed');
    expect((await registerFails({ ...p.body, payments: 'x' }, { w: p.w })).code).toBe('common.validation_failed');
    expect(await ordersOf(p.patient.id)).toHaveLength(0);
    expect(p.w.billingFake.calls('issueOrderInvoice')).toHaveLength(0);
  }, T);
  it('port errors propagate unchanged (08 R18): inactive test -> catalog.test_inactive, no price -> catalog.no_price; nothing stored', async () => {
    const p = await prepare({ fp: 'c'.repeat(64), d: { items: [{ orderable_id: O.lft }] } });
    expect((await registerFails(p.body, { w: p.w })).code).toBe('catalog.test_inactive');
    const q = await prepare({ fp: 'c'.repeat(64), d: { items: [{ orderable_id: O.cul }] } });
    expect((await registerFails(q.body, { w: q.w })).code).toBe('catalog.no_price');
    expect(await ordersOf(p.patient.id)).toHaveLength(0);
  }, T);
  it('logs carry no patient name / phone / registration no / fingerprint-free PHI on success', async () => {
    const p = await prepare();
    const r = await register(p.body, { w: p.w });
    const log = r.probe.logs.join('\n');
    for (const phi of [p.patient.full_name, p.patient.phone_e164, r.body.order.registration_no]) expect(log).not.toContain(phi);
  }, T);
});
