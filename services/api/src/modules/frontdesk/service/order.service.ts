// Orders read F10 listOrders / F11 getOrder + derived status (02-TRD §5.1 F10/F11; 03-IC §10.4 as amended by 08 A13 D-5 + A17.2; 03-APP-FLOW O4/O5; 07-SECURITY §5, §6.1, §6.2).
// Read-only: no write, no event, no stored-status change (the derived status is computed on every read). One request = ctx.tx (RLS on), explicit tenant filter in every query.
// D-5: in_progress/completed come from LabPort.getOrderItemProcessingState (an item whose only specimen was rejected without recollection is `cancelled` there) through the
// pure deriveOrderStatus; pre_registered / cancelled / completed are returned stored WITHOUT a lab call. The lab call carries {orderId} only (no PHI to C5).
// Centre scope = IdentityPort.getActor().centreScope (as FD-T06/T07); an order outside it is common.not_found (404, never 403: existence is not confirmed).
// FD-T09 (below, after F10): F8b quoteOrderItemsChange, F13 changeOrderItems, F14 cancelOrder (02-TRD §5.1 F8b/F13/F14, §6.4, §8.1; 03-APP-FLOW §2.5/§2.6; 07-SECURITY §5/§6).
import type { IssuedInvoiceRef } from '../../../../../../contracts/ports/BillingCommandPort.js';
import type { LabPortV1 } from '../../../../../../contracts/ports/LabPort.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../core/errors.js';
import { checkCancel, deriveOrderStatus, ORDER_STATUSES, type ItemProcessingStatus, type OrderStatus } from '../domain/order.state.js';
import { createFrontdeskEvents } from '../events/publish.js';
import { decodeCursor, encodeCursor, isoUtc, orderSummaryDto } from '../mappers/patient.dto.js';
import { listDiscountsByOrder } from '../repository/discounts.repo.js';
import { listOrderFlagsByOrder } from '../repository/flags.repo.js';
import { activeItemIdsByOrders, cancelActiveItems, insertOrderItem, listOrderItemsByOrder, removeOrderItem } from '../repository/orderItems.repo.js';
import { bumpOrderItemsVersion, cancelOrderRow, getOrderById, lockOrderById, pageOrders, type OrderFilter } from '../repository/orders.repo.js';
import { getPatientById } from '../repository/patients.repo.js';
import { getSettings } from '../repository/settings.repo.js';
import { listTrfByOrder } from '../repository/trf.repo.js';
import { FRONTDESK_PERMISSIONS as P } from '../permissions.js';
import { bad, expectedVersion, isObj, patientCtx, strict, type PatientCtx, type Result } from './patient.service.js';
import { fiscalYearOf, invoiceDto, lineDto, priceDraft, quoteCtx, totalsDto, type Draft, type Priced, type QuoteCtx } from './registration.service.js';

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
const portCtx = <T extends { now(): Date }>(c: T): T => Object.assign(Object.create(c), { now: () => c.now().toISOString() });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_MS = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const omitNull = (o: Obj): Obj => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));
const money = (v: unknown) => ({ amount_paisa: Number(v), currency: 'NPR' });
const portMoney = (m: Money) => ({ amount_paisa: m.amountPaisa, currency: m.currency });

/** { orderId } is the whole lab input. Iterate over the ACTIVE C4 items (03-IC §10.4 / 08 A13 D-5: "every active item"):
 *  a removed item must neither block `completed` nor start the order, and an active item LabPort does not yet know
 *  (e.g. added by changeOrderItems, not consumed by C5 yet) counts as `not_started` so `completed` is never early. */
export async function derivedStatus(c: OrderCtx, row: Obj, activeIds: ReadonlySet<string>): Promise<OrderStatus> {
  const stored = row['status'] as OrderStatus;
  if (stored !== 'registered' && stored !== 'in_progress') return stored;
  const pc = portCtx(c);
  const states = await c.ports.LabPort.getOrderItemProcessingState(pc, { orderId: row['id'] });
  const by = new Map(states.map((s) => [s.orderItemId, s.processingStatus]));
  return deriveOrderStatus(stored, [...activeIds].map((id) => by.get(id) ?? 'not_started'));
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
  return { status: 200, body: await orderDto(c, o, true) };
}

