// C13 T18 — partner dashboard, operation A2 getPartnerDashboard (06-IMPLEMENTATION-PLAN row T18). Tests: integration (in-memory SQL world) + probes. ACs: US-14.1, US-14.2 (API half; the PH-1 page is apps/partner/tests/t18).
// done_when: "counts correct on seeded data; empty state". Spec: 02-TRD §5.2 A2 (GET /dashboard, partner / partners.order.read, 200 {submitted_today, in_lab, reported_today, rejected_open, new_reports, open_pickups,
//   outstanding?: Money, outstanding_as_of?}); contracts/openapi/partners.yaml getPartnerDashboard (additionalProperties false, ints 0..100000); 01-PRD US-14, US-15.1/15.4; 04-UI-UX PH-1 (tile names);
//   05-SCHEMA §3 (order_tracking, order_reports, manifests.line_count/submitted_at, pickup_requests, statement_months), index notes "dashboard"; 07-SECURITY ST2, ST4.
// LEAD DECISION LD-140 (UI only) does not apply to this file: backend.
// Handler: manifest.handlers.getPartnerDashboard (handlers/getPartnerDashboard.ts) over service/dashboard.service.ts. Fixture + SQL subset: dashboard.world.ts (header; one aggregate per statement, no GROUP BY).
// SEAMS (spec does not fix them; the writer follows them or disputes):
//  - Order (as T13/T17): ctx.actor.type === 'partner' else 403 auth.forbidden (no SQL) -> IdentityPort.assertRole(ctx,{permission:'partners.order.read'}) -> partnerContext.require(ctx)
//    (suspended partner -> 403 partners.partner_inactive) -> counts. Every statement on the data tables binds tenant_id AND partner_id (token membership); nothing in req (query/params/headers) is read.
//  - Definitions (the TRD names the tiles, not the rules):
//      submitted_today = SUM(manifests.line_count) of the partner's manifests with submitted_at inside today (draft / discarded have submitted_at NULL) — withdrawn manifests are NOT seeded (spec gap)
//      in_lab = COUNT order_tracking tracking_status = 'in_lab';  rejected_open = COUNT tracking_status = 'action_needed' (tile "New sample needed")
//      reported_today = COUNT order_tracking tracking_status = 'reported' AND last_event_at inside today (partially_reported is not "reported")
//      new_reports = COUNT order_reports status = 'valid' AND is_new;  open_pickups = COUNT pickup_requests state IN ('requested','scheduled')
//      outstanding = closing_balance of the LATEST period_month of partners.statement_months (as S1 / US-12.2; not the max / sum), outstanding_as_of = the partner's latest synced_at; both OMITTED when the
//      partner has no statement row (a real zero balance is returned as 0, not omitted).
//  - "today" = the tenant calendar day of ctx.now() in the tenant timezone (IdentityPort.getTenantSettings({keys:['timezone']}) or ctx.core.tenant(ctx).timezone — both are faked consistently), bounds bound as parameters.
//  - Each count is its own single-table aggregate statement (no row-level pull of orders/reports/manifests/pickups into JS); the handler is read-only (no INSERT/UPDATE/DELETE, no access-log entry asserted either way).
//  - Counts above 100000 (schema maximum) are not tested (spec gap).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../core/errors.js';
import { manifest } from '../index.js';
import { dashCtx, DAY_START_NPT, EXPECTED_B, EXPECTED_X, EXPECTED_Y, makeDashboardWorld, P, seedDashboard, T_A, T_B, U, type Who, type World } from './dashboard.world.js';
import type { Opts } from './tracking-api.world.js';

const H = manifest.handlers as Record<string, (req: any, ctx: any) => Promise<any>>;
const OP = 'getPartnerDashboard';
const world = (o: { data?: boolean } = {}): World => { const w = makeDashboardWorld(); seedDashboard(w, o); return w; };
const ctxFor = (w: World, who: Who = 'adminX', o: Opts & { tz?: string } = {}) => dashCtx(w, who, H, o);
const get = async (w: World, who: Who = 'adminX', o: Opts & { tz?: string } = {}, req: object = {}) => ctxFor(w, who, o).run(OP, req);
const fails = async (p: Promise<unknown>, code: string, status?: number) => {
  const e: any = await p.then(() => { throw new Error('expected rejection'); }, (x) => x);
  expect(e, String(e?.message)).toBeInstanceOf(LimsError);
  expect(e.code).toBe(code);
  if (status) expect(e.statusCode).toBe(status);
};
const DATA_TABLES = /partners\.(order_tracking|order_reports|manifests|pickup_requests|statement_months)\b/;
const COUNT_KEYS = ['submitted_today', 'in_lab', 'reported_today', 'rejected_open', 'new_reports', 'open_pickups'];

