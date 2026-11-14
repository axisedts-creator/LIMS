// C16.T-P2 — E20 listMyOrders + E21 getMyOrder (patient): visible_from filter, ETag / 304 polling contract, account-B probes (06-PLAN row T-P2; 02-TRD §4.4 (read-time filters, cancelled 30 d),
// §4.6 (ETag "<order version>.<max specimen seq>.<report count>"), §5 E20/E21, §9.1 handler pattern; 01-PRD US-EN-07.5-7; 07-SECURITY probe P-L1 (A2 vs X's order -> 404), REQ-SEC-024, E20-E24 row (heavy polling -> 304)).
// Fails now: handlers/index.ts maps listMyOrders / getMyOrder to the T-01 placeholder (common.service_unavailable).
//
// SEAMS (spec fixes behaviour, not names; same convention as link.redeem.test.ts):
//   handlers.listMyOrders({params:{}, query:{profile_id?, stage?, limit?, cursor?}, headers}, ctx) -> {status:200, body:{data:PatientOrder[], page:{next_cursor?, limit}}, headers:{cache-control:'no-store'}}
//   handlers.getMyOrder({params:{order_id}, query:{}, headers:{'if-none-match'?}}, ctx) -> {status:200, body:PatientOrderDetail, headers:{etag, cache-control:'no-store'}} | {status:304, headers:{etag}} (no body)
//   ctx = world.patientCtx(account) (actor patient, claims.membership_id). IdentityPort.assertRole(ctx, {permission:'engagement.self.read'}) runs before any query; a non-patient actor -> auth.forbidden.
//   Reads engagement.patient_orders / patient_order_specimens / patient_reports (+ booking_centres for centre_display_name) and the caller's account_patient_links, in PLAIN SQL the world's fake can run (link.world.ts header; no JOIN).
//   The world's RLS does NOT narrow patient_orders to the caller's links (the real PAT_VIS policy does, 05-SCHEMA §5): the service must filter by the caller's own ACTIVE links itself (REQ-SEC-024, TRD §9.1), and bind tenant_id.
//   profile_id in the DTO = the link id (TRD §3.? Profile: "profile_id (= link id)"), never patient_id. Stage of a specimen = domain/stage.ts specimenStage(status, {recollectionRequired}).
// NOT pinned (spec silent): rows of pre_registered orders (registered_at NULL); the exact cursor format; the 426 app-version guard (needs min-version settings); superseded reports in the detail list.
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';
import { handlers } from '../../handlers/index.js';
import { ID, TENANT_B, T0, makeLinkWorld, type LinkWorld } from '../../__tests__/link.world.js';

const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/engagement.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const schemaErrors = (name: string, x: unknown): string[] => { const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components }); return v(x) ? [] : (v.errors as any[]).map((e) => `${e.instancePath} ${e.message}`); };
const opOf = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };

const PHONE_A = '+99001000001', PHONE_B = '+99001000002';
const X = ID(0x800), Y = ID(0x801), X2 = ID(0x802); // patients: X (A1), Y (A2), X2 (A1, second profile)
const CENTRE = ID(0x810), BRANCH = ID(0x811);
const DAY = 86_400_000, T = Date.parse(T0);
const iso = (offsetMs: number) => new Date(T + offsetMs).toISOString();
const HDR = { 'x-lims-app-version': '1.0.0', 'x-lims-app-platform': 'android' };
const rejection = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } throw new Error('expected a rejection'); };
const shape = (e: any) => ({ code: e.code, statusCode: e.statusCode, detail: e.detail });
const hdr = (res: any, name: string): unknown => { const k = Object.keys(res?.headers ?? {}).find((h) => h.toLowerCase() === name.toLowerCase()); return k ? res.headers[k] : undefined; };

