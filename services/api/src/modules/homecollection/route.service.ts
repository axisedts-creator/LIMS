// HC-T09: routes for the dispatcher actions (02-TRD §4.1 route version rule, §5.1 H3 caps + H11 resequenceHomeRoute, 08 A19 D-131).
// bumpVersion is THE way a route version moves: every committed change to a visit that sits on a route calls it in the same transaction (visit.service.ts does for H3/H4/H5/H6).
// placeOnRoute (used by H3) upserts the route, takes the row lock by bumping the version FIRST (so two assigns to one route are serialised and the loser re-counts), then enforces the caps.
// SQL lives in repository/*.repo.ts only. Messages and logs carry codes only (REQ-SEC-081).
import { LimsError, type FieldError } from '../../core/errors.js';
import { uuidv7 } from '../../../../../packages/shared-ts/src/uuidv7/index.js';
import { loadHomecollectionConfig } from './config.js';
import { dateOnly, toRouteDto } from './mappers/visit.mapper.js';
import { HOMECOLLECTION_PERMISSIONS } from './permissions.js';
import { getRouteById, getRouteByKey, insertRoute, updateRoute } from './repository/routes.repo.js';
import { getSettings } from './repository/settings.repo.js';
import type { Tx } from './repository/shared.repo.js';
import { listActiveLoadByMembers, listRoutesOfDay } from './repository/visitQueries.repo.js';
import { getVisitById, listVisitsByRoute, updateVisit } from './repository/visits.repo.js';
import { ctxOf, staffNames, uuidParam, type Ctx } from './service/visitRead.service.js';

const PERM_VISIT_ASSIGN = HOMECOLLECTION_PERMISSIONS[1];   // 'homecollection.visit.assign'
export type Obj = Record<string, any>;
export type Result = { status: number; body: unknown };
export type DCtx = Ctx & { readonly now: () => Date | string };

export function dctxOf(c: unknown): DCtx {
  const x = ctxOf(c);
  if (typeof (x as Partial<DCtx>).now !== 'function') throw new LimsError('auth.unauthenticated');   // fail closed
  return x as DCtx;
}

// ---- validation helpers shared by the dispatcher actions (fixed messages: no submitted value is echoed) ----
export const bad = (...paths: string[]): LimsError => new LimsError('common.validation_failed', undefined,
  paths.map((path): FieldError => ({ path, code: 'common.field_invalid', message: 'Field invalid' })));
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
export function noExtra(v: Obj, allowed: readonly string[], path = ''): void {
  for (const k of Object.keys(v)) if (!allowed.includes(k)) throw new LimsError('common.validation_failed', undefined, [{ path: `${path}/${k}`, code: 'common.unknown_field', message: 'Unknown field' }]);
}
/** If-Match: the quoted version (`"7"`), the same grammar as settings.service.ts. Missing -> 428, malformed -> 400. */
export function expectedVersionOf(headers: unknown): number {
  const h = isObj(headers) ? headers['if-match'] : undefined;
  if (h === undefined) throw new LimsError('common.precondition_required');
  const m = typeof h === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(h) : null;
  if (!m || Number(m[1]) > 2147483647) throw bad('/headers/if-match');
  return Number(m[1]);
}

const isActive = (v: Obj): boolean => v['status'] === 'assigned' || v['status'] === 'in_progress';

/** TRD §4.1 `route.service.bumpVersion(tx, routeId)` ([CONV] + tenantId: every repo statement binds it). Re-reads on a lost race (a bump commutes), so the row lock it takes lives until the tx ends. */
export async function bumpVersion(tx: Tx, tenantId: string, routeId: string): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await getRouteById(tx, tenantId, routeId);
    if (!row) throw new LimsError('common.not_found');
    const done = await updateRoute(tx, tenantId, routeId, Number(row['version']), {});
    if (done) return Number(done['version']);
  }
  throw new LimsError('common.version_conflict');
}

async function upsertRoute(ctx: DCtx, centreId: string, membershipId: string, routeDate: string): Promise<Obj> {
  const found = await getRouteByKey(ctx.tx, ctx.tenantId, centreId, membershipId, routeDate);
  if (found) return found;
  try { return await ctx.db.tx(() => insertRoute(ctx.tx, ctx.tenantId, { id: uuidv7(), centre_id: centreId, phlebotomist_membership_id: membershipId, route_date: routeDate })); }   // savepoint: a lost create race never poisons the request tx (P-44)
  catch (e) {
    const again = (e as Obj)?.['code'] === '23505' ? await getRouteByKey(ctx.tx, ctx.tenantId, centreId, membershipId, routeDate) : null;
    if (again) return again;
    throw e;
  }
}

export interface Placement { readonly route: Obj; readonly routeVersion: number; readonly sequence: number; readonly activeAfter: number }

/**
 * H3: route (centre of the visit, phlebotomist, date) upserted + locked (old route too on a reassign, locks taken in id order: no deadlock between two crossing reassigns),
 * then the two caps (D-131): max_visits_per_route on the route and LIMS_HOMECOLLECTION_SNAPSHOT_MAX_VISITS across all routes of the phlebotomist that day -> 400 /phlebotomist_membership_id.
 * ponytail: the daily cap is serialised per route only; two assigns to two different routes of one phlebotomist at 59 could both pass. Add a per-phlebotomist lock if that ever shows.
 */
