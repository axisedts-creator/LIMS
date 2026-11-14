// HC-T09: dispatcher actions H3 assignHomeVisit, H4 unassignHomeVisit, H5 scheduleHomeVisit, H6 cancelHomeVisit, H7 createHomeRevisit, H8 resolveHomeVisitFlag
// (02-TRD §5.1, §4.1 route version rule; 03-APP-FLOW V5-V7, V11; 08 A19 D-131 caps, P-44 SMS in a savepoint). All need `homecollection.visit.assign` on the centre of the visit (§5.4 rule 1: load -> 404 -> assertRole).
// Order of checks: load (404) -> permission (403) -> If-Match present (428) -> body (400) -> visit state (409 visit_closed / mutation_superseded) -> version (409 common.version_conflict) -> the rest.
// Every write goes through the HC-T03 repositories with the expected version; a route the visit sits on is bumped once through route.service.bumpVersion (TRD §4.1) in the same tx.
// A thrown error rolls the whole request tx back (nothing is half written, a route created by a failed assign disappears). Messages and logs carry codes only: no address, note, phone or name (REQ-SEC-081).
import { LimsError } from '../../core/errors.js';
import { uuidv7 } from '../../../../../packages/shared-ts/src/uuidv7/index.js';
import { assertVisitTransition, type VisitStatus } from './domain/visit.state.js';
import { dateOnly, toFlagDto } from './mappers/visit.mapper.js';
import { HOMECOLLECTION_PERMISSIONS } from './permissions.js';
import { listMutationsByVisit } from './repository/mutations.repo.js';
import { getSettings } from './repository/settings.repo.js';
import { insertVisitAssignment } from './repository/visitAssignments.repo.js';
import { enqueueRefreshVisitSpecimens } from './repository/visitSpecimens.repo.js';
import { getVisitFlagById, insertVisitFlag, listVisitFlagsByVisit, updateVisitFlag } from './repository/visitFlags.repo.js';
import { insertVisitTransition } from './repository/visitTransitions.repo.js';
import { insertVisit, updateVisit } from './repository/visits.repo.js';
import { bad, bumpVersion, dctxOf, expectedVersionOf, isObj, noExtra, placeOnRoute, type DCtx, type Obj, type Result } from './route.service.js';
import { buildVisitDetail, callerOf, loadVisit, userNames, uuidParam } from './service/visitRead.service.js';

const PERM_VISIT_ASSIGN = HOMECOLLECTION_PERMISSIONS[1];   // 'homecollection.visit.assign'
const conflict = (): LimsError => new LimsError('common.version_conflict');
const code = (e: unknown): string => (typeof (e as Obj)?.['code'] === 'string' ? (e as Obj)['code'] : 'unknown');
const nowOf = (ctx: DCtx): Date => new Date(ctx.now());

// ---- shared steps ----
/**
 * Dispatcher-selectable codes of 05-SCHEMA §2 (global seed, D-130; the system-only `missed` / `booking_cancelled` are left out [CONV]); `other` = requires_text.
 * ponytail: mirrors the seed migration. Read g_cs_reasons through reasons.repo once P-1 seeds it in every environment (the dispatch tests run on an unseeded DB).
 */
const REASONS: Readonly<Record<string, readonly string[]>> = {
  visit_cancel_reasons: ['patient_request', 'duplicate', 'lab_unavailable', 'address_unreachable', 'other'],
  unassign_reasons: ['phlebotomist_unavailable', 'rebalance_routes', 'reschedule', 'other'],
  revisit_reasons: ['failed_visit', 'partial_collection', 'patient_request', 'other'],
  flag_resolutions: ['handled', 'not_needed', 'escalated', 'other'],
};

/** `{ <codeKey>: coded value of `set`, <textKey>?: 1..500 }`; `other` needs the text. */
function parseReason(body: unknown, set: string, codeKey: string, textKey: string): { code: string; text: string | null } {
  if (!isObj(body)) throw bad('');
  noExtra(body, [codeKey, textKey]);
  const c = body[codeKey];
  if (typeof c !== 'string' || !(REASONS[set] ?? []).includes(c)) throw bad(`/${codeKey}`);
  const t = body[textKey];
  if (t !== undefined && (typeof t !== 'string' || t.includes('\u0000') || [...t].length < 1 || [...t].length > 500)) throw bad(`/${textKey}`);
  if (c === 'other' && t === undefined) throw bad(`/${textKey}`);
  return { code: c, text: typeof t === 'string' ? t : null };
}

