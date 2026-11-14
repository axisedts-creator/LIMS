// AN-T14 test helpers (not a test file). Synthetic data only. Used by dashboard / freshness / refresh handler tests and t14.security.test.ts.
// Builds on ./t09.helpers.ts (personas, volume / collections / income emulators) and ./helpers.t11.ts (results emulator). Handler + service + mapper are real.
//
// SEAMS pinned here (the spec leaves them open; the writer may dispute through the reviewer):
//  * Rollup reads go through the EXISTING rollups.repo functions: incomeRows, volumeRows, collectionRows, resultsRows, departmentIncomeRows
//    (the dashboard may ask for groupBy 'day' or 'ad_month' / grain 'total' or 'day'; every grouping is emulated). Labels: labels.repo.listDepartments.
//  * Everything that has no repo function yet goes through ctx.tx.query and is emulated by SQL TEXT (TRD shapes), never by function name:
//      analytics.refresh_state   SELECT family,last_success_at,last_error_code (loadFamilyStates) | INSERT ... '_manual' ... ON CONFLICT ... WHERE ... RETURNING last_manual_at (TRD §9.7)
//                                | SELECT ... last_manual_at ... (Retry-After read, same tx). Params: $1 tenant, $2 minutes, $3 actor.
//      analytics.dirty_partitions SELECT min(first_marked_at) GROUP BY family | INSERT (refresh.repo.markDirty: [tenant, family, date, reason, actor])
//      analytics.report_backlog   SELECT ... FROM analytics.report_backlog WHERE tenant_id = $1 AND <scope>. Columns returned: centre_id, stage ('awaiting_results'|
//                                'ready_unreleased'), age_bucket, orders, oldest_registered_at. Scope = the boolean ($all) / uuid[] ($centres) bound parameters, TRD §6 predicate.
//                                If the statement binds no scope parameter, ALL tenant rows come back and the handler itself must filter.
//      lab.v_pub_pending_items    TRD §6.7 summary shape: columns item_status, priority, department_id, age_bucket, n, overdue, no_target (grouped). Centre scope = C5 RLS
//                                (emulated from the actor's scope, D-49: NO implicit predicate); an explicit `centre_id = ANY($n)` in the SQL narrows further.
//      app.enqueue_job            ($1 identifier, $2 json payload, $3 job key)
//  * Clock: ctx.now() and the fake database `now()` are the same clock (w14.clock.now); tests advance it with advance().
import { vi } from 'vitest';
import { expectLims, rejection } from './helpers.js';
import {
  A1, A2, B1, BR1, BRB, D0, D1, D2, D3, TA, TB, db, cl, cv, ord, w, makeCtx09, rollupsMock09, labelsRepoMock09, seed09,
  FINANCE, LAB_MANAGER, OWNER_A109, OWNER_ALL09, COLL_NO_CASH, ADMIN, NO_PERM, PARTNER, contractErrors,
} from './t09.helpers.js';
import { R as RT, rollupsMockT11, t11 } from './helpers.t11.js';
import { DEPT } from './helpers.js';
import { FAMILIES } from '../../domain/families.js';

export { A1, A2, B1, BR1, BRB, D0, D1, D2, D3, TA, TB, db, FINANCE, LAB_MANAGER, OWNER_A109, OWNER_ALL09, COLL_NO_CASH, ADMIN, NO_PERM, PARTNER, DEPT, FAMILIES, contractErrors, expectLims, rejection, w, t11 };

export const DM1 = '2026-11-03', DM2 = '2026-11-02'; // two days before D0
export const SENTINEL = 987_654_321;                  // tenant B / out-of-window values: must never appear in any response
export const NOW = '2026-11-06T06:00:00.000Z';        // = 2026-11-06 11:45 Asia/Kathmandu → "Today" = D2, previous = D1
export const NOW_EARLY = '2026-11-05T23:00:00.000Z';  // = 2026-11-06 04:45 Asia/Kathmandu (before 06:00) → today D2, yesterday D1 is still marked
export const SNAPSHOT = '1970-01-01';

