// HC-T09 / H5 scheduleHomeVisit, H4 unassignHomeVisit, H6 cancelHomeVisit, H8 resolveHomeVisitFlag + the route version rule (02-TRD §4.1, review #10) + US-15 (manual trigger: the dispatcher acts on a `missed` visit).
// PRD US-03-2, US-03-9, US-15-1/-2 (dispatcher side); 07-SECURITY §4/§5. Runs handlers over a real PG17 tx (helpers.ts). Fails now: H4/H5/H6/H8 are HC-T01 stubs.
// Dates: this file owns routes from 2028-03-01 (see route.test.ts for the split). H5 windows stay near ctx.now() (2026-11-10): the spec refuses a window more than 30 days ahead [CONV].
import { beforeAll, describe, expect, it } from 'vitest';
import { DISPATCHER, DISPATCHER_B, MEMBER, NOBODY, PHLEBO, T, assignmentsOf, assignedVisit, bookingVisit, cancel, day, failure, flagsOf, frontDeskVisit, hc, openFlag, req, resolveFlag,
  responseErrors, routeRow, schedule, schemaErrors, seed, transitionsOf, uid, unassign, visitRow, dop, hdr, worldOf, type DFx } from './helpers.js';

const BASE = '2028-03-01';
let n = 0;
const D = (): string => day(BASE, n++);
const NEAR = '2026-11-12';
const win = (h = 4, mins = 30, date = NEAR) => ({ window_start: `${date}T${String(h).padStart(2, '0')}:00:00Z`, window_end: `${date}T${String(h).padStart(2, '0')}:${String(mins).padStart(2, '0')}:00Z` });
let W: Awaited<ReturnType<typeof worldOf>>;
beforeAll(async () => { W = await worldOf('a'); }, T);
const routeVersion = async (id: string) => (await routeRow(id)).version as number;

describe('US-03-2 schedule (H5): window + address stored, version +1, open address_missing flag resolves by itself', () => {
  it('unassigned visit without address/window: both stored, version +1, address_missing resolved, DTO valid', { timeout: T }, async () => {
    const v = await frontDeskVisit({ window_start: null, window_end: null, address_text: null, landmark: null });
    const flag = await openFlag(v.id, 'address_missing');
    const r = await schedule({ visitId: v.id, version: v.version, body: { ...win(4, 30), address: { address_text: 'Ward 4, Synthetic Tole', landmark: 'Near the synthetic stupa', latitude: '27.717200', longitude: '85.324000' }, note_for_phlebotomist: 'Synthetic gate code 0000' } });
    expect(r.status).toBe(200);
    expect(responseErrors('scheduleHomeVisit', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: v.id, status: 'unassigned', version: v.version + 1, window_start: `${NEAR}T04:00:00.000Z` });
    const row = await visitRow(v.id);
    expect(row).toMatchObject({ address_text: 'Ward 4, Synthetic Tole', landmark: 'Near the synthetic stupa', note_for_phlebotomist: 'Synthetic gate code 0000', version: v.version + 1 });
    expect(new Date(row.window_start).toISOString()).toBe(`${NEAR}T04:00:00.000Z`);
    expect(new Date(row.window_end).toISOString()).toBe(`${NEAR}T04:30:00.000Z`);
    expect([Number(row.latitude), Number(row.longitude)]).toEqual([27.7172, 85.324]);
    const after = (await flagsOf(v.id)).find((f) => f.id === flag.id);
    expect(after).toMatchObject({ status: 'resolved' });
    expect(after.resolved_at).not.toBeNull();
    expect(r.body.open_flag_kinds).not.toContain('address_missing');
  });
  it('the window alone (no address object) keeps the stored address and does not touch coordinates', { timeout: T }, async () => {
    const v = await frontDeskVisit({ latitude: '27.700000', longitude: '85.300000' }, 'a', NEAR);
    const r = await schedule({ visitId: v.id, version: v.version, body: win(6, 30) });
    expect(r.status).toBe(200);
    const row = await visitRow(v.id);
    expect(row).toMatchObject({ address_text: v.address_text, landmark: v.landmark });
    expect([Number(row.latitude), Number(row.longitude)]).toEqual([27.7, 85.3]);
  });
  it('unset: [note_for_phlebotomist, landmark, coordinates] clears exactly those fields', { timeout: T }, async () => {
    const v = await frontDeskVisit({ latitude: '27.700000', longitude: '85.300000', note_for_phlebotomist: 'Synthetic note' }, 'a', NEAR);
    const r = await schedule({ visitId: v.id, version: v.version, body: { ...win(5, 30), unset: ['note_for_phlebotomist', 'landmark', 'coordinates'] } });
    expect(r.status).toBe(200);
    const row = await visitRow(v.id);
    expect(row).toMatchObject({ note_for_phlebotomist: null, landmark: null, latitude: null, longitude: null, address_text: v.address_text });
  });
  it('an assigned visit can be rescheduled; its order and assignment are untouched', { timeout: T }, async () => {
    const date = D(); const { visit } = await assignedVisit({ date });
    const r = await schedule({ visitId: visit.id, version: visit.version, body: win(7, 30) });
    expect(r.status).toBe(200);
    expect(await visitRow(visit.id)).toMatchObject({ status: 'assigned', order_id: visit.order_id, route_id: visit.route_id, assigned_membership_id: MEMBER.a });
    expect(r.probe.createOrder).toHaveLength(0);
  });
});