/** The OrderDto of a loaded row (F11, and the result of F13/F14). `withBilling` = false for a pre-registered order: it is never invoiced, billing is not asked. */
async function orderDto(c: OrderCtx, o: Obj, withBilling: boolean): Promise<Obj> {
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
  if (withBilling) {
    try {
      const b = (await c.ports.BillingCommandPort.getOrderBillingSummary(portCtx(c), { orderId: o['id'] })).balance;
      billing = { order_id: b.orderId, invoiced: portMoney(b.invoiced), paid: portMoney(b.paid), credited: portMoney(b.credited), balance_due: portMoney(b.balanceDue),
        balance_version: b.balanceVersion, as_of: b.asOf };
    } catch (e) { if (!(e instanceof LimsError && e.code === 'common.not_found')) throw e; }
  }

  const orderableOf = new Map<string, string>(items.map((i) => [i['id'], i['orderable_id']]));
  return omitNull({
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
  });
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

// ======================= FD-T09: F8b quoteOrderItemsChange / F13 changeOrderItems / F14 cancelOrder =======================
// One request = ONE tx (ctx.tx). The order row is row-locked first (lockOrderById), so a racing F13/F14 waits, then sees the moved version (409) before any billing call is made.
// Retry-once in a NEW tx on billing.counter_busy / 40P01 (03-APP-FLOW §2.3 step 9, D-25) is NOT done: the handler ctx has no tx opener (same CR as F9: .orchestra/cr/FD-T06-retry-quote-ext.md);
// the error surfaces (409 billing.counter_busy) and the whole request is rolled back, never half-written.
// No log line is written here at all: names, registration no and cancel reason text never reach the logs (07-SECURITY §5).
type ChangeCtx = QuoteCtx & {
  readonly ports: QuoteCtx['ports'] & { readonly LabPort: LabPortV1 };
  readonly events: { publish(ctx: never, type: string, input: never): Promise<{ eventId: string; duplicate: boolean }> };
};
function changeCtx(c: unknown): ChangeCtx {
  const x = quoteCtx(c) as ChangeCtx;
  if (typeof x.ports.LabPort?.getOrderItemProcessingState !== 'function' || typeof x.ports.LabPort.getOrderResults !== 'function' || typeof x.events?.publish !== 'function') throw new LimsError('common.service_unavailable');
  return x;
}
const asOrderCtx = (c: ChangeCtx): OrderCtx => c as unknown as OrderCtx;
const INVOICE_ISSUE = 'billing.invoice.issue';       // F13 on a cash order with additions (03-APP-FLOW §2.5), checked before any write
const CODE = /^[A-Za-z0-9_.:^+\-]{1,64}$/;
const FP = /^[0-9a-f]{64}$/;
type Priority = 'routine' | 'urgent';

/** A port may carry its own error class (no HTTP status): re-raise by code as the core LimsError (08 R18: code and detail unchanged). pg SQLSTATEs are not app codes and pass through. */
async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) {
    const x = e as { code?: unknown; detail?: unknown; statusCode?: unknown } | null;
    if (e instanceof LimsError || typeof x?.code !== 'string' || !/^[a-z_]+\.[a-z_]+$/.test(x.code)) throw e;
    if (typeof x.statusCode === 'number') throw e;                                    // the port error already carries its HTTP status (e.g. billing.counter_busy 409): keep it
    throw new LimsError(x.code, typeof x.detail === 'string' ? x.detail : undefined);
  }
}

const uuidIn = (v: unknown, path: string): string => { if (typeof v !== 'string' || !UUID.test(v)) throw bad(path); return v; };
const codeIn = (v: unknown, path: string): string => { if (typeof v !== 'string' || !CODE.test(v)) throw bad(path); return v; };

/** `priority` is optional (contract RegistrationItem): missing = the stored order's priority, as F9 defaults an item to the draft's priority (see withPriority). */
function parseAdds(raw: unknown, min: number): Array<{ orderableId: string; priority?: Priority }> {
  if (!Array.isArray(raw) || raw.length < min || raw.length > 50) throw bad('/add');
  const seen = new Set<string>();
  return raw.map((x: unknown, i) => {
    const o = strict(x, ['orderable_id', 'priority'], `/add/${i}`);
    const orderableId = uuidIn(o['orderable_id'], `/add/${i}/orderable_id`);
    if (seen.has(orderableId)) throw bad(`/add/${i}/orderable_id`);                    // one line per orderable (as F9): a line carries one priority
    seen.add(orderableId);
    if (o['priority'] === undefined) return { orderableId };
    if (o['priority'] !== 'routine' && o['priority'] !== 'urgent') throw bad(`/add/${i}/priority`);
    return { orderableId, priority: o['priority'] as Priority };
  });
}
const withPriority = (adds: ReturnType<typeof parseAdds>, o: Obj): Array<{ orderableId: string; priority: Priority }> =>
  adds.map((a) => ({ orderableId: a.orderableId, priority: a.priority ?? (o['priority'] as Priority) }));

