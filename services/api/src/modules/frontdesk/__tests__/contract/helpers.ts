// FD-T11 harness: FrontdeskPort (03-IC §4.3, 08 §4.14, 02-TRD §6.1) driven on the REAL impl over a REAL PG17 tx (lims_api, RLS on).
// The port is called the way another module calls it: with a STRICT RequestContext {tenantId, actor, requestId, tx, now(): IsoUtc, ports}. No ctx.events / ctx.core / ctx.audit / ctx.log are
// supplied, so the impl must publish through core `createEvents` and use ctx.tx only (a real cross-module caller has nothing else). ctx.now() is an ISO string (contracts/ports/common.ts); the
// frontdesk services take a Date, so the impl converts. Ports on ctx.ports are the REAL fakes from packages/fakes (Catalog + BillingCommand via ../registration/helpers `rworld`, LabPort via ../orders/helpers).
// ASSUMED seams (dispute via note if wrong): `ports/FrontdeskPort.impl.ts` exports `frontdeskPort` (the manifest object, 6 methods); `service/booking.service.ts` exports `onBookingConfirmed(ctx, payload)` /
//   `onBookingCancelled(ctx, payload)` (TRD §3.1 subscription names; the FD-T12 consumers are thin wrappers) over the same path as the port (X5).
// Identity: IdentityPort is the fake from ../patients/helpers: assertRole passes iff the permission is in `grants` (any actor type). A SYSTEM actor therefore gets `grants` too, so for system
//   callers the tests give exactly the permissions their manifest would hold (see `SYSTEM_GRANTS`); the impl must accept `actor.type === 'system'` where the spec says "or system" without further grants.
// Synthetic data only.
import { frontdeskPort } from '../../ports/FrontdeskPort.impl.js';
import { CENTRE_A2, scenario, type Scenario } from '../orders/helpers.js';
import { BRANCH, CENTRE, CONSENT_VERSION, NOW, SYS_ACTOR, TENANT_A, TENANT_B, TENANT_SETTINGS, appTx, consentRows, makeIdentity, newPatient, ownerRows, patientRow, rejection, seedPatient, superTx, uid } from '../patients/helpers.js';
import { CP, O, T, seedLimits } from '../quote/helpers.js';
import { REG_PATTERN, ensureTaskRegistry, rworld, type RWorld } from '../registration/helpers.js';

export { BRANCH, CENTRE, CENTRE_A2, CONSENT_VERSION, CP, NOW, O, T, TENANT_A, TENANT_B, consentRows, newPatient, ownerRows, patientRow, rejection, rworld, scenario, seedPatient, superTx, uid };
export type { RWorld, Scenario };
export const port = frontdeskPort as any;
export const NOW_ISO = NOW.toISOString();

// ---- permissions named by the spec ----
export const PERMS = {
  orderRead: 'frontdesk.order.read', patientRead: 'frontdesk.patient.read', registrationCreate: 'frontdesk.registration.create', invoiceIssue: 'billing.invoice.issue',
  reportRead: 'reporting.report.read', labelPrint: 'lab.specimen.label_print', smartSummary: 'smartreport.summary.read', visitRead: 'homecollection.visit.read',
  visitAssign: 'homecollection.visit.assign', resultEnter: 'lab.result.enter', resultVerify: 'lab.result.verify', worklist: 'lab.worklist.read', statusBoard: 'lab.status_board.read',
  linkIssue: 'engagement.link.issue', manifestReceive: 'partners.manifest.receive',
} as const;
/** Every permission any purpose or source names: a user holding all of them is the "can do everything a user can" probe. */
export const ALL_USER_PERMS: readonly string[] = Object.values(PERMS);
export const without = (...drop: string[]): string[] => ALL_USER_PERMS.filter((p) => !drop.includes(p));
/** What the partners system actor's manifest holds (C13 TRD §7: 'partners.manifest.receive' + partners.partner.read). */
export const SYSTEM_GRANTS = { engagement: [] as string[], homecollection: [] as string[], partners: [PERMS.manifestReceive, 'partners.partner.read'] };

export type ActorKind = 'user' | 'system' | 'device' | 'portal' | 'patient' | 'partner';
export interface Opts {
  actor?: ActorKind; grants?: readonly string[]; tenant?: string; centreIds?: readonly string[]; w?: RWorld; lab?: any; requestId?: string; actorId?: string; now?: Date;
  /** filled by `run`: what the impl was handed and what it touched */ probe?: Probe;
}
export interface Probe { ctx?: any; identity?: any; requestId?: string; w?: RWorld; lab?: any }
const sideOf = (tenant: string) => (tenant === TENANT_B ? 'b' : 'a');

