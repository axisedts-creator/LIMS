// C13 T17 — partner-facing reads: P1 listPartnerPriceList, S1 listPartnerStatements, S2 getPartnerStatement (02-TRD §5.2; 03-APP-FLOW F8/F9; 04-UI-UX PP-1/PS-1/PS-2).
// ACs: US-11.1 (code/name/kind/unit price/list version), US-11.2 (Standard rate label data: source), US-11.4 (other parties' prices never visible), US-12.1, US-12.2 (outstanding = latest
//   closing balance, as-of = last sync), US-12.4 (empty month = empty state, not an error). Security: 07-SECURITY partner finance data, AB6/AB8/AB9, ST4, REQ-SEC-080 (parameterised SQL).
// The projection TABLES are filled by the worker tasks (projections.test.ts in services/worker); here they are seeded directly. The world runs with rls=false: no RLS helps the handler,
// it must scope by tenant_id AND partner_id itself (defence in depth, as T03).
// Interface expected from the writer (SEAM = not fixed by the spec):
//   ../handlers/{listPartnerPriceList,listPartnerStatements,getPartnerStatement}.ts, one named `Handler` export per operationId, wired in manifest.handlers (boot.test IMPLEMENTED list).
//   req = {params:{period_month}, query:{kind,source,q,sort,period_month_from,period_month_to,cursor,limit}, headers, body}; the core already validated shapes against contracts/openapi/partners.yaml.
//   order (as A1): ctx.actor.type === 'partner' else 403 auth.forbidden before any SQL -> IdentityPort.assertRole(ctx,{permission}) (P1 partners.price_list.read; S1/S2 partners.statement.read)
//        -> partnerContext.require(ctx) (partner from the token membership only; inactive partner/user -> 403 partners.partner_inactive).
//   SEAM SQL: reads only partners.price_list_items / price_list_syncs / statement_months with tenant_id = $n AND partner_id = $n (the fake's subset, see projection.world.ts); q is a prefix of
//        code OR name, case-insensitive, with %, _ and \ taken literally (ILIKE ... ESCAPE or starts_with(lower(..), lower($n))); ordering code|name then orderable_id; statements
//        period_month DESC, fiscal_year_bs DESC. Cursor = opaque ^[A-Za-z0-9_-]+$ string, bad/foreign cursor -> 400 common.invalid_cursor.
//   SEAM DTOs follow PriceListItem / StatementMonth in contracts/openapi/partners.yaml (additionalProperties false): null columns are OMITTED (department_name, effective_to); money as
//        {amount_paisa: number, currency:'NPR'} (bigint strings converted); period_month 'YYYY-MM'; effective_* 'YYYY-MM-DD'; synced_at ISO.
//   SEAM outstanding (S1): closing_balance of the latest (period_month, then fiscal_year_bs) row of the partner; outstanding_as_of = latest synced_at; both omitted without rows.
//   SEAM S1 access log: ctx.audit.access({action:'statement.view', entityType:'partner_statement', outcome:'allowed', ...}) once per call (TRD §9.x table; CR-C13-012); detail carries no amounts.
//   SEAM S2 with no row for the month: 200 {period_month, rows: [], synced_at = latest synced_at of the partner's statement rows} (the schema requires synced_at; with no rows at all the value is not asserted).
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../core/errors.js';
import { getPartnerStatement } from '../handlers/getPartnerStatement.js';
import { listPartnerPriceList } from '../handlers/listPartnerPriceList.js';
import { listPartnerStatements } from '../handlers/listPartnerStatements.js';
import { manifest } from '../index.js';
import { CP, NOW, NOW_ISO, O, P, PL, SYNCED, SYSTEM, T_A, T_B, id, makeWorld, seed, type Row, type World } from './projection.world.js';

