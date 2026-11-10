// FD-T12 booking consumers over a real PG17 tx: engagement.booking.confirmed.v1 and engagement.booking.cancelled.v1 (X5: same logic as FrontdeskPort.createOrderFromBooking).
// PRD US-FD-12.1-.4, .6 (.2 = the later desk confirm, FD-T06/T11; .5 = the port, FD-T11); 02-TRD §8.2; 03-IC §3.22/§3.24; 08 R7 (home_collection: no order, review flag), A2.12 (flag, no finance item).
// Seq rule (03-IC §3.24 Ordering, TRD §8.2): the consumer records `booking_links.last_seq`; a confirmation whose aggregate.seq is lower than a recorded cancellation is ignored.
// Order cancel reason is the C4 code `booking_cancelled` (the engagement reason_code is NOT an order cancel reason and is not stored on the order). Seams + harness: ./helpers.ts. Synthetic data only.
import { describe, expect, it, vi } from 'vitest';
import { CENTRE, IC_EXAMPLES, O, T, TENANT_A, TENANT_B, cancelledPayload, confirmedPayload, consume, consumeQuietly, envelope, eventRows, flagRows, itemRows, linkRows, orderRow, ordersBySource, ownerRows, seed, seedOrder, seedPatient, uid, type CO } from './helpers.js';

vi.setConfig({ testTimeout: T });
const probeOf = (): NonNullable<CO['probe']> => ({ sms: [], writes: [] });
const confirmEnv = (payload: Record<string, unknown>, seq = 1, o: Record<string, unknown> = {}) => envelope('confirmed', payload, { aggregateId: payload['booking_id'] as string, seq, ...o });
const cancelEnv = (payload: Record<string, unknown>, seq = 2, o: Record<string, unknown> = {}) => envelope('cancelled', payload, { aggregateId: payload['booking_id'] as string, seq, ...o });
/** A confirmed centre_visit booking and the pre_registered order the consumer made from it. */
async function preRegistered() {
  const patient = await seedPatient('a');
  const payload = confirmedPayload(patient.id);
  await consume('confirmed', confirmEnv(payload, 1));
  const [order] = await ordersBySource(TENANT_A, 'engagement_booking', payload.booking_id as string);
  return { patient, payload, order };
}
/** A REGISTERED order linked to a booking link (centre_visit: source engagement_booking / booking id; home_collection: source home_collection / visit id). */
async function registeredLinked(source: 'engagement_booking' | 'home_collection', ref = uid()) {
  const patient = await seedPatient('a');
  const order = await seedOrder('a', patient.id, { status: 'registered', source, source_ref_id: ref, collection_mode: source === 'home_collection' ? 'home' : 'centre' });
  await seed('frontdesk.booking_links', { tenant_id: TENANT_A, source, source_ref_id: ref, order_id: order.id, idempotency_key: `k-${ref}`, state: 'converted', last_seq: 1 });
  return { patient, order, ref };
}

describe('engagement.booking.confirmed.v1 (US-FD-12.1)', () => {
  it('centre_visit -> one pre_registered order (source engagement_booking, collection_mode centre, items for the orderables), link converted; NO frontdesk.order.created.v1, no invoice', async () => {
    const patient = await seedPatient('a');
    const payload = confirmedPayload(patient.id);
    const probe = probeOf();
    await consume('confirmed', confirmEnv(payload), { probe });
    const orders = await ordersBySource(TENANT_A, 'engagement_booking', payload.booking_id as string);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ status: 'pre_registered', source: 'engagement_booking', collection_mode: 'centre', patient_id: patient.id, centre_id: CENTRE.a, registered_at: null });
    expect((await itemRows(orders[0].id)).map((i: any) => i.orderable_id).sort()).toEqual([O.cbc, O.glu].sort());
    expect((await linkRows(TENANT_A, 'engagement_booking', payload.booking_id as string))[0]).toMatchObject({ order_id: orders[0].id, state: 'converted' });
    expect(await eventRows('frontdesk.order.created.v1', orders[0].id)).toEqual([]);
    expect(probe.writes.filter((s) => /invoice|ledger/i.test(s))).toEqual([]);     // nothing billing-side is written through ctx.tx (billing itself is a port; the fake would have no invoice for this order)
  });
  it('duplicate delivery (same event, and the same facts under a new event_id) creates nothing new', async () => {
    const patient = await seedPatient('a');
    const payload = confirmedPayload(patient.id);
    const e = confirmEnv(payload);
    await consume('confirmed', e);
    await expect(consume('confirmed', e)).resolves.toBeUndefined();
    await expect(consume('confirmed', confirmEnv(payload))).resolves.toBeUndefined();
    expect(await ordersBySource(TENANT_A, 'engagement_booking', payload.booking_id as string)).toHaveLength(1);
    expect(await linkRows(TENANT_A, 'engagement_booking', payload.booking_id as string)).toHaveLength(1);
  });
  it('unknown payload / envelope fields are ignored: a payload cannot register the order, pick a status, a price or a source', async () => {
    const patient = await seedPatient('a');
    const payload = confirmedPayload(patient.id, { confirm_immediately: true, confirmImmediately: true, status: 'registered', source: 'front_desk', unit_price_paisa: 1, discounts: [{ scope: 'bill', pct: 100 }], future_field: 1 });
    await consume('confirmed', confirmEnv(payload, 1, { extra: { tenant_override: TENANT_B } }));
    const [o] = await ordersBySource(TENANT_A, 'engagement_booking', payload.booking_id as string);
    expect(o).toMatchObject({ status: 'pre_registered', source: 'engagement_booking' });
    expect((await itemRows(o.id)).every((i: any) => Number(i.unit_price_paisa) !== 1)).toBe(true);
    expect(await ownerRows('frontdesk.discounts', 'order_id = $1', [o.id])).toEqual([]);
  });
});