// ------------------------------------------------------------------ world
export interface BacklogFact { tenantId: string; centreId: string | null; stage: 'awaiting_results' | 'ready_unreleased'; bucket: string; orders: number; oldest: string }
export interface PendingFact { tenantId: string; centreId: string | null; status: string; priority: string; departmentId: string | null; bucket: string; n: number; overdue: number; noTarget: number }
export interface StateRow { tenant: string; family: string; last_success_at?: string; last_error_code?: string; last_manual_at?: string; created_by?: string }
export interface MarkRow { tenant: string; family: string; date: string; first: string; last: string; reason: string; actor: string }
export const w14 = {
  clock: { now: NOW },
  state: new Map<string, StateRow>(),
  marks: new Map<string, MarkRow>(),
  jobs: [] as { identifier: string; payload: any; jobKey: unknown; text: string }[],
  backlog: [] as BacklogFact[],
  pending: [] as PendingFact[],
  log: [] as { text: string; values: unknown[] }[],
  failOn: undefined as undefined | ((text: string) => unknown),
};
const sk = (t: string, f: string) => `${t}|${f}`;
const mk = (t: string, f: string, d: string) => `${t}|${f}|${d}`;
export const stateOf = (tenant: string, family: string) => w14.state.get(sk(tenant, family));
export const marksOf = (tenant = TA) => [...w14.marks.values()].filter((m) => m.tenant === tenant);
export const advance = (ms: number) => { w14.clock.now = new Date(Date.parse(w14.clock.now) + ms).toISOString(); };

/**
 * The standard world. "Today" (ctx.now) = D2, previous period = D1. Hand-computed expectations live in the tests.
 *   income (net = taxable, vat 0)  D1 A1 inv 16000 | D1 A2 4000 | D2 A1 inv 10000 credit 2000 | D2 A2 6000 | D2 NULL-centre inv 2000 | D0 A1 4000 | DM1 A1 1000 | DM2 A1 999999 | tenant B D2
 *   orders  [reg, canc, patient_visits, new]  D1 A1 [10,2,8,4] A2 [5,0,5,0] | D2 A1 [12,2,9,2] A2 [4,1,4,0]  | centre volume items D1 A1 32 A2 8 | D2 A1 40 A2 10
 *   results approved  D1 A1 4 A2 6 | D2 A1 8 A2 2 NULL-centre 5
 *   collections net   D1 A1 2500 A2 1500 | D2 A1 5000 A2 1000 NULL-centre 500
 *   department net D2 (sums to the D2 net sales 16000)  H 8000 (A1 5000 + A2 3000) | B 4000 (A1 2000 + NULL-centre 2000) | OLD (inactive) 3000 (A2) | NULL "Multiple departments" 1000 (A1)
 *   department net D1: H 20000 (A1 16000 + A2 4000)
 *   backlog   A1 awaiting 3, ready 2 | A2 awaiting 4, ready 1          → all 10 / 3 ; A1-only 5 / 2
 *   pending   A1 [in_process 4 overdue 1] [awaiting_receipt 3 overdue 2] | A2 [in_process 5 overdue 0]  → all 12 / 3 ; A1-only 7 / 3
 * Every kind of out-of-window / other-tenant row carries SENTINEL-sized numbers.
 */
