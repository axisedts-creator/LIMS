// HC-T13 harness: H9 reviewHeldCollection (POST /v1/homecollection/collections/{collection_id}/review, `homecollection.visit.assign`, Idempotency-Key + If-Match "<version>"),
// 02-TRD §5.1 H9 / §8.1 trigger (b), 03-APP-FLOW §1.2 C3/C4, 01-PRD US-09-1..4 (CR-C17-006 trigger, CR-C17-007 collection_not_held), 07-SECURITY §4/§5 (privilege escalation: phlebotomist -> 403).
// Same convention as ../sync/helpers.ts (HC-T12) and ../dispatch/helpers.ts (HC-T09): the handler under test is taken from the module manifest and driven with a request-shaped object and a HandlerContext
// over a REAL PG17 tx (lims_api, RLS on; `bypassRls` = superuser tx so only the repo's own tenant_id filter keeps tenants apart). The core pipeline (OpenAPI validation, auth, x-permission, the
// Idempotency-Key replay hook) is NOT re-tested.
// ASSUMED ctx (TRD §6.4): tenantId, tx (tx.startedAt set here, as the core tx wrapper does), now(), centreId, actor{type,id,membershipId}, log, db.tx(fn), ports.IdentityPort.assertRole,
//   ports.FrontdeskPort.getOrderSummary(ctx,{orderId}) -> { status } (FAKE: fx.orderStatus, default 'registered'; records every call),
//   ports.LabPort.lookupSpecimens(ctx,{orderId,...}) -> SpecimenRef[] (FAKE: the specimens seeded for the order as `ordered`; fx.lab overrides per order; records every call),
//   ctx.events = the REAL core createEvents({producer:'homecollection'}) (rows land in core.event_log inside the request tx and are read back with the owner role),
//   core.memberships.list (display names), core.user, audit.access. Synthetic data only.
// Env: LIMS_TEST_APP_URL / LIMS_TEST_SUPER_URL, exported by tests/homecollection/HC-T13.pg.sh.
import { LimsError } from '../../../../core/errors.js';
import { access } from '../../../../core/audit/access.js';
import { createEvents } from '../../../../core/events/publish.js';
import { manifest } from '../../index.js';
import { HC_CENTRE, MEMBER, T0, appTx, hc, seed } from '../../repository/__tests__/helpers.js';
import { DISPATCHER, DISPATCHER_B, NOBODY, P, PHLEBO, SYS_ACTOR, T, TENANT_A, TENANT_B, ownerRows, rejection, req, staffName, superTx, uid, type Who } from '../visits/helpers.js';
import { schemaErrors, seedReasons } from '../settings/helpers.js';
import { v7 } from '../devices/helpers.js';
import { ensureSettings, mkRoute, seedDevice, seedVisit } from '../snapshot/helpers.js';
import { EVENT, ensureTaskRegistry, eventKeyRe, eventsOf, keysDeep, nextDay, noonOf, stringsDeep } from '../sync/helpers.js';

export { DISPATCHER, DISPATCHER_B, NOBODY, P, PHLEBO, SYS_ACTOR, T, TENANT_A, TENANT_B, HC_CENTRE, MEMBER, ownerRows, rejection, req, schemaErrors, seedReasons, staffName, superTx, uid, v7, EVENT, eventKeyRe, keysDeep, stringsDeep };
export type { Who };
export const NOW = new Date('2028-06-01T06:00:00.000Z');
export const FILE = 9;   // nextDay(file) range: 120 days per file index; HC-T12 uses 0..4

// ---------------------------------------------------------------- fakes
export interface SpecRef { specimenId: string; barcode: string; orderId: string; patientId: string; centreId: string; specimenTypeCode: string; status: string; isActive: boolean; version: number }
export interface Fx {
  /** status served by FrontdeskPort.getOrderSummary (default 'registered') */
  orderStatus?: string;
  /** FrontdeskPort.getOrderSummary / LabPort.lookupSpecimens fail with this LimsError code */
  orderFails?: string; labFails?: string;
  /** override what lookupSpecimens serves for an order: the seeded specimen refs are patched index by index */
  lab?: Record<string, readonly Partial<SpecRef>[]>;
  /** centres where assertRole(.., {centreId}) fails with auth.forbidden */
  deniedCentres?: readonly string[];
  /** core.memberships.list fails */
  coreFails?: boolean;
}
export interface Probe { requestId: string; logs: string[]; identity: Array<{ permission: string; centreId?: string }>; lab: Array<Record<string, unknown>>; orderSummary: string[]; memberships: Array<Record<string, unknown>> }
export interface Reply { status: number; body: any; headers?: Record<string, string>; probe: Probe }
export interface OpOpts { fx?: Fx; bypassRls?: boolean }
const H = manifest.handlers as unknown as Record<string, (r: any, ctx: any) => Promise<{ status: number; body?: any; headers?: Record<string, string> }>>;
const specStore = new Map<string, SpecRef[]>();   // orderId -> seeded specimens (what LabPort serves)
const events = createEvents({ producer: 'homecollection' });

