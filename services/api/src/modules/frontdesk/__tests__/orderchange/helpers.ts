// FD-T09 harness (F8b quoteOrderItemsChange, F13 changeOrderItems, F14 cancelOrder). Same convention as ../orders/helpers.ts and ../registration/helpers.ts:
// the handler is driven with a request-shaped object + a HandlerContext over a REAL PG17 tx (lims_api, RLS on). Ports are the REAL fakes from packages/fakes
// (CatalogPort via ../quote/helpers `world`, LabPort and BillingCommandPort via ../orders/helpers `scenario`); no hand-rolled price / lab / billing logic.
// ASSUMED ctx (as FD-T06/T08): tenantId, tx, requestId, now() (Date), actor, centreId, audit.access, ctx.ports.{IdentityPort,CatalogPort,BillingCommandPort,LabPort},
//   ctx.events = REAL core createEvents({producer:'frontdesk'}) (core.event_log on ctx.tx), ctx.core = REAL createCoreRepo. One request = one tx (committed, or rolled back on throw).
//   If-Match is the order `version` as `"<n>"` (02-CV §4.2, as F4/F18); absent -> common.precondition_required, stale -> common.version_conflict.
// Billing fake facts the tests rely on: raiseCreditNoteRequirement only "touches" invoices whose fixture `orderItemIds` include a removed/cancelled item (or the order's own
//   invoices when no ids are given) and credit charges that sit on a periodic invoice; voidCreditCharges voids only charges NOT on a periodic invoice and returns the rest as
//   `alreadyInvoiced`. The fixtures below set that state directly, so the tests do not depend on what FD-T06 puts on billing lines.
// The fake billing counter / invoices are in memory and NOT transactional (no rollback): atomicity is asserted on the DATABASE (rows + core.event_log), not on the fake.
import { createFakeBillingCommandPort } from '../../../../../../../packages/fakes/src/BillingCommandPort.fake';
import { err as portErr } from '../../../../../../../packages/fakes/src/base';
import { access } from '../../../../core/audit/access.js';
import { createCoreRepo } from '../../../../core/core-repo/index.js';
import { createEvents } from '../../../../core/events/publish.js';
import { handlers } from '../../handlers/index.js';
import { CENTRE_A2, scenario, type ItemSpec, type LabState, type Scenario } from '../orders/helpers.js';
import { CENTRE, NOW, SYS_ACTOR, TENANT_A, TENANT_B, appTx, makeIdentity, ownerRows, rejection, req, schemaErrors, seedSettings, superTx, uid } from '../patients/helpers.js';
import { CP, O, REFERRER, T, world, type WorldOpts } from '../quote/helpers.js';
import { ensureTaskRegistry } from '../registration/helpers.js';

export { CENTRE, CENTRE_A2, CP, NOW, O, REFERRER, T, TENANT_A, TENANT_B, ownerRows, rejection, req, schemaErrors, seedSettings, superTx, uid };
export const EDIT = 'frontdesk.order.edit';
export const CANCEL = 'frontdesk.order.cancel';
export const INVOICE = 'billing.invoice.issue';
export const NOW_ISO = NOW.toISOString();
export const money = (n: number) => ({ amount_paisa: n, currency: 'NPR' });

export interface ItemDef {
  /** the lab fake has NO row for this item (C5 has not consumed items_changed yet) */ labOmit?: boolean;
  orderable: string; code: string; lab?: LabState; status?: 'active' | 'removed' | 'cancelled'; price?: number;
  /** cash: the registration invoice (fake fixture) lists this item among its lines */ invoiced?: boolean;
  /** credit: a credit charge exists for the item; `periodic` = already on a periodic invoice */ charge?: 'open' | 'periodic';
}
export const CBC: ItemDef = { orderable: O.cbc, code: 'CBC', price: 50000 };
export const GLU: ItemDef = { orderable: O.glu, code: 'GLU', price: 20000 };
export interface EditOpts {
  mode?: 'cash' | 'credit'; stored?: string; items?: readonly ItemDef[]; referrer?: boolean; centre?: string; side?: 'a' | 'b'; wopts?: WorldOpts;
  /** cash only: a registration invoice exists (default true) and is fully paid (default false) */ invoice?: boolean; paid?: boolean; creditParty?: string;
}
export interface E extends Scenario { tenant: string; centre: string; w: ReturnType<typeof world>; mode: 'cash' | 'credit'; itemOf: (code: string) => any; net: number }

