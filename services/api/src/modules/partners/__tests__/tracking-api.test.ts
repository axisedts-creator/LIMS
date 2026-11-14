// C13 T13 — tracking + reports API (06-IMPLEMENTATION-PLAN row T13). Tests: integration (in-memory SQL world) + probes + log-scan. ACs: US-07.6, US-07.8, US-08.2 – US-08.7.
// done_when: "partner isolation on lists/search/detail; POST search (no PHI in URL); download streams with sha256 check, access log allowed/denied (denied committed), rate tier + daily cap (ReportingPort fake, CR-C13-005)".
// Spec: 02-TRD §5.1 (PartnerOrder / PartnerOrderDetail / PartnerReport), §5.2 O1-O3 R1-R3, §10.2 report_download_daily_cap_per_user, §11 (R3 rate key + daily cap), §13 (never logged; access-log table; metrics);
//   03-APP-FLOW §4.3, §4.4, §5.4 (R3 sequence + sha256 while streaming); 05-SCHEMA §3.7 (order_tracking, tracked_specimens, order_reports, download_counters); 07-SECURITY ST2, ST11, ST13, AB-download rows;
//   03-INTERFACE-CATALOG §4.7 ReportingPort.openReleasedReportFile (CR-C13-005); contracts/openapi/partners.yaml.
// LEAD DECISION LD-140 (UI only) does not apply: backend task.
// Handlers are exercised through manifest.handlers[operationId]; services: ../service/tracking.service.ts, ../service/report.service.ts. Fixture + SQL subset: tracking-api.world.ts (header).
// SEAMS (spec does not fix them; the writer follows them or disputes):
//  - Order (as T17): ctx.actor.type === 'partner' else 403 auth.forbidden (no SQL) -> IdentityPort.assertRole(ctx,{permission}) (O1-O3 partners.order.read; R1-R3 partners.report.read) -> partnerContext.require(ctx)
//    (inactive partner -> 403 partners.partner_inactive) -> request validation (400 common.validation_failed, before any SQL on the data tables) -> reads.
//  - Every read/write of partners.{order_tracking,manifest_lines,tracked_specimens,order_reports,manifests,partner_referrers,download_counters} binds tenant_id AND partner_id (token membership); no RLS is emulated.
//    Single-table SQL (the fake rejects joins/sub-selects). Null columns are omitted from DTOs (no null on the wire); panel_names null -> [] (PartnerReport requires it).
//  - Lists: cursor is opaque ^[A-Za-z0-9_-]+$; page = { limit, next_cursor? } (next_cursor absent on the last page); bad cursor -> 400 common.invalid_cursor. Defaults: O1 sort -registered_at, R1 -released_at.
//  - O1 has_new_report = order has a valid report version with is_new; O2 q: patient-name PREFIX (case-insensitive, %, _ and \ literal), partner_sample_ref EXACT, registration_no EXACT; term only from the BODY.
//  - O3 timeline label_key = `partners.tracking.<event>` (registered, collected, in_transit, received, rejected), ascending by `at`; display text = the code humanised (03-APP-FLOW §4.3: EDTA_WB -> "EDTA WB", haemolysed -> "Haemolysed").
//  - R1 lists valid versions only unless include_superseded; R2 sets is_new=false, seen_at=ctx.now(), seen_by=actor id for the partner's own listed pairs only; `updated` = rows changed.
//  - R3: partners.order_reports row for (report_id, version_no) in the caller's scope, else 404 + denied access log + ctx.commitOnError() with NO port call and NO fetch. Then rate limit
//    ctx.rateLimit.consume('report_download', `partner_user:${partner_user_id}:report:${report_id}`), daily cap (partners.download_counters, key (tenant, partner_user, day = ctx.now() date); cap from
//    partners.settings.report_download_daily_cap_per_user, default 500; allowed while count <= cap after the increment), then ReportingPort.openReleasedReportFile(ctx, { reportId, versionNo }) with the REQUEST ctx
//    (partner claims, never a system actor), then global fetch(signedUrl) of the bytes, sha256 of the bytes must equal the port's sha256 or NOTHING is returned (throws; logs `report_hash_mismatch` with ids only),
//    then ctx.audit.access({action:'report.download', entityType:'report_version', entityId: reportVersionId, outcome:'allowed'}) and the response { status:200, headers, body: bytes }.
//    A port `common.not_found` -> same 404 + denied log (committed). Other port / storage failures propagate as errors (no bytes, no allowed log, signed URL never in the error).
//  - metrics (SEAM, request ctx has none today): ctx.metrics.inc('lims_partners_report_downloads_total', { outcome: allowed|denied|rate_limited }).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LimsError } from '../../../core/errors.js';
import { loadSpec, REPO_ROOT } from '../../../core/module.js';
import { manifest } from '../index.js';
import { FILES, LINE, makeCtx, makeWorld13, MAN, MARKERS, ORD, P, PHI, pdf, REF, RPT, rkey, seed13, SPEC, T_A, T_B, TODAY, U, iso, type Opts, type Who, type World } from './tracking-api.world.js';

const H = manifest.handlers as Record<string, (req: any, ctx: any) => Promise<any>>;
afterEach(() => vi.unstubAllGlobals());

const world = (o: { cap?: number } = {}): World => { const w = makeWorld13(); seed13(w, o); return w; };
const ctxFor = (w: World, who: Who = 'adminX', o: Opts = {}) => makeCtx(w, who, H, o);
const fails = async (p: Promise<unknown>, code: string, status?: number) => {
  const e: any = await p.then(() => { throw new Error('expected rejection'); }, (x) => x);
  expect(e, String(e?.message)).toBeInstanceOf(LimsError);
  expect(e.code).toBe(code);
  if (status) expect(e.statusCode).toBe(status);
  return e as LimsError;
};
const leaks = (x: unknown, needles: string[]) => {
  const plain = x instanceof Error ? Object.fromEntries(Object.getOwnPropertyNames(x).map((k) => [k, (x as any)[k]])) : x;
  const hay = JSON.stringify(plain).toLowerCase();
  return needles.filter((n) => hay.includes(n.toLowerCase()));
};
const orderIds = (r: { body: any }) => r.body.data.map((x: any) => x.order_id);
const reportKeys = (r: { body: any }) => r.body.data.map((x: any) => `${x.report_id}:${x.version_no}`);
const k = (report: string, v: number) => rkey(report, v);
const day = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);
const counter = (w: World, user: string, d = TODAY) => w.t['partners.download_counters']!.find((r) => r.partner_user_id === user && day(r.day) === d);
const reportRow = (w: World, report: string, v: number) => w.t['partners.order_reports']!.find((r) => r.report_id === report && r.version_no === v)!;
const hdr = (h: Record<string, string> = {}) => Object.fromEntries(Object.entries(h).map(([a, b]) => [a.toLowerCase(), b]));

/** storage fake behind the signed URLs: default = the real fake PDFs; override per URL with bytes / an Error / an HTTP status. */
function stubStorage(over: Record<string, Uint8Array | Error | number> = {}) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: any) => {
    const url = String(input?.url ?? input); calls.push(url);
    const hit = Object.entries(FILES).find(([, f]) => f.signedUrl === url);
    const v = over[url] ?? (hit ? pdf(hit[0]) : undefined);
    if (v === undefined) return new Response('not found', { status: 404 });
    if (v instanceof Error) throw v;
    if (typeof v === 'number') return new Response('storage error', { status: v });
    return new Response(v, { status: 200, headers: { 'content-type': 'application/pdf' } });
  });
  return calls;
}

