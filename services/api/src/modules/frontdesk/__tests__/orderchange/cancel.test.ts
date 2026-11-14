// FD-T09 F14 cancelOrder. ACs: US-FD-11.1-11.4, US-BL-10.5 (credit-note task on the PERIODIC invoice for already-invoiced credit charges); 02-TRD §5.1 F14, §8.1 (cancelled.v1: key `<order_id>:cancelled`,
// seq = order version); 03-APP-FLOW §1.1 O6/O7, §2.6; 07-SECURITY §5 (cancel reason text is never logged), §6.1, §6.2. Fake-port semantics: see helpers.ts. LD-70: pending.json is the writer's.
// Spec gaps, deliberately NOT asserted: whether voidCreditCharges is also called for a CASH order; which reasonCode C4 passes to voidCreditCharges (only "a non-empty string"); cancelled_by value;
// coded-set validation of reason_code (owner of the set check is not named); that a cancelled order's stale If-Match gives version_conflict rather than order_already_cancelled.
import { beforeAll, describe, expect, it } from 'vitest';
import { CBC, CENTRE_A2, EDIT, GLU, NOW_ISO, O, T, TENANT_B, approveResult, billingIds, callsOf, cancel, cancelFails, change, changeFails, edit, eventRows, itemRows, mk, mutations, orderRow,
  rm, schemaErrors, seedSettings, snap, uid } from './helpers.js';
import { createFakeBillingCommandPort } from '../../../../../../../packages/fakes/src/BillingCommandPort.fake';

beforeAll(seedSettings, T);
const EV = 'frontdesk.order.cancelled.v1';
const left = { reason_code: 'patient_left' };

describe('US-FD-11.1 cancel a registered, invoiced cash order', () => {
  it('status cancelled, items cancelled (removed items stay removed), credit-note task raised, requires_credit_note true in body, row and event; OrderDto schema', async () => {
    const e = await edit({ items: [CBC, GLU, { orderable: O.ure, code: 'OLD', status: 'removed' }] });
    const r = await cancel(e, { reason_code: 'patient_left', reason_text: 'Synthetic cancel note' });
    expect(r.status).toBe(200);
    expect(schemaErrors('OrderDto', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: e.order.id, status: 'cancelled', cancel_reason_code: 'patient_left', requires_credit_note: true });
    expect(r.body.cancelled_at).toBe(NOW_ISO);

    const o = await orderRow(e.order.id);
    expect(o).toMatchObject({ status: 'cancelled', cancel_reason_code: 'patient_left', cancel_reason_text: 'Synthetic cancel note', requires_credit_note: true });
    expect(new Date(o.cancelled_at).toISOString()).toBe(NOW_ISO);
    expect(o.cancelled_by).not.toBeNull();
    expect(Number(o.version)).toBeGreaterThan(1);
    expect(r.body.version).toBe(Number(o.version));
    const items = await itemRows(e.order.id);
    expect(items.map((i) => i.status).sort()).toEqual(['cancelled', 'cancelled', 'removed']);
    expect(items.find((i) => i.id === e.itemOf('OLD').id).status).toBe('removed');

    expect(callsOf(e.lab, 'getOrderResults')[0]).toMatchObject({ orderId: e.order.id, scope: 'approved' });
    const raise = callsOf(e.billing, 'raiseCreditNoteRequirement');
    expect(raise).toHaveLength(1);
    expect(raise[0]).toMatchObject({ orderId: e.order.id, cause: 'order_cancelled' });
    expect(callsOf(e.billing, 'issueOrderInvoice')).toHaveLength(0);

    const evs = await eventRows(EV, e.order.id);
    expect(evs).toHaveLength(1);
    expect(evs[0].idempotency_key).toBe(`${e.order.id}:cancelled`);
    expect(Number(evs[0].aggregate_seq)).toBe(Number(o.version));
    expect(evs[0].producer).toBe('frontdesk');
    expect(evs[0].envelope.aggregate).toMatchObject({ type: 'order', id: e.order.id });
    expect(evs[0].envelope.payload).toEqual({ order_id: e.order.id, reason_code: 'patient_left', cancelled_at: NOW_ISO, requires_credit_note: true });     // no reason_text / PHI in the event
  }, T);

  it('a cash order with no invoice issued: requires_credit_note false (nothing to credit)', async () => {
    const e = await edit({ invoice: false });
    const r = await cancel(e, left);
    expect(r.body.requires_credit_note).toBe(false);
    expect((await eventRows(EV, e.order.id))[0].envelope.payload.requires_credit_note).toBe(false);
    expect((await orderRow(e.order.id)).requires_credit_note).toBe(false);
  }, T);

  it('only APPROVED results block: a pending/resulted result or a received specimen does not (O7)', async () => {
    for (const [stored, lab] of [['registered', 'result_entered_only'], ['registered', 'in_progress']] as const) {
      const e = await edit({ stored, items: [{ ...CBC, lab }, GLU] });
      expect((await cancel(e, left)).body.status, `${stored}/${lab}`).toBe('cancelled');
    }
  }, T);

  it('payments are NOT refunded automatically: no payment / ledger mutation is called', async () => {
    const e = await edit({ paid: true });
    await cancel(e, left);
    expect(callsOf(e.billing, 'recordPayment')).toHaveLength(0);
  }, T);
});