export function seedT14(): void {
  seed09();                                   // clears db + w.* of AN-T08/T09 and fills them; replaced below
  db.income = []; db.dept = []; db.departments = [];
  w.orders = []; w.cvol = []; w.coll = []; w.refs = [];
  const inc = (date: string, centre: string | null, taxable: number, credit = 0, tenantId = TA, branchId = BR1) => ({
    tenantId, date, branchId, centreId: centre, issued: 1, cancelled: 0, gross: taxable, discount: 0, exempt: 0, taxable, vat: 0, other: 0, net: taxable, credit,
  });
  db.income.push(
    inc(D1, A1, 16000), inc(D1, A2, 4000), inc(D2, A1, 10000, 2000), inc(D2, A2, 6000), inc(D2, null, 2000),
    inc(D0, A1, 4000), inc(DM1, A1, 1000), inc(DM2, A1, 999_999), inc(D3, A1, SENTINEL),
    inc(D2, B1, SENTINEL, SENTINEL, TB, BRB),
  );
  const dep = (date: string, centre: string | null, departmentId: string | null, net: number, tenantId = TA) =>
    ({ tenantId, date, branchId: BR1, centreId: centre, departmentId, lines: 1, gross: net, discount: 0, net });
  db.dept.push(
    dep(D2, A1, DEPT.H, 5000), dep(D2, A1, DEPT.B, 2000), dep(D2, A1, null, 1000), dep(D2, A2, DEPT.H, 3000), dep(D2, A2, DEPT.OLD, 3000), dep(D2, null, DEPT.B, 2000),
    dep(D1, A1, DEPT.H, 16000), dep(D1, A2, DEPT.H, 4000), dep(D3, A1, DEPT.H, SENTINEL), dep(D2, B1, DEPT.FOREIGN, SENTINEL, TB),
  );
  db.departments.push(
    { tenantId: TA, department_id: DEPT.H, name: 'Haematology', is_active: true },
    { tenantId: TA, department_id: DEPT.B, name: 'Biochemistry', is_active: true },
    { tenantId: TA, department_id: DEPT.OLD, name: 'Legacy Serology', is_active: false },
    { tenantId: TB, department_id: DEPT.FOREIGN, name: 'Tenant B Radiology', is_active: true },
  );
  w.orders.push(
    ord(D1, A1, { reg: 10, canc: 2, pat: 8, newp: 4 }), ord(D1, A2, { reg: 5, pat: 5, newp: 0 }),
    ord(D2, A1, { reg: 12, canc: 2, pat: 9, newp: 2 }), ord(D2, A2, { reg: 4, canc: 1, pat: 4, newp: 0 }),
    ord(D3, A1, { reg: SENTINEL, pat: SENTINEL }), { ...ord(D2, B1, { reg: SENTINEL, pat: SENTINEL }), tenantId: TB, branchId: BRB },
  );
  w.cvol.push(
    cv(D1, A1, 'walk_in', { orders: 8, pat: 8, items: 32 }), cv(D1, A2, 'centre', { orders: 5, pat: 5, items: 8 }),
    cv(D2, A1, 'walk_in', { orders: 10, pat: 9, items: 40 }), cv(D2, A2, 'centre', { orders: 3, pat: 4, items: 10 }),
    cv(D3, A1, 'walk_in', { orders: SENTINEL, pat: SENTINEL, items: SENTINEL }), cv(D2, B1, 'walk_in', { tenantId: TB, orders: SENTINEL, pat: SENTINEL, items: SENTINEL }),
  );
  w.coll.push(
    cl(D1, A1, null, 'cash', { entries: 5, gross: 2500 }), cl(D1, A2, null, 'cash', { entries: 3, gross: 1500 }),
    cl(D2, A1, null, 'cash', { entries: 9, gross: 5000 }), cl(D2, A2, null, 'cash', { entries: 2, gross: 1000 }), cl(D2, null, null, 'cash', { entries: 1, gross: 500 }),
    cl(D3, A1, null, 'cash', { entries: 1, gross: SENTINEL }), cl(D2, B1, null, 'cash', { entries: 1, gross: SENTINEL, tenantId: TB }),
  );
  t11.results.length = 0;
  t11.results.push(
    RT(D1, A1, BR1, DEPT.H, 'x', [5, 5, 4, 0, 0, 0, 0, 4]), RT(D1, A2, BR1, DEPT.H, 'x', [7, 7, 6, 0, 0, 0, 0, 6]),
    RT(D2, A1, BR1, DEPT.H, 'x', [9, 9, 8, 0, 0, 0, 0, 8]), RT(D2, A2, BR1, DEPT.H, 'x', [3, 3, 2, 0, 0, 0, 0, 2]), RT(D2, null, BR1, DEPT.H, 'x', [6, 6, 5, 0, 0, 0, 0, 5]),
    RT(D3, A1, BR1, DEPT.H, 'x', [SENTINEL, SENTINEL, SENTINEL, SENTINEL, SENTINEL, SENTINEL, SENTINEL, SENTINEL]),
    RT(D2, B1, BRB, DEPT.FOREIGN, 'x', [SENTINEL, SENTINEL, SENTINEL, SENTINEL, SENTINEL, SENTINEL, SENTINEL, SENTINEL], TB),
  );

  w14.clock.now = NOW; w14.state.clear(); w14.marks.clear(); w14.jobs.length = 0; w14.log.length = 0; w14.failOn = undefined;
  const bl = (centreId: string | null, stage: BacklogFact['stage'], bucket: string, orders: number, tenantId = TA): BacklogFact =>
    ({ tenantId, centreId, stage, bucket, orders, oldest: '2026-11-05T05:00:00.000Z' });
  w14.backlog = [bl(A1, 'awaiting_results', 'lt_4h', 3), bl(A1, 'ready_unreleased', 'h4_24', 2), bl(A2, 'awaiting_results', 'd1_3', 4), bl(A2, 'ready_unreleased', 'lt_4h', 1),
    bl(B1, 'awaiting_results', 'lt_4h', SENTINEL, TB)];
  const pf = (centreId: string | null, status: string, priority: string, departmentId: string | null, bucket: string, n: number, overdue: number, noTarget: number, tenantId = TA): PendingFact =>
    ({ tenantId, centreId, status, priority, departmentId, bucket, n, overdue, noTarget });
  w14.pending = [pf(A1, 'in_process', 'routine', DEPT.H, 'lt_4h', 4, 1, 0), pf(A1, 'awaiting_receipt', 'urgent', DEPT.B, 'h4_24', 3, 2, 1), pf(A2, 'in_process', 'routine', DEPT.H, 'd1_3', 5, 0, 2),
    pf(B1, 'in_process', 'routine', DEPT.FOREIGN, 'lt_4h', SENTINEL, SENTINEL, 0, TB)];
}

