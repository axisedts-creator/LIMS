// HC-T08 harness: H1 listHomeVisits, H2 getHomeVisit, H10 listHomeRoutes, H12 listEligiblePhlebotomists, H21 revealHomeVisitPhone (02-TRD §5.1/§5.3/§5.4, 07-SECURITY §4, REQ-SEC-081/096/097).
// Same convention as ../settings/helpers.ts (HC-T04): the handler under test is taken from the module manifest and driven with a request-shaped object + a HandlerContext over a REAL PG17 tx
// (lims_api, RLS on; `bypassRls` = superuser tx so only the repo's own explicit tenant_id filter can keep tenants apart). The core pipeline (schema validation, auth, x-permission) is NOT re-tested.
// ASSUMED ctx (02-TRD §6.4, as HC-T04/FD-T15): tenantId, tx, requestId, now(), centreId, actor{type,id,membershipId}, log, metrics, db.tx(fn), and
//   ports.IdentityPort  { assertRole(ctx,{permission,centreId?}) -> void | auth.forbidden ; getActor(ctx) -> { permissions: string[] , ... } }   (phlebotomist-only = holds sync.upload and NOT visit.assign; either source may be used)
//   ports.FrontdeskPort { getPatientDemographicsBatch(ctx,{patientIds,purpose}), getPatientDemographics(ctx,{patientId,purpose}), getOrderSummary(ctx,{orderId}) }   (FAKES below, record every call)
//   ports.BillingPort   { getOrderBalance(ctx,{orderId}) }
//   core.memberships.list(ctx,{membershipIds?,centreId?,permission?,roleCode?,activeOnly?}) -> [{membershipId,displayName,roleCodes,allCentres,isActive}]  (same shape as core-repo/index.ts; fake records every call)
//   core.user(ctx,{userId}) -> {id,displayName,isActive}      audit.access(entry) = the REAL core/audit/access.ts writer on ctx.tx (rows are read back from audit.access_log)
// Synthetic data only. Env: LIMS_TEST_APP_URL / LIMS_TEST_SUPER_URL, exported by tests/homecollection/HC-T08.pg.sh.
import { LimsError } from '../../../../core/errors.js';
import { access } from '../../../../core/audit/access.js';
import { rows as fdRows } from '../../../frontdesk/__tests__/integration/helpers.js';
import { manifest } from '../../index.js';
import { HC_CENTRE, MEMBER, MEMBER2, OTHER_CENTRE, TENANT_A, TENANT_B, SYS_ACTOR, appTx, hc, ownerRows, seed, seedWorld, superTx, uid, type Side, type World } from '../../repository/__tests__/helpers.js';
import { req, rejection, responseErrors, schemaErrors, spec, opOf } from '../settings/helpers.js';

export { HC_CENTRE, MEMBER, MEMBER2, OTHER_CENTRE, TENANT_A, TENANT_B, SYS_ACTOR, ownerRows, req, rejection, responseErrors, schemaErrors, spec, opOf, superTx, uid };
export const T = 120_000;
export const NOW = new Date('2026-11-10T06:00:00.000Z');
export const P = { read: 'homecollection.visit.read', assign: 'homecollection.visit.assign', sync: 'homecollection.sync.upload' } as const;

// ---- deterministic synthetic names / phones / registration numbers (what the fakes return; tests compare against these) ----
export const nameOf = (patientId: string): string => `Synthetic Patient ${patientId.slice(-8)}`;
export const phoneOf = (patientId: string): string => `+977980${String(parseInt(patientId.slice(-6), 16) % 1_000_000).padStart(6, '0')}`;
export const regOf = (orderId: string): string => `SYNREG-${orderId.slice(-6)}`;
export const staffName = (membershipId: string): string => `Synthetic Staff ${membershipId.slice(-6)}`;
export const userName = (userId: string): string => `Synthetic User ${userId.slice(-6)}`;