/** One port call (or several, via `fn`) = one request tx under RLS with the strict RequestContext. Commits on success, rolls back (and drops fake-side effects) on throw. */
export async function run<T>(o: Opts, fn: (p: any, ctx: any) => Promise<T>): Promise<T> {
  await seedLimits();
  await ensureTaskRegistry();
  const tenant = o.tenant ?? TENANT_A;
  const side = sideOf(tenant);
  const w = o.w ?? rworld({ creditList: true });
  const lab = o.lab ?? unknownLab();
  // FD-T11 ruling: C4 forwards the caller's ctx to LabPort.getOrderItemProcessingState (C5 06-PLAN:76), and the LabPort fake grants user actors only via fixtures.grants[actor.id];
  // seed it with the same grants IdentityPort gets, so auth.forbidden can only come from the impl.
  if ((o.actor ?? 'user') === 'user' && typeof lab.__seed === 'function') lab.__seed({ grants: { [o.actorId ?? SYS_ACTOR]: [...(o.grants ?? [])] } });
  const identity: any = makeIdentity(o.grants ?? [], { centreIds: o.centreIds ?? [CENTRE[side]] });
  const settings = { ...TENANT_SETTINGS, numbering: { ...TENANT_SETTINGS.numbering, registrationNoPattern: REG_PATTERN } };
  identity.getTenantSettings = async () => settings;
  const when = o.now ?? NOW;
  const requestId = o.requestId ?? uid();
  if (o.probe) Object.assign(o.probe, { identity, requestId, w, lab });
  return appTx(tenant, async (tx: any) => {
    tx.startedAt = when;                                    // core events.publish stamps occurred_at from tx.startedAt (the real request tx has it)
    const ctx: any = { tenantId: tenant, actor: { type: o.actor ?? 'user', id: o.actorId ?? SYS_ACTOR, membershipId: uid() }, requestId, tx, now: () => when.toISOString(),
      ports: { IdentityPort: identity, CatalogPort: w.catalog, BillingCommandPort: w.billing, LabPort: lab } };
    if (o.probe) o.probe.ctx = ctx;
    try { return await fn(port, ctx); } catch (e) { w.spy.rollback(tx); throw e; }
  });
}
export const fails = (o: Opts, fn: (p: any, ctx: any) => Promise<unknown>) => rejection(run(o, fn));
/** A LabPort that knows nothing: a derived-status call on an order that should return its stored status (pre_registered / cancelled) is a bug, so it throws loudly. */
function unknownLab() {
  const boom = async () => { throw new Error('LabPort called on an order that should return its stored status'); };
  return { getOrderItemProcessingState: boom, calls: () => [] as unknown[] };
}

// ---- actors ----
export const asUser = (grants: readonly string[], o: Opts = {}): Opts => ({ actor: 'user', grants, ...o });
export const asSystem = (grants: readonly string[] = [], o: Opts = {}): Opts => ({ actor: 'system', grants, ...o });
export const NON_STAFF: readonly ActorKind[] = ['patient', 'portal', 'partner', 'device'];

