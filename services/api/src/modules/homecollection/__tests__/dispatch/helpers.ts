// HC-T09 harness: dispatcher actions H3 assignHomeVisit, H4 unassignHomeVisit, H5 scheduleHomeVisit, H6 cancelHomeVisit, H7 createHomeRevisit, H8 resolveHomeVisitFlag, H11 resequenceHomeRoute
// (02-TRD §4.1 route version rule, §5.1, 01-PRD US-03/US-04/US-11-3/US-15, 07-SECURITY §4/§5, 08 A19 D-131/P-44).
// Same convention as ../visits/helpers.ts (HC-T08): the handler under test comes from the module manifest and is driven with a request-shaped object + a HandlerContext over a REAL PG17 tx
// (lims_api, RLS on). Additions over HC-T08, all ASSUMED from 02-TRD §6.4 / §7 / 03-INTERFACE-CATALOG:
//   ports.FrontdeskPort.createOrderFromBooking(ctx, BookingOrderInput) -> { orderId, registrationNo, status, replayed }   FAKE below: records every input, returns an EXISTING frontdesk order id (FK), can throw any code
//   ports.FrontdeskPort.getOrderSummary(ctx,{orderId}) -> { status }     (H7 "the parent's order is cancelled")
//   ports.LabPort.lookupSpecimens(ctx,{orderId,...}) -> []                (read-model refresh after the order exists; never asserted, only tolerated)
//   ports.NotificationPort.sendSms(ctx, {...})                            (P-44: called inside ctx.db.tx(...) = a SAVEPOINT; this harness makes db.tx a real savepoint)
// Headers arrive lower-cased: `if-match: "<version>"` (quoted, as settings.service.ts parses it) and `idempotency-key`. The core pipeline's own Idempotency-Key handling is exercised through core/idempotency.ts
// exactly like frontdesk/__tests__/integration/registration.billing-real.test.ts does (`viaPipeline`). Synthetic data only. Env: LIMS_TEST_APP_URL / LIMS_TEST_SUPER_URL (tests/homecollection/HC-T09.pg.sh).
import { LimsError } from '../../../../core/errors.js';
import { createIdempotency } from '../../../../core/idempotency.js';
import { rows as fdRows } from '../../../frontdesk/__tests__/integration/helpers.js';
import { manifest } from '../../index.js';
import { appTx, seedWorld as seedBaseWorld, type World } from '../../repository/__tests__/helpers.js';
import { DISPATCHER, DISPATCHER_B, HC_CENTRE, LONG_ADDRESS, MEMBER, MEMBER2, NOBODY, NOT_ELIGIBLE, NOW, OTHER_CENTRE, P, PHLEBO, ROSTER, SYS_ACTOR, T, TENANT_A, TENANT_B, addActiveVisits, as,
  failure, hc, nameOf, ownerRows, phoneOf, req, responseErrors, schemaErrors, seed, spec, staffName, superTx, uid, userName, type Fx, type Who } from '../visits/helpers.js';

export { DISPATCHER, DISPATCHER_B, HC_CENTRE, LONG_ADDRESS, MEMBER, MEMBER2, NOBODY, NOT_ELIGIBLE, NOW, OTHER_CENTRE, P, PHLEBO, ROSTER, SYS_ACTOR, T, TENANT_A, TENANT_B, addActiveVisits, as, failure, hc, ownerRows,
  req, responseErrors, schemaErrors, seed, spec, staffName, superTx, uid, type Who, type World };