/** load (404) + assertRole (403) + If-Match (428). */
async function open(ctx: DCtx, params: unknown, headers: unknown): Promise<{ visit: Obj; expected: number }> {
  const visit = await loadVisit(ctx, uuidParam(isObj(params) ? params['visit_id'] : undefined, '/visit_id'), PERM_VISIT_ASSIGN);
  return { visit, expected: expectedVersionOf(headers) };
}
const staleVersion = (visit: Obj, expected: number): void => { if (Number(visit['version']) !== expected) throw conflict(); };
const respond = async (ctx: DCtx, row: Obj, status = 200): Promise<Result> => ({ status, body: await buildVisitDetail(ctx, row, await callerOf(ctx), false) });
const transition = (ctx: DCtx, visit: Obj, from: string | null, to: string, reason?: { code: string; text: string | null }) =>
  insertVisitTransition(ctx.tx, ctx.tenantId, { id: uuidv7(), centre_id: visit['centre_id'], visit_id: visit['id'], from_status: from, to_status: to, cause: 'dispatcher',
    ...(reason ? { reason_code: reason.code, ...(reason.text !== null ? { reason_text: reason.text } : {}) } : {}), at: nowOf(ctx) });

// ---- H3 ----
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function parseAssign(body: unknown): { membershipId: string; routeDate: string; sequence: number | undefined } {
  if (!isObj(body)) throw bad('');
  noExtra(body, ['phlebotomist_membership_id', 'route_date', 'route_sequence']);
  const m = body['phlebotomist_membership_id'], d = body['route_date'], s = body['route_sequence'];
  if (typeof m !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(m)) throw bad('/phlebotomist_membership_id');
  if (typeof d !== 'string' || !ISO_DATE.test(d) || new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) !== d) throw bad('/route_date');
  if (s !== undefined && (typeof s !== 'number' || !Number.isInteger(s) || s < 1 || s > 60)) throw bad('/route_sequence');
  return { membershipId: m, routeDate: d, sequence: s };
}

/** US-03-6: active membership of the visit centre holding the phlebotomist role (the C17 definition, same as H12). */
async function assertEligible(ctx: DCtx, visit: Obj, membershipId: string): Promise<void> {
  const rows = await ctx.db.tx((x) => ctx.core.memberships.list(x, { membershipIds: [membershipId], centreId: visit['centre_id'], roleCode: 'phlebotomist', activeOnly: true }));
  if (!rows.some((r) => r.membershipId === membershipId)) throw new LimsError('homecollection.phlebotomist_not_eligible');
}

