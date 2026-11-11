// FD-T09 F8b quoteOrderItemsChange + F13 changeOrderItems. ACs: US-FD-10.1-10.3, US-BL-10.5 (periodic charge side); 02-TRD §5.1 F8b/F13, §6.4 (LabPort removal guard, billing.invoice.issue on cash add),
// §8.1 (items_changed.v1: key `<order_id>:items:<order_version>`, seq = order version); 03-APP-FLOW §2.5; 07-SECURITY §5/§6.1/§6.2/§6.4/§6.5.
// Ports are the real fakes (packages/fakes). LD-70: pending.json is the writer's; nothing here touches it.
// Spec gaps, deliberately NOT asserted: adding an orderable that is already active on the order; F13 on a stored `in_progress` order (TRD §8.1 says registered/in_progress, APP-FLOW §2.5 says
// `registered`); unknown / inactive reason codes (coded-set validation owner); billing idempotency-key format.
// The whole-tx RETRY on billing.counter_busy / 40P01 (03-APP-FLOW §2.3 step 9, D-25) needs a handler-ctx tx opener that does not exist (CR .orchestra/cr/FD-T06-retry-quote-ext.md):
// 'transient counter_busy' below accepts a retried success OR a clean failure, but never a half-written change.
import { beforeAll, describe, expect, it } from 'vitest';
import { CBC, CENTRE_A2, CP, EDIT, GLU, INVOICE, NOW_ISO, O, T, TENANT_B, add, approveResult, billingIds, busyBilling, callsOf, change, changeFails, edit, eventRows, fpOf, itemRows, mk, money, mutations,
  orderRow, pay, quoteChange, quoteChangeFails, rm, schemaErrors, seedSettings, snap, uid } from './helpers.js';
import { world } from '../quote/helpers.js';

beforeAll(seedSettings, T);
const EV = 'frontdesk.order.items_changed.v1';
const lines = (r: { body: any }) => (r.body.lines as any[]).filter((l) => l.kind === 'orderable');
const FP0 = 'a'.repeat(64);
const bodyOfInvoiceCalls = (e: any) => callsOf(e.billing, 'issueOrderInvoice');

