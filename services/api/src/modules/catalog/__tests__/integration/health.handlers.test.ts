// T-30 (C3) — `getCatalogRevision` (#1) and `getCatalogHealthReport` (#4): real handlers over tenant data, validated against catalog.yaml.
// Spec: 06-PLAN T-30 ("lists computed from tenant data with `truncated` flag"; PRD §7 metric `no_price` / `no_reference_range` = 0 at go-live);
//   02-TRD §5 rows 1 and 4 (GET, catalog.test.read, no idempotency); PRD AC-02.4, AC-02.5 (tests_missing_required_analyte); 03-APP-FLOW E12 (unmapped_formula_inputs), F-21, R7 (tax default);
//   07-SECURITY REQ-SEC-024 (explicit tenant_id predicate), REQ-SEC-040/044 (cross-tenant probes). CatalogHealthReport carries ONE top-level `truncated` (catalog.yaml), each list <= 200.
// Harness: handler driven with a request-shaped object + the HandlerContext subset of the composite fake (helpers/healthDb.ts). Auth / x-permission are the core pipeline's and are only DECLARED here.
// ASSUMED (spec silent; the writer may ask the arbiter, the tests state them): see .orchestra/notes/C3.T-30-tests.md.
//   - "active orderable" = orderables.is_active (tests AND panels); "default price" = an item in a `published` version of the tenant's `owner_kind='default'` list (draft / superseded versions and other lists do not count).
//   - tests_without_specimen_type = ACTIVE tests with no test_specimen_types row.  analytes_without_reference_range = ACTIVE analytes whose published version is `numeric` and that have no `published` reference_range_set
//     (narrative / attachment analytes never carry ranges and are not listed).  tax_default_configured = a tenant_default tax rule effective at now (effective_from <= now < effective_to).
//   - unmapped_formula_inputs = distinct codes in `formula_inputs` of PUBLISHED analyte versions that match no ACTIVE analyte of the tenant, ascending.
//   - #1 for a tenant without a catalog_state row answers 200 {0, 0} and does not create the row (lazy creation belongs to bumpRevision).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { REPO_ROOT, loadSpec, operationIds } from '../../../../core/module.js';
import { handlers } from '../../handlers/index.js';
import { manifest } from '../../index.js';
import {
  ROOT_A, ROOT_B, TENANT_A, TENANT_B, TENANT_NEW, TEST_READ, actorIdentity, ana, anv, defaultList, dept, makeHealthDb, pitem, plist, pnl, pver, rset, spec, trule, tsr, tst,
  type HealthSeed,
} from '../helpers/healthDb.js';