// ------------------------------------------------------------------ DTO checks
const O_KEYS = ['order_id', 'registration_no', 'manifest', 'line_id', 'partner_sample_ref', 'patient', 'priority', 'tracking_status', 'referrer', 'registered_at', 'last_event_at', 'report_count', 'has_new_report'];
const O_REQ = ['order_id', 'registration_no', 'manifest', 'line_id', 'patient', 'priority', 'tracking_status', 'registered_at', 'last_event_at', 'report_count', 'has_new_report'];
const R_KEYS = ['report_id', 'version_no', 'order_id', 'registration_no', 'patient', 'kind', 'status', 'released_at', 'panel_names', 'is_new'];
const noNull = (b: unknown) => expect(JSON.stringify(b)).not.toContain(':null');
function orderDto(o: any, extra: string[] = []) {
  expect(Object.keys(o).every((x) => [...O_KEYS, ...extra].includes(x)), JSON.stringify(Object.keys(o))).toBe(true);
  for (const x of [...O_REQ, ...extra]) expect(o, x).toHaveProperty(x);
  expect(Object.keys(o.manifest).sort()).toEqual(['id', 'manifest_no']);
  expect(Object.keys(o.patient).every((x) => ['full_name', 'sex', 'age_years'].includes(x))).toBe(true);
  if (o.referrer) expect(Object.keys(o.referrer)).toEqual(['display_name']);
  noNull(o);
}
function reportDto(r: any) {
  expect(Object.keys(r).sort()).toEqual([...R_KEYS].sort());
  expect(Object.keys(r.patient)).toEqual(['full_name']);
  expect(Array.isArray(r.panel_names)).toBe(true);
  noNull(r);
}
const NO_LEAK = ['tenant_id', 'partner_id', 'receiving_centre_id', 'created_by', 'updated_by', 'seen_by', 'patient_phone', 'clinical_note', 'birth_on', 'consent', 'orderables_snapshot', PHI.phone, PHI.note, PHI.dob, T_A, T_B, P.x];

const REQS: Record<string, Partial<{ params: object; query: object; body: unknown }>> = {
  listPartnerOrders: {}, searchPartnerOrders: { body: { q: 'Synthetic' } }, getPartnerOrder: { params: { order_id: ORD.new } }, listPartnerReports: {},
  markPartnerReportsSeen: { body: { report_versions: [{ report_id: RPT.a, version_no: 2 }] } }, downloadPartnerReport: { params: { report_id: RPT.a, version_no: 2 } },
};
const PERM: Record<string, string> = { listPartnerOrders: 'partners.order.read', searchPartnerOrders: 'partners.order.read', getPartnerOrder: 'partners.order.read',
  listPartnerReports: 'partners.report.read', markPartnerReportsSeen: 'partners.report.read', downloadPartnerReport: 'partners.report.read' };
const OPS = Object.keys(REQS);

describe('T13 wiring', () => {
  it('service files exist; no console logging; report.service commits the denied access log', () => {
    for (const f of ['tracking.service.ts', 'report.service.ts']) {
      const p = join(__dirname, '..', 'service', f);
      expect(existsSync(p), f).toBe(true);
      expect(readFileSync(p, 'utf8'), f).not.toMatch(/console\.(log|info|debug|warn|error)/);
    }
    expect(readFileSync(join(__dirname, '..', 'service', 'report.service.ts'), 'utf8')).toContain('commitOnError');
  });
  it.each(OPS)('%s is implemented (no stub: 501 / common.internal)', async (op) => {
    stubStorage();
    const w = world(); const c = ctxFor(w);
    const r = await c.run(op, REQS[op]);
    expect(r.status).toBe(200);
  });
});

describe('T13 common gates (ST4 actor types, ST2 inactive partner, permissions)', () => {
  it.each(OPS.flatMap((op) => ['user', 'patient', 'portal', 'device', 'system'].map((t) => [op, t] as const)))('%s with actor type %s -> 403 auth.forbidden before any SQL / port call', async (op, t) => {
    stubStorage();
    const w = world(); const c = ctxFor(w, 'adminX', { actorType: t });
    await fails(c.run(op, REQS[op]), 'auth.forbidden', 403);
    expect(w.log).toEqual([]); expect(c.portCalls).toEqual([]); expect(w.audit).toEqual([]); expect(c.roles).toEqual([]);
  });
  it.each(OPS)('%s asks IdentityPort.assertRole for its permission first; a denial propagates, no SQL', async (op) => {
    stubStorage();
    const w = world(); const err = new LimsError('auth.forbidden');
    const c = ctxFor(w, 'adminX', { assertRoleError: err });
    expect(await c.run(op, REQS[op]).then(() => undefined, (e) => e)).toBe(err);
    expect(c.roles).toEqual([PERM[op]]); expect(w.log).toEqual([]);
  });
  it.each(OPS)('%s as a member of a suspended partner -> 403 partners.partner_inactive, nothing read, nothing written, no port call', async (op) => {
    stubStorage();
    const w = world(); const c = ctxFor(w, 'adminZ');
    await fails(c.run(op, REQS[op]), 'partners.partner_inactive', 403);
    expect(c.roles).toContain(PERM[op]); expect(c.portCalls).toEqual([]); expect(w.writes()).toEqual([]); expect(w.audit).toEqual([]);
    expect(w.sqlOf(/partners\.(order_tracking|order_reports|manifest_lines|tracked_specimens)/i)).toEqual([]);
  });
  it.each(['adminX', 'memberX'] as const)('%s (admin and member) may use every operation', async (who) => {
    stubStorage();
    for (const op of OPS) expect((await ctxFor(world(), who).run(op, REQS[op])).status, op).toBe(200);
  });
});

