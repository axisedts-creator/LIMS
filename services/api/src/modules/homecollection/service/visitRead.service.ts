// HC-T08: read endpoints H1 listHomeVisits, H2 getHomeVisit, H10 listHomeRoutes, H12 listEligiblePhlebotomists (02-TRD §5, §5.3.1, §5.4, §14) + the helpers H21 shares.
// SQL lives in repository/*.repo.ts only. §5.4: rule 1 = load through the RLS repo (404) then IdentityPort.assertRole(centre of the visit); rule 2 = phlebotomist-only actor
// (holds sync.upload, not visit.assign) sees / reads only visits assigned to them. REQ-SEC-081 allowlists: patient name, address, registration_no, balance only for visit.assign holders or the
// visit's assignee. Names: patients via ONE FrontdeskPort batch per page (§2.1 failure -> "—"), staff via ctx.core.memberships.list (P-17, one batched call), actors via ctx.core.user.
// Messages and logs carry codes only: no patient data is ever logged (07 §6).
import { LimsError, type FieldError } from '../../../core/errors.js';
import { loadHomecollectionConfig } from '../config.js';
import { toEligibleDto, toRouteDto, toVisitDetailDto, toVisitSummaryDto, type Names } from '../mappers/visit.mapper.js';
import { HOMECOLLECTION_PERMISSIONS } from '../permissions.js';
import { listAssignmentsByVisit } from '../repository/visitAssignments.repo.js';
import { listVisitFlagsByVisit } from '../repository/visitFlags.repo.js';
import { listTransitionsByVisit } from '../repository/visitTransitions.repo.js';
import { listVisitSpecimensByVisit } from '../repository/visitSpecimens.repo.js';
import { getRouteById } from '../repository/routes.repo.js';
import { getSettings } from '../repository/settings.repo.js';
import type { Tx } from '../repository/shared.repo.js';
import { getVisitById } from '../repository/visits.repo.js';
import { SORTS, listActiveLoadByMembers, listCollectionsByVisit, listRoutesOfDay, listVisitsPage, type SortCode } from '../repository/visitQueries.repo.js';

const [PERM_VISIT_READ, PERM_VISIT_ASSIGN, , , , PERM_SYNC_UPLOAD] = HOMECOLLECTION_PERMISSIONS;   // 'homecollection.visit.read' / '.visit.assign' / '.sync.upload'
type Obj = Record<string, any>;
export type Result = { status: number; body: unknown };
export interface AccessEntry { action: string; entityType: string; entityId?: string; centreId?: string; purpose?: string; outcome: 'allowed' | 'denied' }
export interface Ctx {
  readonly tenantId: string; readonly tx: Tx; readonly actor: { readonly id: string; readonly membershipId?: string };
  readonly db: { tx<T>(fn: (c: any) => Promise<T>): Promise<T> };
  readonly log: { warn(o: object, m?: string): void };
  readonly ports: {
    readonly IdentityPort: { assertRole(ctx: unknown, r: { permission: string; centreId?: string }): Promise<void>; getActor(ctx: unknown): Promise<{ permissions: readonly string[] }> };
    readonly FrontdeskPort: Obj; readonly BillingPort: Obj;
  };
  readonly core: { readonly memberships: { list(ctx: unknown, i: Obj): Promise<ReadonlyArray<{ membershipId: string; displayName: string }>> }; user(ctx: unknown, i: { userId: string }): Promise<{ displayName: string }> };
  readonly audit: { access(e: AccessEntry): Promise<void> };
}

export function ctxOf(c: unknown): Ctx {
  const x = c as Partial<Ctx> | null;
  if (typeof x?.tenantId !== 'string' || !x.tx || typeof x.actor?.id !== 'string' || !x.ports?.IdentityPort || !x.db || !x.core?.memberships || !x.audit) throw new LimsError('auth.unauthenticated');   // fail closed
  return x as Ctx;
}