let seq = 0x900;
interface Fx {
  w: LinkWorld; a1: Record<string, any>; a2: Record<string, any>; linkX: Record<string, any>; linkY: Record<string, any>;
  order: (o?: Record<string, any>) => Record<string, any>; specimen: (orderId: string, o?: Record<string, any>) => Record<string, any>; report: (orderId: string, o?: Record<string, any>) => Record<string, any>;
  list: (q?: Record<string, any>, who?: Record<string, any>) => Promise<any>; get: (orderId: string, h?: Record<string, any>, who?: Record<string, any>) => Promise<any>;
}
/** Tenant A: account A1 linked to X (active, visible_from NULL), account A2 linked to Y. Orders are seeded straight into the read model (what T-P1 / backfill write). */
function setup(o: { showPartner?: boolean } = {}): Fx {
  const w = makeLinkWorld({ showPartnerOrders: o.showPartner });
  const a1 = w.seedAccount(PHONE_A), a2 = w.seedAccount(PHONE_B);
  const linkX = w.seedLink(a1['id'], X), linkY = w.seedLink(a2['id'], Y);
  const order = (over: Record<string, any> = {}) => {
    const r: Record<string, any> = { tenant_id: w.tenantId, order_id: ID(++seq), patient_id: X, centre_id: CENTRE, branch_id: BRANCH, source: 'front_desk', booking_id: null, order_status: 'registered', registered_at: iso(-DAY), visible_at: over['registered_at'] ?? iso(-DAY),
      stage: 'registered', payment_due: false, invoiced_paisa: null, paid_paisa: null, balance_due_paisa: null, balance_version: null, release_basis: null, status_version: 1, synced_at: w.now(), created_by: ID(0x7aa), updated_by: ID(0x7aa), created_at: w.now(), updated_at: w.now(), ...over };
    w.t['patient_orders']!.push(r); return r;
  };
  const specimen = (orderId: string, over: Record<string, any> = {}) => {
    const r: Record<string, any> = { tenant_id: w.tenantId, specimen_id: ID(++seq), order_id: orderId, patient_id: X, specimen_type_code: 'SERUM', status: 'ordered', status_seq: 1, ordinal: 1, collected_at: null, received_at: null, rejected_at: null,
      rejection_reason_code: null, recollection_required: false, replaces_specimen_id: null, created_by: ID(0x7aa), updated_by: ID(0x7aa), created_at: w.now(), updated_at: w.now(), ...over };
    w.t['patient_order_specimens']!.push(r); return r;
  };
  const report = (orderId: string, over: Record<string, any> = {}) => {
    const r: Record<string, any> = { tenant_id: w.tenantId, report_id: ID(++seq), version_no: 1, order_id: orderId, patient_id: X, report_kind: 'final', status: 'valid', released_at: iso(-DAY / 2), supersedes_version_no: null, panel_names: ['Synthetic Panel'],
      smart_summary_available: false, created_by: ID(0x7aa), updated_by: ID(0x7aa), created_at: w.now(), updated_at: w.now(), ...over };
    w.t['patient_reports']!.push(r); return r;
  };
  const list = (query: Record<string, any> = {}, who: Record<string, any> = a1) => w.inTx(() => (handlers as any).listMyOrders({ params: {}, query, headers: { ...HDR } }, w.patientCtx(who)));
  const get = (orderId: string, h: Record<string, any> = {}, who: Record<string, any> = a1) => w.inTx(() => (handlers as any).getMyOrder({ params: { order_id: orderId }, query: {}, headers: { ...HDR, ...h } }, w.patientCtx(who)));
  return { w, a1, a2, linkX, linkY, order, specimen, report, list, get };
}
const ids = (res: any): string[] => res.body.data.map((d: any) => d.order_id);

describe('contract sanity (the spec is the source of permission, idempotency and the 304)', () => {
  it('E20 / E21: engagement.self.read, no idempotency, general tier; E21 declares 200 + 304 + 404', () => {
    for (const op of ['listMyOrders', 'getMyOrder']) expect(opOf(op)).toMatchObject({ 'x-permission': 'engagement.self.read', 'x-idempotency': 'none', 'x-rate-limit-tier': 'general' });
    expect(Object.keys(opOf('getMyOrder').responses)).toEqual(expect.arrayContaining(['200', '304']));
    expect(opOf('getMyOrder')['x-error-codes']).toContain('common.not_found');
  });
});

