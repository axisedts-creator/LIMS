// T-28a (C3) shared test setup: the REAL CatalogPort (non-price methods) + its revision-keyed cache over the SQL fake (helpers/testsDb.ts). Synthetic data only.
// SEAM (spec silent on names; see .orchestra/notes/T-28a-tests.md):
//   catalog/cache/catalogCache.ts  export function createCatalogCache(opts: { maxEntries: number; ttlSeconds: number; now?: () => number /* epoch ms */ }): CatalogCache
//     CatalogCache = { get<T>(tenantId, revision, kind, id): T | undefined; set<T>(tenantId, revision, kind, id, value: T): void;
//                      getOrLoad<T>(tenantId, revision, kind, id, load: () => Promise<T>): Promise<T>; readonly size: number; clear(): void }
//     key = (tenantId, revision:number, kind:string, id:string) (02-TRD §6.3); LRU (get refreshes recency); TTL = ttlSeconds * 1000 ms on `now()`; a rejected
//     loader caches nothing; falsy values (0, '', [], null) ARE cached (only `undefined` from get means miss).
//   catalog/ports/CatalogPort.impl.ts  export function createCatalogPort(deps: { cache: CatalogCache }): CatalogPortV1-subset
//     methods in T-28a: getTest, getPanel, resolveOrderables, referenceRangeFor, criticalLimitsFor (camelCase per contracts/ports/CatalogPort.ts; priceFor & co land with T-28b/T-29).
//     All run inside ctx.tx (never open a transaction, never write, never FOR UPDATE), tenant from ctx.tenantId only, default asOf/at = ctx.now(), the catalog_revision is read ONCE per
//     ctx (`SELECT catalog_revision FROM catalog.catalog_state WHERE tenant_id = $1`, memoised on the ctx) and is the cache-key revision; everything else is served from the cache when warm.
//     Errors are LimsError (common.not_found, catalog.test_inactive, catalog.panel_cycle, catalog.no_reference_range, common.validation_failed).
import { createEvents } from '../../../../core/events/publish.js';
import { isLimsError } from '../../../../core/errors.js';
import { createCatalogCache } from '../../cache/catalogCache.js';
import { createCatalogPort } from '../../ports/CatalogPort.impl.js';
import { createRevisionService } from '../../service/revision.service.js';
import { ROOT_A, ROOT_B, TENANT_A, TENANT_B } from './catalogDb.js';
import { cont, meth, spec as specimen } from './mastersDb.js';
import { ID, ana, anv, cband, cset, makeTestsDb, pmb, pnl, rband, rset, tat, tsr, tst, type Row, type T6Table } from './testsDb.js';
import { BIOC, EDTA, EDTA_B, HAEM, HAEM_B, LAV, LAV_B, SERUM } from './t6.js';

export { TENANT_A, TENANT_B, ID, EDTA, SERUM, HAEM, BIOC, LAV };
export const T = 20_000;
/** ctx.now() of the fake. */
export const NOW = '2026-11-07T12:00:00.000Z';
export const T0 = '2026-01-01T00:00:00.000Z';
export const REV = 417;
export type Rows = Partial<Record<T6Table, Row[]>>;
const D = (iso: string) => new Date(iso);

export const FLP = specimen(7, TENANT_A, { code: 'FL_PLASMA', report_label: 'FL PLASMA' });
export const GRY = cont(5, TENANT_A, { code: 'GREY_TOP' });
export const M1 = meth(1, TENANT_A, { code: 'PHOTOMETRY', name: 'Photometry' });
export const M2 = meth(2, TENANT_A, { code: 'IMPEDANCE', name: 'Impedance' });