export async function assignHomeVisit(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const ctx = dctxOf(hctx);
  const { visit, expected } = await open(ctx, params, headers);
  assertVisitTransition(visit['status'] as VisitStatus, 'assigned');                       // state before body: a closed visit is closed whatever is sent. closed -> 409 visit_closed, in_progress -> 409 mutation_superseded
  const b = parseAssign(body);
  staleVersion(visit, expected);                                                           // before any side effect: a replay of a lost response never creates a second order
  if (!visit['window_start'] || !visit['address_text']) throw new LimsError('homecollection.visit_incomplete');   // 422, nothing created
  await assertEligible(ctx, visit, b.membershipId);
  const placed = await placeOnRoute(ctx, visit, b.membershipId, b.routeDate, b.sequence);  // upsert + lock + caps (D-131); bumps the old route on a reassign

  const patch: Obj = { status: 'assigned', route_id: placed.route['id'], route_date: b.routeDate, route_sequence: placed.sequence, assigned_membership_id: b.membershipId,
    assigned_at: nowOf(ctx), status_reason_code: null, status_reason_text: null };
  if (!visit['order_id']) {   // booking visit: C4 creates the order in THIS tx (same key on every attempt = C4 replays, 08 A19 P-40); a port error fails the assign and rolls everything back (US-03-4)
    const created = await ctx.ports.FrontdeskPort['createOrderFromBooking'](ctx, {
      source: 'home_collection', sourceRefId: visit['id'], patient: { patientId: visit['patient_id'] }, orderableIds: visit['orderable_ids'], branchId: visit['branch_id'], centreId: visit['centre_id'],
      ...(visit['referrer_id'] ? { referrerId: visit['referrer_id'] } : {}), priority: 'routine', scheduledAt: new Date(visit['window_start']).toISOString(), confirmImmediately: true, idempotencyKey: `${visit['id']}:order`,
    });
    patch['order_id'] = created.orderId;
    if (created.status === 'registered') patch['order_registered_at'] = nowOf(ctx);
  }
  const row = await updateVisit(ctx.tx, ctx.tenantId, visit['id'], expected, patch);
  if (!row) throw conflict();                                                              // a concurrent writer won the visit: this tx (route, order) rolls back
  await insertVisitAssignment(ctx.tx, ctx.tenantId, { id: uuidv7(), centre_id: visit['centre_id'], visit_id: visit['id'], route_id: placed.route['id'], membership_id: b.membershipId,
    route_date: b.routeDate, action: visit['status'] === 'assigned' ? 'reassign' : 'assign' });
  await transition(ctx, visit, visit['status'], 'assigned');
  await enqueueRefreshVisitSpecimens(ctx.tx, ctx.tenantId, visit['id']);                   // V5 / 02-TRD §8: LabPort specimen refresh, same tx (a rolled-back assign leaves no job)

  if ((await getSettings(ctx.tx, ctx.tenantId))?.['notify_phlebotomist_on_assign'] === true) {   // notify_phlebotomist_on_assign (D-129: staff only); P-44: savepoint, a failure never fails the assign
    try {
      await ctx.db.tx((x) => (ctx.ports as Obj)['NotificationPort'].sendSms(x, { recipient: { kind: 'staff', membershipId: b.membershipId }, purpose: 'visit_assignment', templateCode: 'homecollection.visit_assigned',
        params: { route_date: b.routeDate, visit_count: placed.activeAfter }, related: { entityType: 'visit', entityId: visit['id'] }, idempotencyKey: `${placed.route['id']}:${placed.routeVersion}:assigned` }));
    } catch (e) { ctx.log.warn({ code: code(e) }, 'homecollection.assign_sms_failed'); }
  }
  return respond(ctx, row);
}

// ---- H4 ----
export async function unassignHomeVisit(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const ctx = dctxOf(hctx);
  const { visit, expected } = await open(ctx, params, headers);
  assertVisitTransition(visit['status'] as VisitStatus, 'unassigned');                     // in_progress (the phone is at the door) -> 409 mutation_superseded
  const reason = parseReason(body, 'unassign_reasons', 'reason_code', 'reason_text');
  staleVersion(visit, expected);
  if ((await listMutationsByVisit(ctx.tx, ctx.tenantId, visit['id'])).some((m) => m['outcome'] === 'applied')) throw new LimsError('homecollection.mutation_superseded');   // V7 guard
  const row = await updateVisit(ctx.tx, ctx.tenantId, visit['id'], expected, { status: 'unassigned', route_id: null, route_date: null, route_sequence: null, assigned_membership_id: null,
    assigned_at: null, status_reason_code: reason.code, status_reason_text: reason.text });   // order_id stays (C17 cannot cancel C4 orders)
  if (!row) throw conflict();
  await insertVisitAssignment(ctx.tx, ctx.tenantId, { id: uuidv7(), centre_id: visit['centre_id'], visit_id: visit['id'], ...(visit['route_id'] ? { route_id: visit['route_id'] } : {}),
    ...(visit['route_date'] ? { route_date: dateOnly(visit['route_date']) } : {}), action: 'unassign', reason_code: reason.code });
  await transition(ctx, visit, visit['status'], 'unassigned', reason);
  if (visit['route_id']) await bumpVersion(ctx.tx, ctx.tenantId, visit['route_id']);        // the route the visit leaves
  return respond(ctx, row);
}

// ---- H5 ----
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const instant = (v: unknown, path: string): Date => {
  const d = new Date(typeof v === 'string' && ISO_UTC.test(v) ? v : NaN);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 19) !== (v as string).slice(0, 19)) throw bad(path);
  return d;
};
const decimal = (v: unknown, limit: number, path: string): string => {
  if (typeof v !== 'string' || !/^-?\d{1,3}(\.\d{1,6})?$/.test(v) || Math.abs(Number(v)) > limit) throw bad(path);
  return v;
};
const text = (v: unknown, min: number, max: number, path: string): string => {
  if (typeof v !== 'string' || v.includes('\u0000') || [...v].length < min || [...v].length > max) throw bad(path);
  return v;
};
const DAY_MS = 86_400_000;