describe('F8b quoteOrderItemsChange: a Quote over the ADDED lines only, priced in the stored order\'s context', () => {
  it('200, satisfies the Quote schema, one orderable line per added item (never the existing items), no write, no event', async () => {
    const e = await edit();
    const before = await snap(e);
    const r = await quoteChange(e, [add(O.ure)]);
    expect(r.status).toBe(200);
    expect(schemaErrors('Quote', r.body)).toEqual([]);
    expect(lines(r)).toHaveLength(1);
    expect(lines(r)[0]).toMatchObject({ orderable_id: O.ure, unit_price: money(15000), other_tax: money(300), net: money(15300), priority: 'routine' });
    expect(r.body.totals).toMatchObject({ gross: money(15000), net: money(15300) });
    expect(r.body.quote_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(r.wrote).toBe(false);
    expect(await snap(e)).toEqual(before);
    expect(mutations(e)).toEqual([]);
  }, T);

  it('the fingerprint depends on exactly the added lines: same add on two different orders = same fingerprint; different add / priority = different', async () => {
    const [e1, e2] = [await edit({ items: [GLU] }), await edit({ items: [CBC, GLU] })];
    const f1 = await fpOf(e1, [add(O.ure)]);
    expect(await fpOf(e2, [add(O.ure)])).toBe(f1);
    expect(await fpOf(e1, [add(O.ure)])).toBe(f1);
    expect(await fpOf(e1, [add(O.anaemia)])).not.toBe(f1);
    expect(await fpOf(e1, [add(O.cbc, 'urgent')])).not.toBe(await fpOf(e1, [add(O.cbc, 'routine')]));
  }, T);

  it('priority urgent adds the urgent surcharge line (C3 price list)', async () => {
    const e = await edit({ items: [GLU] });
    const r = await quoteChange(e, [add(O.cbc, 'urgent')]);
    expect((r.body.lines as any[]).filter((l) => l.orderable_id === O.cbc).map((l) => l.kind).sort()).toEqual(['orderable', 'urgent_surcharge']);
    expect(r.body.totals.gross).toEqual(money(60000));
  }, T);

  it('pricing context = the STORED order: centre, referrer (cash) and credit party (credit) go to CatalogPort.priceFor; precedence credit_party > referrer > centre > tenant_default', async () => {
    const cash = await edit({ items: [GLU], referrer: true, wopts: { centreList: true, referrerList: true, creditList: true } });
    const r = await quoteChange(cash, [add(O.cbc)]);
    expect(lines(r)[0]).toMatchObject({ unit_price: money(45000), price_source: 'referrer' });
    const ctxs = (cash.w.catalog as any).calls('priceFor').map((c: any) => c.input.context);
    expect(ctxs[0]).toMatchObject({ centreId: cash.centre, referrerId: expect.any(String) });
    expect(ctxs[0]).not.toHaveProperty('creditPartyId');
    const cr = await edit({ mode: 'credit', items: [GLU], referrer: true, wopts: { centreList: true, referrerList: true, creditList: true } });
    const q = await quoteChange(cr, [add(O.cbc)]);
    expect(lines(q)[0]).toMatchObject({ unit_price: money(40000), price_source: 'credit_party' });
    expect((cr.w.catalog as any).calls('priceFor')[0].input.context).toMatchObject({ centreId: cr.centre, creditPartyId: CP.ok });
  }, T);

  it('errors: pre_registered -> 409 frontdesk.order_not_editable; cancelled -> 409 frontdesk.order_already_cancelled; completed -> 409 frontdesk.order_not_editable', async () => {
    for (const [stored, code] of [['pre_registered', 'frontdesk.order_not_editable'], ['cancelled', 'frontdesk.order_already_cancelled'], ['completed', 'frontdesk.order_not_editable']] as const) {
      const e = await edit({ stored });
      const x = await quoteChangeFails(e, [add(O.ure)]);
      expect(x.code, stored).toBe(code); expect(x.statusCode, stored).toBe(409);
    }
  }, T);

  it('catalog errors propagate unchanged (08 R18): inactive test, no price, missing tax config', async () => {
    const e = await edit();
    expect((await quoteChangeFails(e, [add(O.lft)])).code).toBe('catalog.test_inactive');
    expect((await quoteChangeFails(e, [add(O.cul)])).code).toBe('catalog.no_price');
    expect((await quoteChangeFails(e, [add(O.taxMissing)])).code).toBe('catalog.tax_config_missing');
  }, T);

  it('malformed bodies -> 400 common.validation_failed: no add, 51 adds, bad uuid, unknown field', async () => {
    const e = await edit();
    for (const add_ of [undefined, [], Array.from({ length: 51 }, () => add(O.cbc)), [{ orderable_id: 'nope' }], [{ orderable_id: O.cbc, status: 'active' }]]) {
      const x = await quoteChangeFails(e, add_);
      expect(x.code, JSON.stringify(add_)?.slice(0, 60)).toBe('common.validation_failed'); expect(x.statusCode).toBe(400);
    }
  }, T);

  it('needs frontdesk.order.edit (registration.create alone is 403); an orderable that exists only for tenant B is 404', async () => {
    const e = await edit();
    expect((await quoteChangeFails(e, [add(O.ure)], { grants: ['frontdesk.registration.create'] })).code).toBe('auth.forbidden');
    expect((await quoteChangeFails(e, [add(O.tenantBOnly)])).code).toBe('common.not_found');
  }, T);

  it('07 §6.1 / §6.2: another tenant\'s order and an order of another centre are 404 (no catalog call)', async () => {
    const e = await edit();
    const x = await quoteChangeFails(e, [add(O.ure)], { tenant: TENANT_B, centreIds: [CENTRE_A2] });
    expect(x.code).toBe('common.not_found'); expect(x.statusCode).toBe(404);
    const y = await quoteChangeFails(e, [add(O.ure)], { centreIds: [CENTRE_A2] });
    expect(y.code).toBe('common.not_found');
    expect((e.w.catalog as any).calls('priceFor')).toHaveLength(0);
  }, T);

  it('PHI: patient name and registration no never reach the logs', async () => {
    const e = await edit();
    const r = await quoteChange(e, [add(O.ure)]);
    const all = r.probe.logs.join('\n');
    expect(all).not.toContain(e.patient.full_name); expect(all).not.toContain(e.order.registration_no);
  }, T);
});

describe('F13 changeOrderItems: additions (US-FD-10.1)', () => {
  it('cash: a SUPPLEMENTARY invoice for the added lines only; items +1 active at items_version 2; ONE items_changed event (added, removed empty); body satisfies ChangeOrderItemsResult', async () => {
    const e = await edit();
    const b = await mk(e, { add: [add(O.ure)] });
    const r = await change(e, b);
    expect(r.status).toBe(200);
    expect(schemaErrors('ChangeOrderItemsResult', r.body)).toEqual([]);
    const calls = bodyOfInvoiceCalls(e);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ orderId: e.order.id, purpose: 'supplementary', expectedFingerprint: b.quote_fingerprint, branchId: e.order.branch_id, centreId: e.order.centre_id });
    expect(calls[0].lines.map((l: any) => l.orderableId)).toEqual([O.ure]);
    expect(callsOf(e.billing, 'recordCreditCharges')).toHaveLength(0);
    expect(r.body.credit_note_required).toBe(false);
    expect((await billingIds(e)).invoiceIds).toContain(r.body.supplementary_invoice.id);
    expect((await billingIds(e)).invoiceIds).toHaveLength(2);

    const o = await orderRow(e.order.id);
    expect(Number(o.items_version)).toBe(2);
    expect(Number(o.version)).toBeGreaterThan(1);
    expect(r.body.version).toBe(Number(o.version));
    const rows = await itemRows(e.order.id);
    expect(rows).toHaveLength(3);
    const added = rows.find((i) => i.orderable_id === O.ure);
    expect(added).toMatchObject({ status: 'active', added_in_items_version: 2, priority: 'routine', orderable_kind: 'test', unit_price_paisa: '15000', price_source: 'tenant_default', other_tax_code: 'SC', vat_treatment: 'exempt' });
    expect(added.code).toBeTruthy(); expect(added.name).toBeTruthy(); expect(added.test_ids.length).toBeGreaterThan(0);
    expect(rows.filter((i) => i.status === 'active')).toHaveLength(3);
    expect(r.body.items.filter((i: any) => i.status === 'active').map((i: any) => i.orderable_id).sort()).toEqual([O.cbc, O.glu, O.ure].sort());

    const evs = await eventRows(EV, e.order.id);
    expect(evs).toHaveLength(1);
    expect(evs[0].idempotency_key).toBe(`${e.order.id}:items:${o.version}`);
    expect(Number(evs[0].aggregate_seq)).toBe(Number(o.version));
    expect(evs[0].producer).toBe('frontdesk');
    expect(evs[0].envelope.aggregate).toMatchObject({ type: 'order', id: e.order.id });
    const p = evs[0].envelope.payload;
    expect(p).toMatchObject({ order_id: e.order.id, items_version: 2, removed: [], changed_at: NOW_ISO });
    expect(p.added).toEqual([{ order_item_id: added.id, orderable_id: O.ure, orderable_kind: 'test', test_ids: added.test_ids, priority: 'routine' }]);
  }, T);

  it('urgent addition: item priority urgent with the urgent surcharge snapshot (10000 on CBC) and the event item priority urgent', async () => {
    const e = await edit({ items: [GLU] });
    const r = await change(e, await mk(e, { add: [add(O.cbc, 'urgent')] }));
    expect(r.status).toBe(200);
    const added = (await itemRows(e.order.id)).find((i) => i.orderable_id === O.cbc);
    expect(added).toMatchObject({ priority: 'urgent', unit_price_paisa: '50000', urgent_surcharge_paisa: '10000' });
    expect((await eventRows(EV, e.order.id))[0].envelope.payload.added[0].priority).toBe('urgent');
  }, T);

  it('payments[] are recorded against the SUPPLEMENTARY invoice (manual capture); an overpayment is refused and nothing is stored', async () => {
    const e = await edit({ paid: true });
    const r = await change(e, await mk(e, { add: [add(O.ure)], payments: [pay(15300)] }));
    const rec = callsOf(e.billing, 'recordPayment');
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({ orderId: e.order.id, invoiceId: r.body.supplementary_invoice.id, methodCode: 'cash', captureKind: 'manual', amount: { amountPaisa: 15300, currency: 'NPR' } });
    const f = await edit({ paid: true });
    const before = await snap(f);
    const x = await changeFails(f, await mk(f, { add: [add(O.ure)], payments: [pay(15301)] }));
    expect(x.code).toBe('billing.payment_exceeds_due');
    expect(await snap(f)).toEqual(before);
  }, T);

  it('credit order: recordCreditCharges for the added lines (no invoice, no supplementary_invoice); one more open charge', async () => {
    const e = await edit({ mode: 'credit', items: [GLU] });
    const n0 = (await billingIds(e)).creditChargeIds.length;
    const b = await mk(e, { add: [add(O.ure)] });
    const r = await change(e, b, { grants: [EDIT] });          // credit additions issue no invoice: billing.invoice.issue is not needed
    expect(r.status).toBe(200);
    const rec = callsOf(e.billing, 'recordCreditCharges');
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({ orderId: e.order.id, creditPartyId: CP.ok, expectedFingerprint: b.quote_fingerprint });
    expect(rec[0].lines.map((l: any) => l.orderableId)).toEqual([O.ure]);
    expect(bodyOfInvoiceCalls(e)).toHaveLength(0);
    expect(r.body).not.toHaveProperty('supplementary_invoice');
    expect(r.body.credit_note_required).toBe(false);
    expect((await billingIds(e)).creditChargeIds).toHaveLength(n0 + 1);
    expect(Number((await orderRow(e.order.id)).items_version)).toBe(2);
  }, T);

  it('missing / invalid fingerprint for a non-empty add is refused (400 or 409), nothing stored, billing never called', async () => {
    const e = await edit();
    const before = await snap(e);
    for (const b of [{ add: [add(O.ure)] }, { add: [add(O.ure)], quote_fingerprint: 'xyz' }]) {
      const x = await changeFails(e, b);
      expect(['common.validation_failed', 'common.version_conflict'], JSON.stringify(b)).toContain(x.code);
    }
    expect(await snap(e)).toEqual(before);
    expect(mutations(e)).toEqual([]);
  }, T);
});

