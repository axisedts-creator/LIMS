// Orders read F10 listOrders / F11 getOrder + derived status (02-TRD §5.1 F10/F11; 03-IC §10.4 as amended by 08 A13 D-5 + A17.2; 03-APP-FLOW O4/O5; 07-SECURITY §5, §6.1, §6.2).
// Read-only: no write, no event, no stored-status change (the derived status is computed on every read). One request = ctx.tx (RLS on), explicit tenant filter in every query.
// D-5: in_progress/completed come from LabPort.getOrderItemProcessingState (an item whose only specimen was rejected without recollection is `cancelled` there) through the
// pure deriveOrderStatus; pre_registered / cancelled / completed are returned stored WITHOUT a lab call. The lab call carries {orderId} only (no PHI to C5).
// Centre scope = IdentityPort.getActor().centreScope (as FD-T06/T07); an order outside it is common.not_found (404, never 403: existence is not confirmed).
import { LimsError } from '../../../core/errors.js';
import { deriveOrderStatus, ORDER_STATUSES, type ItemProcessingStatus, type OrderStatus } from '../domain/order.state.js';
import { decodeCursor, encodeCursor, isoUtc, orderSummaryDto } from '../mappers/patient.dto.js';
import { listDiscountsByOrder } from '../repository/discounts.repo.js';
import { listOrderFlagsByOrder } from '../repository/flags.repo.js';
import { activeItemIdsByOrders, listOrderItemsByOrder } from '../repository/orderItems.repo.js';
import { getOrderById, pageOrders, type OrderFilter } from '../repository/orders.repo.js';
import { getPatientById } from '../repository/patients.repo.js';
import { listTrfByOrder } from '../repository/trf.repo.js';
import { FRONTDESK_PERMISSIONS as P } from '../permissions.js';
import { bad, isObj, patientCtx, strict, type PatientCtx, type Result } from './patient.service.js';

type Obj = Record<string, any>;
type Money = { amountPaisa: number; currency: string };
interface OrderCtx extends PatientCtx {
  readonly ports: PatientCtx['ports'] & {
    readonly LabPort: { getOrderItemProcessingState: (c: unknown, i: { orderId: string }) => Promise<readonly { orderItemId: string; processingStatus: ItemProcessingStatus }[]> };
    readonly BillingCommandPort: { getOrderBillingSummary: (c: unknown, i: { orderId: string }) => Promise<{ balance: { orderId: string; invoiced: Money; paid: Money; credited: Money; balanceDue: Money; balanceVersion: number; asOf: string } }> };
  };
  /** Optional tenant-bound name lookup (as FD-T07); without it display names are ''. */
  readonly core?: { membership?: (c: unknown, i: { membershipId: string }) => Promise<{ displayName: string }> };
}

function orderCtx(c: unknown): OrderCtx {
  const x = patientCtx(c) as OrderCtx;
  if (typeof x.ports.LabPort?.getOrderItemProcessingState !== 'function' || typeof x.ports.BillingCommandPort?.getOrderBillingSummary !== 'function') throw new LimsError('common.service_unavailable');
  return x;
}
/** Port calls take an ISO-string clock (registration.service portCtx); Object.create keeps tenantId/actor/tx visible to the port. */
const portCtx = (c: OrderCtx): OrderCtx => Object.assign(Object.create(c), { now: () => c.now().toISOString() });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_MS = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const omitNull = (o: Obj): Obj => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));
const money = (v: unknown) => ({ amount_paisa: Number(v), currency: 'NPR' });
const portMoney = (m: Money) => ({ amount_paisa: m.amountPaisa, currency: m.currency });

/** { orderId } is the whole lab input. Only ACTIVE C4 items count (a removed item must neither block `completed` nor start the order). */
async function derivedStatus(c: OrderCtx, row: Obj, activeIds: ReadonlySet<string>): Promise<OrderStatus> {
  const stored = row['status'] as OrderStatus;
  if (stored !== 'registered' && stored !== 'in_progress') return stored;
  const pc = portCtx(c);
  const states = await c.ports.LabPort.getOrderItemProcessingState(pc, { orderId: row['id'] });
  return deriveOrderStatus(stored, states.filter((s) => activeIds.has(s.orderItemId)).map((s) => s.processingStatus));
}

async function scopeOf(c: OrderCtx): Promise<{ all: boolean; centreIds: readonly string[] }> {
  const s = (await c.ports.IdentityPort.getActor(c)).centreScope as { all?: boolean; centreIds?: readonly string[] } | undefined;
  return { all: s?.all === true, centreIds: s?.centreIds ?? [] };      // no scope = no centre (fail closed)
}