// ---- fakes ----
export interface DFx extends Fx {
  /** code thrown by FrontdeskPort.createOrderFromBooking (any registered code, e.g. catalog.no_price) */
  orderError?: string;
  /** an EXISTING frontdesk.orders id that the port "creates" (visits.order_id is an FK) */
  orderId?: string;
  /** C4 idempotent replay flag */
  replayed?: boolean;
  /** status served by FrontdeskPort.getOrderSummary (default 'registered') */
  orderStatus?: string;
  /** NotificationPort.sendSms: 'ok' | 'throw' (a LimsError) | 'sql' (a failing SQL statement on the request tx: poisons the tx unless a SAVEPOINT absorbs it) */
  sms?: 'ok' | 'throw' | 'sql';
}
export interface DProbe {
  logs: string[]; requestId: string;
  identity: Array<{ permission: string; centreId?: string }>;
  /** every createOrderFromBooking input + whether ctx.tx was the request tx */
  createOrder: Array<{ input: any; sameTx: boolean }>;
  sms: any[]; orderSummary: string[]; lab: any[]; memberships: Array<Record<string, unknown>>;
  /** number of ctx.db.tx(...) savepoints opened */
  savepoints: number;
}
export interface DReply { status: number; body: any; headers?: Record<string, string>; probe: DProbe }
export interface DOpts { bypassRls?: boolean; fx?: DFx }
const H = manifest.handlers as unknown as Record<string, (r: any, ctx: any) => Promise<{ status: number; body?: any; headers?: Record<string, string> }>>;

