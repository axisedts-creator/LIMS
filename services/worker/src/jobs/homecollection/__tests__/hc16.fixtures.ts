// HC-T16 fixtures (committed as superuser; synthetic data only). See hc16.helpers.ts for the job harness.
import { BRANCH, rows as fd } from '../../../../../api/src/modules/frontdesk/__tests__/integration/helpers.js';
import { HC_CENTRE, MEMBER, T0, hc, ownerRows, seed, superTx, type Side } from '../../../../../api/src/modules/homecollection/repository/__tests__/helpers.js';
import { TENANT_A, TENANT_B, uid } from './hc16.helpers.js';
export { HC_CENTRE, MEMBER, T0, hc, ownerRows, seed, superTx, type Side };
const TENANT = { a: TENANT_A, b: TENANT_B } as const;

let dayBase: number | undefined; let dayN = 0;
/** unique route date per call (routes are unique per tenant/centre/member/date; every spec file gets its own range). Far future: 2060+ */
export const nextDate = (): string => {
  let h = 0; for (const c of String((globalThis as any).expect?.getState?.().testPath ?? Math.random())) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  dayBase ??= (h % 2000) * 100;
  return new Date(Date.UTC(2060, 0, 1) + (dayBase + ++dayN) * 86_400_000).toISOString().slice(0, 10);
};

/** patient + frontdesk order + lab order, committed */
export async function orderFixture(s: Side) {
  const patient = fd.patient(s, { full_name: 'Synthetic Patient', birth_on: '1990-01-02' }); await seed('frontdesk.patients', patient);
  const order = fd.order(s, patient.id, { centre_id: HC_CENTRE[s], collection_mode: 'home' }); await seed('frontdesk.orders', order);
  await seed('lab.orders', { id: order.id, tenant_id: TENANT[s], centre_id: HC_CENTRE[s], branch_id: BRANCH[s], patient_id: patient.id, registration_no: order.registration_no, visit_type: 'opd',
    priority: 'routine', collection_mode: 'home', source: 'home_collection', registered_at: T0, patient_sex: 'female', last_order_seq: 1 });
  return { patient, order };
}
export const newRoute = async (s: Side, date: string, o: Record<string, unknown> = {}) => { const r = hc.route(s, { route_date: date, ...o }); await seed('homecollection.routes', r); return r; };

/** an `assigned` visit on `route` (visit.route_date = route.route_date) with its `assign` history row */
export async function assignedVisit(s: Side, route: any, o: Record<string, unknown> = {}) {
  const { patient, order } = await orderFixture(s);
  const visit = hc.visit(s, { patient, order }, { status: 'assigned', route_id: route.id, route_date: route.route_date, route_sequence: 1, assigned_membership_id: route.phlebotomist_membership_id,
    assigned_at: '2026-11-01T04:00:00Z', window_start: `${route.route_date}T04:00:00Z`, window_end: `${route.route_date}T04:30:00Z`, ...o });
  await seed('homecollection.visits', visit);
  await seed('homecollection.visit_assignments', hc.assignment(s, visit.id, route.id, { route_date: route.route_date, membership_id: route.phlebotomist_membership_id }));
  return { visit, patient, order };
}