const U = { adminX: id(50), memberX: id(51), deactX: id(52), adminY: id(53), adminZ: id(54), adminB: id(55) };
const M = { adminX: id(60), memberX: id(61), deactX: id(62), adminY: id(63), adminZ: id(64), adminB: id(65) };
const PRICE_READ = 'partners.price_list.read', STATEMENT_READ = 'partners.statement.read';
const iso = (v: unknown) => new Date(v as string).toISOString();
const UUID_LIKE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/;

function item(partner: string, tenant: string, o: { o: string; kind: string; code: string; name: string; dept?: string | null; price: string; source: string; pl: string; v: number; from?: string; to?: string | null }): Row {
  return { tenant_id: tenant, partner_id: partner, orderable_id: o.o, kind: o.kind, code: o.code, name: o.name, department_name: o.dept ?? null, unit_price_paisa: o.price, source: o.source, price_list_id: o.pl,
    price_list_version: o.v, effective_from: new Date(o.from ?? '2026-01-01T00:00:00Z'), effective_to: o.to ? new Date(o.to) : null, synced_at: SYNCED, created_at: NOW, created_by: SYSTEM };
}
const stm = (partner: string, tenant: string, cp: string, m: string, fy: string, inv: string, paid: string, cr: string, close: string): Row =>
  ({ tenant_id: tenant, partner_id: partner, credit_party_id: cp, period_month: m, fiscal_year_bs: fy, invoiced_paisa: inv, paid_paisa: paid, credited_paisa: cr, closing_balance_paisa: close, synced_at: SYNCED, is_stale: false, created_at: NOW, created_by: SYSTEM, updated_at: NOW, updated_by: SYSTEM });

function world(): World {
  const w = makeWorld(); seed(w);
  const T = w.t;
  const mkUser = (k: keyof typeof U, tenant: string, partner: string, role: string, status: string): Row => ({ id: U[k], tenant_id: tenant, partner_id: partner, membership_id: M[k], partner_role: role, status, display_name: `Synthetic ${k}` });
  T['partners.partner_users']!.push(mkUser('adminX', T_A, P.x, 'partner_admin', 'active'), mkUser('memberX', T_A, P.x, 'partner_member', 'active'), mkUser('deactX', T_A, P.x, 'partner_member', 'deactivated'),
    mkUser('adminY', T_A, P.y, 'partner_admin', 'active'), mkUser('adminZ', T_A, P.z, 'partner_admin', 'active'), mkUser('adminB', T_B, P.b, 'partner_admin', 'active'));
  T['partners.price_list_items']!.push(
    item(P.x, T_A, { o: O.t1, kind: 'test', code: 'SYN-T1', name: 'Synthetic Hemogram', dept: 'Synthetic Haematology', price: '150000', source: 'partner', pl: PL.cp1, v: 3 }),
    item(P.x, T_A, { o: O.t2, kind: 'test', code: 'SYN-T2', name: 'Synthetic Glucose', dept: 'Synthetic Biochemistry', price: '60000', source: 'partner', pl: PL.cp1, v: 3, to: '2027-01-01T00:00:00Z' }),
    item(P.x, T_A, { o: O.t4, kind: 'test', code: 'SYN-T4', name: 'Synthetic Urea', dept: 'Synthetic Biochemistry', price: '50000', source: 'standard', pl: PL.dflt, v: 7 }),
    item(P.x, T_A, { o: O.p1, kind: 'panel', code: 'SYN-P1', name: 'Synthetic Lipid Package', price: '90000', source: 'partner', pl: PL.cp1, v: 3 }),
    item(P.x, T_A, { o: O.p2, kind: 'panel', code: 'SYN-P2', name: 'Synthetic Renal Package', price: '110000', source: 'standard', pl: PL.dflt, v: 7 }),
    item(P.y, T_A, { o: O.t1, kind: 'test', code: 'SYN-T1', name: 'Synthetic Hemogram', dept: 'Synthetic Haematology', price: '111000', source: 'partner', pl: PL.cp2, v: 5 }),
    item(P.y, T_A, { o: O.t3, kind: 'test', code: 'SYN-T3', name: 'Synthetic Sodium', dept: 'Synthetic Biochemistry', price: '222000', source: 'partner', pl: PL.cp2, v: 5 }),
    item(P.b, T_B, { o: O.t1, kind: 'test', code: 'B-T1', name: 'Foreign Tenant Hemogram', price: '777777', source: 'partner', pl: PL.b, v: 4 }),
  );
  const sync = (partner: string, tenant: string, v: number | null, n: number): Row => ({ tenant_id: tenant, partner_id: partner, synced_at: SYNCED, price_list_version: v, row_count: n, last_error_code: null, created_at: NOW, created_by: SYSTEM, updated_at: NOW, updated_by: SYSTEM });
  T['partners.price_list_syncs']!.push(sync(P.x, T_A, 3, 5), sync(P.y, T_A, 5, 2), sync(P.b, T_B, 4, 1));
  T['partners.statement_months']!.push(
    stm(P.x, T_A, CP.one, '2026-07-01', '2082/83', '100000', '50000', '0', '350000'), stm(P.x, T_A, CP.one, '2026-07-01', '2083/84', '40000', '0', '10000', '380000'),
    stm(P.x, T_A, CP.one, '2026-08-01', '2083/84', '250000', '100000', '0', '530000'), stm(P.x, T_A, CP.one, '2026-09-01', '2083/84', '125000', '25000', '5000', '625000'),
    stm(P.x, T_A, CP.one, '2026-10-01', '2083/84', '900000', '200000', '0', '1325000'),
    stm(P.y, T_A, CP.two, '2026-10-01', '2083/84', '424242', '0', '0', '424242'), stm(P.b, T_B, CP.b, '2026-10-01', '2083/84', '5550000', '0', '0', '5550000'));
  return w;
}