function parseSchedule(body: unknown, now: Date): Obj {
  if (!isObj(body)) throw bad('');
  noExtra(body, ['window_start', 'window_end', 'address', 'note_for_phlebotomist', 'unset']);
  const start = instant(body['window_start'], '/window_start'), end = instant(body['window_end'], '/window_end');
  if (end.getTime() <= start.getTime() || end.getTime() - start.getTime() > 12 * 3_600_000) throw bad('/window_end');
  if (start.getTime() > now.getTime() + 30 * DAY_MS) throw bad('/window_start');            // [CONV] more than 30 days ahead
  const patch: Obj = { window_start: start, window_end: end };
  const unset = body['unset'] === undefined ? [] : body['unset'];
  if (!Array.isArray(unset) || unset.length > 3 || new Set(unset).size !== unset.length || !unset.every((u) => u === 'note_for_phlebotomist' || u === 'landmark' || u === 'coordinates')) throw bad('/unset');
  const a = body['address'];
  if (a !== undefined) {
    if (!isObj(a)) throw bad('/address');
    noExtra(a, ['address_text', 'landmark', 'latitude', 'longitude'], '/address');
    patch['address_text'] = text(a['address_text'], 1, 500, '/address/address_text');
    if (a['landmark'] !== undefined) patch['landmark'] = text(a['landmark'], 1, 200, '/address/landmark');
    if ((a['latitude'] === undefined) !== (a['longitude'] === undefined)) throw bad('/address/latitude', '/address/longitude');   // both or neither (review m#31)
    if (a['latitude'] !== undefined) { patch['latitude'] = decimal(a['latitude'], 90, '/address/latitude'); patch['longitude'] = decimal(a['longitude'], 180, '/address/longitude'); }
  }
  if (body['note_for_phlebotomist'] !== undefined) patch['note_for_phlebotomist'] = text(body['note_for_phlebotomist'], 1, 500, '/note_for_phlebotomist');
  for (const u of unset) {
    const cols = u === 'coordinates' ? ['latitude', 'longitude'] : [u as string];
    if (cols.some((c) => patch[c] !== undefined)) throw bad('/unset');                      // set and unset of the same field in one call
    for (const c of cols) patch[c] = null;
  }
  return patch;
}

export async function scheduleHomeVisit(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const ctx = dctxOf(hctx);
  const { visit, expected } = await open(ctx, params, headers);
  if (visit['status'] !== 'unassigned' && visit['status'] !== 'assigned') throw new LimsError('homecollection.visit_closed');   // closed, or in_progress (the DB guard freezes address / window then)
  const patch = parseSchedule(body, nowOf(ctx));
  staleVersion(visit, expected);
  const row = await updateVisit(ctx.tx, ctx.tenantId, visit['id'], expected, patch);
  if (!row) throw conflict();
  if (visit['route_id']) await bumpVersion(ctx.tx, ctx.tenantId, visit['route_id']);        // TRD §4.1: one bump per call, whatever fields changed
  if (typeof row['address_text'] === 'string' && row['address_text'] !== '') {              // US-03-2: an address now exists -> address_missing resolves by itself
    for (const f of await listVisitFlagsByVisit(ctx.tx, ctx.tenantId, visit['id'])) {
      if (f['kind'] === 'address_missing' && f['status'] === 'open') await updateVisitFlag(ctx.tx, ctx.tenantId, f['id'], Number(f['version']), { status: 'resolved', resolution_code: 'handled', resolved_by: ctx.actor.id, resolved_at: nowOf(ctx) });
    }
  }
  return respond(ctx, row);
}