interface ChangeIn {
  add: Array<{ orderableId: string; priority?: Priority }>; remove: Array<{ itemId: string; reasonCode: string }>;
  fingerprint?: string; payments: Array<{ methodCode: string; amountPaisa: number; reference?: string }>;
}
function parseChange(body: unknown): ChangeIn {
  const b = strict(body, ['add', 'remove', 'quote_fingerprint', 'payments']);
  const add = b['add'] === undefined ? [] : parseAdds(b['add'], 0);
  const rr = b['remove'] === undefined ? [] : b['remove'];
  if (!Array.isArray(rr) || rr.length > 50) throw bad('/remove');
  const seen = new Set<string>();
  const remove = rr.map((x: unknown, i) => {
    const o = strict(x, ['order_item_id', 'reason_code'], `/remove/${i}`);
    const itemId = uuidIn(o['order_item_id'], `/remove/${i}/order_item_id`);
    if (seen.has(itemId)) throw bad(`/remove/${i}/order_item_id`);
    seen.add(itemId);
    return { itemId, reasonCode: codeIn(o['reason_code'], `/remove/${i}/reason_code`) };
  });
  if (add.length === 0 && remove.length === 0) throw bad('');                         // "added/removed are never both empty" (event contract)
  const fp = b['quote_fingerprint'];
  if (add.length > 0) { if (typeof fp !== 'string' || !FP.test(fp)) throw bad('/quote_fingerprint'); }
  else if (fp !== undefined) throw bad('/quote_fingerprint');                         // "omitted when add is empty"
  const pr = b['payments'] === undefined ? [] : b['payments'];
  if (!Array.isArray(pr) || pr.length > 5 || (pr.length > 0 && add.length === 0)) throw bad('/payments');   // a payment needs the supplementary invoice of an addition
  const payments = pr.map((x: unknown, i) => {
    const o = strict(x, ['method_code', 'amount_received_paisa', 'reference', 'tendered_paisa'], `/payments/${i}`);
    if (typeof o['method_code'] !== 'string' || o['method_code'].length < 1 || o['method_code'].length > 64) throw bad(`/payments/${i}/method_code`);
    if (!Number.isSafeInteger(o['amount_received_paisa']) || o['amount_received_paisa'] < 1) throw bad(`/payments/${i}/amount_received_paisa`);
    if (o['reference'] !== undefined && (typeof o['reference'] !== 'string' || o['reference'].length > 100)) throw bad(`/payments/${i}/reference`);
    if (o['tendered_paisa'] !== undefined && (!Number.isSafeInteger(o['tendered_paisa']) || o['tendered_paisa'] < 1)) throw bad(`/payments/${i}/tendered_paisa`);
    return { methodCode: o['method_code'], amountPaisa: o['amount_received_paisa'] as number, ...(typeof o['reference'] === 'string' ? { reference: o['reference'] } : {}) };
  });
  return { add, remove, ...(typeof fp === 'string' ? { fingerprint: fp } : {}), payments };
}

/** The order of the path, tenant-filtered; outside the actor's centre scope = 404 (never 403). `lock` = row lock (F13/F14). */
async function loadOrder(c: ChangeCtx, params: unknown, lock: boolean): Promise<Obj> {
  const id = isObj(params) ? params['order_id'] : undefined;
  const o = typeof id === 'string' && UUID.test(id) ? await (lock ? lockOrderById : getOrderById)(c.tx, c.tenantId, id) : null;
  if (!o) throw new LimsError('common.not_found');
  const scope = await scopeOf(asOrderCtx(c));
  if (!scope.all && !scope.centreIds.includes(o['centre_id'])) throw new LimsError('common.not_found');
  return o;
}
/** Editable = registered | in_progress (APP-FLOW §2.5). pre_registered goes through F12 items_override; completed is closed. */
function assertEditable(o: Obj): void {
  if (o['status'] === 'cancelled') throw new LimsError('frontdesk.order_already_cancelled');
  if (o['status'] !== 'registered' && o['status'] !== 'in_progress') throw new LimsError('frontdesk.order_not_editable');
}