// ======================= F11 getOrder =======================
function nameOf(c: OrderCtx) {
  const seen = new Map<string, Promise<string>>();
  return (membershipId: unknown): Promise<string> => {
    const id = String(membershipId);
    let p = seen.get(id);
    if (!p) {
      const look = c.core?.membership;
      p = look ? look(c, { membershipId: id }).then((m) => m.displayName, (e) => { if (e instanceof LimsError && e.code === 'common.not_found') return ''; throw e; }) : Promise.resolve('');
      seen.set(id, p);
    }
    return p;
  };
}

export async function getOrder(hctx: unknown, params: unknown): Promise<Result> {
  const c = orderCtx(hctx);
  await c.ports.IdentityPort.assertRole(c, { permission: P.orderRead });
  const id = isObj(params) ? params['order_id'] : undefined;
  const o = typeof id === 'string' && UUID.test(id) ? await getOrderById(c.tx, c.tenantId, id) : null;
  if (!o) throw new LimsError('common.not_found');
  const scope = await scopeOf(c);
  if (!scope.all && !scope.centreIds.includes(o['centre_id'])) throw new LimsError('common.not_found');

  const patient = await getPatientById(c.tx, c.tenantId, o['patient_id']);
  if (!patient) throw new LimsError('common.not_found');
  const items = await listOrderItemsByOrder(c.tx, c.tenantId, o['id']);
  const status = await derivedStatus(c, o, new Set(items.filter((i) => i['status'] === 'active').map((i) => i['id'])));
  const discounts = (await listDiscountsByOrder(c.tx, c.tenantId, o['id'])).filter((d) => d['status'] === 'applied');
  const trfs = await listTrfByOrder(c.tx, c.tenantId, o['id']);
  const flags = await listOrderFlagsByOrder(c.tx, c.tenantId, o['id']);
  const name = nameOf(c);
  const actor = async (m: unknown) => ({ membership_id: m, display_name: await name(m) });   // [CONV] created_by / resolved_by hold the membership id

  // Billing may not know a pre-registered order yet: not_found there means "no block", every other port error propagates.
  let billing: Obj | undefined;
  try {
    const b = (await c.ports.BillingCommandPort.getOrderBillingSummary(portCtx(c), { orderId: o['id'] })).balance;
    billing = { order_id: b.orderId, invoiced: portMoney(b.invoiced), paid: portMoney(b.paid), credited: portMoney(b.credited), balance_due: portMoney(b.balanceDue),
      balance_version: b.balanceVersion, as_of: b.asOf };
  } catch (e) { if (!(e instanceof LimsError && e.code === 'common.not_found')) throw e; }

  const orderableOf = new Map<string, string>(items.map((i) => [i['id'], i['orderable_id']]));
  return { status: 200, body: omitNull({
    id: o['id'], registration_no: o['registration_no'],
    patient: { id: patient['id'], patient_code: patient['patient_code'], full_name: patient['anonymised_at'] != null ? '' : String(patient['full_name'] ?? ''), sex: patient['sex'],
      age_at_order: o['age_years'] != null ? `${o['age_years']} Years` : 'Unknown' },    // snapshot at order time (ageDisplay format)
    branch_id: o['branch_id'], centre_id: o['centre_id'], visit_type: o['visit_type'], billing_mode: o['billing_mode'], credit_party_id: o['credit_party_id'],
    referrer_id: o['referrer_id'], priority: o['priority'], collection_mode: o['collection_mode'], source: o['source'], source_ref_id: o['source_ref_id'], status,
    items: items.map((i) => omitNull({ id: i['id'], orderable_id: i['orderable_id'], orderable_kind: i['orderable_kind'], code: i['code'], name: i['name'], priority: i['priority'],
      status: i['status'], unit_price: money(i['unit_price_paisa']), urgent_surcharge: i['urgent_surcharge_paisa'] != null ? money(i['urgent_surcharge_paisa']) : undefined,
      outsourced: i['outsourced'] === true })),
    discounts: discounts.map((d) => omitNull({ scope: d['scope'], orderable_id: d['order_item_id'] ? orderableOf.get(d['order_item_id']) : undefined, kind: d['kind'],
      amount_paisa: d['amount_paisa'] != null ? Number(d['amount_paisa']) : undefined, percent_bp: d['percent_bp'] ?? undefined, reason_code: d['reason_code'], reason_text: d['reason_text'] })),
    // TRF: metadata only (07-SECURITY P2): never object_path / sha256 / URL; content is F21a's job.
    trf_attachments: await Promise.all(trfs.map(async (t) => omitNull({ id: t['id'], order_id: t['order_id'], mime_type: t['mime_type'], size_bytes: Number(t['size_bytes']),
      scan_state: t['scan_state'], uploaded_at: isoUtc(t['created_at']), uploaded_by: await actor(t['created_by']), original_filename: t['original_filename'] ?? '' }))),
    flags: await Promise.all(flags.map(async (f) => omitNull({ id: f['id'], order_id: f['order_id'], kind: f['kind'], status: f['status'], specimen_id: f['specimen_id'],
      created_at: isoUtc(f['created_at']), resolved_at: isoUtc(f['resolved_at']), resolved_by: f['resolved_by'] ? await actor(f['resolved_by']) : undefined,
      resolution_code: f['resolution_code'], version: Number(f['version']) }))),
    requires_credit_note: o['requires_credit_note'] === true, registered_at: isoUtc(o['registered_at']), cancelled_at: isoUtc(o['cancelled_at']),
    cancel_reason_code: o['cancel_reason_code'], billing, version: Number(o['version']),
  }) };
}

