// HC-T14 fixtures: a committed handover world (handover + items + the visits/collections/specimens behind them), seeded as superuser. NO handler import here:
// the worker test (services/worker/.../flag_handover_discrepancy.live.test.ts) reuses it, so it must stay light (repository helpers + frontdesk rows only).
// Synthetic data only. Env: LIMS_TEST_APP_URL / LIMS_TEST_SUPER_URL (tests/homecollection/HC-T14.pg.sh).
import { rows as fd } from '../../../frontdesk/__tests__/integration/helpers.js';
import { HC_CENTRE, MEMBER, OTHER_CENTRE, T0, TENANT, TENANT_A, TENANT_B, hc, ownerRows, seed, superTx, uid, type Side } from '../../repository/__tests__/helpers.js';
import { BRANCH } from '../../../frontdesk/__tests__/integration/helpers.js';

export { HC_CENTRE, MEMBER, OTHER_CENTRE, TENANT_A, TENANT_B, ownerRows, superTx, uid, hc, T0 };
export type { Side };

/** seeded by db/seeds/010_core__synthetic_tenants.sql: a50a = user a30a, all_centres = false, membership_centres = {A-C1 (a201)}; NOT a member of the home-collection centre A-HC (a203). */
export const RECEIVER = { tenant: TENANT_A, membershipId: '01a1a98a-ac40-7000-8000-00000000a50a', userId: '01a1a98a-ac40-7000-8000-00000000a30a' } as const;
/** tenant-wide staff (all_centres = true) */
export const ALL_CENTRES_STAFF = { tenant: TENANT_A, membershipId: MEMBER.a, userId: '01a1a98a-ac40-7000-8000-00000000a300' } as const;
export const CENTRE_C = OTHER_CENTRE.a;                                                    // A-C1 (own): where RECEIVER works
export const CENTRE_D = '01a1a98a-ac40-7000-8000-00000000a202';                           // A-C2 (franchise): RECEIVER has no scope here
export const NOW = new Date('2026-11-13T06:00:00.000Z');

const hash = (s: string): number => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
let dayBase: number | undefined;
let dayN = 0;
/** One route date per world: routes are unique per (centre, member, date) and spec files run in parallel on one DB. Far-future dates, spaced by 200 days per spec file. */
const nextDate = (): string => {
  dayBase ??= hash(String((globalThis as any).expect?.getState?.().testPath ?? Math.random())) % 2000 * 200;
  return new Date(Date.UTC(2040, 0, 1) + (dayBase + ++dayN) * 86_400_000).toISOString().slice(0, 10);
};
let seqN = 0;
const code12 = (): string => uid().replace(/-/g, '').slice(-12).toUpperCase();

export interface HoItem { id: string; specimenId: string; visitId: string; collectionId: string; barcode: string; typeCode: string; labBarcode: string; labTypeCode: string; routeId: string | null }
export interface HoWorld { s: Side; tenant: string; date: string; to: string; fromMember: string; device: any; route: any; handover: any; items: HoItem[] }
export interface HoOpts {
  s?: Side; n?: number; to?: string; fromMember?: string; status?: 'pending' | 'confirmed' | 'discrepancy';
  /** per item (default null = not yet decided) */
  outcomes?: Array<'received' | 'missing' | null>;
  /** visit status of the collected visits (default 'assigned', on the route); 'completed' visits are seeded WITHOUT a route */
  visitStatus?: 'assigned' | 'completed';
  handedOverAt?: string; note?: string | null;
}