describe('F13 stale quote: fingerprint must equal the F8b quote over exactly `add` (APP-FLOW §2.5 step 3)', () => {
  it('prices changed between F8b and F13 -> 409 common.version_conflict; nothing stored, no billing mutation (the counter is never touched)', async () => {
    const e = await edit({ items: [GLU] });
    const fp = await fpOf(e, [add(O.cbc)]);
    const before = await snap(e);
    const x = await changeFails(e, { add: [add(O.cbc)], quote_fingerprint: fp }, { w: world({ cbcPriceV2: 65000 }) });
    expect(x.code).toBe('common.version_conflict'); expect(x.statusCode).toBe(409);
    expect(await snap(e)).toEqual(before);
    expect(mutations(e)).toEqual([]);
  }, T);

  it('a fingerprint over a DIFFERENT add (other orderable, or routine vs urgent) or a made-up one -> 409 common.version_conflict', async () => {
    const e = await edit({ items: [GLU] });
    const before = await snap(e);
    const fpRoutine = await fpOf(e, [add(O.cbc, 'routine')]);
    for (const b of [{ add: [add(O.ure)], quote_fingerprint: fpRoutine }, { add: [add(O.cbc, 'urgent')], quote_fingerprint: fpRoutine }, { add: [add(O.ure)], quote_fingerprint: FP0 }]) {
      expect((await changeFails(e, b)).code).toBe('common.version_conflict');
    }
    expect(await snap(e)).toEqual(before);
  }, T);

  it('catalog errors are raised by the in-tx re-quote (inactive test / no price) and roll everything back', async () => {
    const e = await edit();
    const before = await snap(e);
    expect((await changeFails(e, { add: [add(O.lft)], quote_fingerprint: FP0 })).code).toBe('catalog.test_inactive');
    expect((await changeFails(e, { add: [add(O.cul)], quote_fingerprint: FP0 })).code).toBe('catalog.no_price');
    expect(await snap(e)).toEqual(before);
  }, T);
});