describe('guards: permission first, patient actors only', () => {
  for (const op of ['list', 'get'] as const) {
    it(`${op}: assertRole(engagement.self.read) runs before any query; without it auth.forbidden and no statement at all`, async () => {
      const f = setup(); const o = f.order(); const call = () => (op === 'list' ? f.list() : f.get(o['order_id']));
      await call(); const first = f.w.identity.calls[0]!; expect(first.permission).toBe('engagement.self.read'); expect(first.at).toBe(0);
      const g = setup(); const o2 = g.order(); g.w.identity.grants = []; const before = g.w.stmts.length;
      const e = await rejection(op === 'list' ? g.list() : g.get(o2['order_id'])); expect(e.code).toBe('auth.forbidden'); expect(g.w.stmts.length).toBe(before);
    });
    it(`${op}: a non-patient actor (staff) is refused with auth.forbidden before any query`, async () => {
      const f = setup(); const o = f.order(); const staff = f.w.patientCtx(f.a1, { actor: { type: 'user', id: ID(0x7aa) } });
      const req = op === 'list' ? { params: {}, query: {}, headers: { ...HDR } } : { params: { order_id: o['order_id'] }, query: {}, headers: { ...HDR } };
      const e = await rejection(f.w.inTx(() => (handlers as any)[op === 'list' ? 'listMyOrders' : 'getMyOrder'](req, staff))); expect(e.code).toBe('auth.forbidden');
      expect(f.w.stmts).toHaveLength(0);
    });
  }
});

