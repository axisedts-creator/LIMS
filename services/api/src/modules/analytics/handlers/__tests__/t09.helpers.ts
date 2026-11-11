// AN-T09 test helpers (not a test file). Synthetic data only. Used by volume/topCentres/topReferrers/collections/filterOptions handler tests.
// Builds on ./helpers.ts (AN-T08): same ids, same ctx shape, same income emulator. Adds in-memory emulators of
// analytics.daily_orders, daily_centre_volume, daily_referrer_volume, daily_collections and the directory lookups.
//
// SEAMS pinned here (the spec leaves repository signatures open; the writer may dispute through the reviewer). All take (tx, args):
//   rollups.repo.volumeRows({tenantId,from,to,scope,groupBy:'day'|'ad_month'|'branch'|'centre'})
//       -> [{key, orders_registered, orders_cancelled, patient_visits, new_patients, urgent_orders, opd_orders, ipd_orders, tests_ordered}]
//          (key as income: 'YYYY-MM-DD' | 'YYYY-MM-01' | uuid; tests_ordered = daily_centre_volume.order_items summed by the same key; bs_month = day rows grouped in service)
//   rollups.repo.topCentresRows({tenantId,from,to,scope})
//       -> [{centre_id, branch_id, orders, patient_visits, tests_ordered, net_sales_paisa, orders_walk_in, orders_home, orders_centre, orders_partner}]
//   rollups.repo.referrerVolumeRows({tenantId,from,to,scope})   (reads daily_referrer_volume ONLY; D-44)
//       -> [{referrer_id: uuid|null, orders, patient_visits, tests_ordered}]   grouped by the RAW referrer id (canonical merge is done in the service)
//   rollups.repo.collectionRows({tenantId,from,to,scope,groupBy:'method'|'staff'|'staff_method'|'centre'|'day'|'ad_month',paymentMethodCodes?})
//       -> [{[method_code]:string, [staff_id]:uuid|null, [centre_id]:uuid|null, [period]:'YYYY-MM-DD'|'YYYY-MM-01',
//            entries, reversals, gross_collected_paisa, reversed_paisa, net_collected_paisa}]
//          only the dimension fields of the requested groupBy are present (method->method_code, staff->staff_id, staff_method->both,
//          centre->centre_id, day/ad_month->period). bs_month = the service asks for 'day' and groups itself.
//   rollups.repo.paymentMethodCodes({tenantId,scope}) -> string[]     distinct daily_collections.payment_method_code in scope (C8 cannot read the foreign billing coded set)
//   rollups.repo.specimenTypeCodes({tenantId,scope})   -> string[]     distinct daily_specimens.specimen_type_code in scope
//   labels.repo.listReferrers({tenantId, ids}) as AN-T07; labels.repo.searchReferrers({tenantId, query, limit}) -> ReferrerRow[]
//       (display_name contains `query`, case-insensitive, `%`/`_` taken literally; the service caps the answer at 20)
//   ctx.core.memberships.list(ctx, {membershipIds?, permission?, activeOnly?}) (08 A17 D-47); rows carry roleCodes + allCentres, which must NOT reach the DTO.
import { vi } from 'vitest';
import { createFakeIdentityPort, type MembershipRow } from '../../../../../../../packages/fakes/src/IdentityPort.fake';
import { TENANTS, actorIdFor, idFor } from '../../../../../../../packages/fakes/src/base';
import { makeCtxFor } from '../../../../../../../packages/fakes/src/harness';
import {
  A1, A2, A3, B1, BR1, BR2, BRB, D0, D1, D2, D3, TA, TB, db, incFact, labelsRepoMock, makeCore, rollupsMock, seedStandard,
} from './helpers.js';

export { A1, A2, A3, B1, BR1, BR2, BRB, D0, D1, D2, D3, TA, TB, db };
export { ADMIN, NO_PERM, PARTNER, OWNER_A1, OWNER_ALL, OWNER_MULTI, BRANCH_NAME, CENTRE_NAME, addDays, bsKey, golden, contractErrors, expectLims, rejection } from './helpers.js';

