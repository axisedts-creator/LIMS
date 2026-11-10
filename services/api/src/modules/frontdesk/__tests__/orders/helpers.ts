// FD-T08 harness (Orders read F10 listOrders / F11 getOrder + derived status, 08 A13 D-5 / A17.2). Same convention as ../patients/helpers.ts and ../registration/helpers.ts:
// the handler is driven with a request-shaped object + a HandlerContext over a REAL PG17 tx (lims_api, RLS on). LabPort and BillingCommandPort are the REAL fakes
// from packages/fakes (LabPort.fake `getOrderItemProcessingState` implements D-5 + A17.2); no hand-rolled lab logic here.
// ASSUMED ctx.ports keys: IdentityPort{assertRole,getActor}, LabPort, BillingCommandPort (02-TRD §6.4 names). Centre scope = IdentityPort.getActor().centreScope (as FD-T06/T07).
// The LabPort fake only knows ids from its fixtures, but C4 owns the order/item ids: `scenario` seeds the DB rows and the matching fake fixtures (tenant-scoped).
import { createFakeBillingCommandPort } from '../../../../../../../packages/fakes/src/BillingCommandPort.fake';
import { createFakeLabPort } from '../../../../../../../packages/fakes/src/LabPort.fake';
import { access } from '../../../../core/audit/access.js';
import { handlers } from '../../handlers/index.js';
import { rows } from '../integration/helpers.js';
import { BRANCH, CENTRE, NOW, SYS_ACTOR, TENANT_A, TENANT_B, appTx, makeIdentity, ownerRows, rejection, req, schemaErrors, seed, seedPatient, superTx, uid } from '../patients/helpers.js';

export { BRANCH, CENTRE, NOW, TENANT_A, TENANT_B, ownerRows, rejection, req, rows, schemaErrors, seed, seedPatient, superTx, uid };
export const T = 60_000;
export const PERM = 'frontdesk.order.read';
/** Second branch + centre of tenant A (db/seeds/010), same ids the approvals/registration suites use. */
export const CENTRE_A2 = '01a1a98a-ac40-7000-8000-00000000a202';
export const BRANCH_A2 = '01a1a98a-ac40-7000-8000-00000000a102';

/** LabPort `processingStatus` situations, expressed as the lab facts that produce them (so the FAKE derives the state, not the test). */
export type LabState =
  | 'not_started'                       // no specimen received, no result beyond pending
  | 'in_progress'                       // specimen received
  | 'result_entered_only'               // existing-material item: no specimen received, a result is `resulted` (A17.2) -> in_progress
  | 'reported'                          // every non-cancelled order_test reported
  | 'cancelled'                         // every order_test cancelled
  | 'rejected_no_recollection'          // only specimen rejected, no replacement -> D-5: cancelled
  | 'rejected_recollection_pending'     // rejected specimen + replacement not yet received -> not_started
  | 'rejected_recollection_received';   // rejected specimen + replacement received -> in_progress

/** `labOmit`: C4 item exists (active) but the lab fake has no row for it (e.g. items_changed.v1 not yet consumed by C5). */
export interface ItemSpec { lab: LabState; status?: 'active' | 'removed' | 'cancelled'; row?: Record<string, unknown>; labOmit?: boolean }
export interface Scenario { side: 'a' | 'b'; patient: any; order: any; items: any[]; lab: any; billing: any; labPortCalls: () => { input: any; ctx: any }[] }