export async function op(operationId: string, r: ReturnType<typeof req>, who: Who, o: OpOpts = {}): Promise<Reply> {
  const side = who.tenant === TENANT_B ? 'b' : 'a';
  const fx = o.fx ?? {};
  const probe: Probe = { requestId: uid(), logs: [], identity: [], lab: [], orderSummary: [], memberships: [] };
  const run = async (tx: any) => {
    tx.startedAt = NOW;   // core publish stamps occurred_at from it
    const log = (lvl: string) => (obj: object, msg?: string) => { probe.logs.push(`${lvl} ${JSON.stringify(obj)} ${msg ?? ''}`); };
    const ctx: any = {
      operationId, clientIp: '203.0.113.9', log: { info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') }, metrics: { inc: () => undefined },
      tenantId: who.tenant, tx, requestId: probe.requestId, now: () => NOW, centreId: HC_CENTRE[side],
      actor: { type: 'user', id: SYS_ACTOR, membershipId: who.membershipId },
      db: { tx: async (fn: (c: any) => Promise<unknown>) => fn(ctx) },
      ports: {
        IdentityPort: {
          async assertRole(_c: unknown, a: { permission: string; centreId?: string }) {
            probe.identity.push({ permission: a?.permission, ...(a?.centreId ? { centreId: a.centreId } : {}) });
            if (!who.grants.includes(a?.permission)) throw new LimsError('auth.forbidden');
            if (a?.centreId && fx.deniedCentres?.includes(a.centreId)) throw new LimsError('auth.forbidden');
          },
          async getActor() {
            return { actor: { type: 'user', id: SYS_ACTOR, membershipId: who.membershipId }, displayName: 'Synthetic Dispatcher', roles: [], permissions: [...who.grants], centreScope: { all: true, centreIds: [] },
              branchIds: [], mfa: { enrolled: false, level: 'aal1' }, isLocked: false };
          },
          async getTenantSettings() { return { timezone: 'Asia/Kathmandu' }; },
        },
        FrontdeskPort: {
          async getOrderSummary(_c: unknown, a: { orderId: string }) {
            probe.orderSummary.push(a.orderId);
            if (fx.orderFails) throw new LimsError(fx.orderFails);
            return { orderId: a.orderId, registrationNo: `SYNREG-${a.orderId.slice(-6)}`, status: fx.orderStatus ?? 'registered', items: [], version: 1 };
          },
        },
        LabPort: {
          async lookupSpecimens(_c: unknown, a: { orderId: string; statuses?: string[] }) {
            probe.lab.push({ ...a });
            if (fx.labFails) throw new LimsError(fx.labFails);
            const base = specStore.get(a.orderId) ?? [];
            const over = fx.lab?.[a.orderId];
            return over ? over.map((x, i) => ({ ...base[i], ...x })) : base;
          },
        },
      },
      events,
      core: {
        memberships: {
          async list(_c: unknown, a: { membershipIds?: readonly string[] } = {}) {
            probe.memberships.push({ ...a, ...(a.membershipIds ? { membershipIds: [...a.membershipIds] } : {}) });
            if (fx.coreFails) throw new LimsError('common.internal');
            return (a.membershipIds ?? []).map((id) => ({ membershipId: id, displayName: staffName(id), roleCodes: [], allCentres: true, isActive: true }));
          },
        },
        async user(_c: unknown, a: { userId: string }) { return { id: a.userId, displayName: `Synthetic User ${a.userId.slice(-6)}`, isActive: true }; },
      },
      audit: { access: (e: any) => access(ctx, e) },
      commitOnError: () => undefined,
    };
    return H[operationId]!(r, ctx);
  };
  try {
    const out = await (o.bypassRls ? superTx(run, who.tenant) : appTx(who.tenant, run));
    return { ...(out as any), probe };
  } catch (e) { if (e && typeof e === 'object') (e as any).probe = probe; throw e; }
}

// ---------------------------------------------------------------- the world of one review test
export interface ColSpec {
  /** default 'held' */
  status?: 'held' | 'applied' | 'discarded';
  /** hold code of a held collection (default homecollection.mutation_superseded) */
  hold?: string;
  /** 'camera' | 'hid' | 'manual' (default camera; barcode_verified = method != manual unless `verified` given) */
  method?: string; verified?: boolean;
  /** which specimen of the world (index into `specimens`, default = next unused one) */
  specimen?: number;
  /** extra columns of the collections row */
  extra?: Record<string, unknown>;
}
export interface WorldCol { row: any; mutation: any; specimen: SpecRef; flag?: any }
export interface HeldWorld {
  date: string; member: string; device: any; route: any; visit: any; order: any; patient: any; specimens: SpecRef[]; cols: WorldCol[];
  /** the first collection (default: held) */
  col: any; flag: any; specimen: SpecRef;
}
export interface WorldOpts { kind?: 'front_desk' | 'booking'; visitStatus?: string; specimens?: number; cols?: ColSpec[]; member?: string }
// per-run unique barcode (A-Z0-9, 17 chars): module-level counters restart in every spec file and files run in parallel on one DB.
const nextBarcode = () => `HC13${uid().replace(/-/g, '').slice(-12).toUpperCase()}A`;
/** collected_at (corrected) differs from collected_at_device (raw) so "the event carries the corrected value" is observable. */
export const COLLECTED_AT = '2028-05-31T04:10:00.000Z';
export const COLLECTED_AT_DEVICE = '2028-05-31T04:00:00.000Z';

export async function heldWorld(o: WorldOpts = {}): Promise<HeldWorld> {
  await ensureTaskRegistry();
  await seedReasons();
  await ensureSettings('a');
  const s = 'a' as const;
  const date = nextDay(FILE);
  const member = o.member ?? MEMBER.a;
  const route = await mkRoute(s, member, date);
  const sv = await seedVisit(s, { route, member, seq: 1, date, status: o.visitStatus ?? 'assigned',
    extra: { ...(o.kind === 'booking' ? { kind: 'booking', booking_id: uid(), orderable_ids: [uid()] } : {}) } });
  const specs: ColSpec[] = o.cols ?? [{}];
  const nSpec = Math.max(o.specimens ?? 0, specs.length, ...specs.map((c) => (c.specimen ?? -1) + 1));
  const specimens: SpecRef[] = [];
  for (let i = 0; i < nSpec; i++) {
    const row = { id: uid(), tenant_id: sv.order.tenant_id, centre_id: HC_CENTRE[s], order_id: sv.order.id, patient_id: sv.patient.id, barcode: nextBarcode(), creation_key: `hct13-${uid()}`,
      specimen_type_code: i % 2 ? 'EDTA' : 'SST', priority: 'routine', patient_sex: 'female', status: 'ordered', ordered_at: T0 };
    await seed('lab.specimens', row);
    specimens.push({ specimenId: row.id, barcode: row.barcode, orderId: sv.order.id, patientId: sv.patient.id, centreId: row.centre_id, specimenTypeCode: row.specimen_type_code, status: 'ordered', isActive: true, version: 1 });
  }
  specStore.set(sv.order.id, specimens);
  const device = await seedDevice(s, { membership_id: member });
  const held = specs.filter((c) => (c.status ?? 'held') === 'held').length;
  const batch = hc.syncBatch(s, device.id, { mutation_count: specs.length, applied_count: specs.length - held, held_count: held });
  await seed('homecollection.sync_batches', batch);
  const cols: WorldCol[] = [];
  let used = 0;
  for (const [i, c] of specs.entries()) {
    const status = c.status ?? 'held';
    const specimen = specimens[c.specimen ?? used++]!;
    const hold = c.hold ?? 'homecollection.mutation_superseded';
    const clientId = v7();
    const mutation = hc.mutation(s, device.id, batch.id, sv.row.id, { client_mutation_id: clientId, device_seq: i + 1, type: 'specimen.collected', membership_id: member,
      payload: { specimen_id: specimen.specimenId, scanned_barcode: specimen.barcode, scan_method: c.method ?? 'camera', specimen_type_code: specimen.specimenTypeCode, gps: { status: 'off' } },
      outcome: status === 'held' ? 'held' : 'applied', ...(status === 'held' ? { outcome_code: hold } : {}), captured_at_device: COLLECTED_AT_DEVICE, captured_at: COLLECTED_AT });
    await seed('homecollection.mutations', mutation);
    const method = c.method ?? 'camera';
    const row = hc.collection(s, { specimen: { id: specimen.specimenId }, order: sv.order }, sv.row.id, mutation.id, {
      client_mutation_id: clientId, collected_by_membership_id: member, scan_method: method, barcode_verified: c.verified ?? method !== 'manual', collected_at: COLLECTED_AT, collected_at_device: COLLECTED_AT_DEVICE,
      status, hold_code: status === 'held' ? hold : null,
      ...(status === 'discarded' ? { review_decision: 'discard', review_reason_code: 'duplicate_draw', reviewed_by: SYS_ACTOR, reviewed_at: T0 } : {}),
      ...(c.extra ?? {}) });
    await seed('homecollection.collections', row);
    let flag: any;
    if (status === 'held') { flag = hc.flag(s, sv.row.id, { kind: 'held_collection', related_id: row.id }); await seed('homecollection.visit_flags', flag); }
    cols.push({ row, mutation, specimen, ...(flag ? { flag } : {}) });
  }
  return { date, member, device, route, visit: sv.row, order: sv.order, patient: sv.patient, specimens, cols, col: cols[0]!.row, flag: cols[0]!.flag, specimen: cols[0]!.specimen };
}

// ---------------------------------------------------------------- calls
export const key = (): string => `t13-${uid().replace(/-/g, '').slice(0, 24)}`;
export interface Call { version?: number | string | null; idem?: string | null; who?: Who; fx?: Fx; bypassRls?: boolean }
/** `version` undefined = the collection's seeded version (1); null = no If-Match header; number = `"<n>"`; string = raw header value. */
export const review = (collectionId: string, body: unknown, c: Call = {}) => {
  const v = c.version === undefined ? 1 : c.version;
  const headers: Record<string, string> = { ...(v === null ? {} : { 'if-match': typeof v === 'number' ? `"${v}"` : v }), ...(c.idem === null ? {} : { 'idempotency-key': c.idem ?? key() }) };
  return op('reviewHeldCollection', req({ params: { collection_id: collectionId }, headers, body }), c.who ?? DISPATCHER, { ...(c.fx ? { fx: c.fx } : {}), ...(c.bypassRls ? { bypassRls: true } : {}) });
};
export const reviewFails = (collectionId: string, body: unknown, c: Call = {}) => rejection(review(collectionId, body, c));
export const APPLY = { decision: 'apply', reason_code: 'confirmed_with_phlebotomist' } as const;
export const DISCARD = { decision: 'discard', reason_code: 'duplicate_draw' } as const;

// ---------------------------------------------------------------- readers (owner role, RLS bypassed = DB truth)
export const colRow = async (id: string) => (await ownerRows('homecollection.collections', 'id = $1', [id]))[0];
export const colRowsOfVisit = (visitId: string) => ownerRows('homecollection.collections', 'visit_id = $1 ORDER BY created_at, id', [visitId]);
export const flagOf = async (collectionId: string) => (await ownerRows('homecollection.visit_flags', "related_id = $1 AND kind = 'held_collection'", [collectionId]))[0];
export const visitRow = async (id: string) => (await ownerRows('homecollection.visits', 'id = $1', [id]))[0];
export const eventsOfVisit = (w: HeldWorld, tenant: string = TENANT_A) => eventsOf(tenant, w.visit.id);
/** every column of the collections row that H9 must NOT touch */
export const identityCols = (r: any) => ({ id: r.id, visit_id: r.visit_id, specimen_id: r.specimen_id, order_id: r.order_id, mutation_id: r.mutation_id, client_mutation_id: r.client_mutation_id,
  collected_by_membership_id: r.collected_by_membership_id, scan_method: r.scan_method, barcode_verified: r.barcode_verified, collected_at: r.collected_at, collected_at_device: r.collected_at_device, hold_code: r.hold_code });
/** the whole row, for "nothing changed" comparisons */
export const frozen = (r: any) => JSON.stringify(r);
export { noonOf };