const SEED = 1;
const BRANCH_OF: Record<string, string> = { [A1]: BR1, [A2]: BR1, [A3]: BR2, [B1]: BRB };
export const DEPT_NAMES = ['Haematology', 'Biochemistry', 'Legacy Serology']; // tenant A departments of seedStandard()
export const R = { ALPHA: idFor(SEED, 0xf1), BETA: idFor(SEED, 0xf2), GAMMA: idFor(SEED, 0xf3), DELTA: idFor(SEED, 0xf4), FOREIGN: idFor(SEED, 0xf5) };
export const REF_NAME = { ALPHA: 'Dr. Test Alpha', BETA: 'Dr. Test Beta', GAMMA: 'Dr. Test Gamma', DELTA: 'Dr. Test Delta', FOREIGN: 'Dr. Tenant B Foreign' };
export const S1 = idFor(SEED, 0xe1), S2 = idFor(SEED, 0xe2); // collecting staff; S2 is deactivated
export const M1 = idFor(SEED, 0xe3), M2 = idFor(SEED, 0xe4), M3 = idFor(SEED, 0xe5), M4 = idFor(SEED, 0xe6);

// ------------------------------------------------------------------ personas
export const FINANCE = 'A:user:finance';           // finance: analytics.collections.read + billing.cash_report.read, NO analytics.dashboard.read
export const FINANCE_A1 = 'A:user:financea1';      // same, restricted to {A1}
export const LAB_MANAGER = 'A:user:labmanager';    // analytics.dashboard.read only (no collections, no schedule.manage, no cash report)
export const COLL_NO_CASH = 'A:user:collnocash';   // lab_manager + analytics.collections.read, NO billing.cash_report.read
export const OWNER_ALL09 = 'A:user:ownerall';
export const OWNER_A109 = 'A:user:ownera1';
const member = (persona: string, n: number, roles: string[], centreScope: MembershipRow['centreScope'], extra: string[] = []): MembershipRow => ({
  id: idFor(SEED, 0xa00 + n), tenantId: TENANTS.A, actorId: actorIdFor('A', 'user', persona), actorType: 'user',
  displayName: `Test User A-${persona}`, roles, extraPermissions: extra, centreScope, branchIds: [],
  mfaLevel: 'aal2', isLocked: false, status: 'active', email: null, version: 1,
});
const ALLC = { all: true, centreIds: [] as string[] };
const MEMBERS = [
  member('ownerall', 1, ['owner_viewer'], ALLC), member('ownera1', 2, ['owner_viewer'], { all: false, centreIds: [A1] }),
  member('ownermulti', 3, ['owner_viewer'], { all: false, centreIds: [A1, A2] }),
  member('finance', 4, ['finance'], ALLC), member('financea1', 5, ['finance'], { all: false, centreIds: [A1] }),
  member('labmanager', 6, ['lab_manager'], ALLC), member('collnocash', 7, ['lab_manager'], ALLC, ['analytics.collections.read']),
];

// ------------------------------------------------------------------ world
interface Base { tenantId: string; date: string; branchId: string; centreId: string | null }
export interface OrdersFact extends Base { reg: number; canc: number; pat: number; newp: number; urgent: number; opd: number; ipd: number }
export interface CvolFact extends Base { mode: 'walk_in' | 'home' | 'centre' | 'partner'; orders: number; pat: number; items: number }
export interface RefFact extends Base { referrerId: string | null; orders: number; pat: number; items: number }
export interface CollFact extends Base { staffId: string | null; method: string; entries: number; reversals: number; gross: number; reversed: number; net: number }
export const w = {
  orders: [] as OrdersFact[], cvol: [] as CvolFact[], refs: [] as RefFact[], coll: [] as CollFact[],
  referrers: [] as { tenantId: string; referrer_id: string; display_name: string; is_active: boolean; canonical_referrer_id: string | null }[],
  specimens: [] as { tenantId: string; centreId: string; code: string }[],
  staff: [] as { membershipId: string; displayName: string; roleCodes: string[]; allCentres: boolean; isActive: boolean; perms: string[] }[],
};
const bOf = (c: string | null) => (c ? BRANCH_OF[c]! : BR1);
export const ord = (date: string, c: string, o: Partial<OrdersFact> & { reg: number }): OrdersFact =>
  ({ tenantId: TA, date, branchId: bOf(c), centreId: c, canc: 0, pat: o.reg, newp: 0, urgent: 0, opd: 0, ipd: 0, ...o });
export const cv = (date: string, c: string, mode: CvolFact['mode'], o: { orders: number; pat: number; items: number; tenantId?: string }): CvolFact =>
  ({ tenantId: o.tenantId ?? TA, date, branchId: bOf(c), centreId: c, mode, orders: o.orders, pat: o.pat, items: o.items });