describe('T18 world smoke (fixture self-check, not the implementation)', () => {
  it('count / sum / max aggregates and bound scoping work in the fake', async () => {
    const w = world();
    const q = (t: string, v: unknown[]) => w.tx.query(t, v);
    expect((await q("SELECT count(*)::int AS n FROM partners.order_tracking WHERE tenant_id = $1 AND partner_id = $2 AND tracking_status = 'in_lab'", [T_A, P.x])).rows[0]).toEqual({ n: 3 });
    expect((await q("SELECT count(*) AS n FROM partners.order_tracking WHERE tenant_id = $1 AND partner_id = $2 AND tracking_status = 'in_lab'", [T_A, P.x])).rows[0]).toEqual({ n: '3' });
    expect((await q('SELECT sum(line_count)::int AS n FROM partners.manifests WHERE tenant_id = $1 AND partner_id = $2 AND submitted_at >= $3', [T_A, P.x, new Date(DAY_START_NPT)])).rows[0]).toEqual({ n: 5 });
    expect((await q('SELECT sum(line_count)::int AS n FROM partners.manifests WHERE tenant_id = $1 AND partner_id = $2 AND submitted_at >= $3', [T_A, P.x, new Date('2030-01-01')])).rows[0]).toEqual({ n: null });
    expect((await q('SELECT max(synced_at) AS s FROM partners.statement_months WHERE tenant_id = $1 AND partner_id = $2', [T_A, P.x])).rows[0]!.s.toISOString()).toBe(EXPECTED_X.outstanding_as_of);
    await expect(q('SELECT tracking_status, count(*) AS n FROM partners.order_tracking WHERE tenant_id = $1 GROUP BY tracking_status', [T_A])).rejects.toThrow(/fake SQL/);
  });
});

describe('T18 wiring', () => {
  it('service + handler files exist; no console logging', () => {
    for (const f of ['service/dashboard.service.ts', 'handlers/getPartnerDashboard.ts']) {
      const p = join(__dirname, '..', f);
      expect(existsSync(p), f).toBe(true);
      expect(readFileSync(p, 'utf8'), f).not.toMatch(/console\.(log|info|debug|warn|error)/);
    }
  });
  it('getPartnerDashboard is implemented (no stub: 501 / common.internal)', async () => {
    const r = await get(world());
    expect(r.status).toBe(200);
  });
});

describe('T18 counts on seeded data (US-14.1)', () => {
  it('partner X: every tile value, outstanding and its as-of are exact; body has exactly the contract keys', async () => {
    const r = await get(world());
    expect(r.status).toBe(200);
    expect(r.body).toEqual(EXPECTED_X);
    expect(Object.keys(r.body).sort()).toEqual([...COUNT_KEYS, 'outstanding', 'outstanding_as_of'].sort());
    for (const k of COUNT_KEYS) { expect(Number.isInteger(r.body[k]), k).toBe(true); expect(r.body[k]).toBeGreaterThanOrEqual(0); expect(r.body[k]).toBeLessThanOrEqual(100000); }
    expect(Object.keys(r.body.outstanding).sort()).toEqual(['amount_paisa', 'currency']);
    expect(Number.isSafeInteger(r.body.outstanding.amount_paisa)).toBe(true);
    expect(new Date(r.body.outstanding_as_of).toISOString()).toBe(r.body.outstanding_as_of);
  });
  it('any partner user (member as well as admin) of the partner sees the same numbers (partners.order.read)', async () => {
    const w = world();
    expect((await get(w, 'memberX')).body).toEqual(EXPECTED_X);
    expect((await get(w, 'adminX')).body).toEqual(EXPECTED_X);
  });
  it('partially_reported orders are counted in no tile (seed also holds registered / in_transit / cancelled, superseded + seen reports, closed pickups: all excluded by EXPECTED_X above)', async () => {
    const w = world();
    // flip every partner-X in-lab order to partially_reported: only in_lab moves (to 0)
    for (const t of w.t['partners.order_tracking']!) if (t.partner_id === P.x && t.tracking_status === 'in_lab') t.tracking_status = 'partially_reported';
    expect((await get(w)).body).toEqual({ ...EXPECTED_X, in_lab: 0 });
  });
  it('a bigger older balance or another fiscal-year row never wins: outstanding is the closing balance of the latest month; adding a newer month moves it and as_of', async () => {
    const w = world();
    w.t['partners.statement_months']!.push({ ...w.t['partners.statement_months']!.find((r) => r.partner_id === P.x && String(r.period_month).startsWith('2026-10'))!, period_month: '2026-11-01', closing_balance_paisa: '42', synced_at: new Date('2026-11-13T05:59:00Z') });
    const r = await get(w);
    expect(r.body.outstanding).toEqual({ amount_paisa: 42, currency: 'NPR' });
    expect(r.body.outstanding_as_of).toBe('2026-11-13T05:59:00.000Z');
  });
  it('a real zero balance is returned as outstanding 0 with its as-of (not omitted)', async () => {
    const r = await get(world(), 'adminY');
    expect(r.body).toEqual(EXPECTED_Y);
    expect(r.body.outstanding).toEqual({ amount_paisa: 0, currency: 'NPR' });
  });
  it('large money amounts stay exact integers (no float rounding)', async () => {
    const w = world();
    for (const r of w.t['partners.statement_months']!) if (r.partner_id === P.x && String(r.period_month).startsWith('2026-10')) r.closing_balance_paisa = '9007199254740991';
    expect((await get(w)).body.outstanding).toEqual({ amount_paisa: 9007199254740991, currency: 'NPR' });
  });
});

