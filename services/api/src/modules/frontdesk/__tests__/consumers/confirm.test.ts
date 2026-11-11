// FD-T12 review item 1: F12 confirmPreRegisteredOrder (02-TRD §5.1 F12; PRD US-FD-12.2: "When the patient arrives and I confirm, Then the order becomes `registered`, invoice + payment as in US-FD-03,
// and `frontdesk.order.created.v1` is emitted once"). Same registration/invoice path as F9 (registration.test.ts): quote with F8 using the stored order context, then confirm with that fingerprint.
// The pre_registered order is made by the REAL booking consumer (US-FD-12.1), so the two halves of US-FD-12 are proven together. Harness: ./desk.ts. LD-70: pending.json is the writer's.
// Spec gaps, deliberately NOT asserted: HTTP status (200 vs 201: only 2xx + RegistrationResult shape), what happens to the replaced stored items on items_override beyond "active items = the override".
import { describe, expect, it, vi } from 'vitest';
import { schemaErrors } from '../patients/helpers.js';
import { NET, draft, knowRecipient, pay, quoteFp } from '../registration/helpers.js';
import { CENTRE, CENTRE_A2, NOW_ISO, O, T, TENANT_A, TENANT_B, confirmedPayload, consume, envelope, eventRows, itemRows, orderRow, ordersBySource, seedOrder, seedPatient } from './helpers.js';
import { CREATE, confirm, confirmFails, rworld, uid } from './desk.js';

vi.setConfig({ testTimeout: T });
const CREATED = 'frontdesk.order.created.v1';

/** A confirmed centre_visit booking -> pre_registered order (via the real consumer), plus the F8 fingerprint over the stored context. */
async function preRegistered(o: { side?: 'a' | 'b'; orderables?: string[] } = {}) {
  const side = o.side ?? 'a';
  const tenant = side === 'a' ? TENANT_A : TENANT_B;
  const patient = await seedPatient(side, {}, { sms: true });
  const w = rworld();
  knowRecipient(w, tenant, patient.id, true, patient.phone_e164);
  const payload = confirmedPayload(patient.id, { centre_id: CENTRE[side], ...(o.orderables ? { orderable_ids: o.orderables } : {}) });
  await consume('confirmed', envelope('confirmed', payload, { aggregateId: payload['booking_id'] as string, seq: 1, tenant }), { w, tenant });
  const [order] = await ordersBySource(tenant, 'engagement_booking', payload.booking_id as string);
  const d = draft({ patient: { patient_id: patient.id }, centre_id: CENTRE[side], ...(o.orderables ? { items: o.orderables.map((orderable_id) => ({ orderable_id })) } : {}) });
  const fp = await quoteFp(w, d, { tenant, centreIds: [CENTRE[side]] });
  return { patient, w, order, fp, tenant, side, body: { quote_fingerprint: fp, payments: [pay(o.orderables?.length === 1 ? 50000 : NET)] } };
}