/** pending handover (default) of `n` tubes from the phlebotomist to centre C; item barcode / specimen type DIFFER from lab.specimens on purpose (D-125: the receiver reads the copy on the item). */
export async function handoverWorld(o: HoOpts = {}): Promise<HoWorld> {
  const s = o.s ?? 'a'; const tenant = TENANT[s]; const n = o.n ?? 3; const to = o.to ?? (s === 'a' ? CENTRE_C : OTHER_CENTRE.b);
  const fromMember = o.fromMember ?? MEMBER[s]; const date = nextDate(); const status = o.status ?? 'pending';
  const route = { ...hc.route(s, { route_date: date, phlebotomist_membership_id: fromMember }) }; await seed('homecollection.routes', route);
  const device = hc.device(s, { membership_id: fromMember }); await seed('homecollection.devices', device);
  const batch = hc.syncBatch(s, device.id, { membership_id: fromMember }); await seed('homecollection.sync_batches', batch);
  const ho = hc.mutation(s, device.id, batch.id, null, { type: 'handover.recorded', membership_id: fromMember, device_seq: 1_000_000 + ++seqN }); await seed('homecollection.mutations', ho);
  const items: HoItem[] = []; const staged: Array<{ visit: any; specimen: any; order: any; col: any }> = [];
  for (let i = 0; i < n; i++) {
    const patient = fd.patient(s, { full_name: 'Synthetic Patient DB', birth_on: '1991-02-03' }); await seed('frontdesk.patients', patient);
    const order = fd.order(s, patient.id, { centre_id: HC_CENTRE[s], collection_mode: 'home' }); await seed('frontdesk.orders', order);
    await seed('lab.orders', { id: order.id, tenant_id: tenant, centre_id: HC_CENTRE[s], branch_id: BRANCH[s], patient_id: patient.id, registration_no: order.registration_no, visit_type: 'opd',
      priority: 'routine', collection_mode: 'home', source: 'home_collection', registered_at: T0, patient_sex: 'female', last_order_seq: 1 });
    const onRoute = (o.visitStatus ?? 'assigned') === 'assigned';
    const visit = hc.visit(s, { patient, order }, { status: o.visitStatus ?? 'assigned', ...(onRoute ? { route_id: route.id, route_date: date, route_sequence: i + 1, assigned_membership_id: fromMember, assigned_at: '2028-01-01T00:00:00Z' }
      : { assigned_membership_id: fromMember, assigned_at: '2028-01-01T00:00:00Z', outcome: 'collected', completed_at: '2028-01-01T05:00:00Z' }), window_start: `${date}T04:00:00Z`, window_end: `${date}T04:30:00Z` });
    await seed('homecollection.visits', visit);
    const specimen = { id: uid(), tenant_id: tenant, centre_id: HC_CENTRE[s], order_id: order.id, patient_id: patient.id, barcode: `LAB14${code12()}`, creation_key: `hct14-${uid()}`,
      specimen_type_code: 'SST', priority: 'routine', patient_sex: 'female', status: 'ordered', ordered_at: T0 };
    await seed('lab.specimens', specimen);
    const mut = hc.mutation(s, device.id, batch.id, visit.id, { type: 'specimen.collected', membership_id: fromMember, device_seq: 2_000_000 + ++seqN }); await seed('homecollection.mutations', mut);
    const col = hc.collection(s, { specimen, order }, visit.id, mut.id, { collected_by_membership_id: fromMember, status: 'applied', hold_code: null }); await seed('homecollection.collections', col);
    staged.push({ visit, specimen, order, col });
  }
  const received = status === 'pending' ? {} : { received_by_membership_id: s === 'a' ? RECEIVER.membershipId : MEMBER.b, received_at: '2026-11-11T05:00:00Z' };
  const handover = hc.handover(s, ho.id, { to_centre_id: to, from_membership_id: fromMember, status, handed_over_at: o.handedOverAt ?? '2026-11-10T04:00:00Z', handed_over_at_device: o.handedOverAt ?? '2026-11-10T04:00:00Z',
    ...received, ...(o.note ? { note: o.note } : {}) });
  await seed('homecollection.handovers', handover);
  for (const [i, st] of staged.entries()) {
    const barcode = `HO14${code12()}${i}`; const typeCode = i % 2 ? 'SST' : 'EDTA';   // the lab specimen is SST: item 0 and 2 carry a type that differs from lab.specimens
    const outcome = o.outcomes?.[i] ?? (status === 'confirmed' ? 'received' : null);
    const row = hc.handoverItem(s, handover.id, st.col.id, { specimen: st.specimen }, st.visit.id, { to_centre_id: to, barcode, specimen_type_code: typeCode, ...(outcome ? { outcome } : {}) });
    await seed('homecollection.handover_items', row);
    items.push({ id: row.id, specimenId: st.specimen.id, visitId: st.visit.id, collectionId: st.col.id, barcode, typeCode, labBarcode: st.specimen.barcode, labTypeCode: 'SST', routeId: st.visit.route_id ?? null });
  }
  return { s, tenant, date, to, fromMember, device, route, handover, items };
}

// ---- committed DB truth (owner side, no RLS) ----
export const handoverRow = async (id: string) => (await ownerRows('homecollection.handovers', 'id = $1', [id]))[0];
export const itemRowsOf = (handoverId: string) => ownerRows('homecollection.handover_items', 'handover_id = $1 ORDER BY created_at, id', [handoverId]);
export const flagsOfVisit = (visitId: string, kind?: string) =>
  ownerRows('homecollection.visit_flags', kind ? 'visit_id = $1 AND kind = $2 ORDER BY created_at, id' : 'visit_id = $1 ORDER BY created_at, id', kind ? [visitId, kind] : [visitId]);
export const routeVersion = async (routeId: string): Promise<number> => Number((await ownerRows('homecollection.routes', 'id = $1', [routeId]))[0].version);
export const visitVersion = async (visitId: string): Promise<number> => Number((await ownerRows('homecollection.visits', 'id = $1', [visitId]))[0].version);
/** graphile-worker job rows for the discrepancy task (key = flag_handover_discrepancy:<handover_id>) */
export const discrepancyJobs = (handoverId: string) => superTx(async (tx: any) => (await tx.query(
  `SELECT j.key, t.identifier AS task_identifier, j.payload FROM graphile_worker._private_jobs j JOIN graphile_worker._private_tasks t ON t.id = j.task_id WHERE j.key = $1`,
  [`flag_handover_discrepancy:${handoverId}`])).rows);
export const TASK = 'homecollection.flag_handover_discrepancy';
/** Test-DB fixture only (as the HC-T09 ruling for refresh_visit_specimens): app.enqueue_job needs the identifier in core.g_task_registry; registry-sync runs at deploy, not in the test boot. */
export async function ensureDiscrepancyTask(): Promise<void> {
  await superTx(async (tx: any) => { await tx.query(`INSERT INTO core.g_task_registry (identifier, module, kind, scope, max_attempts, is_active) VALUES ($1, 'homecollection', 'task', 'per_tenant', 10, true)
    ON CONFLICT (identifier) DO UPDATE SET is_active = true`, [TASK]); });
}