// ------------------------------------------------------------------ O1
describe('T13 O1 listPartnerOrders (US-07.6)', () => {
  it('200: own orders only, newest registration first, exact PartnerOrder DTO (null omitted, no PHI beyond the DTO)', async () => {
    const w = world(); const r = await ctxFor(w).run('listPartnerOrders');
    expect(r.status).toBe(200);
    expect(orderIds(r)).toEqual([ORD.new, ORD.lab, ORD.rep, ORD.act, ORD.canc]);
    expect(r.body.page).toEqual({ limit: 50 });
    expect(Object.keys(r.body).sort()).toEqual(['data', 'page']);
    for (const o of r.body.data) orderDto(o);
    const by = Object.fromEntries(r.body.data.map((o: any) => [o.order_id, o]));
    expect(by[ORD.lab]).toEqual({ order_id: ORD.lab, registration_no: 'SYN-0002', manifest: { id: MAN.m1, manifest_no: 'SYN-MF-0001' }, line_id: LINE.lab, partner_sample_ref: 'SYN-REF-002',
      patient: { full_name: 'Synthetic Binita Test', sex: 'female', age_years: 34 }, priority: 'urgent', tracking_status: 'in_lab', registered_at: iso('2026-11-09T02:00:00Z'),
      last_event_at: iso('2026-11-12T10:00:00Z'), report_count: 1, has_new_report: false });
    expect(by[ORD.new]).toMatchObject({ referrer: { display_name: 'Dr Synthetic Referrer One' }, has_new_report: true, tracking_status: 'registered' });
    expect(by[ORD.rep]).toMatchObject({ has_new_report: true, tracking_status: 'reported', manifest: { id: MAN.m2, manifest_no: 'SYN-MF-0002' }, patient: { sex: 'male' } });
    expect(by[ORD.act]).not.toHaveProperty('partner_sample_ref'); expect(by[ORD.act].patient).not.toHaveProperty('age_years'); expect(by[ORD.act]).not.toHaveProperty('referrer');
    expect(leaks(r.body, NO_LEAK)).toEqual([]);
  });

  it('US-07.6: partner Y and tenant B orders never appear; each partner sees only its own', async () => {
    const w = world();
    expect(orderIds(await ctxFor(w, 'adminY').run('listPartnerOrders'))).toEqual([ORD.y]);
    expect(orderIds(await ctxFor(w, 'adminB').run('listPartnerOrders'))).toEqual([ORD.b]);
    expect(orderIds(await ctxFor(w, 'memberX').run('listPartnerOrders'))).toEqual([ORD.new, ORD.lab, ORD.rep, ORD.act, ORD.canc]);
    const x = JSON.stringify((await ctxFor(w).run('listPartnerOrders')).body);
    for (const leak of ['SYN-Y001', 'Yogesh', 'SYN-B001', 'Referrer Y', 'SYN-MF-0101', 'SYN-MF-0201']) expect(x).not.toContain(leak);
  });
  it.each([['partner Y manifest', { manifest_id: MAN.y }], ['tenant B manifest', { manifest_id: MAN.b }], ['partner Y referrer', { referrer_id: REF.y }],
    ['unknown manifest', { manifest_id: MAN.y.replace(/.$/, '9') }]])('US-07.6: filtering by a foreign / unknown id (%s) -> 200 with an empty list, not an error', async (_l, query) => {
    const r = await ctxFor(world()).run('listPartnerOrders', { query });
    expect(r.status).toBe(200); expect(r.body.data).toEqual([]); expect(r.body.page).toEqual({ limit: 50 });
  });

  it.each([
    ['tracking_status csv', { tracking_status: 'in_lab,reported' }, [ORD.lab, ORD.rep]], ['tracking_status single', { tracking_status: 'cancelled' }, [ORD.canc]],
    ['manifest_id', { manifest_id: MAN.m1 }, [ORD.new, ORD.lab, ORD.canc]], ['referrer_id', { referrer_id: REF.r1 }, [ORD.new, ORD.rep]],
    ['registered_at window', { registered_at_from: '2026-11-07T12:00:00.000Z', registered_at_to: '2026-11-09T12:00:00.000Z' }, [ORD.lab, ORD.rep]],
    ['registered_at_from only', { registered_at_from: '2026-11-09T12:00:00.000Z' }, [ORD.new]], ['has_new_report true', { has_new_report: true }, [ORD.new, ORD.rep]],
    ['has_new_report false', { has_new_report: false }, [ORD.lab, ORD.act, ORD.canc]], ['filters combine (AND)', { tracking_status: 'registered,reported', has_new_report: true, manifest_id: MAN.m2 }, [ORD.rep]],
    ['sort -last_event_at', { sort: '-last_event_at' }, [ORD.lab, ORD.rep, ORD.new, ORD.act, ORD.canc]], ['sort -registered_at', { sort: '-registered_at' }, [ORD.new, ORD.lab, ORD.rep, ORD.act, ORD.canc]],
  ])('filter / sort: %s', async (_l, query, expected) => {
    const r = await ctxFor(world()).run('listPartnerOrders', { query });
    expect(orderIds(r)).toEqual(expected);
  });

  it.each([['default sort', {}], ['-last_event_at', { sort: '-last_event_at' }]])('cursor paging (%s, limit 2): three pages, no duplicates, no gaps, next_cursor absent on the last page', async (_l, base) => {
    const w = world(); const c = ctxFor(w); const all: string[] = []; const pages: any[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const r = await c.run('listPartnerOrders', { query: { ...base, limit: 2, ...(cursor ? { cursor } : {}) } });
      pages.push(r.body.page); all.push(...orderIds(r));
      cursor = r.body.page.next_cursor; if (!cursor) break;
      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    }
    expect(pages.map((p) => p.limit)).toEqual([2, 2, 2]);
    expect(pages.map((p) => 'next_cursor' in p)).toEqual([true, true, false]);
    expect(all).toEqual((await c.run('listPartnerOrders', { query: base })).body.data.map((o: any) => o.order_id));
    expect(new Set(all).size).toBe(5);
  });

  it.each([['unknown status', { tracking_status: 'bogus' }], ['trailing comma', { tracking_status: 'in_lab,' }], ['one bad status in csv', { tracking_status: 'in_lab,bogus' }], ['sort not allowed', { sort: 'registered_at' }],
    ['sort created_at', { sort: '-created_at' }], ['limit 0', { limit: 0 }], ['limit 201', { limit: 201 }], ['limit text', { limit: 'abc' }], ['manifest_id not uuid', { manifest_id: 'x' }],
    ['referrer_id not uuid', { referrer_id: "' OR 1=1 --" }], ['date not ISO', { registered_at_from: 'yesterday' }], ['has_new_report text', { has_new_report: 'maybe' }], ['unknown query key', { q: 'Synthetic' }],
  ])('validation: %s -> 400 common.validation_failed, no data read', async (_l, query) => {
    const w = world();
    await fails(ctxFor(w).run('listPartnerOrders', { query }), 'common.validation_failed', 400);
    expect(w.sqlOf(/partners\.(order_tracking|manifest_lines)/i)).toEqual([]);
  });
  it.each(['not a cursor!!', Buffer.from('{"x":1}').toString('base64url'), 'a'.repeat(600)])('bad cursor %# -> 400 common.invalid_cursor', async (cursor) => {
    await fails(ctxFor(world()).run('listPartnerOrders', { query: { cursor } }), 'common.invalid_cursor', 400);
  });
});

// ------------------------------------------------------------------ O2
describe('T13 O2 searchPartnerOrders (US-07.6, US-07.8)', () => {
  const search = (w: World, q: unknown, extra: object = {}, who: Who = 'adminX') => ctxFor(w, who).run('searchPartnerOrders', { body: { q, ...extra } });
  it.each([
    ['name prefix', 'Synthetic', [ORD.new, ORD.lab, ORD.rep, ORD.act, ORD.canc]], ['name prefix, case-insensitive', 'synthetic b', [ORD.lab]], ['full name', 'Synthetic Aarav Test', [ORD.new]],
    ['sample ref (exact)', 'SYN-REF-002', [ORD.lab]], ['registration no (exact)', 'SYN-0003', [ORD.rep]],
    ['partial sample ref -> nothing', 'SYN-REF-00', []], ['partial registration no -> nothing', 'SYN-000', []], ['name infix is not a prefix', 'Binita', []],
    ['LIKE wildcard % is literal', 'Syn%', []], ['LIKE wildcard _ is literal', '_ynthetic', []], ['only wildcards', '%%', []], ['backslash is literal', 'Synthetic\\', []],
    ['SQL-ish text', "x' OR '1'='1", []],
  ])('X searches by %s', async (_l, q, expected) => {
    const r = await search(world(), q);
    expect(r.status).toBe(200); expect(Object.keys(r.body)).toEqual(['data']);
    expect(orderIds(r).sort()).toEqual([...expected].sort());
    for (const o of r.body.data) orderDto(o);
  });
  it('US-07.6: foreign data is never found (Y\'s patient / registration no; X\'s own search sees one row for names / numbers that tenant B and partner Y share)', async () => {
    const w = world();
    expect((await search(w, 'Synthetic Yogesh Test')).body.data).toEqual([]);
    expect((await search(w, 'SYN-Y001')).body.data).toEqual([]);
    expect(orderIds(await search(w, 'SYN-0001'))).toEqual([ORD.new]);              // tenant B has SYN-0001 too
    expect(orderIds(await search(w, 'Synthetic Aarav Test'))).toEqual([ORD.new]);   // tenant B has the same name
    expect(orderIds(await search(w, 'SYN-REF-002'))).toEqual([ORD.lab]);            // partner Y has the same sample ref
    expect(orderIds(await search(w, 'SYN-REF-002', {}, 'adminY'))).toEqual([ORD.y]);
    expect(orderIds(await search(w, 'Synthetic Aarav Test', {}, 'adminB'))).toEqual([ORD.b]);
  });
  it('limit: honoured, at most 50, default does not exceed 20', async () => {
    const w = world();
    expect(orderIds(await search(w, 'Synthetic', { limit: 2 }))).toHaveLength(2);
    expect(orderIds(await search(w, 'Synthetic', { limit: 50 }))).toHaveLength(5);
  });
  it.each([['q 1 char', { q: 'a' }], ['q 65 chars', { q: 'a'.repeat(65) }], ['q missing', {}], ['q number', { q: 12 }], ['q null', { q: null }], ['limit 0', { q: 'Synthetic', limit: 0 }], ['limit 51', { q: 'Synthetic', limit: 51 }],
    ['unknown key', { q: 'Synthetic', cursor: 'x' }], ['body missing', undefined], ['body array', ['Synthetic']]])('validation: %s -> 400 common.validation_failed, no data read', async (_l, body) => {
    const w = world();
    await fails(ctxFor(w).run('searchPartnerOrders', { body }), 'common.validation_failed', 400);
    expect(w.sqlOf(/partners\.(order_tracking|manifest_lines)/i)).toEqual([]);
  });
  it('US-07.8: the term is read from the BODY only; a q in the query string is not a search (400) and a body q wins over any query', async () => {
    const w = world();
    await fails(ctxFor(w).run('searchPartnerOrders', { query: { q: 'Synthetic Binita' } }), 'common.validation_failed', 400);
    const r = await ctxFor(w).run('searchPartnerOrders', { query: { q: 'Synthetic Binita' }, body: { q: 'SYN-0003' } });
    expect(orderIds(r)).toEqual([ORD.rep]);
  });
});

