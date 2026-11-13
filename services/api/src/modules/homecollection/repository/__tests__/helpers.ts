// HC-T03 helpers: real PG17 (migrated + seeded), tenant_a / tenant_b synthetic fixtures. Synthetic data only.
// Reuses the frontdesk integration plumbing (pools, claims, seed, ownerRows). Env: LIMS_TEST_APP_URL / LIMS_TEST_SUPER_URL (set by tests/homecollection/HC-T03.pg.sh).
import { appTx, closePools, ownerRows, rows as fd, seed, superTx, uid, SYS_ACTOR, TENANT, TENANT_A, TENANT_B, BRANCH, type Side, type Tx } from '../../../frontdesk/__tests__/integration/helpers.js';
export { appTx, closePools, ownerRows, seed, superTx, uid, SYS_ACTOR, TENANT, TENANT_A, TENANT_B, type Side, type Tx };

// seeded by db/seeds/010_core__synthetic_tenants.sql
export const HC_CENTRE = { a: '01a1a98a-ac40-7000-8000-00000000a203', b: '01a1a98a-ac40-7000-8000-00000000b203' } as const; // centre_kind home_collection
export const OTHER_CENTRE = { a: '01a1a98a-ac40-7000-8000-00000000a201', b: '01a1a98a-ac40-7000-8000-00000000b201' } as const;
export const MEMBER = { a: '01a1a98a-ac40-7000-8000-00000000a500', b: '01a1a98a-ac40-7000-8000-00000000b500' } as const;
export const MEMBER2 = { a: '01a1a98a-ac40-7000-8000-00000000a501', b: '01a1a98a-ac40-7000-8000-00000000b501' } as const;

let seq = 0;
let dayCounter = 0; // unique (centre, member, date) per route row within one test file
// LD-137 (2026-11-12): spec files run in parallel on one DB and each has its own module copy (dayCounter restarts at 0), so default routes collided on
// (tenant, centre, member, route_date). Give each spec file its own day range (hash of its path), after the fixed dates the specs use (<= 2027-03-31).
const fileDayOffset = (): number => {
  const p = String((globalThis as any).expect?.getState?.().testPath ?? Math.random());
  let h = 0; for (const c of p) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 200 + (h % 5000) * 30; // spaced by 30 so one file's default routes cannot reach the next file's range
};
let dayBase: number | undefined;

const n = () => ++seq + Math.floor(Math.random() * 1e9) * 1000;
const hex64 = () => (uid() + uid()).replace(/-/g, '').slice(0, 64);
const barcode = (s: Side) => `HCT03${s.toUpperCase()}${n()}`;
const base = (s: Side) => ({ tenant_id: TENANT[s], created_by: SYS_ACTOR, updated_by: SYS_ACTOR });
export const T0 = '2026-11-10T04:00:00Z';