const D = '2026-11-05T03:00:00.000Z';
let seq = 0;
/** DB order + items (+ optional extras) and the LabPort / BillingCommandPort fakes seeded to match. `o.order` overrides order columns. */
export async function scenario(o: { side?: 'a' | 'b'; stored?: string; items?: readonly (LabState | ItemSpec)[]; order?: Record<string, unknown>; patient?: Record<string, unknown>; centre?: string } = {}): Promise<Scenario> {
  const side = o.side ?? 'a';
  const tenant = side === 'a' ? TENANT_A : TENANT_B;
  const patient = await seedPatient(side, o.patient ?? {});
  const stored = o.stored ?? 'registered';
  const cancelled = stored === 'cancelled' ? { cancelled_at: '2026-11-06T00:00:00Z', cancel_reason_code: 'patient_request' } : {};
  const centre = o.centre ?? CENTRE[side];
  const branch = centre === CENTRE_A2 ? BRANCH_A2 : BRANCH[side];
  const order = rows.order(side, patient.id, { status: stored, centre_id: centre, branch_id: branch, age_years: 43, registration_no: `FDT08-${Date.now() % 1e6}-${++seq}`, ...cancelled, ...(o.order ?? {}) });
  await seed('frontdesk.orders', order);
  const specs = (o.items ?? ['not_started']).map((i) => (typeof i === 'string' ? { lab: i } : i) as ItemSpec);
  const items: any[] = [];
  const fx = { orders: [] as any[], items: [] as any[], specimens: [] as any[], results: [] as any[] };
  fx.orders.push({ id: order.id, tenantId: tenant, patientId: patient.id, centreId: centre, priority: 'routine', patient: { sex: 'female', ageDays: 15000 } });
  for (const s of specs) {
    const status = s.status ?? 'active';
    const removed = status === 'removed' ? { removed_at: '2026-11-06T00:00:00Z', removal_reason_code: 'patient_request' } : {};
    const item = rows.item(side, order.id, { centre_id: centre, status, code: `FD${++seq}`, ...removed, ...(s.row ?? {}) });
    await seed('frontdesk.order_items', item);
    items.push(item);
    if (s.labOmit) continue;
    const base = { id: uid(), tenantId: tenant, orderId: order.id, barcode: `FDT08-${uid().slice(-12)}`, specimenTypeCode: 'BLOOD', itemIds: [item.id], isActive: true, version: 1 };
    fx.items.push({ id: item.id, tenantId: tenant, orderId: order.id, testId: item.test_ids[0], departmentId: uid(), workflowType: 'standard',
      ...(s.lab === 'cancelled' ? { cancelled: true } : {}), ...(s.lab === 'reported' ? { reportedAt: '2026-11-06T04:00:00.000Z' } : {}) });
    const spec = (extra: Record<string, unknown>) => fx.specimens.push({ ...base, id: uid(), barcode: `FDT08-${uid().slice(-12)}`, ...extra });
    switch (s.lab) {
      case 'in_progress': case 'reported': spec({ status: 'received', receivedAt: D }); break;
      case 'result_entered_only':
        fx.results.push({ id: uid(), tenantId: tenant, orderItemId: item.id, testId: item.test_ids[0], analyteId: uid(), versionNo: 1, status: 'resulted', origin: 'manual', commentCodes: [], attachments: [], onHold: false, qcReviewRequired: false });
        break;
      case 'rejected_no_recollection': spec({ status: 'rejected', receivedAt: D }); break;
      case 'rejected_recollection_pending': case 'rejected_recollection_received': {
        const rejected = uid();
        spec({ id: rejected, status: 'rejected', receivedAt: D, isActive: false });
        spec({ status: s.lab === 'rejected_recollection_received' ? 'received' : 'collected', replacesSpecimenId: rejected, ...(s.lab === 'rejected_recollection_received' ? { receivedAt: D } : {}) });
        break;
      }
      default: break;
    }
  }
  const lab: any = createFakeLabPort({ seed: 1, fixtures: fx as any });
  const billing: any = createFakeBillingCommandPort({ seed: 1, fixtures: { orders: [{ id: order.id, tenantId: tenant }] } as any });
  return { side, patient, order, items, lab, billing, labPortCalls: () => lab.calls('getOrderItemProcessingState') as any };
}