// ---- who calls ----
export interface Who { tenant: string; membershipId: string; grants: readonly string[] }
const mid = (side: 'a' | 'b', n: number) => `01a1a98a-ac40-7000-8000-00000000${side}${n}`;
/** front_desk / lab_manager dispatcher: visit.read + visit.assign. */
export const DISPATCHER: Who = { tenant: TENANT_A, membershipId: mid('a', 701), grants: [P.read, P.assign] };
export const DISPATCHER_B: Who = { tenant: TENANT_B, membershipId: mid('b', 701), grants: [P.read, P.assign] };
/** phlebotomist-only (role phlebotomist: visit.read + sync.upload), the actor of the AB9 probe. Their membership IS a seeded one, so visits can be assigned to them. */
export const PHLEBO: Who = { tenant: TENANT_A, membershipId: MEMBER.a, grants: [P.read, P.sync] };
export const PHLEBO2: Who = { tenant: TENANT_A, membershipId: MEMBER2.a, grants: [P.read, P.sync] };
export const NOBODY: Who = { tenant: TENANT_A, membershipId: mid('a', 799), grants: [] };
export const as = (w: Who, o: Partial<Who>): Who => ({ ...w, ...o });

// ---- fakes ----
export interface Fx {
  batchFails?: boolean; demoFails?: boolean; balanceFails?: boolean; orderSummaryFails?: boolean; coreFails?: boolean;
  /** patient ids the port "cannot see" (omitted from the batch / not_found on a single read) */
  omit?: readonly string[];
  /** patient ids that have no phone */
  noPhone?: readonly string[];
  /** roster served by core.memberships.list when no membershipIds filter is given (default: ROSTER) */
  roster?: readonly RosterEntry[];
}
export interface RosterEntry { membershipId: string; isActive: boolean; roleCodes: string[]; permissions: string[]; allCentres: boolean; centreIds: string[] }
/** Eligible-phlebotomist roster for H12: two seeded phlebotomists (tenant A, all centres) + three that must NOT be offered. */
export const NOT_ELIGIBLE = { inactive: mid('a', 610), noRole: mid('a', 611), otherCentre: mid('a', 612) } as const;
export const ROSTER: readonly RosterEntry[] = [
  { membershipId: MEMBER.a, isActive: true, roleCodes: ['phlebotomist'], permissions: [P.read, P.sync], allCentres: true, centreIds: [] },
  { membershipId: MEMBER2.a, isActive: true, roleCodes: ['phlebotomist'], permissions: [P.read, P.sync], allCentres: false, centreIds: [HC_CENTRE.a] },
  { membershipId: NOT_ELIGIBLE.inactive, isActive: false, roleCodes: ['phlebotomist'], permissions: [P.read, P.sync], allCentres: true, centreIds: [] },
  { membershipId: NOT_ELIGIBLE.noRole, isActive: true, roleCodes: ['front_desk'], permissions: [P.read, P.assign], allCentres: true, centreIds: [] },
  { membershipId: NOT_ELIGIBLE.otherCentre, isActive: true, roleCodes: ['phlebotomist'], permissions: [P.read, P.sync], allCentres: false, centreIds: [OTHER_CENTRE.a] },
];

export interface Probe {
  logs: string[]; requestId: string;
  identity: { calls: Array<{ permission: string; centreId?: string }> };
  batch: Array<{ patientIds: string[]; purpose: unknown }>; single: Array<{ patientId: string; purpose: unknown }>; orderSummary: string[]; balance: string[];
  memberships: Array<Record<string, unknown>>; users: string[];
}
export interface Reply { status: number; body: any; headers?: Record<string, string>; probe: Probe }
export interface OpOpts { bypassRls?: boolean; fx?: Fx }
const H = manifest.handlers as unknown as Record<string, (r: any, ctx: any) => Promise<{ status: number; body?: any; headers?: Record<string, string> }>>;
const notFound = () => new LimsError('common.not_found');

