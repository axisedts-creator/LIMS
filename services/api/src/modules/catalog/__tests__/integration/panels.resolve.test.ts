// T-12 (C3) — resolveOrderablesPreview (#3): POST /v1/catalog/orderables/resolve, the port's ResolvedOrderables in snake_case.
// Spec: 02-TRD §5.2 #3 (409 catalog.test_inactive, 422 catalog.panel_cycle), §7.7 (depth-first expansion in sort_order, first occurrence wins, any inactive test/panel
//       reached -> catalog.test_inactive, specimen groups by the PREFERRED requirement sorted by specimen type code, tests without a requirement omitted from groups,
//       catalogRevision = the request's revision, defensive cycle check), 03-IC §4.2 ResolvedOrderables + contract tests (4) (5);
//       PRD AC-07.1, AC-07.2, AC-07.5 (resolve side); 07-SECURITY S-1. A read: no write, no event, no lock-taking UPDATE.
// Interface: helpers/t12.ts (SEAM header). Authoring notes in .orchestra/notes/T-12-tests.md.
import { describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_B } from '../helpers/catalogDb.js';
import { ana, anv } from '../helpers/testsDb.js';
import {
  A1C, ADDON, BASIC, CBC, DEAD, FBS, HDL, HP_ELITE_M, ID, LDL, LIPID, OLD, PANEL_B, SEED_REVISION, T, TC, TEST_B, TG,
  chainSeed, errPaths, lims, mem, pBody, pmb, pnl, rejection, setup12, validation400, type Env12,
} from '../helpers/t12.js';

const resolve = (env: Env12, ids: unknown, extra: Record<string, unknown> = {}) => env.db.run((ctx) => env.svc['resolveOrderablesPreview']!(ctx, { orderable_ids: ids, ...extra }));
const idsOf = (...ts: Array<{ test: { id: string } }>) => ts.map((t) => t.test.id);