const T = 30_000;
const spec_: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/catalog.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true, formats: { email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/ } });
const validatorFor = (name: string) => {
  const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec_.components });
  return (x: unknown) => { const ok = v(x); return ok ? [] : (v.errors as any[]).map((e) => `${e.instancePath} ${e.message}`); };
};
const opOf = (id: string): any => { for (const p of Object.values<any>(spec_.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };
const H = handlers as Record<string, (req: any, ctx: any) => Promise<{ status: number; body?: any }>>;
const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, got success'); };
const req = () => ({ params: {}, query: {}, headers: {}, body: undefined });
const at = new Date(Date.UTC(2026, 10, 7, 12, 0, 0));
const A = TENANT_A; const B = TENANT_B;
const T0 = new Date(Date.UTC(2026, 0, 1)); const T1 = new Date(Date.UTC(2026, 5, 1));
const asc = (xs: readonly string[]) => [...xs].sort();

// ------------------------------------------------------------------------------------------------ the tenant-A world
const D1 = dept(1, A); const S1 = spec(1, A, { code: 'EDTA_WB' });
const t = (n: number, o: Record<string, unknown> = {}) => tst(n, A, D1.id as string, o);
const CBC = t(1, { code: 'CBC' }); const FBS = t(2, { code: 'FBS' }); const OLD = t(3, { code: 'OLD', is_active: false });
const MICRO = t(4, { code: 'MICRO', workflow_type: 'microbiology' }); const NARR = t(5, { code: 'NARR', workflow_type: 'narrative' });
const MOL = t(6, { code: 'MOL', workflow_type: 'molecular' }); const ATT = t(7, { code: 'ATT', workflow_type: 'attachment' });
const ATT2 = t(8, { code: 'ATT2', workflow_type: 'attachment' }); const STD0 = t(9, { code: 'STD0' });
const OLDM = t(10, { code: 'OLDM', workflow_type: 'microbiology', is_active: false });
const P1 = pnl(1, A, { code: 'PNL1' }); const P2 = pnl(2, A, { code: 'PNL2' });
const id = (x: { orderable: Record<string, unknown> }) => x.orderable['id'] as string;
const ALL_T = [CBC, FBS, OLD, MICRO, NARR, MOL, ATT, ATT2, STD0, OLDM];

const HB = ana(1, A, id(CBC), { code: 'HB' }); const K = ana(2, A, id(CBC), { code: 'K' }); const GLU = ana(3, A, id(FBS), { code: 'GLU' });
const NARRA = ana(4, A, id(NARR), { code: 'NARRA' }); const MOLN = ana(5, A, id(MOL), { code: 'MOLN' }); const ATTA = ana(6, A, id(ATT2), { code: 'ATTA' });
const RATIO = ana(7, A, id(CBC), { code: 'RATIO' }); const OLDIN = ana(8, A, id(CBC), { code: 'OLDIN', is_active: false });
const NOPUB = { effective_from: null, published_at: null };
const versions = [
  anv(1, A, HB.id as string), anv(2, A, K.id as string), anv(3, A, GLU.id as string),
  anv(4, A, NARRA.id as string, { result_type: 'narrative', decimals: null }),
  anv(5, A, MOLN.id as string, { result_type: 'narrative', decimals: null, status: 'draft', ...NOPUB }),   // draft only: not "published"
  anv(6, A, ATTA.id as string, { result_type: 'attachment', decimals: null }),
  anv(7, A, RATIO.id as string, { formula_expression: 'HB / GHOST + OLDIN', formula_inputs: ['HB', 'GHOST', 'OLDIN'] }),
  anv(8, A, OLDIN.id as string),
  anv(9, A, RATIO.id as string, { version_no: 2, status: 'draft', formula_expression: 'DRAFTGHOST', formula_inputs: ['DRAFTGHOST'], ...NOPUB }),   // a draft's inputs are not reported
];
const sets = [rset(1, A, HB.id as string), rset(2, A, K.id as string, { status: 'draft', ...NOPUB }), rset(3, A, RATIO.id as string)];
const edge = (v: number, from: Record<string, unknown>, to: Record<string, unknown>) => ({ tenant_id: A, analyte_version_id: versions[v]!['id'], analyte_id: from['id'], input_analyte_id: to['id'], created_by: 'x' });

const DEF = defaultList(1, A); const CP = plist(2, A);
const V1 = pver(1, A, DEF.id as string, 1, { status: 'superseded', effective_from: T0, effective_to: T1 });
const V2 = pver(2, A, DEF.id as string, 2, { status: 'published', effective_from: T1 });
const V3 = pver(3, A, DEF.id as string, 3, { status: 'draft' });
const VCP = pver(4, A, CP.id as string, 1, { status: 'published' });
const PRICED = [CBC, MICRO, NARR, MOL, ATT, ATT2, STD0, P1];
const items = [
  ...PRICED.map((o, i) => pitem(i + 1, A, V2.id as string, id(o), 90_000 + i)),
  pitem(20, A, V1.id as string, id(FBS), 80_000),   // superseded version: FBS still has no current default price
  pitem(21, A, V3.id as string, id(P2), 70_000),    // draft version: P2 still has no current default price
  pitem(22, A, VCP.id as string, id(FBS), 60_000),  // another list: not the default
];
const SPECCED = [CBC, MICRO, NARR, MOL, ATT, ATT2, STD0];

// tenant B: one unpriced, unspecified test + its own default list and rule-less tax
const DB_ = dept(2, B); const TB = tst(70, B, DB_.id as string, { code: 'CBC' }); const DEFB = defaultList(3, B); const VB = pver(5, B, DEFB.id as string, 1, { status: 'published' });

const world = (o: { tax?: Record<string, unknown>[]; extra?: HealthSeed['t6']; state?: HealthSeed['state'] } = {}): HealthSeed => ({
  masters: { departments: [D1, DB_], specimen_types: [S1] },
  t6: {
    orderables: [...ALL_T.map((x) => x.orderable), P1.orderable, P2.orderable, TB.orderable, ...(o.extra?.orderables ?? [])],
    tests: [...ALL_T.map((x) => x.test), TB.test, ...(o.extra?.tests ?? [])],
    panels: [P1.panel, P2.panel],
    test_specimen_types: [...SPECCED.map((x) => tsr(id(x), S1.id as string, A, { is_preferred: true })), ...(o.extra?.test_specimen_types ?? [])],
    analytes: [HB, K, GLU, NARRA, MOLN, ATTA, RATIO, OLDIN],
    analyte_versions: versions,
    reference_range_sets: sets,
    formula_dependencies: [edge(6, RATIO, HB), edge(6, RATIO, OLDIN)],
  },
  price: { price_lists: [DEF, CP, DEFB], price_list_versions: [V1, V2, V3, VCP, VB], price_list_items: items },
  tax: { tax_rules: o.tax ?? [trule(1, A)] },
  ...(o.state ? { state: o.state } : {}),
});

const call = (db: ReturnType<typeof makeHealthDb>, op: string, perms: readonly string[] = [TEST_READ], tenantId: string = A) =>
  db.run((ctx) => H[op]!(req(), ctx), { tenantId, at, ctx: { ports: { IdentityPort: actorIdentity(perms) } } });
const report = async (seed: HealthSeed = world(), tenantId: string = A) => { const r = await call(makeHealthDb(seed), 'getCatalogHealthReport', [TEST_READ], tenantId); expect(r.status).toBe(200); return r.body; };

describe('world fixture self-check (single-table SQL only; independent of the handlers)', () => {
  it('every table the report reads is seeded and visible to tenant A only', { timeout: T }, async () => {
    const q = (ctx: any, sql: string, v: unknown[] = [A]) => ctx.tx.query(sql, v).then((r: any) => r.rows as any[]);
    const out = await makeHealthDb(world()).run(async (ctx) => ({
      orderables: (await q(ctx, 'SELECT id FROM catalog.orderables WHERE tenant_id = $1')).length,
      tests: (await q(ctx, 'SELECT id FROM catalog.tests WHERE tenant_id = $1')).length,
      tsr: (await q(ctx, 'SELECT test_id FROM catalog.test_specimen_types WHERE tenant_id = $1')).length,
      analytes: (await q(ctx, 'SELECT id FROM catalog.analytes WHERE tenant_id = $1')).length,
      versions: (await q(ctx, 'SELECT id, formula_inputs FROM catalog.analyte_versions WHERE tenant_id = $1 AND status = $2', [A, 'published'])).length,
      sets: (await q(ctx, 'SELECT analyte_id FROM catalog.reference_range_sets WHERE tenant_id = $1 AND status = $2', [A, 'published'])).length,
      lists: (await q(ctx, 'SELECT id FROM catalog.price_lists WHERE tenant_id = $1')).length,
      versionsP: (await q(ctx, 'SELECT id FROM catalog.price_list_versions WHERE tenant_id = $1 AND status = $2', [A, 'published'])).length,
      items: (await q(ctx, 'SELECT orderable_id FROM catalog.price_list_items WHERE tenant_id = $1')).length,
      rules: (await q(ctx, 'SELECT id FROM catalog.tax_rules WHERE tenant_id = $1')).length,
    }));
    expect(out).toEqual({ orderables: 12, tests: 10, tsr: 7, analytes: 8, versions: 7, sets: 2, lists: 2, versionsP: 2, items: 11, rules: 1 });
  });
});

// ------------------------------------------------------------------------------------------------ contract + probes
describe('#1 and #4 in the contract and the manifest', () => {
  it.each(['getCatalogRevision', 'getCatalogHealthReport'])('%s: GET, catalog.test.read, no idempotency, served by the real handler (not the stub)', (op) => {
    expect(operationIds(spec_)).toContain(op);
    expect(opOf(op)['x-permission']).toBe('catalog.test.read');
    expect(opOf(op)['x-idempotency']).toBe('none');
    expect(typeof (manifest.handlers as any)[op]).toBe('function');
    expect((manifest.handlers as any)[op]).toBe(H[op]);
  });
  it('CatalogHealthReport is closed, carries ids / codes only, each list <= 200 and one top-level truncated', () => {
    const s = spec_.components.schemas['CatalogHealthReport'];
    expect(s.additionalProperties).toBe(false);
    expect(Object.keys(s.properties).sort()).toEqual(['active_orderables_without_default_price', 'analytes_without_reference_range', 'tax_default_configured', 'tests_missing_required_analyte',
      'tests_without_specimen_type', 'truncated', 'unmapped_formula_inputs']);
    for (const k of Object.keys(s.properties).filter((x) => s.properties[x].type === 'array')) expect(s.properties[k].maxItems, k).toBe(200);
  });
});

describe('probes (CR-C3-008): the #1 / #4 stubs are gone', () => {
  const pending: string[] = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'probes', 'pending.json'), 'utf8'));
  it.each(['getCatalogRevision', 'getCatalogHealthReport'])('%s is no longer listed in probes/pending.json', (op) => {
    expect(pending).not.toContain(op);
  });
  it.each(['getCatalogRevision', 'getCatalogHealthReport'])('%s does not answer 503 common.service_unavailable / not_implemented', { timeout: T }, async (op) => {
    const e = await call(makeHealthDb(world()), op).then(() => undefined, (x) => x);
    expect(e?.code).not.toBe('common.service_unavailable');
    expect(e?.detail).not.toBe('not_implemented');
  });
});