describe('H5 validation: 400 common.validation_failed, nothing written', () => {
  const lat = { address_text: 'Ward 4, Synthetic Tole' };
  it.each<[string, () => unknown, string?]>([
    ['end == start', () => ({ window_start: `${NEAR}T04:00:00Z`, window_end: `${NEAR}T04:00:00Z` })],
    ['end < start', () => ({ window_start: `${NEAR}T05:00:00Z`, window_end: `${NEAR}T04:00:00Z` })],
    ['span 12 h + 1 s', () => ({ window_start: `${NEAR}T00:00:00Z`, window_end: `${NEAR}T12:00:01Z` })],
    ['window more than 30 days ahead [CONV]', () => ({ window_start: '2027-02-01T04:00:00Z', window_end: '2027-02-01T05:00:00Z' })],
    ['only latitude', () => ({ ...win(), address: { ...lat, latitude: '27.717200' } })],
    ['only longitude', () => ({ ...win(), address: { ...lat, longitude: '85.324000' } })],
    ['latitude 90.000001', () => ({ ...win(), address: { ...lat, latitude: '90.000001', longitude: '85.324000' } })],
    ['longitude -180.000001', () => ({ ...win(), address: { ...lat, latitude: '27.7', longitude: '-180.000001' } })],
    ['latitude with 7 decimals', () => ({ ...win(), address: { ...lat, latitude: '27.1234567', longitude: '85.324000' } })],
    ['latitude as a JSON number, not a DecimalString', () => ({ ...win(), address: { ...lat, latitude: 27.7172, longitude: '85.324000' } })],
    ['address_text empty', () => ({ ...win(), address: { address_text: '' } })],
    ['address_text 501 chars', () => ({ ...win(), address: { address_text: 'x'.repeat(501) } })],
    ['landmark 201 chars', () => ({ ...win(), address: { ...lat, landmark: 'x'.repeat(201) } })],
    ['note 501 chars', () => ({ ...win(), note_for_phlebotomist: 'x'.repeat(501) })],
    ['unset with an unknown member', () => ({ ...win(), unset: ['address_text'] })],
    ['window_start without window_end', () => ({ window_start: `${NEAR}T04:00:00Z` })],
    ['window_start not a timestamp', () => ({ window_start: 'tomorrow', window_end: `${NEAR}T05:00:00Z` })],
    ['unknown field status', () => ({ ...win(), status: 'assigned' })],
    ['unknown field route_id (a schedule can never move a visit between routes)', () => ({ ...win(), route_id: uid() })],
    ['unknown field order_id', () => ({ ...win(), order_id: uid() })],
    ['address with an unknown field', () => ({ ...win(), address: { ...lat, tenant_id: uid() } })],
    ['body is an array', () => []],
  ])('%s', { timeout: T }, async (_n, mk) => {
    const v = await frontDeskVisit({}, 'a', NEAR);
    const e = await failure(schedule({ visitId: v.id, version: v.version, body: mk() }));
    expect(e.code).toBe('common.validation_failed');
    expect(e.statusCode).toBe(400);
    expect(await visitRow(v.id)).toMatchObject({ version: v.version, address_text: v.address_text, landmark: v.landmark });
  });
  it('the exact limits are accepted: 12 h span, 500-char address, 200-char landmark, 500-char note, latitude -90 / longitude 180', { timeout: T }, async () => {
    const v = await frontDeskVisit({}, 'a', NEAR);
    const r = await schedule({ visitId: v.id, version: v.version, body: { window_start: `${NEAR}T00:00:00Z`, window_end: `${NEAR}T12:00:00Z`,
      address: { address_text: 'x'.repeat(500), landmark: 'y'.repeat(200), latitude: '-90.000000', longitude: '180.000000' }, note_for_phlebotomist: 'z'.repeat(500) } });
    expect(r.status).toBe(200);
  });
  it('a schedule request that fails writes nothing for a visit with an open address_missing flag either (flag stays open)', { timeout: T }, async () => {
    const v = await frontDeskVisit({ window_start: null, window_end: null, address_text: null }, 'a', NEAR);
    const flag = await openFlag(v.id, 'address_missing');
    expect((await failure(schedule({ visitId: v.id, version: v.version, body: { window_start: `${NEAR}T05:00:00Z`, window_end: `${NEAR}T04:00:00Z`, address: { address_text: 'Ward 4' } } }))).code).toBe('common.validation_failed');
    expect((await flagsOf(v.id)).find((f) => f.id === flag.id)!.status).toBe('open');
    expect((await visitRow(v.id)).address_text).toBeNull();
  });
});