describe('resolveOrderablesPreview (#3) — AC-07.1, AC-07.2', () => {
  it('AC-07.1: package HP_ELITE_M = {CBC, LIPID{TC,HDL,TG,LDL}, FBS} -> orderables[0].test_ids lists the 6 test ids, tests holds each once, specimen_requirements groups by (preferred specimen type, container)', { timeout: T }, async () => {
    const env = setup12();
    const r = await resolve(env, [HP_ELITE_M.panel.id]);
    const six = idsOf(CBC, TC, HDL, TG, LDL, FBS);
    expect(r.orderables).toEqual([{ orderable_id: HP_ELITE_M.panel.id, kind: 'panel', test_ids: six }]);
    expect(r.tests.map((t: any) => t.id)).toEqual(six);
    expect(r.specimen_requirements).toEqual([
      { specimen_type_code: 'EDTA_WB', container_code: 'LAV_TOP', test_ids: idsOf(CBC) },
      { specimen_type_code: 'FL_PLASMA', container_code: 'GREY_TOP', test_ids: idsOf(FBS) },
      { specimen_type_code: 'SERUM', test_ids: idsOf(TC, HDL, TG, LDL) },
    ]);
    expect(r.catalog_revision).toBe(SEED_REVISION);
  });

  it('the result has exactly the port keys in snake_case (no camelCase twins, no internals)', { timeout: T }, async () => {
    const r = await resolve(setup12(), [LIPID.panel.id]);
    expect(Object.keys(r).sort()).toEqual(['catalog_revision', 'orderables', 'specimen_requirements', 'tests']);
    expect(Object.keys(r.orderables[0]).sort()).toEqual(['kind', 'orderable_id', 'test_ids']);
    expect(JSON.stringify(r)).not.toMatch(/tenant_id|created_by|updated_by|specimenRequirements|catalogRevision|testIds/);
  });

  it('a TestDefinition carries id, code, name, department, specimen_type_codes, container_code, workflow_type, analytes, is_active, revision', { timeout: T }, async () => {
    const env = setup12();
    const r = await resolve(env, [CBC.test.id]);
    expect(r.orderables).toEqual([{ orderable_id: CBC.test.id, kind: 'test', test_ids: [CBC.test.id] }]);
    const t = r.tests[0];
    expect(t).toMatchObject({ id: CBC.test.id, code: 'CBC', name: 'Complete blood count', department_code: 'HAEM', container_code: 'LAV_TOP', workflow_type: 'standard', is_active: true, revision: 0 });
    expect(t.department_id).toBe(CBC.orderable.department_id);
    expect([...t.specimen_type_codes].sort()).toEqual(['EDTA_WB', 'SERUM']);
    expect(t.analytes).toHaveLength(1);
    expect(t.analytes[0]).toMatchObject({ code: 'HB', name: 'Hemoglobin', result_type: 'numeric', unit_code: 'g_dl', decimals: 1, reportable: true, sort_order: 10, report_subheading: 'RBC parameters' });
    for (const k of ['tenant_id', 'created_by', 'updated_by', 'version']) expect(t).not.toHaveProperty(k);
  });

  it('T-12-review item 3 (CR-C11-009): a uses_existing_material test is absent from specimen_requirements, has specimen_type_codes [] and uses_existing_material true; others say false', { timeout: T }, async () => {
    const r = await resolve(setup12(), [ADDON.test.id, TC.test.id]);
    const addon = r.tests.find((t: any) => t.id === ADDON.test.id), tc = r.tests.find((t: any) => t.id === TC.test.id);
    expect(addon).toMatchObject({ code: 'ADDON', specimen_type_codes: [], uses_existing_material: true });
    expect(tc.uses_existing_material).toBe(false);
    expect(r.specimen_requirements.flatMap((g: any) => g.test_ids)).not.toContain(ADDON.test.id);
  });

  it('T-12-review item 2 (03-IC §4.2 / 08 D-9): an analyte with an ordinal set returns ordinal_set_code AND exactly that set\'s ACTIVE values (code, display, sort_order) by sort_order asc; no ordinal set -> neither key', { timeout: T }, async () => {
    const hb = ana(40, TENANT_A, A1C.test.id, { code: 'UPROT', name: 'Urine protein', sort_order: 20 });
    const v = anv(40, TENANT_A, hb.id, { version_no: 1, status: 'published', result_type: 'ordinal', value_set_code: 'URINE_SEMIQ', effective_from: new Date('2026-01-01T00:00:00.000Z'), published_at: new Date('2026-01-01T00:00:00.000Z'), change_reason: 'initial' });
    const gv = (n: number, code: string, sort_order: number, o: Record<string, unknown> = {}) => ({ id: ID(0x7100 + n), value_set_code: 'URINE_SEMIQ', code, display: `Display ${code}`, sort_order, ...o });
    const env = setup12({ t6: {
      analytes: [hb], analyte_versions: [v],
      g_value_sets: [{ id: ID(0x7001), code: 'URINE_SEMIQ', display: 'Urine semi-quantitative', is_ordered: true }, { id: ID(0x7002), code: 'OTHER_SET', display: 'Other', is_ordered: true }],
      g_value_set_values: [gv(1, 'TRACE', 20), gv(2, 'NEG', 10), gv(3, 'GONE', 15, { is_active: false }), gv(4, 'POS3', 30), { ...gv(5, 'X', 5), value_set_code: 'OTHER_SET' }],
    } });
    const r = await resolve(env, [A1C.test.id, CBC.test.id]);
    const a = r.tests.find((t: any) => t.id === A1C.test.id).analytes.find((x: any) => x.code === 'UPROT');
    expect(a.ordinal_set_code).toBe('URINE_SEMIQ');
    expect(a.ordinal_set_values).toEqual([
      { code: 'NEG', display: 'Display NEG', sort_order: 10 }, { code: 'TRACE', display: 'Display TRACE', sort_order: 20 }, { code: 'POS3', display: 'Display POS3', sort_order: 30 },
    ]);
    const hbOut = r.tests.find((t: any) => t.id === CBC.test.id).analytes.find((x: any) => x.code === 'HB');
    expect(hbOut).not.toHaveProperty('ordinal_set_code'); expect(hbOut).not.toHaveProperty('ordinal_set_values');
  });

  it('AC-07.2 / contract (4): a test present in two ordered panels appears once in `tests`; each orderable still lists it in its own test_ids [ASSUMPTION: per-orderable lists are not globally de-duplicated]', { timeout: T }, async () => {
    const r = await resolve(setup12(), [BASIC.panel.id, HP_ELITE_M.panel.id]);          // CBC and FBS are in both
    expect(r.tests.filter((t: any) => t.id === CBC.test.id)).toHaveLength(1);
    expect(r.tests.filter((t: any) => t.id === FBS.test.id)).toHaveLength(1);
    expect(new Set(r.tests.map((t: any) => t.id)).size).toBe(r.tests.length);
    expect(r.tests.map((t: any) => t.id)).toEqual(idsOf(CBC, FBS, TC, HDL, TG, LDL));      // union in first-seen order
    expect(r.orderables.map((o: any) => o.orderable_id)).toEqual([BASIC.panel.id, HP_ELITE_M.panel.id]);
    expect(r.orderables[0].test_ids).toEqual(idsOf(CBC, FBS));
    expect(r.orderables[1].test_ids).toEqual(idsOf(CBC, TC, HDL, TG, LDL, FBS));
    const serum = r.specimen_requirements.find((g: any) => g.specimen_type_code === 'SERUM');
    expect(serum.test_ids).toEqual(idsOf(TC, HDL, TG, LDL));                              // a shared test is in one group only once
  });

  it('a test ordered directly AND inside a panel -> once in `tests`; the same id twice in the request does not fail', { timeout: T }, async () => {
    const r = await resolve(setup12(), [TC.test.id, LIPID.panel.id, TC.test.id]);
    expect(r.tests.map((t: any) => t.id)).toEqual(idsOf(TC, HDL, TG, LDL));
  });

  it('input order drives orderables[] and the first-seen order of tests; member sort_order drives the order inside a panel', { timeout: T }, async () => {
    const env = setup12({ t6: { panel_members: [] } });
    const rev = await resolve(env, [FBS.test.id, CBC.test.id]);
    expect(rev.orderables.map((o: any) => o.orderable_id)).toEqual(idsOf(FBS, CBC));
    expect(rev.tests.map((t: any) => t.id)).toEqual(idsOf(FBS, CBC));
    const p = pnl(90, TENANT_A, { code: 'SHUF' });
    const e2 = setup12({ t6: { orderables: [p.orderable], panels: [p.panel], panel_members: [pmb(p.panel.id, LDL.test.id, TENANT_A, 30), pmb(p.panel.id, TC.test.id, TENANT_A, 10), pmb(p.panel.id, TG.test.id, TENANT_A, 20)] } });
    expect((await resolve(e2, [p.panel.id])).orderables[0].test_ids).toEqual(idsOf(TC, TG, LDL));
  });

  it('nested panels expand depth-first at the position of the nested panel (first occurrence wins)', { timeout: T }, async () => {
    const outer = pnl(91, TENANT_A, { code: 'OUTER' });
    const env = setup12({ t6: { orderables: [outer.orderable], panels: [outer.panel], panel_members: [
      pmb(outer.panel.id, A1C.test.id, TENANT_A, 1), pmb(outer.panel.id, LIPID.panel.id, TENANT_A, 2), pmb(outer.panel.id, TC.test.id, TENANT_A, 3), pmb(outer.panel.id, FBS.test.id, TENANT_A, 4)] } });
    expect((await resolve(env, [outer.panel.id])).orderables[0].test_ids).toEqual(idsOf(A1C, TC, HDL, TG, LDL, FBS));
  });

  it('specimen groups use the PREFERRED requirement only; same specimen type with different containers are separate groups; a test with no requirement is in `tests` (specimen_type_codes []) but in no group', { timeout: T }, async () => {
    const r = await resolve(setup12(), [ADDON.test.id, CBC.test.id, A1C.test.id, TC.test.id]);
    expect(r.tests.find((t: any) => t.id === ADDON.test.id)).toMatchObject({ code: 'ADDON', specimen_type_codes: [] });
    expect(r.specimen_requirements.flatMap((g: any) => g.test_ids)).not.toContain(ADDON.test.id);
    expect(r.specimen_requirements).toEqual([
      { specimen_type_code: 'EDTA_WB', container_code: 'LAV_TOP', test_ids: idsOf(CBC, A1C) },       // CBC's non-preferred SERUM row does not create a SERUM group entry for CBC
      { specimen_type_code: 'SERUM', test_ids: idsOf(TC) },
    ]);
  });

  it('an empty panel resolves to no tests: orderables[0].test_ids [] and no groups', { timeout: T }, async () => {
    const e = pnl(92, TENANT_A, { code: 'EMPTYP' });
    const r = await resolve(setup12({ t6: { orderables: [e.orderable], panels: [e.panel] } }), [e.panel.id]);
    expect(r.orderables).toEqual([{ orderable_id: e.panel.id, kind: 'panel', test_ids: [] }]);
    expect(r.tests).toEqual([]); expect(r.specimen_requirements).toEqual([]);
  });

  it('as_of is accepted (ISO UTC, ms precision); a malformed one -> 400 /as_of', { timeout: T }, async () => {
    const env = setup12();
    expect((await resolve(env, [TC.test.id], { as_of: '2026-11-05T04:15:00.000Z' })).tests).toHaveLength(1);
    for (const as_of of ['2026-11-05', 'yesterday', '2026-11-05T04:15:00+05:45', 5, null]) {
      const e = await rejection(resolve(env, [TC.test.id], { as_of }));
      validation400(e);
      if (e.code === 'common.validation_failed') expect(errPaths(e)).toContain('/as_of');
    }
  });

  it('as_of before the first published analyte version -> the analyte has no result type from a version that did not exist yet (the test itself still resolves)', { timeout: T }, async () => {
    const r = await resolve(setup12(), [CBC.test.id], { as_of: '2025-06-01T00:00:00.000Z' });
    expect(r.tests[0].code).toBe('CBC');
    expect(r.tests[0].analytes.every((a: any) => a.result_type === undefined || a.code !== 'HB')).toBe(true);
  });
});