export async function placeOnRoute(ctx: DCtx, visit: Obj, membershipId: string, routeDate: string, requestedSequence: number | undefined): Promise<Placement> {
  const route = await upsertRoute(ctx, visit['centre_id'], membershipId, routeDate);
  const oldRouteId: string | null = visit['status'] === 'assigned' ? (visit['route_id'] ?? null) : null;
  let routeVersion = 0;
  for (const id of [...new Set([route['id'], oldRouteId].filter((x): x is string => typeof x === 'string'))].sort()) {
    const v = await bumpVersion(ctx.tx, ctx.tenantId, id);
    if (id === route['id']) routeVersion = v;
  }

  const max = Number((await getSettings(ctx.tx, ctx.tenantId))?.['max_visits_per_route'] ?? 40);   // tenant default 40 (TRD §11.2)
  const active = (await listVisitsByRoute(ctx.tx, ctx.tenantId, route['id'])).filter((v) => isActive(v) && v['id'] !== visit['id']);
  if (active.length >= max) throw bad('/phlebotomist_membership_id');
  const loads = await listActiveLoadByMembers(ctx.tx, ctx.tenantId, routeDate, [membershipId]);
  const total = loads.reduce((n, l) => n + Number(l['active_visits']), 0);
  const selfCounted = isActive(visit) && visit['assigned_membership_id'] === membershipId && dateOnly(visit['route_date']) === routeDate ? 1 : 0;
  if (total - selfCounted >= loadHomecollectionConfig().snapshotMaxVisits) throw bad('/phlebotomist_membership_id');

  const ordered = [...active].sort((a, b) => Number(a['route_sequence']) - Number(b['route_sequence']) || String(a['id']).localeCompare(String(b['id'])));
  if (requestedSequence === undefined) {   // append (a gap in the route is fine: the phone and the board only sort)
    return { route, routeVersion, sequence: Math.min(ordered.reduce((m, v) => Math.max(m, Number(v['route_sequence'])), 0) + 1, 60), activeAfter: active.length + 1 };
  }
  const at = Math.min(requestedSequence, ordered.length + 1) - 1;   // insert at that place, renumber the visits behind it (each moved visit changes, so the phone sees it)
  for (const [i, other] of ordered.entries()) {
    const want = i < at ? i + 1 : i + 2;
    if (Number(other['route_sequence']) !== want && !(await updateVisit(ctx.tx, ctx.tenantId, other['id'], Number(other['version']), { route_sequence: want }))) throw new LimsError('common.version_conflict');
  }
  return { route, routeVersion, sequence: at + 1, activeAfter: active.length + 1 };
}

// ---- H11 ----
export async function resequenceHomeRoute(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const ctx = dctxOf(hctx);
  const routeId = uuidParam(isObj(params) ? params['route_id'] : undefined, '/route_id');
  const route = await getRouteById(ctx.tx, ctx.tenantId, routeId);
  if (!route) throw new LimsError('common.not_found');
  await ctx.ports.IdentityPort.assertRole(ctx, { permission: PERM_VISIT_ASSIGN, centreId: route['centre_id'] });
  const expected = expectedVersionOf(headers);
  if (!isObj(body)) throw bad('');
  noExtra(body, ['visit_ids']);
  const raw = body['visit_ids'];
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 60) throw bad('/visit_ids');
  const ids = raw.map((x) => uuidParam(x, '/visit_ids'));
  if (new Set(ids).size !== ids.length) throw bad('/visit_ids');

  if (!(await updateRoute(ctx.tx, ctx.tenantId, routeId, expected, {}))) throw new LimsError('common.version_conflict');   // compare-and-bump = the row lock for the rest of the tx
  const onRoute = new Map((await listVisitsByRoute(ctx.tx, ctx.tenantId, routeId)).map((v) => [v['id'] as string, v]));
  for (const id of ids) if (!onRoute.has(id) && !(await getVisitById(ctx.tx, ctx.tenantId, id))) throw new LimsError('common.not_found');   // unknown / other tenant: the whole request is a 404 (TRD §5 rule 4)
  const activeIds = [...onRoute.values()].filter(isActive).map((v) => v['id'] as string);
  if (activeIds.length !== ids.length || !ids.every((id) => onRoute.has(id) && isActive(onRoute.get(id)!))) throw bad('/visit_ids');   // exact set of the route's active visits

  for (const [i, id] of ids.entries()) {
    const v = onRoute.get(id)!;
    if (Number(v['route_sequence']) !== i + 1 && !(await updateVisit(ctx.tx, ctx.tenantId, id, Number(v['version']), { route_sequence: i + 1 }))) throw new LimsError('common.version_conflict');
  }
  const after = await getRouteById(ctx.tx, ctx.tenantId, routeId);
  const row = (await listRoutesOfDay(ctx.tx, ctx.tenantId, { routeDate: dateOnly(after?.['route_date']) ?? '', centreId: route['centre_id'], membershipId: route['phlebotomist_membership_id'] })).find((r) => r['id'] === routeId);
  if (!row) throw new LimsError('common.not_found');
  return { status: 200, body: toRouteDto(row, { staff: await staffNames(ctx, [route['phlebotomist_membership_id']]), users: new Map() }) };
}