// ------------------------------------------------------------------------------------------------ #1
describe('GET /v1/catalog/revision (#1)', () => {
  const ok = validatorFor('CatalogRevision');
  it('200 {catalog_revision, global_release_seen} as JSON numbers, schema-valid, from the caller tenant row (417 / 3); read-only', { timeout: T }, async () => {
    const db = makeHealthDb(world());
    const r = await call(db, 'getCatalogRevision');
    expect(r.status).toBe(200); expect(ok(r.body)).toEqual([]);
    expect(r.body).toEqual({ catalog_revision: 417, global_release_seen: 3 });
    expect(typeof r.body.catalog_revision).toBe('number');   // pg returns bigint as a string
    expect(db.writes).toEqual([]); expect(db.price.events).toHaveLength(0); expect(db.revisionOf(A)).toBe(417);
  });
  it('is tenant-scoped: tenant B reads its own 9 / 1, never A\'s', { timeout: T }, async () => {
    const r = await call(makeHealthDb(world()), 'getCatalogRevision', [TEST_READ], B);
    expect(r.body).toEqual({ catalog_revision: 9, global_release_seen: 1 });
  });
  it('a tenant that never wrote answers 200 {0, 0} and the read does not create its catalog_state row', { timeout: T }, async () => {
    const db = makeHealthDb(world());
    const r = await call(db, 'getCatalogRevision', [TEST_READ], TENANT_NEW);
    expect(r.status).toBe(200); expect(ok(r.body)).toEqual([]);
    expect(r.body).toEqual({ catalog_revision: 0, global_release_seen: 0 });
    expect(db.writes).toEqual([]);
  });
  it('fails closed without an authenticated request context', { timeout: T }, async () => {
    const e = await rejection(H['getCatalogRevision']!(req(), { operationId: 'getCatalogRevision', log: { info() {}, warn() {}, error() {} } }));
    expect(isLimsError(e, 'auth.unauthenticated')).toBe(true);
  });
  it('the statement filters on tenant_id with the caller tenant bound (REQ-SEC-024)', { timeout: T }, async () => {
    const db = makeHealthDb(world());
    await call(db, 'getCatalogRevision');
    const mine = db.stmts.filter((x) => /catalog\.catalog_state/i.test(x.text));
    expect(mine.length).toBeGreaterThan(0);
    for (const x of mine) { expect(/^\s*SELECT\b/i.test(x.text), x.text).toBe(true); expect(/\btenant_id\b/i.test(x.text), x.text).toBe(true); expect(x.values).toContain(A); expect(x.text).not.toContain(A); }
  });
});