describe('E20 listMyOrders', () => {
  it('lists the caller\'s linked patient orders newest first; DTO is schema-valid, profile_id = link id, no patient_id / centre ids / specimen type leaks', async () => {
    const f = setup(); const o1 = f.order({ registered_at: iso(-3 * DAY) }), o2 = f.order({ registered_at: iso(-1 * DAY), stage: 'in_lab' }), o3 = f.order({ registered_at: iso(-2 * DAY), stage: 'sample_collected' });
    f.specimen(o2['order_id'], { ordinal: 1, status: 'received' }); f.specimen(o2['order_id'], { ordinal: 2, status: 'collected' }); f.report(o2['order_id']);
    const res = await f.list();
    expect(res.status).toBe(200); expect(ids(res)).toEqual([o2['order_id'], o3['order_id'], o1['order_id']]);
    for (const d of res.body.data) { expect(schemaErrors('PatientOrder', d)).toEqual([]); expect(d.profile_id).toBe(f.linkX['id']); }
    const top = res.body.data[0]; expect(top).toMatchObject({ stage: 'in_lab', specimen_count: 2, report_count: 1, payment_due: false });
    expect(JSON.stringify(res.body)).not.toMatch(/patient_id|centre_id|branch_id|specimen_type|SERUM|rejection/);
    expect(String(hdr(res, 'cache-control'))).toMatch(/no-store/i);
  });
  it('payment_due true carries the balance as Money (NPR paisa); payment_due false does not', async () => {
    const f = setup(); const due = f.order({ payment_due: true, balance_due_paisa: 225000, invoiced_paisa: 225000, paid_paisa: 0 }), paid = f.order({ registered_at: iso(-2 * DAY) });
    const res = await f.list(); const byId = Object.fromEntries(res.body.data.map((d: any) => [d.order_id, d]));
    expect(byId[due['order_id']]).toMatchObject({ payment_due: true, balance_due: { amount_paisa: 225000, currency: 'NPR' } }); expect(byId[paid['order_id']].payment_due).toBe(false);
    for (const d of res.body.data) expect(schemaErrors('PatientOrder', d)).toEqual([]);
  });
  it('centre_display_name comes from engagement.booking_centres (never ctx.core); absent row -> field omitted', async () => {
    const f = setup(); const o = f.order(); const other = f.order({ centre_id: ID(0x812), registered_at: iso(-2 * DAY) });
    f.w.t['booking_centres']!.push({ id: ID(0x813), tenant_id: f.w.tenantId, centre_id: CENTRE, branch_id: BRANCH, display_name: 'Synthetic Centre A', address_text: null, is_active: true, synced_at: f.w.now() });
    const res = await f.list(); const byId = Object.fromEntries(res.body.data.map((d: any) => [d.order_id, d]));
    expect(byId[o['order_id']].centre_display_name).toBe('Synthetic Centre A'); expect(byId[other['order_id']].centre_display_name).toBeUndefined();
  });
  it('profile_id narrows to one link; stage filters; a foreign profile_id never yields foreign orders', async () => {
    const f = setup(); const l2 = f.w.seedLink(f.a1['id'], X2, { relationship: 'child' });
    const a = f.order({ stage: 'in_lab' }), b = f.order({ patient_id: X2, stage: 'report_ready', registered_at: iso(-2 * DAY) }), c = f.order({ patient_id: Y, registered_at: iso(-3 * DAY) });
    expect(ids(await f.list({ profile_id: l2['id'] }))).toEqual([b['order_id']]);
    expect(ids(await f.list({ profile_id: f.linkX['id'] }))).toEqual([a['order_id']]);
    expect(ids(await f.list({ stage: 'report_ready' }))).toEqual([b['order_id']]);
    expect(ids(await f.list())).toEqual([a['order_id'], b['order_id']]);
    let leaked: string[] = []; try { leaked = ids(await f.list({ profile_id: f.linkY['id'] })); } catch (e: any) { expect(e.code).toBe('common.not_found'); }
    expect(leaked).toEqual([]); expect(leaked).not.toContain(c['order_id']);
  });
  it('visible_from (US-EN-07.6): orders with visible_at before the link\'s visible_from are not listed; at-or-after are (>=)', async () => {
    const f = setup(); f.linkX['visible_from'] = iso(-10 * DAY);
    const before = f.order({ registered_at: iso(-11 * DAY) }), edge = f.order({ registered_at: iso(-10 * DAY) }), after = f.order({ registered_at: iso(-5 * DAY) });
    const res = await f.list(); expect(ids(res)).toEqual([after['order_id'], edge['order_id']]); expect(ids(res)).not.toContain(before['order_id']);
  });
  it('visible_at (not registered_at) is the anchor: a booking-origin order whose slot is after visible_from is shown', async () => {
    const f = setup(); f.linkX['visible_from'] = iso(-2 * DAY);
    const o = f.order({ source: 'engagement_booking', order_status: 'pre_registered', registered_at: iso(-20 * DAY), visible_at: iso(-1 * DAY) });
    expect(ids(await f.list())).toEqual([o['order_id']]);
  });
  it('suspended and revoked links hide that patient\'s orders (03-APP-FLOW §3.4; TRD §4.3.3)', async () => {
    const f = setup(); f.order(); const g = setup(); g.order();
    Object.assign(f.linkX, { status: 'suspended', suspend_reason: 'phone_mismatch', suspended_at: f.w.now() });
    Object.assign(g.linkX, { status: 'revoked', revoked_by_kind: 'patient', revoked_at: g.w.now(), is_active: false });
    for (const x of [f, g]) { let got: string[] = []; try { got = ids(await x.list()); } catch (e: any) { expect(['common.not_found', 'auth.forbidden']).toContain(e.code); } expect(got).toEqual([]); }
  });
  it('cancelled orders are listed (stage cancelled) for 30 days after the cancellation was projected, then hidden (TRD §4.4)', async () => {
    const f = setup(); const fresh = f.order({ order_status: 'cancelled', stage: 'cancelled', updated_at: iso(-29 * DAY) }), stale = f.order({ order_status: 'cancelled', stage: 'cancelled', updated_at: iso(-31 * DAY), registered_at: iso(-40 * DAY) });
    const live = f.order({ registered_at: iso(-2 * DAY) });
    const res = await f.list(); expect(ids(res)).toEqual(expect.arrayContaining([fresh['order_id'], live['order_id']])); expect(ids(res)).not.toContain(stale['order_id']);
    expect(res.body.data.find((d: any) => d.order_id === fresh['order_id']).stage).toBe('cancelled');
  });
  it('keyset paging: limit 2 over 5 orders walks every order once, newest first; the page is schema-valid', async () => {
    const f = setup(); const all = [1, 2, 3, 4, 5].map((n) => f.order({ registered_at: iso(-n * DAY) }));
    const seen: string[] = []; let cursor: string | undefined; let pages = 0;
    do { const res: any = await f.list({ limit: 2, ...(cursor ? { cursor } : {}) }); expect(res.body.data.length).toBeLessThanOrEqual(2); expect(res.body.page.limit).toBe(2); seen.push(...ids(res)); cursor = res.body.page.next_cursor; pages++; } while (cursor && pages < 10);
    expect(seen).toEqual(all.map((o) => o['order_id'])); expect(pages).toBe(3);
  });
  it('same registered_at: ties are ordered by order_id and no order is skipped or repeated across a page boundary', async () => {
    const f = setup(); const same = iso(-DAY); const rows = [f.order({ registered_at: same }), f.order({ registered_at: same }), f.order({ registered_at: same })];
    const first = await f.list({ limit: 2 }); const second = await f.list({ limit: 2, cursor: first.body.page.next_cursor });
    expect([...ids(first), ...ids(second)].sort()).toEqual(rows.map((r) => r['order_id']).sort());
  });
  it('is read-only: no INSERT / UPDATE / DELETE, no access_log, no job; every statement on the read model binds tenant_id (REQ-SEC-024)', async () => {
    const f = setup(); f.order(); await f.list();
    expect(f.w.writes()).toEqual([]); expect(f.w.audit).toEqual([]); expect(f.w.jobs()).toEqual([]);
    const reads = f.w.stmts.filter((s) => /patient_orders|patient_order_specimens|patient_reports|account_patient_links|booking_centres/.test(s.text)); expect(reads.length).toBeGreaterThan(0);
    for (const s of reads) expect(s.text, s.text).toMatch(/tenant_id/);
  });
});

