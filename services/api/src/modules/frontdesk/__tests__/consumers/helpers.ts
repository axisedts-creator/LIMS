// FD-T12 harness: the five frontdesk event consumers (02-TRD §3.3 / §8.2; 03-IC §3.7, §3.8, §3.19, §3.22, §3.24; 08 A13 D-6, R7, A2.12) driven on a REAL PG17 tx (lims_api, RLS on).
// Lives under services/api so the package vitest config (LIMS_CORE_ENV etc.) applies; it imports the worker files by relative path (the billing consumers do the same the other way round).
// ASSUMED seams (spec fixes behaviour, not signatures; writer: dispute via .orchestra/notes if wrong):
//   services/worker/src/jobs/frontdesk/consumers/<event_type>.ts, one file per event, each exporting ONE ConsumerHandler `(envelope, ctx)` under the TRD §3.3 name:
//     lab.specimen.rejected.v1 -> onSpecimenRejected, lab.specimen.status_changed.v1 -> onSpecimenStatusChanged, catalog.changed.v1 -> onCatalogChanged,
//     engagement.booking.confirmed.v1 -> onBookingConfirmed, engagement.booking.cancelled.v1 -> onBookingCancelled.   index.ts registers them in manifest.subscriptions under the event types.
//   The C0 wrapper (core/consumer.ts) already did inbox dedupe by event_id and schema validation (unknown fields stripped); the handler gets the envelope with the payload under `.payload` and
//   `.aggregate.seq`. Handlers are ALSO idempotent on their own keys (order_flags unique index, booking_links), proven here by redelivering under a NEW event_id. They open no transaction (ctx.tx is the job's).
//   ctx = JobContext-like: tenantId, actor {type:'system'}, requestId, tx, now() ISO string, isNewer(last, seq), log, + what the services need: events (REAL core createEvents), core (REAL createCoreRepo),
//   audit {access}, ports {IdentityPort (getTenantSettings -> branding.displayName), NotificationPort, CatalogPort, BillingCommandPort, LabPort} (REAL packages/fakes). The tenant comes from ctx.tenantId only:
//   an envelope whose tenant_id differs from ctx.tenantId writes nothing (BL-T16 rule).
//   SMS template `frontdesk.recollection_request` is declared with params {lab_name, centre_phone} (TRD §8.2, 03-APP-FLOW §3.4); the fake's default template declares only {lab_name}, so the harness overrides it
//   exactly like registration/helpers.ts does for registration_confirmation.
// Synthetic data only.
import { createFakeNotificationPort } from '../../../../../../../packages/fakes/src/NotificationPort.fake';
import { TYPES, handlerOf, type Kind } from './names.js';
import { access } from '../../../../core/audit/access.js';
import { createCoreRepo } from '../../../../core/core-repo/index.js';
import { createEvents } from '../../../../core/events/publish.js';
import { CENTRE_A2, scenario, type Scenario } from '../orders/helpers.js';
import { BRANCH, CENTRE, NOW, SYS_ACTOR, TENANT_A, TENANT_B, appTx, makeIdentity, ownerRows, rejection, seed, seedOrder, seedPatient, superTx, uid, TENANT_SETTINGS } from '../patients/helpers.js';
import { O, seedLimits } from '../quote/helpers.js';
import { LAB_NAME, REG_PATTERN, ensureTaskRegistry, rworld, type RWorld } from '../registration/helpers.js';

export { BRANCH, CENTRE, CENTRE_A2, LAB_NAME, NOW, O, TENANT_A, TENANT_B, ownerRows, rejection, scenario, seed, seedOrder, seedPatient, superTx, uid };
export type { RWorld, Scenario };

export const T = 60_000;
export const NOW_ISO = NOW.toISOString();
export const CENTRE_PHONE = '01-4400123';               // short_text-safe (the fake's charset has no '+')

export { EXPORT_OF, FILE_OF, TYPES, handlerOf } from './names.js';
export type { Kind } from './names.js';