/** A committed order (+items) with the LabPort / BillingCommandPort fakes seeded to match; the CatalogPort world is the FD-T05 one. */
export async function edit(o: EditOpts = {}): Promise<E> {
  await seedSettings();
  await ensureTaskRegistry(); // ruling FD-T09 #1: app.enqueue_job needs core.g_task_registry rows
  const side = o.side ?? 'a';
  const tenant = side === 'a' ? TENANT_A : TENANT_B;
  const mode = o.mode ?? 'cash';
  const defs = o.items ?? [CBC, GLU];
  const centre = o.centre ?? CENTRE[side];
  const specs: ItemSpec[] = defs.map((d) => ({ lab: d.lab ?? 'not_started', ...(d.labOmit ? { labOmit: true } : {}), ...(d.status ? { status: d.status } : {}),
    row: { orderable_id: d.orderable, code: d.code, name: `${d.code} synthetic test`, unit_price_paisa: d.price ?? 50000, vat_treatment: 'exempt' } }));
  const s = await scenario({ side, stored: o.stored ?? 'registered', items: specs, centre, order: { billing_mode: mode, ...(mode === 'credit' ? { credit_party_id: o.creditParty ?? CP.ok } : {}),
    ...(o.referrer ? { referrer_id: REFERRER } : {}) } });
  const net = defs.reduce((a, d) => a + (d.price ?? 50000), 0);
  const ids = (pred: (d: ItemDef) => boolean) => defs.flatMap((d, i) => (pred(d) ? [s.items[i].id] : []));
  const invoices = mode === 'cash' && (o.invoice ?? true) && o.stored !== 'pre_registered'
    ? [{ id: uid(), tenantId: tenant, orderId: s.order.id, purpose: 'registration', invoiceNo: '2083/84-900001', fiscalYearBs: '2083/84', issuedAt: '2026-11-05T04:15:00.000Z', netPaisa: net,
        orderItemIds: ids((d) => d.invoiced !== false) }] : [];
  const creditCharges = mode === 'credit' ? defs.flatMap((d, i) => (d.status && d.status !== 'active' ? [] : [{ id: uid(), tenantId: tenant, orderId: s.order.id, orderItemId: s.items[i].id,
    creditPartyId: o.creditParty ?? CP.ok, amountPaisa: d.price ?? 50000, periodicInvoiceId: d.charge === 'periodic' ? uid() : null, invoiceLineId: null, voided: false }])) : [];
  s.billing.__seed({
    creditParties: [{ id: CP.ok, tenantId: TENANT_A, allowsCredit: true, isActive: true, isLocked: false, creditLimitPaisa: 1_000_000, outstandingPaisa: 0 },
      { id: CP.over, tenantId: TENANT_A, allowsCredit: true, isActive: true, isLocked: false, creditLimitPaisa: 1000, outstandingPaisa: 0 }],
    invoices, creditCharges,
    payments: o.paid && invoices.length ? [{ id: uid(), tenantId: tenant, orderId: s.order.id, amountPaisa: net }] : [],
  } as any);
  return { ...s, tenant, centre, w: world(o.wopts), mode, net, itemOf: (code) => s.items[defs.findIndex((d) => d.code === code)] };
}

/** Plant an APPROVED lab result on an item (LabPort.getOrderResults scope 'approved' then returns it). */
export function approveResult(e: E, itemId: string) {
  const item = e.items.find((i) => i.id === itemId);
  e.lab.__seed({ results: [{ id: uid(), tenantId: e.tenant, orderItemId: itemId, testId: item.test_ids[0], analyteId: uid(), versionNo: 1, status: 'approved', origin: 'manual',
    commentCodes: [], attachments: [], onHold: false, qcReviewRequired: false, approvedAt: '2026-11-06T04:00:00.000Z' }] } as any);
}

