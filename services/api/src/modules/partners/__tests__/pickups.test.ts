// C13 T15 — pickups (06-IMPLEMENTATION-PLAN row T15). Tests: unit (state matrix) + integration (in-memory SQL world, real concurrency) + probes. ACs: US-10.1 – US-10.5.
// done_when: "window rules; one open pickup per manifest (concurrent create test); state machine; manifest in_transit_at".
// Spec: 02-TRD §5.2 K1-K4, §5.3 SP1-SP4, §10.2 pickup_max_days_ahead, §10 permissions; 03-APP-FLOW §2.3 (pickup table), §2.1 MS5 (detach), §4.5 (K1 FOR UPDATE);
//       05-SCHEMA §3.6 (pickup_requests, pickup_request_manifests, is_open), §7 coded sets; 07-SECURITY AB2, AB3, AB11, ST7; contracts/openapi/partners.yaml.
// LEAD DECISION LD-140 (UI only) does not apply: backend task.
// Handlers are exercised through manifest.handlers[operationId]; the service is ../service/pickup.service.ts. Fixture + SQL subset: pickup.world.ts (header).
// SEAMS (spec does not fix them; the writer follows them or disputes):
//  - Order: actor type -> IdentityPort.assertRole (K1/K4 partners.pickup.request; K2/K3 partners.order.read; SP1-SP4 partners.pickup.manage) FIRST ->
//    partnerContext.require (partner callers; partner_id never read from the body) -> body / If-Match validation -> lock row -> transition -> store.
//  - If-Match `"<version>"`: absent 428 common.precondition_required, malformed 400 common.validation_failed, stale 409 common.version_conflict (checked on the row found by id in the
//    caller's scope, so another partner's / tenant's / centre's pickup is 404 first). Unknown body / query key -> 400 common.validation_failed. Null columns are omitted from DTOs.
//  - K1: SELECT … FROM partners.manifests … FOR UPDATE for the requested ids, THEN (after the locks) SELECT of open links (partners.pickup_request_manifests, is_open = true); the unique-index
//    error 23505 is mapped to 422 partners.pickup_invalid. pickup_max_days_ahead comes from partners.settings (single-table SELECT, tenant scoped; no row = 7), not from IdentityPort.
//    A manifest of another partner / tenant (or unknown) is 404 common.not_found for the whole request; state / window / centre / double-booking rules are 422 partners.pickup_invalid.
//  - Lists (K2, SP1): single-table SELECTs (pickups; then links `is_open` of those ids; then manifests for manifest_no; SP1 also partners for the partner block). No JOIN / sub-select.
//  - SP3: manifests' in_transit_at = the pickup's picked_up_at, for the pickup's open links only (a detached manifest is not marked); manifest.state is not changed.
//    picked_up_at in the future -> 400 common.validation_failed (SP3 lists no 422).
//  - K4 / SP3 / SP4 set resolved_at = ctx.now(), resolved_by = actor id and close (is_open = false) the pickup's links; SP2 leaves links open.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LimsError } from '../../../core/errors.js';
import { manifest } from '../index.js';
import { C, DAY, HOUR, id, iso, makeCtx, makeWorld, MF, NOW, NOW_MS, P, PK, STAFFS, T_A, T_B, U, type Opts, type Who, type World } from './pickup.world.js';

vi.mock('../service/partner-context.service.js', () => ({
  partnerContext: { require: (c: any) => c.__require(c), load: (c: any) => c.__require(c) },
}));

const PR_KEYS = ['id', 'state', 'window_start', 'window_end', 'packages_count', 'notes', 'contact_name', 'contact_phone_e164', 'manifests', 'scheduled_start', 'scheduled_end',
  'assignee_text', 'picked_up_at', 'reject_reason_code', 'cancel_reason_code', 'created_at', 'version'];
const PR_REQUIRED = ['id', 'state', 'window_start', 'window_end', 'packages_count', 'manifests', 'created_at', 'version'];
const ifm = (v: number | string) => ({ 'if-match': typeof v === 'number' ? `"${v}"` : v });
const req = (o: Partial<{ params: object; query: object; headers: object; body: unknown }> = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });

async function call(w: World, op: string, who: Who, r: ReturnType<typeof req>, over: Opts = {}) {
  const { ctx, finish } = makeCtx(w, who, over);
  try {
    const res = (await manifest.handlers[op]!(r as any, ctx)) as { status: number; body: any };
    finish(true);
    return res;
  } catch (e) { finish(false); throw e; } // the pipeline rolls the request tx back on any error
}
async function fails(p: Promise<unknown>, code: string, status?: number) {
  const e: any = await p.then(() => { throw new Error('expected rejection'); }, (x) => x);
  expect(e, String(e?.message)).toBeInstanceOf(LimsError);
  expect(e.code).toBe(code);
  if (status) expect(e.statusCode).toBe(status);
  return e as LimsError;
}
const untouched = (w: World) => expect(w.writes()).toEqual([]);
const dto = (b: any, admin = false) => {
  const keys = admin ? [...PR_KEYS, 'partner'] : PR_KEYS;
  expect(Object.keys(b).every((k) => keys.includes(k)), JSON.stringify(Object.keys(b))).toBe(true);
  for (const k of admin ? [...PR_REQUIRED, 'partner'] : PR_REQUIRED) expect(b, k).toHaveProperty(k);
  expect(Array.isArray(b.manifests)).toBe(true);
  for (const m of b.manifests) expect(Object.keys(m).sort()).toEqual(['id', 'manifest_no']);
  expect(Object.values(b).includes(null)).toBe(false);
};
const leaks = (x: unknown, needles: string[]) => {
  const plain = x instanceof Error ? Object.fromEntries(Object.getOwnPropertyNames(x).map((k) => [k, (x as any)[k]])) : x;
  const hay = JSON.stringify(plain).toLowerCase();
  return needles.filter((n) => hay.includes(n.toLowerCase()));
};
const without = (o: Record<string, unknown>, k: string) => { const c = { ...o }; delete c[k]; return c; };
const k1 = (o: Record<string, unknown> = {}) => ({ manifest_ids: [MF.m1], window_start: iso(NOW_MS + HOUR), window_end: iso(NOW_MS + 5 * HOUR), packages_count: 2, ...o });
const create = (w: World, b: unknown, who: Who = 'adminX', over: Opts = {}) => call(w, 'createPickupRequest', who, req({ body: b }), over);
const pkp = (pid: string, o: Partial<{ headers: object; body: unknown; query: object }> = {}) => req({ params: { pickup_request_id: pid }, ...o });
const cancel = (w: World, pid: string, v: number | string, b: unknown = { reason_code: 'no_longer_needed' }, who: Who = 'adminX', over: Opts = {}) =>
  call(w, 'cancelPickupRequest', who, pkp(pid, { headers: ifm(v), body: b }), over);
const SCHED = { scheduled_start: iso(NOW_MS + DAY), scheduled_end: iso(NOW_MS + DAY + 2 * HOUR), assignee_text: 'Synthetic Rider Two' };
const schedule = (w: World, pid: string, v: number | string, b: unknown = SCHED, who: Who = 'staff', over: Opts = {}) =>
  call(w, 'schedulePickup', who, pkp(pid, { headers: ifm(v), body: b }), over);
const collect = (w: World, pid: string, v: number | string, b: unknown = undefined, who: Who = 'staff', over: Opts = {}) =>
  call(w, 'markPickupCollected', who, pkp(pid, { headers: ifm(v), body: b }), over);
const reject = (w: World, pid: string, v: number | string, b: unknown = { reason_code: 'no_rider_available' }, who: Who = 'staff', over: Opts = {}) =>
  call(w, 'rejectPickup', who, pkp(pid, { headers: ifm(v), body: b }), over);