const PRODUCER: Record<Kind, [string, string]> = { rejected: ['lab', 'specimen'], changed: ['lab', 'specimen'], catalog: ['catalog', 'catalog'], confirmed: ['engagement', 'booking'], cancelled: ['engagement', 'booking'] };
/** A validated envelope as the C0 consumer wrapper hands it over (02-CV §7.1). */
export function envelope(kind: Kind, payload: Record<string, unknown>, o: { seq?: number; eventId?: string; tenant?: string; aggregateId?: string; extra?: Record<string, unknown> } = {}) {
  const [producer, aggType] = PRODUCER[kind];
  return { event_id: o.eventId ?? uid(), event_type: TYPES[kind], tenant_id: o.tenant ?? TENANT_A, occurred_at: '2026-11-10T05:30:00.000Z', actor: { type: 'system', id: uid() },
    idempotency_key: `${TYPES[kind]}:${uid()}`, producer, aggregate: { type: aggType, id: o.aggregateId ?? uid(), seq: o.seq ?? 1 }, request_id: uid(), payload, ...(o.extra ?? {}) };
}

export interface CO {
  tenant?: string; w?: RWorld; sms?: 'on' | 'off'; smsThrows?: boolean; failEvent?: string; envTenant?: string;
  /** filled by `consume`: what the handler was given / did */ probe?: { sms: any[]; ctx?: any; writes: string[]; w?: RWorld };
}
const WRITE = /^\s*(insert|update|delete|truncate)\b/i;

/** One delivery = one job tx under RLS (system claims) with the JobContext-like ctx. Commits on success, rolls back (and drops fake-side effects) on throw. */
export async function consume(kind: Kind, env: unknown, o: CO = {}): Promise<void> {
  await seedLimits();
  await ensureTaskRegistry();
  const handler = await handlerOf(kind);
  const tenant = o.tenant ?? TENANT_A;
  const side = tenant === TENANT_B ? 'b' : 'a';
  const w = o.w ?? rworld({ creditList: true });
  const probe = o.probe ?? { sms: [], writes: [] };
  probe.w = w;
  const fake: any = createFakeNotificationPort({ seed: 1, fixtures: { templates: [{ id: uid(), code: 'frontdesk.recollection_request', purpose: 'recollection_request', channels: ['sms', 'whatsapp'],
    params: { lab_name: 'short_text', centre_phone: 'short_text' } }], channels: { [TENANT_A]: { smsEnabled: true, whatsappEnabled: true, emailEnabled: true }, [TENANT_B]: { smsEnabled: true, whatsappEnabled: true, emailEnabled: true } } } as any });
  const known = (w as any).__recipients as any[] | undefined;
  if (known) fake.__seed({ recipients: known });
  const notif = { ...fake, sendSms: async (c: any, i: any) => { probe.sms.push(i); if (o.smsThrows) throw new Error('provider down'); return fake.sendSms(c, i); } };
  const identity: any = makeIdentity([], { centreIds: [CENTRE[side]] });
  const settings = { ...TENANT_SETTINGS, numbering: { ...TENANT_SETTINGS.numbering, registrationNoPattern: REG_PATTERN }, branding: { displayName: LAB_NAME }, channels: { ...TENANT_SETTINGS.channels, smsEnabled: o.sms !== 'off' } };
  identity.getTenantSettings = async () => settings;
  const real = createEvents({ producer: 'frontdesk' });
  const events = { publish: async (c: any, type: string, input: any, ...rest: any[]) => {
    if (o.failEvent === type) throw Object.assign(new Error('injected'), { code: 'common.internal' });
    return (real.publish as any)(c, type, input, ...rest);
  } };
  return appTx(tenant, async (rawTx: any) => {
    rawTx.startedAt = NOW;                                   // core events.publish stamps occurred_at from tx.startedAt
    const tx = new Proxy(rawTx, { get: (t, p) => (p === 'query' ? (sql: any, ...a: any[]) => { if (typeof sql === 'string' && WRITE.test(sql)) probe.writes.push(sql); return t.query(sql, ...a); } : t[p]) });
    const ctx: any = {
      tenantId: tenant, actor: { type: 'system', id: SYS_ACTOR }, requestId: uid(), tx, now: () => NOW.toISOString(), isNewer: (last: number | undefined, seq: number) => last === undefined || seq > last,
      attempt: 1, maxAttempts: 10, jobId: '1', log: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } },
      events, core: createCoreRepo({} as never), storage: undefined, files: undefined, audit: { access: async (e: any) => access(ctx, e) },
      ports: { IdentityPort: identity, CatalogPort: w.catalog, BillingCommandPort: w.billing, NotificationPort: notif, LabPort: laterLab() },
    };
    ctx.db = { tx: async (fn: any) => fn(ctx) };
    probe.ctx = ctx;
    try { return await handler(env, ctx); } catch (e) { w.spy.rollback(rawTx); fake.__rollback?.(rawTx); throw e; }
  });
}
export const consumeFails = (kind: Kind, env: unknown, o: CO = {}) => rejection(consume(kind, env, o));
/** Outcome-agnostic: some "nothing should happen" cases (unknown order, foreign tenant) may either resolve or reject (dead-letter); both are fine, only the writes matter. */
export const consumeQuietly = async (kind: Kind, env: unknown, o: CO = {}): Promise<'resolved' | 'rejected'> => { try { await consume(kind, env, o); return 'resolved'; } catch { return 'rejected'; } };
/** A LabPort that knows nothing (a booking cancel on a pre_registered order must not need lab facts beyond "no approved results"). */
function laterLab() {
  return { getOrderItemProcessingState: async () => ({ items: [] }), getOrderResults: async () => ({ results: [] }) };
}