// ---- tests (tenant A): chemistry TC/HDL/TG/LDL (serum), CBC (EDTA pref + LAV, serum), FBS (FL plasma + grey), ADDON (no specimen, uses existing material), OLD (inactive)
export const TC = tst(1, TENANT_A, BIOC.id, { code: 'TC', name: 'Total cholesterol' });
export const HDL = tst(2, TENANT_A, BIOC.id, { code: 'HDL', name: 'HDL cholesterol' });
export const TG = tst(3, TENANT_A, BIOC.id, { code: 'TG', name: 'Triglycerides' });
export const LDL = tst(4, TENANT_A, BIOC.id, { code: 'LDL', name: 'LDL cholesterol' });
export const CBC = tst(5, TENANT_A, HAEM.id, { code: 'CBC', name: 'Complete blood count' });
export const FBS = tst(6, TENANT_A, BIOC.id, { code: 'FBS', name: 'Fasting blood sugar' });
export const ADDON = tst(7, TENANT_A, HAEM.id, { code: 'ADDON', name: 'Add-on on existing material', uses_existing_material: true });
export const OLD = tst(8, TENANT_A, BIOC.id, { code: 'OLD', name: 'Retired test', is_active: false });
/** The rich definition: revision 77, preferred SERUM (+ container) and a non-preferred EDTA, TAT history, six analytes (see ANA below). */
export const LAB = tst(50, TENANT_A, HAEM.id, { code: 'LAB', name: 'Lab profile test', revision: 77 });
/** Host of the range / critical-limit analytes. */
export const RNG = tst(51, TENANT_A, BIOC.id, { code: 'RNG', name: 'Range host test' });
export const TEST_B = tst(20, TENANT_B, HAEM_B.id, { code: 'BTEST', name: 'Tenant B only test' });
const TESTS = [TC, HDL, TG, LDL, CBC, FBS, ADDON, OLD, LAB, RNG];

// ---- panels (tenant A). HP_ELITE_M carries revision 91; CY1 <-> CY2 is a (seeded, i.e. defensive) cycle; HASOLD is active but holds the inactive OLD test.
export const LIPID = pnl(1, TENANT_A, { code: 'LIPID', name: 'Lipid profile', panel_kind: 'clinical', department_id: BIOC.id });
export const HP_ELITE_M = pnl(2, TENANT_A, { code: 'HP_ELITE_M', name: 'Health package elite male', panel_kind: 'package', sex_restriction: 'male', revision: 91 });
export const BASIC = pnl(3, TENANT_A, { code: 'BASIC', name: 'Basic screen', panel_kind: 'clinical' });
export const DEAD = pnl(4, TENANT_A, { code: 'DEAD', name: 'Retired panel', panel_kind: 'clinical', is_active: false });
export const HASOLD = pnl(5, TENANT_A, { code: 'HASOLD', name: 'Panel holding a retired test', panel_kind: 'clinical' });
export const CY1 = pnl(6, TENANT_A, { code: 'CY1', name: 'Cycle one', panel_kind: 'clinical' });
export const CY2 = pnl(7, TENANT_A, { code: 'CY2', name: 'Cycle two', panel_kind: 'clinical' });
export const PANEL_B = pnl(20, TENANT_B, { code: 'BPANEL', name: 'Tenant B panel', panel_kind: 'clinical' });
const PANELS = [LIPID, HP_ELITE_M, BASIC, DEAD, HASOLD, CY1, CY2];
const MEMBERS: Row[] = [
  pmb(LIPID.panel.id, TC.test.id, TENANT_A, 1), pmb(LIPID.panel.id, HDL.test.id, TENANT_A, 2), pmb(LIPID.panel.id, TG.test.id, TENANT_A, 3), pmb(LIPID.panel.id, LDL.test.id, TENANT_A, 4),
  pmb(HP_ELITE_M.panel.id, CBC.test.id, TENANT_A, 1), pmb(HP_ELITE_M.panel.id, LIPID.panel.id, TENANT_A, 2), pmb(HP_ELITE_M.panel.id, FBS.test.id, TENANT_A, 3),
  pmb(BASIC.panel.id, CBC.test.id, TENANT_A, 1), pmb(BASIC.panel.id, FBS.test.id, TENANT_A, 2),
  pmb(DEAD.panel.id, TC.test.id, TENANT_A, 1),
  pmb(HASOLD.panel.id, CBC.test.id, TENANT_A, 1), pmb(HASOLD.panel.id, OLD.test.id, TENANT_A, 2),
  pmb(CY1.panel.id, CY2.panel.id, TENANT_A, 1), pmb(CY2.panel.id, CY1.panel.id, TENANT_A, 1),
  pmb(PANEL_B.panel.id, TEST_B.test.id, TENANT_B, 1),
];
const SPECIMENS: Row[] = [
  ...[TC, HDL, TG, LDL, OLD].map((t) => tsr(t.test.id, SERUM.id, TENANT_A, { is_preferred: true })),
  tsr(CBC.test.id, EDTA.id, TENANT_A, { is_preferred: true, container_id: LAV.id, min_volume_ul: 2000 }), tsr(CBC.test.id, SERUM.id, TENANT_A, { is_preferred: false }),
  tsr(FBS.test.id, FLP.id, TENANT_A, { is_preferred: true, container_id: GRY.id }),
  tsr(LAB.test.id, SERUM.id, TENANT_A, { is_preferred: true, container_id: LAV.id }), tsr(LAB.test.id, EDTA.id, TENANT_A, { is_preferred: false }),
  tsr(TEST_B.test.id, EDTA_B.id, TENANT_B, { is_preferred: true, container_id: LAV_B.id }),
];