/** refresh_state seed: fresh families succeeded 10 min ago; the four special cases used by the freshness tests (now = NOW). */
export function seedFreshness(over: Partial<Record<string, Partial<StateRow> | null>> = {}): void {
  const at = (min: number) => new Date(Date.parse(NOW) - min * 60_000).toISOString();
  for (const f of FAMILIES) w14.state.set(sk(TA, f), { tenant: TA, family: f, last_success_at: at(10) });
  w14.state.set(sk(TA, 'income'), { tenant: TA, family: 'income', last_success_at: at(45) });           // 45 min ago → refresh_lagging (US-01.4)
  w14.state.delete(sk(TA, 'department_income'));                                                          // no row → never_refreshed
  w14.state.set(sk(TA, 'referrer_billing'), { tenant: TA, family: 'referrer_billing', last_success_at: at(10), last_error_code: 'refresh_error' }); // last attempt failed
  w14.marks.set(mk(TA, 'referrer_volume', D2), { tenant: TA, family: 'referrer_volume', date: D2, first: at(30), last: at(1), reason: 'event', actor: 'x' }); // dirty 30 min → lagging
  w14.state.set(sk(TB, 'income'), { tenant: TB, family: 'income', last_success_at: at(1000) });          // other tenant: must not leak
  for (const [f, v] of Object.entries(over)) { if (v === null) w14.state.delete(sk(TA, f)); else w14.state.set(sk(TA, f), { tenant: TA, family: f, ...v }); }
}