describe('resolveOrderablesPreview — AC-07.5 inactive, errors, S-1', () => {
  it('AC-07.5: a panel containing an inactive test -> 409 catalog.test_inactive', { timeout: T }, async () => {
    const p = pnl(93, TENANT_A, { code: 'HASOLD' });
    const env = setup12({ t6: { orderables: [p.orderable], panels: [p.panel], panel_members: [pmb(p.panel.id, TC.test.id, TENANT_A, 1), pmb(p.panel.id, OLD.test.id, TENANT_A, 2)] } });
    lims(await rejection(resolve(env, [p.panel.id])), 'catalog.test_inactive', 409);
  });
  it('an inactive test ordered directly, an inactive panel ordered directly, an inactive panel NESTED two levels down -> 409 catalog.test_inactive', { timeout: T }, async () => {
    const env = setup12();
    lims(await rejection(resolve(env, [OLD.test.id])), 'catalog.test_inactive', 409);
    lims(await rejection(resolve(env, [DEAD.panel.id])), 'catalog.test_inactive', 409);
    const top = pnl(94, TENANT_A, { code: 'TOPP' }), mid = pnl(95, TENANT_A, { code: 'MIDP' });
    const e2 = setup12({ t6: { orderables: [top.orderable, mid.orderable], panels: [top.panel, mid.panel], panel_members: [pmb(top.panel.id, mid.panel.id, TENANT_A, 1), pmb(mid.panel.id, DEAD.panel.id, TENANT_A, 1)] } });
    lims(await rejection(resolve(e2, [top.panel.id])), 'catalog.test_inactive', 409);
  });
  it('deactivating a contained panel via the service makes the containing package unresolvable (end to end with #55)', { timeout: T }, async () => {
    const env = setup12();
    await env.db.run((ctx) => env.svc['updatePanel']!(ctx, { id: LIPID.panel.id, expectedVersion: 1, patch: { is_active: false } }));
    lims(await rejection(resolve(env, [HP_ELITE_M.panel.id])), 'catalog.test_inactive', 409);
    expect((await resolve(env, [BASIC.panel.id])).tests).toHaveLength(2);                 // unrelated panels still resolve
  });
  it('one bad orderable fails the whole call (no partial result), and nothing is written', { timeout: T }, async () => {
    const env = setup12();
    lims(await rejection(resolve(env, [TC.test.id, OLD.test.id])), 'catalog.test_inactive', 409);
    expect(env.db.events).toHaveLength(0);
  });
  it.each([['unknown id', ID(0xdead)], ['test of tenant B', TEST_B.test.id], ['panel of tenant B', PANEL_B.panel.id]])('S-1: %s -> 404 common.not_found and no data of tenant B', { timeout: T }, async (_n, id) => {
    const env = setup12();
    const e = await rejection(resolve(env, [TC.test.id, id]));
    lims(e, 'common.not_found', 404);
    expect(JSON.stringify({ m: e.message, d: e.detail, errs: e.errors })).not.toMatch(/BTEST|BPANEL|Tenant B/);
  });
  it('tenant B resolving its own panel never sees tenant A tests, even if a tenant A test id is planted in a B panel row', { timeout: T }, async () => {
    const env = setup12({ t6: { panel_members: [pmb(PANEL_B.panel.id, TC.test.id, TENANT_B, 9)] } });
    const r = await env.db.run((ctx) => env.svc['resolveOrderablesPreview']!(ctx, { orderable_ids: [PANEL_B.panel.id] }), { tenantId: TENANT_B }).then((x) => x, (x) => x);
    expect(JSON.stringify(r)).not.toContain(TC.test.id);
  });
  it('defensive: a stored cycle (seeded around the write check) -> 422 catalog.panel_cycle, no hang, no partial result', { timeout: T }, async () => {
    const a = pnl(96, TENANT_A, { code: 'CYCA' }), b = pnl(97, TENANT_A, { code: 'CYCB' });
    const env = setup12({ t6: { orderables: [a.orderable, b.orderable], panels: [a.panel, b.panel], panel_members: [pmb(a.panel.id, b.panel.id, TENANT_A, 1), pmb(b.panel.id, a.panel.id, TENANT_A, 1), pmb(a.panel.id, TC.test.id, TENANT_A, 2)] } });
    lims(await rejection(resolve(env, [a.panel.id])), 'catalog.panel_cycle', 422);
    lims(await rejection(resolve(env, [TC.test.id, b.panel.id])), 'catalog.panel_cycle', 422);
  });
  it.each([
    ['empty list', []], ['not an array', 'x'], ['null', null], ['51 ids', Array.from({ length: 51 }, (_v, i) => ID(0x8000 + i))], ['not uuids', ['nope']], ['a number', [5]], ['null member', [null]],
  ])('invalid orderable_ids (%s) -> 400 path /orderable_ids, no SQL on the catalog tables', { timeout: T }, async (_n, ids) => {
    const env = setup12();
    const e = await rejection(resolve(env, ids));
    validation400(e);
    if (e.code === 'common.validation_failed') expect(errPaths(e).some((p) => p === '/orderable_ids' || p.startsWith('/orderable_ids/'))).toBe(true);
    expect(env.db.t6Stmts()).toHaveLength(0);
  });
  it('orderable_ids missing, or an undeclared body field (tenant_id, include_inactive) -> 400', { timeout: T }, async () => {
    const env = setup12();
    validation400(await rejection(env.db.run((ctx) => env.svc['resolveOrderablesPreview']!(ctx, {}))));
    for (const extra of [{ tenant_id: TENANT_B }, { include_inactive: true }, { catalogRevision: 1 }]) validation400(await rejection(resolve(env, [TC.test.id], extra)));
    validation400(await rejection(env.db.run((ctx) => env.svc['resolveOrderablesPreview']!(ctx, undefined))));
  });
  it('error detail never echoes submitted values (AB-20)', { timeout: T }, async () => {
    const env = setup12();
    const planted = 'PLANTED-VALUE-5b1e';
    const e = await rejection(resolve(env, [planted], { as_of: planted }));
    expect(JSON.stringify({ m: e.message, d: e.detail, errs: e.errors })).not.toContain('PLANTED-VALUE');
  });
});