// ======================= F10 listOrders =======================
function parseListQuery(query: unknown) {
  const q = strict(query ?? {}, ['status', 'centre_id', 'registered_at_from', 'registered_at_to', 'source', 'has_open_flag', 'sort', 'cursor', 'limit']);
  const f: OrderFilter = {};
  if (q['status'] !== undefined) { if (typeof q['status'] !== 'string' || !(ORDER_STATUSES as readonly string[]).includes(q['status'])) throw bad('/status'); f.status = q['status']; }
  if (q['centre_id'] !== undefined) { if (typeof q['centre_id'] !== 'string' || !UUID.test(q['centre_id'])) throw bad('/centre_id'); f.centreId = q['centre_id']; }
  if (q['source'] !== undefined) { if (typeof q['source'] !== 'string' || q['source'].length < 1 || q['source'].length > 32 || q['source'].includes('\u0000')) throw bad('/source'); f.source = q['source']; }
  for (const [k, slot] of [['registered_at_from', 'from'], ['registered_at_to', 'to']] as const) {
    const v = q[k];
    if (v === undefined) continue;
    if (typeof v !== 'string' || !ISO_MS.test(v) || Number.isNaN(Date.parse(v)) || new Date(v).toISOString() !== v) throw bad(`/${k}`);   // round trip rejects 2041-02-30
    f[slot] = v;
  }
  const h = q['has_open_flag'];
  if (h !== undefined) { if (h !== true && h !== false && h !== 'true' && h !== 'false') throw bad('/has_open_flag'); f.hasOpenFlag = h === true || h === 'true'; }
  const sort = q['sort'] ?? '-registered_at';
  if (sort !== '-registered_at' && sort !== 'registered_at') throw bad('/sort');
  const raw = q['limit'];
  const limit = raw === undefined ? 50 : typeof raw === 'string' && /^[0-9]{1,3}$/.test(raw) ? Number(raw) : raw;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 200) throw bad('/limit');
  const after = q['cursor'] === undefined ? undefined : decodeCursor(q['cursor'], sort);
  return { f, sort: sort as string, limit: limit as number, after };
}

export async function listOrders(hctx: unknown, query: unknown): Promise<Result> {
  const c = orderCtx(hctx);
  await c.ports.IdentityPort.assertRole(c, { permission: P.orderRead });
  const { f, sort, limit, after } = parseListQuery(query);
  const scope = await scopeOf(c);
  if (!scope.all) f.scopeCentreIds = scope.centreIds;
  const rows = await pageOrders(c.tx, c.tenantId, f, { asc: sort === 'registered_at', limit, ...(after ? { after } : {}) });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  // status is derived per row: one lab call per registered/in_progress order of the page (nothing is cached or stored)
  const active = await activeItemIdsByOrders(c.tx, c.tenantId, page.filter((o) => o['status'] === 'registered' || o['status'] === 'in_progress').map((o) => o['id']));
  const data = await Promise.all(page.map(async (o) => orderSummaryDto({ ...o, status: await derivedStatus(c, o, active.get(o['id']) ?? new Set()) }, String(o['patient_display'] ?? ''))));
  return { status: 200, body: { data, page: { limit, ...(rows.length > limit && last ? { next_cursor: encodeCursor(sort, last['sort_key'], last['id']) } : {}) } } };
}