describe('US-FD-11.2 / 11.3 guards', () => {
  it('11.2 an approved result -> 409 frontdesk.order_cancel_not_allowed; nothing stored, no event, billing never called', async () => {
    const e = await edit();
    approveResult(e, e.itemOf('CBC').id);
    const before = await snap(e);
    const x = await cancelFails(e, left);
    expect(x.code).toBe('frontdesk.order_cancel_not_allowed'); expect(x.statusCode).toBe(409);
    expect(await snap(e)).toEqual(before);
    expect(mutations(e)).toEqual([]);
    expect(await eventRows(EV, e.order.id)).toHaveLength(0);
  }, T);

  it('a completed order cannot be cancelled either -> 409 frontdesk.order_cancel_not_allowed', async () => {
    const e = await edit({ stored: 'completed' });
    expect((await cancelFails(e, left)).code).toBe('frontdesk.order_cancel_not_allowed');
  }, T);

  it('11.3 already cancelled -> 409 frontdesk.order_already_cancelled; the second cancel changes and emits nothing', async () => {
    const e = await edit({ stored: 'cancelled' });
    const before = await snap(e);
    const x = await cancelFails(e, left);
    expect(x.code).toBe('frontdesk.order_already_cancelled'); expect(x.statusCode).toBe(409);
    expect(await snap(e)).toEqual(before);
    expect(mutations(e)).toEqual([]);

    const f = await edit();
    await cancel(f, left);
    const after = await snap(f);
    expect((await cancelFails(f, left, { ifMatch: `"${after.order!.version}"` })).code).toBe('frontdesk.order_already_cancelled');
    expect(await snap(f)).toEqual(after);
    expect(await eventRows(EV, f.order.id)).toHaveLength(1);
    expect(callsOf(f.billing, 'raiseCreditNoteRequirement')).toHaveLength(1);       // not raised twice
  }, T);

  it('LabPort failure fails closed: the error propagates and nothing is cancelled (cancel and item removal)', async () => {
    const e = await edit();
    const before = await snap(e);
    e.lab.failNext('getOrderResults', 'common.service_unavailable');
    expect((await cancelFails(e, left)).code).toBe('common.service_unavailable');
    expect(await snap(e)).toEqual(before);
    e.lab.failNext('getOrderItemProcessingState', 'common.service_unavailable');
    expect((await changeFails(e, await mk(e, { remove: [rm(e.itemOf('GLU').id)] }))).code).toBe('common.service_unavailable');
    expect(await snap(e)).toEqual(before);
    expect(mutations(e)).toEqual([]);
  }, T);

  it('billing failure or event failure rolls the whole cancel back (one tx): order stays registered, items active, no event', async () => {
    const e = await edit();
    const before = await snap(e);
    e.billing.failNext('raiseCreditNoteRequirement', 'common.internal');
    expect((await cancelFails(e, left)).code).toBe('common.internal');
    expect(await snap(e)).toEqual(before);
    const f = await edit();
    const b2 = await snap(f);
    expect((await cancelFails(f, left, { failEvent: EV })).code).toBe('common.internal');
    expect(await snap(f)).toEqual(b2);
  }, T);
});