// ------------------------------------------------------------------------------------------------ #4
describe('GET /v1/catalog/health-report (#4) — lists computed from tenant data', () => {
  const ok = validatorFor('CatalogHealthReport');
  it('200, schema-valid; every list has exactly the expected members and truncated is false', { timeout: T }, async () => {
    const b = await report();
    expect(ok(b)).toEqual([]);
    expect(asc(b.active_orderables_without_default_price)).toEqual(asc([id(FBS), id(P2)]));
    expect(asc(b.tests_without_specimen_type)).toEqual([id(FBS)]);
    expect(asc(b.analytes_without_reference_range)).toEqual(asc([K.id as string, GLU.id as string]));
    expect(asc(b.tests_missing_required_analyte)).toEqual(asc([id(MICRO), id(MOL), id(ATT)]));
    expect(b.unmapped_formula_inputs).toEqual(['GHOST', 'OLDIN']);
    expect(b.tax_default_configured).toBe(true);
    expect(b.truncated).toBe(false);
  });
  it('a fully configured tenant answers all-empty lists, tax configured, truncated false (PRD §7: 0 at go-live)', { timeout: T }, async () => {
    const clean = tst(50, A, D1.id as string, { code: 'CLEAN' });
    const ca = ana(50, A, id(clean), { code: 'CLEANA' });
    const b = await report({
      masters: { departments: [D1], specimen_types: [S1] },
      t6: { orderables: [clean.orderable], tests: [clean.test], test_specimen_types: [tsr(id(clean), S1.id as string, A, { is_preferred: true })], analytes: [ca], analyte_versions: [anv(50, A, ca.id as string)], reference_range_sets: [rset(50, A, ca.id as string)] },
      price: { price_lists: [DEF], price_list_versions: [V2], price_list_items: [pitem(50, A, V2.id as string, id(clean), 100)] },
      tax: { tax_rules: [trule(1, A)] },
    });
    expect(b).toEqual({ active_orderables_without_default_price: [], analytes_without_reference_range: [], tests_without_specimen_type: [], tests_missing_required_analyte: [], tax_default_configured: true, unmapped_formula_inputs: [], truncated: false });
  });
  it('an empty tenant answers empty lists and tax_default_configured false (R7), not an error', { timeout: T }, async () => {
    const b = await report({ masters: {}, t6: {}, price: {}, tax: {} }, A);
    expect(ok(b)).toEqual([]);
    expect(b).toEqual({ active_orderables_without_default_price: [], analytes_without_reference_range: [], tests_without_specimen_type: [], tests_missing_required_analyte: [], tax_default_configured: false, unmapped_formula_inputs: [], truncated: false });
  });

  describe('active_orderables_without_default_price', () => {
    it('lists active tests AND panels with no item in a published version of the default list; inactive ones, draft / superseded versions and other lists do not count', { timeout: T }, async () => {
      const b = await report();
      const l = b.active_orderables_without_default_price as string[];
      expect(l).toContain(id(FBS));   // item only in a superseded version and in another list
      expect(l).toContain(id(P2));    // item only in a draft version
      for (const o of [OLD, OLDM]) expect(l, 'inactive').not.toContain(id(o));
      for (const o of PRICED) expect(l, 'priced').not.toContain(id(o));
    });
    it('without any default list every active orderable is listed', { timeout: T }, async () => {
      const w = world(); w.price = { ...w.price!, price_lists: [CP], price_list_versions: [VCP], price_list_items: [pitem(22, A, VCP.id as string, id(FBS), 60_000)] };
      const b = await report(w);
      expect(asc(b.active_orderables_without_default_price)).toEqual(asc([...ALL_T.filter((x) => x !== OLD && x !== OLDM).map(id), id(P1), id(P2)]));
    });
  });

  describe('analytes_without_reference_range', () => {
    it('lists active numeric analytes with no PUBLISHED set (none at all, or only a draft); an inactive analyte and narrative / attachment analytes are not listed', { timeout: T }, async () => {
      const l = (await report()).analytes_without_reference_range as string[];
      expect(l).toContain(GLU.id); expect(l).toContain(K.id);
      for (const a of [HB, RATIO]) expect(l, `${a.code}`).not.toContain(a.id);        // published set
      expect(l, 'inactive').not.toContain(OLDIN.id);
      for (const a of [NARRA, MOLN, ATTA]) expect(l, `${a.code}`).not.toContain(a.id);
    });
  });

  describe('tests_without_specimen_type', () => {
    it('lists active tests with no specimen requirement; inactive tests and panels are not listed', { timeout: T }, async () => {
      const l = (await report()).tests_without_specimen_type as string[];
      expect(l).toContain(id(FBS));
      for (const o of [OLD, OLDM, P1, P2]) expect(l).not.toContain(id(o));
    });
  });

  describe('tests_missing_required_analyte (AC-02.4, AC-02.5)', () => {
    it('lists narrative-family tests without a PUBLISHED narrative analyte and attachment tests without a published attachment analyte', { timeout: T }, async () => {
      const l = (await report()).tests_missing_required_analyte as string[];
      expect(l).toContain(id(MICRO));   // microbiology, no analyte
      expect(l).toContain(id(MOL));     // molecular, narrative analyte only as a draft version
      expect(l).toContain(id(ATT));     // attachment, no attachment analyte
    });
    it('does not list satisfied tests, standard tests (even without analytes) or inactive tests', { timeout: T }, async () => {
      const l = (await report()).tests_missing_required_analyte as string[];
      for (const o of [NARR, ATT2, STD0, CBC, FBS, OLDM, OLD]) expect(l).not.toContain(id(o));
    });
    it('publishing the missing narrative analyte removes the test from the list', { timeout: T }, async () => {
      const w = world(); const micro = ana(60, A, id(MICRO), { code: 'MICROA' });
      w.t6!.analytes = [...w.t6!.analytes!, micro]; w.t6!.analyte_versions = [...w.t6!.analyte_versions!, anv(60, A, micro.id as string, { result_type: 'narrative', decimals: null })];
      expect((await report(w)).tests_missing_required_analyte).not.toContain(id(MICRO));
    });
  });

  describe('unmapped_formula_inputs (E12)', () => {
    it('lists codes of published formula inputs that match no active analyte (never existed, or deactivated), distinct and ascending; draft versions are ignored', { timeout: T }, async () => {
      const b = await report();
      expect(b.unmapped_formula_inputs).toEqual(['GHOST', 'OLDIN']);
      expect(b.unmapped_formula_inputs).not.toContain('HB');
      expect(b.unmapped_formula_inputs).not.toContain('DRAFTGHOST');
      for (const c of b.unmapped_formula_inputs) expect(c).toMatch(/^[A-Z][A-Z0-9_]{0,31}$/);
    });
    it('the same missing input used by two formulas is listed once', { timeout: T }, async () => {
      const w = world(); const r2 = ana(61, A, id(CBC), { code: 'RATIO2' });
      w.t6!.analytes = [...w.t6!.analytes!, r2];
      w.t6!.analyte_versions = [...w.t6!.analyte_versions!, anv(61, A, r2.id as string, { formula_expression: 'GHOST * 2', formula_inputs: ['GHOST'] })];
      w.t6!.reference_range_sets = [...w.t6!.reference_range_sets!, rset(61, A, r2.id as string)];
      expect((await report(w)).unmapped_formula_inputs).toEqual(['GHOST', 'OLDIN']);
    });
  });

  describe('tax_default_configured', () => {
    it.each([
      ['an open tenant_default rule effective since the past', [trule(1, A)], true],
      ['no rule at all', [], false],
      ['a tenant_default rule that ended before now', [trule(1, A, { effective_to: new Date(Date.UTC(2026, 5, 1)) })], false],
      ['a tenant_default rule that starts after now', [trule(1, A, { effective_from: new Date(Date.UTC(2027, 0, 1)) })], false],
      ['a rule of another tenant only', [trule(1, B)], false],
    ] as const)('%s', { timeout: T }, async (_n, rules, want) => {
      expect((await report(world({ tax: rules as never }))).tax_default_configured).toBe(want);
    });
  });

  describe('truncated (<= 200 ids per list)', () => {
    const bulk = (n: number, withSpecimen: boolean): HealthSeed => {
      const rows = Array.from({ length: n }, (_, i) => tst(200 + i, A, D1.id as string, { code: `BULK${200 + i}` }));
      return {
        masters: { departments: [D1], specimen_types: [S1] },
        t6: { orderables: rows.map((x) => x.orderable), tests: rows.map((x) => x.test), test_specimen_types: withSpecimen ? rows.map((x) => tsr(id(x), S1.id as string, A, { is_preferred: true })) : [] },
        price: { price_lists: [DEF], price_list_versions: [V2], price_list_items: [] },
        tax: { tax_rules: [trule(1, A)] },
      };
    };
    it('exactly 200 findings in a list: all 200 returned, truncated false', { timeout: T * 2 }, async () => {
      const b = await report(bulk(200, true));
      expect(b.active_orderables_without_default_price).toHaveLength(200);
      expect(new Set(b.active_orderables_without_default_price).size).toBe(200);
      expect(b.truncated).toBe(false);
    });
    it('201 findings: the list is cut to 200 distinct tenant ids and truncated is true; the other lists stay complete', { timeout: T * 2 }, async () => {
      const seed = bulk(201, true); const mine = new Set(seed.t6!.orderables!.map((o) => o['id'] as string));
      const b = await report(seed);
      expect(ok(b)).toEqual([]);
      expect(b.active_orderables_without_default_price).toHaveLength(200);
      expect(new Set(b.active_orderables_without_default_price).size).toBe(200);
      for (const x of b.active_orderables_without_default_price) expect(mine.has(x)).toBe(true);
      expect(b.tests_without_specimen_type).toEqual([]);
      expect(b.truncated).toBe(true);
    });
    it('truncation of ANY list sets the one flag (tests without specimen type)', { timeout: T * 2 }, async () => {
      const b = await report(bulk(205, false));
      expect(b.tests_without_specimen_type).toHaveLength(200);
      expect(b.active_orderables_without_default_price).toHaveLength(200);
      expect(b.truncated).toBe(true);
    });
  });

  describe('security', () => {
    it('cross-tenant: tenant A\'s report never contains tenant B\'s ids; B\'s own report lists only B\'s', { timeout: T }, async () => {
      const a = await report();
      expect(JSON.stringify(a)).not.toContain(id(TB));
      const b = await report(world(), B);
      expect(b.active_orderables_without_default_price).toEqual([id(TB)]);
      expect(b.tests_without_specimen_type).toEqual([id(TB)]);
      expect(b.tax_default_configured).toBe(false);   // A's rule is not B's
      expect(b.unmapped_formula_inputs).toEqual([]);  // A's formulas are not B's
      expect(b.analytes_without_reference_range).toEqual([]);
    });
    it('read-only: no INSERT / UPDATE / DELETE, no event, revision untouched', { timeout: T }, async () => {
      const db = makeHealthDb(world());
      await call(db, 'getCatalogHealthReport');
      expect(db.writes).toEqual([]); expect(db.price.events).toHaveLength(0); expect(db.revisionOf(A)).toBe(417);
    });
    it('every statement on a tenant table is a SELECT filtering on tenant_id with the caller tenant bound; ids / codes are binds, never SQL text (REQ-SEC-024)', { timeout: T }, async () => {
      const db = makeHealthDb(world());
      await call(db, 'getCatalogHealthReport');
      const tenantTables = /catalog\.(orderables|tests|panels|test_specimen_types|analytes|analyte_versions|reference_range_sets|price_lists|price_list_versions|price_list_items|tax_rules)\b/i;
      const mine = db.stmts.filter((x) => tenantTables.test(x.text));
      expect(mine.length).toBeGreaterThan(0);
      for (const x of mine) {
        expect(/^\s*SELECT\b/i.test(x.text), x.text).toBe(true);
        expect(/\btenant_id\b/i.test(x.text), x.text).toBe(true);
        expect(x.values, x.text).toContain(A);
        for (const lit of [A, B, id(FBS), String(DEF.id), 'GHOST']) expect(x.text, 'literal in SQL text').not.toContain(lit);
      }
    });
    it('fails closed without an authenticated request context', { timeout: T }, async () => {
      const e = await rejection(H['getCatalogHealthReport']!(req(), { operationId: 'getCatalogHealthReport', log: { info() {}, warn() {}, error() {} } }));
      expect(isLimsError(e, 'auth.unauthenticated')).toBe(true);
    });
    it('the response carries ids / codes only: no names, prices or tenant ids', { timeout: T }, async () => {
      const s = JSON.stringify(await report());
      for (const leak of [A, B, ROOT_A, ROOT_B, 'Synthetic', 'Test ', 'Analyte ', '90000']) expect(s, leak).not.toContain(leak);
    });
    it('20 concurrent reports in separate transactions agree', { timeout: T }, async () => {
      const db = makeHealthDb(world());
      const runs = await Promise.all(Array.from({ length: 20 }, () => call(db, 'getCatalogHealthReport').then((r) => r.body)));
      for (const r of runs) expect(r).toEqual(runs[0]);
    });
  });
});
