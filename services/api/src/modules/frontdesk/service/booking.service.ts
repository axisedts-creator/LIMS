// FD-T11: createOrderFromBooking + createSelfRegisteredPatient (03-IC §4.3, 02-TRD §6.1) and the booking consumers' entry points (X5: same logic behind the port and the event).
// The port gets a STRICT RequestContext {tenantId, actor, requestId, tx, now(): ISO string, ports}: no ctx.events / ctx.core and no audit helper. Everything runs in ctx.tx (the caller's tx):
// events go through core createEvents, centre/branch through the core repo, and the access log is the CALLING user-facing action's job (IC §4.3 invariant), never this file's.
// Services written for handler contexts take a Date clock: `dateCtx` is the prototype-delegating copy with now(): Date. Ports always get the original ISO-string ctx.
// Authorisation: actor guard FIRST (before validation, port calls or writes), then per-source (08 R7), then validation. Messages are fixed text: no input is echoed (07-SECURITY).
import { createHash } from 'node:crypto';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../core/errors.js';
import { createCoreRepo } from '../../../core/core-repo/index.js';
import { createEvents } from '../../../core/events/publish.js';
import { estimatedBirthOn, isDuplicateSuspect, normaliseName } from '../domain/patient.js';
import { formatNumber, hasToken } from '../domain/numbering.js';
import { createFrontdeskEvents } from '../events/publish.js';
import { dateOnly } from '../mappers/patient.dto.js';
import { getBookingLink, insertBookingLink, touchBookingLink } from '../repository/bookingLinks.repo.js';
import { insertConsent } from '../repository/consents.repo.js';
import { nextCounterValue } from '../repository/counters.repo.js';
import { cancelActiveItems, insertOrderItem } from '../repository/orderItems.repo.js';
import { cancelOrderRow, getOrderById, insertOrder, lockOrderById, patientHasOrder } from '../repository/orders.repo.js';
import { findDedupePool, getPatientById, insertPatient } from '../repository/patients.repo.js';
import { getSettings } from '../repository/settings.repo.js';
import type { Tx } from '../repository/shared.repo.js';
import { raiseBookingCancelledFlag } from './flags.service.js';
import { bad, isObj, todayIn } from './patient.service.js';
import { ageParts, priceDraft, type Draft, type QuoteCtx } from './registration.service.js';

type Obj = Record<string, any>;
export interface PortCtx {
  readonly tenantId: string; readonly requestId: string; readonly tx: Tx; now(): string;
  readonly actor: { readonly type: string; readonly id: string; readonly membershipId?: string };
  readonly ports: { readonly IdentityPort: { assertRole(c: unknown, r: { permission: string; centreId?: string }): Promise<void>;
    getActor(c: unknown): Promise<{ centreScope?: { all?: boolean; centreIds?: readonly string[] } }>; getTenantSettings(c: unknown, i: { keys: readonly string[] }): Promise<any> } } & Record<string, any>;
}
type Source = 'engagement_booking' | 'home_collection' | 'partner_manifest';
const SOURCES: readonly Source[] = ['engagement_booking', 'home_collection', 'partner_manifest'];
const COLLECTION: Record<Source, 'centre' | 'home' | 'partner'> = { engagement_booking: 'centre', home_collection: 'home', partner_manifest: 'partner' };
/** 08 R7: engagement_booking = system only (no user permission exists); home_collection = dispatcher; partner_manifest = partners.manifest.receive. System actors pass (module identity of a system actor is not modelled). */
const SOURCE_PERMISSION: Record<Source, string | undefined> = { engagement_booking: undefined, home_collection: 'homecollection.visit.assign', partner_manifest: 'partners.manifest.receive' };

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PHONE = /^\+[1-9][0-9]{7,14}$/;
const SEX = ['male', 'female', 'other', 'unknown'];
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TZ = 'Asia/Kathmandu';
const events = createEvents({ producer: 'frontdesk' });
const core = createCoreRepo({} as never);