export const rf = (date: string, c: string, referrerId: string | null, o: { orders: number; pat?: number; items?: number; tenantId?: string }): RefFact =>
  ({ tenantId: o.tenantId ?? TA, date, branchId: bOf(c), centreId: c, referrerId, orders: o.orders, pat: o.pat ?? o.orders, items: o.items ?? o.orders });
export const cl = (date: string, c: string | null, staffId: string | null, method: string, o: { entries: number; reversals?: number; gross: number; reversed?: number; tenantId?: string }): CollFact => {
  const reversed = o.reversed ?? 0;
  return { tenantId: o.tenantId ?? TA, date, branchId: bOf(c), centreId: c, staffId, method, entries: o.entries, reversals: o.reversals ?? 0, gross: o.gross, reversed, net: o.gross - reversed };
};

/**
 * Standard world, window [D1, D3), tenant A (hand-computed expectations live in the tests). Income comes from seedStandard().
 *  orders  D1 A1 reg10 canc1 pv8 new2 urg3 opd6 ipd2 | D1 A2 reg5 pv5 new1 opd4 ipd1 | D2 A1 reg4 canc2 pv3 urg1 opd2 ipd2 | D0/D3 A1 + tenant B outliers
 *  cvol    D1 A1 walk_in 7/6/20, home 3/2/5 | D1 A2 centre 5/5/11 | D2 A1 walk_in 4/3/9 (orders/pv/items) | outliers
 *  refs    ALPHA 5 (D1: A1 3, A2 2), BETA 3 (D1 A1), SELF 2 (D1 A1), GAMMA 4 (D2 A1; merged into ALPHA), DELTA 1 (D2 A1; inactive) | outliers
 *  coll    empty here; seedCollections() fills it (totals 9000 gross, 500 reversed, 8500 net)
 */
export function seed09(): void {
  seedStandard();
  w.orders = [
    ord(D1, A1, { reg: 10, canc: 1, pat: 8, newp: 2, urgent: 3, opd: 6, ipd: 2 }), ord(D1, A2, { reg: 5, pat: 5, newp: 1, opd: 4, ipd: 1 }),
    ord(D2, A1, { reg: 4, canc: 2, pat: 3, urgent: 1, opd: 2, ipd: 2 }),
    ord(D0, A1, { reg: 111, pat: 111 }), ord(D3, A1, { reg: 222, pat: 222 }),
    { ...ord(D1, B1, { reg: 999_999 }), tenantId: TB, branchId: BRB },
  ];
  w.cvol = [
    cv(D1, A1, 'walk_in', { orders: 7, pat: 6, items: 20 }), cv(D1, A1, 'home', { orders: 3, pat: 2, items: 5 }),
    cv(D1, A2, 'centre', { orders: 5, pat: 5, items: 11 }), cv(D2, A1, 'walk_in', { orders: 4, pat: 3, items: 9 }),
    cv(D0, A1, 'walk_in', { orders: 111, pat: 111, items: 111 }), cv(D3, A1, 'walk_in', { orders: 222, pat: 222, items: 222 }),
    cv(D1, B1, 'walk_in', { tenantId: TB, orders: 999_999, pat: 999_999, items: 999_999 }),
  ];
  w.refs = [
    rf(D1, A1, R.ALPHA, { orders: 3, pat: 3, items: 6 }), rf(D1, A2, R.ALPHA, { orders: 2, pat: 2, items: 4 }),
    rf(D1, A1, R.BETA, { orders: 3, pat: 3, items: 3 }), rf(D1, A1, null, { orders: 2, pat: 2, items: 2 }),
    rf(D2, A1, R.GAMMA, { orders: 4, pat: 4, items: 8 }), rf(D2, A1, R.DELTA, { orders: 1, pat: 1, items: 1 }),
    rf(D0, A1, R.BETA, { orders: 100 }), rf(D3, A1, R.BETA, { orders: 200 }),
    rf(D1, B1, R.FOREIGN, { tenantId: TB, orders: 999_999 }),
  ];
  w.referrers = [
    { tenantId: TA, referrer_id: R.ALPHA, display_name: REF_NAME.ALPHA, is_active: true, canonical_referrer_id: null },
    { tenantId: TA, referrer_id: R.BETA, display_name: REF_NAME.BETA, is_active: true, canonical_referrer_id: null },
    { tenantId: TA, referrer_id: R.GAMMA, display_name: REF_NAME.GAMMA, is_active: true, canonical_referrer_id: R.ALPHA }, // merged into ALPHA
    { tenantId: TA, referrer_id: R.DELTA, display_name: REF_NAME.DELTA, is_active: false, canonical_referrer_id: null },
    { tenantId: TB, referrer_id: R.FOREIGN, display_name: REF_NAME.FOREIGN, is_active: true, canonical_referrer_id: null },
  ];
  w.coll = [];
  w.specimens = [{ tenantId: TA, centreId: A1, code: 'serum' }, { tenantId: TA, centreId: A1, code: 'edta_blood' }, { tenantId: TA, centreId: A2, code: 'urine' },
    { tenantId: TA, centreId: A3, code: 'swab_a3_only' }, { tenantId: TB, centreId: B1, code: 'tenant_b_code' }];
  w.staff = [
    { membershipId: S1, displayName: 'Test Cashier One', roleCodes: ['finance'], allCentres: true, isActive: true, perms: [] },
    { membershipId: S2, displayName: 'Test Cashier Two', roleCodes: ['finance'], allCentres: true, isActive: false, perms: [] },
    { membershipId: M1, displayName: 'Test Manager One', roleCodes: ['lab_manager'], allCentres: true, isActive: true, perms: ['analytics.dashboard.read'] },
    { membershipId: M2, displayName: 'Test Manager Two', roleCodes: ['owner_viewer'], allCentres: false, isActive: true, perms: ['analytics.dashboard.read'] },
    { membershipId: M3, displayName: 'Test Former Manager', roleCodes: ['lab_manager'], allCentres: true, isActive: false, perms: ['analytics.dashboard.read'] },
    { membershipId: M4, displayName: 'Test Cashier Three', roleCodes: ['finance'], allCentres: true, isActive: true, perms: [] }, // no dashboard.read
  ];
}