export interface CallOpts {
  grants?: readonly string[]; tenant?: string; centreIds?: readonly string[]; requestId?: string; now?: Date; billing?: any; lab?: any; w?: ReturnType<typeof world>;
  /** If-Match header: default = the order's current version; `null` = header absent; string = sent verbatim */ ifMatch?: string | null; failEvent?: string; headers?: Record<string, string>;
}
export interface Reply { status: number; body: any; wrote: boolean; probe: { logs: string[]; accessCalls: any[]; identity: any; requestId: string; ctx: any } }
type OperationId = 'quoteOrderItemsChange' | 'changeOrderItems' | 'cancelOrder';
const H = handlers as unknown as Record<string, (r: any, ctx: any) => Promise<{ status: number; body?: any }>>;
const DEFAULT_GRANTS: Record<OperationId, readonly string[]> = { quoteOrderItemsChange: [EDIT], changeOrderItems: [EDIT, INVOICE], cancelOrder: [CANCEL] };

export async function call(operationId: OperationId, e: E, orderId: string, body: unknown, o: CallOpts = {}): Promise<Reply> {
  const tenant = o.tenant ?? e.tenant;
  const side = tenant === TENANT_B ? 'b' : 'a';
  const identity: any = makeIdentity(o.grants ?? DEFAULT_GRANTS[operationId], { centreIds: o.centreIds ?? [e.centre] });
  const probe: Reply['probe'] = { logs: [], accessCalls: [], identity, requestId: o.requestId ?? uid(), ctx: undefined };
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (operationId !== 'quoteOrderItemsChange') {
    headers['idempotency-key'] ??= uid();
    const v = o.ifMatch === undefined ? `"${Number((await orderRow(orderId))?.version ?? 1)}"` : o.ifMatch;
    if (v !== null) headers['if-match'] = v;
  }
  const out = await appTx(tenant, async (tx: any) => {
    tx.startedAt = o.now ?? NOW;                      // core events.publish stamps occurred_at from tx.startedAt
    const real = createEvents({ producer: 'frontdesk' });
    const events = { publish: async (c: any, type: string, input: any) => {
      if (o.failEvent === type) throw Object.assign(new Error('injected'), { code: 'common.internal' });
      return real.publish(c, type, input);
    } };
    const log = (lvl: string) => (obj: object, msg?: string) => { probe.logs.push(`${lvl} ${JSON.stringify(obj)} ${msg ?? ''}`); };
    const ctx: any = {
      operationId, clientIp: '203.0.113.9', log: { info: log('info'), warn: log('warn'), error: log('error') },
      tenantId: tenant, tx, requestId: probe.requestId, now: () => o.now ?? NOW, centreId: CENTRE[side],
      actor: { type: 'system', id: SYS_ACTOR, membershipId: uid() },
      ports: { IdentityPort: identity, CatalogPort: (o.w ?? e.w).catalog, BillingCommandPort: o.billing ?? e.billing, LabPort: o.lab ?? e.lab },
      events, core: createCoreRepo({} as never),
    };
    ctx.audit = { access: async (a: any) => { probe.accessCalls.push(a); await access(ctx, a); } };
    probe.ctx = ctx;
    const reply = await H[operationId]!(req({ params: { order_id: orderId }, body, headers }), ctx);
    const x = await tx.query('SELECT txid_current_if_assigned() AS x');
    return { ...reply, wrote: x.rows[0].x !== null };
  });
  return { ...(out as any), probe };
}
export const quoteChange = (e: E, add: unknown, o: CallOpts = {}, orderId = e.order.id) => call('quoteOrderItemsChange', e, orderId, { add }, o);
export const change = (e: E, body: unknown, o: CallOpts = {}, orderId = e.order.id) => call('changeOrderItems', e, orderId, body, o);
export const cancel = (e: E, body: unknown, o: CallOpts = {}, orderId = e.order.id) => call('cancelOrder', e, orderId, body, o);
export const quoteChangeFails = (e: E, add: unknown, o: CallOpts = {}, orderId = e.order.id) => rejection(quoteChange(e, add, o, orderId));
export const changeFails = (e: E, body: unknown, o: CallOpts = {}, orderId = e.order.id) => rejection(change(e, body, o, orderId));
export const cancelFails = (e: E, body: unknown, o: CallOpts = {}, orderId = e.order.id) => rejection(cancel(e, body, o, orderId));

