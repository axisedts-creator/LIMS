// HC-T30 E2E nightly (02-TRD §15 "E2E nightly"; DoD §5.2). done_when: "scenario in TRD §15 green on compose stack".
// booking (fake C16 event) -> assign -> C4 order -> C5 specimens/labels -> app collects OFFLINE -> push -> C5 `collected`/`in_transit` -> C4 ledger row -> handover confirm -> C5 receive.
// The phone is played by the device API (staff_mobile token) so the compose stack needs no emulator; the real-app offline path is the Flutter integration_test (TRD §15 Device row).
// Skips unless the compose seed is present. Synthetic data only. Env:
//   LIMS_E2E_API_URL, LIMS_E2E_STAFF_TOKEN       dispatcher (homecollection.visit.read/assign)
//   LIMS_E2E_BOOKING_VISIT_ID                    the visit created by the fake `engagement.booking.confirmed.v1` event (unassigned; has address + window; one test with one specimen type)
//   LIMS_E2E_PHLEBO_MEMBERSHIP_ID                eligible phlebotomist; LIMS_E2E_DEVICE_TOKEN / LIMS_E2E_DEVICE_ID = that phlebotomist's registered device (homecollection.sync.upload)
//   LIMS_E2E_RECEIVING_CENTRE_ID, LIMS_E2E_RECEIVER_TOKEN = receiver (homecollection.handover.receive) who is NOT a member of the home-collection centre (D-125)
//   LIMS_E2E_PAYMENT_METHOD_CODE                 seeded C4 cash payment method code (payment.captured, 02-TRD §6.3)
import { expect, test, type APIRequestContext } from '@playwright/test';

const API = process.env.LIMS_E2E_API_URL ?? '';
const STAFF = process.env.LIMS_E2E_STAFF_TOKEN ?? '';
const VISIT = process.env.LIMS_E2E_BOOKING_VISIT_ID ?? '';
const PHLEBO = process.env.LIMS_E2E_PHLEBO_MEMBERSHIP_ID ?? '';
const DEVICE_TOKEN = process.env.LIMS_E2E_DEVICE_TOKEN ?? '';
const DEVICE_ID = process.env.LIMS_E2E_DEVICE_ID ?? '';
const CENTRE = process.env.LIMS_E2E_RECEIVING_CENTRE_ID ?? '';
const RECEIVER = process.env.LIMS_E2E_RECEIVER_TOKEN ?? '';
const PAY_METHOD = process.env.LIMS_E2E_PAYMENT_METHOD_CODE ?? '';
test.skip(!API || !STAFF || !VISIT || !PHLEBO || !DEVICE_TOKEN || !DEVICE_ID || !CENTRE || !RECEIVER || !PAY_METHOD, 'compose env not set');
test.describe.configure({ mode: 'serial' });