/**
 * Collections world (window [D1, D3)), tenant A. Totals gross 9000, reversed 500, net 8500.
 *  D1 A1 S1 cash 3/0 gross 5000 | D1 A1 S1 esewa 1/0 1000 | D1 A2 S2 cash 2 entries, 1 reversal, gross 2000 reversed 500 (net 1500)
 *  D2 A1 gateway(NULL staff) esewa 1/0 300 | D2 NULL-centre (credit party) S1 bank_transfer 1/0 700 | D0/D3 + tenant B outliers
 *  by method: cash 5/1 7000/500/6500, esewa 2/0 1300, bank_transfer 1/0 700; by staff: S1 6700, S2 1500, gateway 300; by centre: A1 6300, A2 1500, NULL 700.
 */
export function seedCollections(): void {
  w.coll = [
    cl(D1, A1, S1, 'cash', { entries: 3, gross: 5000 }), cl(D1, A1, S1, 'esewa', { entries: 1, gross: 1000 }),
    cl(D1, A2, S2, 'cash', { entries: 2, reversals: 1, gross: 2000, reversed: 500 }),
    cl(D2, A1, null, 'esewa', { entries: 1, gross: 300 }), cl(D2, null, S1, 'bank_transfer', { entries: 1, gross: 700 }),
    cl(D0, A1, S1, 'cash', { entries: 9, gross: 111 }), cl(D3, A1, S1, 'cash', { entries: 9, gross: 222 }),
    cl(D1, B1, S1, 'tenant_b_method', { tenantId: TB, entries: 99, gross: 999_999 }),
  ];
}

// ------------------------------------------------------------------ repo emulators
type Scope = { all: boolean; centreIds: readonly string[] };
const inScope = (s: Scope, c: string | null) => s.all || (c !== null && s.centreIds.includes(c));
const inWin = (d: string, from: string, to: string) => d >= from && d < to;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
type Q = { tenantId: string; from: string; to: string; scope: Scope };
const pick = <T extends Base>(xs: T[], a: Q) => xs.filter((f) => f.tenantId === a.tenantId && inWin(f.date, a.from, a.to) && inScope(a.scope, f.centreId));
function group<T>(xs: T[], keyOf: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>(); for (const x of xs) m.set(keyOf(x), [...(m.get(keyOf(x)) ?? []), x]); return m;
}
const keyFor = (groupBy: string, f: Base) => groupBy === 'day' ? f.date : groupBy === 'ad_month' ? `${f.date.slice(0, 7)}-01`
  : groupBy === 'branch' ? f.branchId : groupBy === 'centre' ? String(f.centreId) : (() => { throw new Error(`mock: groupBy ${groupBy}`); })();