/** Row builders (snake_case = DB columns). Repos take and return raw rows. */
export const hc = {
  settings: (s: Side, o = {}) => ({ id: uid(), ...base(s), collection_consent_text: 'Synthetic consent text', payment_methods: [{ code: 'cash', display: 'Cash', requires_reference: false }], ...o }),
  reason: (set: string, code: string, o = {}) => ({ id: uid(), set_code: set, code, display: `Synthetic ${code}`, requires_text: false, sort_order: 0, ...o }),
  bookingRef: (s: Side, o = {}) => ({ id: uid(), ...base(s), booking_id: uid(), state: 'confirmed', last_seq: 1, ...o }),
  route: (s: Side, o = {}) => ({ id: uid(), ...base(s), centre_id: HC_CENTRE[s], phlebotomist_membership_id: MEMBER[s], route_date: new Date(Date.UTC(2027, 0, 1) + ((dayBase ??= fileDayOffset()) + (++dayCounter)) * 86400000).toISOString().slice(0, 10), ...o }),
  visit: (s: Side, w: { patient: any; order: any }, o = {}) => ({ id: uid(), ...base(s), centre_id: HC_CENTRE[s], branch_id: BRANCH[s], kind: 'front_desk', status: 'unassigned',
    patient_id: w.patient.id, order_id: w.order.id, address_text: 'Synthetic Lane 1', landmark: 'Near the synthetic temple', ...o }),
  bookingVisit: (s: Side, w: { patient: any }, o = {}) => ({ id: uid(), ...base(s), centre_id: HC_CENTRE[s], branch_id: BRANCH[s], kind: 'booking', status: 'unassigned',
    patient_id: w.patient.id, booking_id: uid(), orderable_ids: [uid()], address_text: 'Synthetic Lane 2', ...o }),
  transition: (s: Side, visitId: string, o = {}) => ({ id: uid(), ...base(s), centre_id: HC_CENTRE[s], visit_id: visitId, from_status: null, to_status: 'unassigned', cause: 'dispatcher', at: T0, ...o }),
  assignment: (s: Side, visitId: string, routeId: string, o = {}) => ({ id: uid(), ...base(s), centre_id: HC_CENTRE[s], visit_id: visitId, route_id: routeId, membership_id: MEMBER[s], route_date: '2027-01-05', action: 'assign', ...o }),
  visitSpecimen: (s: Side, w: { specimen: any; order: any }, visitId: string, o = {}) => ({ id: uid(), ...base(s), centre_id: HC_CENTRE[s], visit_id: visitId, specimen_id: w.specimen.id, order_id: w.order.id, specimen_type_code: 'SST', status: 'ordered', ...o }),
  device: (s: Side, o = {}) => ({ id: uid(), ...base(s), membership_id: MEMBER[s], platform: 'android', os_version: '14', app_version: '1.0.0', model: 'Synthetic Phone', ...o }),
  syncBatch: (s: Side, deviceId: string, o = {}) => ({ id: uid(), ...base(s), device_id: deviceId, membership_id: MEMBER[s], sent_at_device: T0, now_device_wall_time: T0, now_monotonic_ms: 1000,
    now_boot_id: 'boot-1', anchors: [], mutation_count: 1, applied_count: 1, held_count: 0, rejected_count: 0, duplicate_count: 0, received_at: T0, ...o }),
  mutation: (s: Side, deviceId: string, batchId: string, visitId: string | null, o = {}) => ({ id: uid(), ...base(s), centre_id: HC_CENTRE[s], client_mutation_id: uid(), device_id: deviceId, batch_id: batchId,
    membership_id: MEMBER[s], device_seq: 1 + (n() % 1e6), type: 'visit.arrived', visit_id: visitId, payload: { note: 'synthetic' }, payload_sha256: hex64(), captured_at_device: T0, captured_at: T0,
    clock_source: 'anchor', outcome: 'applied', received_at: T0, ...o }),
  collection: (s: Side, w: { specimen: any; order: any }, visitId: string, mutationId: string, o = {}) => ({ id: uid(), ...base(s), centre_id: HC_CENTRE[s], visit_id: visitId, specimen_id: w.specimen.id, order_id: w.order.id,
    mutation_id: mutationId, client_mutation_id: uid(), collected_by_membership_id: MEMBER[s], scan_method: 'camera', barcode_verified: true, collected_at: T0, collected_at_device: T0,
    status: 'held', hold_code: 'synthetic_hold', ...o }),
  handover: (s: Side, mutationId: string, o = {}) => ({ id: uid(), ...base(s), centre_id: HC_CENTRE[s], to_centre_id: OTHER_CENTRE[s], from_membership_id: MEMBER[s], mutation_id: mutationId,
    handed_over_at: T0, handed_over_at_device: T0, status: 'pending', ...o }),
  handoverItem: (s: Side, handoverId: string, collectionId: string, w: { specimen: any }, visitId: string, o = {}) => ({ id: uid(), ...base(s), centre_id: HC_CENTRE[s], to_centre_id: OTHER_CENTRE[s],
    handover_id: handoverId, collection_id: collectionId, specimen_id: w.specimen.id, visit_id: visitId, barcode: w.specimen.barcode, specimen_type_code: 'SST', ...o }),
  flag: (s: Side, visitId: string, o = {}) => ({ id: uid(), ...base(s), centre_id: HC_CENTRE[s], visit_id: visitId, kind: 'held_collection', related_id: uid(), ...o }),
  location: (s: Side, visitId: string, mutationId: string, o = {}) => ({ id: uid(), ...base(s), centre_id: HC_CENTRE[s], visit_id: visitId, mutation_id: mutationId, kind: 'arrived',
    latitude: 27.7172, longitude: 85.324, captured_at: T0, expires_at: '2099-01-01T00:00:00Z', ...o }),
};