export const forbidden = (): LimsError => new LimsError('auth.forbidden');
/** Fail closed on a malformed request context, then on the actor kind: only staff (user) and system actors may call the staff-facing methods. */
export function staffCtx(c: unknown, kinds: readonly string[] = ['user', 'system']): PortCtx {
  const x = c as Partial<PortCtx> | null;
  if (typeof x?.tenantId !== 'string' || !x.tx || typeof x.actor?.id !== 'string' || typeof x.actor.type !== 'string' || typeof x.now !== 'function' || !x.ports?.IdentityPort) throw new LimsError('auth.unauthenticated');
  if (!kinds.includes(x.actor.type)) throw forbidden();
  return x as PortCtx;
}
export const dateCtx = <T extends { now(): string }>(c: T): Omit<T, 'now'> & { now(): Date } => Object.assign(Object.create(c), { now: () => new Date(c.now()) });

const uuid = (v: unknown, path: string): string => { if (typeof v !== 'string' || !UUID.test(v)) throw bad(path); return v; };
const oneOf = <T extends string>(v: unknown, set: readonly T[], path: string): T => { if (!set.includes(v as T)) throw bad(path); return v as T; };
function name(v: unknown, path: string): string {
  if (typeof v !== 'string' || v.includes('\u0000')) throw bad(path);
  const t = v.trim();
  if (t.length < 1 || v.length > 200) throw bad(path);
  return t;
}
function calendarDate(v: unknown, path: string, today: string): string {
  const m = typeof v === 'string' ? DATE.exec(v) : null;
  if (!m) throw bad(path);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d || (v as string) > today) throw bad(path);
  return v as string;
}