// ---- fixtures ----
export type Side = 'a' | 'b';
/** A patient with every demographic filled in (name, phone, email, birth_on) and SMS+email consent, for the allowlist tests. */
export async function fullPatient(side: Side = 'a', o: Record<string, unknown> = {}) {
  return seedPatient(side, { full_name: `Asha Fdt ${uid().slice(-6)}`, email: `asha.${uid().slice(-6)}@example.com`, birth_on: '1983-11-10', ...o },
    { sms: true, whatsapp: false, email: true, share_with_referrer: false });
}
export const consentInput = (o: Record<string, unknown> = {}) => ({ sms: true, whatsapp: false, email: false, shareWithReferrer: false, consentTextVersion: CONSENT_VERSION, ...o });
export const newPatientInput = (o: Record<string, unknown> = {}) => ({ fullName: `Fdt Booking ${uid().slice(-6)}`, sex: 'female', birthOn: '1990-05-05', phoneE164: `+97798${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, consents: consentInput(), ...o });
export const SOURCES = ['engagement_booking', 'home_collection', 'partner_manifest'] as const;
export type Source = (typeof SOURCES)[number];
export const PARTNER = '01a1a98a-ac40-7000-8000-00000000f901';
/** BookingOrderInput; `patient` is {patientId} or {newPatient}. */
export function booking(source: Source, patient: unknown, o: Record<string, unknown> = {}) {
  const side = (o['tenant'] as Side | undefined) ?? 'a';
  const { tenant: _t, ...rest } = o;
  return { source, sourceRefId: uid(), patient, branchId: BRANCH[side], centreId: CENTRE[side], orderableIds: [O.cbc, O.glu], priority: 'routine', confirmImmediately: true, idempotencyKey: `k-${uid()}`,
    ...(source === 'partner_manifest' ? { partnerId: PARTNER } : {}), ...rest };
}
/** The actor that is allowed to create from `source` in the happy path. */
export const creator = (source: Source, o: Opts = {}): Opts => asSystem(source === 'partner_manifest' ? SYSTEM_GRANTS.partners : [], o);
export const create = (input: any, o: Opts) => run(o, (p, ctx) => p.createOrderFromBooking(ctx, input));
export const createFails = (input: any, o: Opts) => fails(o, (p, ctx) => p.createOrderFromBooking(ctx, input));

// ---- owner-side truth (no RLS) ----
export const orderRow = async (id: string) => (await ownerRows('frontdesk.orders', 'id = $1', [id]))[0];
export const itemRows = (orderId: string) => ownerRows('frontdesk.order_items', 'order_id = $1 ORDER BY code, priority', [orderId]);
export const linkRows = (tenant: string, source: string, ref: string) => ownerRows('frontdesk.booking_links', 'tenant_id = $1 AND source = $2 AND source_ref_id = $3', [tenant, source, ref]);
export const ordersBySource = (tenant: string, source: string, ref: string) => ownerRows('frontdesk.orders', 'tenant_id = $1 AND source = $2 AND source_ref_id = $3', [tenant, source, ref]);
export const eventRows = (type: string, orderId: string) => ownerRows('core.event_log', 'event_type = $1 AND aggregate_id = $2', [type, orderId]);
export const allEventRows = (orderId: string) => ownerRows('core.event_log', 'aggregate_id = $1', [orderId]);
export const flagRows = (orderId: string) => ownerRows('frontdesk.order_flags', 'order_id = $1', [orderId]);
export const accessLogRows = (requestId: string) => ownerRows('audit.access_log', 'request_id = $1', [requestId]);
export const patientsByPhone = (tenant: string, phone: string) => ownerRows('frontdesk.patients', 'tenant_id = $1 AND phone_e164 = $2', [tenant, phone]);
export const countRows = async (table: string, tenant: string) => Number((await superTx(async (tx) => (await tx.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [tenant])).rows[0].n)));
/** Everything a booking may write, for "nothing happened" assertions. */
export const writes = async (tenant: string) => ({ orders: await countRows('frontdesk.orders', tenant), items: await countRows('frontdesk.order_items', tenant), links: await countRows('frontdesk.booking_links', tenant),
  patients: await countRows('frontdesk.patients', tenant), consents: await countRows('frontdesk.patient_consents', tenant), flags: await countRows('frontdesk.order_flags', tenant) });

/** FD-T11 ruling: "nothing is written" is asserted on rows THIS test could create (its patient ids, source refs / keys, phones), not on tenant-wide counts that parallel test files change. */
export interface WriteScope { patientIds?: string[]; refs?: string[]; keys?: string[]; phones?: string[] }
export async function scopedWrites(tenant: string, s: WriteScope) {
  const pids = s.patientIds ?? [], refs = s.refs ?? [], keys = s.keys ?? [], phones = s.phones ?? [];
  const patients = await ownerRows('frontdesk.patients', 'tenant_id = $1 AND (id = ANY($2::uuid[]) OR phone_e164 = ANY($3::text[]))', [tenant, pids, phones]);
  const allPids = [...new Set([...pids, ...patients.map((p: any) => p.id as string)])];
  const orders = await ownerRows('frontdesk.orders', 'tenant_id = $1 AND (patient_id = ANY($2::uuid[]) OR source_ref_id = ANY($3::uuid[]))', [tenant, allPids, refs]);
  const links = await ownerRows('frontdesk.booking_links', 'tenant_id = $1 AND (source_ref_id = ANY($2::uuid[]) OR idempotency_key = ANY($3::text[]) OR order_id = ANY($4::uuid[]))', [tenant, refs, keys, orders.map((o: any) => o.id)]);
  const oids = [...new Set([...orders.map((o: any) => o.id as string), ...links.map((l: any) => l.order_id as string).filter(Boolean)])];
  return { orders: orders.length, links: links.length, patients: patients.length, items: (await ownerRows('frontdesk.order_items', 'order_id = ANY($1::uuid[])', [oids])).length,
    consents: (await ownerRows('frontdesk.patient_consents', 'tenant_id = $1 AND patient_id = ANY($2::uuid[])', [tenant, allPids])).length, flags: (await ownerRows('frontdesk.order_flags', 'order_id = ANY($1::uuid[])', [oids])).length };
}

// ---- booking events (contracts/events/engagement.booking.{confirmed,cancelled}.v1.schema.json payloads) ----
export const confirmedEvent = (patientId: string, o: Record<string, unknown> = {}) => ({ booking_id: uid(), patient_id: patientId, branch_id: BRANCH.a, centre_id: CENTRE.a, booking_kind: 'centre_visit',
  slot_start: '2026-11-11T04:00:00.000Z', slot_end: '2026-11-11T04:30:00.000Z', orderable_ids: [O.cbc, O.glu], confirmed_at: '2026-11-10T05:00:00.000Z', ...o });
export const cancelledEvent = (patientId: string, o: Record<string, unknown> = {}) => ({ booking_id: uid(), patient_id: patientId, booking_kind: 'centre_visit', reason_code: 'patient_request',
  cancelled_by_kind: 'patient', cancelled_at: '2026-11-10T05:30:00.000Z', ...o });