describe('T18 "today" is the tenant calendar day', () => {
  it('Asia/Kathmandu: a manifest submitted / an order reported at 00:00 NPT (18:15Z the day before) is today; one second earlier is not', async () => {
    const b = (await get(world(), 'adminX', { tz: 'Asia/Kathmandu' })).body;
    expect(b.submitted_today).toBe(5);
    expect(b.reported_today).toBe(2);
  });
  it('UTC tenant: the same data gives a different "today" (the timezone is read, not hard-coded)', async () => {
    const b = (await get(world(), 'adminX', { tz: 'UTC' })).body;
    expect(b.submitted_today).toBe(3);
    expect(b.reported_today).toBe(1);
    expect({ ...b, submitted_today: 5, reported_today: 2 }).toEqual(EXPECTED_X);
  });
  it('the day follows ctx.now(): the next tenant day sees no submissions and no reports "today"', async () => {
    const b = (await get(world(), 'adminX', { now: '2026-11-14T06:00:00.000Z' })).body;
    expect(b.submitted_today).toBe(0);
    expect(b.reported_today).toBe(0);
    expect(b.in_lab).toBe(3); // not date-bound
  });
});

describe('T18 empty state (US-14.2)', () => {
  it('a partner with no data: every count is 0 and outstanding / outstanding_as_of are absent (no null on the wire)', async () => {
    const r = await get(world({ data: false }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ submitted_today: 0, in_lab: 0, reported_today: 0, rejected_open: 0, new_reports: 0, open_pickups: 0 });
    expect(JSON.stringify(r.body)).not.toContain('null');
  });
  it('a partner with only a draft manifest and no orders: counts 0 (drafts are not "submitted today")', async () => {
    const w = world({ data: false });
    w.t['partners.manifests']!.push({ id: U.adminX, tenant_id: T_A, partner_id: P.x, manifest_no: 'MF26000001', state: 'draft', line_count: 4, submitted_at: null });
    expect((await get(w)).body.submitted_today).toBe(0);
  });
});

