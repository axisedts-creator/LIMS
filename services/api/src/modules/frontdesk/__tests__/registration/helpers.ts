// FD-T06 harness (Registration F9 createRegistration). Handler driven with a request-shaped object + HandlerContext over a REAL PG17 tx (lims_api, RLS on),
// same convention as ../quote/helpers.ts. Ports are the REAL fakes from packages/fakes (Catalog, BillingCommand, Notification) + a fake IdentityPort.
// ASSUMED ctx (spec names no frontdesk ctx; 02-TRD §6.4/§6.8/§6.10): ctx.tenantId, tx, requestId, now() (Date), actor, centreId, audit.access,
//   ctx.ports.{IdentityPort,CatalogPort,BillingCommandPort,NotificationPort}, ctx.events = REAL core createEvents({producer:'frontdesk'}) (writes core.event_log on ctx.tx),
//   ctx.core = REAL createCoreRepo (centre -> branch_id). The service retries via ctx.db.tx are NOT modelled: one request = one tx (appTx commits, or rolls back on throw).
// Billing fake gap handled here: the fake only knows order ids from its fixtures, but C4 generates the order id. The wrapper below seeds an unknown order id into the
// fake just before the first billing call that names it (re-seeding resets the fake's in-memory invoice/counter state: per-world, one registration is the unit).
// The fake's invoice counter is NOT transactional (no __onRollback): counter gaplessness is J-T01 (real billing), not asserted here.
import { createFakeNotificationPort } from '../../../../../../../packages/fakes/src/NotificationPort.fake';
import { createFakeBillingCommandPort } from '../../../../../../../packages/fakes/src/BillingCommandPort.fake';
import { createEventSpy } from '../../../../../../../packages/fakes/src/event-spy';
import { idFor } from '../../../../../../../packages/fakes/src/base';
import { access } from '../../../../core/audit/access.js';
import { createCoreRepo } from '../../../../core/core-repo/index.js';
import { createEvents } from '../../../../core/events/publish.js';
import { handlers } from '../../handlers/index.js';
import { BRANCH, CENTRE, NOW, SYS_ACTOR, TENANT_A, TENANT_B, TENANT_SETTINGS, appTx, makeIdentity, ownerRows, rejection, req, seed, seedPatient, superTx, uid } from '../patients/helpers.js';
import { CP, O, T, draft, seedLimits, world, quote as quoteOnly, type World } from '../quote/helpers.js';

export { BRANCH, CENTRE, CP, NOW, O, T, TENANT_A, TENANT_B, draft, ownerRows, rejection, seed, seedLimits, seedPatient, superTx, uid };
export const PERM = 'frontdesk.registration.create';
export const INVOICE_PERM = 'billing.invoice.issue';
export const LAB_NAME = 'Synthetic Lab';
/** Second branch + centre of tenant A (db/seeds/010): used ONLY by the counter tests so parallel files cannot move its registration_no counter. */
export const CENTRE_A2 = '01a1a98a-ac40-7000-8000-00000000a202';
export const BRANCH_A2 = '01a1a98a-ac40-7000-8000-00000000a102';
export const TEMPLATE_ID = idFor(1, 0x801);   // default fake template id for frontdesk.registration_confirmation: same id => the override replaces it

export interface RWorld extends World { notif: any; spy: ReturnType<typeof createEventSpy>; billingFake: any }
export function rworld(o: Parameters<typeof world>[0] = {}): RWorld {
  const base = world(o);
  const spy = createEventSpy();
  const billingFake: any = createFakeBillingCommandPort({ seed: 1, events: spy, fixtures: (base.billingFake as any).fixtures });
  const known = new Set<string>();
  const ensure = (c: any, orderId: string) => {
    if (known.has(orderId)) return;
    known.add(orderId);
    billingFake.__seed({ orders: [{ id: orderId, tenantId: c.tenantId }] });
  };
  const wrap = (m: string) => async (c: any, i: any) => { ensure(c, i.orderId); return billingFake[m](c, i); };
  const billing = { ...billingFake, issueOrderInvoice: wrap('issueOrderInvoice'), recordPayment: wrap('recordPayment'), recordCreditCharges: wrap('recordCreditCharges') };
  // Template override: spec 03-APP-FLOW §2.3 step 7 declares params {lab_name, registered_time_hhmm} (the fake's default declares {lab_name, ref}).
  const notif: any = createFakeNotificationPort({ seed: 1, fixtures: { templates: [{ id: TEMPLATE_ID, code: 'frontdesk.registration_confirmation', purpose: 'registration_confirmation',
    channels: ['sms', 'whatsapp'], params: { lab_name: 'short_text', registered_time_hhmm: 'short_text' } }],
    // fake `channels` is keyed by the fake tenant ids; key it by the DB tenant ids (ruling FD-T06 #3). Gate stays channels.smsEnabled (03-APP-FLOW §2.3).
    channels: { [TENANT_A]: { smsEnabled: true, whatsappEnabled: true, emailEnabled: true }, [TENANT_B]: { smsEnabled: true, whatsappEnabled: true, emailEnabled: true } } } as any });
  return { ...base, billing: billing as any, billingFake, notif, spy };
}
/** Make `patientId` resolvable by the fake NotificationPort (recipient + consent matrix). Re-seeds the fake: call before registering. */
export function knowRecipient(w: RWorld, tenant: string, patientId: string, sms: boolean, phone = '+9779800000011') {
  w.notif.__seed({ recipients: [{ id: patientId, tenantId: tenant, kind: 'patient', phoneE164: phone, email: null, consent: { sms, whatsapp: false, email: false } }] });
}