describe('US-FD-12.2 confirm a pre_registered order (F12)', () => {
  it('becomes registered with invoice + payment as in US-FD-03 and EXACTLY ONE frontdesk.order.created.v1 (none existed before)', async () => {
    const p = await preRegistered();
    expect(p.order.status).toBe('pre_registered');
    expect(await eventRows(CREATED, p.order.id)).toHaveLength(0);
    expect(p.w.billingFake.calls('issueOrderInvoice')).toHaveLength(0);

    const r = await confirm(p.order.id, p.body, { w: p.w });
    expect(r.status).toBeGreaterThanOrEqual(200); expect(r.status).toBeLessThan(300);
    expect(r.body.order.id).toBe(p.order.id);                                       // same order: no second order is created
    expect(schemaErrors('RegistrationResult', r.body)).toEqual([]);

    const o = await orderRow(p.order.id);
    expect(o).toMatchObject({ status: 'registered', source: 'engagement_booking', patient_id: p.patient.id, centre_id: CENTRE.a });
    expect(o.registration_no).toBe(r.body.order.registration_no);
    expect(new Date(o.registered_at).toISOString()).toBe(NOW_ISO);                   // stamped at confirm time (ctx.now), as F9

    const inv = p.w.billingFake.calls('issueOrderInvoice');
    expect(inv).toHaveLength(1);
    expect(inv[0].input as any).toMatchObject({ orderId: p.order.id, patientId: p.patient.id, purpose: 'registration', expectedFingerprint: p.fp });
    const pays = p.w.billingFake.calls('recordPayment');
    expect(pays).toHaveLength(1);
    expect(pays[0].input as any).toMatchObject({ orderId: p.order.id, methodCode: 'cash', idempotencyKey: `${p.order.id}:reg:0` });

    const evs = await eventRows(CREATED, p.order.id);
    expect(evs).toHaveLength(1);
    expect(evs[0].idempotency_key).toBe(`${p.order.id}:created`);
    expect(evs[0].envelope.payload).toMatchObject({ order_id: p.order.id, patient_id: p.patient.id });
  });

  it('confirming twice: the second is common.immutable_record (not pre_registered any more) and invoice/payment/event stay at one', async () => {
    const p = await preRegistered();
    await confirm(p.order.id, p.body, { w: p.w });
    const e = await confirmFails(p.order.id, p.body, { w: p.w });
    expect(e.code).toBe('common.immutable_record');
    expect(p.w.billingFake.calls('issueOrderInvoice')).toHaveLength(1);
    expect(p.w.billingFake.calls('recordPayment')).toHaveLength(1);
    expect(await eventRows(CREATED, p.order.id)).toHaveLength(1);
  });

  it('an order that is not pre_registered (registered / cancelled) -> common.immutable_record; nothing invoiced, nothing emitted', async () => {
    for (const status of ['registered', 'cancelled'] as const) {
      const p = await preRegistered();
      const target = await seedOrder('a', p.patient.id, { status, ...(status === 'cancelled' ? { cancelled_at: '2026-11-06T00:00:00Z', cancel_reason_code: 'patient_request' } : {}) });
      const e = await confirmFails(target.id, p.body, { w: p.w });
      expect(e.code, status).toBe('common.immutable_record');
      expect(p.w.billingFake.calls('issueOrderInvoice'), status).toHaveLength(0);
      expect(await eventRows(CREATED, target.id), status).toHaveLength(0);
      expect((await orderRow(target.id)).status, status).toBe(status);
    }
  });

  it('items_override replaces the stored items: the active items after confirm are exactly the override (quoted with F8 over the same context)', async () => {
    const p = await preRegistered({ orderables: [O.cbc] });
    const w = p.w;
    const d = draft({ patient: { patient_id: p.patient.id }, centre_id: CENTRE.a, items: [{ orderable_id: O.cbc }] });
    const fp = await quoteFp(w, d, { tenant: TENANT_A, centreIds: [CENTRE.a] });
    const r = await confirm(p.order.id, { quote_fingerprint: fp, payments: [pay(50000)], items_override: { items: [{ orderable_id: O.cbc }] } }, { w });
    expect(r.body.order.id).toBe(p.order.id);
    const active = (await itemRows(p.order.id)).filter((i) => i.status === 'active');
    expect(active.map((i) => i.orderable_id)).toEqual([O.cbc]);
  });

  it('stale / wrong quote fingerprint -> common.version_conflict (as F9); the order stays pre_registered and nothing is invoiced or emitted', async () => {
    const p = await preRegistered();
    const e = await confirmFails(p.order.id, { ...p.body, quote_fingerprint: 'ab'.repeat(32) }, { w: p.w });
    expect(e.code).toBe('common.version_conflict');
    expect((await orderRow(p.order.id)).status).toBe('pre_registered');
    expect(await eventRows(CREATED, p.order.id)).toHaveLength(0);
    expect(p.w.billingFake.calls('issueOrderInvoice')).toHaveLength(0);
  });

  it('a failure while publishing the event rolls the confirm back: still pre_registered, no created event', async () => {
    const p = await preRegistered();
    await expect(confirm(p.order.id, p.body, { w: p.w, failEvent: CREATED })).rejects.toBeTruthy();
    expect((await orderRow(p.order.id)).status).toBe('pre_registered');
    expect(await eventRows(CREATED, p.order.id)).toHaveLength(0);
  });

  it('If-Match: absent -> common.precondition_required; stale version -> common.version_conflict; order unchanged', async () => {
    const p = await preRegistered();
    expect((await confirmFails(p.order.id, p.body, { w: p.w, ifMatch: null })).code).toBe('common.precondition_required');
    expect((await confirmFails(p.order.id, p.body, { w: p.w, ifMatch: '"999"' })).code).toBe('common.version_conflict');
    expect((await orderRow(p.order.id)).status).toBe('pre_registered');
  });

  it('bad body -> common.validation_failed: missing quote_fingerprint, items_override with 0 items, more than 50 items', async () => {
    const p = await preRegistered();
    const bad = [{ payments: p.body.payments }, { ...p.body, items_override: { items: [] } },
      { ...p.body, items_override: { items: Array.from({ length: 51 }, () => ({ orderable_id: O.cbc })) } }];
    for (const b of bad) expect((await confirmFails(p.order.id, b, { w: p.w })).code).toBe('common.validation_failed');
    expect((await orderRow(p.order.id)).status).toBe('pre_registered');
  });

  it('permission frontdesk.registration.create is required: order.read / order.edit alone -> auth.forbidden; billing.invoice.issue is the second assert (07-SECURITY F9 row)', async () => {
    const p = await preRegistered();
    expect((await confirmFails(p.order.id, p.body, { w: p.w, grants: ['frontdesk.order.read', 'frontdesk.order.edit'] })).code).toBe('auth.forbidden');
    expect((await confirmFails(p.order.id, p.body, { w: p.w, grants: [CREATE] })).code).toBe('auth.forbidden');
    expect((await orderRow(p.order.id)).status).toBe('pre_registered');
    expect(p.w.billingFake.calls('issueOrderInvoice')).toHaveLength(0);
  });

  it('centre scope + tenant isolation: an actor outside the order centre, or another tenant, gets 404 common.not_found (existence not confirmed)', async () => {
    const p = await preRegistered();
    expect((await confirmFails(p.order.id, p.body, { w: p.w, centreIds: [CENTRE_A2] })).code).toBe('common.not_found');
    expect((await confirmFails(p.order.id, p.body, { w: p.w, tenant: TENANT_B })).code).toBe('common.not_found');
    expect((await confirmFails(uid(), p.body, { w: p.w })).code).toBe('common.not_found');
    expect((await orderRow(p.order.id)).status).toBe('pre_registered');
  });
});