// ---- validation (fixed messages: no submitted value is echoed) ----
const bad = (path: string): LimsError => new LimsError('common.validation_failed', undefined, [{ path, code: 'common.field_invalid', message: 'Field invalid' } as FieldError]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
export const uuidParam = (v: unknown, path: string): string => { if (typeof v !== 'string' || !UUID.test(v)) throw bad(path); return v; };
const optUuid = (q: Obj, k: string): string | undefined => (q[k] === undefined ? undefined : uuidParam(q[k], `/${k}`));
const isoDate = (v: unknown, path: string): string => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) throw bad(path);
  return v;
};
const optDate = (q: Obj, k: string): string | undefined => (q[k] === undefined ? undefined : isoDate(q[k], `/${k}`));
const isoUtc = (v: unknown, path: string): string => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) || Number.isNaN(Date.parse(v)) || new Date(v).toISOString() !== v) throw bad(path);
  return v;
};
const bool = (v: unknown, path: string): boolean | undefined => {
  if (v === undefined) return undefined;
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  throw bad(path);
};
const STATUSES = ['unassigned', 'assigned', 'in_progress', 'completed', 'failed', 'cancelled'];
const KINDS = ['booking', 'front_desk', 'recollection', 'revisit'];
const csv = (v: unknown, allowed: readonly string[], path: string): string[] | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length > 120 || !/^[a-z_]+(,[a-z_]+)*$/.test(v)) throw bad(path);
  const parts = [...new Set(v.split(','))];
  if (!parts.every((x) => allowed.includes(x))) throw bad(path);
  return parts;
};
const limitOf = (v: unknown): number => {
  if (v === undefined) return 50;
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^[0-9]{1,3}$/.test(v) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 200) throw bad('/limit');
  return n;
};
const dedupe = (xs: ReadonlyArray<string | null | undefined>): string[] => [...new Set(xs.filter((x): x is string => typeof x === 'string' && x !== ''))];

// ---- cursor: base64url(JSON{v:1, s: sort, k: sort key, i: id}); carries no authority (02-CV §4.3); anything malformed -> common.invalid_cursor ----
const TS_KEY = /^(infinity|\d{4,}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?)$/;
const invalidCursor = (): LimsError => new LimsError('common.invalid_cursor');
const encodeCursor = (sort: SortCode, key: string, id: string): string => Buffer.from(JSON.stringify({ v: 1, s: sort, k: key, i: id })).toString('base64url');
function decodeCursor(raw: unknown, sort: SortCode): { key: string; id: string } {
  if (typeof raw !== 'string' || raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw invalidCursor();
  let o: unknown;
  try { o = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { throw invalidCursor(); }
  if (!isObj(o) || o['v'] !== 1 || o['s'] !== sort || typeof o['k'] !== 'string' || typeof o['i'] !== 'string' || !UUID.test(o['i'])) throw invalidCursor();
  const ok = SORTS[sort].kind === 'ts' ? TS_KEY.test(o['k']) : /^[0-9]{1,10}$/.test(o['k']) && Number(o['k']) <= 2147483647;
  if (!ok) throw invalidCursor();
  return { key: o['k'], id: o['i'] };
}

// ---- who is calling ----
export interface Caller { readonly membershipId: string | undefined; readonly holdsAssign: boolean; readonly phleboOnly: boolean }
/** §5.4 rule 2: phlebotomist-only = holds sync.upload and NOT visit.assign. */
export async function callerOf(c: Ctx): Promise<Caller> {
  const perms = (await c.ports.IdentityPort.getActor(c)).permissions;
  const holdsAssign = perms.includes(PERM_VISIT_ASSIGN);
  return { membershipId: c.actor.membershipId, holdsAssign, phleboOnly: perms.includes(PERM_SYNC_UPLOAD) && !holdsAssign };
}
/** REQ-SEC-081: patient name / address / registration_no / balance only for visit.assign holders or the visit's current assignee. */
const mayAccessPii = (who: Caller, visit: Obj): boolean => who.holdsAssign || (who.membershipId !== undefined && visit['assigned_membership_id'] === who.membershipId);
const code = (e: unknown): string => (typeof (e as Obj)?.['code'] === 'string' ? (e as Obj)['code'] : 'unknown');

// ---- names (every lookup that may fail runs in ctx.db.tx = savepoint, 08 A19 P-44) ----
export async function staffNames(ctx: Ctx, ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 200) {                                                     // core caps one call at 200 ids; a page / visit never needs a second
    try {
      const rows = await ctx.db.tx((x) => ctx.core.memberships.list(x, { membershipIds: ids.slice(i, i + 200), activeOnly: false }));   // activeOnly:false: ex-staff keep their name
      for (const r of rows) if (typeof r.displayName === 'string' && r.displayName) out.set(r.membershipId, r.displayName);
    } catch (e) { ctx.log.warn({ code: code(e) }, 'homecollection.staff_names_unavailable'); }
  }
  return out;
}
/** H12 roster: active memberships of the centre holding the phlebotomist role (the C17 definition of "phlebotomist"); a failure propagates (nothing to show without it). */
const rosterOf = (ctx: Ctx, centreId: string) => ctx.db.tx((x) => ctx.core.memberships.list(x, { centreId, roleCode: 'phlebotomist' }));
export async function userNames(c: Ctx, ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const userId of ids) {
    try { const u = await c.db.tx((x) => c.core.user(x, { userId })); if (u?.displayName) out.set(userId, u.displayName); }
    catch (e) { c.log.warn({ code: code(e) }, 'homecollection.user_name_unavailable'); }
  }
  return out;
}