export interface RegOpts { grants?: readonly string[]; tenant?: string; w?: RWorld; centreId?: string; centreIds?: readonly string[]; headers?: Record<string, string>;
  failEvent?: string; smsEnabled?: boolean; requestId?: string; now?: Date }
export interface RegReply { status: number; body: any; probe: { logs: string[]; accessCalls: any[]; identity: any; requestId: string; ctx: any }; w: RWorld }

export function ctxFor(tx: any, tenant: string, w: RWorld, o: RegOpts, probe: RegReply['probe']): any {
  const side = tenant === TENANT_B ? 'b' : 'a';
  const centre = o.centreId ?? CENTRE[side];
  const identity: any = makeIdentity(o.grants ?? [PERM, INVOICE_PERM], { centreIds: o.centreIds ?? [centre], displayName: 'Synthetic Operator' });
  const settings = { ...TENANT_SETTINGS, numbering: { ...TENANT_SETTINGS.numbering, registrationNoPattern: REG_PATTERN }, branding: { displayName: LAB_NAME }, channels: { ...TENANT_SETTINGS.channels, smsEnabled: o.smsEnabled ?? true } };
  identity.getTenantSettings = async () => settings;
  probe.identity = identity;
  tx.startedAt = o.now ?? NOW;                               // core events.publish stamps occurred_at from tx.startedAt (the real request tx has it)
  const real = createEvents({ producer: 'frontdesk' });
  const events = { publish: async (c: any, type: string, input: any) => {
    if (o.failEvent === type) throw Object.assign(new Error('injected'), { code: 'common.internal' });
    return real.publish(c, type, input);
  } };
  const log = (lvl: string) => (obj: object, msg?: string) => { probe.logs.push(`${lvl} ${JSON.stringify(obj)} ${msg ?? ''}`); };
  const ctx: any = {
    operationId: 'createRegistration', clientIp: '203.0.113.9', log: { info: log('info'), warn: log('warn'), error: log('error') },
    tenantId: tenant, tx, requestId: probe.requestId, now: () => o.now ?? NOW, centreId: centre,
    actor: { type: 'system', id: SYS_ACTOR, membershipId: uid() },
    ports: { IdentityPort: identity, CatalogPort: w.catalog, BillingCommandPort: w.billing, NotificationPort: w.notif },
    events, core: createCoreRepo({} as never),
  };
  ctx.audit = { access: async (e: any) => { probe.accessCalls.push(e); await access(ctx, e); } };
  return ctx;
}

/** One registration = one request tx under RLS. On throw the tx rolls back and the in-memory spies drop what that tx published/queued (as the real outbox would). */
export async function register(body: unknown, o: RegOpts = {}): Promise<RegReply> {
  await seedLimits();
  await ensureTaskRegistry();
  const tenant = o.tenant ?? TENANT_A;
  const w = o.w ?? rworld();
  const probe: RegReply['probe'] = { logs: [], accessCalls: [], identity: undefined, requestId: o.requestId ?? uid(), ctx: undefined };
  const out = await appTx(tenant, async (tx) => {
    const ctx = ctxFor(tx, tenant, w, o, probe);
    probe.ctx = ctx;
    try { return await (handlers as any).createRegistration(req({ body, headers: o.headers ?? {} }), ctx); }
    catch (e) { w.spy.rollback(tx); w.notif.__rollback(tx); throw e; }
  });
  return { ...out, probe, w };
}
export const registerFails = (body: unknown, o: RegOpts = {}) => rejection(register(body, o));

/** Quote with the SAME world (so the fingerprint is the one the registration re-computes). */
export async function quoteFp(w: RWorld, d: Record<string, unknown>, o: { tenant?: string; centreIds?: readonly string[] } = {}): Promise<string> {
  const q = await quoteOnly(d, { w, ...(o.tenant ? { tenant: o.tenant } : {}), ...(o.centreIds ? { centreIds: o.centreIds } : {}), grants: [PERM] });
  return q.body.quote_fingerprint as string;
}
export const pay = (amount: number, o: Record<string, unknown> = {}) => ({ method_code: 'cash', amount_received_paisa: amount, ...o });
export const NET = 72600;     // CBC 50000 exempt + GLU 20000 + VAT 2600 (13 %), tenant_default list