// ---- owner-side truth (no RLS) ----
export const flagRows = (orderId: string) => ownerRows('frontdesk.order_flags', 'order_id = $1 ORDER BY created_at, id', [orderId]);
export const flagsOfSpecimen = (tenant: string, specimenId: string) => ownerRows('frontdesk.order_flags', 'tenant_id = $1 AND specimen_id = $2', [tenant, specimenId]);
export const orderRow = async (id: string) => (await ownerRows('frontdesk.orders', 'id = $1', [id]))[0];
export const linkRows = (tenant: string, source: string, ref: string) => ownerRows('frontdesk.booking_links', 'tenant_id = $1 AND source = $2 AND source_ref_id = $3', [tenant, source, ref]);
export const ordersBySource = (tenant: string, source: string, ref: string) => ownerRows('frontdesk.orders', 'tenant_id = $1 AND source = $2 AND source_ref_id = $3', [tenant, source, ref]);
export const itemRows = (orderId: string) => ownerRows('frontdesk.order_items', 'order_id = $1 ORDER BY code, priority', [orderId]);
export const eventRows = (type: string, orderId: string) => ownerRows('core.event_log', 'event_type = $1 AND aggregate_id = $2', [type, orderId]);

/** A registered order whose patient has (or has not) SMS consent and is known to the notification fake, plus the order centre's phone. */
export async function recollectionWorld(o: { sms?: boolean; side?: 'a' | 'b'; status?: string } = {}) {
  const side = o.side ?? 'a';
  const tenant = side === 'a' ? TENANT_A : TENANT_B;
  const sms = o.sms ?? true;
  const patient = await seedPatient(side, {}, { sms });
  const order = await seedOrder(side, patient.id, { status: o.status ?? 'registered' });
  const w: any = rworld({ creditList: true });
  w.__recipients = [{ id: patient.id, tenantId: tenant, kind: 'patient', phoneE164: '+9779800000011', email: null, consent: { sms, whatsapp: false, email: false } }];
  await setCentrePhone(CENTRE[side], CENTRE_PHONE);
  return { w: w as RWorld, patient, order, tenant, side };
}
export async function setCentrePhone(centreId: string, phone: string): Promise<void> {
  await superTx(async (tx) => { await tx.query('UPDATE core.collection_centres SET phone_display = $2 WHERE id = $1', [centreId, phone]); });
}