describe('route version rule (TRD §4.1, review #10): every committed change to a visit on a route bumps that route version once, in the same transaction', () => {
  it.each<[string, () => unknown]>([
    ['window only', () => win(8, 30)],
    ['address text', () => ({ ...win(8, 30), address: { address_text: 'Ward 9, Synthetic Tole' } })],
    ['landmark', () => ({ ...win(8, 30), address: { address_text: 'Ward 9, Synthetic Tole', landmark: 'Synthetic landmark' } })],
    ['coordinates', () => ({ ...win(8, 30), address: { address_text: 'Ward 9, Synthetic Tole', latitude: '27.717200', longitude: '85.324000' } })],
    ['note_for_phlebotomist', () => ({ ...win(8, 30), note_for_phlebotomist: 'Synthetic note' })],
    ['unset note', () => ({ ...win(8, 30), unset: ['note_for_phlebotomist'] })],
    ['unset coordinates', () => ({ ...win(8, 30), unset: ['coordinates'] })],
  ])('H5 on an ASSIGNED visit: %s -> route version +1 (exactly one bump per call), visit version +1', { timeout: T }, async (_n, mk) => {
    const date = D(); const { visit, route } = await assignedVisit({ date });
    const before = await routeVersion(route.id);
    const r = await schedule({ visitId: visit.id, version: visit.version, body: mk() });
    expect(r.status).toBe(200);
    expect(await routeVersion(route.id)).toBe(before + 1);
    expect((await visitRow(visit.id)).version).toBe(visit.version + 1);
  });
  it('H5 on an UNASSIGNED visit has no route to bump and does not give it one', { timeout: T }, async () => {
    const v = await frontDeskVisit({}, 'a', NEAR);
    const r = await schedule({ visitId: v.id, version: v.version, body: win(9, 30) });
    expect(r.status).toBe(200);
    expect((await visitRow(v.id)).route_id).toBeNull();
  });
  it('H4 unassign bumps the route the visit leaves (+1)', { timeout: T }, async () => {
    const date = D(); const { visit, route } = await assignedVisit({ date }); const before = await routeVersion(route.id);
    expect((await unassign({ visitId: visit.id, version: visit.version, body: { reason_code: 'reschedule' } })).status).toBe(200);
    expect(await routeVersion(route.id)).toBe(before + 1);
  });
  it('H6 cancel of an assigned visit bumps its route (+1): the phone must see the cancelled stub', { timeout: T }, async () => {
    const date = D(); const { visit, route } = await assignedVisit({ date }); const before = await routeVersion(route.id);
    expect((await cancel({ visitId: visit.id, version: visit.version, body: { reason_code: 'patient_request' } })).status).toBe(200);
    expect(await routeVersion(route.id)).toBe(before + 1);
  });
  it('a refused write bumps nothing (closed visit, stale version, validation)', { timeout: T }, async () => {
    const date = D(); const { visit, route } = await assignedVisit({ date }); const before = await routeVersion(route.id);
    expect((await failure(schedule({ visitId: visit.id, version: visit.version + 3, body: win(9, 30) }))).code).toBe('common.version_conflict');
    expect((await failure(schedule({ visitId: visit.id, version: visit.version, body: { window_start: `${NEAR}T09:00:00Z`, window_end: `${NEAR}T08:00:00Z` } }))).code).toBe('common.validation_failed');
    const done = await assignedVisit({ date: D(), status: 'completed' });
    expect((await failure(schedule({ visitId: done.visit.id, version: done.visit.version, body: win(9, 30) }))).code).toBe('homecollection.visit_closed');
    expect(await routeVersion(route.id)).toBe(before);
    expect(await routeVersion(done.route.id)).toBe(1);
  });
});