/** F8b / F13 step 3: price `adds` in the STORED order's context (centre, referrer, credit party; precedence is C3's). Fingerprint = over exactly these lines, no discounts. */
async function priceAdds(c: ChangeCtx, o: Obj, adds: ReturnType<typeof withPriority>): Promise<Priced> {
  const d: Draft = {
    centreId: o['centre_id'], billingMode: o['billing_mode'], visitType: o['visit_type'], priority: o['priority'], collectionMode: o['collection_mode'],
    ...(o['credit_party_id'] ? { creditPartyId: o['credit_party_id'] } : {}), ...(o['referrer_id'] ? { referrerId: o['referrer_id'] } : {}),
    items: adds.map((a) => ({ orderableId: a.orderableId, priority: a.priority })), discounts: [],
  };
  return priceDraft(c, d, await getSettings(c.tx, c.tenantId));
}

// ---------------- F8b quoteOrderItemsChange (read-only) ----------------
export function quoteItemsChange(hctx: unknown, params: unknown, body: unknown): Promise<Result> {
  return wrap(async () => {
    const c = changeCtx(hctx);
    await c.ports.IdentityPort.assertRole(c, { permission: P.orderEdit });
    const adds = parseAdds(strict(body, ['add'])['add'], 1);
    const o = await loadOrder(c, params, false);
    assertEditable(o);
    const { resolved, q, limits, verdict } = await priceAdds(c, o, withPriority(adds, o));
    const tz = ((await c.ports.IdentityPort.getTenantSettings(c, { keys: ['timezone'] })) ?? {}).timezone;
    return { status: 200, body: {
      lines: q.lines.map(lineDto), totals: totalsDto(q.totals),
      discount_evaluation: { within_limit: verdict === 'within_limit', approval_required: verdict === 'approval_required', limit_percent_bp: limits.selfLimitBp, limit_paisa: limits.selfLimitPaisa },
      catalog_revision: resolved.catalogRevision, quote_fingerprint: q.fingerprint, base_fingerprint: q.baseFingerprint, fiscal_year_bs: fiscalYearOf(c.now(), tz),
    } };
  });
}

// ---------------- F13 changeOrderItems ----------------
const supplementaryDto = (c: ChangeCtx, inv: IssuedInvoiceRef, p: Priced, o: Obj, buyer: Obj): Promise<Obj> => invoiceDto(c, inv, p, o, buyer);