// ---- H1 ----
export async function listHomeVisits(hctx: unknown, query: unknown): Promise<Result> {
  const c = ctxOf(hctx);
  const q: Obj = isObj(query) ? query : {};
  const sort = (q['sort'] === undefined ? 'window_start' : q['sort']) as SortCode;
  if (typeof sort !== 'string' || !Object.hasOwn(SORTS, sort)) throw bad('/sort');
  const f = {
    routeDate: optDate(q, 'route_date'), windowFrom: q['window_from'] === undefined ? undefined : isoUtc(q['window_from'], '/window_from'),
    windowTo: q['window_to'] === undefined ? undefined : isoUtc(q['window_to'], '/window_to'), statuses: csv(q['status'], STATUSES, '/status'), kinds: csv(q['kind'], KINDS, '/kind'),
    centreId: optUuid(q, 'centre_id'), membershipId: optUuid(q, 'phlebotomist_membership_id'), unassignedOnly: bool(q['unassigned_only'], '/unassigned_only'), hasOpenFlags: bool(q['has_open_flags'], '/has_open_flags'),
  };
  const limit = limitOf(q['limit']);
  const after = q['cursor'] === undefined ? undefined : decodeCursor(q['cursor'], sort);

  await c.ports.IdentityPort.assertRole(c, { permission: PERM_VISIT_READ, ...(f.centreId ? { centreId: f.centreId } : {}) });
  const who = await callerOf(c);
  if (who.phleboOnly && who.membershipId === undefined) return { status: 200, body: { data: [], page: { limit } } };   // fail closed: no identity, no rows
  const { rows, hasMore } = await listVisitsPage(c.tx, c.tenantId, {
    ...Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)), sort, limit, ...(after ? { after } : {}),
    ...(who.phleboOnly ? { onlyAssignedTo: who.membershipId! } : {}),
  });

  const pii = rows.filter((r) => mayAccessPii(who, r));
  const patientIds = dedupe(pii.map((r) => r['patient_id']));
  const patients = new Map<string, string>();
  if (patientIds.length > 0) {                                                                    // ONE batch call per page (review m#34); a failing port -> "—" for the whole page
    try {
      const found = await c.db.tx((x) => c.ports.FrontdeskPort['getPatientDemographicsBatch'](x, { patientIds, purpose: 'home_visit' }));
      for (const p of found as Obj[]) if (typeof p?.['patientId'] === 'string' && typeof p['fullName'] === 'string') patients.set(p['patientId'], p['fullName']);
    } catch (e) { c.log.warn({ code: code(e) }, 'homecollection.demographics_unavailable'); }
  }
  const names: Names = { staff: await staffNames(c, dedupe(rows.map((r) => r['assigned_membership_id']))), users: new Map() };
  const data = rows.map((r) => toVisitSummaryDto(r, { names, showAreaHint: who.holdsAssign, ...(mayAccessPii(who, r) ? { patientName: patients.get(r['patient_id']) } : {}) }));
  const last = rows[rows.length - 1];
  return { status: 200, body: { data, page: { limit, ...(hasMore && last ? { next_cursor: encodeCursor(sort, last['sort_key'], last['id']) } : {}) } } };
}