function ctxFor(w: World, who: keyof typeof U, over: Row = {}) {
  const u = w.t['partners.partner_users']!.find((x) => x.id === U[who])!;
  const calls: string[] = []; const logs: string[] = [];
  const ctx: any = {
    tenantId: u.tenant_id, actor: { type: (over['actorType'] as string) ?? 'partner', id: u.id, membershipId: u.membership_id }, requestId: id(99), tx: w.tx, now: () => NOW_ISO,
    db: {}, core: {}, events: {}, uploads: {}, files: {}, storage: {}, services: {},
    audit: { access: async (e: unknown) => { w.audit.push(e); } },
    log: { info: (o: object) => logs.push(JSON.stringify(o)), warn: (o: object) => logs.push(JSON.stringify(o)), error: (o: object) => logs.push(JSON.stringify(o)) },
    ports: { IdentityPort: { async assertRole(_c: unknown, r: { permission: string }) { calls.push(`assertRole:${r.permission}`); if (over['assertRoleError']) throw over['assertRoleError']; } } },
  };
  return { ctx, calls, logs };
}
const req = (query: Row = {}, params: Row = {}) => ({ params, query, headers: {}, body: undefined });
const price = (ctx: any, query: Row = {}) => listPartnerPriceList(req(query) as any, ctx) as Promise<{ status: number; body: any }>;
const list = (ctx: any, query: Row = {}) => listPartnerStatements(req(query) as any, ctx) as Promise<{ status: number; body: any }>;
const one = (ctx: any, period: string) => getPartnerStatement(req({}, { period_month: period }) as any, ctx) as Promise<{ status: number; body: any }>;
const fails = async (p: Promise<unknown>, code: string | string[], status?: number) => {
  const e: any = await p.then(() => { throw new Error('expected rejection'); }, (x) => x);
  expect(e).toBeInstanceOf(LimsError);
  expect(Array.isArray(code) ? code : [code]).toContain(e.code);
  if (status) expect(e.statusCode).toBe(status);
  return e as LimsError;
};
const money = (n: number) => ({ amount_paisa: n, currency: 'NPR' });
const touchedData = (w: World) => w.sqlOf(/partners\.(price_list_items|price_list_syncs|statement_months)/i);
const codes = (body: any) => body.data.map((d: any) => d.code);