export const rollupsMock09 = {
  ...rollupsMock,
  volumeRows: vi.fn(async (_tx: unknown, a: Q & { groupBy: string }) => {
    db.calls.push({ fn: 'volumeRows', args: a });
    if (db.fail) throw db.fail;
    const os = group(pick(w.orders, a), (f) => keyFor(a.groupBy, f)); const cs = group(pick(w.cvol, a), (f) => keyFor(a.groupBy, f));
    return [...os.keys()].sort().map((key) => {
      const g = os.get(key)!;
      return {
        key, orders_registered: sum(g.map((f) => f.reg)), orders_cancelled: sum(g.map((f) => f.canc)), patient_visits: sum(g.map((f) => f.pat)),
        new_patients: sum(g.map((f) => f.newp)), urgent_orders: sum(g.map((f) => f.urgent)), opd_orders: sum(g.map((f) => f.opd)), ipd_orders: sum(g.map((f) => f.ipd)),
        tests_ordered: sum((cs.get(key) ?? []).map((f) => f.items)),
      };
    });
  }),
  topCentresRows: vi.fn(async (_tx: unknown, a: Q) => {
    db.calls.push({ fn: 'topCentresRows', args: a });
    if (db.fail) throw db.fail;
    const inc = pick(db.income as any, a) as typeof db.income;
    return [...group(pick(w.cvol, a), (f) => String(f.centreId)).entries()].sort(([x], [y]) => x.localeCompare(y)).map(([centre, g]) => {
      const mode = (m: string) => sum(g.filter((f) => f.mode === m).map((f) => f.orders));
      const mine = inc.filter((f) => f.centreId === centre);
      return {
        centre_id: centre, branch_id: g[0]!.branchId, orders: sum(g.map((f) => f.orders)), patient_visits: sum(g.map((f) => f.pat)), tests_ordered: sum(g.map((f) => f.items)),
        net_sales_paisa: sum(mine.map((f) => f.net - f.credit)), orders_walk_in: mode('walk_in'), orders_home: mode('home'), orders_centre: mode('centre'), orders_partner: mode('partner'),
      };
    });
  }),
  referrerVolumeRows: vi.fn(async (_tx: unknown, a: Q) => {
    db.calls.push({ fn: 'referrerVolumeRows', args: a });
    if (db.fail) throw db.fail;
    return [...group(pick(w.refs, a), (f) => f.referrerId ?? '').entries()].sort(([x], [y]) => x.localeCompare(y)).map(([, g]) => ({
      referrer_id: g[0]!.referrerId, orders: sum(g.map((f) => f.orders)), patient_visits: sum(g.map((f) => f.pat)), tests_ordered: sum(g.map((f) => f.items)),
    }));
  }),
  collectionRows: vi.fn(async (_tx: unknown, a: Q & { groupBy: string; paymentMethodCodes?: readonly string[] }) => {
    db.calls.push({ fn: 'collectionRows', args: a });
    if (db.fail) throw db.fail;
    const dims = a.groupBy === 'staff_method' ? ['staff', 'method'] : [a.groupBy];
    const facts = pick(w.coll, a).filter((f) => !a.paymentMethodCodes?.length || a.paymentMethodCodes.includes(f.method));
    const dimKey = (f: CollFact) => dims.map((d) => d === 'method' ? f.method : d === 'staff' ? String(f.staffId) : d === 'centre' ? String(f.centreId) : keyFor(d, f)).join('|');
    return [...group(facts, dimKey).entries()].sort(([x], [y]) => x.localeCompare(y)).map(([, g]) => {
      const f = g[0]!;
      return {
        ...(dims.includes('method') ? { method_code: f.method } : {}), ...(dims.includes('staff') ? { staff_id: f.staffId } : {}),
        ...(dims.includes('centre') ? { centre_id: f.centreId } : {}), ...(dims.includes('day') || dims.includes('ad_month') ? { period: keyFor(a.groupBy, f) } : {}),
        entries: sum(g.map((x) => x.entries)), reversals: sum(g.map((x) => x.reversals)), gross_collected_paisa: sum(g.map((x) => x.gross)),
        reversed_paisa: sum(g.map((x) => x.reversed)), net_collected_paisa: sum(g.map((x) => x.net)),
      };
    });
  }),
  paymentMethodCodes: vi.fn(async (_tx: unknown, a: { tenantId: string; scope: Scope }) => {
    db.calls.push({ fn: 'paymentMethodCodes', args: a });
    return [...new Set(w.coll.filter((f) => f.tenantId === a.tenantId && inScope(a.scope, f.centreId)).map((f) => f.method))].sort();
  }),
  specimenTypeCodes: vi.fn(async (_tx: unknown, a: { tenantId: string; scope: Scope }) => {
    db.calls.push({ fn: 'specimenTypeCodes', args: a });
    return [...new Set(w.specimens.filter((f) => f.tenantId === a.tenantId && inScope(a.scope, f.centreId)).map((f) => f.code))].sort();
  }),
};