// ---- analytes. A published version row (defaults: numeric g_dl, 1 decimal, no method, effective since T0).
export const av = (n: number, tenant: string, analyteId: string, o: Row = {}): Row =>
  anv(n, tenant, analyteId, { version_no: 1, status: 'published', result_type: 'numeric', unit_code: 'g_dl', decimals: 1, method_id: null, effective_from: D(T0), published_at: D(T0), published_by: ID(0xa1), change_reason: 'initial', ...o });
const draftV = (n: number, analyteId: string, o: Row = {}): Row =>
  anv(n, TENANT_A, analyteId, { version_no: 3, status: 'draft', result_type: 'numeric', unit_code: 'mmol_l', decimals: 3, method_id: null, effective_from: null, published_at: null, change_reason: null, ...o });
const JUN = '2026-06-01T00:00:00.000Z', SEP = '2026-09-01T00:00:00.000Z', OCT = '2026-10-01T00:00:00.000Z';

export const LHB = ana(50, TENANT_A, LAB.test.id, { code: 'LHB', name: 'Haemoglobin (lab)', print_name: 'Haemoglobin', report_subheading: 'RBC parameters', sort_order: 10 });
export const LNEW = ana(51, TENANT_A, LAB.test.id, { code: 'LNEW', name: 'New analyte', sort_order: 20 });
export const LORD = ana(52, TENANT_A, LAB.test.id, { code: 'LORD', name: 'Ordinal analyte', sort_order: 30 });
export const LTEN = ana(53, TENANT_A, LAB.test.id, { code: 'LTEN', name: 'Tenant-set ordinal', sort_order: 35 });
export const LFRM = ana(54, TENANT_A, LAB.test.id, { code: 'LFRM', name: 'Formula analyte', sort_order: 40 });
export const LHID = ana(55, TENANT_A, LAB.test.id, { code: 'LHID', name: 'Hidden text analyte', sort_order: 50, is_reportable: false });
const ordV = { result_type: 'ordinal', unit_code: null, decimals: null, method_id: null };
const LAB_VERSIONS: Row[] = [
  av(50, TENANT_A, LHB.id, { version_no: 1, status: 'superseded', decimals: 1, method_id: M1.id, effective_to: D(JUN) }),
  av(51, TENANT_A, LHB.id, { version_no: 2, decimals: 2, method_id: M2.id, effective_from: D(JUN), published_at: D(JUN) }),
  draftV(52, LHB.id),
  av(53, TENANT_A, LNEW.id, { effective_from: D(SEP), published_at: D(SEP) }),
  av(54, TENANT_A, LORD.id, { ...ordV, value_set_code: 'LAB_SEMIQ' }),
  av(55, TENANT_A, LTEN.id, { ...ordV, value_set_code: 'LAB_TEN' }),
  av(56, TENANT_A, LFRM.id, { decimals: 2, formula_expression: 'LHB / 10', formula_inputs: ['LHB'], formula_input_units: { LHB: 'g_dl' } }),
  av(57, TENANT_A, LHID.id, { result_type: 'text', unit_code: null, decimals: null }),
];
const gv = (n: number, set: string, code: string, sort: number, o: Row = {}): Row => ({ id: ID(0xc100 + n), value_set_code: set, code, display: o['display'] ?? code, sort_order: sort, ...o });
const cv = (n: number, tenant: string, setId: string, code: string, sort: number, o: Row = {}): Row => ({ id: ID(0xc200 + n), tenant_id: tenant, value_set_id: setId, code, display: o['display'] ?? code, sort_order: sort, ...o });
const CS_A = ID(0xc001), CS_B = ID(0xc002);
export const VALUE_SETS: Rows = {
  g_value_sets: [{ id: ID(0xc010), code: 'LAB_SEMIQ', display: 'Lab semi-quantitative', is_ordered: true }, { id: ID(0xc011), code: 'LAB_TEN', display: 'Global LAB_TEN (shadowed)', is_ordered: true }],
  g_value_set_values: [
    gv(1, 'LAB_SEMIQ', '2+', 3, { display: 'Two plus' }), gv(2, 'LAB_SEMIQ', 'NEG', 1, { display: 'Negative' }), gv(3, 'LAB_SEMIQ', '1+', 2, { display: 'One plus' }), gv(4, 'LAB_SEMIQ', 'OLD', 4, { is_active: false }),
    gv(5, 'LAB_TEN', 'GLOBAL_ONLY', 1), gv(6, 'OTHER_SET', 'FOREIGN', 1),
  ],
  cs_value_sets: [{ id: CS_A, tenant_id: TENANT_A, code: 'LAB_TEN', display: 'Tenant A LAB_TEN', is_ordered: true }, { id: CS_B, tenant_id: TENANT_B, code: 'LAB_TEN', display: 'Tenant B LAB_TEN', is_ordered: true }],
  cs_value_set_values: [cv(1, TENANT_A, CS_A, 'T2', 2, { display: 'Ten two' }), cv(2, TENANT_A, CS_A, 'T1', 1, { display: 'Ten one' }), cv(3, TENANT_A, CS_A, 'T0', 0, { is_active: false }), cv(4, TENANT_B, CS_B, 'B1', 1)],
};
const tt = (n: number, p: string, secs: number, from: string, to: string | null): Row => tat(n, TENANT_A, LAB.test.id, { priority: p, segment: 'total', target_seconds: secs, effective_from: D(from), effective_to: to ? D(to) : null });
const TATS: Row[] = [tt(50, 'routine', 7200, T0, JUN), tt(51, 'routine', 14400, JUN, null), tt(52, 'urgent', 3600, T0, null)];