describe('H4 unassignHomeVisit', () => {
  it('assigned -> unassigned: order_id kept, status_reason_code stored, assignment row action unassign with the reason, transition row, DTO valid', { timeout: T }, async () => {
    const date = D(); const { visit } = await assignedVisit({ date });
    const r = await unassign({ visitId: visit.id, version: visit.version, body: { reason_code: 'phlebotomist_unavailable', reason_text: 'Synthetic: staff on leave' } });
    expect(r.status).toBe(200);
    expect(responseErrors('unassignHomeVisit', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: visit.id, status: 'unassigned', order_id: visit.order_id });
    expect(r.body).not.toHaveProperty('phlebotomist');
    const row = await visitRow(visit.id);
    expect(row).toMatchObject({ status: 'unassigned', order_id: visit.order_id, assigned_membership_id: null, status_reason_code: 'phlebotomist_unavailable', version: visit.version + 1 });
    expect((await assignmentsOf(visit.id)).at(-1)).toMatchObject({ action: 'unassign', membership_id: null, reason_code: 'phlebotomist_unavailable' });
    expect((await transitionsOf(visit.id)).some((t) => t.from_status === 'assigned' && t.to_status === 'unassigned' && t.cause === 'dispatcher')).toBe(true);
  });
  it('in_progress -> 409 homecollection.mutation_superseded (the phone is at the door)', { timeout: T }, async () => {
    const { visit } = await assignedVisit({ date: D(), status: 'in_progress' });
    const e = await failure(unassign({ visitId: visit.id, version: visit.version, body: { reason_code: 'reschedule' } }));
    expect(e.code).toBe('homecollection.mutation_superseded');
    expect(e.statusCode).toBe(409);
    expect(await visitRow(visit.id)).toMatchObject({ status: 'in_progress', version: visit.version });
  });
  it('ASSUMED: an assigned visit with an APPLIED mutation cannot be unassigned either (TRD sweep_missed_visits: "H4 unassign is still blocked once an applied mutation exists")', { timeout: T }, async () => {
    const { visit } = await assignedVisit({ date: D() });
    await seed('homecollection.mutations', hc.mutation('a', W.device.id, W.batch.id, visit.id, { outcome: 'applied', type: 'visit.arrived' }));
    const e = await failure(unassign({ visitId: visit.id, version: visit.version, body: { reason_code: 'reschedule' } }));
    expect(e.code).toBe('homecollection.mutation_superseded');
    expect((await visitRow(visit.id)).status).toBe('assigned');
  });
  it.each<[string, unknown]>([
    ['reason_code missing', {}],
    ['reason_code outside the coded set', { reason_code: 'because' }],
    ['reason_code from another coded set (visit_cancel_reasons)', { reason_code: 'patient_request' }],
    ["'other' without reason_text (requires_text)", { reason_code: 'other' }],
    ['reason_text 501 chars', { reason_code: 'reschedule', reason_text: 'x'.repeat(501) }],
    ['unknown field', { reason_code: 'reschedule', membership_id: uid() }],
  ])('400 common.validation_failed: %s', { timeout: T }, async (_n, b) => {
    const { visit } = await assignedVisit({ date: D() });
    const e = await failure(unassign({ visitId: visit.id, version: visit.version, body: b }));
    expect(e.code).toBe('common.validation_failed');
    expect(await visitRow(visit.id)).toMatchObject({ status: 'assigned', version: visit.version });
  });
});