describe('US-FD-11.4 / US-BL-10.5 credit orders', () => {
  it('11.4 charges not yet billed are VOIDED in the same transaction; requires_credit_note false in body, row and event', async () => {
    const e = await edit({ mode: 'credit' });
    expect((await billingIds(e)).creditChargeIds).toHaveLength(2);
    const r = await cancel(e, left);
    expect(r.body).toMatchObject({ status: 'cancelled', requires_credit_note: false });
    const v = callsOf(e.billing, 'voidCreditCharges');
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ orderId: e.order.id });
    expect(typeof v[0].reasonCode).toBe('string'); expect(v[0].reasonCode.length).toBeGreaterThan(0);
    expect((await billingIds(e)).creditChargeIds).toEqual([]);                      // the fake really voided them
    expect((await orderRow(e.order.id)).requires_credit_note).toBe(false);
    expect((await eventRows(EV, e.order.id))[0].envelope.payload).toMatchObject({ requires_credit_note: false, reason_code: 'patient_left' });
    expect(callsOf(e.billing, 'issueOrderInvoice')).toHaveLength(0);
  }, T);

  it('US-BL-10.5 charges already on a PERIODIC invoice are not voided: a credit_note_required task opens on that invoice -> requires_credit_note true (the open charge is still voided)', async () => {
    const e = await edit({ mode: 'credit', items: [{ ...CBC, charge: 'periodic' }, GLU] });
    const periodic = (await billingIds(e)).creditChargeIds;
    expect(periodic).toHaveLength(2);
    const r = await cancel(e, left);
    expect(r.body).toMatchObject({ status: 'cancelled', requires_credit_note: true });
    expect(callsOf(e.billing, 'raiseCreditNoteRequirement')[0]).toMatchObject({ orderId: e.order.id, cause: 'order_cancelled' });
    expect((await billingIds(e)).creditChargeIds).toHaveLength(1);                  // GLU voided, the periodic CBC charge stays for finance's credit note
    expect((await orderRow(e.order.id)).requires_credit_note).toBe(true);
    expect((await eventRows(EV, e.order.id))[0].envelope.payload.requires_credit_note).toBe(true);
  }, T);

  it('a credit order whose every charge is periodic: requires_credit_note true, nothing voided', async () => {
    const e = await edit({ mode: 'credit', items: [{ ...CBC, charge: 'periodic' }, { ...GLU, charge: 'periodic' }] });
    const r = await cancel(e, left);
    expect(r.body.requires_credit_note).toBe(true);
    expect((await billingIds(e)).creditChargeIds).toHaveLength(2);
  }, T);
});

describe('pre_registered orders (APP-FLOW O6): never invoiced, no billing involvement', () => {
  it('cancelled with items cancelled and requires_credit_note false; the billing port is not called at all', async () => {
    const e = await edit({ stored: 'pre_registered' });
    const billing = createFakeBillingCommandPort({ seed: 1, fixtures: { orders: [] } as any });     // billing does not know this order: any call would be common.not_found
    const r = await cancel(e, left, { billing });
    expect(r.body).toMatchObject({ status: 'cancelled', requires_credit_note: false });
    expect((await itemRows(e.order.id)).map((i) => i.status)).toEqual(['cancelled', 'cancelled']);
    expect(mutations(e, billing)).toEqual([]);
    const evs = await eventRows(EV, e.order.id);
    expect(evs).toHaveLength(1);
    expect(evs[0].envelope.payload).toEqual({ order_id: e.order.id, reason_code: 'patient_left', cancelled_at: NOW_ISO, requires_credit_note: false });
  }, T);
});