// ---- ranges. Every range analyte: version v1 (g_dl, no method) effective since T0, so each set's unit/method snapshot matches.
const ra = (n: number, tenant: string, testId: string, code: string): Row => ana(n, tenant, testId, { code, name: `Range analyte ${code}` });
export const RHB = ra(60, TENANT_A, RNG.test.id, 'RHB'), RUNK = ra(61, TENANT_A, RNG.test.id, 'RUNK'), RAGED = ra(62, TENANT_A, RNG.test.id, 'RAGED');
export const RSP = ra(63, TENANT_A, RNG.test.id, 'RSP'), RTXT = ra(64, TENANT_A, RNG.test.id, 'RTXT'), RFUT = ra(65, TENANT_A, RNG.test.id, 'RFUT');
export const RB = ra(70, TENANT_B, TEST_B.test.id, 'RB');
const age = (lowV: number | null, lowU: string | null, highV: number | null, highU: string | null) => ({ age_low_value: lowV, age_low_unit: lowU, age_high_value: highV, age_high_unit: highU });
const rsPub = (n: number, analyte: Row, o: Row = {}) => rset(n, analyte['tenant_id'], analyte['id'], o);
// RHB: v1 (superseded 2026-10-01) / v2 (published) / v3 draft. Bands: neonate [0 d, 30 d), adult [30 d, inf), v2 adds a female adult band.
export const RS1 = rsPub(60, RHB, { version_no: 1, status: 'superseded', effective_to: D(OCT) });
export const RS2 = rsPub(61, RHB, { version_no: 2, effective_from: D(OCT), published_at: D(OCT) });
export const RS3 = rsPub(62, RHB, { version_no: 3, status: 'draft', effective_from: null, published_at: null, change_reason: null });
export const B_NEO1 = rband(60, TENANT_A, RS1.id, { ...age(0, 'day', 30, 'day'), low: '14.0', high: '24.0' });
export const B_ADU1 = rband(61, TENANT_A, RS1.id, { ...age(30, 'day', null, null), low: '12.0', high: '16.0' });
export const B_NEO2 = rband(62, TENANT_A, RS2.id, { ...age(0, 'day', 30, 'day'), low: '15.0', high: '25.0' });
export const B_ADU2 = rband(63, TENANT_A, RS2.id, { ...age(30, 'day', null, null), low: '12.0', high: '16.0' });
export const B_FEM2 = rband(64, TENANT_A, RS2.id, { sex: 'female', ...age(30, 'day', null, null), low: '11.5', high: '15.5' });
export const B_DRAFT = rband(65, TENANT_A, RS3.id, { low: '99.0', high: '100.0' });                          // draft, age-unrestricted: must never be returned
// RUNK: an age-unrestricted band (sort 200) beside an open-ended adult band (sort 50) and a neonate band (sort 100).
export const RS_UNK = rsPub(63, RUNK);
export const B_UNR = rband(66, TENANT_A, RS_UNK.id, { sort_order: 200, low: '11.0', high: '17.0' });
export const B_UNK_NEO = rband(67, TENANT_A, RS_UNK.id, { sort_order: 100, ...age(0, 'day', 30, 'day'), low: '14.0', high: '24.0' });
export const B_UNK_ADU = rband(68, TENANT_A, RS_UNK.id, { sort_order: 50, ...age(18, 'year', null, null), low: '12.0', high: '16.0' });
// RAGED: every band carries an age bound (incl. the open-ended one); same for its critical set.
export const RS_AGED = rsPub(64, RAGED);
export const B_AGED_NEO = rband(69, TENANT_A, RS_AGED.id, { ...age(0, 'day', 30, 'day'), low: '14.0', high: '24.0' });
export const B_AGED_ADU = rband(70, TENANT_A, RS_AGED.id, { ...age(30, 'day', null, null), low: '12.0', high: '16.0' });
export const CS_AGED = cset(62, TENANT_A, RAGED.id, { version_no: 1 });
export const CB_AGED = cband(62, TENANT_A, CS_AGED.id, { ...age(1, 'year', null, null), low: '1.0', high: '9.0' });
// RSP: a generic band and a SERUM-specific one.
export const RS_SP = rsPub(65, RSP);
export const B_GEN = rband(71, TENANT_A, RS_SP.id, { low: '1.0', high: '2.0' });
export const B_SERUM = rband(72, TENANT_A, RS_SP.id, { specimen_type_id: SERUM.id, low: '3.0', high: '4.0' });
// RFUT: the only set starts in 2027.
export const RS_FUT = rsPub(66, RFUT, { effective_from: D('2027-01-01T00:00:00.000Z'), published_at: D('2027-01-01T00:00:00.000Z') });
export const B_FUT = rband(73, TENANT_A, RS_FUT.id, { low: '1.0', high: '2.0' });
// RHB critical: one all-ages band. RTXT: no sets at all.
export const CS_HB = cset(60, TENANT_A, RHB.id, { version_no: 1 });
export const CB_HB = cband(60, TENANT_A, CS_HB.id, { low: '5.0', high: '22.0' });
// tenant B
export const RS_B = rset(70, TENANT_B, RB.id, { version_no: 1 });
export const B_B = rband(80, TENANT_B, RS_B.id, { low: '1.0', high: '2.0' });