/** F8b over `add`, then the F13 body that carries its fingerprint (same world => the fingerprint F13 re-computes). */
export const add = (orderable: string, priority: 'routine' | 'urgent' = 'routine') => ({ orderable_id: orderable, priority });
export const rm = (itemId: string, reason_code = 'patient_request') => ({ order_item_id: itemId, reason_code });
export async function fpOf(e: E, adds: unknown[], o: CallOpts = {}): Promise<string> { return (await quoteChange(e, adds, o)).body.quote_fingerprint; }
export async function mk(e: E, o: { add?: unknown[]; remove?: unknown[]; payments?: unknown[]; fp?: string } = {}, co: CallOpts = {}) {
  const adds = o.add ?? [];
  return { ...(adds.length ? { add: adds } : {}), ...(o.remove?.length ? { remove: o.remove } : {}), ...(o.payments ? { payments: o.payments } : {}),
    ...(adds.length ? { quote_fingerprint: o.fp ?? await fpOf(e, adds, co) } : {}) };
}
export const pay = (amount: number, o: Record<string, unknown> = {}) => ({ method_code: 'cash', amount_received_paisa: amount, ...o });

// ---- owner-side truth (no RLS) ----
export const orderRow = async (id: string) => (await ownerRows('frontdesk.orders', 'id = $1', [id]))[0];
export const itemRows = (orderId: string) => ownerRows('frontdesk.order_items', 'order_id = $1 ORDER BY created_at, id', [orderId]);
export const eventRows = (type: string, orderId: string) => ownerRows('core.event_log', 'event_type = $1 AND aggregate_id = $2', [type, orderId]);
export const allEvents = (orderId: string) => ownerRows('core.event_log', 'aggregate_id = $1', [orderId]);
export const MUTATIONS = ['issueOrderInvoice', 'recordCreditCharges', 'voidCreditCharges', 'raiseCreditNoteRequirement', 'recordPayment'] as const;
export const mutations = (e: E, billing: any = e.billing) => MUTATIONS.flatMap((m) => billing.calls(m).map((c: any) => ({ method: m, input: c.input })));
export const callsOf = (billing: any, m: string): any[] => billing.calls(m).map((c: any) => c.input);
/** Everything a change/cancel may touch, for "nothing happened" assertions. */
export async function snap(e: E, orderId = e.order.id) {
  const o = await orderRow(orderId);
  return { order: o && { status: o.status, version: Number(o.version), items_version: Number(o.items_version), requires_credit_note: o.requires_credit_note, cancelled_at: o.cancelled_at,
      cancel_reason_code: o.cancel_reason_code }, items: (await itemRows(orderId)).map((i) => ({ id: i.id, status: i.status, removed_at: i.removed_at, version: Number(i.version) })),
    events: (await allEvents(orderId)).length };
}
export const billingIds = async (e: E) => (await e.billing.getOrderBillingSummary({ tenantId: e.tenant }, { orderId: e.order.id })) as { invoiceIds: string[]; creditChargeIds: string[]; hasIssuedInvoice: boolean };
/** A billing port that fails EVERY issueOrderInvoice with `billing.counter_busy` (the fake's failNext is one-shot). */
export function busyBilling(e: E) { return { ...e.billing, issueOrderInvoice: async () => { throw portErr('billing.counter_busy', 'busy'); } }; }