describe('home_collection confirmation -> no order (US-FD-12.6, 08 R7)', () => {
  it('03-IC §3.22 example verbatim: resolves, creates no order, no link, no patient, no flag, writes nothing', async () => {
    const probe = probeOf();
    await expect(consume('confirmed', envelope('confirmed', { ...IC_EXAMPLES.confirmedHome }, { aggregateId: IC_EXAMPLES.confirmedHome.booking_id }), { probe })).resolves.toBeUndefined();
    expect(await ordersBySource(TENANT_A, 'engagement_booking', IC_EXAMPLES.confirmedHome.booking_id)).toEqual([]);
    expect(await ownerRows('frontdesk.booking_links', 'source_ref_id = $1', [IC_EXAMPLES.confirmedHome.booking_id])).toEqual([]);
    expect(probe.writes).toEqual([]);
  });
  it('an existing patient + real orderables: still no order and no link', async () => {
    const patient = await seedPatient('a');
    const payload = confirmedPayload(patient.id, { booking_kind: 'home_collection', home_address_id: uid() });
    await consume('confirmed', confirmEnv(payload));
    expect(await ownerRows('frontdesk.orders', 'patient_id = $1', [patient.id])).toEqual([]);
    expect(await ownerRows('frontdesk.booking_links', 'source_ref_id = $1', [payload.booking_id])).toEqual([]);
  });
});