describe('F13 removals (US-FD-10.2, US-FD-10.3)', () => {
  it('10.2 cash: the item becomes `removed` (reason, removed_at); the event lists it under `removed`; a credit_note_required task is raised for the invoiced line; the invoice is untouched', async () => {
    const e = await edit();
    const cbc = e.itemOf('CBC');
    const r = await change(e, await mk(e, { remove: [rm(cbc.id, 'patient_request')] }), { grants: [EDIT] });     // removal issues no invoice
    expect(r.status).toBe(200);
    expect(schemaErrors('ChangeOrderItemsResult', r.body)).toEqual([]);
    const row = (await itemRows(e.order.id)).find((i) => i.id === cbc.id);
    expect(row).toMatchObject({ status: 'removed', removal_reason_code: 'patient_request' });
    expect(row.removed_at).not.toBeNull();
    expect((await itemRows(e.order.id)).find((i) => i.id === e.itemOf('GLU').id).status).toBe('active');
    expect(r.body.items.find((i: any) => i.id === cbc.id).status).toBe('removed');
    const raise = callsOf(e.billing, 'raiseCreditNoteRequirement');
    expect(raise).toHaveLength(1);
    expect(raise[0]).toMatchObject({ orderId: e.order.id, orderItemIds: [cbc.id], cause: 'item_removed' });
    expect(r.body.credit_note_required).toBe(true);
    expect(bodyOfInvoiceCalls(e)).toHaveLength(0);
    expect(r.body).not.toHaveProperty('supplementary_invoice');
    expect((await billingIds(e)).invoiceIds).toHaveLength(1);
    const o = await orderRow(e.order.id);
    expect(Number(o.items_version)).toBe(2);
    const evs = await eventRows(EV, e.order.id);
    expect(evs).toHaveLength(1);
    expect(evs[0].envelope.payload).toMatchObject({ order_id: e.order.id, items_version: 2, added: [], removed: [{ order_item_id: cbc.id, reason_code: 'patient_request' }] });
    expect(evs[0].idempotency_key).toBe(`${e.order.id}:items:${o.version}`);
  }, T);

  it('removing an item that is on no invoice raises no task: credit_note_required false', async () => {
    const e = await edit({ items: [CBC, { ...GLU, invoiced: false }] });
    const r = await change(e, await mk(e, { remove: [rm(e.itemOf('GLU').id)] }), { grants: [EDIT] });
    expect(r.body.credit_note_required).toBe(false);
    expect((await itemRows(e.order.id)).find((i) => i.id === e.itemOf('GLU').id).status).toBe('removed');
  }, T);

  it('credit order: charges of the removed item are voided (not on a periodic invoice -> no task)', async () => {
    const e = await edit({ mode: 'credit' });
    const cbc = e.itemOf('CBC');
    const n0 = (await billingIds(e)).creditChargeIds.length;
    const r = await change(e, await mk(e, { remove: [rm(cbc.id)] }), { grants: [EDIT] });
    const v = callsOf(e.billing, 'voidCreditCharges');
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ orderId: e.order.id, orderItemIds: [cbc.id] });
    expect(typeof v[0].reasonCode).toBe('string');
    expect((await billingIds(e)).creditChargeIds).toHaveLength(n0 - 1);
    expect(r.body.credit_note_required).toBe(false);
    expect(r.body).not.toHaveProperty('supplementary_invoice');
  }, T);

  it('US-BL-10.5 (item level): a credit charge already on a PERIODIC invoice is not voided; a credit_note_required task opens for it (cause item_removed) -> credit_note_required true', async () => {
    const e = await edit({ mode: 'credit', items: [{ ...CBC, charge: 'periodic' }, GLU] });
    const cbc = e.itemOf('CBC');
    const r = await change(e, await mk(e, { remove: [rm(cbc.id)] }), { grants: [EDIT] });
    expect(r.status).toBe(200);
    expect(callsOf(e.billing, 'raiseCreditNoteRequirement')[0]).toMatchObject({ orderId: e.order.id, orderItemIds: [cbc.id], cause: 'item_removed' });
    expect(r.body.credit_note_required).toBe(true);
    expect((await billingIds(e)).creditChargeIds).toHaveLength(2);     // the periodic charge stays; finance corrects it with the credit note
  }, T);

  it('one request may add and remove: a single transaction, items_version +1 only once, ONE event with both lists, supplementary invoice for the addition only', async () => {
    const e = await edit();
    const cbc = e.itemOf('CBC');
    const r = await change(e, await mk(e, { add: [add(O.ure)], remove: [rm(cbc.id, 'wrong_test')] }));
    expect(r.status).toBe(200);
    const o = await orderRow(e.order.id);
    expect(Number(o.items_version)).toBe(2);
    const evs = await eventRows(EV, e.order.id);
    expect(evs).toHaveLength(1);
    expect(evs[0].envelope.payload.added.map((i: any) => i.orderable_id)).toEqual([O.ure]);
    expect(evs[0].envelope.payload.removed).toEqual([{ order_item_id: cbc.id, reason_code: 'wrong_test' }]);
    expect(bodyOfInvoiceCalls(e)[0].lines.map((l: any) => l.orderableId)).toEqual([O.ure]);
    expect(callsOf(e.billing, 'raiseCreditNoteRequirement')[0].orderItemIds).toEqual([cbc.id]);
    expect(r.body.credit_note_required).toBe(true);
    expect(r.body.supplementary_invoice).toBeDefined();
  }, T);

  it('10.3 removal guard: LabPort says removable=false (specimen received) -> 409 frontdesk.order_not_editable; nothing changes; billing never called; the lab call carries {orderId} only', async () => {
    const e = await edit({ items: [{ ...CBC, lab: 'in_progress' }, GLU] });
    const before = await snap(e);
    const x = await changeFails(e, await mk(e, { remove: [rm(e.itemOf('CBC').id)] }));
    expect(x.code).toBe('frontdesk.order_not_editable'); expect(x.statusCode).toBe(409);
    expect(await snap(e)).toEqual(before);
    expect(mutations(e)).toEqual([]);
    const lab = e.labPortCalls();
    expect(lab.length).toBeGreaterThan(0);
    for (const c of lab) expect(c.input).toEqual({ orderId: e.order.id });
  }, T);

  it('10.3 removal guard fails CLOSED: the lab returns no row for the removed item -> 409 frontdesk.order_not_editable; nothing written; billing not called (reviewer FD-T09 #1; 03-IC §3.2, 02-TRD:482)', async () => {
    const e = await edit({ items: [{ ...CBC, labOmit: true }, GLU] });
    const before = await snap(e);
    const x = await changeFails(e, await mk(e, { remove: [rm(e.itemOf('CBC').id)] }));
    expect(x.code).toBe('frontdesk.order_not_editable'); expect(x.statusCode).toBe(409);
    expect(await snap(e)).toEqual(before);
    expect(mutations(e)).toEqual([]);
  }, T);

  it('10.3 a result already entered also blocks removal (fake reason result_entered)', async () => {
    const e = await edit({ items: [{ ...CBC, lab: 'result_entered_only' }, GLU] });
    expect((await changeFails(e, await mk(e, { remove: [rm(e.itemOf('CBC').id)] }))).code).toBe('frontdesk.order_not_editable');
  }, T);

  it('10.3 the other items stay removable and additions are still allowed, but one blocked item in the request fails the WHOLE request (atomic)', async () => {
    const e = await edit({ items: [{ ...CBC, lab: 'in_progress' }, GLU] });
    const glu = e.itemOf('GLU');
    const before = await snap(e);
    expect((await changeFails(e, await mk(e, { remove: [rm(e.itemOf('CBC').id), rm(glu.id)] }))).code).toBe('frontdesk.order_not_editable');
    expect(await snap(e)).toEqual(before);                      // GLU was not removed either
    expect((await change(e, await mk(e, { add: [add(O.ure)] }))).status).toBe(200);                    // addition alone: fine
    expect((await change(e, await mk(e, { remove: [rm(glu.id)] }), { grants: [EDIT] })).status).toBe(200);     // the free item: removable
    expect((await itemRows(e.order.id)).find((i) => i.id === glu.id).status).toBe('removed');
    expect((await itemRows(e.order.id)).find((i) => i.id === e.itemOf('CBC').id).status).toBe('active');
  }, T);

  it('removal of an item that belongs to ANOTHER order of the same tenant is refused (404/400), neither order changes', async () => {
    const e = await edit(); const other = await edit();
    const [b1, b2] = [await snap(e), await snap(other)];
    const x = await changeFails(e, await mk(e, { remove: [rm(other.items[0].id)] }));
    expect(['common.not_found', 'common.validation_failed']).toContain(x.code);
    expect(await snap(e)).toEqual(b1); expect(await snap(other)).toEqual(b2);
  }, T);
});