export interface Prepared { patient: any; w: RWorld; body: any; fp: string }
/** Seed a patient (SMS consent given), quote, and build the F9 body. `d` overrides draft fields; `payments` default = one full cash payment. */
export async function prepare(o: { side?: 'a' | 'b'; patient?: Record<string, unknown>; consent?: Record<string, unknown>; w?: RWorld; d?: Record<string, unknown>;
  payments?: unknown[]; centreId?: string; sms?: boolean; fp?: string; extra?: Record<string, unknown> } = {}): Promise<Prepared> {
  await ensureTaskRegistry();
  const side = o.side ?? 'a';
  const tenant = side === 'b' ? TENANT_B : TENANT_A;
  const patient = await seedPatient(side, o.patient ?? {}, { sms: true, ...(o.consent ?? {}) });
  const w = o.w ?? rworld();
  knowRecipient(w, tenant, patient.id, o.sms ?? true, patient.phone_e164);
  const centreId = o.centreId ?? CENTRE[side];
  const d = draft({ patient: { patient_id: patient.id }, centre_id: centreId, ...(o.d ?? {}) });
  const fp = o.fp ?? await quoteFp(w, d, { tenant, centreIds: [centreId] });
  const billingMode = (d as any).billing_mode;
  const payments = o.payments ?? (billingMode === 'credit' ? [] : [pay(NET)]);
  return { patient, w, fp, body: { ...d, quote_fingerprint: fp, payments, ...(o.extra ?? {}) } };
}

// ---- owner-side truth (no RLS) ----
export const orderRow = async (id: string) => (await ownerRows('frontdesk.orders', 'id = $1', [id]))[0];
export const itemRows = (orderId: string) => ownerRows('frontdesk.order_items', 'order_id = $1 ORDER BY code, priority', [orderId]);
export const discountRows = (orderId: string) => ownerRows('frontdesk.discounts', 'order_id = $1', [orderId]);
export const ordersOf = (patientId: string) => ownerRows('frontdesk.orders', 'patient_id = $1', [patientId]);
export const eventRows = (type: string, orderId: string) => ownerRows('core.event_log', 'event_type = $1 AND aggregate_id = $2', [type, orderId]);
export const counterValue = async (tenant: string, kind: string, scopeKey: string): Promise<number> => {
  const r = await ownerRows('frontdesk.number_counters', 'tenant_id = $1 AND counter_kind = $2 AND scope_key = $3', [tenant, kind, scopeKey]);
  return r.length ? Number(r[0].last_value) : 0;
};
/** Order id the service generated, read from the first billing-port call (the only place it leaks when the tx rolled back). */
export const generatedOrderId = (w: RWorld): string | undefined => {
  for (const m of ['issueOrderInvoice', 'recordCreditCharges', 'recordPayment']) { const c = w.billingFake.calls(m)[0]; if (c) return (c.input as any).orderId; }
  return undefined;
};
let registryDone = false;
/** app.enqueue_job rejects identifiers absent from core.g_task_registry (C0 02-TRD:867); the deploy step registry-sync.ts (02-TRD:790) fills it and the FD-T03 boot skips it (ruling FD-T06 #1). Superuser, idempotent. */
export async function ensureTaskRegistry(): Promise<void> {
  if (registryDone) return;
  await superTx(async (tx) => { await tx.query(
    `INSERT INTO core.g_task_registry (identifier,module,kind,scope,max_attempts) VALUES ('core.event_fanout','core','core','per_tenant',25) ON CONFLICT DO NOTHING`); });
  registryDone = true;
}
/** Everything a registration writes, by order id: all must be empty after a rollback. */
export async function storedFor(orderId: string) {
  return {
    orders: (await ownerRows('frontdesk.orders', 'id = $1', [orderId])).length,
    items: (await ownerRows('frontdesk.order_items', 'order_id = $1', [orderId])).length,
    discounts: (await ownerRows('frontdesk.discounts', 'order_id = $1', [orderId])).length,
    trf: (await ownerRows('frontdesk.trf_attachments', 'order_id = $1', [orderId])).length,
    events: (await ownerRows('core.event_log', 'aggregate_id = $1', [orderId])).length,
  };
}
export const NOTHING = { orders: 0, items: 0, discounts: 0, trf: 0, events: 0 };
/** C4 grammar: registrationNoPattern must contain {branch} (03-INTERFACE-CATALOG:2844), counter per branch (05-SCHEMA:134). Branch code of the counter tests' centre A2: see `branchCode`. */
export const BRANCH_CODE = 'A-B2';   // db/seeds/010 branch code of BRANCH_A2 (the {branch} token value)
export const REG_PATTERN ='{branch}R{seq:6}';
export const regNo = (n: number, branch = BRANCH_CODE) => `${branch}R${String(n).padStart(6, '0')}`;
export type { World };