const RANGE_ANALYTES = [RHB, RUNK, RAGED, RSP, RTXT, RFUT, RB];
export const BASE: Rows = {
  orderables: [...TESTS.map((t) => t.orderable), TEST_B.orderable, ...PANELS.map((p) => p.orderable), PANEL_B.orderable],
  tests: [...TESTS.map((t) => t.test), TEST_B.test], panels: [...PANELS.map((p) => p.panel), PANEL_B.panel], panel_members: MEMBERS, test_specimen_types: SPECIMENS,
  analytes: [LHB, LNEW, LORD, LTEN, LFRM, LHID, ...RANGE_ANALYTES],
  analyte_versions: [...LAB_VERSIONS, ...RANGE_ANALYTES.map((a, i) => av(60 + i, a['tenant_id'], a['id'], a['code'] === 'RTXT' ? { result_type: 'text', unit_code: null, decimals: null } : {}))],
  reference_range_sets: [RS1, RS2, RS3, RS_UNK, RS_AGED, RS_SP, RS_FUT, RS_B], reference_ranges: [B_NEO1, B_ADU1, B_NEO2, B_ADU2, B_FEM2, B_DRAFT, B_UNR, B_UNK_NEO, B_UNK_ADU, B_AGED_NEO, B_AGED_ADU, B_GEN, B_SERUM, B_FUT, B_B],
  critical_limit_sets: [CS_HB, CS_AGED], critical_limits: [CB_HB, CB_AGED], tat_targets: TATS, ...VALUE_SETS,
};