describe('T17 P1 listPartnerPriceList — US-11.1 / 11.2 / 11.4', () => {
  it('200: the partner\'s own rows with the exact PriceListItem DTO, code order, list version and synced_at; "Standard rate" rows carry source standard', async () => {
    const w = world(); const { ctx, calls } = ctxFor(w, 'adminX');
    const r = await price(ctx);
    expect(r.status).toBe(200);
    expect(calls).toContain(`assertRole:${PRICE_READ}`);
    expect(r.body.data).toEqual([
      { orderable_id: O.p1, kind: 'panel', code: 'SYN-P1', name: 'Synthetic Lipid Package', unit_price: money(90000), source: 'partner', price_list_version: 3, effective_from: '2026-01-01' },
      { orderable_id: O.p2, kind: 'panel', code: 'SYN-P2', name: 'Synthetic Renal Package', unit_price: money(110000), source: 'standard', price_list_version: 7, effective_from: '2026-01-01' },
      { orderable_id: O.t1, kind: 'test', code: 'SYN-T1', name: 'Synthetic Hemogram', department_name: 'Synthetic Haematology', unit_price: money(150000), source: 'partner', price_list_version: 3, effective_from: '2026-01-01' },
      { orderable_id: O.t2, kind: 'test', code: 'SYN-T2', name: 'Synthetic Glucose', department_name: 'Synthetic Biochemistry', unit_price: money(60000), source: 'partner', price_list_version: 3, effective_from: '2026-01-01', effective_to: '2027-01-01' },
      { orderable_id: O.t4, kind: 'test', code: 'SYN-T4', name: 'Synthetic Urea', department_name: 'Synthetic Biochemistry', unit_price: money(50000), source: 'standard', price_list_version: 7, effective_from: '2026-01-01' },
    ]);
    expect(r.body.price_list_version).toBe(3);
    expect(new Date(r.body.synced_at).getTime()).toBe(SYNCED.getTime());
    expect(r.body.page).toEqual({ limit: 50 });
    expect(Object.keys(r.body).sort()).toEqual(['data', 'page', 'price_list_version', 'synced_at']);
  });

  it('a partner_member reads it too; no tenant id, partner id, price_list_id, credit party id or created_by is ever in the body', async () => {
    const w = world(); const { ctx } = ctxFor(w, 'memberX');
    const r = await price(ctx);
    expect(r.status).toBe(200);
    const text = JSON.stringify(r.body);
    for (const leak of [T_A, T_B, P.x, P.y, CP.one, CP.two, PL.cp1, PL.dflt, SYSTEM, 'price_list_id', 'partner_id', 'tenant_id', 'created_by', 'unit_price_paisa']) expect(text).not.toContain(leak);
    expect(text.match(UUID_LIKE)?.every((u) => [O.p1, O.p2, O.t1, O.t2, O.t4].includes(u))).toBe(true); // the only ids are orderable ids
  });

  it('US-11.4: partner Y\'s prices and tenant B\'s prices are invisible to X; each partner sees only its own rows (no RLS emulated: the handler scopes)', async () => {
    const w = world();
    const x = JSON.stringify((await price(ctxFor(w, 'adminX').ctx)).body);
    for (const leak of ['111000', '222000', '777777', 'Foreign']) expect(x).not.toContain(leak);
    const y = await price(ctxFor(w, 'adminY').ctx);
    expect(codes(y.body)).toEqual(['SYN-T1', 'SYN-T3']);
    expect(y.body.data.map((d: any) => d.unit_price.amount_paisa)).toEqual([111000, 222000]);
    expect(y.body.price_list_version).toBe(5);
    const b = await price(ctxFor(w, 'adminB').ctx);
    expect(codes(b.body)).toEqual(['B-T1']);
    const q = touchedData(w).filter((c) => /price_list_items/i.test(c.text));
    expect(q.length).toBeGreaterThanOrEqual(3);
    for (const c of q) expect(c.values.some((v) => [P.x, P.y, P.b].includes(v as string))).toBe(true); // partner id is a bound parameter of every read
  });

  it('filters: kind, source, q prefix on code or name (case-insensitive) and sort=name', async () => {
    const w = world(); const { ctx } = ctxFor(w, 'adminX');
    expect(codes((await price(ctx, { kind: 'panel' })).body)).toEqual(['SYN-P1', 'SYN-P2']);
    expect(codes((await price(ctx, { source: 'standard' })).body)).toEqual(['SYN-P2', 'SYN-T4']);
    expect(codes((await price(ctx, { kind: 'test', source: 'partner' })).body)).toEqual(['SYN-T1', 'SYN-T2']);
    expect(codes((await price(ctx, { q: 'syn-p' })).body)).toEqual(['SYN-P1', 'SYN-P2']);
    expect(codes((await price(ctx, { q: 'SYNTHETIC G' })).body)).toEqual(['SYN-T2']);
    expect(codes((await price(ctx, { sort: 'name' })).body)).toEqual(['SYN-T2', 'SYN-T1', 'SYN-P1', 'SYN-P2', 'SYN-T4']);
    expect(codes((await price(ctx, { sort: 'code' })).body)).toEqual(['SYN-P1', 'SYN-P2', 'SYN-T1', 'SYN-T2', 'SYN-T4']);
  });

  it('q is data, never SQL or a pattern: %, _, \\ and a quote-injection string match nothing and never appear in SQL text', async () => {
    const w = world(); const { ctx } = ctxFor(w, 'adminX');
    for (const q of ['%', '_', '\\', "x' OR '1'='1", "'; DROP TABLE partners.price_list_items; --", 'SYN-T_']) {
      const r = await price(ctx, { q });
      expect(r.status).toBe(200);
      expect(r.body.data).toEqual([]);
    }
    for (const c of w.log) { expect(c.text).not.toContain('DROP TABLE'); expect(c.text).not.toContain("'1'='1"); expect(c.text).not.toContain('SYN-T_'); }
  });

  it('cursor paging: limit 2 -> [P1,P2], [T1,T2], [T4]; no gaps, no duplicates; page.limit echoes; the last page has no next_cursor', async () => {
    const w = world(); const { ctx } = ctxFor(w, 'adminX');
    const seen: string[] = []; let cursor: string | undefined; let pages = 0;
    do {
      const r = await price(ctx, { limit: 2, ...(cursor ? { cursor } : {}) });
      expect(r.body.page.limit).toBe(2);
      seen.push(...codes(r.body)); pages++;
      cursor = r.body.page.next_cursor;
      if (cursor) expect(cursor).toMatch(/^[A-Za-z0-9_-]{1,512}$/);
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual(['SYN-P1', 'SYN-P2', 'SYN-T1', 'SYN-T2', 'SYN-T4']);
  });

  it('a garbage cursor -> 400 common.invalid_cursor; a statement cursor is not accepted by the price list', async () => {
    const w = world(); const { ctx } = ctxFor(w, 'adminX');
    await fails(price(ctx, { cursor: 'AAAA' }), 'common.invalid_cursor', 400);
    const s = await list(ctxFor(w, 'adminX').ctx, { limit: 1 });
    expect(s.body.page.next_cursor).toBeTruthy();
    await fails(price(ctx, { cursor: s.body.page.next_cursor }), 'common.invalid_cursor', 400);
  });

  it('never synced / empty: 200 with an empty list and without price_list_version / synced_at', async () => {
    const w = world(); const { ctx } = ctxFor(w, 'adminX');
    w.t['partners.price_list_items'] = []; w.t['partners.price_list_syncs'] = [];
    const r = await price(ctx);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ data: [], page: { limit: 50 } });
  });
});