describe('engagement.booking.cancelled.v1 on a centre_visit (US-FD-12.3)', () => {
  it('pre_registered order -> cancelled with cancel_reason_code booking_cancelled, frontdesk.order.cancelled.v1 once with requires_credit_note:false; link cancelled; engagement reason not stored on the order', async () => {
    const { patient, payload, order } = await preRegistered();
    await consume('cancelled', cancelEnv(cancelledPayload(patient.id, { booking_id: payload.booking_id, reason_code: 'no_show' }), 2));
    const o = await orderRow(order.id);
    expect(o).toMatchObject({ status: 'cancelled', cancel_reason_code: 'booking_cancelled' });
    expect(o.cancelled_at).not.toBeNull();
    expect(JSON.stringify([o.cancel_reason_code, o.cancel_reason_text])).not.toMatch(/no_show/);
    const ev = await eventRows('frontdesk.order.cancelled.v1', order.id);
    expect(ev).toHaveLength(1);
    expect(JSON.stringify(ev[0])).toMatch(/"requires_credit_note"\s*:\s*false/);
    expect(JSON.stringify(ev[0])).toMatch(/booking_cancelled/);
    expect((await linkRows(TENANT_A, 'engagement_booking', payload.booking_id as string))[0]).toMatchObject({ state: 'cancelled', order_id: order.id });
  });
  it('redelivery (same event, new event_id) -> still ONE cancelled event, order stays cancelled, no flag', async () => {
    const { patient, payload, order } = await preRegistered();
    const c = cancelledPayload(patient.id, { booking_id: payload.booking_id });
    const e = cancelEnv(c, 2);
    await consume('cancelled', e);
    await expect(consume('cancelled', e)).resolves.toBeUndefined();
    await expect(consume('cancelled', cancelEnv(c, 2))).resolves.toBeUndefined();
    expect(await eventRows('frontdesk.order.cancelled.v1', order.id)).toHaveLength(1);
    expect(await flagRows(order.id)).toEqual([]);
    expect((await orderRow(order.id)).status).toBe('cancelled');
  });
  it('REGISTERED order -> flag booking_cancelled_after_registration (open), order untouched (no cancel, no event); redelivery -> still one flag', async () => {
    const { patient, order, ref } = await registeredLinked('engagement_booking');
    const c = cancelledPayload(patient.id, { booking_id: ref });
    await consume('cancelled', cancelEnv(c, 2));
    await consume('cancelled', cancelEnv(c, 2));
    const flags = await flagRows(order.id);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ kind: 'booking_cancelled_after_registration', status: 'open', specimen_id: null, centre_id: order.centre_id });
    expect(await orderRow(order.id)).toMatchObject({ status: 'registered', cancelled_at: null });
    expect(await eventRows('frontdesk.order.cancelled.v1', order.id)).toEqual([]);
  });
  it('cancel is atomic: if publishing frontdesk.order.cancelled.v1 fails the order is still pre_registered and the link still converted; the retry then cancels once', async () => {
    const { patient, payload, order } = await preRegistered();
    const e = cancelEnv(cancelledPayload(patient.id, { booking_id: payload.booking_id }), 2);
    expect(await consumeQuietly('cancelled', e, { failEvent: 'frontdesk.order.cancelled.v1' })).toBe('rejected');
    expect((await orderRow(order.id)).status).toBe('pre_registered');
    expect((await linkRows(TENANT_A, 'engagement_booking', payload.booking_id as string))[0].state).toBe('converted');
    await consume('cancelled', e);
    expect((await orderRow(order.id)).status).toBe('cancelled');
    expect(await eventRows('frontdesk.order.cancelled.v1', order.id)).toHaveLength(1);
  });
});

describe('cancel before confirm / stale seq (US-FD-12.4; 03-IC §3.24 Ordering)', () => {
  it('unknown booking: cancelled(seq 2) stores link state cancelled + last_seq 2 and no order; the later confirmed(seq 1) is IGNORED (no order, no patient write, link stays cancelled)', async () => {
    const patient = await seedPatient('a');
    const booking = uid();
    await consume('cancelled', cancelEnv(cancelledPayload(patient.id, { booking_id: booking }), 2));
    const [l] = await linkRows(TENANT_A, 'engagement_booking', booking);
    expect(l).toMatchObject({ state: 'cancelled', last_seq: 2, order_id: null });
    expect(await ordersBySource(TENANT_A, 'engagement_booking', booking)).toEqual([]);
    const probe = probeOf();
    await expect(consume('confirmed', confirmEnv(confirmedPayload(patient.id, { booking_id: booking }), 1), { probe })).resolves.toBeUndefined();
    expect(await ordersBySource(TENANT_A, 'engagement_booking', booking)).toEqual([]);
    expect((await linkRows(TENANT_A, 'engagement_booking', booking))[0]).toMatchObject({ state: 'cancelled', last_seq: 2, order_id: null });
    expect(await ownerRows('frontdesk.orders', 'patient_id = $1', [patient.id])).toEqual([]);
  });
  it('an older cancellation (lower seq) delivered after a newer one changes nothing', async () => {
    const patient = await seedPatient('a');
    const booking = uid();
    await consume('cancelled', cancelEnv(cancelledPayload(patient.id, { booking_id: booking }), 5));
    await expect(consume('cancelled', cancelEnv(cancelledPayload(patient.id, { booking_id: booking }), 3))).resolves.toBeUndefined();
    expect((await linkRows(TENANT_A, 'engagement_booking', booking))[0]).toMatchObject({ state: 'cancelled', last_seq: 5 });
  });
  it('confirmed -> cancelled -> a stale confirmed redelivery (new event_id): the order stays cancelled and no second order appears', async () => {
    const { patient, payload, order } = await preRegistered();
    await consume('cancelled', cancelEnv(cancelledPayload(patient.id, { booking_id: payload.booking_id }), 2));
    await expect(consume('confirmed', confirmEnv(payload, 1))).resolves.toBeUndefined();
    expect(await ordersBySource(TENANT_A, 'engagement_booking', payload.booking_id as string)).toHaveLength(1);
    expect((await orderRow(order.id)).status).toBe('cancelled');
  });
});