const H = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra });
const uuid7 = () => { // time-ordered uuid v7 (synthetic ids)
  const b = crypto.getRandomValues(new Uint8Array(16)); const ts = BigInt(Date.now());
  for (let i = 0; i < 6; i++) b[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70; b[8] = (b[8] & 0x3f) | 0x80;
  const x = [...b].map((v) => v.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
};
const visit = async (request: APIRequestContext) => (await request.get(`${API}/v1/homecollection/visits/${VISIT}`, { headers: H(STAFF) })).json();

let version = 0; let orderId = ''; let specimen: { id: string; barcode: string; type: string };
let consentVersion = ''; let balanceDue: { amount_paisa: number; currency: string }; let paymentMutationId = '';
const anchor = uuid7(); const now = new Date();
const captured = { device_wall_time: now.toISOString(), anchor_id: anchor, elapsed_since_anchor_ms: 1000 };
let seq = 1;
const mut = (type: string, payload: object) => ({ client_mutation_id: uuid7(), device_seq: seq++, type, visit_id: VISIT, captured, payload });
const pushBody = (batch: string, mutations: object[]) => ({
  device_id: DEVICE_ID, batch_id: batch, sent_at_device: now.toISOString(),
  anchors: [{ anchor_id: anchor, server_time: now.toISOString(), device_wall_time: now.toISOString(), monotonic_ms: 1000, boot_id: 'b-e2e' }],
  now: { device_wall_time: now.toISOString(), monotonic_ms: 2000, boot_id: 'b-e2e' }, mutations,
});
const push = (request: APIRequestContext, batch: string, mutations: object[]) =>
  request.post(`${API}/v1/homecollection/sync/mutations`, { headers: H(DEVICE_TOKEN, { 'idempotency-key': batch, 'x-lims-device-id': DEVICE_ID, 'x-lims-app-version': '1.0.0' }), data: pushBody(batch, mutations) });

test('1 booking: the fake booking event produced exactly one unassigned home visit linked to the booking', async ({ request }) => {
  const v = await visit(request);
  expect(v.status).toBe('unassigned'); // 05-SCHEMA visits.status: unassigned|assigned|in_progress|completed|failed|cancelled
  expect(v.booking_id).toBeTruthy();
  expect(v.order_id ?? null).toBeNull(); // R7: the order is created at assignment, not by C4 on the booking
  version = v.version;
});

test('2 assign -> 3 C4 order: assigning creates exactly one order (no duplicate order from the booking consumer)', async ({ request }) => {
  const route_date = now.toISOString().slice(0, 10);
  const r = await request.post(`${API}/v1/homecollection/visits/${VISIT}/assign`, {
    headers: H(STAFF, { 'if-match': `"${version}"`, 'idempotency-key': uuid7() }), data: { phlebotomist_membership_id: PHLEBO, route_date, route_sequence: 1 },
  });
  expect(r.status()).toBe(200);
  const v = await visit(request);
  expect(v.status).toBe('assigned');
  orderId = v.order_id;
  expect(orderId).toBeTruthy();
  const again = await visit(request); // a second read must not show a second order (exactly one order per booking, 06-PLAN risk row)
  expect(again.order_id).toBe(orderId);
});

test('4 C5 specimens/labels: the phone snapshot (A2) lists the visit specimens with barcodes and the C4 balance', async ({ request }) => {
  const r = await request.get(`${API}/v1/homecollection/sync/snapshot?device_id=${DEVICE_ID}`, { headers: H(DEVICE_TOKEN, { 'x-lims-device-id': DEVICE_ID }) });
  expect(r.status()).toBe(200);
  const snap = await r.json();
  const sv = snap.visits.find((x: { visit_id: string }) => x.visit_id === VISIT);
  expect(sv).toBeTruthy();
  expect(sv.specimens.length).toBeGreaterThanOrEqual(1);
  const s = sv.specimens[0]; // 02-TRD §6.2: {specimen_id, barcode, specimen_type_code, ...}
  specimen = { id: s.specimen_id, barcode: s.barcode, type: s.specimen_type_code };
  expect(specimen.id).toBeTruthy();
  expect(specimen.barcode).toMatch(/^[A-Z0-9]{1,20}$/);
  expect(specimen.type).toBeTruthy();
  consentVersion = snap.config.collection_consent_text_version;
  expect(consentVersion).toBeTruthy();
  balanceDue = sv.balance.balance_due;
  expect(balanceDue.amount_paisa).toBeGreaterThan(0); // payment.captured needs amount >= 1 paisa
});

test('5 phone collects OFFLINE, 6 push: arrived + collected + completed + cash payment replay-safe; frozen batch resent returns the same result', async ({ request }) => {
  const batch = uuid7();
  const payment = mut('payment.captured', { order_id: orderId, payment_method_code: PAY_METHOD, amount: balanceDue });
  paymentMutationId = payment.client_mutation_id;
  const mutations = [
    mut('visit.arrived', { gps: { status: 'off' } }),
    mut('visit.identity_checked', { name_check: 'matches', second_identifier: 'phone', second_check: 'matches' }),
    mut('visit.consent_recorded', { consent_text_version: consentVersion, given: true }),
    mut('specimen.collected', { specimen_id: specimen.id, scanned_barcode: specimen.barcode, scan_method: 'hid', specimen_type_code: specimen.type, gps: { status: 'off' } }),
    payment,
    mut('visit.completed', { outcome: 'collected' }),
  ];
  const first = await push(request, batch, mutations);
  expect(first.status()).toBe(200);
  const body1 = await first.json();
  expect(body1.results).toHaveLength(mutations.length); // PushResponse is 200 for any valid envelope: judge per-mutation outcomes
  expect(body1.results.every((r: { outcome: string }) => r.outcome === 'applied')).toBe(true);
  const second = await push(request, batch, mutations); // airplane-mode retry: same batch_id and identical body
  expect(second.status()).toBe(200);
  expect(await second.json()).toEqual(body1);
});

test('7 C5 collected / in_transit: the visit is completed and the specimen is collected with the scanned barcode, once', async ({ request }) => {
  const v = await visit(request);
  expect(v.status).toBe('completed');
  const s = v.specimens.find((x: { specimen_id: string }) => x.specimen_id === specimen.id);
  expect(['collected', 'in_transit']).toContain(s.status);
  expect(v.collections.filter((c: { specimen_id: string; status: string }) => c.specimen_id === specimen.id && c.status === 'applied')).toHaveLength(1);
});

test('8 C4 ledger / payment row: the cash payment is applied once and the C4 balance is settled', async ({ request }) => {
  const v = await visit(request);
  expect(v.order_id).toBe(orderId);
  expect(v.payments).toHaveLength(1);
  expect(v.payments[0].client_mutation_id).toBe(paymentMutationId);
  expect(v.payments[0].outcome).toBe('applied');
  expect(v.balance.balance_due.amount_paisa).toBe(0);
});

let handoverId = '';
test('9 handover: the phone records a handover to another centre', async ({ request }) => {
  handoverId = uuid7();
  const r = await push(request, uuid7(), [{ client_mutation_id: uuid7(), device_seq: seq++, type: 'handover.recorded', captured, payload: { handover_id: handoverId, to_centre_id: CENTRE, specimen_ids: [specimen.id] } }]);
  expect(r.status()).toBe(200);
  expect((await r.json()).handover_items).toEqual([{ handover_id: handoverId, specimen_id: specimen.id, outcome: 'included' }]);
});

test('10 confirm + 11 C5 receive: a receiver outside the home-collection centre sees the barcodes and confirms; the handover is received', async ({ request }) => {
  const d = await request.get(`${API}/v1/homecollection/handovers/${handoverId}`, { headers: H(RECEIVER) });
  expect(d.status()).toBe(200);
  const h = await d.json();
  expect(JSON.stringify(h.items)).toContain(specimen.barcode);
  const c = await request.post(`${API}/v1/homecollection/handovers/${handoverId}/confirm`, {
    headers: H(RECEIVER, { 'if-match': `"${h.version}"`, 'idempotency-key': uuid7() }), data: { items: [{ specimen_id: specimen.id, received: true }] },
  });
  expect(c.status()).toBe(200);
  const after = await (await request.get(`${API}/v1/homecollection/handovers/${handoverId}`, { headers: H(RECEIVER) })).json();
  expect(after.status).toBe('confirmed'); // 05-SCHEMA handovers.status: pending|confirmed|discrepancy
  expect(after.received_count).toBe(after.item_count);
  expect(after.items.every((i: { outcome: string }) => i.outcome === 'received')).toBe(true); // 02-TRD §5.3 item outcome
});

test('cross-tenant / no-token probes at the last step: no token -> 401, device token on a dispatcher route -> 403', async ({ request }) => {
  expect((await request.get(`${API}/v1/homecollection/visits/${VISIT}`)).status()).toBe(401);
  expect((await request.get(`${API}/v1/homecollection/visits/${VISIT}`, { headers: H(DEVICE_TOKEN) })).status()).toBe(403);
});