describe('E21 getMyOrder: detail + ETag', () => {
  function full() {
    const f = setup(); const o = f.order({ stage: 'in_lab', status_version: 4, registered_at: iso(-DAY) });
    const s1 = f.specimen(o['order_id'], { ordinal: 1, status: 'received', status_seq: 3, collected_at: iso(-DAY / 2), received_at: iso(-DAY / 3) }), s2 = f.specimen(o['order_id'], { ordinal: 2, status: 'collected', status_seq: 5, collected_at: iso(-DAY / 2) });
    const r1 = f.report(o['order_id'], { panel_names: ['Synthetic CBC'] }), r2 = f.report(o['order_id'], { panel_names: ['Synthetic Lipids'], report_kind: 'partial' });
    return { f, o, s1, s2, r1, r2 };
  }
  it('200: schema-valid detail; specimens by ordinal with stage and times, reports of the order, ETag header, no-store; nothing internal leaks', async () => {
    const { f, o } = full(); const res = await f.get(o['order_id']);
    expect(res.status).toBe(200); expect(schemaErrors('PatientOrderDetail', res.body)).toEqual([]);
    expect(res.body).toMatchObject({ order_id: o['order_id'], profile_id: f.linkX['id'], stage: 'in_lab', specimen_count: 2, report_count: 2 });
    expect(res.body.specimens).toEqual([
      { specimen_ref: 1, stage: 'in_lab', collected_at: iso(-DAY / 2), received_at: iso(-DAY / 3) },
      { specimen_ref: 2, stage: 'sample_collected', collected_at: iso(-DAY / 2) },
    ]);
    expect(res.body.reports.map((r: any) => r.panel_names).flat().sort()).toEqual(['Synthetic CBC', 'Synthetic Lipids']);
    for (const r of res.body.reports) expect(r).toMatchObject({ profile_id: f.linkX['id'], order_id: o['order_id'], status: 'valid' });
    expect(JSON.stringify(res.body)).not.toMatch(/patient_id|specimen_type|SERUM|rejection|status_seq/);
    expect(String(hdr(res, 'cache-control'))).toMatch(/no-store/i);
  });
  it('a recollection specimen shows stage recollection_needed and never its rejection reason (PRD US-EN-07.4)', async () => {
    const f = setup(); const o = f.order({ stage: 'recollection_needed' });
    f.specimen(o['order_id'], { status: 'rejected', status_seq: 4, recollection_required: true, rejected_at: iso(-3600_000), rejection_reason_code: 'HAEMOLYSED' });
    const res = await f.get(o['order_id']); expect(res.body.specimens[0].stage).toBe('recollection_needed'); expect(JSON.stringify(res.body)).not.toMatch(/HAEMOLYSED|rejection/i);
  });
  it('ETag = "<status_version>.<max specimen status_seq>.<report count>" (quoted) and the body etag is the same value (TRD §4.6)', async () => {
    const { f, o } = full(); const res = await f.get(o['order_id']);
    expect(hdr(res, 'etag')).toBe('"4.5.2"'); expect(res.body.etag).toBe('"4.5.2"');
    const bare = setup(); const o2 = bare.order({ status_version: 1 }); expect(hdr(await bare.get(o2['order_id']), 'etag')).toBe('"1.0.0"'); // no specimens, no reports
  });
  it('304 when If-None-Match equals the current ETag: no body, ETag repeated; any other value -> 200', async () => {
    const { f, o } = full();
    const same = await f.get(o['order_id'], { 'if-none-match': '"4.5.2"' }); expect(same.status).toBe(304); expect(same.body).toBeUndefined(); expect(hdr(same, 'etag')).toBe('"4.5.2"');
    for (const stale of ['"4.5.1"', '"3.5.2"', '"4.4.2"', '', 'W/"x"']) { const r = await f.get(o['order_id'], { 'if-none-match': stale }); expect(r.status, `If-None-Match ${stale}`).toBe(200); }
  });
  it('each ingredient of the ETag moves it: order version, a specimen seq, a new report (the app never keeps a stale 304)', async () => {
    const { f, o, s2 } = full(); const etag = async () => String(hdr(await f.get(o['order_id']), 'etag'));
    const e0 = await etag(); o['status_version'] = 5; const e1 = await etag(); expect(e1).toBe('"5.5.2"');
    s2['status_seq'] = 6; const e2 = await etag(); expect(e2).toBe('"5.6.2"'); f.report(o['order_id'], { version_no: 1 }); const e3 = await etag(); expect(e3).toBe('"5.6.3"');
    expect(new Set([e0, e1, e2, e3]).size).toBe(4);
    expect((await f.get(o['order_id'], { 'if-none-match': e0 })).status).toBe(200);
  });
  it('visible_from: an order before the link\'s visible_from is 404 on E21 as well (same shape as an unknown id)', async () => {
    const f = setup(); f.linkX['visible_from'] = iso(-10 * DAY); const hidden = f.order({ registered_at: iso(-11 * DAY) });
    const e = await rejection(f.get(hidden['order_id'])); const unknown = await rejection(f.get(ID(0xfff)));
    expect(e.code).toBe('common.not_found'); expect(e.statusCode).toBe(404); expect(shape(e)).toEqual(shape(unknown));
  });
  it('a suspended / revoked link makes its orders 404 on E21', async () => {
    const f = setup(); const o = f.order(); Object.assign(f.linkX, { status: 'suspended', suspend_reason: 'dormant', suspended_at: f.w.now() });
    expect((await rejection(f.get(o['order_id']))).code).toBe('common.not_found');
  });
  it('reports before the link\'s visible_from are not in the detail (released_at >= visible_from, TRD §4.4)', async () => {
    const f = setup(); f.linkX['visible_from'] = iso(-DAY); const o = f.order({ registered_at: iso(-DAY / 2) });
    const old = f.report(o['order_id'], { released_at: iso(-2 * DAY) }), cur = f.report(o['order_id'], { released_at: iso(-DAY / 4) });
    const res = await f.get(o['order_id']); expect(res.body.reports.map((r: any) => r.report_id)).toEqual([cur['report_id']]); expect(res.body.reports.map((r: any) => r.report_id)).not.toContain(old['report_id']);
  });
  it('is read-only: no writes, no access_log, no job; every read binds tenant_id', async () => {
    const { f, o } = full(); await f.get(o['order_id']); await f.get(o['order_id'], { 'if-none-match': '"4.5.2"' });
    expect(f.w.writes()).toEqual([]); expect(f.w.audit).toEqual([]); expect(f.w.jobs()).toEqual([]);
    for (const s of f.w.stmts.filter((x) => /patient_orders|patient_order_specimens|patient_reports|account_patient_links/.test(x.text))) expect(s.text, s.text).toMatch(/tenant_id/);
  });
});