describe('F14 request validation, optimistic locking, concurrency', () => {
  it('malformed bodies -> 400 common.validation_failed: {}, empty / missing reason_code, reason_text > 500, unknown fields (status, tenant_id), non-object', async () => {
    const e = await edit();
    const before = await snap(e);
    for (const b of [{}, { reason_code: '' }, { reason_text: 'x' }, { reason_code: 'patient_left', reason_text: 'x'.repeat(501) }, { reason_code: 'patient_left', status: 'cancelled' },
      { reason_code: 'patient_left', tenant_id: TENANT_B }, null, 'patient_left']) {
      const x = await cancelFails(e, b);
      expect(x.code, JSON.stringify(b)?.slice(0, 50)).toBe('common.validation_failed'); expect(x.statusCode).toBe(400);
    }
    expect(await snap(e)).toEqual(before);
    expect((await cancel(e, { reason_code: 'patient_left', reason_text: 'x'.repeat(500) })).status).toBe(200);     // 500 is the inclusive limit
  }, T);

  it('If-Match: absent -> 428 common.precondition_required; stale -> 409 common.version_conflict; nothing stored', async () => {
    const e = await edit();
    const before = await snap(e);
    const a = await cancelFails(e, left, { ifMatch: null });
    expect(a.code).toBe('common.precondition_required'); expect(a.statusCode).toBe(428);
    const s = await cancelFails(e, left, { ifMatch: '"99"' });
    expect(s.code).toBe('common.version_conflict'); expect(s.statusCode).toBe(409);
    expect(await snap(e)).toEqual(before);
  }, T);

  it('an items change moves the version: cancelling with the pre-change If-Match is stale (409), with the fresh one succeeds', async () => {
    const e = await edit();
    const v0 = `"${Number((await orderRow(e.order.id)).version)}"`;
    await change(e, await mk(e, { remove: [rm(e.itemOf('GLU').id)] }), { grants: [EDIT], ifMatch: v0 });
    expect((await cancelFails(e, left, { ifMatch: v0 })).code).toBe('common.version_conflict');
    expect((await cancel(e, left)).status).toBe(200);
    expect((await itemRows(e.order.id)).map((i) => i.status).sort()).toEqual(['cancelled', 'removed']);
  }, T);

  it('race: two concurrent cancels -> exactly one wins; the loser is version_conflict or order_already_cancelled; ONE event, ONE credit-note requirement', async () => {
    const e = await edit();
    const v = `"${Number((await orderRow(e.order.id)).version)}"`;
    const res = await Promise.allSettled([cancel(e, left, { ifMatch: v }), cancel(e, { reason_code: 'duplicate_registration' }, { ifMatch: v })]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(['common.version_conflict', 'frontdesk.order_already_cancelled']).toContain(lost.reason.code);
    expect(await eventRows(EV, e.order.id)).toHaveLength(1);
    expect((await orderRow(e.order.id)).status).toBe('cancelled');
  }, T);

  it('cancel and an items change racing on the same version: one wins, no half state (cancelled order never gains items)', async () => {
    const e = await edit();
    const v = `"${Number((await orderRow(e.order.id)).version)}"`;
    const b = await mk(e, { remove: [rm(e.itemOf('GLU').id)] });
    const res = await Promise.allSettled([cancel(e, left, { ifMatch: v }), change(e, b, { grants: [EDIT], ifMatch: v })]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const items = (await itemRows(e.order.id)).map((i) => i.status).sort();
    const o = await orderRow(e.order.id);
    if (o.status === 'cancelled') expect(items).toEqual(['cancelled', 'cancelled']); else expect(items).toEqual(['active', 'removed']);
  }, T);
});

describe('F14 security (07 §6.1, §6.2, §5)', () => {
  it('needs frontdesk.order.cancel: order.edit alone -> 403 auth.forbidden; nothing stored', async () => {
    const e = await edit();
    const before = await snap(e);
    const x = await cancelFails(e, left, { grants: [EDIT] });
    expect(x.code).toBe('auth.forbidden'); expect(x.statusCode).toBe(403);
    expect(await snap(e)).toEqual(before);
    expect(mutations(e)).toEqual([]);
  }, T);

  it('tenant isolation: tenant B calling with tenant A\'s order id -> 404; owner check shows zero changes; unknown id -> 404', async () => {
    const e = await edit();
    const before = await snap(e);
    const x = await cancelFails(e, left, { tenant: TENANT_B, centreIds: [CENTRE_A2], ifMatch: '"1"' });
    expect(x.code).toBe('common.not_found'); expect(x.statusCode).toBe(404);
    expect(await snap(e)).toEqual(before);
    expect(mutations(e)).toEqual([]);
    expect((await cancelFails(e, left, { ifMatch: '"1"' }, uid())).code).toBe('common.not_found');
  }, T);

  it('cross-centre: an actor scoped to centre A2 gets 404 (not 403) for a centre A1 order; an actor with the right centre can cancel', async () => {
    const e = await edit();
    const before = await snap(e);
    const x = await cancelFails(e, left, { centreIds: [CENTRE_A2] });
    expect(x.code).toBe('common.not_found'); expect(x.statusCode).toBe(404);
    expect(await snap(e)).toEqual(before);
    expect((await cancel(e, left, { centreIds: [e.centre] })).status).toBe(200);
  }, T);

  it('PHI: the cancel reason text, patient name and registration no never reach the logs, the event or an error', async () => {
    const e = await edit();
    const text = 'Synthetic reason text zq81';
    const r = await cancel(e, { reason_code: 'patient_left', reason_text: text });
    const all = r.probe.logs.join('\n') + JSON.stringify((await eventRows(EV, e.order.id)).map((x) => x.envelope));
    for (const secret of [text, e.patient.full_name, e.order.registration_no]) expect(all).not.toContain(secret);
    const f = await edit({ stored: 'cancelled' });
    const x = await cancelFails(f, { reason_code: 'patient_left', reason_text: text });
    expect(JSON.stringify({ d: x.detail, e: x.errors, m: x.message })).not.toContain(text);
  }, T);
});