const ids = (r: { body: any }) => r.body.data.map((x: any) => x.id);

describe('T15 wiring', () => {
  it('service file exists', () => {
    expect(existsSync(join(__dirname, '..', 'service', 'pickup.service.ts'))).toBe(true);
  });
  it('static: SQL is parameterised (no template-literal interpolation in query text), no commitOnError, no console logging', () => {
    const src = readFileSync(join(__dirname, '..', 'service', 'pickup.service.ts'), 'utf8');
    expect(/query\(\s*`[^`]*\$\{/.test(src)).toBe(false);
    expect(src).not.toContain('commitOnError');
    expect(src).not.toMatch(/console\.(log|info|debug)/);
  });
  it('the eight operations are implemented (no stub: 501 / common.internal)', async () => {
    const w = makeWorld();
    for (const [op, who, r] of [['listPickupRequests', 'adminX', req()], ['getPickupRequest', 'adminX', pkp(PK.req)], ['listInboundPickups', 'staff', req()]] as const) {
      const res = await call(w, op, who, r);
      expect(res.status, op).toBe(200);
    }
  });
});

// ------------------------------------------------------------------ K1 create
describe('T15 K1 createPickupRequest (US-10.1, US-10.2)', () => {
  it.each(['adminX', 'memberX'] as const)('%s: two submitted manifests -> 201 requested; link rows; manifests untouched; DTO allowlist', async (who) => {
    const w = makeWorld();
    const manifestsBefore = JSON.stringify(w.manifests);
    const r = await create(w, k1({ manifest_ids: [MF.m1, MF.m2], notes: 'Gate 3, ring the bell', contact_name: 'Synthetic Contact', contact_phone_e164: '+15555550123' }), who);
    expect(r.status).toBe(201);
    dto(r.body);
    expect(r.body).toMatchObject({ state: 'requested', packages_count: 2, version: 1, notes: 'Gate 3, ring the bell', contact_name: 'Synthetic Contact', contact_phone_e164: '+15555550123',
      window_start: iso(NOW_MS + HOUR), window_end: iso(NOW_MS + 5 * HOUR) });
    expect(r.body.manifests.map((m: any) => m.id).sort()).toEqual([MF.m1, MF.m2].sort());
    expect(r.body.manifests.find((m: any) => m.id === MF.m1).manifest_no).toBe(w.mf(MF.m1).manifest_no);
    expect(JSON.stringify(r.body)).not.toMatch(/"(tenant_id|partner_id|receiving_centre_id|created_by|resolved_by|resolved_at|is_active)"\s*:/);
    const row = w.pk(r.body.id);
    expect(row).toMatchObject({ state: 'requested', tenant_id: T_A, partner_id: P.X, receiving_centre_id: C.c1, packages_count: 2, version: 1, created_by: U[who], updated_by: U[who],
      scheduled_start: null, picked_up_at: null, cancel_reason_code: null, reject_reason_code: null });
    const links = w.linksOf(row.id);
    expect(links.map((l) => l.manifest_id).sort()).toEqual([MF.m1, MF.m2].sort());
    for (const l of links) expect(l).toMatchObject({ tenant_id: T_A, partner_id: P.X, receiving_centre_id: C.c1, is_open: true, created_by: U[who] });
    expect(JSON.stringify(w.manifests)).toBe(manifestsBefore); // creating a pickup does not touch the manifests
    expect(w.portCalls.find((c) => c.name === 'assertRole')!.input.permission).toBe('partners.pickup.request');
  });
  it('partially_received manifests are allowed; one to twenty manifests', async () => {
    const w = makeWorld();
    expect((await create(w, k1({ manifest_ids: [MF.m3] }))).status).toBe(201);
    const twenty = w.addManifests(20);
    expect((await create(w, k1({ manifest_ids: twenty }))).body.manifests).toHaveLength(20);
  });
  it('optional fields may be omitted: DTO has no notes / contact keys', async () => {
    const w = makeWorld();
    const r = await create(w, k1());
    dto(r.body);
    for (const k of ['notes', 'contact_name', 'contact_phone_e164', 'scheduled_start', 'assignee_text', 'picked_up_at']) expect(r.body).not.toHaveProperty(k);
  });

  it.each([
    ['manifest of partner Y', [MF.y]], ['manifest of tenant B', [MF.b]], ['unknown manifest', [id(9999)]],
    ['valid X manifest + one of Y', [MF.m1, MF.y]], ['valid X manifest + one of tenant B', [MF.m1, MF.b]], ['valid X manifest + unknown', [MF.m1, id(9998)]],
  ])('%s -> 404 common.not_found, whole request rejected, nothing created (US-10.2, AB3)', async (_l, manifest_ids) => {
    for (const noRls of [false, true]) {
      const w = makeWorld();
      const before = w.snapshot();
      await fails(create(w, k1({ manifest_ids }), 'adminX', { noRls }), 'common.not_found', 404);
      expect(w.snapshot(), `noRls=${noRls}`).toBe(before);
      expect(w.openLinks(MF.m1)).toEqual([]);
    }
  });
  it('the 404 body does not reveal the other partner\'s manifest', async () => {
    const w = makeWorld();
    const e = await fails(create(w, k1({ manifest_ids: [MF.y] })), 'common.not_found');
    expect(leaks(e, [w.mf(MF.y).manifest_no, 'Synthetic Partner Y', MF.y, 'submitted'])).toEqual([]);
  });

  it.each([
    ['draft manifest', MF.draft], ['received manifest', MF.received], ['withdrawn manifest', MF.withdrawn],
    ['manifest already on a requested pickup', MF.open], ['manifest already on a scheduled pickup', MF.sch],
  ])('%s -> 422 partners.pickup_invalid', async (_l, mid) => {
    const w = makeWorld();
    const before = w.snapshot();
    await fails(create(w, k1({ manifest_ids: [mid] })), 'partners.pickup_invalid', 422);
    expect(w.snapshot()).toBe(before);
  });
  it('one bad manifest rejects the whole request (m1 valid + draft)', async () => {
    const w = makeWorld();
    const before = w.snapshot();
    await fails(create(w, k1({ manifest_ids: [MF.m1, MF.draft] })), 'partners.pickup_invalid', 422);
    expect(w.snapshot()).toBe(before);
  });
  it('manifests of two receiving centres -> 422 partners.pickup_invalid (03-APP-FLOW 4.5); same non-default centre is fine', async () => {
    const w = makeWorld();
    await fails(create(w, k1({ manifest_ids: [MF.m1, MF.c2] })), 'partners.pickup_invalid', 422);
    const r = await create(w, k1({ manifest_ids: [MF.c2] }));
    expect(w.pk(r.body.id).receiving_centre_id).toBe(C.c2);
  });
  it('a manifest on a cancelled / rejected / picked-up pickup (link closed) can be requested again', async () => {
    const w = makeWorld();
    for (const mid of [MF.canc, MF.rej]) expect((await create(w, k1({ manifest_ids: [mid] }))).status).toBe(201);
  });
  it('a detached manifest (is_open = false on a still-open pickup, MS5) can join a new pickup', async () => {
    const w = makeWorld();
    const r = await create(w, k1({ manifest_ids: [MF.detached] }));
    expect(r.status).toBe(201);
    expect(w.openLinks(MF.detached)).toHaveLength(1);
    expect(w.linksOf(PK.two).find((l) => l.manifest_id === MF.detached)!.is_open).toBe(false); // old link row is never deleted
  });
  it('duplicate ids in manifest_ids: rejected as a validation error or de-duplicated, never two links / a 500', async () => {
    const w = makeWorld();
    const r: any = await create(w, k1({ manifest_ids: [MF.m1, MF.m1] })).catch((e) => e);
    if (r instanceof LimsError) expect(['common.validation_failed', 'partners.pickup_invalid']).toContain(r.code);
    else expect(r.status).toBe(201);
    expect(w.openLinks(MF.m1).length).toBeLessThanOrEqual(1);
  });

  describe('window rules', () => {
    const win = (s: number, e: number) => k1({ window_start: iso(s), window_end: iso(e) });
    it.each([
      ['start = now - 1 h (boundary), end = now + 7 d (boundary)', NOW_MS - HOUR, NOW_MS + 7 * DAY],
      ['start just before end (1 ms)', NOW_MS + HOUR, NOW_MS + HOUR + 1],
      ['start in the future, end = now + 7 d', NOW_MS + 6 * DAY, NOW_MS + 7 * DAY],
    ])('accepted: %s', async (_l, s, e) => {
      const w = makeWorld();
      expect((await create(w, win(s, e))).status).toBe(201);
    });
    it.each([
      ['start = end', NOW_MS + HOUR, NOW_MS + HOUR],
      ['start > end', NOW_MS + 2 * HOUR, NOW_MS + HOUR],
      ['start 1 ms earlier than now - 1 h', NOW_MS - HOUR - 1, NOW_MS + HOUR],
      ['start days in the past', NOW_MS - 3 * DAY, NOW_MS + HOUR],
      ['end 1 ms later than now + 7 d', NOW_MS + HOUR, NOW_MS + 7 * DAY + 1],
      ['end 8 days ahead', NOW_MS + HOUR, NOW_MS + 8 * DAY],
    ])('rejected: %s -> 422 partners.pickup_invalid', async (_l, s, e) => {
      const w = makeWorld();
      const before = w.snapshot();
      await fails(create(w, win(s, e)), 'partners.pickup_invalid', 422);
      expect(w.snapshot()).toBe(before);
    });
    it('pickup_max_days_ahead comes from the tenant\'s partners.settings row (3 -> now + 3 d ok, + 1 ms refused; 30 -> now + 30 d ok); the default is 7; another tenant\'s row is ignored', async () => {
      const w = makeWorld();
      w.settings.push({ tenant_id: T_B, pickup_max_days_ahead: 1 }); // tenant B's row must not apply to tenant A
      expect((await create(w, k1({ window_end: iso(NOW_MS + 7 * DAY) }))).status).toBe(201);
      w.settings.push({ tenant_id: T_A, pickup_max_days_ahead: 3 });
      expect((await create(w, k1({ manifest_ids: [MF.m2], window_end: iso(NOW_MS + 3 * DAY) }))).status).toBe(201);
      await fails(create(w, k1({ manifest_ids: [MF.m3], window_end: iso(NOW_MS + 3 * DAY + 1) })), 'partners.pickup_invalid', 422);
      w.settings.find((s) => s.tenant_id === T_A)!.pickup_max_days_ahead = 30;
      expect((await create(w, k1({ manifest_ids: [MF.m3], window_end: iso(NOW_MS + 30 * DAY) }))).status).toBe(201);
      expect(JSON.stringify(w.portCalls)).not.toContain('pickup_max'); // D-119: partner requests read only timezone / calendarDisplay from IdentityPort
    });
    it('the window is judged against ctx.now(), not the wall clock', async () => {
      const w = makeWorld();
      const later = iso(NOW_MS + 30 * DAY);
      expect((await create(w, k1({ window_start: iso(NOW_MS + 30 * DAY), window_end: iso(NOW_MS + 30 * DAY + HOUR) }), 'adminX', { now: later })).status).toBe(201);
    });
  });

  it.each([
    ['manifest_ids missing', (b: any) => without(b, 'manifest_ids')], ['manifest_ids []', () => k1({ manifest_ids: [] })], ['manifest_ids 21', () => k1({ manifest_ids: Array.from({ length: 21 }, (_, i) => id(8000 + i)) })],
    ['manifest_ids string', () => k1({ manifest_ids: MF.m1 })], ['manifest_ids [123]', () => k1({ manifest_ids: [123] })], ['manifest_ids not uuid', () => k1({ manifest_ids: ['not-a-uuid'] })],
    ['window_start missing', (b: any) => without(b, 'window_start')], ['window_end missing', (b: any) => without(b, 'window_end')],
    ['window_start free text', () => k1({ window_start: 'tomorrow' })], ['window_start date only', () => k1({ window_start: '2026-11-14' })],
    ['window_start without ms', () => k1({ window_start: '2026-11-13T05:00:00Z' })], ['window_start with +05:45 offset', () => k1({ window_start: '2026-11-13T10:45:00.000+05:45' })],
    ['window_start number', () => k1({ window_start: NOW_MS })], ['window_end null', () => k1({ window_end: null })],
    ['packages_count missing', (b: any) => without(b, 'packages_count')], ['packages_count 0', () => k1({ packages_count: 0 })], ['packages_count 51', () => k1({ packages_count: 51 })],
    ['packages_count 1.5', () => k1({ packages_count: 1.5 })], ['packages_count "2"', () => k1({ packages_count: '2' })], ['packages_count null', () => k1({ packages_count: null })],
    ['notes 501 chars', () => k1({ notes: 'n'.repeat(501) })], ['notes number', () => k1({ notes: 5 })], ['contact_name 81 chars', () => k1({ contact_name: 'c'.repeat(81) })],
    ['contact_phone local format', () => k1({ contact_phone_e164: '9841000000' })], ['contact_phone +0…', () => k1({ contact_phone_e164: '+0123456789' })], ['contact_phone too long', () => k1({ contact_phone_e164: '+1234567890123456' })],
    ['partner_id in body (AB2)', () => k1({ partner_id: P.Y })], ['tenant_id in body', () => k1({ tenant_id: T_B })], ['state in body', () => k1({ state: 'picked_up' })],
    ['receiving_centre_id in body', () => k1({ receiving_centre_id: C.c2 })], ['scheduled_start in body (AB11)', () => k1({ scheduled_start: iso(NOW_MS + HOUR) })],
    ['assignee_text in body (AB11)', () => k1({ assignee_text: 'me' })], ['picked_up_at in body (AB11)', () => k1({ picked_up_at: iso(NOW_MS) })], ['version in body', () => k1({ version: 5 })],
    ['id in body', () => k1({ id: id(7000) })], ['created_by in body', () => k1({ created_by: U.adminY })],
    ['body null', () => null], ['body array', () => [k1()]], ['body string', () => 'x'], ['body undefined', () => undefined],
  ])('validation: %s -> 400 common.validation_failed (before any lookup)', async (_l, make) => {
    const w = makeWorld();
    await fails(create(w, (make as (b: any) => unknown)(k1())), 'common.validation_failed', 400);
    untouched(w);
  });

  it('gate: staff token -> 403 auth.forbidden (US-15.4) before any SQL; suspended partner -> partners.partner_inactive; denied permission -> 403', async () => {
    const w = makeWorld();
    await fails(create(w, k1(), 'staff'), 'auth.forbidden', 403);
    await fails(create(w, k1(), 'adminZ'), 'partners.partner_inactive');
    await fails(create(w, k1(), 'adminX', { deny: 'partners.pickup.request' }), 'auth.forbidden', 403);
    expect(w.sql).toEqual([]);
  });
  it('contact data and notes never appear in logs or error bodies; SQL text carries no user text (injection stays a bound parameter)', async () => {
    const w = makeWorld();
    const evil = "x'); DROP TABLE partners.pickup_requests;--";
    await create(w, k1({ notes: evil, contact_name: 'Synthetic Contact', contact_phone_e164: '+15555550123' }));
    expect(w.pk(w.pickups.at(-1)!.id).notes).toBe(evil);
    expect(w.sql.every((s) => !s.text.includes('DROP TABLE'))).toBe(true);
    const e = await create(w, k1({ manifest_ids: [MF.draft], contact_name: 'Synthetic Contact', contact_phone_e164: '+15555550123', notes: 'Synthetic gate note' })).catch((x) => x);
    expect(leaks(e, ['Synthetic Contact', '+15555550123', 'Synthetic gate note'])).toEqual([]);
    expect(leaks(w.logs, ['Synthetic Contact', '+15555550123', evil])).toEqual([]);
  });
  it('the manifests SELECT takes row locks (FOR UPDATE) before the open-link check (03-APP-FLOW 4.5)', async () => {
    const w = makeWorld();
    await create(w, k1({ manifest_ids: [MF.m1, MF.m2] }));
    const sels = w.sql.filter((q) => /^\s*SELECT/i.test(q.text));
    const lockAt = sels.findIndex((q) => /partners\.manifests/i.test(q.text) && /FOR UPDATE/i.test(q.text));
    const linkAt = sels.findIndex((q) => /partners\.pickup_request_manifests/i.test(q.text));
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(linkAt).toBeGreaterThan(lockAt);
    expect(sels.every((q) => /tenant_id/i.test(q.text) || /g_cs_reasons/i.test(q.text))).toBe(true); // every read is tenant scoped
  });
});

// ------------------------------------------------------------------ one open pickup per manifest (concurrent)
describe('T15 one open pickup per manifest under concurrency (done_when)', () => {
  it.each([false, true])('two simultaneous K1 for the same manifest: exactly one 201, the other 422 partners.pickup_invalid; one open link (noUniqueIndex=%s)', async (noUniqueIndex) => {
    const w = makeWorld();
    const n0 = w.pickups.length;
    const res = await Promise.allSettled([create(w, k1(), 'adminX', { noUniqueIndex }), create(w, k1(), 'memberX', { noUniqueIndex })]);
    const ok = res.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
    const bad = res.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok, JSON.stringify(res.map((r) => (r.status === 'rejected' ? String(r.reason?.code ?? r.reason) : 'ok')))).toHaveLength(1);
    expect(ok[0]!.value.status).toBe(201);
    expect(bad[0]!.reason).toBeInstanceOf(LimsError);
    expect(bad[0]!.reason.code).toBe('partners.pickup_invalid');
    expect(w.openLinks(MF.m1)).toHaveLength(1);
    expect(w.pickups.length).toBe(n0 + 1); // the loser's pickup row was rolled back
    expect(w.links.filter((l) => l.manifest_id === MF.m1 && l.is_open && l.pickup_request_id !== ok[0]!.value.body.id)).toEqual([]);
  });
  it('five simultaneous K1 for one manifest: exactly one wins', async () => {
    const w = makeWorld();
    const res = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => create(w, k1(), i % 2 ? 'adminX' : 'memberX')));
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of res) if (r.status === 'rejected') expect(r.reason.code).toBe('partners.pickup_invalid');
    expect(w.openLinks(MF.m1)).toHaveLength(1);
  });
  it('overlapping requests with the manifests in opposite order: no deadlock (no 40P01 / 500), exactly one wins, no manifest on two open pickups', async () => {
    const w = makeWorld();
    const res = await Promise.allSettled([create(w, k1({ manifest_ids: [MF.m1, MF.m2] })), create(w, k1({ manifest_ids: [MF.m2, MF.m1] }), 'memberX')]);
    const codes = res.map((r) => (r.status === 'rejected' ? r.reason?.code : 'ok'));
    expect(codes.sort(), JSON.stringify(codes)).toEqual(['ok', 'partners.pickup_invalid']);
    for (const m of [MF.m1, MF.m2]) expect(w.openLinks(m)).toHaveLength(1);
  });
  it('requests for different manifests do not block or reject each other', async () => {
    const w = makeWorld();
    const res = await Promise.all([create(w, k1({ manifest_ids: [MF.m1] })), create(w, k1({ manifest_ids: [MF.m2] }), 'memberX'), create(w, k1({ manifest_ids: [MF.m4] }))]);
    expect(res.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(new Set(res.map((r) => r.body.id)).size).toBe(3);
  });
  it('a cancel racing a new K1: afterwards the manifest is on at most one open pickup', async () => {
    const w = makeWorld();
    const res = await Promise.allSettled([cancel(w, PK.req, 1), create(w, k1({ manifest_ids: [MF.open] }), 'memberX')]);
    expect(res[0]!.status).toBe('fulfilled');
    expect(w.openLinks(MF.open).length).toBeLessThanOrEqual(1);
    if (res[1]!.status === 'rejected') expect((res[1] as PromiseRejectedResult).reason.code).toBe('partners.pickup_invalid');
  });
  it('a partner cancel racing the staff pick-up of the same pickup version: one wins, the other is 409; the end state is consistent', async () => {
    const w = makeWorld();
    const res = await Promise.allSettled([cancel(w, PK.sch, 2), collect(w, PK.sch, 2)]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(['common.version_conflict', 'partners.pickup_invalid_transition']).toContain(lost.reason.code);
    expect(lost.reason.statusCode).toBe(409);
    const row = w.pk(PK.sch);
    expect(['cancelled', 'picked_up']).toContain(row.state);
    expect(row.version).toBe(3);
    expect(w.openLinks(MF.sch)).toEqual([]);
    expect(w.mf(MF.sch).in_transit_at).toBe(row.state === 'picked_up' ? row.picked_up_at : null);
  });
});