export const labelsRepoMock09 = {
  ...labelsRepoMock,
  listReferrers: vi.fn(async (_tx: unknown, a: { tenantId: string; ids?: readonly string[] }) => {
    db.calls.push({ fn: 'listReferrers', args: a });
    return w.referrers.filter((r) => r.tenantId === a.tenantId && (!a.ids || a.ids.includes(r.referrer_id)))
      .map(({ referrer_id, display_name, is_active, canonical_referrer_id }) => ({ referrer_id, display_name, is_active, canonical_referrer_id }));
  }),
  searchReferrers: vi.fn(async (_tx: unknown, a: { tenantId: string; query: string; limit?: number }) => {
    db.calls.push({ fn: 'searchReferrers', args: a });
    if (db.fail) throw db.fail;
    return w.referrers.filter((r) => r.tenantId === a.tenantId && r.display_name.toLowerCase().includes(a.query.toLowerCase()))
      .map(({ referrer_id, display_name, is_active, canonical_referrer_id }) => ({ referrer_id, display_name, is_active, canonical_referrer_id }));
  }),
};

// ------------------------------------------------------------------ ctx
export async function makeCtx09(actorKey: string, over: Record<string, unknown> = {}) {
  const identity = createFakeIdentityPort({ seed: SEED, fixtures: { memberships: MEMBERS } }) as any;
  const touched: string[] = [];
  const core: any = makeCore(touched);
  core.memberships = {
    async list(_ctx: unknown, input: { membershipIds?: string[]; permission?: string; activeOnly?: boolean } = {}) {
      touched.push('core.memberships'); db.calls.push({ fn: 'memberships.list', args: input });
      return w.staff
        .filter((s) => (!input.membershipIds || input.membershipIds.includes(s.membershipId)) && (input.activeOnly === false || s.isActive)
          && (!input.permission || s.perms.includes(input.permission)))
        .map(({ perms: _p, ...row }) => row);
    },
  };
  const reports = await import('../../service/reports.service.js');
  const ctx: any = {
    ...makeCtxFor()(actorKey, { now: () => '2026-11-06T06:00:00.000Z', ...over } as any),
    operationId: 'getVolumeReport', clientIp: '127.0.0.1',
    ports: { IdentityPort: identity }, core,
    tx: { query: vi.fn(async () => { touched.push('tx.query'); return { rows: [] }; }) },
    metrics: { inc: vi.fn() }, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    services: { analytics: { reports } },
  };
  return { ctx, touched, identity };
}

export type Op09 = 'getVolumeReport' | 'getTopCentresReport' | 'getTopReferrersReport' | 'getCollectionsReport' | 'searchAnalyticsReferrers'
  | 'getAnalyticsFilterOptions' | 'getCollectionsFilterOptions';
export async function call09(op: Op09, ctx: any, query: Record<string, unknown> = {}, body?: unknown) {
  const { handlers } = await import('../index.js');
  ctx.operationId = op;
  return handlers[op]({ params: {}, query, headers: {}, body }, ctx);
}
export async function ok09(op: Op09, ctx: any, query: Record<string, unknown> = {}, body?: unknown): Promise<any> {
  const r = await call09(op, ctx, query, body);
  if (r.status !== 200) throw new Error(`expected 200 from ${op}, got ${r.status}`);
  return r.body;
}
export const WINDOW = { business_date_from: D1, business_date_to: D3 }; // [2026-11-05, 2026-11-07)
export const rowByKey = (body: any, key: string) => body.rows.find((r: any) => r.key === key);
export { incFact };