/** a visit (default `completed`, no route) + an `applied` collection of one tube collected at `collectedAt`, no handover item yet */
export async function collectedVisit(s: Side, collectedAt: string, o: { visit?: Record<string, unknown>; status?: string } = {}) {
  const { patient, order } = await orderFixture(s);
  const device = hc.device(s); await seed('homecollection.devices', device);
  const batch = hc.syncBatch(s, device.id); await seed('homecollection.sync_batches', batch);
  const visit = hc.visit(s, { patient, order }, { status: 'completed', outcome: 'collected', completed_at: collectedAt, assigned_membership_id: MEMBER[s], assigned_at: '2026-11-01T04:00:00Z', ...(o.visit ?? {}) });
  await seed('homecollection.visits', visit);
  const specimen = { id: uid(), tenant_id: TENANT[s], centre_id: HC_CENTRE[s], order_id: order.id, patient_id: patient.id, barcode: `HC16${uid().replace(/-/g, '').slice(-12).toUpperCase()}`, creation_key: `hct16-${uid()}`,
    specimen_type_code: 'SST', priority: 'routine', patient_sex: 'female', status: 'ordered', ordered_at: T0 };
  await seed('lab.specimens', specimen);
  const mut = hc.mutation(s, device.id, batch.id, visit.id, { type: 'specimen.collected', device_seq: 3_000_000 + Math.floor(Math.random() * 1e6) }); await seed('homecollection.mutations', mut);
  const status = o.status ?? 'applied';
  const col = hc.collection(s, { specimen, order }, visit.id, mut.id, { status, hold_code: status === 'held' ? 'synthetic_hold' : null, collected_at: collectedAt, collected_at_device: collectedAt });
  await seed('homecollection.collections', col);
  return { visit, specimen, order, device, batch, mut, col };
}
/** a second applied collection (another tube) on an existing visit */
export async function extraCollection(s: Side, base: Awaited<ReturnType<typeof collectedVisit>>, collectedAt: string) {
  const specimen = { ...base.specimen, id: uid(), barcode: `HC16${uid().replace(/-/g, '').slice(-12).toUpperCase()}`, creation_key: `hct16-${uid()}` };
  await seed('lab.specimens', specimen);
  const mut = hc.mutation(s, base.device.id, base.batch.id, base.visit.id, { type: 'specimen.collected', device_seq: 4_000_000 + Math.floor(Math.random() * 1e6) }); await seed('homecollection.mutations', mut);
  const col = hc.collection(s, { specimen, order: base.order }, base.visit.id, mut.id, { status: 'applied', hold_code: null, collected_at: collectedAt, collected_at_device: collectedAt });
  await seed('homecollection.collections', col);
  return { specimen, col };
}
/** handover (+ item for `col`) on the visit: the tube has been handed over */
export async function handOver(s: Side, c: { visit: any; specimen: any; col: any; device: any; batch: any }, status = 'pending') {
  const mut = hc.mutation(s, c.device.id, c.batch.id, null, { type: 'handover.recorded', device_seq: 5_000_000 + Math.floor(Math.random() * 1e6) }); await seed('homecollection.mutations', mut);
  const ho = hc.handover(s, mut.id, { status, ...(status === 'pending' ? {} : { received_by_membership_id: MEMBER[s], received_at: T0 }) }); await seed('homecollection.handovers', ho);
  const item = hc.handoverItem(s, ho.id, c.col.id, { specimen: c.specimen }, c.visit.id, { barcode: `HOI${uid().replace(/-/g, '').slice(-10).toUpperCase()}` }); await seed('homecollection.handover_items', item);
  return { ho, item };
}

export const flagsOf = (visitId: string, kind?: string) => ownerRows('homecollection.visit_flags', kind ? 'visit_id = $1 AND kind = $2 ORDER BY created_at, id' : 'visit_id = $1 ORDER BY created_at, id', kind ? [visitId, kind] : [visitId]);
export const visitOf = async (id: string) => (await ownerRows('homecollection.visits', 'id = $1', [id]))[0];
export const routeOf = async (id: string) => (await ownerRows('homecollection.routes', 'id = $1', [id]))[0];
export const assignmentsOf = (visitId: string) => ownerRows('homecollection.visit_assignments', 'visit_id = $1 ORDER BY created_at, id', [visitId]);
export const transitionsOf = (visitId: string) => ownerRows('homecollection.visit_transitions', 'visit_id = $1 ORDER BY created_at, id', [visitId]);
/** Test-DB fixture only (as the HC-T09 / HC-T14 rulings): app.enqueue_job needs the identifier in core.g_task_registry; registry-sync runs at deploy, not in the test boot. */
export async function ensureTasks(ids: string[]): Promise<void> {
  await superTx(async (tx: any) => { for (const id of ids) await tx.query(`INSERT INTO core.g_task_registry (identifier, module, kind, scope, max_attempts, is_active) VALUES ($1, 'homecollection', 'task', 'per_tenant', 5, true)
    ON CONFLICT (identifier) DO UPDATE SET is_active = true`, [id]); });
}