export interface World { patient: any; order: any; specimen: any; visit: any; bookingVisit: any; route: any; bookingRef: any; device: any; batch: any; mutation: any; collection: any;
  handover: any; handoverItem: any; flag: any; location: any; transition: any; assignment: any; visitSpecimen: any; settings: any }

/** One committed object graph per tenant (superuser inserts; RLS bypassed). Order matters: parents first, sync_batches before mutations. */
export async function seedWorld(s: Side): Promise<World> {
  const patient = fd.patient(s); await seed('frontdesk.patients', patient);
  const order = fd.order(s, patient.id, { centre_id: HC_CENTRE[s], collection_mode: 'home' }); await seed('frontdesk.orders', order);
  await seed('lab.orders', { id: order.id, tenant_id: TENANT[s], centre_id: HC_CENTRE[s], branch_id: BRANCH[s], patient_id: patient.id, registration_no: order.registration_no, visit_type: 'opd',
    priority: 'routine', collection_mode: 'home', source: 'home_collection', registered_at: T0, patient_sex: 'female', last_order_seq: 1 });
  const specimen = { id: uid(), tenant_id: TENANT[s], centre_id: HC_CENTRE[s], order_id: order.id, patient_id: patient.id, barcode: barcode(s), creation_key: `hct03-${uid()}`,
    specimen_type_code: 'SST', priority: 'routine', patient_sex: 'female', status: 'ordered', ordered_at: T0 };
  await seed('lab.specimens', specimen);
  const route = hc.route(s); await seed('homecollection.routes', route);
  const visit = hc.visit(s, { patient, order }); await seed('homecollection.visits', visit);
  const bookingVisit = hc.bookingVisit(s, { patient }); await seed('homecollection.visits', bookingVisit);
  const bookingRef = hc.bookingRef(s, { booking_id: bookingVisit.booking_id, visit_id: bookingVisit.id }); await seed('homecollection.booking_refs', bookingRef);
  const device = hc.device(s); await seed('homecollection.devices', device);
  const batch = hc.syncBatch(s, device.id); await seed('homecollection.sync_batches', batch);
  const mutation = hc.mutation(s, device.id, batch.id, visit.id); await seed('homecollection.mutations', mutation);
  const hoMutation = hc.mutation(s, device.id, batch.id, null, { type: 'handover.recorded' }); await seed('homecollection.mutations', hoMutation);
  const collection = hc.collection(s, { specimen, order }, visit.id, mutation.id); await seed('homecollection.collections', collection);
  const handover = hc.handover(s, hoMutation.id); await seed('homecollection.handovers', handover);
  const handoverItem = hc.handoverItem(s, handover.id, collection.id, { specimen }, visit.id); await seed('homecollection.handover_items', handoverItem);
  const flag = hc.flag(s, visit.id); await seed('homecollection.visit_flags', flag);
  const location = hc.location(s, visit.id, mutation.id); await seed('homecollection.visit_locations', location);
  const transition = hc.transition(s, visit.id); await seed('homecollection.visit_transitions', transition);
  const assignment = hc.assignment(s, visit.id, route.id); await seed('homecollection.visit_assignments', assignment);
  const visitSpecimen = hc.visitSpecimen(s, { specimen, order }, visit.id); await seed('homecollection.visit_specimens', visitSpecimen);
  const settings = hc.settings(s); await seed('homecollection.settings', settings);
  return { patient, order, specimen, visit, bookingVisit, route, bookingRef, device, batch, mutation, collection, handover, handoverItem, flag, location, transition, assignment, visitSpecimen, settings };
}