describe('T18 isolation (US-15.1, US-15.2)', () => {
  it('partner Y (same tenant) and tenant B each get only their own numbers', async () => {
    const w = world();
    expect((await get(w, 'adminY')).body).toEqual(EXPECTED_Y);
    expect((await get(w, 'adminB')).body).toEqual(EXPECTED_B);
    expect((await get(w, 'adminX')).body).toEqual(EXPECTED_X);
  });
  it('request input never widens scope: partner_id / tenant / header probes are ignored', async () => {
    const w = world();
    const r = await get(w, 'adminX', {}, { query: { partner_id: P.y, tenant_id: T_B, limit: '999' }, params: { partner_id: P.y }, headers: { 'x-partner-id': P.y, 'x-tenant-id': T_B }, body: { partner_id: P.y } });
    expect(r.body).toEqual(EXPECTED_X);
  });
  it('every statement on a data table binds tenant_id AND partner_id to the token membership values (ST2), and is an aggregate (counts / sums are computed in SQL)', async () => {
    const w = world(); const c = ctxFor(w);
    await c.run(OP, {});
    const data = w.log.filter((q) => DATA_TABLES.test(q.text));
    expect(data.length).toBeGreaterThanOrEqual(5);
    for (const q of data) {
      const tn = /\btenant_id\s*=\s*\$(\d+)/.exec(q.text), pn = /\bpartner_id\s*=\s*\$(\d+)/.exec(q.text);
      expect(tn, q.text).not.toBeNull(); expect(pn, q.text).not.toBeNull();
      expect(q.values[Number(tn![1]) - 1], q.text).toBe(T_A);
      expect(q.values[Number(pn![1]) - 1], q.text).toBe(P.x);
      if (!/partners\.statement_months/.test(q.text)) expect(q.text, 'row-level pull of a large table').toMatch(/^\s*SELECT\s+(count|sum)\s*\(/i);
    }
    for (const t of ['order_tracking', 'order_reports', 'manifests', 'pickup_requests']) expect(data.some((q) => q.text.includes(`partners.${t}`)), t).toBe(true);
  });
  it('read-only: no write statement, no table changes, no job enqueued', async () => {
    const w = world(); const before = JSON.stringify(w.snapshot()); const c = ctxFor(w);
    await c.run(OP, {});
    expect(w.writes()).toEqual([]);
    expect(JSON.stringify(w.snapshot())).toBe(before);
  });
  it('the response carries no identifiers: no tenant / partner / membership id, no row ids', async () => {
    const body = JSON.stringify((await get(world())).body);
    for (const needle of [T_A, T_B, P.x, P.y, U.adminX, U.memberX]) expect(body).not.toContain(needle);
  });
});

describe('T18 gates (ST4 actor types, ST2 inactive partner, permission)', () => {
  it.each(['user', 'patient', 'portal', 'device', 'system'])('actor type %s -> 403 auth.forbidden before any SQL / port call', async (t) => {
    const w = world(); const c = ctxFor(w, 'adminX', { actorType: t });
    await fails(c.run(OP, {}), 'auth.forbidden', 403);
    expect(w.log).toEqual([]); expect(c.roles).toEqual([]); expect(c.portCalls).toEqual([]);
  });
  it('asks IdentityPort.assertRole for partners.order.read first; a denial propagates unchanged and nothing is read', async () => {
    const w = world(); const err = new LimsError('auth.forbidden');
    const c = ctxFor(w, 'adminX', { assertRoleError: err });
    expect(await c.run(OP, {}).then(() => undefined, (e) => e)).toBe(err);
    expect(c.roles).toEqual(['partners.order.read']); expect(w.log).toEqual([]);
  });
  it('a suspended partner (token still valid) -> 403 partners.partner_inactive, no count statement runs', async () => {
    const w = world(); const c = ctxFor(w, 'adminZ');
    await fails(c.run(OP, {}), 'partners.partner_inactive', 403);
    expect(w.log.filter((q) => DATA_TABLES.test(q.text))).toEqual([]);
  });
});

describe('T18 failures, many users', () => {
  it.each(['order_tracking', 'order_reports', 'manifests', 'pickup_requests', 'statement_months'])('a database failure on %s fails the whole request: no partial body, no write', async (table) => {
    const w = world(); w.failNext(new RegExp(`FROM partners\\.${table}\\b`), new Error('injected database failure'));
    const c = ctxFor(w);
    const e: any = await c.run(OP, {}).then(() => { throw new Error('expected rejection'); }, (x) => x);
    expect(e.message).toBe('injected database failure');
    expect(w.writes()).toEqual([]);
  });
  it('a database error text never reaches a log line with request input (no PHI / ids in logs)', async () => {
    const w = world(); const c = ctxFor(w); await c.run(OP, {});
    for (const l of c.logs) for (const needle of [T_A, T_B, P.x, 'Synthetic Partner']) expect(l).not.toContain(needle);
  });
  it('60 interleaved requests of three partners all get their own numbers (no shared mutable state between requests)', async () => {
    const w = world();
    const who: Array<[Who, unknown]> = [['adminX', EXPECTED_X], ['adminY', EXPECTED_Y], ['adminB', EXPECTED_B]];
    const out = await Promise.all(Array.from({ length: 60 }, (_, i) => { const [u, exp] = who[i % 3]!; return get(w, u).then((r) => ({ got: r.body, exp })); }));
    for (const o of out) expect(o.got).toEqual(o.exp);
  });
});