export function changeItems(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  return wrap(async () => {
    const c = changeCtx(hctx);
    const { IdentityPort: identity, BillingCommandPort: billing, LabPort: lab } = c.ports;
    await identity.assertRole(c, { permission: P.orderEdit });
    const version = expectedVersion(headers);
    const r = parseChange(body);
    const o = await loadOrder(c, params, true);
    assertEditable(o);
    if (Number(o['version']) !== version) throw new LimsError('common.version_conflict');
    const orderId: string = o['id'];
    const credit = o['billing_mode'] === 'credit';
    if (credit && r.payments.length > 0) throw bad('/payments');                       // credit orders take no payment (as F9)
    if (r.add.length > 0 && !credit) await identity.assertRole(c, { permission: INVOICE_ISSUE, centreId: o['centre_id'] });   // checked before any write
    const pc = portCtx(c);

    // removal guard (TRD §6.4): LabPort says per item whether it is still removable; ONE blocked item fails the whole request. {orderId} only, no PHI.
    if (r.remove.length > 0) {
      const have = new Map((await listOrderItemsByOrder(c.tx, c.tenantId, orderId)).map((i) => [i['id'] as string, i]));
      for (const x of r.remove) {
        const it = have.get(x.itemId);
        if (!it) throw new LimsError('common.not_found');                              // not an item of THIS order (another order's id is no different from a random one)
        if (it['status'] !== 'active') throw new LimsError('frontdesk.order_not_editable');
      }
      const states = new Map((await lab.getOrderItemProcessingState(pc, { orderId: orderId as never })).map((s) => [s.orderItemId as string, s]));
      // fails CLOSED (03-IC §3.2, TRD:482): an item LabPort does not report is not removable.
      if (r.remove.some((x) => states.get(x.itemId)?.removable !== true)) throw new LimsError('frontdesk.order_not_editable');
    }

    // stale-quote guard: the fingerprint must equal the F8b quote over exactly `add`, re-priced now inside this tx (nothing is written and no counter touched before this)
    let p: Priced | undefined;
    if (r.add.length > 0) {
      p = await priceAdds(c, o, withPriority(r.add, o));
      if (p.q.fingerprint !== r.fingerprint) throw new LimsError('common.version_conflict', 'Prices changed');     // fresh `quote` extension: same CR as F9 (FD-T06-retry-quote-ext.md)
    }

    const at = c.now();
    const by = c.actor.membershipId ?? c.actor.id;
    const itemsVersion = Number(o['items_version']) + 1;
    const added: any[] = [];
    for (const l of p?.priced ?? []) {
      const i = added.length;
      added.push(await insertOrderItem(c.tx, c.tenantId, {
        id: uuidv7(), order_id: orderId, centre_id: o['centre_id'], orderable_id: l.orderableId, orderable_kind: l.orderableKind, code: l.code, name: l.name,
        test_ids: p!.meta[i]!.testIds, department_id: p!.meta[i]!.departmentId, priority: l.priority, unit_price_paisa: l.unitPrice.amountPaisa,
        urgent_surcharge_paisa: l.urgentSurcharge?.amountPaisa, price_list_id: l.priceListId, price_list_version: l.priceListVersion, price_source: l.priceSource,
        vat_treatment: l.tax.vat, other_tax_code: l.tax.otherTaxCode, added_in_items_version: itemsVersion,
      }));
    }
    for (const x of r.remove) if (!(await removeOrderItem(c.tx, c.tenantId, orderId, x.itemId, { at, by, reasonCode: x.reasonCode }))) throw new LimsError('frontdesk.order_not_editable');

    // billing, same tx. Removals first, the invoice counter (inside billing) last: short lock window (as F9).
    let creditNote = false;
    const byReason = new Map<string, string[]>();
    for (const x of r.remove) (byReason.get(x.reasonCode) ?? byReason.set(x.reasonCode, []).get(x.reasonCode)!).push(x.itemId);
    for (const [reasonCode, ids] of byReason) {
      // credit: charges not yet on a periodic invoice are voided; those already on one cannot be, so finance gets a credit-note task on that periodic invoice (US-BL-10.5).
      // cash: the lines of the issued invoice must be credited (task only, no fiscal document is created here).
      const orderItemIds = ids as never[];
      const open = credit ? (await billing.voidCreditCharges(pc, { orderId: orderId as never, orderItemIds, reasonCode })).alreadyInvoiced.length > 0 : true;
      if (open) creditNote = (await billing.raiseCreditNoteRequirement(pc, { orderId: orderId as never, orderItemIds, cause: 'item_removed', reasonCode })).required || creditNote;
    }
    let supplementary: Obj | undefined;
    if (p) {
      const patient = (await getPatientById(c.tx, c.tenantId, o['patient_id']))!;
      const refPart = o['referrer_id'] ? { referrerId: o['referrer_id'] as never } : {};
      const common = { orderId: orderId as never, branchId: o['branch_id'] as never, centreId: o['centre_id'] as never, ...refPart, lines: p.priced, discounts: p.discounts, expectedFingerprint: r.fingerprint! };
      if (credit) {
        await billing.recordCreditCharges(pc, { ...common, creditPartyId: o['credit_party_id'] as never, patientDisplayName: String(patient['full_name']) });
      } else {
        const buyer = { name: String(patient['full_name']), ...(patient['address_text'] ? { address: String(patient['address_text']) } : {}) };
        const inv = await billing.issueOrderInvoice(pc, { ...common, patientId: o['patient_id'], buyer, purpose: 'supplementary' });
        for (const [i, pay] of r.payments.entries()) {
          await billing.recordPayment(pc, {
            orderId: orderId as never, invoiceId: inv.invoiceId, methodCode: pay.methodCode, amount: { amountPaisa: pay.amountPaisa, currency: 'NPR' } as never,
            ...(pay.reference ? { reference: pay.reference } : {}), captureKind: 'manual', idempotencyKey: `${orderId}:items:${Number(o['version']) + 1}:${i}`,
            collectedByMembershipId: by as never, issueReceiptNo: false,       // the supplementary invoice is the receipt (PRD D-RECEIPT, as F9)
          });
        }
        supplementary = await supplementaryDto(c, inv, p, o, buyer);
      }
    }

    const updated = await bumpOrderItemsVersion(c.tx, c.tenantId, orderId, version, creditNote);
    if (!updated) throw new LimsError('common.version_conflict');
    await createFrontdeskEvents(c.events as never).itemsChanged(c as never, {
      order_id: orderId, items_version: itemsVersion,
      added: added.map((it, i) => ({ order_item_id: it['id'], orderable_id: it['orderable_id'], orderable_kind: it['orderable_kind'], test_ids: p!.meta[i]!.testIds, priority: it['priority'] })),
      removed: r.remove.map((x) => ({ order_item_id: x.itemId, reason_code: x.reasonCode })), changed_at: at.toISOString(),
    }, Number(updated['version']));
    return { status: 200, body: { ...(await orderDto(asOrderCtx(c), updated, true)), ...(supplementary ? { supplementary_invoice: supplementary } : {}), credit_note_required: creditNote } };
  });
}