describe('resolveOrderablesPreview — read-only, bounded, consistent', () => {
  it('writes nothing: only SELECTs, no UPDATE of orderables.revision, no catalog_state increment, no event, revision unchanged', { timeout: T }, async () => {
    const env = setup12();
    await resolve(env, [HP_ELITE_M.panel.id, BASIC.panel.id]);
    expect(env.db.stmts.every((s) => /^\s*SELECT/i.test(s.text)), env.db.stmts.map((s) => s.text.slice(0, 60)).join(' | ')).toBe(true);
    expect(env.db.events).toHaveLength(0);
    expect(env.db.revisionOf(TENANT_A)).toBe(SEED_REVISION);
  });
  it('every statement on the catalog tables carries an explicit tenant_id = $n predicate (defence in depth under RLS)', { timeout: T }, async () => {
    const env = setup12();
    await resolve(env, [HP_ELITE_M.panel.id]);
    const own = env.db.t6Stmts();
    expect(own.length).toBeGreaterThan(0);
    for (const s of own) expect(s.text, s.text).toMatch(/\btenant_id\s*=\s*\$\d+/i);
  });
  it('no N+1: resolving 7 tests through 4 nested panels costs at most 2 statements more than resolving 1',{ timeout: T }, async () => {
    const c = chainSeed('r', 4);
    const small = setup12({ t6: c.rows }), big = setup12({ t6: { ...c.rows, panel_members: [...c.rows.panel_members!, ...[TC, HDL, TG, LDL, A1C, FBS].map((t, i) => pmb(c.ids[3]!, t.test.id, TENANT_A, i + 2))] } });
    await resolve(small, [c.ids[0]!]); await resolve(big, [c.ids[0]!]);
    expect(big.db.stmts.length).toBeLessThanOrEqual(small.db.stmts.length + 2);
    const wide = setup12();
    await resolve(wide, [HP_ELITE_M.panel.id, BASIC.panel.id, LIPID.panel.id]);
    expect(wide.db.stmts.length).toBeLessThan(40);
  });
  it('catalog_revision is the tenant\'s current revision at read time (a write in between is visible to the next call)', { timeout: T }, async () => {
    const env = setup12();
    expect((await resolve(env, [TC.test.id])).catalog_revision).toBe(SEED_REVISION);
    await env.db.run((ctx) => env.svc['createPanel']!(ctx, pBody({ members: [mem('test', TC.test.id, 1)] })));
    expect((await resolve(env, [TC.test.id])).catalog_revision).toBe(SEED_REVISION + 1);
  });
  it('a panel created through #53 resolves like a seeded one (create -> resolve, AC-07.1 end to end)', { timeout: T }, async () => {
    const env = setup12();
    const pkg = await env.db.run((ctx) => env.svc['createPanel']!(ctx, pBody({ code: 'pkg_m', panel_kind: 'package', sex_restriction: 'male',
      members: [mem('test', CBC.test.id, 1), mem('panel', LIPID.panel.id, 2), mem('test', FBS.test.id, 3)] })));
    const r = await resolve(env, [pkg.id]);
    expect(r.orderables[0]).toEqual({ orderable_id: pkg.id, kind: 'panel', test_ids: idsOf(CBC, TC, HDL, TG, LDL, FBS) });
  });
  it('concurrent resolves and a concurrent member replace never produce a half-applied set (all-old or all-new)', { timeout: T }, async () => {
    const env = setup12();
    const reads = Array.from({ length: 5 }, () => resolve(env, [BASIC.panel.id]));
    const write = env.db.run((ctx) => env.svc['replacePanelMembers']!(ctx, { id: BASIC.panel.id, expectedVersion: 1, body: { members: [mem('test', TC.test.id, 1), mem('test', HDL.test.id, 2)] } }));
    const [out] = await Promise.all([Promise.all(reads), write]);
    for (const r of out) { const ids = r.orderables[0].test_ids; expect([idsOf(CBC, FBS), idsOf(TC, HDL)]).toContainEqual(ids); }
  });
});