/** One request = one committed tx with `who.tenant`'s claims (RLS on unless `bypassRls`); a thrown error rolls the tx back (so does the access-log row). */
export async function op(operationId: string, r: ReturnType<typeof req>, who: Who, o: OpOpts = {}): Promise<Reply> {
  const side = who.tenant === TENANT_B ? 'b' : 'a';
  const fx = o.fx ?? {};
  const probe: Probe = { logs: [], requestId: uid(), identity: { calls: [] }, batch: [], single: [], orderSummary: [], balance: [], memberships: [], users: [] };
  const run = async (tx: any) => {
    const log = (lvl: string) => (obj: object, msg?: string) => { probe.logs.push(`${lvl} ${JSON.stringify(obj)} ${msg ?? ''}`); };
    const projectPatient = (id: string) => ({ patientId: id, fullName: nameOf(id), ...(fx.noPhone?.includes(id) ? {} : { phoneE164: phoneOf(id) }), status: 'active' });
    const ctx: any = {
      operationId, clientIp: '203.0.113.9', log: { info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') }, metrics: { inc: () => undefined },
      tenantId: who.tenant, tx, requestId: probe.requestId, now: () => NOW, centreId: HC_CENTRE[side],
      actor: { type: 'user', id: SYS_ACTOR, membershipId: who.membershipId },
      db: { tx: async (fn: (c: any) => Promise<unknown>) => fn(ctx) },
      ports: {
        IdentityPort: {
          async assertRole(_c: unknown, a: { permission: string; centreId?: string }) {
            probe.identity.calls.push({ permission: a?.permission, ...(a?.centreId ? { centreId: a.centreId } : {}) });
            if (!who.grants.includes(a?.permission)) throw new LimsError('auth.forbidden');
          },
          async getActor() {
            return { actor: { type: 'user', id: SYS_ACTOR, membershipId: who.membershipId }, displayName: 'Synthetic Caller', roles: [], permissions: [...who.grants],
              centreScope: { all: true, centreIds: [] }, branchIds: [], mfa: { enrolled: false, level: 'aal1' }, isLocked: false };
          },
          async getTenantSettings() { return { timezone: 'Asia/Kathmandu' }; },
        },
        FrontdeskPort: {
          async getPatientDemographicsBatch(_c: unknown, a: { patientIds: readonly string[]; purpose: unknown }) {
            probe.batch.push({ patientIds: [...a.patientIds], purpose: a.purpose });
            if (fx.batchFails) throw new LimsError('common.internal');
            if (a.purpose !== 'home_visit' || a.patientIds.length > 200) throw new LimsError('auth.forbidden');
            return a.patientIds.filter((id) => !fx.omit?.includes(id)).map(projectPatient);
          },
          async getPatientDemographics(_c: unknown, a: { patientId: string; purpose: unknown }) {
            probe.single.push({ patientId: a.patientId, purpose: a.purpose });
            if (fx.demoFails) throw new LimsError('auth.forbidden');
            if (a.purpose !== 'home_visit') throw new LimsError('auth.forbidden');
            if (fx.omit?.includes(a.patientId)) throw notFound();
            return projectPatient(a.patientId);
          },
          async getOrderSummary(_c: unknown, a: { orderId: string }) {
            probe.orderSummary.push(a.orderId);
            if (fx.orderSummaryFails) throw new LimsError('common.internal');
            return { orderId: a.orderId, registrationNo: regOf(a.orderId), status: 'registered', items: [], version: 1 };
          },
        },
        BillingPort: {
          async getOrderBalance(_c: unknown, a: { orderId: string }) {
            probe.balance.push(a.orderId);
            if (fx.balanceFails) throw new LimsError('common.internal');
            const m = (amount: number) => ({ amountPaisa: amount, currency: 'NPR' });
            return { orderId: a.orderId, invoiced: m(180000), paid: m(0), credited: m(0), balanceDue: m(180000), balanceVersion: 1, asOf: NOW.toISOString() };
          },
        },
      },
      core: {
        memberships: {
          async list(_c: unknown, a: { membershipIds?: readonly string[]; centreId?: string; permission?: string; roleCode?: string; activeOnly?: boolean; limit?: number } = {}) {
            probe.memberships.push({ ...a, ...(a.membershipIds ? { membershipIds: [...a.membershipIds] } : {}) });
            if (fx.coreFails) throw new LimsError('common.internal');
            if (a.membershipIds !== undefined && a.membershipIds.length > 200) throw new LimsError('common.validation_failed');
            const pool = a.membershipIds
              ? a.membershipIds.map((id) => (fx.roster ?? ROSTER).find((x) => x.membershipId === id) ?? { membershipId: id, isActive: true, roleCodes: [], permissions: [], allCentres: true, centreIds: [] })
              : (fx.roster ?? ROSTER);
            return pool
              .filter((x) => a.activeOnly === false || x.isActive)               // core-repo semantics: activeOnly defaults to true
              .filter((x) => a.centreId === undefined || x.allCentres || x.centreIds.includes(a.centreId))
              .filter((x) => a.roleCode === undefined || x.roleCodes.includes(a.roleCode))
              .filter((x) => a.permission === undefined || x.permissions.includes(a.permission))
              .map((x) => ({ membershipId: x.membershipId, displayName: staffName(x.membershipId), roleCodes: x.roleCodes, allCentres: x.allCentres, isActive: x.isActive }));
          },
        },
        async user(_c: unknown, a: { userId: string }) { probe.users.push(a.userId); return { id: a.userId, displayName: userName(a.userId), isActive: true }; },
      },
      audit: { access: (e: any) => access(ctx, e) },
      commitOnError: () => undefined,
    };
    return H[operationId]!(r, ctx);
  };
  try {
    const out = await (o.bypassRls ? superTx(run, who.tenant) : appTx(who.tenant, run));
    return { ...(out as any), probe };
  } catch (e) { if (e && typeof e === 'object') (e as any).probe = probe; throw e; }   // a rejection carries what the handler did before failing (ports called, checks made)
}
export const failure = async (p: Promise<unknown>): Promise<any> => rejection(p);

export const listVisits = (query: object, who: Who = DISPATCHER, o: OpOpts = {}) => op('listHomeVisits', req({ query }), who, o);
export const getVisit = (visitId: string, who: Who = DISPATCHER, o: OpOpts = {}) => op('getHomeVisit', req({ params: { visit_id: visitId } }), who, o);
export const listRoutes = (query: object, who: Who = DISPATCHER, o: OpOpts = {}) => op('listHomeRoutes', req({ query }), who, o);
export const listPhlebos = (query: object, who: Who = DISPATCHER, o: OpOpts = {}) => op('listEligiblePhlebotomists', req({ query }), who, o);
export const revealPhone = (visitId: string, who: Who = DISPATCHER, o: OpOpts = {}) => op('revealHomeVisitPhone', req({ params: { visit_id: visitId }, body: {} }), who, o);

/** audit.access_log rows written by one request (owner-side truth, no RLS). */
export const accessRows = (requestId: string) => ownerRows('audit.access_log', 'request_id = $1 ORDER BY created_at', [requestId]);
/** audit.access_log rows of `action` home_visit.view for a visit, by purpose. */
export const viewRows = (tenant: string, visitId: string, purpose?: string) =>
  ownerRows('audit.access_log', `tenant_id = $1 AND entity_id = $2 AND action = 'home_visit.view'${purpose ? ' AND purpose_code = $3' : ''}`, purpose ? [tenant, visitId, purpose] : [tenant, visitId]);

/** Every string value under keys containing "display" (and `display_name`) anywhere in a body. */
export function displayStrings(x: unknown, out: string[] = []): string[] {
  if (Array.isArray(x)) x.forEach((v) => displayStrings(v, out));
  else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { if (/display/.test(k) && typeof v === 'string') out.push(v); else displayStrings(v, out); }
  return out;
}

// ---- scenario (committed once per test file; synthetic) ----
export const LONG_ADDRESS = 'Ward 4, House 12, Synthetic Tole, Synthetic Municipality, Synthetic District, Synthetic Province, near the synthetic stupa';   // > 60 chars
export interface Scenario {
  /** route_date of this scenario: one per test file (routes are unique per centre+member+date and the files run in parallel on one DB) */
  date: string;
  w: World; wB: World;
  routeA1: any; routeA2: any;
  /** assigned to MEMBER.a (PHLEBO) on routeA1, sequence 1 / 2, windows 04:00 / 05:00 */
  assigned1: any; assigned2: any;
  /** completed on routeA1, sequence 3 (MEMBER.a) */
  done: any;
  /** assigned to MEMBER2.a (PHLEBO2) on routeA2 */
  assignedOther: any;
  /** unassigned visits (front desk visit with the open flag + a booking visit without an order) */
  unassigned: any; unassignedBooking: any;
  /** tenant B */
  assignedB: any; routeB: any;
  patients: Record<string, any>;
}
const times = (day: string, h: number) => ({ window_start: `${day}T${String(h).padStart(2, '0')}:00:00Z`, window_end: `${day}T${String(h).padStart(2, '0')}:30:00Z` });

async function extraVisit(s: Side, w: World, o: Record<string, unknown>): Promise<any> {
  const patient = fdRows.patient(s); await seed('frontdesk.patients', patient);
  const v = { ...hc.bookingVisit(s, { patient }, { order_id: w.order.id, address_text: LONG_ADDRESS, landmark: 'Opposite the synthetic bakery', note_for_phlebotomist: 'Synthetic gate code 0000', ...o }) };
  await seed('homecollection.visits', v);
  return { ...v, __patient: patient };
}
export async function buildScenario(date: string): Promise<Scenario> {
  const ROUTE_DATE = date;
  const w = await seedWorld('a'), wB = await seedWorld('b');
  const routeA1 = hc.route('a', { phlebotomist_membership_id: MEMBER.a, route_date: ROUTE_DATE }); await seed('homecollection.routes', routeA1);
  const routeA2 = hc.route('a', { phlebotomist_membership_id: MEMBER2.a, route_date: ROUTE_DATE }); await seed('homecollection.routes', routeA2);
  const assign = (route: any, member: string, seq: number, extra: Record<string, unknown>) => ({ status: 'assigned', route_id: route.id, route_date: ROUTE_DATE, route_sequence: seq, assigned_membership_id: member, assigned_at: '2027-02-28T10:00:00Z', ...extra });
  // created in reverse sequence order on purpose: visit_ids_in_order must follow route_sequence, not insertion order
  const done = await extraVisit('a', w, assign(routeA1, MEMBER.a, 3, { status: 'completed', outcome: 'collected', completed_at: `${date}T06:00:00Z`, ...times(ROUTE_DATE, 6) }));
  const assigned2 = await extraVisit('a', w, assign(routeA1, MEMBER.a, 2, times(ROUTE_DATE, 5)));
  const assigned1 = await extraVisit('a', w, assign(routeA1, MEMBER.a, 1, times(ROUTE_DATE, 4)));
  const assignedOther = await extraVisit('a', w, assign(routeA2, MEMBER2.a, 1, times(ROUTE_DATE, 7)));
  const routeB = hc.route('b', { phlebotomist_membership_id: MEMBER.b, route_date: ROUTE_DATE }); await seed('homecollection.routes', routeB);
  const assignedB = await extraVisit('b', wB, { status: 'assigned', route_id: routeB.id, route_date: ROUTE_DATE, route_sequence: 1, assigned_membership_id: MEMBER.b, assigned_at: '2027-02-28T10:00:00Z', ...times(ROUTE_DATE, 4) });
  const patients: Record<string, any> = {};
  for (const x of [w.patient, wB.patient, done, assigned1, assigned2, assignedOther, assignedB]) { const p = x.__patient ?? x; patients[p.id] = p; }
  return { date, w, wB, routeA1, routeA2, assigned1, assigned2, done, assignedOther, unassigned: w.visit, unassignedBooking: w.bookingVisit, assignedB, routeB, patients };
}

/** All of tenant A's / B's scenario visits (committed rows), for "nothing else is listed" assertions. */
export const tenantVisitIds = async (tenant: string): Promise<string[]> => (await ownerRows('homecollection.visits', 'tenant_id = $1', [tenant])).map((r) => r.id);
export const setMaxVisitsPerRoute = async (tenant: string, n: number) =>
  superTx(async (tx) => { await tx.query('UPDATE homecollection.settings SET max_visits_per_route = $2 WHERE tenant_id = $1', [tenant, n]); }, tenant);
/** Insert `n` further active visits (assigned) for `member` on `routeId`, in `centreId`, on ROUTE_DATE-like `date` (committed). */
export async function addActiveVisits(s: Side, w: World, o: { n: number; member: string; routeId: string; centreId: string; date: string; startSeq?: number }): Promise<void> {
  for (let i = 0; i < o.n; i++) {
    await extraVisit(s, w, { centre_id: o.centreId, status: 'assigned', route_id: o.routeId, route_date: o.date, route_sequence: (o.startSeq ?? 1) + i, assigned_membership_id: o.member, assigned_at: '2027-02-28T10:00:00Z' });
  }
}
export { hc, seed };