// ---------------- F14 cancelOrder ----------------
export function cancelOrder(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  return wrap(async () => {
    const c = changeCtx(hctx);
    const { IdentityPort: identity, BillingCommandPort: billing, LabPort: lab } = c.ports;
    await identity.assertRole(c, { permission: P.orderCancel });
    const version = expectedVersion(headers);
    const b = strict(body, ['reason_code', 'reason_text']);
    const reasonCode = codeIn(b['reason_code'], '/reason_code');
    const text = b['reason_text'];
    if (text !== undefined && (typeof text !== 'string' || text.length > 500 || text.includes('\u0000'))) throw bad('/reason_text');
    const o = await loadOrder(c, params, true);
    const status = o['status'] as OrderStatus;
    const refuse = (k: { ok: boolean; code?: string }) => { if (!k.ok) throw new LimsError(k.code!); };
    refuse(checkCancel({ status, hasApprovedResults: false }));                       // already cancelled / completed (11.3)
    if (Number(o['version']) !== version) throw new LimsError('common.version_conflict');
    const orderId: string = o['id'];
    const pc = portCtx(c);
    // 11.2: an APPROVED result blocks the cancel. A pre-registered order has no lab footprint. {orderId, scope} only, no PHI. A lab failure propagates: fail closed.
    if (status !== 'pre_registered') {
      const res = await lab.getOrderResults(pc, { orderId: orderId as never, scope: 'approved' });
      refuse(checkCancel({ status, hasApprovedResults: res.items.some((i) => i.results.length > 0) }));
    }

    // billing, same tx. Pre-registered orders were never invoiced: no billing call. Payments are NOT refunded automatically (11.1).
    let required = false;
    if (status !== 'pre_registered') {
      // credit (11.4 / US-BL-10.5): unbilled charges are voided; charges already on a periodic invoice need a credit-note task on that invoice. cash: a task for the issued invoice.
      const open = o['billing_mode'] === 'credit' ? (await billing.voidCreditCharges(pc, { orderId: orderId as never, reasonCode })).alreadyInvoiced.length > 0 : true;
      if (open) required = (await billing.raiseCreditNoteRequirement(pc, { orderId: orderId as never, cause: 'order_cancelled', reasonCode })).required;
    }
    await cancelActiveItems(c.tx, c.tenantId, orderId);
    const at = c.now();
    const updated = await cancelOrderRow(c.tx, c.tenantId, orderId, version, { at, by: c.actor.membershipId ?? c.actor.id, reasonCode, ...(typeof text === 'string' ? { reasonText: text } : {}), requiresCreditNote: required });
    if (!updated) throw new LimsError('common.version_conflict');
    // the event never carries reason_text (P3)
    await createFrontdeskEvents(c.events as never).cancelled(c as never, { order_id: orderId, reason_code: reasonCode, cancelled_at: at.toISOString(), requires_credit_note: required }, Number(updated['version']));
    return { status: 200, body: await orderDto(asOrderCtx(c), updated, status !== 'pre_registered') };
  });
}