// ---- H2 + H21 shared: §5.4 rule 1 (load -> 404 -> assertRole on the visit's centre) ----
export async function loadVisit(c: Ctx, visitId: string, permission: string): Promise<Obj> {
  const visit = await getVisitById(c.tx, c.tenantId, visitId);
  if (!visit) throw new LimsError('common.not_found');
  await c.ports.IdentityPort.assertRole(c, { permission, centreId: visit['centre_id'] });
  return visit;
}

export async function getHomeVisit(hctx: unknown, params: unknown): Promise<Result> {
  const c = ctxOf(hctx);
  const visitId = uuidParam(isObj(params) ? params['visit_id'] : undefined, '/visit_id');
  const visit = await loadVisit(c, visitId, PERM_VISIT_READ);
  const who = await callerOf(c);
  if (who.phleboOnly && visit['assigned_membership_id'] !== who.membershipId) throw new LimsError('homecollection.visit_not_assigned');   // nothing fetched, nothing logged
  const body = await buildVisitDetail(c, visit, who, true);
  await c.audit.access({ action: 'home_visit.view', entityType: 'home_visit', entityId: visitId, centreId: visit['centre_id'], purpose: 'visit_detail', outcome: 'allowed' });   // one row per read (review #18)
  return { status: 200, body };
}

/** VisitDetailDto of a loaded visit row. `orderLookups` = registration_no (FrontdeskPort) + balance (BillingPort): H2 only, the HC-T09 write responses skip both (REQ-SEC-081: less data, fewer port calls). */
export async function buildVisitDetail(c: Ctx, visit: Obj, who: Caller, orderLookups: boolean): Promise<Obj> {
  const visitId: string = visit['id'];
  const showPii = mayAccessPii(who, visit);

  const [flags, assignments, transitions, specimens, collections, route] = await Promise.all([
    listVisitFlagsByVisit(c.tx, c.tenantId, visitId), listAssignmentsByVisit(c.tx, c.tenantId, visitId), listTransitionsByVisit(c.tx, c.tenantId, visitId),
    listVisitSpecimensByVisit(c.tx, c.tenantId, visitId), listCollectionsByVisit(c.tx, c.tenantId, visitId), visit['route_id'] ? getRouteById(c.tx, c.tenantId, visit['route_id']) : null,
  ]);
  const names: Names = {
    staff: await staffNames(c, dedupe([visit['assigned_membership_id'], ...assignments.map((a) => a['membership_id']), ...collections.map((x) => x['collected_by_membership_id'])])),
    users: await userNames(c, dedupe([...transitions.map((t) => t['created_by']), ...assignments.map((a) => a['created_by']), ...flags.map((f) => f['resolved_by']), ...collections.map((x) => x['reviewed_by'])])),
  };

  let patientName: string | undefined;
  let registrationNo: string | undefined;
  let balance: Obj | undefined;
  if (showPii) {
    try { patientName = ((await c.db.tx((x) => c.ports.FrontdeskPort['getPatientDemographics'](x, { patientId: visit['patient_id'], purpose: 'home_visit' }))) as Obj | undefined)?.['fullName']; }
    catch (e) { c.log.warn({ code: code(e) }, 'homecollection.demographics_unavailable'); }
    if (orderLookups && visit['order_id']) {
      registrationNo = (await c.ports.FrontdeskPort['getOrderSummary'](c, { orderId: visit['order_id'] }))?.registrationNo;   // §2.1: propagates
      try { balance = await c.db.tx((x) => c.ports.BillingPort['getOrderBalance'](x, { orderId: visit['order_id'] })); }       // §2.1: omitted on failure
      catch (e) { c.log.warn({ code: code(e) }, 'homecollection.balance_unavailable'); }
    }
  }

  const live = specimens.filter((s) => s['is_active'] !== false);
  const row: Obj = {
    ...visit, last_device_ack_at: route?.['last_ack_at'] ?? null, open_flag_kinds: dedupe(flags.filter((f) => f['status'] === 'open').map((f) => f['kind'])).sort(),
    sp_expected: live.length, sp_collected: collections.filter((x) => x['status'] === 'applied').length, sp_held: collections.filter((x) => x['status'] === 'held').length,
    sp_received: live.filter((s) => ['received', 'aliquoted', 'in_process', 'resulted', 'verified', 'approved', 'reported', 'stored'].includes(s['status'])).length,
    sp_rejected: live.filter((s) => s['status'] === 'rejected').length,
  };
  return toVisitDetailDto(row, { names, showAreaHint: who.holdsAssign, ...(showPii ? { patientName } : {}) },
    { flags, assignments, transitions, specimens, collections, showPii, ...(registrationNo ? { registrationNo } : {}), ...(balance ? { balance: { balanceDue: balance['balanceDue'], asOf: balance['asOf'] } } : {}) });
}