/** Extra tenant-A fixtures need one Lab+Billing pair per call; list tests share these fakes across orders. */
export function sharedFakes() {
  const lab: any = createFakeLabPort({ seed: 1, fixtures: { orders: [], items: [], specimens: [], results: [] } as any });
  const billing: any = createFakeBillingCommandPort({ seed: 1, fixtures: {} as any });
  return { lab, billing };
}
/** Merge a scenario's lab/billing fixtures into shared fakes (so one F10 page can hold several scenarios). */
export function mergeInto(shared: ReturnType<typeof sharedFakes>, s: Scenario) {
  const tenant = s.side === 'a' ? TENANT_A : TENANT_B;
  shared.lab.__seed({ orders: s.lab.fixtures.orders.filter((x: any) => x.id === s.order.id), items: s.lab.fixtures.items.filter((x: any) => x.orderId === s.order.id),
    specimens: s.lab.fixtures.specimens.filter((x: any) => x.orderId === s.order.id), results: s.lab.fixtures.results.filter((r: any) => s.items.some((i) => i.id === r.orderItemId)) });
  shared.billing.__seed({ orders: [{ id: s.order.id, tenantId: tenant }] });
}

export interface Opts { grants?: readonly string[]; tenant?: string; centreIds?: readonly string[]; lab?: any; billing?: any; requestId?: string }
export interface Reply { status: number; body: any; wrote: boolean; probe: { logs: string[]; accessCalls: any[]; identity: any; requestId: string; ctx: any } }
const H = handlers as unknown as Record<string, (req: any, ctx: any) => Promise<{ status: number; body?: any }>>;

/** One read = one committed tx under RLS. `wrote` = the tx was assigned a transaction id (a read-only request never is). */
export async function call(operationId: 'getOrder' | 'listOrders', r: ReturnType<typeof req>, o: Opts & { s?: Scenario } = {}): Promise<Reply> {
  const tenant = o.tenant ?? TENANT_A;
  const side = tenant === TENANT_B ? 'b' : 'a';
  const identity: any = makeIdentity(o.grants ?? [PERM], { centreIds: o.centreIds ?? [CENTRE[side]] });
  const lab = o.lab ?? o.s?.lab ?? sharedFakes().lab;
  const billing = o.billing ?? o.s?.billing ?? sharedFakes().billing;
  const probe: Reply['probe'] = { logs: [], accessCalls: [], identity, requestId: o.requestId ?? uid(), ctx: undefined };
  const out = await appTx(tenant, async (tx) => {
    const log = (lvl: string) => (obj: object, msg?: string) => { probe.logs.push(`${lvl} ${JSON.stringify(obj)} ${msg ?? ''}`); };
    const ctx: any = {
      operationId, clientIp: '203.0.113.9', log: { info: log('info'), warn: log('warn'), error: log('error') },
      tenantId: tenant, tx, requestId: probe.requestId, now: () => NOW, centreId: CENTRE[side],
      actor: { type: 'system', id: SYS_ACTOR, membershipId: uid() },
      ports: { IdentityPort: identity, LabPort: lab, BillingCommandPort: billing },
    };
    ctx.audit = { access: async (e: any) => { probe.accessCalls.push(e); await access(ctx, e); } };
    probe.ctx = ctx;
    const reply = await H[operationId]!(r, ctx);
    const x = await tx.query('SELECT txid_current_if_assigned() AS x');
    return { ...reply, wrote: x.rows[0].x !== null };
  });
  return { ...(out as any), probe };
}
export const getOrder = (id: string, o: Opts & { s?: Scenario } = {}) => call('getOrder', req({ params: { order_id: id } }), o);
export const listOrders = (query: object = {}, o: Opts & { s?: Scenario } = {}) => call('listOrders', req({ query }), o);
export const getFails = (id: string, o: Opts & { s?: Scenario } = {}) => rejection(getOrder(id, o));
export const listFails = (query: object, o: Opts & { s?: Scenario } = {}) => rejection(listOrders(query, o));
export const orderRow = async (id: string) => (await ownerRows('frontdesk.orders', 'id = $1', [id]))[0];

/** Every page of a F10 query, following next_cursor. */
export async function allPages(query: Record<string, unknown>, o: Opts & { s?: Scenario } = {}): Promise<{ data: any[]; pages: number }> {
  const data: any[] = [];
  let cursor: string | undefined;
  for (let pages = 1; pages < 100; pages++) {
    const r = await listOrders({ ...query, ...(cursor ? { cursor } : {}) }, o);
    data.push(...r.body.data);
    cursor = r.body.page.next_cursor;
    if (!cursor) return { data, pages };
  }
  throw new Error('cursor never ended');
}