/** One request = one committed tx with `who.tenant`'s claims (RLS on unless `bypassRls`); a thrown error rolls the tx back. A rejection carries `.probe`. */
export async function dop(operationId: string, r: ReturnType<typeof req>, who: Who, o: DOpts = {}): Promise<DReply> {
  const side = who.tenant === TENANT_B ? 'b' : 'a';
  const fx = o.fx ?? {};
  const probe: DProbe = { logs: [], requestId: uid(), identity: [], createOrder: [], sms: [], orderSummary: [], lab: [], memberships: [], savepoints: 0 };
  const run = async (tx: any) => {
    const log = (lvl: string) => (obj: object, msg?: string) => { probe.logs.push(`${lvl} ${JSON.stringify(obj)} ${msg ?? ''}`); };
    const projectPatient = (id: string) => ({ patientId: id, fullName: nameOf(id), phoneE164: phoneOf(id), status: 'active' });
    let sp = 0;
    const ctx: any = {
      operationId, clientIp: '203.0.113.9', log: { info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') }, metrics: { inc: () => undefined },
      tenantId: who.tenant, tx, requestId: probe.requestId, now: () => NOW, centreId: HC_CENTRE[side],
      actor: { type: 'user', id: SYS_ACTOR, membershipId: who.membershipId },
      // P-44: ctx.db.tx(fn) inside a request is a SAVEPOINT (released on success, rolled back to on error, error re-thrown)
      db: {
        tx: async (fn: (c: any) => Promise<unknown>) => {
          const name = `hc_t09_sp_${++sp}`; probe.savepoints++;
          await tx.query(`SAVEPOINT ${name}`);
          try { const out = await fn(ctx); await tx.query(`RELEASE SAVEPOINT ${name}`); return out; }
          catch (e) { await tx.query(`ROLLBACK TO SAVEPOINT ${name}`); throw e; }
        },
      },
      ports: {
        IdentityPort: {
          async assertRole(_c: unknown, a: { permission: string; centreId?: string }) {
            probe.identity.push({ permission: a?.permission, ...(a?.centreId ? { centreId: a.centreId } : {}) });
            if (!who.grants.includes(a?.permission)) throw new LimsError('auth.forbidden');
          },
          async getActor() {
            return { actor: { type: 'user', id: SYS_ACTOR, membershipId: who.membershipId }, displayName: 'Synthetic Caller', roles: [], permissions: [...who.grants],
              centreScope: { all: true, centreIds: [] }, branchIds: [], mfa: { enrolled: false, level: 'aal1' }, isLocked: false };
          },
          async getTenantSettings() { return { timezone: 'Asia/Kathmandu' }; },
        },
        FrontdeskPort: {
          async createOrderFromBooking(c: any, a: any) {
            probe.createOrder.push({ input: JSON.parse(JSON.stringify(a)), sameTx: c?.tx === tx });
            if (fx.orderError) throw new LimsError(fx.orderError);
            if (!fx.orderId) throw new Error('test setup: DFx.orderId is required when the port is expected to succeed');
            return { orderId: fx.orderId, registrationNo: `SYNREG-${fx.orderId.slice(-6)}`, status: 'registered', replayed: fx.replayed === true };
          },
          async getPatientDemographicsBatch(_c: unknown, a: { patientIds: readonly string[]; purpose: unknown }) {
            if (a.purpose !== 'home_visit') throw new LimsError('auth.forbidden');
            return a.patientIds.map(projectPatient);
          },
          async getPatientDemographics(_c: unknown, a: { patientId: string; purpose: unknown }) {
            if (a.purpose !== 'home_visit') throw new LimsError('auth.forbidden');
            return projectPatient(a.patientId);
          },
          async getOrderSummary(_c: unknown, a: { orderId: string }) {
            probe.orderSummary.push(a.orderId);
            return { orderId: a.orderId, registrationNo: `SYNREG-${a.orderId.slice(-6)}`, status: fx.orderStatus ?? 'registered', items: [], version: 1 };
          },
        },
        LabPort: { async lookupSpecimens(_c: unknown, a: unknown) { probe.lab.push(a); return []; } },
        BillingPort: { async getOrderBalance(_c: unknown, a: { orderId: string }) { const m = (n: number) => ({ amountPaisa: n, currency: 'NPR' }); return { orderId: a.orderId, invoiced: m(0), paid: m(0), credited: m(0), balanceDue: m(0), balanceVersion: 1, asOf: NOW.toISOString() }; } },
        NotificationPort: {
          async sendSms(_c: unknown, a: any) {
            probe.sms.push(JSON.parse(JSON.stringify(a)));
            if (fx.sms === 'throw') throw new LimsError('common.internal');
            if (fx.sms === 'sql') await tx.query('SELECT 1/0');
            return { notificationId: uid(), status: 'suppressed_no_contact' };
          },
        },
      },
      core: {
        memberships: {
          async list(_c: unknown, a: { membershipIds?: readonly string[]; centreId?: string; permission?: string; roleCode?: string; activeOnly?: boolean } = {}) {
            probe.memberships.push({ ...a, ...(a.membershipIds ? { membershipIds: [...a.membershipIds] } : {}) });
            const roster = fx.roster ?? ROSTER;
            const pool = a.membershipIds
              ? a.membershipIds.map((id) => roster.find((x) => x.membershipId === id) ?? { membershipId: id, isActive: true, roleCodes: [], permissions: [], allCentres: true, centreIds: [] })
              : roster;
            return pool
              .filter((x) => a.activeOnly === false || x.isActive)
              .filter((x) => a.centreId === undefined || x.allCentres || x.centreIds.includes(a.centreId))
              .filter((x) => a.roleCode === undefined || x.roleCodes.includes(a.roleCode))
              .filter((x) => a.permission === undefined || x.permissions.includes(a.permission))
              .map((x) => ({ membershipId: x.membershipId, displayName: staffName(x.membershipId), roleCodes: x.roleCodes, allCentres: x.allCentres, isActive: x.isActive }));
          },
        },
        async user(_c: unknown, a: { userId: string }) { return { id: a.userId, displayName: userName(a.userId), isActive: true }; },
      },
      audit: { access: () => undefined },
      commitOnError: () => undefined,
    };
    return H[operationId]!(r, ctx);
  };
  try {
    const out = await (o.bypassRls ? superTx(run, who.tenant) : appTx(who.tenant, run));
    return { ...(out as any), probe };
  } catch (e) { if (e && typeof e === 'object') (e as any).probe = probe; throw e; }
}

// ---- request builders ----
export const key = (): string => `t09-${uid().replace(/-/g, '').slice(0, 24)}`;
export const hdr = (version: number, idem: string | null = key()) => ({ 'if-match': `"${version}"`, ...(idem === null ? {} : { 'idempotency-key': idem }) });
export interface Act { visitId: string; body: unknown; version: number; idem?: string | null; who?: Who; fx?: DFx; bypassRls?: boolean }
const act = (operationId: string, a: Act) => dop(operationId, req({ params: { visit_id: a.visitId }, headers: hdr(a.version, a.idem), body: a.body }), a.who ?? DISPATCHER, { ...(a.fx ? { fx: a.fx } : {}), ...(a.bypassRls ? { bypassRls: true } : {}) });
export const assign = (a: Act) => act('assignHomeVisit', a);
export const unassign = (a: Act) => act('unassignHomeVisit', a);
export const schedule = (a: Act) => act('scheduleHomeVisit', a);
export const cancel = (a: Act) => act('cancelHomeVisit', a);
export const revisit = (a: Act) => act('createHomeRevisit', a);
export const resolveFlag = (a: Act & { flagId: string }) =>
  dop('resolveHomeVisitFlag', req({ params: { visit_id: a.visitId, flag_id: a.flagId }, headers: hdr(a.version, a.idem), body: a.body }), a.who ?? DISPATCHER, { ...(a.fx ? { fx: a.fx } : {}) });
export const resequence = (o: { routeId: string; visitIds: unknown; version: number; who?: Who; fx?: DFx; headers?: object }) =>
  dop('resequenceHomeRoute', req({ params: { route_id: o.routeId }, headers: o.headers ?? hdr(o.version, null), body: { visit_ids: o.visitIds } }), o.who ?? DISPATCHER, { ...(o.fx ? { fx: o.fx } : {}) });

// ---- the core pipeline around a handler (stage 6 begin -> handler + stage 10 finish -> stage 11 release), as FD's J-T01 `viaPipeline` ----
export async function viaPipeline(operationId: string, a: Act & { routeTemplate: string }, tenant = TENANT_A) {
  const claims = { sub: SYS_ACTOR, tenant_id: tenant };
  const db: any = { requestTx: async (_in: unknown, fn: (tx: any) => Promise<unknown>) => appTx(tenant, fn) };
  const idem = createIdempotency({ db });
  const idempotencyKey = a.idem ?? key();
  const operation = { module: 'homecollection', operationId, context: 'tenant', idempotency: 'required' } as const;
  const begun = await idem.begin({ operation, method: 'POST', routeTemplate: a.routeTemplate, pathParams: { visit_id: a.visitId }, body: a.body, idempotencyKey, claims: claims as never, requestId: uid(), clientIp: '203.0.113.9' });
  if (begun.action === 'replay') return { replay: true as const, status: begun.status, body: begun.body, headers: begun.headers, probe: undefined as DProbe | undefined };
  if (begun.action !== 'proceed') throw new Error('unexpected skip');
  try {
    let probe: DProbe | undefined;
    const out = await (async () => {
      const r = await dop(operationId, req({ params: { visit_id: a.visitId }, headers: hdr(a.version, idempotencyKey), body: a.body }), a.who ?? DISPATCHER, { ...(a.fx ? { fx: a.fx } : {}) });
      probe = r.probe;
      await appTx(tenant, async (tx) => { await idem.finish(tx, begun.handle, { status: r.status, body: r.body }); });
      return r;
    })();
    return { replay: false as const, status: out.status, body: out.body, headers: undefined, probe };
  } catch (e) { await idem.release(begun.handle); throw e; }
}

// ---- committed DB truth (owner-side, no RLS) ----
export const q = (sql: string, params: unknown[] = [], tenant: string = TENANT_A): Promise<any[]> => superTx(async (tx: any) => (await tx.query(sql, params)).rows, tenant);
const VISIT_COLS = `id, version, kind, status, outcome, centre_id, branch_id, patient_id, order_id, booking_id, parent_visit_id, orderable_ids, referrer_id, address_text, landmark, latitude::text AS latitude, longitude::text AS longitude,
  note_for_phlebotomist, window_start, window_end, route_id, route_date::text AS route_date, route_sequence, assigned_membership_id, status_reason_code, status_reason_text, order_registered_at`;
export const visitRow = async (id: string, tenant: string = TENANT_A): Promise<any> => (await q(`SELECT ${VISIT_COLS} FROM homecollection.visits WHERE id = $1`, [id], tenant))[0];
export const routeRow = async (id: string, tenant: string = TENANT_A): Promise<any> => (await q('SELECT id, version, centre_id, phlebotomist_membership_id, route_date::text AS route_date FROM homecollection.routes WHERE id = $1', [id], tenant))[0];
export const routesOf = (member: string, date: string, tenant: string = TENANT_A) =>
  q('SELECT id, version, centre_id, route_date::text AS route_date FROM homecollection.routes WHERE tenant_id = $1 AND phlebotomist_membership_id = $2 AND route_date = $3 ORDER BY centre_id', [tenant, member, date], tenant);
export const assignmentsOf = (visitId: string, tenant: string = TENANT_A) =>
  q('SELECT action, membership_id, route_id, route_date::text AS route_date, reason_code FROM homecollection.visit_assignments WHERE visit_id = $1 ORDER BY created_at, id', [visitId], tenant);
export const transitionsOf = (visitId: string, tenant: string = TENANT_A) =>
  q('SELECT from_status, to_status, cause, reason_code, reason_text FROM homecollection.visit_transitions WHERE visit_id = $1 ORDER BY at, created_at, id', [visitId], tenant);
export const flagsOf = (visitId: string, tenant: string = TENANT_A) =>
  q('SELECT id, version, kind, status, resolution_code, resolution_note, resolved_at FROM homecollection.visit_flags WHERE visit_id = $1 ORDER BY created_at, id', [visitId], tenant);
export const visitsOnRoute = (routeId: string, tenant: string = TENANT_A) =>
  q('SELECT id, status, route_sequence FROM homecollection.visits WHERE route_id = $1 ORDER BY route_sequence', [routeId], tenant);
export const sameInstant = (a: unknown, b: unknown): boolean => new Date(a as string).getTime() === new Date(b as string).getTime();

// ---- fixtures (committed; every test builds its own rows, dates are unique per test file / per test: routes are unique per (centre, member, date) and files run in parallel on one DB) ----
export const day = (base: string, n: number): string => new Date(Date.parse(`${base}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const winOf = (date: string, hour = 4, minutes = 30) => ({ window_start: `${date}T${String(hour).padStart(2, '0')}:00:00Z`, window_end: `${date}T${String(hour).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00Z` });

let registryDone = false;
/** HC-T09 ruling: app.enqueue_job raises unknown_task_identifier for ids absent from core.g_task_registry (C0 05-SCHEMA:1060); registry-sync fills it at deploy (C0 05-SCHEMA:1783), the HC-T03 boot does not.
 *  Test-DB fixture only (02-TRD:514: max attempts 10). Superuser, idempotent. Pattern: frontdesk/__tests__/registration/helpers.ts ensureTaskRegistry. */
export async function ensureTaskRegistry(): Promise<void> {
  if (registryDone) return;
  await superTx(async (tx: any) => { await tx.query(
    `INSERT INTO core.g_task_registry (identifier,module,kind,scope,max_attempts) VALUES ('homecollection.refresh_visit_specimens','homecollection','task','per_tenant',10) ON CONFLICT DO NOTHING`); });
  registryDone = true;
}
type Side = 'a' | 'b';
export const seedWorld = async (s: Side = 'a'): Promise<World> => { await ensureTaskRegistry(); return seedBaseWorld(s); };
export const worldOf =(s: Side = 'a'): Promise<World> => seedWorld(s);
/** A fresh frontdesk order (FK target of visits.order_id / what the FrontdeskPort fake returns). */
export async function newOrder(s: Side = 'a', patientId?: string): Promise<any> {
  const patient = patientId ? { id: patientId } : fdRows.patient(s);
  if (!patientId) await seed('frontdesk.patients', patient);
  const order = fdRows.order(s, patient.id, { centre_id: HC_CENTRE[s], collection_mode: 'home' });
  await seed('frontdesk.orders', order);
  return order;
}
/** An unassigned booking visit (no order), complete by default (window + address); pass `null` for a field to leave it empty. */
export async function bookingVisit(o: Record<string, unknown> = {}, s: Side = 'a', date = '2027-04-01'): Promise<any> {
  const patient = fdRows.patient(s); await seed('frontdesk.patients', patient);
  const v = hc.bookingVisit(s, { patient }, { address_text: LONG_ADDRESS, landmark: 'Opposite the synthetic bakery', ...winOf(date), ...o });
  for (const k of Object.keys(v)) if ((v as any)[k] === null) delete (v as any)[k];
  await seed('homecollection.visits', v);
  return { ...v, version: (await visitRow(v.id, s === 'b' ? TENANT_B : TENANT_A)).version };
}
/** An unassigned front-desk visit with its order (complete by default). */
export async function frontDeskVisit(o: Record<string, unknown> = {}, s: Side = 'a', date = '2027-04-01'): Promise<any> {
  const patient = fdRows.patient(s); await seed('frontdesk.patients', patient);
  const order = fdRows.order(s, patient.id, { centre_id: HC_CENTRE[s], collection_mode: 'home' }); await seed('frontdesk.orders', order);
  const v = hc.visit(s, { patient, order }, { ...winOf(date), ...o });
  for (const k of Object.keys(v)) if ((v as any)[k] === null) delete (v as any)[k];
  await seed('homecollection.visits', v);
  return { ...v, version: (await visitRow(v.id, s === 'b' ? TENANT_B : TENANT_A)).version };
}
export const routeFor = async (member: string, date: string, centreId: string = HC_CENTRE.a, s: Side = 'a'): Promise<any> => {
  const r = hc.route(s, { phlebotomist_membership_id: member, route_date: date, centre_id: centreId }); await seed('homecollection.routes', r); return r;
};
export interface AssignedOpts { member?: string; date: string; seq?: number; route?: any; status?: string; extra?: Record<string, unknown> }
/** A visit in status assigned/in_progress/completed/... on `route` (created when not given), with its order. Returns { visit, route }. */
export async function assignedVisit(o: AssignedOpts, s: Side = 'a'): Promise<{ visit: any; route: any }> {
  const member = o.member ?? (s === 'b' ? MEMBER.b : MEMBER.a);
  const route = o.route ?? (await routeFor(member, o.date, HC_CENTRE[s], s));
  const status = o.status ?? 'assigned';
  const lifecycle: Record<string, unknown> =
    status === 'completed' ? { outcome: 'collected', completed_at: `${o.date}T06:00:00Z` }
      : status === 'failed' ? { outcome: 'none', failed_at: `${o.date}T06:00:00Z`, status_reason_code: 'patient_refused' }
        : status === 'in_progress' ? { arrived_at: `${o.date}T05:00:00Z` }
          : status === 'cancelled' ? { cancelled_at: `${o.date}T05:00:00Z`, status_reason_code: 'patient_request' } : {};
  const order = await newOrder(s);
  const patient = { id: order.patient_id };
  const v = hc.bookingVisit(s, { patient }, { order_id: order.id, address_text: LONG_ADDRESS, ...winOf(o.date), status, route_id: route.id, route_date: o.date, route_sequence: o.seq ?? 1, assigned_membership_id: member,
    assigned_at: '2027-02-28T10:00:00Z', ...lifecycle, ...(o.extra ?? {}) });
  await seed('homecollection.visits', v);
  return { visit: { ...v, version: (await visitRow(v.id, s === 'b' ? TENANT_B : TENANT_A)).version }, route };
}
export const openFlag = async (visitId: string, kind: string, s: Side = 'a', o: Record<string, unknown> = {}): Promise<any> => {
  const f = hc.flag(s, visitId, { kind, ...o }); await seed('homecollection.visit_flags', f);
  return { ...f, version: (await flagsOf(visitId, s === 'b' ? TENANT_B : TENANT_A)).find((x) => x.id === f.id).version };
};

export const phone = (id: string) => phoneOf(id);
export { fdRows, T as TIMEOUT };
export const rejectedWith = async (p: Promise<unknown>, code: string): Promise<any> => {
  const e = await failure(p);
  if (e?.code !== code) throw new Error(`expected ${code}, got ${e?.code ?? String(e)}`);
  return e;
};
export const hasPointer = (e: any, pointer: string): boolean => Array.isArray(e?.errors) && e.errors.some((x: any) => x.path === pointer);