// ---- H10 ----
export async function listHomeRoutes(hctx: unknown, query: unknown): Promise<Result> {
  const c = ctxOf(hctx);
  const q: Obj = isObj(query) ? query : {};
  const routeDate = isoDate(q['route_date'], '/route_date');
  const centreId = optUuid(q, 'centre_id');
  await c.ports.IdentityPort.assertRole(c, { permission: PERM_VISIT_READ, ...(centreId ? { centreId } : {}) });
  const who = await callerOf(c);
  if (who.phleboOnly && who.membershipId === undefined) return { status: 200, body: { data: [] } };
  const rows = await listRoutesOfDay(c.tx, c.tenantId, { routeDate, ...(centreId ? { centreId } : {}), ...(who.phleboOnly ? { membershipId: who.membershipId! } : {}) });   // phlebotomist-only: own routes
  const names: Names = { staff: await staffNames(c, dedupe(rows.map((r) => r['phlebotomist_membership_id']))), users: new Map() };
  return { status: 200, body: { data: rows.map((r) => toRouteDto(r, names)) } };
}

// ---- H12 ----
export async function listEligiblePhlebotomists(hctx: unknown, query: unknown): Promise<Result> {
  const c = ctxOf(hctx);
  const q: Obj = isObj(query) ? query : {};
  const centreId = uuidParam(q['centre_id'], '/centre_id');
  const routeDate = optDate(q, 'route_date');
  await c.ports.IdentityPort.assertRole(c, { permission: PERM_VISIT_ASSIGN, centreId });
  const roster = (await rosterOf(c, centreId)).slice(0, 200);
  const loads = routeDate && roster.length > 0 ? await listActiveLoadByMembers(c.tx, c.tenantId, routeDate, roster.map((m) => m.membershipId)) : [];
  const max = Number((await getSettings(c.tx, c.tenantId))?.['max_visits_per_route'] ?? 40);   // tenant default 40 (TRD §11.2)
  const cap = loadHomecollectionConfig().snapshotMaxVisits;                                       // LIMS_HOMECOLLECTION_SNAPSHOT_MAX_VISITS (60)
  const data = roster.map((m) => {
    const mine = loads.filter((l) => l['membership_id'] === m.membershipId);
    const route = mine.find((l) => l['centre_id'] === centreId);
    const active = route ? Number(route['active_visits']) : 0;
    const total = mine.reduce((n, l) => n + Number(l['active_visits']), 0);
    return toEligibleDto(m, { active, ...(route ? { routeId: route['route_id'] } : {}), full: routeDate !== undefined && (active >= max || total >= cap) });   // one flag for both H3 refusals (D-131)
  });
  return { status: 200, body: { data } };
}