describe('F13 guards, optimistic locking, atomicity', () => {
  it('pre_registered -> 409 frontdesk.order_not_editable (F12 items_override is the way); cancelled -> 409 frontdesk.order_already_cancelled; completed -> not_editable; nothing stored', async () => {
    for (const [stored, code] of [['pre_registered', 'frontdesk.order_not_editable'], ['cancelled', 'frontdesk.order_already_cancelled'], ['completed', 'frontdesk.order_not_editable']] as const) {
      const e = await edit({ stored });
      const before = await snap(e);
      const x = await changeFails(e, { remove: [rm(e.items[0].id)] });
      expect(x.code, stored).toBe(code); expect(x.statusCode, stored).toBe(409);
      expect(await snap(e), stored).toEqual(before);
      expect(mutations(e), stored).toEqual([]);
    }
  }, T);

  it('an empty change (no add, no remove) is refused 400 and never emits an event ("added/removed never both empty")', async () => {
    const e = await edit();
    for (const b of [{}, { add: [], remove: [] }, { remove: [] }]) {
      const x = await changeFails(e, b);
      expect(x.code, JSON.stringify(b)).toBe('common.validation_failed'); expect(x.statusCode).toBe(400);
    }
    expect((await eventRows(EV, e.order.id))).toHaveLength(0);
  }, T);

  it('malformed bodies -> 400: 51 adds / 51 removes / bad uuid / missing reason_code / unknown field (status, tenant_id) / 6 payments', async () => {
    const e = await edit();
    const before = await snap(e);
    const it0 = e.items[0].id;
    const bad: unknown[] = [
      { add: Array.from({ length: 51 }, () => add(O.cbc)), quote_fingerprint: FP0 },
      { remove: Array.from({ length: 51 }, () => rm(it0)) },
      { remove: [{ order_item_id: 'nope', reason_code: 'patient_request' }] },
      { remove: [{ order_item_id: it0 }] },
      { remove: [rm(it0)], status: 'cancelled' },
      { remove: [rm(it0)], tenant_id: TENANT_B },
      { add: [add(O.ure)], quote_fingerprint: FP0, payments: Array.from({ length: 6 }, () => pay(1)) },
    ];
    for (const b of bad) { const x = await changeFails(e, b); expect(x.code, JSON.stringify(b).slice(0, 60)).toBe('common.validation_failed'); expect(x.statusCode).toBe(400); }
    expect(await snap(e)).toEqual(before);
  }, T);

  it('If-Match: absent -> 428 common.precondition_required; stale -> 409 common.version_conflict; nothing stored', async () => {
    const e = await edit();
    const before = await snap(e);
    const b = { remove: [rm(e.items[0].id)] };
    const a = await changeFails(e, b, { ifMatch: null });
    expect(a.code).toBe('common.precondition_required'); expect(a.statusCode).toBe(428);
    const s = await changeFails(e, b, { ifMatch: '"99"' });
    expect(s.code).toBe('common.version_conflict'); expect(s.statusCode).toBe(409);
    expect(await snap(e)).toEqual(before);
  }, T);

  it('replaying the SAME If-Match after a success is stale (version moved): 409, still exactly one event and items_version 2', async () => {
    const e = await edit();
    const v = `"${Number((await orderRow(e.order.id)).version)}"`;
    expect((await change(e, { remove: [rm(e.itemOf('CBC').id)] }, { ifMatch: v })).status).toBe(200);
    expect((await changeFails(e, { remove: [rm(e.itemOf('GLU').id)] }, { ifMatch: v })).code).toBe('common.version_conflict');
    expect(await eventRows(EV, e.order.id)).toHaveLength(1);
    expect(Number((await orderRow(e.order.id)).items_version)).toBe(2);
    expect((await itemRows(e.order.id)).filter((i) => i.status === 'active')).toHaveLength(1);
  }, T);

  it('race: two concurrent changes with the same If-Match -> exactly one wins, the other gets common.version_conflict; one event, items_version 2', async () => {
    const e = await edit();
    const v = `"${Number((await orderRow(e.order.id)).version)}"`;
    const [b1, b2] = [await mk(e, { add: [add(O.ure)] }), await mk(e, { add: [add(O.anaemia)] })];
    const res = await Promise.allSettled([change(e, b1, { ifMatch: v }), change(e, b2, { ifMatch: v })]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason.code).toBe('common.version_conflict');
    expect(await eventRows(EV, e.order.id)).toHaveLength(1);
    expect(Number((await orderRow(e.order.id)).items_version)).toBe(2);
    expect((await itemRows(e.order.id)).filter((i) => i.status === 'active')).toHaveLength(3);
  }, T);

  it('event publish failure rolls the whole change back (items, version, counters) - one tx', async () => {
    const e = await edit();
    const before = await snap(e);
    const x = await changeFails(e, await mk(e, { add: [add(O.ure)], remove: [rm(e.itemOf('CBC').id)] }), { failEvent: EV });
    expect(x.code).toBe('common.internal');
    expect(await snap(e)).toEqual(before);
  }, T);

  it('billing.counter_busy that persists -> 503 billing.counter_busy surfaced, nothing stored, no event', async () => {
    const e = await edit();
    const before = await snap(e);
    const b = await mk(e, { add: [add(O.ure)] });
    const x = await changeFails(e, b, { billing: busyBilling(e) });
    expect(x.code).toBe('billing.counter_busy'); expect(x.statusCode).toBe(503);
    expect(await snap(e)).toEqual(before);
  }, T);

  it('billing.counter_busy once (transient): either a retried success (one change, one event, one new invoice) or a clean failure - never a half-written change', async () => {
    const e = await edit();
    const before = await snap(e);
    const b = await mk(e, { add: [add(O.ure)], remove: [rm(e.itemOf('GLU').id)] });
    (e.billing as any).failNext('issueOrderInvoice', 'billing.counter_busy');
    let ok = true;
    try { await change(e, b); } catch (err: any) { ok = false; expect(err.code).toBe('billing.counter_busy'); }
    if (ok) {
      expect(await eventRows(EV, e.order.id)).toHaveLength(1);
      expect(Number((await orderRow(e.order.id)).items_version)).toBe(2);
      expect((await billingIds(e)).invoiceIds).toHaveLength(2);
      expect((await itemRows(e.order.id)).filter((i) => i.orderable_id === O.ure)).toHaveLength(1);
    } else expect(await snap(e)).toEqual(before);
  }, T);
});