describe('probes: account B vs account A\'s data (07-SECURITY P-L1, REQ-SEC-024)', () => {
  it('P-L1: A2 (not linked to X) gets 404 common.not_found on E21 for X\'s order, identical in shape to an unknown id (no existence oracle)', async () => {
    const f = setup(); const o = f.order({ patient_id: X }); f.specimen(o['order_id']); f.report(o['order_id']);
    const e = await rejection(f.get(o['order_id'], {}, f.a2)); const unknown = await rejection(f.get(ID(0xffe), {}, f.a2));
    expect(e.code).toBe('common.not_found'); expect(e.statusCode).toBe(404); expect(shape(e)).toEqual(shape(unknown));
    expect(JSON.stringify(shape(e))).not.toContain(String(o['order_id']).slice(0, 8) + 'x');
  });
  it('P-L1: sending A1\'s current ETag as A2 is 404, never 304 (a 304 would confirm the order exists and is unchanged)', async () => {
    const f = setup(); const o = f.order({ patient_id: X, status_version: 2 });
    const mine = await f.get(o['order_id']); const etag = String(hdr(mine, 'etag'));
    expect((await f.get(o['order_id'], { 'if-none-match': etag })).status).toBe(304);
    expect((await rejection(f.get(o['order_id'], { 'if-none-match': etag }, f.a2))).code).toBe('common.not_found');
  });
  it('P-L1: A2\'s list contains only Y\'s orders, A1\'s only X\'s; a profile_id of the other account matches nothing', async () => {
    const f = setup(); const ox = f.order({ patient_id: X }), oy = f.order({ patient_id: Y, registered_at: iso(-2 * DAY) });
    expect(ids(await f.list({}, f.a1))).toEqual([ox['order_id']]); expect(ids(await f.list({}, f.a2))).toEqual([oy['order_id']]);
    let got: string[] = []; try { got = ids(await f.list({ profile_id: f.linkX['id'] }, f.a2)); } catch (e: any) { expect(e.code).toBe('common.not_found'); } expect(got).toEqual([]);
  });
  it('an account with no links sees an empty list (200), not an error and not other accounts\' orders', async () => {
    const f = setup(); f.order(); const a3 = f.w.seedAccount('+99001000003');
    const res = await f.list({}, a3); expect(res.status).toBe(200); expect(res.body.data).toEqual([]);
  });
  it('another tenant\'s order with the same id is invisible (tenant bound in every read); the A1 tenant-B probe is 404', async () => {
    const f = setup(); const shared = ID(0xabc); f.order({ order_id: shared, tenant_id: TENANT_B, patient_id: X, registered_at: iso(-DAY) });
    expect((await rejection(f.get(shared))).code).toBe('common.not_found'); expect(ids(await f.list())).toEqual([]);
  });
  it('a patient_id the caller supplies is ignored: the DTO / query accept profile_id only (REQ-SEC-024)', async () => {
    const f = setup(); const oy = f.order({ patient_id: Y }); let got: string[] = []; try { got = ids(await f.list({ patient_id: Y })); } catch (e: any) { expect(['common.validation_failed', 'common.not_found']).toContain(e.code); }
    expect(got).not.toContain(oy['order_id']);
  });
  it('nothing patient-identifying is logged, counted or audited by the read path (no PHI in logs / labels)', async () => {
    const f = setup(); const o = f.order(); f.w.setDemographics(X, {}); await f.list(); await f.get(o['order_id']); await rejection(f.get(o['order_id'], {}, f.a2));
    expect(f.w.observed()).not.toMatch(/Synthetic Patient|\+9900100000|SERUM/);
  });
});