// ---- H6 ----
export async function cancelHomeVisit(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const ctx = dctxOf(hctx);
  const { visit, expected } = await open(ctx, params, headers);
  assertVisitTransition(visit['status'] as VisitStatus, 'cancelled');                      // closed -> visit_closed, in_progress -> mutation_superseded (cancel -> flag instead)
  const reason = parseReason(body, 'visit_cancel_reasons', 'reason_code', 'reason_text');
  staleVersion(visit, expected);
  const row = await updateVisit(ctx.tx, ctx.tenantId, visit['id'], expected, { status: 'cancelled', cancelled_at: nowOf(ctx), status_reason_code: reason.code, status_reason_text: reason.text });   // route fields stay (history, the phone gets a stub)
  if (!row) throw conflict();
  await transition(ctx, visit, visit['status'], 'cancelled', reason);
  if (visit['status'] === 'assigned') {
    if (visit['order_id']) {                                                               // V11: C17 cannot cancel a C4 order -> a work item for the dispatcher
      const already = (await listVisitFlagsByVisit(ctx.tx, ctx.tenantId, visit['id'])).some((f) => f['kind'] === 'order_cancel_required' && f['status'] === 'open' && f['related_id'] === visit['order_id']);
      if (!already) await insertVisitFlag(ctx.tx, ctx.tenantId, { id: uuidv7(), centre_id: visit['centre_id'], visit_id: visit['id'], kind: 'order_cancel_required', status: 'open', related_id: visit['order_id'] });
    }
    if (visit['route_id']) await bumpVersion(ctx.tx, ctx.tenantId, visit['route_id']);
  }
  return respond(ctx, row);
}

// ---- H7 (US-11-3; no If-Match: the parent is never edited) ----
export async function createHomeRevisit(hctx: unknown, params: unknown, _headers: unknown, body: unknown): Promise<Result> {
  const ctx = dctxOf(hctx);
  const parent = await loadVisit(ctx, uuidParam(isObj(params) ? params['visit_id'] : undefined, '/visit_id'), PERM_VISIT_ASSIGN);
  if (!(parent['status'] === 'failed' || (parent['status'] === 'completed' && parent['outcome'] === 'partial'))) throw new LimsError('homecollection.visit_closed');   // review #4: the registered 409, not validation_failed
  const reason = parseReason(body, 'revisit_reasons', 'reason_code', 'reason_text');
  if (parent['order_id'] && (await ctx.ports.FrontdeskPort['getOrderSummary'](ctx, { orderId: parent['order_id'] }))?.status === 'cancelled') throw new LimsError('homecollection.visit_closed');
  const child = await insertVisit(ctx.tx, ctx.tenantId, { id: uuidv7(), centre_id: parent['centre_id'], branch_id: parent['branch_id'], kind: 'revisit', status: 'unassigned', parent_visit_id: parent['id'],
    patient_id: parent['patient_id'], order_id: parent['order_id'], ...(parent['orderable_ids'] ? { orderable_ids: parent['orderable_ids'] } : {}), ...(parent['referrer_id'] ? { referrer_id: parent['referrer_id'] } : {}),
    ...(parent['home_address_id'] ? { home_address_id: parent['home_address_id'] } : {}), address_text: parent['address_text'], landmark: parent['landmark'], latitude: parent['latitude'], longitude: parent['longitude'] });
  await transition(ctx, child, null, 'unassigned', reason);
  return respond(ctx, child, 201);
}

// ---- H8 ----
export async function resolveHomeVisitFlag(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const ctx = dctxOf(hctx);
  const visit = await loadVisit(ctx, uuidParam(isObj(params) ? params['visit_id'] : undefined, '/visit_id'), PERM_VISIT_ASSIGN);
  const flagId = uuidParam(isObj(params) ? params['flag_id'] : undefined, '/flag_id');
  const expected = expectedVersionOf(headers);
  const resolution = parseReason(body, 'flag_resolutions', 'resolution_code', 'note');
  const flag = await getVisitFlagById(ctx.tx, ctx.tenantId, flagId);
  if (!flag || flag['visit_id'] !== visit['id']) throw new LimsError('common.not_found');   // no cross-visit resolve
  if (flag['status'] !== 'open' || Number(flag['version']) !== expected) throw conflict();
  const row = await updateVisitFlag(ctx.tx, ctx.tenantId, flagId, expected, { status: 'resolved', resolution_code: resolution.code, resolution_note: resolution.text, resolved_by: ctx.actor.id, resolved_at: nowOf(ctx) });
  if (!row) throw conflict();                                                              // two dispatchers at once: the loser re-reads the board
  return { status: 200, body: toFlagDto(row, { staff: new Map(), users: await userNames(ctx, [ctx.actor.id]) }) };
}