// ------------------------------------------------------------------ O3
describe('T13 O3 getPartnerOrder (US-07.1, US-07.5, US-07.6)', () => {
  const get = (w: World, order: string, who: Who = 'adminX', o: Opts = {}) => ctxFor(w, who, o).run('getPartnerOrder', { params: { order_id: order } });
  it('200 PartnerOrderDetail: order + orderables + specimens (humanised display, rejection reason, replacement link) + reports + timeline', async () => {
    const w = world(); const r = await get(w, ORD.lab);
    expect(r.status).toBe(200);
    orderDto(r.body, ['orderables', 'specimens', 'reports', 'timeline']);
    expect(Object.keys(r.body).sort()).toEqual([...O_REQ, 'partner_sample_ref', 'orderables', 'specimens', 'reports', 'timeline'].sort());
    expect(r.body).toMatchObject({ order_id: ORD.lab, registration_no: 'SYN-0002', tracking_status: 'in_lab', has_new_report: false, report_count: 1 });
    expect(r.body.orderables).toEqual([{ code: 'SYN-T1', name: 'Synthetic Hemogram' }, { code: 'SYN-P1', name: 'Synthetic Lipid Package' }]);
    const sp = Object.fromEntries(r.body.specimens.map((s: any) => [s.specimen_id, s]));
    expect(Object.keys(sp).sort()).toEqual([SPEC.a, SPEC.b, SPEC.repl].sort());
    expect(sp[SPEC.a]).toEqual({ specimen_id: SPEC.a, specimen_type_code: 'EDTA_WB', specimen_type_display: 'EDTA WB', status: 'received', collected_at: iso('2026-11-09T03:00:00Z'),
      in_transit_at: iso('2026-11-09T04:00:00Z'), received_at: iso('2026-11-09T06:00:00Z') });
    expect(sp[SPEC.b]).toMatchObject({ status: 'rejected', rejected_at: iso('2026-11-09T07:00:00Z'), rejection_reason_code: 'haemolysed', rejection_reason_display: 'Haemolysed' });
    expect(sp[SPEC.repl]).toMatchObject({ status: 'in_transit', replaces_specimen_id: SPEC.b });
    expect(sp[SPEC.repl]).not.toHaveProperty('rejected_at'); expect(sp[SPEC.a]).not.toHaveProperty('rejection_reason_code');
    for (const s of r.body.specimens) expect(Object.keys(s).every((x) => ['specimen_id', 'specimen_type_code', 'specimen_type_display', 'status', 'collected_at', 'in_transit_at', 'received_at', 'rejected_at',
      'rejection_reason_code', 'rejection_reason_display', 'replaces_specimen_id'].includes(x))).toBe(true);
    expect(r.body.reports.map((x: any) => `${x.report_id}:${x.version_no}`)).toEqual([k(RPT.b, 1)]);
    reportDto(r.body.reports[0]);
    expect(leaks(r.body, NO_LEAK)).toEqual([]);
  });
  it('timeline: ascending by time, registered first, specimen events carry the humanised type', async () => {
    const t = (await get(world(), ORD.lab)).body.timeline as any[];
    expect(t[0]).toEqual({ at: iso('2026-11-09T02:00:00Z'), label_key: 'partners.tracking.registered' });
    expect(t.map((e) => Date.parse(e.at))).toEqual([...t.map((e) => Date.parse(e.at))].sort((a, b) => a - b));
    for (const e of t) { expect(e.label_key).toMatch(/^partners\.tracking\.[a-z_]+$/); expect(Object.keys(e).every((x) => ['at', 'label_key', 'specimen_type_display'].includes(x))).toBe(true); }
    expect(t).toContainEqual({ at: iso('2026-11-09T06:00:00Z'), label_key: 'partners.tracking.received', specimen_type_display: 'EDTA WB' });
    expect(t).toContainEqual({ at: iso('2026-11-09T07:00:00Z'), label_key: 'partners.tracking.rejected', specimen_type_display: 'EDTA WB' });
  });
  it('US-08.4: both versions of a re-issued report are listed, newest first, v1 superseded; has_new_report from the valid new version', async () => {
    const r = await get(world(), ORD.rep);
    expect(r.body.reports.map((x: any) => [x.version_no, x.status, x.is_new])).toEqual([[2, 'valid', true], [1, 'superseded', false]]);
    expect(r.body.has_new_report).toBe(true);
    for (const x of r.body.reports) reportDto(x);
    expect(r.body.specimens).toEqual([]);
  });
  it('an order without specimens / reports: empty arrays (never null / missing)', async () => {
    const r = await get(world(), ORD.act);
    expect(r.body).toMatchObject({ specimens: [], reports: [], orderables: [{ code: 'SYN-T1', name: 'Synthetic Hemogram' }] });
    expect(r.body.timeline[0].label_key).toBe('partners.tracking.registered');
  });
  it.each([['partner Y order', ORD.y], ['tenant B order', ORD.b], ['unknown order', ORD.y.replace(/.$/, '8')]])('ST2: %s -> 404 common.not_found; body does not reveal it; nothing written', async (_l, order) => {
    for (const who of ['adminX', 'memberX'] as const) {
      const w = world();
      const e = await fails(get(w, order, who), 'common.not_found', 404);
      expect(leaks(e, ['SYN-Y001', 'Yogesh', 'SYN-B001', 'Synthetic Partner Y', 'SYN-MF-0101'])).toEqual([]);
      expect(w.writes()).toEqual([]);
    }
  });
  it('a malformed order id never reaches the data tables', async () => {
    const w = world();
    const e: any = await get(w, 'not-a-uuid').then(() => undefined, (x) => x);
    expect(['common.validation_failed', 'common.not_found']).toContain(e?.code);
    expect(w.sqlOf(/partners\.order_tracking/i)).toEqual([]);
  });
});