describe('home_collection cancellation with a linked order (US-FD-12.6, 08 R7, A2.12)', () => {
  it('home_visit_id links a REGISTERED order -> one open booking_cancelled_after_registration flag; the order is not cancelled; no cancel event; redelivery -> still one flag', async () => {
    const { patient, order, ref } = await registeredLinked('home_collection');
    const c = cancelledPayload(patient.id, { booking_kind: 'home_collection', home_visit_id: ref, order_id: order.id });
    await consume('cancelled', cancelEnv(c, 2));
    await consume('cancelled', cancelEnv(c, 2));
    const flags = await flagRows(order.id);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ kind: 'booking_cancelled_after_registration', status: 'open' });
    expect(await orderRow(order.id)).toMatchObject({ status: 'registered', cancelled_at: null });
    expect(await eventRows('frontdesk.order.cancelled.v1', order.id)).toEqual([]);
  });
  it('no linked order for the home_visit_id, or no home_visit_id at all -> inbox only: no flag, no order, no link written', async () => {
    const patient = await seedPatient('a');
    const probe = probeOf();
    await consume('cancelled', cancelEnv(cancelledPayload(patient.id, { booking_kind: 'home_collection', home_visit_id: uid() }), 2), { probe });
    await consume('cancelled', cancelEnv(cancelledPayload(patient.id, { booking_kind: 'home_collection' }), 2), { probe });
    expect(probe.writes.filter((s) => /order_flags|booking_links|frontdesk\.orders/i.test(s))).toEqual([]);
  });
  it('03-IC §3.24 example verbatim (home_collection, ids that exist nowhere): accepted, nothing written to flags/orders/links', async () => {
    const probe = probeOf();
    await expect(consume('cancelled', envelope('cancelled', { ...IC_EXAMPLES.cancelledHome }, { aggregateId: IC_EXAMPLES.cancelledHome.booking_id, seq: 3 }), { probe })).resolves.toBeUndefined();
    expect(probe.writes.filter((s) => /order_flags|booking_links|frontdesk\.orders/i.test(s))).toEqual([]);
  });
});

describe('isolation and forged references (07-SECURITY consumer probes, A19)', () => {
  it('payload.order_id is a hint, never a key: a cancel naming ANOTHER booking\'s pre_registered order leaves that order alone', async () => {
    const victim = await preRegistered();
    const patient = await seedPatient('a');
    await consumeQuietly('cancelled', cancelEnv(cancelledPayload(patient.id, { booking_id: uid(), order_id: victim.order.id }), 2));
    expect((await orderRow(victim.order.id)).status).toBe('pre_registered');
    expect(await flagRows(victim.order.id)).toEqual([]);
  });
  it('a centre_visit cancel never touches a home_collection-linked order and vice versa (links are keyed by source)', async () => {
    const home = await registeredLinked('home_collection');
    const patient = await seedPatient('a');
    await consume('cancelled', cancelEnv(cancelledPayload(patient.id, { booking_id: home.ref }), 2));        // centre_visit kind, booking id == the visit id
    expect(await flagRows(home.order.id)).toEqual([]);
    expect((await orderRow(home.order.id)).status).toBe('registered');
  });
  it('tenant B context + tenant B envelope naming tenant A booking/order: A\'s order, links and flags are unchanged', async () => {
    const a = await preRegistered();
    const patientB = await seedPatient('b');
    await consumeQuietly('cancelled', envelope('cancelled', cancelledPayload(patientB.id, { booking_id: a.payload.booking_id }), { aggregateId: a.payload.booking_id as string, seq: 2, tenant: TENANT_B }), { tenant: TENANT_B });
    expect((await orderRow(a.order.id)).status).toBe('pre_registered');
    expect((await linkRows(TENANT_A, 'engagement_booking', a.payload.booking_id as string))[0].state).toBe('converted');
  });
  it('an envelope whose tenant_id differs from the job context tenant writes nothing (confirmed and cancelled)', async () => {
    const a = await preRegistered();
    const probe = probeOf();
    await consumeQuietly('cancelled', cancelEnv(cancelledPayload(a.patient.id, { booking_id: a.payload.booking_id }), 2, { tenant: TENANT_B }), { tenant: TENANT_A, probe });
    expect((await orderRow(a.order.id)).status).toBe('pre_registered');
    const patient = await seedPatient('a');
    const p = confirmedPayload(patient.id);
    await consumeQuietly('confirmed', confirmEnv(p, 1, { tenant: TENANT_B }), { tenant: TENANT_A, probe });
    expect(await ordersBySource(TENANT_A, 'engagement_booking', p.booking_id as string)).toEqual([]);
  });
});