describe('T17 S1 listPartnerStatements — US-12.1 / 12.2', () => {
  it('200: one row per (month, fiscal year), newest first, exact StatementMonth DTO; outstanding = latest closing balance, as-of = last sync; access log statement.view', async () => {
    const w = world(); const { ctx, calls } = ctxFor(w, 'adminX');
    const r = await list(ctx);
    expect(r.status).toBe(200);
    expect(calls).toContain(`assertRole:${STATEMENT_READ}`);
    const row = (m: string, fy: string, inv: number, paid: number, cr: number, close: number) =>
      ({ period_month: m, fiscal_year_bs: fy, invoiced: money(inv), paid: money(paid), credited: money(cr), closing_balance: money(close), synced_at: SYNCED.toISOString() });
    expect(r.body.data).toEqual([
      row('2026-10', '2083/84', 900000, 200000, 0, 1325000), row('2026-09', '2083/84', 125000, 25000, 5000, 625000), row('2026-08', '2083/84', 250000, 100000, 0, 530000),
      row('2026-07', '2083/84', 40000, 0, 10000, 380000), row('2026-07', '2082/83', 100000, 50000, 0, 350000),
    ]);
    expect(r.body.outstanding).toEqual(money(1325000));
    expect(new Date(r.body.outstanding_as_of).getTime()).toBe(SYNCED.getTime());
    expect(r.body.page).toEqual({ limit: 50 });
    expect(w.audit).toHaveLength(1);
    expect(w.audit[0]).toMatchObject({ action: 'statement.view', entityType: 'partner_statement', outcome: 'allowed' });
    expect(JSON.stringify(w.audit[0])).not.toMatch(/1325000|424242/); // no amounts in the access log
  });

  it('outstanding when the latest month spans two fiscal years: the later fiscal year\'s closing balance (380000), not the earlier (350000)', async () => {
    const w = world(); const { ctx } = ctxFor(w, 'adminX');
    w.t['partners.statement_months'] = w.t['partners.statement_months']!.filter((x) => !(x.partner_id === P.x && ['2026-08-01', '2026-09-01', '2026-10-01'].includes(x.period_month)));
    const r = await list(ctx);
    expect(r.body.outstanding).toEqual(money(380000));
  });

  it('US-12.2 / 12.1: only this partner\'s rows — Y\'s 424242 and tenant B\'s 5550000 never appear (no RLS emulated); no partner/credit party/tenant ids or is_stale in the body', async () => {
    const w = world();
    const x = await list(ctxFor(w, 'adminX').ctx);
    const text = JSON.stringify(x.body);
    for (const leak of ['424242', '5550000', T_A, T_B, P.x, P.y, CP.one, CP.two, 'partner_id', 'credit_party_id', 'is_stale', 'created_by', 'closing_balance_paisa']) expect(text).not.toContain(leak);
    const y = await list(ctxFor(w, 'adminY').ctx);
    expect(y.body.data).toHaveLength(1);
    expect(y.body.outstanding).toEqual(money(424242));
    const b = await list(ctxFor(w, 'adminB').ctx);
    expect(b.body.outstanding).toEqual(money(5550000));
    for (const c of touchedData(w)) expect(c.values.some((v) => [P.x, P.y, P.b].includes(v as string))).toBe(true);
  });

  it('period_month_from / _to filter inclusively on the A.D. month', async () => {
    const w = world(); const { ctx } = ctxFor(w, 'adminX');
    const months = (b: any) => b.data.map((d: any) => `${d.period_month}|${d.fiscal_year_bs}`);
    expect(months((await list(ctx, { period_month_from: '2026-08', period_month_to: '2026-09' })).body)).toEqual(['2026-09|2083/84', '2026-08|2083/84']);
    expect(months((await list(ctx, { period_month_from: '2026-09' })).body)).toEqual(['2026-10|2083/84', '2026-09|2083/84']);
    expect(months((await list(ctx, { period_month_to: '2026-07' })).body)).toEqual(['2026-07|2083/84', '2026-07|2082/83']);
  });

  it('cursor paging over (period_month, fiscal_year_bs): limit 2 gives 3 pages, 5 rows, no duplicate, July\'s two fiscal years split across a page boundary intact', async () => {
    const w = world(); const { ctx } = ctxFor(w, 'adminX');
    const seen: string[] = []; let cursor: string | undefined; let pages = 0;
    do {
      const r = await list(ctx, { limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...r.body.data.map((d: any) => `${d.period_month}|${d.fiscal_year_bs}`)); pages++;
      cursor = r.body.page.next_cursor;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual(['2026-10|2083/84', '2026-09|2083/84', '2026-08|2083/84', '2026-07|2083/84', '2026-07|2082/83']);
    await fails(list(ctx, { cursor: 'AAAA' }), 'common.invalid_cursor', 400);
  });

  it('no statement rows: 200 with an empty list and no outstanding fields (empty state)', async () => {
    const w = world(); const { ctx } = ctxFor(w, 'adminX');
    w.t['partners.statement_months'] = [];
    const r = await list(ctx);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ data: [], page: { limit: 50 } });
  });

  it('bigint money converts to JSON numbers (node-pg returns strings); a negative closing balance is shown as is', async () => {
    const w = world(); const { ctx } = ctxFor(w, 'adminX');
    w.t['partners.statement_months']!.find((x) => x.partner_id === P.x && x.period_month === '2026-10-01')!.closing_balance_paisa = '-250000';
    const r = await list(ctx);
    expect(r.body.data[0].closing_balance).toEqual(money(-250000));
    expect(typeof r.body.data[0].invoiced.amount_paisa).toBe('number');
    expect(r.body.outstanding).toEqual(money(-250000));
  });
});