// ------------------------------------------------------------------ K2 / K3
describe('T15 K2 listPickupRequests + K3 getPickupRequest', () => {
  const X_ALL = [PK.two, PK.c2, PK.rej, PK.canc, PK.picked, PK.sch, PK.req]; // default sort -created_at
  it.each(['adminX', 'memberX'] as const)('%s lists the 7 pickups of partner X only, newest first; nothing of Y or tenant B (RLS on and off)', async (who) => {
    for (const noRls of [false, true]) {
      const w = makeWorld();
      const r = await call(w, 'listPickupRequests', who, req(), { noRls });
      expect(r.status).toBe(200);
      expect(ids(r), `noRls=${noRls}`).toEqual(X_ALL);
      for (const x of r.body.data) dto(x);
      expect(r.body.page).toBeTruthy();
      expect(w.portCalls.find((c) => c.name === 'assertRole')!.input.permission).toBe('partners.order.read');
      expect(JSON.stringify(r.body)).not.toContain(PK.y);
      untouched(w);
    }
  });
  it('manifests of a non-terminal pickup are its open links only (a detached manifest is not listed)', async () => {
    const w = makeWorld();
    const r = await call(w, 'listPickupRequests', 'adminX', req());
    const two = r.body.data.find((x: any) => x.id === PK.two);
    expect(two.manifests).toEqual([{ id: MF.two, manifest_no: w.mf(MF.two).manifest_no }]);
    expect(r.body.data.find((x: any) => x.id === PK.req).manifests).toEqual([{ id: MF.open, manifest_no: w.mf(MF.open).manifest_no }]);
  });
  it('the partner sees the scheduled time and assignee (US-10.3) and the reasons of closed pickups', async () => {
    const w = makeWorld();
    const r = await call(w, 'listPickupRequests', 'memberX', req());
    const by = (pid: string) => r.body.data.find((x: any) => x.id === pid);
    expect(by(PK.sch)).toMatchObject({ state: 'scheduled', scheduled_start: iso(NOW_MS + DAY + HOUR), scheduled_end: iso(NOW_MS + DAY + 2 * HOUR), assignee_text: 'Synthetic Rider', version: 2 });
    expect(by(PK.canc)).toMatchObject({ state: 'cancelled', cancel_reason_code: 'no_longer_needed' });
    expect(by(PK.rej)).toMatchObject({ state: 'rejected', reject_reason_code: 'no_rider_available' });
    expect(by(PK.picked)).toMatchObject({ state: 'picked_up', picked_up_at: '2026-11-12T04:00:00.000Z' });
    expect(by(PK.req)).toMatchObject({ notes: 'Synthetic gate note', contact_name: 'Synthetic Contact', contact_phone_e164: '+15555550123' });
    expect(by(PK.req)).not.toHaveProperty('scheduled_start');
  });
  it('filters and sort: state csv, window_start sort', async () => {
    const w = makeWorld();
    const q = async (query: object) => ids(await call(w, 'listPickupRequests', 'adminX', req({ query })));
    expect(await q({ state: 'requested' })).toEqual([PK.two, PK.c2, PK.req]);
    expect((await q({ state: 'requested,scheduled' })).sort()).toEqual([PK.two, PK.c2, PK.sch, PK.req].sort());
    expect((await q({ state: 'cancelled,rejected,picked_up' })).sort()).toEqual([PK.rej, PK.canc, PK.picked].sort());
    expect(await q({ sort: 'window_start' })).toEqual([PK.picked, PK.two, PK.sch, PK.req, PK.canc, PK.rej, PK.c2]);
    expect(await q({ sort: '-created_at' })).toEqual(X_ALL);
  });
  it('cursor paging walks all rows once: limit 3 -> 3 pages, no duplicates, last page has no next_cursor; garbage cursor -> 400 common.invalid_cursor', async () => {
    const w = makeWorld();
    const seen: string[] = []; let cursor: string | undefined; let pages = 0;
    do {
      const r = await call(w, 'listPickupRequests', 'adminX', req({ query: { limit: 3, ...(cursor ? { cursor } : {}) } }));
      seen.push(...ids(r)); pages++; cursor = r.body.page.next_cursor;
      expect(r.body.data.length).toBeLessThanOrEqual(3);
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual(X_ALL);
    await fails(call(w, 'listPickupRequests', 'adminX', req({ query: { cursor: 'AAAA' } })), 'common.invalid_cursor', 400);
  });
  it.each([['state bogus', { state: 'bogus' }], ['state trailing comma', { state: 'requested,' }], ['sort bogus', { sort: 'partner_id' }], ['limit 0', { limit: 0 }], ['limit 201', { limit: 201 }],
    ['unknown key partner_id (AB2)', { partner_id: P.Y }]])('list validation: %s -> 400', async (_l, query) => {
    const w = makeWorld();
    await fails(call(w, 'listPickupRequests', 'adminX', req({ query })), 'common.validation_failed', 400);
    expect(w.sql).toEqual([]);
  });
  it('gate: staff -> 403 before SQL; suspended partner -> partners.partner_inactive; q with LIKE / SQL text is not a feature (unknown key 400)', async () => {
    const w = makeWorld();
    await fails(call(w, 'listPickupRequests', 'staff', req()), 'auth.forbidden', 403);
    await fails(call(w, 'getPickupRequest', 'staff', pkp(PK.req)), 'auth.forbidden', 403);
    await fails(call(w, 'listPickupRequests', 'adminZ', req()), 'partners.partner_inactive');
    expect(w.sql).toEqual([]);
  });

  it.each(['adminX', 'memberX'] as const)('K3 %s reads an own pickup (200, DTO)', async (who) => {
    const w = makeWorld();
    const r = await call(w, 'getPickupRequest', who, pkp(PK.sch));
    expect(r.status).toBe(200);
    dto(r.body);
    expect(r.body).toMatchObject({ id: PK.sch, state: 'scheduled', version: 2, manifests: [{ id: MF.sch, manifest_no: w.mf(MF.sch).manifest_no }] });
    expect(w.portCalls.find((c) => c.name === 'assertRole')!.input.permission).toBe('partners.order.read');
  });
  it.each([['partner Y\'s pickup', PK.y], ['tenant B\'s pickup', PK.b], ['unknown id', id(9000)]])('K3 %s -> 404 common.not_found (US-15.1/15.2), RLS on and off', async (_l, pid) => {
    for (const noRls of [false, true]) {
      const w = makeWorld();
      const e = await fails(call(w, 'getPickupRequest', 'adminX', pkp(pid), { noRls }), 'common.not_found', 404);
      expect(leaks(e, ['Synthetic Partner Y', 'Synthetic Partner B'])).toEqual([]);
    }
  });
  it('K3 malformed id -> 400', async () => {
    await fails(call(makeWorld(), 'getPickupRequest', 'adminX', pkp('not-a-uuid')), 'common.validation_failed', 400);
  });
});

// ------------------------------------------------------------------ K4 cancel
describe('T15 K4 cancelPickupRequest (US-10.5)', () => {
  it.each([['requested', PK.req, 1, MF.open], ['scheduled', PK.sch, 2, MF.sch]] as const)('%s -> cancelled: reason, resolved_*, links closed, manifests untouched, version + 1', async (_s, pid, v, mid) => {
    const w = makeWorld();
    const manifestsBefore = JSON.stringify(w.manifests);
    const r = await cancel(w, pid, v, { reason_code: 'will_deliver_ourselves' }, 'memberX');
    expect(r.status).toBe(200);
    dto(r.body);
    expect(r.body).toMatchObject({ id: pid, state: 'cancelled', cancel_reason_code: 'will_deliver_ourselves', version: v + 1 });
    expect(w.pk(pid)).toMatchObject({ state: 'cancelled', cancel_reason_code: 'will_deliver_ourselves', resolved_at: NOW, resolved_by: U.memberX, updated_by: U.memberX, version: v + 1, picked_up_at: null });
    expect(w.linksOf(pid).every((l) => l.is_open === false)).toBe(true);
    expect(w.openLinks(mid)).toEqual([]);
    expect(JSON.stringify(w.manifests)).toBe(manifestsBefore); // no in_transit_at, no state change
    expect(w.portCalls.find((c) => c.name === 'assertRole')!.input.permission).toBe('partners.pickup.request');
  });
  it('after the cancel the manifest can be put on a new pickup (the open-link slot is free)', async () => {
    const w = makeWorld();
    await cancel(w, PK.req, 1);
    expect((await create(w, k1({ manifest_ids: [MF.open] }))).status).toBe(201);
  });
  it.each([['no_longer_needed'], ['will_deliver_ourselves'], ['other']])('cancel reason %s accepted', async (reason_code) => {
    expect((await cancel(makeWorld(), PK.req, 1, { reason_code })).status).toBe(200);
  });
  it.each([['picked_up', PK.picked, 3], ['cancelled', PK.canc, 2], ['rejected', PK.rej, 2]] as const)('%s -> 409 partners.pickup_invalid_transition (US-10.5), no write', async (_s, pid, v) => {
    const w = makeWorld();
    const before = w.snapshot();
    await fails(cancel(w, pid, v), 'partners.pickup_invalid_transition', 409);
    untouched(w);
    expect(w.snapshot()).toBe(before);
  });
  it('If-Match: absent 428, malformed 400, stale 409 common.version_conflict; nothing written', async () => {
    const w = makeWorld();
    await fails(call(w, 'cancelPickupRequest', 'adminX', pkp(PK.req, { body: { reason_code: 'other' } })), 'common.precondition_required', 428);
    for (const bad of ['abc', '"abc"', '"0"', '"-1"', '""']) await fails(cancel(w, PK.req, bad), 'common.validation_failed', 400);
    await fails(cancel(w, PK.req, 7), 'common.version_conflict', 409);
    untouched(w);
  });
  it.each([
    ['reason_code missing', {}], ['reason_code empty', { reason_code: '' }], ['reason_code 65', { reason_code: 'r'.repeat(65) }], ['reason_code number', { reason_code: 5 }],
    ['reason_code not in set', { reason_code: 'not_a_reason' }], ['reason from the reject set', { reason_code: 'outside_service_area' }],
    ['unknown key state (AB11)', { reason_code: 'other', state: 'picked_up' }], ['unknown key picked_up_at', { reason_code: 'other', picked_up_at: iso(NOW_MS) }], ['body null', null], ['body undefined', undefined],
  ])('validation: %s -> 400', async (_l, b) => {
    const w = makeWorld();
    // ruling C13.T15: a JS default param swallows `undefined`; send a truly absent body via call() directly.
    await fails(b === undefined ? call(w, 'cancelPickupRequest', 'adminX', pkp(PK.req, { headers: ifm(1), body: undefined })) : cancel(w, PK.req, 1, b), 'common.validation_failed', 400);
    untouched(w);
  });
  it.each([['partner Y\'s pickup', PK.y], ['tenant B\'s pickup', PK.b], ['unknown id', id(9001)]])('%s -> 404 even with a wrong version (no existence oracle), nothing changed, RLS on and off', async (_l, pid) => {
    for (const noRls of [false, true]) {
      const w = makeWorld();
      const before = w.snapshot();
      await fails(cancel(w, pid, 99, { reason_code: 'other' }, 'adminX', { noRls }), 'common.not_found', 404);
      untouched(w);
      expect(w.snapshot()).toBe(before);
    }
  });
  it('gate: staff -> 403 before SQL; suspended -> partners.partner_inactive; denied permission -> 403', async () => {
    const w = makeWorld();
    await fails(cancel(w, PK.req, 1, undefined, 'staff'), 'auth.forbidden', 403);
    await fails(cancel(w, PK.req, 1, undefined, 'adminZ'), 'partners.partner_inactive');
    await fails(cancel(w, PK.req, 1, undefined, 'adminX', { deny: 'partners.pickup.request' }), 'auth.forbidden', 403);
    expect(w.sql).toEqual([]);
  });
  it('AB11: SQL written under partner claims never touches scheduled_* / assignee_text / picked_up_at / in_transit_at (guard_partner_columns would raise immutable_row)', async () => {
    const w = makeWorld();
    await create(w, k1({ manifest_ids: [MF.m1] }));
    await cancel(w, PK.req, 1);
    const partnerWrites = w.writes().filter((q) => q.actor === 'partner').map((q) => q.text);
    expect(partnerWrites.length).toBeGreaterThan(0);
    expect(partnerWrites.filter((t) => /scheduled_start|scheduled_end|assignee_text|picked_up_at|in_transit_at|partners\.manifests\b/i.test(t))).toEqual([]);
  });
});

// ------------------------------------------------------------------ SP1 list
describe('T15 SP1 listInboundPickups', () => {
  const OPEN_BY_WINDOW = [PK.two, PK.sch, PK.req, PK.y, PK.c2];
  it('all-centre staff: default = requested + scheduled of every partner, sorted by window_start; PickupRequestAdmin DTO with partner block; no tenant B rows', async () => {
    for (const noRls of [false, true]) {
      const w = makeWorld();
      const r = await call(w, 'listInboundPickups', 'staff', req(), { noRls });
      expect(r.status).toBe(200);
      expect(ids(r), `noRls=${noRls}`).toEqual(OPEN_BY_WINDOW);
      for (const x of r.body.data) dto(x, true);
      expect(r.body.data.find((x: any) => x.id === PK.req).partner).toEqual({ id: P.X, partner_code: 'SYN-X', name: 'Synthetic Partner X', contact_phone_e164: '+15555550101', address_text: 'Synthetic address X, Ward 1' });
      expect(r.body.data.find((x: any) => x.id === PK.y).partner).toEqual({ id: P.Y, partner_code: 'SYN-Y', name: 'Synthetic Partner Y' }); // nulls omitted
      expect(r.body.data.find((x: any) => x.id === PK.two).manifests).toEqual([{ id: MF.two, manifest_no: w.mf(MF.two).manifest_no }]);
      expect(w.portCalls.find((c) => c.name === 'assertRole')!.input.permission).toBe('partners.pickup.manage');
      untouched(w);
    }
  });
  it('receiving-centre scoping: staff of c1 sees c1 pickups only, staff of c2 sees c2 only (03-APP-FLOW 4.5, REQ-SEC-017)', async () => {
    const w = makeWorld();
    expect(ids(await call(w, 'listInboundPickups', 'staffC1', req()))).toEqual([PK.two, PK.sch, PK.req, PK.y]);
    expect(ids(await call(w, 'listInboundPickups', 'staffC2', req()))).toEqual([PK.c2]);
    expect(ids(await call(w, 'listInboundPickups', 'staffC1', req({ query: { receiving_centre_id: C.c2 } })))).toEqual([]);
  });
  it('filters: state csv, partner_id, receiving_centre_id, window_start_from/_to, sort -created_at', async () => {
    const w = makeWorld();
    const q = async (query: object, who: Who = 'staff') => ids(await call(w, 'listInboundPickups', who, req({ query })));
    expect((await q({ state: 'picked_up,cancelled,rejected' })).sort()).toEqual([PK.picked, PK.canc, PK.rej].sort());
    expect(await q({ state: 'rejected' })).toEqual([PK.rej]);
    expect(await q({ partner_id: P.Y })).toEqual([PK.y]);
    expect(await q({ receiving_centre_id: C.c2 })).toEqual([PK.c2]);
    expect(await q({ window_start_from: iso(NOW_MS + 36 * HOUR) })).toEqual([PK.req, PK.y, PK.c2]);
    expect(await q({ window_start_to: iso(NOW_MS + 36 * HOUR) })).toEqual([PK.two, PK.sch]);
    expect(await q({ window_start_from: iso(NOW_MS + 2 * DAY), window_start_to: iso(NOW_MS + 2 * DAY) })).toEqual([PK.req]); // inclusive bounds
    expect(await q({ sort: '-created_at' })).toEqual([PK.two, PK.c2, PK.y, PK.sch, PK.req]);
  });
  it('paging: limit 2 over 5 rows -> 3 pages, each row once', async () => {
    const w = makeWorld();
    const seen: string[] = []; let cursor: string | undefined; let pages = 0;
    do {
      const r = await call(w, 'listInboundPickups', 'staff', req({ query: { limit: 2, ...(cursor ? { cursor } : {}) } }));
      seen.push(...ids(r)); pages++; cursor = r.body.page.next_cursor;
    } while (cursor && pages < 10);
    expect(seen).toEqual(OPEN_BY_WINDOW);
    expect(pages).toBe(3);
  });
  it('tenant B staff sees only tenant B pickups (RLS on and off)', async () => {
    for (const noRls of [false, true]) {
      const w = makeWorld();
      expect(ids(await call(w, 'listInboundPickups', 'staffB', req(), { noRls })), `noRls=${noRls}`).toEqual([PK.b]);
    }
  });
  it.each([['state bogus', { state: 'bogus' }], ['partner_id not uuid', { partner_id: 'x' }], ['window_start_from free text', { window_start_from: 'yesterday' }], ['sort bogus', { sort: 'state' }],
    ['unknown key', { tenant_id: T_B }], ['limit 201', { limit: 201 }]])('validation: %s -> 400', async (_l, query) => {
    const w = makeWorld();
    await fails(call(w, 'listInboundPickups', 'staff', req({ query })), 'common.validation_failed', 400);
    expect(w.sql).toEqual([]);
  });
  it('gate: partner token -> 403 before SQL (US-15.3); staff without partners.pickup.manage -> 403', async () => {
    const w = makeWorld();
    await fails(call(w, 'listInboundPickups', 'adminX', req()), 'auth.forbidden', 403);
    await fails(call(w, 'listInboundPickups', 'staffNoManage', req()), 'auth.forbidden', 403);
    expect(w.sql).toEqual([]);
  });
});

// ------------------------------------------------------------------ SP2 / SP3 / SP4
describe('T15 SP2 schedulePickup (US-10.3)', () => {
  it('requested -> scheduled: times + assignee stored, version + 1, links stay open; the partner then sees the scheduled time', async () => {
    const w = makeWorld();
    const manifestsBefore = JSON.stringify(w.manifests);
    const r = await schedule(w, PK.req, 1);
    expect(r.status).toBe(200);
    dto(r.body, true);
    expect(r.body).toMatchObject({ id: PK.req, state: 'scheduled', ...SCHED, version: 2 });
    expect(w.pk(PK.req)).toMatchObject({ state: 'scheduled', ...SCHED, version: 2, updated_by: STAFFS['staff']!.id, resolved_at: null, picked_up_at: null });
    expect(w.openLinks(MF.open)).toHaveLength(1);
    expect(JSON.stringify(w.manifests)).toBe(manifestsBefore);
    expect(w.portCalls.find((c) => c.name === 'assertRole')!.input.permission).toBe('partners.pickup.manage');
    const seen = await call(w, 'getPickupRequest', 'memberX', pkp(PK.req));
    expect(seen.body).toMatchObject({ state: 'scheduled', ...SCHED });
  });
  it('scheduled -> scheduled (reschedule): new times, version + 1 each time', async () => {
    const w = makeWorld();
    const s2 = { scheduled_start: iso(NOW_MS + 2 * DAY), scheduled_end: iso(NOW_MS + 2 * DAY + HOUR), assignee_text: 'Synthetic Rider Three' };
    const r = await schedule(w, PK.sch, 2, s2);
    expect(r.body).toMatchObject({ state: 'scheduled', ...s2, version: 3 });
    expect((await schedule(w, PK.sch, 3, SCHED)).body).toMatchObject({ ...SCHED, version: 4 });
  });
  it.each([['equal', NOW_MS + DAY, NOW_MS + DAY], ['end before start', NOW_MS + DAY + HOUR, NOW_MS + DAY]])('scheduled_start/end %s -> 422 partners.pickup_invalid, nothing written', async (_l, s, e) => {
    const w = makeWorld();
    const before = w.snapshot();
    await fails(schedule(w, PK.req, 1, { ...SCHED, scheduled_start: iso(s), scheduled_end: iso(e) }), 'partners.pickup_invalid', 422);
    expect(w.snapshot()).toBe(before);
  });
  it.each([
    ['scheduled_start missing', without(SCHED, 'scheduled_start')], ['scheduled_end missing', without(SCHED, 'scheduled_end')], ['assignee_text missing', without(SCHED, 'assignee_text')],
    ['scheduled_start free text', { ...SCHED, scheduled_start: 'noon' }], ['scheduled_end without ms', { ...SCHED, scheduled_end: '2026-11-14T05:00:00Z' }],
    ['assignee_text 81 chars', { ...SCHED, assignee_text: 'a'.repeat(81) }], ['assignee_text number', { ...SCHED, assignee_text: 7 }],
    ['unknown key state', { ...SCHED, state: 'picked_up' }], ['unknown key partner_id', { ...SCHED, partner_id: P.Y }], ['unknown key picked_up_at', { ...SCHED, picked_up_at: iso(NOW_MS) }],
    ['body null', null], ['body undefined', undefined],
  ])('validation: %s -> 400', async (_l, b) => {
    const w = makeWorld();
    // ruling C13.T15: bypass the helper's default body so `undefined` really reaches the handler.
    await fails(b === undefined ? call(w, 'schedulePickup', 'staff', pkp(PK.req, { headers: ifm(1), body: undefined })) : schedule(w, PK.req, 1, b), 'common.validation_failed', 400);
    untouched(w);
  });
  it('assignee_text of exactly 80 chars is stored', async () => {
    const w = makeWorld();
    expect((await schedule(w, PK.req, 1, { ...SCHED, assignee_text: 'a'.repeat(80) })).status).toBe(200);
  });
});

describe('T15 SP3 markPickupCollected (US-10.4, manifest in_transit_at)', () => {
  it('scheduled -> picked_up (default now): picked_up_at = now, resolved_*, links closed, the pickup\'s manifests get in_transit_at, their state is unchanged, others untouched', async () => {
    const w = makeWorld();
    const others = JSON.stringify(w.manifests.filter((m) => m.id !== MF.sch));
    const stateBefore = w.mf(MF.sch).state;
    const r = await collect(w, PK.sch, 2);
    expect(r.status).toBe(200);
    dto(r.body, true);
    expect(r.body).toMatchObject({ id: PK.sch, state: 'picked_up', picked_up_at: NOW, version: 3 });
    expect(w.pk(PK.sch)).toMatchObject({ state: 'picked_up', picked_up_at: NOW, resolved_at: NOW, resolved_by: STAFFS['staff']!.id, updated_by: STAFFS['staff']!.id, version: 3 });
    expect(w.linksOf(PK.sch).every((l) => l.is_open === false)).toBe(true);
    expect(w.mf(MF.sch).in_transit_at).toBe(NOW);
    expect(w.mf(MF.sch).state).toBe(stateBefore);
    expect(JSON.stringify(w.manifests.filter((m) => m.id !== MF.sch))).toBe(others);
  });
  it('requested -> picked_up directly (03-APP-FLOW 2.3) with an explicit picked_up_at <= now (boundary now accepted); manifest in_transit_at = picked_up_at', async () => {
    const w = makeWorld();
    const at = iso(NOW_MS - 2 * HOUR);
    const r = await collect(w, PK.req, 1, { picked_up_at: at });
    expect(r.body).toMatchObject({ state: 'picked_up', picked_up_at: at });
    expect(w.mf(MF.open).in_transit_at).toBe(at);
    const w2 = makeWorld();
    expect((await collect(w2, PK.req, 1, { picked_up_at: NOW })).status).toBe(200);
  });
  it('body {} and no body behave like "now"', async () => {
    for (const b of [{}, undefined]) expect((await collect(makeWorld(), PK.req, 1, b)).body.picked_up_at).toBe(NOW);
  });
  it('a detached manifest of the same pickup is not marked in transit; the open one is', async () => {
    const w = makeWorld();
    await collect(w, PK.two, 1);
    expect(w.mf(MF.two).in_transit_at).toBe(NOW);
    expect(w.mf(MF.detached).in_transit_at).toBeNull();
  });
  it('several manifests: all open ones are marked, in one transaction; another partner\'s manifest with the same state is untouched', async () => {
    const w = makeWorld();
    const r1 = await create(w, k1({ manifest_ids: [MF.m1, MF.m2, MF.m3] }));
    await collect(w, r1.body.id, 1);
    for (const m of [MF.m1, MF.m2, MF.m3]) expect(w.mf(m).in_transit_at, m).toBe(NOW);
    expect(w.mf(MF.y).in_transit_at).toBeNull();
  });
  it('picked_up_at in the future (1 ms) -> 400 common.validation_failed, nothing written', async () => {
    const w = makeWorld();
    await fails(collect(w, PK.req, 1, { picked_up_at: iso(NOW_MS + 1) }), 'common.validation_failed', 400);
    untouched(w);
  });
  it.each([['free text', { picked_up_at: 'now' }], ['number', { picked_up_at: 5 }], ['unknown key state', { state: 'picked_up' }], ['unknown key in_transit_at (AB11)', { in_transit_at: NOW }]])(
    'validation: %s -> 400', async (_l, b) => {
      const w = makeWorld();
      await fails(collect(w, PK.req, 1, b), 'common.validation_failed', 400);
      untouched(w);
    });
});

describe('T15 SP4 rejectPickup', () => {
  it.each([['requested', PK.req, 1, MF.open], ['scheduled', PK.sch, 2, MF.sch]] as const)('%s -> rejected: reason, resolved_*, links closed, manifests NOT in transit; partner sees the reason', async (_s, pid, v, mid) => {
    const w = makeWorld();
    const manifestsBefore = JSON.stringify(w.manifests);
    const r = await reject(w, pid, v, { reason_code: 'window_too_short' });
    expect(r.status).toBe(200);
    dto(r.body, true);
    expect(r.body).toMatchObject({ state: 'rejected', reject_reason_code: 'window_too_short', version: v + 1 });
    expect(w.pk(pid)).toMatchObject({ state: 'rejected', reject_reason_code: 'window_too_short', resolved_at: NOW, resolved_by: STAFFS['staff']!.id, updated_by: STAFFS['staff']!.id, picked_up_at: null });
    expect(w.linksOf(pid).every((l) => l.is_open === false)).toBe(true);
    expect(JSON.stringify(w.manifests)).toBe(manifestsBefore);
    expect((await call(w, 'getPickupRequest', 'adminX', pkp(pid))).body).toMatchObject({ state: 'rejected', reject_reason_code: 'window_too_short' });
    expect((await create(w, k1({ manifest_ids: [mid] }))).status).toBe(201); // the manifest is free again
  });
  it.each([['no_reason'], ['reason from the cancel set'], ['empty'], ['too long'], ['number']])('reason validation: %s -> 400', async (kind) => {
    const w = makeWorld();
    const b = { 'no_reason': {}, 'reason from the cancel set': { reason_code: 'no_longer_needed' }, empty: { reason_code: '' }, 'too long': { reason_code: 'r'.repeat(65) }, number: { reason_code: 3 } }[kind];
    await fails(reject(w, PK.req, 1, b), 'common.validation_failed', 400);
    untouched(w);
  });
  it('unknown body key -> 400', async () => {
    await fails(reject(makeWorld(), PK.req, 1, { reason_code: 'other', state: 'picked_up' }), 'common.validation_failed', 400);
  });
});

// ------------------------------------------------------------------ state machine (all ops x all states) + staff-op common rules
describe('T15 state machine through the handlers (03-APP-FLOW 2.3)', () => {
  const STATES = [['requested', PK.req, 1], ['scheduled', PK.sch, 2], ['picked_up', PK.picked, 3], ['cancelled', PK.canc, 2], ['rejected', PK.rej, 2]] as const;
  const OPS: Array<[string, (w: World, pid: string, v: number) => Promise<unknown>]> = [
    ['K4 cancel', (w, pid, v) => cancel(w, pid, v)], ['SP2 schedule', (w, pid, v) => schedule(w, pid, v)],
    ['SP3 picked-up', (w, pid, v) => collect(w, pid, v)], ['SP4 reject', (w, pid, v) => reject(w, pid, v)],
  ];
  for (const [opName, run] of OPS) {
    for (const [state, pid, v] of STATES) {
      const allowed = state === 'requested' || state === 'scheduled';
      it(`${opName} from ${state}: ${allowed ? 'allowed' : '409 partners.pickup_invalid_transition'}`, async () => {
        const w = makeWorld();
        const before = JSON.stringify(w.pk(pid));
        if (allowed) await run(w, pid, v);
        else {
          await fails(run(w, pid, v), 'partners.pickup_invalid_transition', 409);
          untouched(w);
          expect(JSON.stringify(w.pk(pid))).toBe(before);
        }
      });
    }
  }
  it('a terminal pickup stays terminal: second SP3 / second K4 / SP4 after SP3 are all 409', async () => {
    const w = makeWorld();
    await collect(w, PK.sch, 2);
    await fails(collect(w, PK.sch, 3), 'partners.pickup_invalid_transition', 409);
    await fails(cancel(w, PK.sch, 3), 'partners.pickup_invalid_transition', 409);
    await fails(reject(w, PK.sch, 3), 'partners.pickup_invalid_transition', 409);
    await fails(schedule(w, PK.sch, 3), 'partners.pickup_invalid_transition', 409);
    expect(w.pk(PK.sch).state).toBe('picked_up');
  });
});

describe.each([['SP2 schedule', schedule, SCHED], ['SP3 picked-up', collect, {}], ['SP4 reject', reject, { reason_code: 'other' }]] as const)(
  'T15 %s: common staff-operation rules', (_n, run, okBody) => {
    const opId = { 'SP2 schedule': 'schedulePickup', 'SP3 picked-up': 'markPickupCollected', 'SP4 reject': 'rejectPickup' }[_n];
    it('If-Match: absent 428, malformed 400, stale 409 common.version_conflict; nothing written', async () => {
      const w = makeWorld();
      await fails(call(w, opId, 'staff', pkp(PK.req, { body: okBody })), 'common.precondition_required', 428);
      for (const bad of ['abc', '"abc"', '"0"', '""']) await fails(run(w, PK.req, bad as any, okBody as any), 'common.validation_failed', 400);
      await fails(run(w, PK.req, 9, okBody as any), 'common.version_conflict', 409);
      untouched(w);
    });
    it('other tenant -> 404 (RLS on and off); centre-scoped staff of another centre -> 404; unknown id -> 404; malformed id -> 400', async () => {
      for (const noRls of [false, true]) {
        const w = makeWorld();
        const before = w.snapshot();
        await fails(run(w, PK.req, 1, okBody as any, 'staffB', { noRls }), 'common.not_found', 404);
        await fails(run(w, id(9002), 1, okBody as any, 'staff', { noRls }), 'common.not_found', 404);
        expect(w.snapshot()).toBe(before);
      }
      const w = makeWorld();
      await fails(run(w, PK.req, 1, okBody as any, 'staffC2'), 'common.not_found', 404); // PK.req is at centre c1
      await fails(run(w, PK.c2, 1, okBody as any, 'staffC1'), 'common.not_found', 404);
      await fails(run(w, 'not-a-uuid', 1, okBody as any), 'common.validation_failed', 400);
      untouched(w);
    });
    it('centre-scoped staff of the right centre may act; the other partner\'s pickup at the same centre is also reachable (staff are not partner scoped)', async () => {
      const w = makeWorld();
      expect((await run(w, PK.y, 1, okBody as any, 'staffC1')).status).toBe(200);
    });
    it('gate: partner token -> 403 auth.forbidden before SQL (US-15.3); staff without partners.pickup.manage -> 403', async () => {
      const w = makeWorld();
      await fails(run(w, PK.req, 1, okBody as any, 'adminX'), 'auth.forbidden', 403);
      await fails(run(w, PK.req, 1, okBody as any, 'staffNoManage'), 'auth.forbidden', 403);
      expect(w.sql).toEqual([]);
    });
  });