// ---- event payloads (contracts/events/*.schema.json; field sets and example values follow 03-IC §3.7 / §3.8 / §3.22 / §3.24) ----
export const rejectedPayload = (o: { specimenId: string; orderId: string; patientId: string; centreId?: string; recollection?: boolean } & Record<string, unknown>) => {
  const { specimenId, orderId, patientId, centreId, recollection, ...rest } = o;
  return { specimen_id: specimenId, order_id: orderId, patient_id: patientId, centre_id: centreId ?? CENTRE.a, reason_code: 'haemolysed', rejected_at: '2026-11-05T03:25:00.000Z',
    recollection_required: recollection ?? true, order_item_ids: [uid()], ...rest };
};
export const statusPayload = (o: { specimenId: string; orderId: string; patientId: string; to: string; centreId?: string } & Record<string, unknown>) => {
  const { specimenId, orderId, patientId, to, centreId, ...rest } = o;
  return { specimen_id: specimenId, order_id: orderId, patient_id: patientId, centre_id: centreId ?? CENTRE.a, specimen_type_code: 'EDTA_WB', from_status: 'rejected', to_status: to,
    changed_at: '2026-11-05T03:26:00.000Z', ...rest };
};
export const confirmedPayload = (patientId: string, o: Record<string, unknown> = {}) => ({ booking_id: uid(), patient_id: patientId, branch_id: BRANCH.a, centre_id: CENTRE.a, booking_kind: 'centre_visit',
  slot_start: '2026-11-11T04:00:00.000Z', slot_end: '2026-11-11T04:30:00.000Z', orderable_ids: [O.cbc, O.glu], confirmed_at: '2026-11-10T05:00:00.000Z', ...o });
export const cancelledPayload = (patientId: string, o: Record<string, unknown> = {}) => ({ booking_id: uid(), patient_id: patientId, booking_kind: 'centre_visit', reason_code: 'patient_request',
  cancelled_by_kind: 'patient', cancelled_at: '2026-11-10T05:30:00.000Z', ...o });

/** 03-IC §3.22 / §3.24 / §3.19 example payloads, verbatim. */
export const IC_EXAMPLES = {
  confirmedHome: { booking_id: '01a1a98a-ac40-7000-8000-000000120001', patient_id: '01a1a98a-ac40-7000-8000-000000040001', branch_id: '01a1a98a-ac40-7000-8000-000000010001', centre_id: '01a1a98a-ac40-7000-8000-000000020002',
    booking_kind: 'home_collection', slot_start: '2026-11-06T01:15:00.000Z', slot_end: '2026-11-06T01:45:00.000Z', orderable_ids: ['01a1a98a-ac40-7000-8000-000000070002'],
    home_address_id: '01a1a98a-ac40-7000-8000-000000190001', confirmed_at: '2026-11-05T09:00:00.000Z' },
  cancelledHome: { booking_id: '01a1a98a-ac40-7000-8000-000000120001', patient_id: '01a1a98a-ac40-7000-8000-000000040001', booking_kind: 'home_collection', reason_code: 'patient_request', cancelled_by_kind: 'patient',
    order_id: '01a1a98a-ac40-7000-8000-000000050002', home_visit_id: '01a1a98a-ac40-7000-8000-000000130001', slot_start: '2026-11-06T01:15:00.000Z', cancelled_at: '2026-11-05T12:00:00.000Z' },
  catalog: { catalog_revision: 418, entity_type: 'price_list', entity_id: '01a1a98a-ac40-7000-8000-000000180001', change_kind: 'versioned', effective_from: '2026-11-06T00:00:00.000Z' },
  rejected: { specimen_id: '01a1a98a-ac40-7000-8000-000000090001', order_id: '01a1a98a-ac40-7000-8000-000000050001', patient_id: '01a1a98a-ac40-7000-8000-000000040001', centre_id: '01a1a98a-ac40-7000-8000-000000020002',
    reason_code: 'haemolysed', rejected_at: '2026-11-05T03:25:00.000Z', recollection_required: true, order_item_ids: ['01a1a98a-ac40-7000-8000-000000060002'] },
  statusReceived: { specimen_id: '01a1a98a-ac40-7000-8000-000000090001', order_id: '01a1a98a-ac40-7000-8000-000000050001', patient_id: '01a1a98a-ac40-7000-8000-000000040001', centre_id: '01a1a98a-ac40-7000-8000-000000020002',
    processing_branch_id: '01a1a98a-ac40-7000-8000-000000010001', specimen_type_code: 'EDTA_WB', from_status: 'in_transit', to_status: 'received', changed_at: '2026-11-05T03:20:41.300Z',
    order_item_ids: ['01a1a98a-ac40-7000-8000-000000060001'] },
} as const;