describe('H6 cancelHomeVisit', () => {
  it('unassigned booking visit -> cancelled with reason code + text; no route touched; DTO valid', { timeout: T }, async () => {
    const v = await bookingVisit({}, 'a', NEAR);
    const r = await cancel({ visitId: v.id, version: v.version, body: { reason_code: 'duplicate', reason_text: 'Synthetic duplicate booking' } });
    expect(r.status).toBe(200);
    expect(responseErrors('cancelHomeVisit', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: v.id, status: 'cancelled' });
    expect(await visitRow(v.id)).toMatchObject({ status: 'cancelled', status_reason_code: 'duplicate', status_reason_text: 'Synthetic duplicate booking', version: v.version + 1 });
    expect((await transitionsOf(v.id)).some((t) => t.to_status === 'cancelled' && t.cause === 'dispatcher' && t.reason_code === 'duplicate')).toBe(true);
    expect(r.probe.createOrder).toHaveLength(0);
  });
  it('assigned visit -> cancelled, keeps route_id / route_date / route_sequence (the phone gets a stub, TRD §6.2 step 5) and its order (C17 cannot cancel C4 orders)', { timeout: T }, async () => {
    const date = D(); const { visit, route } = await assignedVisit({ date, seq: 2 });
    const r = await cancel({ visitId: visit.id, version: visit.version, body: { reason_code: 'patient_request' } });
    expect(r.status).toBe(200);
    expect(await visitRow(visit.id)).toMatchObject({ status: 'cancelled', route_id: route.id, route_date: date, route_sequence: 2, order_id: visit.order_id });
    expect(r.probe.orderSummary).toEqual([]);
  });
  it('in_progress -> 409 homecollection.mutation_superseded (cancel -> flag instead)', { timeout: T }, async () => {
    const { visit } = await assignedVisit({ date: D(), status: 'in_progress' });
    const e = await failure(cancel({ visitId: visit.id, version: visit.version, body: { reason_code: 'patient_request' } }));
    expect(e.code).toBe('homecollection.mutation_superseded');
    expect(await visitRow(visit.id)).toMatchObject({ status: 'in_progress', version: visit.version });
  });
  it.each<[string, unknown]>([
    ['reason_code missing', {}],
    ['reason_code outside the set', { reason_code: 'nope' }],
    ['reason_code of the unassign set', { reason_code: 'reschedule' }],
    ["'other' without reason_text", { reason_code: 'other' }],
    ['reason_text 501 chars', { reason_code: 'patient_request', reason_text: 'x'.repeat(501) }],
    ['unknown field status', { reason_code: 'patient_request', status: 'completed' }],
  ])('400 common.validation_failed: %s', { timeout: T }, async (_n, b) => {
    const v = await bookingVisit({}, 'a', NEAR);
    const e = await failure(cancel({ visitId: v.id, version: v.version, body: b }));
    expect(e.code).toBe('common.validation_failed');
    expect(await visitRow(v.id)).toMatchObject({ status: 'unassigned', version: v.version });
  });
});

describe('US-15 (manual trigger): a `missed` visit that stays assigned is resolved by the dispatcher', () => {
  it('missed flag open on an assigned visit: H4 unassign returns it to unassigned (order kept), H8 resolves the flag', { timeout: T }, async () => {
    const date = D(); const { visit } = await assignedVisit({ date }); const flag = await openFlag(visit.id, 'missed');
    const u = await unassign({ visitId: visit.id, version: visit.version, body: { reason_code: 'rebalance_routes' } });
    expect(u.status).toBe(200);
    expect(u.body).toMatchObject({ status: 'unassigned', order_id: visit.order_id });
    const r = await resolveFlag({ visitId: visit.id, flagId: flag.id, version: flag.version, body: { resolution_code: 'handled', note: 'Synthetic: rebooked by phone' } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: flag.id, kind: 'missed', status: 'resolved', resolution_code: 'handled' });
  });
  it('missed flag open, the phone holds the visit: the dispatcher can still reassign it to a new date (stays assigned, order unchanged)', { timeout: T }, async () => {
    const d1 = D(), d2 = D(); const { visit } = await assignedVisit({ date: d1 }); await openFlag(visit.id, 'missed');
    const fx: DFx = {};
    const r = await dop('assignHomeVisit', req({ params: { visit_id: visit.id }, headers: hdr(visit.version), body: { phlebotomist_membership_id: MEMBER.a, route_date: d2 } }), DISPATCHER, { fx });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'assigned', route_date: d2, order_id: visit.order_id });
    expect(r.probe.createOrder).toHaveLength(0);
  });
});