// ------------------------------------------------------------------ R1
describe('T13 R1 listPartnerReports (US-08.1, US-08.4, US-08.5)', () => {
  it('200: own valid versions, newest release first, exact PartnerReport DTO ("New" = is_new)', async () => {
    const w = world(); const r = await ctxFor(w).run('listPartnerReports');
    expect(r.status).toBe(200);
    expect(reportKeys(r)).toEqual([k(RPT.a, 2), k(RPT.c, 1), k(RPT.b, 1), k(RPT.d, 1)]);
    expect(r.body.page).toEqual({ limit: 50 }); expect(Object.keys(r.body).sort()).toEqual(['data', 'page']);
    for (const x of r.body.data) reportDto(x);
    expect(r.body.data[0]).toEqual({ report_id: RPT.a, version_no: 2, order_id: ORD.rep, registration_no: 'SYN-0003', patient: { full_name: 'Synthetic Chandra Test' }, kind: 'amended', status: 'valid',
      released_at: iso('2026-11-12T05:00:00Z'), panel_names: ['Synthetic Lipid Package', 'Synthetic Renal Package'], is_new: true });
    expect(r.body.data.find((x: any) => x.report_id === RPT.b).panel_names).toEqual([]);
    expect(r.body.data.map((x: any) => x.is_new)).toEqual([true, true, false, false]);
    expect(leaks(r.body, NO_LEAK)).toEqual([]);
  });
  it('US-08.4: include_superseded=true adds v1 (status superseded); default / false hide it', async () => {
    const w = world();
    const all = await ctxFor(w).run('listPartnerReports', { query: { include_superseded: true } });
    expect(reportKeys(all)).toEqual([k(RPT.a, 2), k(RPT.c, 1), k(RPT.b, 1), k(RPT.d, 1), k(RPT.a, 1)]);
    expect(all.body.data.find((x: any) => x.version_no === 1 && x.report_id === RPT.a).status).toBe('superseded');
    expect(reportKeys(await ctxFor(w).run('listPartnerReports', { query: { include_superseded: false } }))).toEqual([k(RPT.a, 2), k(RPT.c, 1), k(RPT.b, 1), k(RPT.d, 1)]);
  });
  it.each([['is_new true', { is_new: true }, [k(RPT.a, 2), k(RPT.c, 1)]], ['is_new false', { is_new: false }, [k(RPT.b, 1), k(RPT.d, 1)]],
    ['is_new false + superseded', { is_new: false, include_superseded: true }, [k(RPT.b, 1), k(RPT.d, 1), k(RPT.a, 1)]],
    ['released window', { released_at_from: '2026-11-09T12:00:00.000Z', released_at_to: '2026-11-11T12:00:00.000Z' }, [k(RPT.c, 1), k(RPT.b, 1)]],
    ['released_at_to only', { released_at_to: '2026-11-09T12:00:00.000Z' }, [k(RPT.d, 1)]], ['sort -released_at', { sort: '-released_at' }, [k(RPT.a, 2), k(RPT.c, 1), k(RPT.b, 1), k(RPT.d, 1)]],
  ])('filter: %s', async (_l, query, expected) => {
    expect(reportKeys(await ctxFor(world()).run('listPartnerReports', { query }))).toEqual(expected);
  });
  it('ST2: partner Y / tenant B reports never appear (even newer ones); each partner sees its own', async () => {
    const w = world();
    expect(reportKeys(await ctxFor(w, 'adminY').run('listPartnerReports'))).toEqual([k(RPT.y, 1)]);
    expect(reportKeys(await ctxFor(w, 'adminB').run('listPartnerReports'))).toEqual([k(RPT.bb, 1)]);
    const x = reportKeys(await ctxFor(w).run('listPartnerReports', { query: { include_superseded: true } }));
    expect(x).not.toContain(k(RPT.y, 1)); expect(x).not.toContain(k(RPT.bb, 1));
  });
  it('cursor paging (limit 2): two pages, no duplicates; bad cursor -> 400 common.invalid_cursor', async () => {
    const w = world(); const c = ctxFor(w);
    const p1 = await c.run('listPartnerReports', { query: { limit: 2 } });
    expect(p1.body.page.next_cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    const p2 = await c.run('listPartnerReports', { query: { limit: 2, cursor: p1.body.page.next_cursor } });
    expect([...reportKeys(p1), ...reportKeys(p2)]).toEqual([k(RPT.a, 2), k(RPT.c, 1), k(RPT.b, 1), k(RPT.d, 1)]);
    expect(p2.body.page).toEqual({ limit: 2 });
    await fails(c.run('listPartnerReports', { query: { cursor: 'not a cursor!!' } }), 'common.invalid_cursor', 400);
  });
  it.each([['sort', { sort: 'released_at' }], ['limit 0', { limit: 0 }], ['limit 201', { limit: 201 }], ['is_new text', { is_new: 'maybe' }], ['include_superseded text', { include_superseded: 'x' }],
    ['date not ISO', { released_at_from: 'yesterday' }], ['unknown key', { order_id: ORD.rep }]])('validation: %s -> 400 common.validation_failed, no data read', async (_l, query) => {
    const w = world();
    await fails(ctxFor(w).run('listPartnerReports', { query }), 'common.validation_failed', 400);
    expect(w.sqlOf(/partners\.order_reports/i)).toEqual([]);
  });
});

// ------------------------------------------------------------------ R2
describe('T13 R2 markPartnerReportsSeen', () => {
  const mark = (w: World, report_versions: unknown, who: Who = 'adminX') => ctxFor(w, who).run('markPartnerReportsSeen', { body: { report_versions } });
  it('marks the listed own versions seen (is_new=false, seen_at=now, seen_by=actor); returns the count; other rows untouched', async () => {
    const w = world();
    const r = await mark(w, [{ report_id: RPT.a, version_no: 2 }, { report_id: RPT.c, version_no: 1 }]);
    expect(r).toEqual({ status: 200, body: { updated: 2 } });
    for (const [rep, v] of [[RPT.a, 2], [RPT.c, 1]] as const) expect(reportRow(w, rep, v)).toMatchObject({ is_new: false, seen_by: U.adminX });
    expect(iso(reportRow(w, RPT.a, 2).seen_at)).toBe('2026-11-13T06:00:00.000Z');
    expect(reportRow(w, RPT.a, 1)).toMatchObject({ is_new: false, status: 'superseded' });
    expect(reportRow(w, RPT.y, 1)).toMatchObject({ is_new: true, seen_at: null }); expect(reportRow(w, RPT.bb, 1)).toMatchObject({ is_new: true, seen_at: null });
    expect(reportKeys(await ctxFor(w).run('listPartnerReports', { query: { is_new: true } }))).toEqual([]);
  });
  it('a member of the same partner may mark (seen_by = the member)', async () => {
    const w = world(); await mark(w, [{ report_id: RPT.c, version_no: 1 }], 'memberX');
    expect(reportRow(w, RPT.c, 1)).toMatchObject({ is_new: false, seen_by: U.memberX });
  });
  it('ST2: foreign (Y, tenant B) and unknown ids are silently skipped: counted only when own, never revealed, foreign rows unchanged', async () => {
    const w = world(); const before = JSON.stringify([reportRow(w, RPT.y, 1), reportRow(w, RPT.bb, 1)]);
    const r = await mark(w, [{ report_id: RPT.y, version_no: 1 }, { report_id: RPT.bb, version_no: 1 }, { report_id: RPT.unknown, version_no: 1 }, { report_id: RPT.a, version_no: 9 }, { report_id: RPT.a, version_no: 2 }]);
    expect(r).toEqual({ status: 200, body: { updated: 1 } });
    expect(JSON.stringify([reportRow(w, RPT.y, 1), reportRow(w, RPT.bb, 1)])).toBe(before);
    expect(JSON.stringify(r)).not.toMatch(/not_found|skipped|foreign/i);
    const only = await mark(world(), [{ report_id: RPT.y, version_no: 1 }]);
    expect(only).toEqual({ status: 200, body: { updated: 0 } });
  });
  it('the same pair twice in one request counts once', async () => {
    expect((await mark(world(), [{ report_id: RPT.c, version_no: 1 }, { report_id: RPT.c, version_no: 1 }])).body).toEqual({ updated: 1 });
  });
  it('writes only partners.order_reports, bound to tenant + partner', async () => {
    const w = world(); await mark(w, [{ report_id: RPT.c, version_no: 1 }]);
    const writes = w.writes();
    expect(writes.length).toBeGreaterThan(0);
    for (const q of writes) { expect(q.text).toMatch(/partners\.order_reports/i); expect(q.values).toContain(T_A); expect(q.values).toContain(P.x); }
  });
  it.each([['empty list', []], ['201 items', Array.from({ length: 201 }, (_, i) => ({ report_id: RPT.a, version_no: i + 1 }))], ['version 0', [{ report_id: RPT.a, version_no: 0 }]],
    ['version 10001', [{ report_id: RPT.a, version_no: 10001 }]], ['report_id not uuid', [{ report_id: 'x', version_no: 1 }]], ['missing version', [{ report_id: RPT.a }]],
    ['extra key', [{ report_id: RPT.a, version_no: 1, is_new: false }]], ['not an array', { report_id: RPT.a, version_no: 1 }]])('validation: %s -> 400 common.validation_failed, nothing written', async (_l, report_versions) => {
    const w = world();
    await fails(mark(w, report_versions), 'common.validation_failed', 400);
    expect(w.writes()).toEqual([]);
  });
  it('body missing / unknown top-level key -> 400', async () => {
    const w = world();
    await fails(ctxFor(w).run('markPartnerReportsSeen', {}), 'common.validation_failed', 400);
    await fails(ctxFor(w).run('markPartnerReportsSeen', { body: { report_versions: [{ report_id: RPT.a, version_no: 2 }], all: true } }), 'common.validation_failed', 400);
    expect(w.writes()).toEqual([]);
  });
});

// ------------------------------------------------------------------ R3
describe('T13 R3 downloadPartnerReport (US-08.2 – US-08.7)', () => {
  const dl = (c: ReturnType<typeof ctxFor>, report: string, v: number) => c.run('downloadPartnerReport', { params: { report_id: report, version_no: v } });
  const denied = (w: World) => w.audit.filter((e) => e.outcome === 'denied'); const allowed = (w: World) => w.audit.filter((e) => e.outcome === 'allowed');

  it('US-08.2: 200 application/pdf attachment, bytes == stored sha256, headers, access log allowed, counter, port called with the REQUEST ctx', async () => {
    const f = stubStorage(); const w = world(); const c = ctxFor(w);
    const r = await dl(c, RPT.a, 2);
    expect(r.status).toBe(200);
    expect(Buffer.from(r.body as Uint8Array).equals(pdf(k(RPT.a, 2)))).toBe(true);
    const h = hdr(r.headers);
    expect(h['content-type']).toBe('application/pdf');
    expect(h['content-disposition']).toMatch(/^attachment;/); expect(h['content-disposition']).toContain('filename="report-SYN-0003-v2.pdf"');
    expect(h['x-content-type-options']).toBe('nosniff'); expect(h['cache-control']).toBe('no-store'); expect(h['x-lims-sha256']).toBe(FILES[k(RPT.a, 2)].sha256);
    expect(c.portCalls).toHaveLength(1);
    expect(c.portCalls[0]!.input).toEqual({ reportId: RPT.a, versionNo: 2 });
    expect(c.portCalls[0]!.ctx.actor).toMatchObject({ type: 'partner', id: U.adminX });
    expect(f).toEqual([FILES[k(RPT.a, 2)].signedUrl]);
    expect(w.audit).toHaveLength(1);
    expect(w.audit[0]).toMatchObject({ action: 'report.download', entityType: 'report_version', outcome: 'allowed', entityId: FILES[k(RPT.a, 2)].reportVersionId });
    expect(counter(w, U.adminX)).toMatchObject({ tenant_id: T_A, partner_id: P.x, count: 1 });
    // headers carry filename="report-SYN-0003-v2.pdf" by spec (02-TRD.md:238): scan them for markers / patient / panel names only
    expect(leaks([r.headers], [...MARKERS, 'Chandra', 'Synthetic Lipid'])).toEqual([]);
    expect(leaks([w.audit, c.logs, c.metrics], [...MARKERS, 'SYN-0003', 'Chandra', 'Synthetic Lipid'])).toEqual([]);
  });
  it('a member downloads too; the daily counter is per user and per day (2 downloads = 2)', async () => {
    stubStorage(); const w = world(); const c = ctxFor(w, 'memberX');
    await dl(c, RPT.b, 1); await dl(c, RPT.c, 1);
    expect(counter(w, U.memberX)).toMatchObject({ count: 2, partner_id: P.x }); expect(counter(w, U.adminX)).toBeUndefined();
    expect(allowed(w)).toHaveLength(2);
  });
  it('partner Y downloads its own report (symmetry); X cannot (next test)', async () => {
    stubStorage(); const w = world(); const r = await dl(ctxFor(w, 'adminY'), RPT.y, 1);
    expect(r.status).toBe(200); expect(hdr(r.headers)['content-disposition']).toContain('report-SYN-Y001-v1.pdf');
  });
  it('US-08.4: a superseded version can still be downloaded (C13 does not alter the PDF)', async () => {
    stubStorage(); const w = world(); const r = await dl(ctxFor(w), RPT.a, 1);
    expect(r.status).toBe(200); expect(Buffer.from(r.body as Uint8Array).equals(pdf(k(RPT.a, 1)))).toBe(true);
    expect(hdr(r.headers)['content-disposition']).toContain('filename="report-SYN-0003-v1.pdf"');
  });

  describe('denied: 404 + denied access log committed (ctx.commitOnError), no port call, no fetch', () => {
    it.each([['US-08.3 report of partner Y', RPT.y, 1], ['report of tenant B', RPT.bb, 1], ['US-08.5 unknown / unreleased report', RPT.unknown, 1], ['unknown version of an own report', RPT.a, 3]])('%s', async (_l, report, v) => {
      const f = stubStorage(); const w = world(); const c = ctxFor(w, 'adminX', { portKnowsForeign: true });
      const e = await fails(dl(c, report, v), 'common.not_found', 404);
      expect(c.state.committed).toBe(true);
      expect(w.audit).toHaveLength(1);
      expect(w.audit[0]).toMatchObject({ action: 'report.download', entityType: 'report_version', outcome: 'denied' });
      if (w.audit[0].entityId !== undefined) expect(w.audit[0].entityId).toMatch(/^[0-9a-f-]{36}$/);
      expect(c.portCalls).toEqual([]); expect(f).toEqual([]);
      expect(leaks([e, w.audit, c.logs], [...MARKERS, 'SYN-Y001', 'Yogesh', 'SYN-B001', 'Synthetic Partner Y'])).toEqual([]);
      expect(w.t['partners.download_counters']).toEqual([]);
    });
    it('a port common.not_found for an own row (unreleased / vanished at C6) -> the same 404 + denied log, committed, no fetch', async () => {
      const f = stubStorage(); const w = world(); const c = ctxFor(w, 'adminX', { portError: new LimsError('common.not_found') });
      await fails(dl(c, RPT.a, 2), 'common.not_found', 404);
      expect(c.state.committed).toBe(true); expect(denied(w)).toHaveLength(1); expect(allowed(w)).toEqual([]); expect(f).toEqual([]);
    });
    it('id guessing: 5 foreign attempts -> 5 denied rows, still no data, X\'s own download works afterwards', async () => {
      stubStorage(); const w = world(); const c = ctxFor(w);
      for (let i = 0; i < 5; i++) await fails(dl(c, RPT.y, 1), 'common.not_found', 404);
      expect(denied(w)).toHaveLength(5); expect((await dl(c, RPT.a, 2)).status).toBe(200);
    });
  });

  describe('ST11 sha256 + storage failures: no bytes, no allowed log, signed URL never leaks', () => {
    it('sha256 mismatch (same size, different bytes) aborts: error, nothing returned, `report_hash_mismatch` logged with ids only, no allowed row, counter not kept', async () => {
      const good = FILES[k(RPT.a, 2)]; const bad = Buffer.from(pdf(k(RPT.a, 2))); bad[bad.length - 2] ^= 0xff;
      stubStorage({ [good.signedUrl]: bad });
      const w = world(); const c = ctxFor(w);
      const e: any = await dl(c, RPT.a, 2).then((r) => { throw new Error(`served ${JSON.stringify(r).slice(0, 80)}`); }, (x) => x);
      expect(e).toBeInstanceOf(Error);
      expect(leaks(e, [...MARKERS, 'SYN-0003', 'Chandra'])).toEqual([]);
      expect(c.logs.some((l) => l.includes('report_hash_mismatch'))).toBe(true);
      expect(leaks(c.logs, [...MARKERS, 'SYN-0003', 'Chandra', 'Synthetic'])).toEqual([]);
      expect(allowed(w)).toEqual([]); expect(counter(w, U.adminX)).toBeUndefined();
    });
    it('a truncated / empty body is a mismatch too', async () => {
      const good = FILES[k(RPT.b, 1)];
      for (const bytes of [pdf(k(RPT.b, 1)).subarray(0, 10), Buffer.alloc(0)]) {
        const f = stubStorage({ [good.signedUrl]: bytes });
        const w = world(); const c = ctxFor(w);
        await dl(c, RPT.b, 1).then(() => { throw new Error('served'); }, () => undefined);
        expect(f).toEqual([good.signedUrl]); // the bytes were fetched and then refused (a stub never fetches)
        expect(allowed(w)).toEqual([]);
      }
    });
    it.each([['network error', new TypeError('fetch failed')], ['storage 500', 500], ['storage 404', 404]])('storage failure (%s) -> error (dependency_unavailable | internal), no allowed row, URL not in the error', async (_l, fail) => {
      const f = stubStorage({ [FILES[k(RPT.a, 2)].signedUrl]: fail as any });
      const w = world(); const c = ctxFor(w);
      const e = await dl(c, RPT.a, 2).then(() => { throw new Error('served'); }, (x) => x);
      expect(f).toEqual([FILES[k(RPT.a, 2)].signedUrl]); expect(c.portCalls).toHaveLength(1);
      expect(['common.dependency_unavailable', 'common.internal']).toContain((e as LimsError).code);
      expect(leaks([e, c.logs, w.audit], MARKERS)).toEqual([]); expect(allowed(w)).toEqual([]);
    });
    it('a port failure other than not_found (C6 down) propagates unchanged: no 404, no denied row, no fetch', async () => {
      const f = stubStorage(); const w = world(); const err = new LimsError('common.dependency_unavailable');
      const c = ctxFor(w, 'adminX', { portError: err });
      expect(await dl(c, RPT.a, 2).then(() => undefined, (e) => e)).toBe(err);
      expect(w.audit).toEqual([]); expect(f).toEqual([]);
    });
  });

  describe('US-08.6 rate tier report_download (20 per hour per user + report)', () => {
    it('consumes tier report_download with key partner_user:<partner_user_id>:report:<report_id>; member and admin keys differ; another report differs', async () => {
      stubStorage(); const w = world(); const a = ctxFor(w), m = ctxFor(w, 'memberX');
      await dl(a, RPT.a, 2); await dl(a, RPT.b, 1); await dl(m, RPT.a, 2);
      expect(a.limiterCalls).toContainEqual({ tier: 'report_download', key: `partner_user:${U.adminX}:report:${RPT.a}` });
      expect(a.limiterCalls).toContainEqual({ tier: 'report_download', key: `partner_user:${U.adminX}:report:${RPT.b}` });
      expect(m.limiterCalls).toContainEqual({ tier: 'report_download', key: `partner_user:${U.memberX}:report:${RPT.a}` });
    });
    it('21st download of one report within the window -> 429 common.rate_limited (the limiter\'s error, unchanged); first 20 served; 21st: no port call, no bytes, nothing counted; another report still works', async () => {
      const f = stubStorage(); const w = world(); const c = ctxFor(w);
      for (let i = 0; i < 20; i++) expect((await dl(c, RPT.a, 2)).status).toBe(200);
      const e = await fails(dl(c, RPT.a, 2), 'common.rate_limited', 429);
      expect(e).toBeInstanceOf(LimsError);
      expect(c.portCalls).toHaveLength(20); expect(f).toHaveLength(20); expect(allowed(w)).toHaveLength(20); expect(counter(w, U.adminX)).toMatchObject({ count: 20 });
      expect((await dl(c, RPT.b, 1)).status).toBe(200);
      expect(c.metrics).toContainEqual({ name: 'lims_partners_report_downloads_total', labels: { outcome: 'rate_limited' }, by: 1 }); // SEAM
    });
  });

  describe('US-08.7 daily cap per user (partners.settings.report_download_daily_cap_per_user, default 500)', () => {
    const seedCounter = (w: World, user: string, d: string, count: number, partner = P.x) =>
      w.t['partners.download_counters']!.push({ tenant_id: T_A, partner_user_id: user, day: d, partner_id: partner, count, expires_at: new Date('2026-12-13T00:00:00Z'), created_at: new Date(), created_by: user, updated_at: new Date(), updated_by: user });
    it('cap 3: three downloads served, the 4th -> 429 common.rate_limited with no port call / bytes / count; another user unaffected; yesterday\'s count not carried; next day allowed again', async () => {
      const f = stubStorage(); const w = world({ cap: 3 }); seedCounter(w, U.adminX, '2026-11-12', 3);
      const c = ctxFor(w);
      for (let i = 1; i <= 3; i++) { expect((await dl(c, RPT.a, 2)).status).toBe(200); expect(counter(w, U.adminX)!.count).toBe(i); }
      await fails(dl(c, RPT.a, 2), 'common.rate_limited', 429);
      expect(c.portCalls).toHaveLength(3); expect(f).toHaveLength(3); expect(allowed(w)).toHaveLength(3); expect(counter(w, U.adminX)!.count).toBe(3);
      expect(c.metrics).toContainEqual({ name: 'lims_partners_report_downloads_total', labels: { outcome: 'rate_limited' }, by: 1 }); // SEAM
      expect((await dl(ctxFor(w, 'memberX'), RPT.a, 2)).status).toBe(200); expect(counter(w, U.memberX)!.count).toBe(1);
      const tomorrow = ctxFor(w, 'adminX', { now: '2026-11-14T06:00:00.000Z' });
      expect((await dl(tomorrow, RPT.a, 2)).status).toBe(200);
      expect(counter(w, U.adminX, '2026-11-14')!.count).toBe(1); expect(counter(w, U.adminX)!.count).toBe(3); expect(counter(w, U.adminX, '2026-11-12')!.count).toBe(3);
    });
    it('default cap 500 without a settings row: 499 -> served (500), then 429', async () => {
      stubStorage(); const w = world(); seedCounter(w, U.adminX, TODAY, 499);
      const c = ctxFor(w);
      expect((await dl(c, RPT.a, 2)).status).toBe(200); expect(counter(w, U.adminX)!.count).toBe(500);
      await fails(dl(c, RPT.a, 1), 'common.rate_limited', 429); expect(counter(w, U.adminX)!.count).toBe(500);
    });
    it('another tenant\'s cap / counters never apply (tenant B user is not limited by tenant A\'s cap row)', async () => {
      stubStorage(); const w = world({ cap: 1 }); const c = ctxFor(w, 'adminB');
      expect((await dl(c, RPT.bb, 1)).status).toBe(200); expect((await dl(c, RPT.bb, 1)).status).toBe(200);
    });
  });

  it('SEAM metrics: lims_partners_report_downloads_total outcome allowed / denied', async () => {
    stubStorage(); const w = world(); const c = ctxFor(w);
    await dl(c, RPT.a, 2); await fails(dl(c, RPT.y, 1), 'common.not_found');
    expect(c.metrics.filter((m) => m.name === 'lims_partners_report_downloads_total').map((m) => m.labels['outcome'])).toEqual(['allowed', 'denied']);
  });
});

// ------------------------------------------------------------------ probes + log-scan (ST2, ST11, ST13, REQ-SEC-098)
const NEEDLES = ['Synthetic Aarav', 'Synthetic Binita', 'Synthetic Chandra', 'Synthetic Dipesh', 'Synthetic Esha', 'Yogesh', 'SYN-REF-00', 'SYN-0001', 'SYN-0003', 'SYN-MF-00', 'Synthetic Lipid', 'Synthetic Renal',
  'Synthetic Hemogram', PHI.phone, PHI.note, PHI.dob, ...MARKERS, 'Dr Synthetic'];
async function battery(w: World, c: ReturnType<typeof ctxFor>) {
  const tries: Array<[string, Partial<{ params: object; query: object; body: unknown }>]> = [
    ['listPartnerOrders', { query: { tracking_status: 'in_lab,reported', manifest_id: MAN.m1, has_new_report: true, limit: 2 } }], ['listPartnerOrders', {}], ['listPartnerOrders', { query: { cursor: 'bad cursor!!' } }],
    ['searchPartnerOrders', { body: { q: 'Synthetic Binita' } }], ['searchPartnerOrders', { body: { q: 'SYN-REF-002' } }], ['searchPartnerOrders', { body: { q: 'x' } }],
    ['getPartnerOrder', { params: { order_id: ORD.lab } }], ['getPartnerOrder', { params: { order_id: ORD.y } }], ['listPartnerReports', { query: { include_superseded: true } }],
    ['markPartnerReportsSeen', { body: { report_versions: [{ report_id: RPT.a, version_no: 2 }, { report_id: RPT.y, version_no: 1 }] } }],
    ['downloadPartnerReport', { params: { report_id: RPT.a, version_no: 2 } }], ['downloadPartnerReport', { params: { report_id: RPT.y, version_no: 1 } }],
  ];
  const errors: unknown[] = []; let ok = 0;
  for (const [op, req] of tries) await c.run(op, req).then(() => { ok++; }, (e) => errors.push(e));
  return { errors, ok };
}
describe('T13 probes + log-scan', () => {
  it('ST13: planted synthetic PHI / lab identifiers / q / signed URLs never reach logs, access-log entries, metrics, errors, or SQL text (values are bound)', async () => {
    stubStorage(); const w = world(); const c = ctxFor(w);
    const { errors, ok } = await battery(w, c);
    expect([ok, errors.length]).toEqual([8, 4]); // 8 calls succeed, 4 fail validation / 404 (a stub makes all 12 fail)
    expect(leaks(c.logs, NEEDLES)).toEqual([]); expect(leaks(w.audit, NEEDLES)).toEqual([]); expect(leaks(c.metrics, NEEDLES)).toEqual([]);
    for (const e of errors) expect(leaks(e, NEEDLES), String(e)).toEqual([]);
    expect(leaks(w.log.map((q) => q.text), NEEDLES.filter((n) => n !== 'Dr Synthetic'))).toEqual([]);
    expect(leaks(w.log.map((q) => q.text), [P.x, T_A, ORD.lab, RPT.a, MAN.m1])).toEqual([]); // no id is ever interpolated either
  });
  it('ST2: every read / write of a partner-owned table binds tenant_id AND partner_id of the caller (no RLS help in this world)', async () => {
    stubStorage();
    for (const [who, partner, tenant] of [['adminX', P.x, T_A], ['adminY', P.y, T_A], ['adminB', P.b, T_B]] as const) {
      const w = world(); const c = ctxFor(w, who); await battery(w, c);
      const owned = w.log.filter((q) => /\bpartners\.(order_tracking|manifest_lines|tracked_specimens|order_reports|manifests|partner_referrers|download_counters)\b/i.test(q.text));
      expect(owned.length, who).toBeGreaterThan(0);
      for (const q of owned) { expect(q.values, `${who}: ${q.text}`).toContain(tenant); expect(q.values, `${who}: ${q.text}`).toContain(partner); }
    }
  });
  it('ST2: partner X credentials with partner Y / tenant B ids across all six operations leave Y and B data unchanged and return no Y / B data', async () => {
    stubStorage(); const w = world(); const c = ctxFor(w);
    const before = JSON.stringify([w.t['partners.order_reports']!.filter((r) => r.partner_id !== P.x), w.t['partners.order_tracking']!.filter((r) => r.partner_id !== P.x)]);
    const { errors, ok } = await battery(w, c);
    expect([ok, errors.length]).toEqual([8, 4]);
    expect(JSON.stringify([w.t['partners.order_reports']!.filter((r) => r.partner_id !== P.x), w.t['partners.order_tracking']!.filter((r) => r.partner_id !== P.x)])).toBe(before);
    for (const e of errors) expect(leaks(e, ['SYN-Y001', 'Yogesh', 'SYN-B001'])).toEqual([]);
  });
  it('US-07.8 / REQ-SEC-098 contract: the only search operation is POST with q in the body; no GET under /orders or /reports takes a free-text / patient parameter', () => {
    const spec: any = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'partners.yaml'));
    const search = spec.paths['/v1/partners/orders/search'];
    expect(Object.keys(search)).toEqual(expect.arrayContaining(['post'])); expect(search.get).toBeUndefined();
    expect(search.post.operationId).toBe('searchPartnerOrders');
    expect(search.post.requestBody.content['application/json'].schema.properties.q).toBeDefined();
    expect((search.post.parameters ?? []).filter((p: any) => p.in === 'query')).toEqual([]);
    for (const [path, item] of Object.entries<any>(spec.paths)) {
      if (!/^\/v1\/partners\/(orders|reports)/.test(path) || !item.get) continue;
      for (const p of item.get.parameters ?? []) expect(String(p.name ?? p.$ref), `${path} ${p.name}`).not.toMatch(/^(q|search|term|name|patient.*|full_name|phone|ref|partner_sample_ref|registration_no)$/i);
    }
  });
});