describe('T17 S2 getPartnerStatement — US-12.1 / 12.4', () => {
  it('a month with two fiscal years returns both rows and synced_at; a one-row month returns one', async () => {
    const w = world(); const { ctx } = ctxFor(w, 'adminX');
    const july = await one(ctx, '2026-07');
    expect(july.status).toBe(200);
    expect(july.body.period_month).toBe('2026-07');
    expect([...july.body.rows].sort((a: any, b: any) => a.fiscal_year_bs.localeCompare(b.fiscal_year_bs))).toEqual([
      { period_month: '2026-07', fiscal_year_bs: '2082/83', invoiced: money(100000), paid: money(50000), credited: money(0), closing_balance: money(350000), synced_at: SYNCED.toISOString() },
      { period_month: '2026-07', fiscal_year_bs: '2083/84', invoiced: money(40000), paid: money(0), credited: money(10000), closing_balance: money(380000), synced_at: SYNCED.toISOString() },
    ]);
    expect(new Date(july.body.synced_at).getTime()).toBe(SYNCED.getTime());
    expect(Object.keys(july.body).sort()).toEqual(['period_month', 'rows', 'synced_at']);
    expect((await one(ctx, '2026-10')).body.rows).toHaveLength(1);
  });

  it('US-12.4: a period without billing rows (/statements/2026-05) is a 200 empty state, not an error', async () => {
    const w = world(); const { ctx } = ctxFor(w, 'adminX');
    const r = await one(ctx, '2026-05');
    expect(r.status).toBe(200);
    expect(r.body.period_month).toBe('2026-05');
    expect(r.body.rows).toEqual([]);
    expect(new Date(r.body.synced_at).getTime()).toBe(SYNCED.getTime());
    w.t['partners.statement_months'] = [];
    const none = await one(ctxFor(w, 'adminX').ctx, '2026-10');
    expect(none.status).toBe(200);
    expect(none.body.rows).toEqual([]);
  });

  it('scoped to the caller: Y asking for 2026-10 gets 424242, never X\'s 1325000; tenant B gets 5550000 only', async () => {
    const w = world();
    const y = await one(ctxFor(w, 'adminY').ctx, '2026-10');
    expect(y.body.rows.map((x: any) => x.closing_balance.amount_paisa)).toEqual([424242]);
    const b = await one(ctxFor(w, 'adminB').ctx, '2026-10');
    expect(b.body.rows.map((x: any) => x.closing_balance.amount_paisa)).toEqual([5550000]);
    expect(JSON.stringify(y.body)).not.toMatch(/1325000|5550000|partner_id|credit_party_id|is_stale/);
  });

  it('a malformed month never reaches SQL: validation_failed or not_found, no statement query', async () => {
    for (const bad of ['2026-13', '2026-00', '26-10', "2026-10'; DROP TABLE partners.statement_months; --", '2026-10-01', '']) {
      const w = world(); const { ctx } = ctxFor(w, 'adminX');
      await fails(one(ctx, bad), ['common.validation_failed', 'common.not_found']);
      expect(w.sqlOf(/statement_months/i)).toEqual([]);
    }
  });

  it('the month value is a bound parameter', async () => {
    const w = world(); const { ctx } = ctxFor(w, 'adminX');
    await one(ctx, '2026-07');
    for (const c of touchedData(w)) { expect(c.text).not.toContain('2026-07'); expect(c.text).not.toContain(P.x); }
  });
});