describe('F13 security (07 §6.1, §6.2, §6.4, §5)', () => {
  it('needs frontdesk.order.edit: without it 403 auth.forbidden, nothing stored, no billing call', async () => {
    const e = await edit();
    const before = await snap(e);
    expect((await changeFails(e, { remove: [rm(e.items[0].id)] }, { grants: [INVOICE, 'frontdesk.order.read'] })).code).toBe('auth.forbidden');
    expect(await snap(e)).toEqual(before);
    expect(mutations(e)).toEqual([]);
  }, T);

  it('a CASH addition also needs billing.invoice.issue (checked before any write): order.edit alone -> 403; removal-only and credit additions do not need it', async () => {
    const e = await edit();
    const b = await mk(e, { add: [add(O.ure)] });
    const before = await snap(e);
    const x = await changeFails(e, b, { grants: [EDIT] });
    expect(x.code).toBe('auth.forbidden'); expect(x.statusCode).toBe(403);
    expect(await snap(e)).toEqual(before);
    expect(mutations(e)).toEqual([]);
  }, T);

  it('tenant isolation: tenant B calling with tenant A\'s order id -> 404, owner check shows zero changes', async () => {
    const e = await edit();
    const before = await snap(e);
    const x = await changeFails(e, { remove: [rm(e.items[0].id)] }, { tenant: TENANT_B, centreIds: [CENTRE_A2], ifMatch: '"1"' });
    expect(x.code).toBe('common.not_found'); expect(x.statusCode).toBe(404);
    expect(await snap(e)).toEqual(before);
    expect(mutations(e)).toEqual([]);
  }, T);

  it('cross-centre: an actor scoped to centre A2 gets 404 for a centre A1 order (not 403); nothing changes', async () => {
    const e = await edit();
    const before = await snap(e);
    const x = await changeFails(e, { remove: [rm(e.items[0].id)] }, { centreIds: [CENTRE_A2] });
    expect(x.code).toBe('common.not_found'); expect(x.statusCode).toBe(404);
    expect(await snap(e)).toEqual(before);
  }, T);

  it('unknown order id -> 404 common.not_found', async () => {
    const e = await edit();
    expect((await changeFails(e, { remove: [rm(e.items[0].id)] }, { ifMatch: '"1"' }, uid())).code).toBe('common.not_found');
  }, T);

  it('PHI: patient name / registration no never reach the logs, the event payload or an error detail', async () => {
    const e = await edit();
    const r = await change(e, await mk(e, { add: [add(O.ure)], remove: [rm(e.itemOf('GLU').id)] }));
    const all = r.probe.logs.join('\n') + JSON.stringify((await eventRows(EV, e.order.id)).map((x) => x.envelope));
    expect(all).not.toContain(e.patient.full_name); expect(all).not.toContain(e.order.registration_no);
    expect(all).not.toContain(e.itemOf('GLU').name);
    const f = await edit({ items: [{ ...CBC, lab: 'in_progress' }] });
    const x = await changeFails(f, { remove: [rm(f.items[0].id)] });
    expect(JSON.stringify({ d: x.detail, e: x.errors, m: x.message })).not.toContain(f.patient.full_name);
  }, T);

  it('an order whose items are approved in the lab still follows the removal guard (approved -> removable false -> 409)', async () => {
    const e = await edit();
    approveResult(e, e.itemOf('CBC').id);
    expect((await changeFails(e, await mk(e, { remove: [rm(e.itemOf('CBC').id)] }))).code).toBe('frontdesk.order_not_editable');
  }, T);
});