// ------------------------------------------------------------------ the fake transaction
type Scope = { all: boolean; centreIds: readonly string[] };
const ALL: Scope = { all: true, centreIds: [] };
export const SCOPE_OF: Record<string, Scope> = { [OWNER_A109]: { all: false, centreIds: [A1] } };
const isUuidArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const tick = () => Promise.resolve();

export function makeTx14(ctxTenant: string, actorScope: Scope = ALL, touched: string[] = []) {
  const query = vi.fn(async (text: string, values: unknown[] = []) => {
    touched.push('tx.query');
    w14.log.push({ text, values });
    if (w14.failOn) { const e = w14.failOn(text); if (e) throw e; }
    await tick();                                                            // one yield per statement: un-serialised read-then-write races interleave
    const tenant = ctxTenant;                                                // RLS: the session tenant is the only one visible / writable
    if (typeof values[0] === 'string' && values[0] !== ctxTenant && /^\s*INSERT/i.test(text)) {
      throw Object.assign(new Error('new row violates row-level security policy'), { code: '42501' });
    }

    if (/INSERT\s+INTO\s+analytics\.refresh_state/i.test(text)) {            // §9.7 throttle (the only refresh_state row a user may write: '_manual')
      if (!/_manual/.test(text)) throw Object.assign(new Error('permission denied for table refresh_state'), { code: '42501' });
      const minutes = Number(values[1]);
      const now = Date.parse(w14.clock.now);
      const cur = w14.state.get(sk(tenant, '_manual'));
      if (!cur) { w14.state.set(sk(tenant, '_manual'), { tenant, family: '_manual', last_manual_at: w14.clock.now, created_by: String(values[2]) }); return { rows: [{ last_manual_at: new Date(now) }], rowCount: 1 }; }
      if (cur.last_manual_at === undefined || Date.parse(cur.last_manual_at) < now - minutes * 60_000) {
        cur.last_manual_at = w14.clock.now; return { rows: [{ last_manual_at: new Date(now) }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (/last_manual_at/i.test(text) && /FROM\s+analytics\.refresh_state/i.test(text) && /^\s*SELECT/i.test(text)) {
      const cur = w14.state.get(sk(tenant, '_manual'));
      return { rows: cur?.last_manual_at ? [{ last_manual_at: new Date(cur.last_manual_at) }] : [], rowCount: cur ? 1 : 0 };
    }
    if (/^\s*SELECT[\s\S]*FROM\s+analytics\.refresh_state/i.test(text)) {    // loadFamilyStates
      const rows = [...w14.state.values()].filter((s) => s.tenant === tenant)
        .map((s) => ({ family: s.family, last_success_at: s.last_success_at ? new Date(s.last_success_at) : null, last_error_code: s.last_error_code ?? null }));
      return { rows, rowCount: rows.length };
    }
    if (/^\s*SELECT[\s\S]*FROM\s+analytics\.dirty_partitions/i.test(text)) {
      const by = new Map<string, string>();
      for (const m of w14.marks.values()) if (m.tenant === tenant && (by.get(m.family) ?? '9') > m.first) by.set(m.family, m.first);
      return { rows: [...by].map(([family, oldest]) => ({ family, oldest: new Date(oldest) })), rowCount: by.size };
    }
    if (/INSERT\s+INTO\s+analytics\.dirty_partitions/i.test(text)) {         // refresh.repo.markDirty
      const [t, family, date, reason, actor] = values as string[];
      const key = mk(t!, family!, date!);
      const cur = w14.marks.get(key);
      w14.marks.set(key, cur ? { ...cur, last: w14.clock.now } : { tenant: t!, family: family!, date: date!, first: w14.clock.now, last: w14.clock.now, reason: reason!, actor: actor! });
      return { rows: [], rowCount: 1 };
    }
    if (/app\.enqueue_job/i.test(text)) {
      let payload: any = values[1]; try { payload = JSON.parse(String(values[1])); } catch { /* keep raw */ }
      w14.jobs.push({ identifier: String(values[0]), payload, jobKey: values[2], text });
      return { rows: [], rowCount: 1 };
    }
    if (/FROM\s+analytics\.report_backlog/i.test(text)) {
      const all = values.find((v) => typeof v === 'boolean') as boolean | undefined;
      const centres = values.find(isUuidArr);
      const rows = w14.backlog.filter((b) => b.tenantId === tenant && (all === undefined && centres === undefined ? true : all === true || (b.centreId !== null && (centres ?? []).includes(b.centreId))))
        .map((b) => ({ centre_id: b.centreId, stage: b.stage, age_bucket: b.bucket, orders: b.orders, oldest_registered_at: b.oldest }));
      return { rows, rowCount: rows.length };
    }
    if (/FROM\s+lab\.v_pub_pending_items/i.test(text)) {
      const explicit = /centre_id\s*=\s*ANY\s*\(\s*\$(\d+)/i.exec(text);
      const wanted = explicit ? (values[Number(explicit[1]) - 1] as string[]) : undefined;
      const seen = w14.pending.filter((p) => p.tenantId === tenant && (actorScope.all || (p.centreId !== null && actorScope.centreIds.includes(p.centreId)))   // C5 RLS
        && (!wanted || (p.centreId !== null && wanted.includes(p.centreId))));
      const g = new Map<string, PendingFact[]>();
      for (const p of seen) { const k = [p.status, p.priority, p.departmentId, p.bucket].join('|'); g.set(k, [...(g.get(k) ?? []), p]); }
      const rows = [...g.values()].map((x) => ({ item_status: x[0]!.status, priority: x[0]!.priority, department_id: x[0]!.departmentId, age_bucket: x[0]!.bucket,
        n: sum(x.map((p) => p.n)), overdue: sum(x.map((p) => p.overdue)), no_target: sum(x.map((p) => p.noTarget)) }));
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  });
  return { query };
}

// ------------------------------------------------------------------ repo mocks
export const rollupsMock14 = {
  ...rollupsMock09,
  resultsRows: rollupsMockT11.resultsRows,
};
export const labelsRepoMock14 = labelsRepoMock09;

// ------------------------------------------------------------------ ctx + calls
export async function makeCtx14(actorKey: string, over: Record<string, unknown> = {}) {
  const r = await makeCtx09(actorKey, { now: () => w14.clock.now, ...over });
  const touched: string[] = r.touched;
  r.ctx.tx = makeTx14(r.ctx.tenantId, SCOPE_OF[actorKey] ?? ALL, touched);
  r.ctx.operationId = 'getAnalyticsDashboard';
  return { ...r, touched, tx: r.ctx.tx };
}

export type Op14 = 'getAnalyticsDashboard' | 'getAnalyticsFreshness' | 'requestAnalyticsRefresh';
export async function call14(op: Op14, ctx: any, o: { query?: Record<string, unknown>; body?: unknown } = {}) {
  const { handlers } = await import('../index.js');
  ctx.operationId = op;
  return handlers[op]({ params: {}, query: o.query ?? {}, headers: {}, body: o.body }, ctx);
}
export async function ok14(op: Op14, ctx: any, o: { query?: Record<string, unknown>; body?: unknown } = {}, status = 200): Promise<any> {
  const r = await call14(op, ctx, o);
  if (r.status !== status) throw new Error(`expected ${status} from ${op}, got ${r.status}`);
  return r.body;
}
export const dash = (ctx: any, query: Record<string, unknown> = {}) => ok14('getAnalyticsDashboard', ctx, { query });
export const WINDOW = { business_date_from: D1, business_date_to: D3 }; // [2026-11-05, 2026-11-07): two days, previous period = [2026-11-03, 2026-11-05)

/** Statements of the log that touched refresh_state / dirty_partitions / enqueue (writes only). */
export const writes = () => w14.log.filter((l) => /^\s*(INSERT|UPDATE|DELETE)/i.test(l.text) || /app\.enqueue_job/i.test(l.text));