describe('H8 resolveHomeVisitFlag', () => {
  it('open -> resolved with resolution_code, note and resolved_at; response is a valid VisitFlagDto', { timeout: T }, async () => {
    const v = await bookingVisit({}, 'a', NEAR); const flag = await openFlag(v.id, 'held_collection');
    const r = await resolveFlag({ visitId: v.id, flagId: flag.id, version: flag.version, body: { resolution_code: 'escalated', note: 'Synthetic note for the lab lead' } });
    expect(r.status).toBe(200);
    expect(schemaErrors('VisitFlagDto', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: flag.id, kind: 'held_collection', status: 'resolved', resolution_code: 'escalated', version: flag.version + 1 });
    expect(r.body.resolved_at).toBeTruthy();
    const row = (await flagsOf(v.id)).find((f) => f.id === flag.id);
    expect(row).toMatchObject({ status: 'resolved', resolution_code: 'escalated', resolution_note: 'Synthetic note for the lab lead' });
    expect(row.resolved_at).not.toBeNull();
  });
  it('already resolved -> 409 common.version_conflict; nothing changes', { timeout: T }, async () => {
    const v = await bookingVisit({}, 'a', NEAR); const flag = await openFlag(v.id, 'missed');
    await resolveFlag({ visitId: v.id, flagId: flag.id, version: flag.version, body: { resolution_code: 'handled' } });
    const e = await failure(resolveFlag({ visitId: v.id, flagId: flag.id, version: flag.version, body: { resolution_code: 'not_needed' } }));
    expect(e.code).toBe('common.version_conflict');
    expect(e.statusCode).toBe(409);
    expect((await flagsOf(v.id)).find((f) => f.id === flag.id)).toMatchObject({ status: 'resolved', resolution_code: 'handled' });
  });
  it('two dispatchers resolving the same flag at once: one 200, one 409 common.version_conflict', { timeout: T }, async () => {
    const v = await bookingVisit({}, 'a', NEAR); const flag = await openFlag(v.id, 'missed');
    const res = await Promise.allSettled(['handled', 'not_needed'].map((c) => resolveFlag({ visitId: v.id, flagId: flag.id, version: flag.version, body: { resolution_code: c } })));
    expect(res.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    expect((res.find((s) => s.status === 'rejected') as PromiseRejectedResult).reason.code).toBe('common.version_conflict');
  });
  it("a flag of ANOTHER visit under this visit's path is 404 common.not_found (no cross-visit resolve)", { timeout: T }, async () => {
    const [v1, v2] = [await bookingVisit({}, 'a', NEAR), await bookingVisit({}, 'a', NEAR)]; const flag = await openFlag(v2.id, 'missed');
    const e = await failure(resolveFlag({ visitId: v1.id, flagId: flag.id, version: flag.version, body: { resolution_code: 'handled' } }));
    expect(e.code).toBe('common.not_found');
    expect((await flagsOf(v2.id))[0]).toMatchObject({ status: 'open' });
  });
  it.each<[string, unknown]>([
    ['resolution_code missing', {}],
    ['resolution_code outside flag_resolutions', { resolution_code: 'whatever' }],
    ['note 501 chars', { resolution_code: 'handled', note: 'x'.repeat(501) }],
    ['unknown field status', { resolution_code: 'handled', status: 'open' }],
  ])('400 common.validation_failed: %s', { timeout: T }, async (_n, b) => {
    const v = await bookingVisit({}, 'a', NEAR); const flag = await openFlag(v.id, 'missed');
    const e = await failure(resolveFlag({ visitId: v.id, flagId: flag.id, version: flag.version, body: b }));
    expect(e.code).toBe('common.validation_failed');
    expect((await flagsOf(v.id))[0]).toMatchObject({ status: 'open', version: flag.version });
  });
});

describe('security (07-SECURITY §4/§5): permission homecollection.visit.assign, tenant from claims, If-Match, no writes on refusal', () => {
  const calls: Array<[string, (v: any, who: any, bypass?: boolean) => Promise<unknown>]> = [
    ['H4 unassign', (v, who, bypass) => unassign({ visitId: v.id, version: v.version, body: { reason_code: 'reschedule' }, who, ...(bypass ? { bypassRls: true } : {}) })],
    ['H5 schedule', (v, who, bypass) => schedule({ visitId: v.id, version: v.version, body: win(), who, ...(bypass ? { bypassRls: true } : {}) })],
    ['H6 cancel', (v, who, bypass) => cancel({ visitId: v.id, version: v.version, body: { reason_code: 'patient_request' }, who, ...(bypass ? { bypassRls: true } : {}) })],
  ];
  for (const [name, call] of calls) {
    it(`${name}: 403 auth.forbidden for a phlebotomist / no grants; 404 common.not_found across tenants (RLS on and off); version unchanged`, { timeout: T }, async () => {
      const { visit } = await assignedVisit({ date: D() });
      for (const who of [PHLEBO, NOBODY]) expect((await failure(call(visit, who))).code).toBe('auth.forbidden');
      for (const bypass of [false, true]) expect((await failure(call(visit, DISPATCHER_B, bypass))).code).toBe('common.not_found');
      expect(await visitRow(visit.id)).toMatchObject({ status: 'assigned', version: visit.version });
    });
    it(`${name}: If-Match missing -> 428 common.precondition_required; stale -> 409 common.version_conflict`, { timeout: T }, async () => {
      const { visit } = await assignedVisit({ date: D() });
      const op = name.startsWith('H4') ? 'unassignHomeVisit' : name.startsWith('H5') ? 'scheduleHomeVisit' : 'cancelHomeVisit';
      const b = name.startsWith('H4') ? { reason_code: 'reschedule' } : name.startsWith('H5') ? win() : { reason_code: 'patient_request' };
      const none = await failure(dop(op, req({ params: { visit_id: visit.id }, headers: {}, body: b }), DISPATCHER));
      expect(none.code).toBe('common.precondition_required');
      const stale = await failure(call({ ...visit, version: visit.version + 5 }, DISPATCHER));
      expect(stale.code).toBe('common.version_conflict');
      expect(await visitRow(visit.id)).toMatchObject({ status: 'assigned', version: visit.version });
    });
  }
  it('H8: 403 without assign; 404 across tenants', { timeout: T }, async () => {
    const v = await bookingVisit({}, 'a', NEAR); const flag = await openFlag(v.id, 'missed');
    expect((await failure(resolveFlag({ visitId: v.id, flagId: flag.id, version: flag.version, body: { resolution_code: 'handled' }, who: PHLEBO }))).code).toBe('auth.forbidden');
    expect((await failure(resolveFlag({ visitId: v.id, flagId: flag.id, version: flag.version, body: { resolution_code: 'handled' }, who: DISPATCHER_B }))).code).toBe('common.not_found');
    expect((await flagsOf(v.id))[0]).toMatchObject({ status: 'open' });
  });
  it('a visit id that is not a uuid -> 400, an unknown one -> 404, in every action', { timeout: T }, async () => {
    for (const call of [unassign, schedule, cancel]) {
      expect((await failure(call({ visitId: "1' OR '1'='1", version: 1, body: { reason_code: 'reschedule', ...win() } }))).code).toBe('common.validation_failed');
      expect((await failure(call({ visitId: uid(), version: 1, body: { reason_code: 'reschedule', ...win() } }))).code).toMatch(/^common\.(not_found|validation_failed)$/);
    }
  });
  it('REQ-SEC-081: no address / note in the logs of a schedule', { timeout: T }, async () => {
    const v = await frontDeskVisit({}, 'a', NEAR);
    const r = await schedule({ visitId: v.id, version: v.version, body: { ...win(), address: { address_text: 'Synthetic Ward 99 secret lane' }, note_for_phlebotomist: 'Synthetic gate code 4242' } });
    expect(r.probe.logs.join('\n')).not.toMatch(/secret lane|4242|Ward 99/);
  });
});