/** Serialises concurrent callers of the same business key inside this tx (released at tx end): the loser then sees the winner's committed row, never a raw unique violation. */
async function lock(c: PortCtx, key: string): Promise<void> {
  await c.tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${c.tenantId}:${key}`]);
}

// ---------------- new patient (booking newPatient and self-registration) ----------------
interface NewPatient { fullName: string; sex: string; birthOn?: string; ageYears?: number; phoneE164?: string; consents: { sms: boolean; whatsapp: boolean; email: boolean; shareWithReferrer: boolean; consentTextVersion: string } }

function parseNewPatient(v: unknown, path: string, o: { phoneRequired: boolean }): NewPatient {
  if (!isObj(v)) throw bad(path);
  const fullName = name(v['fullName'], `${path}/fullName`);
  const sex = oneOf(v['sex'], SEX, `${path}/sex`);
  if ((v['birthOn'] === undefined) === (v['ageYears'] === undefined)) throw bad(`${path}/birthOn`, `${path}/ageYears`);     // exactly one of the two
  if (v['ageYears'] !== undefined && (!Number.isInteger(v['ageYears']) || v['ageYears'] < 0 || v['ageYears'] > 150)) throw bad(`${path}/ageYears`);
  if (v['phoneE164'] === undefined ? o.phoneRequired : typeof v['phoneE164'] !== 'string' || !PHONE.test(v['phoneE164'])) throw bad(`${path}/phoneE164`);
  const k = v['consents'];
  if (!isObj(k)) throw bad(`${path}/consents`);
  for (const f of ['sms', 'whatsapp', 'email', 'shareWithReferrer']) if (typeof k[f] !== 'boolean') throw bad(`${path}/consents/${f}`);
  if (typeof k['consentTextVersion'] !== 'string' || k['consentTextVersion'].length < 1 || k['consentTextVersion'].length > 32) throw bad(`${path}/consents/consentTextVersion`);
  return { fullName, sex, ...(v['birthOn'] !== undefined ? { birthOn: v['birthOn'] as string } : {}), ...(v['ageYears'] !== undefined ? { ageYears: v['ageYears'] as number } : {}),
    ...(typeof v['phoneE164'] === 'string' ? { phoneE164: v['phoneE164'] } : {}), consents: k as NewPatient['consents'] };
}

/** TRD §6.1: the calling producer attests processing consent by calling the port (processing = true); the text version must be the tenant's current one (contract case 10). */
async function insertNewPatient(c: PortCtx, p: NewPatient, o: { id?: string; source: string; centreId?: string; today: string; numbering: Obj; now: Date }): Promise<{ row: Obj; duplicateSuspected: boolean }> {
  const cur = (await getSettings(c.tx, c.tenantId))?.consent_text_version;
  if (typeof cur !== 'string') throw new LimsError('common.internal');
  if (p.consents.consentTextVersion !== cur) throw new LimsError('frontdesk.consent_required');
  const pattern = o.numbering['patientCodePattern'];
  if (typeof pattern !== 'string') throw new LimsError('common.internal');
  const birthOn = p.birthOn !== undefined ? calendarDate(p.birthOn, '/birthOn', o.today) : estimatedBirthOn(p.ageYears!, o.today);
  const nameSearch = normaliseName(p.fullName);
  const dupes = (await findDedupePool(c.tx, c.tenantId, nameSearch)).filter((r) =>
    isDuplicateSuspect({ fullName: p.fullName, birthOn, ...(p.phoneE164 ? { phoneE164: p.phoneE164 } : {}) },
      { fullName: String(r['full_name']), birthOn: dateOnly(r['birth_on'])!, phoneE164: r['phone_e164'], anonymised: r['anonymised_at'] != null }));
  const seq = await nextCounterValue(c.tx, c.tenantId, 'patient_code', '', c.actor.id);
  const row = await insertPatient(c.tx, c.tenantId, { id: o.id ?? uuidv7(), patient_code: formatNumber(pattern, { seq }), full_name: p.fullName, name_search: nameSearch, sex: p.sex,
    birth_on: birthOn, is_birth_on_estimated: p.birthOn === undefined, ...(p.phoneE164 ? { phone_e164: p.phoneE164 } : {}), source: o.source, ...(o.centreId ? { registered_centre_id: o.centreId } : {}) });
  await insertConsent(c.tx, c.tenantId, { id: uuidv7(), patient_id: row['id'], processing: true, sms: p.consents.sms, whatsapp: p.consents.whatsapp, email: p.consents.email,
    share_with_referrer: p.consents.shareWithReferrer, consent_text_version: p.consents.consentTextVersion, source: o.source, captured_at: o.now });
  return { row, duplicateSuspected: dupes.length > 0 };
}

async function tenantInfo(c: PortCtx): Promise<{ today: string; tz: string; numbering: Obj }> {
  const s = (await c.ports.IdentityPort.getTenantSettings(c, { keys: ['numbering', 'timezone'] })) ?? {};
  const tz = typeof s.timezone === 'string' ? s.timezone : TZ;
  return { today: todayIn(tz, new Date(c.now())), tz, numbering: isObj(s.numbering) ? s.numbering : {} };
}

/** A deterministic UUIDv7-shaped id from (tenant, key): the replay lookup is a primary-key read, no separate idempotency table (patients has no key column). */
function idFromKey(tenantId: string, key: string): string {
  const b = createHash('sha256').update(`selfreg\u0000${tenantId}\u0000${key}`).digest().subarray(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x70; b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Engagement system actor only (IC §4.3). Always a NEW patient (source self_service, no centre); `duplicateSuspected` only flags. Idempotent on idempotencyKey. */
export async function createSelfRegisteredPatient(ctx: unknown, input: unknown): Promise<{ patientId: string; patientCode: string; duplicateSuspected: boolean; replayed: boolean }> {
  const c = staffCtx(ctx, ['system']);
  if (!isObj(input)) throw bad('');
  const p = parseNewPatient(input, '', { phoneRequired: true });
  const key = input['idempotencyKey'];
  if (typeof key !== 'string' || key.length < 1 || key.length > 200 || key.includes('\u0000')) throw bad('/idempotencyKey');
  const id = idFromKey(c.tenantId, key);
  await lock(c, `selfreg:${id}`);
  const info = await tenantInfo(c);
  const existing = await getPatientById(c.tx, c.tenantId, id);
  if (existing) {       // replay: the flag is recomputed over the patients that existed BEFORE this one, so it equals the first answer
    const pool = (await findDedupePool(c.tx, c.tenantId, normaliseName(String(existing['full_name'])))).filter((r) => r['id'] !== id && r['created_at'] < existing['created_at']);
    const dup = pool.some((r) => isDuplicateSuspect({ fullName: String(existing['full_name']), birthOn: dateOnly(existing['birth_on'])!, phoneE164: existing['phone_e164'] },
      { fullName: String(r['full_name']), birthOn: dateOnly(r['birth_on'])!, phoneE164: r['phone_e164'], anonymised: r['anonymised_at'] != null }));
    return { patientId: id, patientCode: existing['patient_code'], duplicateSuspected: dup, replayed: true };
  }
  const { row, duplicateSuspected } = await insertNewPatient(c, p, { id, source: 'self_service', ...info, now: new Date(c.now()) });
  return { patientId: row['id'], patientCode: row['patient_code'], duplicateSuspected, replayed: false };
}

// ---------------- createOrderFromBooking ----------------
interface BookingIn {
  source: Source; sourceRefId: string; patient: { patientId: string } | { newPatient: NewPatient }; branchId: string; centreId: string; referrerId?: string; creditPartyId?: string;
  orderableIds: string[]; priority: 'routine' | 'urgent'; scheduledAt?: string; confirmImmediately: boolean; idempotencyKey: string; partnerId?: string;
}

function parseBooking(b: Obj, source: Source): BookingIn {
  const p = b['patient'];
  if (!isObj(p) || (p['patientId'] === undefined) === (p['newPatient'] === undefined)) throw bad('/patient');
  const patient = p['patientId'] !== undefined ? { patientId: uuid(p['patientId'], '/patient/patientId') } : { newPatient: parseNewPatient(p['newPatient'], '/patient/newPatient', { phoneRequired: false }) };
  const ids = b['orderableIds'];
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 50) throw bad('/orderableIds');
  ids.forEach((x, i) => uuid(x, `/orderableIds/${i}`));
  if (new Set(ids).size !== ids.length) throw bad('/orderableIds');
  if (typeof b['confirmImmediately'] !== 'boolean') throw bad('/confirmImmediately');
  const key = b['idempotencyKey'];
  if (typeof key !== 'string' || key.length < 1 || key.length > 200 || key.includes('\u0000')) throw bad('/idempotencyKey');       // booking_links__key__ck: <= 200
  const at = b['scheduledAt'];
  if (at !== undefined && (typeof at !== 'string' || !ISO_INSTANT.test(at) || Number.isNaN(Date.parse(at)))) throw bad('/scheduledAt');
  if ((source === 'partner_manifest') !== (b['partnerId'] !== undefined)) throw bad('/partnerId');                      // required iff partner_manifest (08)
  return {
    source, sourceRefId: uuid(b['sourceRefId'], '/sourceRefId'), patient, branchId: uuid(b['branchId'], '/branchId'), centreId: uuid(b['centreId'], '/centreId'),
    ...(b['referrerId'] !== undefined ? { referrerId: uuid(b['referrerId'], '/referrerId') } : {}), ...(b['creditPartyId'] !== undefined ? { creditPartyId: uuid(b['creditPartyId'], '/creditPartyId') } : {}),
    orderableIds: ids as string[], priority: oneOf(b['priority'], ['routine', 'urgent'], '/priority'), ...(at !== undefined ? { scheduledAt: at as string } : {}),
    confirmImmediately: b['confirmImmediately'], idempotencyKey: key, ...(b['partnerId'] !== undefined ? { partnerId: uuid(b['partnerId'], '/partnerId') } : {}),
  };
}

type Result = { orderId: string; registrationNo: string; status: 'pre_registered' | 'registered'; replayed: boolean };
// ponytail: a replay reports pre_registered or registered only (the IC type): a later in_progress / completed / cancelled order is reported as registered.
const replayOf = (o: Obj): Result => ({ orderId: o['id'], registrationNo: o['registration_no'], status: o['status'] === 'pre_registered' ? 'pre_registered' : 'registered', replayed: true });

export async function createOrderFromBooking(ctx: unknown, input: unknown): Promise<Result> {
  const c = staffCtx(ctx);
  const source = isObj(input) && SOURCES.includes(input['source'] as Source) ? (input['source'] as Source) : undefined;
  if (!source) throw bad('/source');
  if (c.actor.type === 'user') {          // system actors pass; a user needs the source's permission (engagement_booking has none)
    const permission = SOURCE_PERMISSION[source];
    if (!permission) throw forbidden();
    await c.ports.IdentityPort.assertRole(c, { permission });
  }
  const b = parseBooking(input as Obj, source);
  if (c.actor.type === 'user') {          // 03-IC §4.3 "centre scope applies" (review FD-T11 #1): checked before any write; 404, not 403, as F9
    const s = (await c.ports.IdentityPort.getActor(c)).centreScope as { all?: boolean; centreIds?: readonly string[] } | undefined;
    if (s?.all !== true && !(s?.centreIds ?? []).includes(b.centreId)) throw new LimsError('common.not_found');
  }
  const hc =dateCtx(c) as unknown as QuoteCtx;
  const { catalog, billing } = { catalog: c.ports['CatalogPort'], billing: c.ports['BillingCommandPort'] };
  if (!catalog || !billing) throw new LimsError('common.service_unavailable');

  // idempotency + one order per booking: serialised on (source, sourceRefId), so a concurrent loser reads the winner's link instead of hitting a unique index
  await lock(c, `booking:${source}:${b.sourceRefId}`);
  const link = await getBookingLink(c.tx, c.tenantId, source, b.sourceRefId);
  if (link) {
    if (link['idempotency_key'] !== b.idempotencyKey || !link['order_id']) throw new LimsError('frontdesk.booking_already_converted');
    return replayOf((await getOrderById(c.tx, c.tenantId, link['order_id']))!);
  }

  const centre = await core.centre(c as never, { centreId: b.centreId });                  // other tenant's centre: common.not_found
  if (centre.branchId !== b.branchId) throw bad('/branchId');
  const settings = await getSettings(c.tx, c.tenantId);
  const info = await tenantInfo(c);
  const now = new Date(c.now());

  let patient: Obj;
  if ('patientId' in b.patient) {
    const row = await getPatientById(c.tx, c.tenantId, b.patient.patientId);
    if (!row) throw new LimsError('common.not_found');
    if (row['anonymised_at'] != null) throw bad('/patient');
    patient = row;
  } else {
    const made = await insertNewPatient(c, b.patient.newPatient, { source, centreId: b.centreId, ...info, now });
    if (made.duplicateSuspected) throw new LimsError('frontdesk.patient_duplicate_suspected');
    patient = made.row;
  }
  if (b.referrerId && !(await catalog.getReferrer(c, { referrerId: b.referrerId, purpose: 'display' })).isActive) throw bad('/referrerId');

  // server-side prices (REQ-SEC-046): the caller supplies orderable ids only
  const d: Draft = { centreId: b.centreId, billingMode: b.creditPartyId ? 'credit' : 'cash', visitType: 'opd', priority: b.priority, collectionMode: COLLECTION[source],
    ...(b.creditPartyId ? { creditPartyId: b.creditPartyId } : {}), ...(b.referrerId ? { referrerId: b.referrerId } : {}), items: b.orderableIds.map((orderableId) => ({ orderableId, priority: b.priority })), discounts: [] };
  const p = await priceDraft(hc, d, settings);
  if (b.confirmImmediately && d.billingMode === 'credit') await billing.assertCreditAllowed(c, { creditPartyId: b.creditPartyId, additional: p.q.totals.net });

  const pattern = info.numbering['registrationNoPattern'];
  if (typeof pattern !== 'string') throw new LimsError('common.internal');
  const branchCode = hasToken(pattern, 'branch') ? (await core.branch(c as never, { branchId: b.branchId })).branchCode : undefined;
  const seq = await nextCounterValue(c.tx, c.tenantId, 'registration_no', b.branchId, c.actor.id);
  const birth = dateOnly(patient['birth_on']);
  const age = birth ? ageParts(birth, info.today) : undefined;
  const orderId = uuidv7();
  const order = await insertOrder(c.tx, c.tenantId, {
    id: orderId, branch_id: b.branchId, centre_id: b.centreId, patient_id: patient['id'],
    registration_no: formatNumber(pattern, { seq, year: Number(info.today.slice(0, 4)), ...(branchCode === undefined ? {} : { branch: branchCode }) }),
    status: b.confirmImmediately ? 'registered' : 'pre_registered', visit_type: 'opd', billing_mode: d.billingMode, credit_party_id: b.creditPartyId, referrer_id: b.referrerId, priority: b.priority,
    collection_mode: COLLECTION[source], source, source_ref_id: b.sourceRefId, partner_id: b.partnerId, age_years: age?.years, age_months: age?.months, age_days: age?.days,
    is_first_order_of_patient: !(await patientHasOrder(c.tx, c.tenantId, patient['id'])), catalog_revision: p.resolved.catalogRevision, scheduled_at: b.scheduledAt,
    ...(b.confirmImmediately ? { registered_at: now } : {}),
  });
  const items: Obj[] = [];
  for (const [i, l] of p.priced.entries()) {
    items.push(await insertOrderItem(c.tx, c.tenantId, { id: uuidv7(), order_id: orderId, centre_id: b.centreId, orderable_id: l.orderableId, orderable_kind: l.orderableKind, code: l.code, name: l.name,
      test_ids: p.meta[i]!.testIds, department_id: p.meta[i]!.departmentId, priority: l.priority, unit_price_paisa: l.unitPrice.amountPaisa, urgent_surcharge_paisa: l.urgentSurcharge?.amountPaisa,
      price_list_id: l.priceListId, price_list_version: l.priceListVersion, price_source: l.priceSource, vat_treatment: l.tax.vat, other_tax_code: l.tax.otherTaxCode, added_in_items_version: 1 }));
  }
  await insertBookingLink(c.tx, c.tenantId, { source, source_ref_id: b.sourceRefId, order_id: orderId, idempotency_key: b.idempotencyKey, state: 'converted', last_seq: 0 });

  if (b.confirmImmediately) {          // the registration path without payments: cash = invoice issued (due outstanding), credit = charges; the order.created event once
    const refPart = b.referrerId ? { referrerId: b.referrerId } : {};
    if (d.billingMode === 'cash') {
      await billing.issueOrderInvoice(c, { orderId, patientId: patient['id'], branchId: b.branchId, centreId: b.centreId, ...refPart,
        buyer: { name: String(patient['full_name']), ...(patient['address_text'] ? { address: String(patient['address_text']) } : {}) },
        lines: p.priced, discounts: p.discounts, expectedFingerprint: p.q.fingerprint, purpose: 'registration' });
    } else {
      await billing.recordCreditCharges(c, { orderId, creditPartyId: b.creditPartyId, branchId: b.branchId, centreId: b.centreId, ...refPart,
        patientDisplayName: String(patient['full_name']), lines: p.priced, discounts: p.discounts, expectedFingerprint: p.q.fingerprint });
    }
    await createFrontdeskEvents(events as never).orderCreated(c as never, {
      order_id: orderId, patient_id: patient['id'], branch_id: b.branchId, centre_id: b.centreId, visit_type: 'opd', billing_mode: d.billingMode,
      ...(b.creditPartyId ? { credit_party_id: b.creditPartyId } : {}), ...(b.referrerId ? { referrer_id: b.referrerId } : {}), priority: b.priority, collection_mode: COLLECTION[source],
      source, source_ref_id: b.sourceRefId, registered_at: now.toISOString(),
      items: items.map((it, i) => ({ order_item_id: it['id'], orderable_id: it['orderable_id'], orderable_kind: it['orderable_kind'], test_ids: p.meta[i]!.testIds, priority: it['priority'] })),
    }, Number(order['version']));
  }
  return { orderId, registrationNo: order['registration_no'], status: b.confirmImmediately ? 'registered' : 'pre_registered', replayed: false };
}

// ---------------- booking consumers (TRD §3.1 / §8.2 subscriptions; the FD-T12 worker files wrap these with envelope.payload and envelope.aggregate.seq) ----------------
// `seq` = aggregate.seq of the event. booking_links.last_seq records the newest applied one; a cancelled link is final (03-IC §3.24 Ordering: a late confirmation is ignored).
const bookingKey = (id: unknown): string => String(id);

/** engagement.booking.confirmed.v1: centre_visit -> one pre_registered engagement_booking order (same path as the port, X5); home_collection -> nothing (C17 creates it at assignment, 08 R7). */
export async function onBookingConfirmed(ctx: unknown, payload: unknown, seq?: number): Promise<void> {
  const c = staffCtx(ctx, ['system']);
  if (!isObj(payload)) throw bad('');
  if (payload['booking_kind'] !== 'centre_visit') return;
  const id = payload['booking_id'];
  if (typeof id !== 'string' || !UUID.test(id)) throw bad('/booking_id');
  await lock(c, `booking:engagement_booking:${id}`);
  if ((await getBookingLink(c.tx, c.tenantId, 'engagement_booking', id))?.['state'] === 'cancelled') return;      // cancel-before-confirm / stale confirmation
  await createOrderFromBooking(c, { source: 'engagement_booking', sourceRefId: id, patient: { patientId: payload['patient_id'] }, branchId: payload['branch_id'], centreId: payload['centre_id'],
    orderableIds: payload['orderable_ids'], priority: 'routine', scheduledAt: payload['slot_start'], confirmImmediately: false, idempotencyKey: `booking:${bookingKey(id)}:confirmed` });
  if (seq !== undefined) await touchBookingLink(c.tx, c.tenantId, 'engagement_booking', id, seq);
}

/**
 * engagement.booking.cancelled.v1. centre_visit: unknown booking -> link cancelled + last_seq; pre_registered order -> cancelled (reason booking_cancelled, event, no billing: never invoiced);
 * registered or later -> review flag, order untouched. home_collection with a linked REGISTERED order -> the same flag (08 R7, A2.12); no link -> nothing.
 */
export async function onBookingCancelled(ctx: unknown, payload: unknown, seq?: number): Promise<void> {
  const c = staffCtx(ctx, ['system']);
  if (!isObj(payload)) throw bad('');
  if (payload['booking_kind'] === 'home_collection') {
    if (typeof payload['home_visit_id'] !== 'string' || !UUID.test(payload['home_visit_id'])) return;
    const link = await getBookingLink(c.tx, c.tenantId, 'home_collection', payload['home_visit_id']);
    const order = link?.['order_id'] ? await getOrderById(c.tx, c.tenantId, link['order_id']) : null;
    if (!order || order['status'] === 'pre_registered' || order['status'] === 'cancelled') return;
    await raiseBookingCancelledFlag(c, order);        // redelivery: the unique index keeps one open review item per order
    return;
  }
  const id = payload['booking_id'];
  if (typeof id !== 'string' || !UUID.test(id)) throw bad('/booking_id');
  const at = seq ?? 0;
  await lock(c, `booking:engagement_booking:${id}`);
  const link = await getBookingLink(c.tx, c.tenantId, 'engagement_booking', id);
  if (!link) { await insertBookingLink(c.tx, c.tenantId, { source: 'engagement_booking', source_ref_id: id, state: 'cancelled', last_seq: at }); return; }
  if (seq !== undefined && seq <= Number(link['last_seq'])) return;                  // stale or duplicate
  const order = link['order_id'] ? await lockOrderById(c.tx, c.tenantId, link['order_id']) : null;
  if (order?.['status'] === 'pre_registered') {
    const when = new Date(c.now());
    const updated = await cancelOrderRow(c.tx, c.tenantId, order['id'], Number(order['version']), { at: when, by: c.actor.id, reasonCode: 'booking_cancelled', requiresCreditNote: false });
    if (!updated) throw new LimsError('common.version_conflict');
    await cancelActiveItems(c.tx, c.tenantId, order['id']);
    const ev = (c as unknown as { events?: unknown }).events ?? events;
    await createFrontdeskEvents(ev as never).cancelled(dateCtx(c) as never, { order_id: order['id'], reason_code: 'booking_cancelled', cancelled_at: when.toISOString(), requires_credit_note: false }, Number(updated['version']));
    await touchBookingLink(c.tx, c.tenantId, 'engagement_booking', id, at, 'cancelled');
  } else if (order && order['status'] !== 'cancelled') {
    await raiseBookingCancelledFlag(c, order);
    await touchBookingLink(c.tx, c.tenantId, 'engagement_booking', id, at);
  } else {
    await touchBookingLink(c.tx, c.tenantId, 'engagement_booking', id, at, 'cancelled');
  }
}