export const seedAB = { state: { [TENANT_A]: { rootId: ROOT_A, revision: REV }, [TENANT_B]: { rootId: ROOT_B, revision: REV } } };
const merge = (a: Rows, b: Rows): Rows => Object.fromEntries((Object.keys({ ...a, ...b }) as T6Table[]).map((k) => [k, [...(a[k] ?? []), ...(b[k] ?? [])]]));

export interface Setup28a { extra?: Rows; base?: boolean; maxEntries?: number; ttlSeconds?: number }
/** World above (`extra` rows ADD to / override by id; `base: false` starts empty). One cache + one port per env, shared by every `call`. */
export function setup28a(s: Setup28a = {}) {
  const db = makeTestsDb({
    rows: { departments: [HAEM, BIOC, HAEM_B], specimen_types: [EDTA, SERUM, EDTA_B, FLP], containers: [LAV, LAV_B, GRY], methods: [M1, M2] },
    t6: merge(s.base === false ? {} : BASE, s.extra ?? {}), catalog: seedAB,
  });
  const cache = createCatalogCache({ maxEntries: s.maxEntries ?? 50_000, ttlSeconds: s.ttlSeconds ?? 600 });
  const port = createCatalogPort({ cache }) as Record<string, (ctx: any, input?: any) => Promise<any>>;
  return { db, cache, port };
}
export type Env28a = ReturnType<typeof setup28a>;

/** One request (= one ctx = one tx) against the port. */
export const call = <R>(env: Env28a, fn: (port: Env28a['port'], ctx: any) => Promise<R>, o: { tenantId?: string; ctx?: Record<string, unknown> } = {}): Promise<R> =>
  env.db.run((ctx) => fn(env.port, ctx), o);
/** Single port call as tenant A (default) or B. */
export const one = (env: Env28a, method: string, input: unknown, o: { tenantId?: string; ctx?: Record<string, unknown> } = {}): Promise<any> => call(env, (p, ctx) => p[method]!(ctx, input), o);
export const inB = { tenantId: TENANT_B };

/** Rejection code of a LimsError (asserts the rejection IS a LimsError). */
export async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try { await p; return undefined; } catch (e: any) { if (!isLimsError(e)) throw e; return e.code; }
}
/** Statements issued by `fn` (exclusive of earlier traffic). */
export async function stmtsOf(env: Env28a, fn: () => Promise<unknown>) {
  const from = env.db.stmts.length;
  await fn();
  return env.db.stmts.slice(from);
}
/** Statements that read the tenant's revision. */
export const isRevisionRead = (text: string) => /FROM\s+catalog\.catalog_state/i.test(text);

/** Commits an edit + a revision bump (what any C3 write does): renames the orderable and bumps catalog_revision, stamping the orderable. */
export async function bumpAndRename(env: Env28a, orderableId: string, name: string): Promise<void> {
  const rev = createRevisionService({ events: createEvents({ producer: 'catalog' } as never) } as never);
  await env.db.run(async (ctx) => {
    await ctx.tx.query('UPDATE catalog.orderables SET name = $1 WHERE id = $2', [name, orderableId]);
    await rev.bumpRevision(ctx as never, { entityType: 'test', entityId: orderableId, changeKind: 'updated', effectiveFrom: NOW });
  });
}

/** All object keys of a value, recursively (for the "no snake_case / no internals" checks). */
export function keysOf(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); keysOf(x, out); }
  return out;
}
export const idsOf = (...ts: Array<{ test: { id: string } }>) => ts.map((t) => t.test.id);