describe('T17 P1 / S1 / S2 — authorization and partner state (AB6, AB8, AB9, ST4)', () => {
  const OPS: Array<[string, (c: any) => Promise<unknown>, string]> = [
    ['P1', (c) => price(c), PRICE_READ], ['S1', (c) => list(c), STATEMENT_READ], ['S2', (c) => one(c, '2026-10'), STATEMENT_READ],
  ];
  for (const [name, call, permission] of OPS) {
    it(`${name}: staff, system, device and portal tokens -> 403 auth.forbidden before any SQL`, async () => {
      for (const actorType of ['user', 'system', 'device', 'portal']) {
        const w = world(); const { ctx } = ctxFor(w, 'adminX', { actorType });
        await fails(call(ctx), 'auth.forbidden', 403);
        expect(w.log).toEqual([]);
        expect(w.audit).toEqual([]);
      }
    });

    it(`${name}: asks IdentityPort for ${permission}; a refusal (auth.forbidden) propagates and no projection table is read, no access log written`, async () => {
      const w = world(); const { ctx, calls } = ctxFor(w, 'adminX', { assertRoleError: new LimsError('auth.forbidden') });
      await fails(call(ctx), 'auth.forbidden', 403);
      expect(calls).toEqual([`assertRole:${permission}`]);
      expect(touchedData(w)).toEqual([]);
      expect(w.audit).toEqual([]);
    });

    it(`${name}: suspended partner or deactivated user -> 403 partners.partner_inactive, projection tables not read`, async () => {
      for (const who of ['adminZ', 'deactX'] as const) {
        const w = world(); const { ctx } = ctxFor(w, who);
        await fails(call(ctx), 'partners.partner_inactive', 403);
        expect(touchedData(w)).toEqual([]);
        expect(w.audit).toEqual([]);
      }
    });

    it(`${name}: the partner comes from the token membership only (a partner_id / tenant_id in the request is ignored)`, async () => {
      const w = world(); const { ctx } = ctxFor(w, 'adminY');
      const r: any = await (name === 'S2' ? getPartnerStatement(req({ partner_id: P.x, tenant_id: T_B }, { period_month: '2026-10', partner_id: P.x }) as any, ctx)
        : name === 'S1' ? listPartnerStatements(req({ partner_id: P.x, tenant_id: T_B }) as any, ctx) : listPartnerPriceList(req({ partner_id: P.x, tenant_id: T_B }) as any, ctx));
      expect(JSON.stringify(r.body)).not.toMatch(/1325000|150000|777777|5550000/);
    });
  }

  it('manifest wires the three operations to the handlers (not the 501 stub)', () => {
    expect(manifest.handlers['listPartnerPriceList']).toBe(listPartnerPriceList);
    expect(manifest.handlers['listPartnerStatements']).toBe(listPartnerStatements);
    expect(manifest.handlers['getPartnerStatement']).toBe(getPartnerStatement);
  });
});
