// C9 T-07 — QC plans + versions service #14-#19 (02-TRD §5.3; AC-03.1–03.6; 07-SECURITY S-01/S-03/S-04/S-07). Fake repo + fake CatalogPort; SEAMS in plan.helpers.ts header.
import { describe, expect, it } from 'vitest';
import { createPlanService } from '../service/plan.service.js';
import {
  AFTER, ANA, DTO_KEYS, baseSeed, FULL2, INS, INS_B, LVL, NOW, OPS, PARAM_KEYS, PLANTED, PLN, TENANT_A, TENANT_B, TST, UUID7, USER, body, code, makeCatalog, makePlanCtx, makePlanRepo,
  noRights, params2, params3, params4, readOnly, rejection, type Row,
} from './plan.helpers.js';

const setup = (o: Parameters<typeof makePlanCtx>[0] = {}, seed?: Parameters<typeof makePlanRepo>[0]) => {
  const fake = makePlanRepo(seed); const c = makePlanCtx(o); const svc: any = createPlanService({ repo: fake.repo });
  return { svc, fake, ...c };
};
const errors = (e: any): Array<{ path: string; code: string }> => (e?.errors ?? e?.details ?? []).map((x: any) => ({ path: x.path, code: x.code }));
const invalid = async (p: Promise<unknown>, path: string, c = 'common.field_invalid') => {
  const e = await rejection(p); expect(code(e)).toBe('common.validation_failed'); expect(errors(e)).toContainEqual({ path, code: c }); return e;
};

// ================================================================================================================ AC-03.1 / 03.2 / 03.3 — N, composition, rule set
describe('createQcPlan: rule set by N (AC-03.1–03.3; 04 L23)', () => {
  const cases: Array<[string, Row, string | undefined, string, string[]]> = [
    ['AC-03.1 N=2 {L1:1,L2:1}, default mean rule', params2(), undefined, '10x', ['1-3s', '2-2s', 'R-4s', '4-1s', '10x']],
    ['N=2 mean rule 8x', params2({ mean_rule: '8x' }), '8x', '8x', ['1-3s', '2-2s', 'R-4s', '4-1s', '8x']],
    ['N=2 mean rule 12x', params2({ mean_rule: '12x' }), '12x', '12x', ['1-3s', '2-2s', 'R-4s', '4-1s', '12x']],
    ['AC-03.2 N=3 three levels, default mean rule 6x', params3(), undefined, '6x', ['1-3s', '2of3-2s', 'R-4s', '3-1s', '6x']],
    ['AC-03.2 N=3 mean rule 9x selectable', params3({ mean_rule: '9x' }), '9x', '9x', ['1-3s', '2of3-2s', 'R-4s', '3-1s', '9x']],
    ['AC-03.3 N=4 {L1:2,L2:2}, default mean rule 10x', params4(), undefined, '10x', ['1-3s', '2-2s', 'R-4s', '4-1s', '10x']],
    ['AC-03.3 N=4 mean rule 8x', params4({ mean_rule: '8x' }), '8x', '8x', ['1-3s', '2-2s', 'R-4s', '4-1s', '8x']],
    ['AC-03.3 N=4 mean rule 12x', params4({ mean_rule: '12x' }), '12x', '12x', ['1-3s', '2-2s', 'R-4s', '4-1s', '12x']],
  ];
  it.each(cases)('%s -> 201, inactive, version 1, rule_set_preview %j', async (_n, p, _given, meanRule, rejection_) => {
    const { svc, ctx } = setup();
    const r = await svc.createQcPlan(ctx, { body: body({ instrument_id: INS(2), analyte_id: ANA(1) }, p) });
    expect(r.status).toBe(201); expect(r.version).toBe(1);
    expect(r.body).toMatchObject({ status: 'inactive', current_version_no: 1, version: 1, instrument_id: INS(2), test_id: TST(1), analyte_id: ANA(1) });
    expect(r.body.rule_set_preview).toEqual({ warning: ['1-2s'], rejection: rejection_ });
    expect(r.body.params.mean_rule).toBe(meanRule); expect(r.body.params.controls_per_run).toBe(p['controls_per_run']);
  });
  it('N=4 with three levels {L1:2, L2:1, L3:1} is a valid composition (counts sum to N, levels of one material)', async () => {
    const { svc, ctx } = setup();
    const r = await svc.createQcPlan(ctx, { body: body({ instrument_id: INS(2) }, { controls_per_run: 4, composition: [{ level_id: LVL(1), count: 2 }, { level_id: LVL(2), count: 1 }, { level_id: LVL(3), count: 1 }] }) });
    expect(r.status).toBe(201); expect(r.body.rule_set_preview.rejection).toContain('4-1s');
  });
  it('levels of SEVERAL materials may be composed (02-TRD §5.3: "levels of one material or several")', async () => {
    const { svc, ctx } = setup();
    const r = await svc.createQcPlan(ctx, { body: body({ instrument_id: INS(2) }, params2({ composition: [{ level_id: LVL(1), count: 1 }, { level_id: LVL(4), count: 1 }] })) });
    expect(r.status).toBe(201);
  });
  it('defaults are filled in and echoed: the DTO params carry all 9 QcPlanParams keys', async () => {
    const { svc, ctx } = setup(); const r = await svc.createQcPlan(ctx, { body: body({ instrument_id: INS(2) }) });
    expect(Object.keys(r.body.params).sort()).toEqual(PARAM_KEYS); expect(r.body.params).toEqual(FULL2);
  });
  it('explicit params are stored, not defaulted over', async () => {
    const { svc, ctx, } = setup(); const p = params2({ mean_rule: '12x', two_two_s_across_runs: false, count_rules_across_materials: false, exclude_rejected_runs_from_history: false, run_window_minutes: 5, qc_validity_hours: 168, hold_lookback_hours: 1 });
    const r = await svc.createQcPlan(ctx, { body: body({ instrument_id: INS(2) }, p) });
    expect(r.body.params).toEqual({ ...p }); expect(PARAM_KEYS.every((k) => k in r.body.params)).toBe(true);
  });
  it('boundary values 5/240, 1/168, 1/168 are accepted', async () => {
    for (const [i, p] of [{ run_window_minutes: 5, qc_validity_hours: 1, hold_lookback_hours: 1 }, { run_window_minutes: 240, qc_validity_hours: 168, hold_lookback_hours: 168 }].entries()) {
      const { svc, ctx } = setup(); const r = await svc.createQcPlan(ctx, { body: body({ instrument_id: INS(2), analyte_id: ANA(1) }, params2(p)) }); expect(r.status, String(i)).toBe(201);
    }
  });
});

describe('createQcPlan: what is written (version 1, tenant, actor, ids)', () => {
  it('inserts one plan row (inactive, current_version_no 1) and one version row (version_no 1, effective_from = now, no change_reason); ids are UUIDv7', async () => {
    const { svc, ctx, fake } = setup();
    const r = await svc.createQcPlan(ctx, { body: body({ instrument_id: INS(2) }, params2({ mean_rule: '8x' })) });
    const [p] = fake.callsOf('insertPlan'), [v] = fake.callsOf('insertVersion');
    expect(fake.callsOf('insertPlan')).toHaveLength(1); expect(fake.callsOf('insertVersion')).toHaveLength(1);
    expect(p!.tenantId).toBe(TENANT_A); expect(v!.tenantId).toBe(TENANT_A);
    const plan = p!.args[0] as Row, ver = v!.args[0] as Row;
    expect(plan).toMatchObject({ instrument_id: INS(2), test_id: TST(1), analyte_id: ANA(1), created_by: USER, updated_by: USER });
    expect(plan['id']).toMatch(UUID7); expect(ver['id']).toMatch(UUID7); expect(r.body.id).toBe(plan['id']);
    expect(ver).toMatchObject({ plan_id: plan['id'], version_no: 1, controls_per_run: 2, mean_rule: '8x', effective_from: NOW, created_by: USER, updated_by: USER });
    expect(ver['composition']).toEqual(params2()['composition']); expect(ver['change_reason'] ?? null).toBeNull(); expect(r.body.effective_from).toBe(NOW);
    expect(plan).not.toHaveProperty('tenant_id'); expect(ver).not.toHaveProperty('tenant_id');          // tenant is a repo argument from ctx only (REQ-SEC-013)
  });
  it('the plan insert comes before the version insert (FK), and a duplicate plan leaves NO version row', async () => {
    const { svc, ctx, fake } = setup();
    await rejection(svc.createQcPlan(ctx, { body: body({ analyte_id: ANA(1) }) }));      // PLN(1) already holds (INS(1), ANA(1))
    expect(fake.callsOf('insertVersion')).toHaveLength(0); expect(fake.versions).toHaveLength(4);
  });
  it('a created plan can be read back (#16) with exactly its version 1', async () => {
    const { svc, ctx } = setup(); const c = await svc.createQcPlan(ctx, { body: body({ instrument_id: INS(2) }, params3()) });
    const g = await svc.getQcPlan(ctx, { planId: c.body.id });
    expect(g.body.versions).toHaveLength(1); expect(g.body.versions[0]).toMatchObject({ version_no: 1, params: { controls_per_run: 3, mean_rule: '6x' } });
  });
});

// ================================================================================================================ AC-03.4 — 400 naming the field
describe('createQcPlan: validation (AC-03.4) -> 400 common.validation_failed naming the field', () => {
  const run = (p: Row) => { const s = setup(); return { ...s, p: s.svc.createQcPlan(s.ctx, { body: body({}, p) }) }; };
  it.each([[1], [5], [6], [0], [-2], [2.5], ['2'], [null], [true], [[2]]])('controls_per_run = %j is outside {2,3,4} -> /params/controls_per_run', async (n) => {
    const { p, fake } = run(params2({ controls_per_run: n })); await invalid(p, '/params/controls_per_run'); expect(fake.mutations()).toHaveLength(0);
  });
  it('controls_per_run missing -> /params/controls_per_run common.field_required', async () => {
    const q: Row = params2(); delete q['controls_per_run']; await invalid(run(q).p, '/params/controls_per_run', 'common.field_required');
  });
  it('composition missing -> /params/composition common.field_required', async () => {
    const q: Row = params2(); delete q['composition']; await invalid(run(q).p, '/params/composition', 'common.field_required');
  });
  it.each([
    ['counts sum to less than N: N=2 {L1:1}', params2({ composition: [{ level_id: LVL(1), count: 1 }] })],
    ['counts sum to more than N: N=2 {L1:2, L2:1}', params2({ composition: [{ level_id: LVL(1), count: 2 }, { level_id: LVL(2), count: 1 }] })],
    ['N=3 {L1:1, L2:1} (sum 2)', params3({ composition: [{ level_id: LVL(1), count: 1 }, { level_id: LVL(2), count: 1 }] })],
    ['N=4 {L1:2, L2:1} (sum 3)', params4({ composition: [{ level_id: LVL(1), count: 2 }, { level_id: LVL(2), count: 1 }] })],
  ])('composition whose counts do not sum to N: %s -> /params/composition', async (_n, p) => { await invalid(run(p).p, '/params/composition'); });
  it.each([['empty', []], ['5 items', [1, 2, 3, 4, 5].map((n) => ({ level_id: LVL(n), count: 1 }))], ['not an array', { level_id: LVL(1), count: 2 }], ['null', null], ['a string', 'L1']])
  ('composition %s -> /params/composition', async (_n, c) => { await invalid(run(params2({ composition: c })).p, '/params/composition'); });
  it.each([[0], [5], [1.5], ['1'], [null], [-1]])('composition count %j -> /params/composition/0/count', async (n) => {
    await invalid(run(params2({ composition: [{ level_id: LVL(1), count: n }, { level_id: LVL(2), count: 1 }] })).p, '/params/composition/0/count');
  });
  it('composition item without count -> field_required at /params/composition/1/count; without level_id -> /params/composition/0/level_id', async () => {
    await invalid(run(params2({ composition: [{ level_id: LVL(1), count: 1 }, { level_id: LVL(2) }] })).p, '/params/composition/1/count', 'common.field_required');
    await invalid(run(params2({ composition: [{ count: 1 }, { level_id: LVL(2), count: 1 }] })).p, '/params/composition/0/level_id', 'common.field_required');
  });
  it('composition level_id not a UUID -> /params/composition/0/level_id', async () => {
    await invalid(run(params2({ composition: [{ level_id: 'L1', count: 1 }, { level_id: LVL(2), count: 1 }] })).p, '/params/composition/0/level_id');
  });
  it('composition names the same level twice -> /params/composition/1/level_id (one entry per level)', async () => {
    await invalid(run(params2({ composition: [{ level_id: LVL(1), count: 1 }, { level_id: LVL(1), count: 1 }] })).p, '/params/composition/1/level_id');
  });
  it('composition level that does not exist (or belongs to tenant B) -> 400 /params/composition/<i>/level_id, nothing written (S-04, AB-11)', async () => {
    for (const lv of [LVL(7), LVL(9)]) {
      const { p, fake } = run(params2({ composition: [{ level_id: LVL(1), count: 1 }, { level_id: lv, count: 1 }] }));
      await invalid(p, '/params/composition/1/level_id'); expect(fake.mutations()).toHaveLength(0);
    }
  });
  it('composition item with an unknown key -> common.unknown_field at /params/composition/0/status', async () => {
    await invalid(run(params2({ composition: [{ level_id: LVL(1), count: 1, status: 'x' }, { level_id: LVL(2), count: 1 }] })).p, '/params/composition/0/status', 'common.unknown_field');
  });
  it.each([
    ['N=2 with 6x', params2({ mean_rule: '6x' })], ['N=2 with 9x', params2({ mean_rule: '9x' })], ['N=4 with 6x', params4({ mean_rule: '6x' })], ['N=4 with 9x', params4({ mean_rule: '9x' })],
    ['N=3 with 8x', params3({ mean_rule: '8x' })], ['N=3 with 10x', params3({ mean_rule: '10x' })], ['N=3 with 12x', params3({ mean_rule: '12x' })],
    ['unknown 11x', params2({ mean_rule: '11x' })], ['upper-case 10X', params2({ mean_rule: '10X' })], ['number 10', params2({ mean_rule: 10 })], ['null', params2({ mean_rule: null })], ['empty', params2({ mean_rule: '' })],
  ])('a mean rule not allowed for N (%s) -> /params/mean_rule', async (_n, p) => { await invalid(run(p).p, '/params/mean_rule'); });
  it.each([
    ['run_window_minutes', 4], ['run_window_minutes', 241], ['run_window_minutes', 30.5], ['run_window_minutes', '30'], ['qc_validity_hours', 0], ['qc_validity_hours', 169], ['hold_lookback_hours', 0], ['hold_lookback_hours', 169],
    ['two_two_s_across_runs', 'yes'], ['count_rules_across_materials', 1], ['exclude_rejected_runs_from_history', null],
  ])('%s = %j -> 400 at /params/%s', async (k, v) => { await invalid(run(params2({ [k]: v })).p, `/params/${k}`); });
  it('every violation is reported, not just the first (several paths in one answer)', async () => {
    const { svc, ctx } = setup(); const e = await rejection(svc.createQcPlan(ctx, { body: body({}, params2({ controls_per_run: 5, mean_rule: '11x', run_window_minutes: 1 })) }));
    expect(errors(e).map((x) => x.path)).toEqual(expect.arrayContaining(['/params/controls_per_run', '/params/mean_rule', '/params/run_window_minutes']));
  });
  it.each([['instrument_id'], ['test_id'], ['analyte_id'], ['params']])('%s missing -> common.field_required at /%s', async (k) => {
    const b = body(); delete b[k]; const { svc, ctx } = setup(); await invalid(svc.createQcPlan(ctx, { body: b }), `/${k}`, 'common.field_required');
  });
  it.each([['instrument_id'], ['test_id'], ['analyte_id']])('%s not a UUID -> /%s', async (k) => { const { svc, ctx } = setup(); await invalid(svc.createQcPlan(ctx, { body: body({ [k]: 'not-a-uuid' }) }), `/${k}`); });
  it.each([[null], [[]], ['x'], [7]])('body %j -> 400 (root)', async (b) => { const { svc, ctx, fake } = setup(); const e = await rejection(svc.createQcPlan(ctx, { body: b })); expect(code(e)).toBe('common.validation_failed'); expect(fake.calls).toHaveLength(0); });
  it('a validation error echoes no request value (REQ-SEC-095)', async () => {
    const { svc, ctx } = setup(); const e = await rejection(svc.createQcPlan(ctx, { body: body({}, params2({ mean_rule: PLANTED })) }));
    expect(JSON.stringify({ c: e?.code, m: e?.message, d: e?.detail, e: e?.errors })).not.toContain(PLANTED);
  });
});

describe('createQcPlan: mass assignment (S-03, REQ-SEC-013/067) -> common.unknown_field, nothing written', () => {
  it.each([['tenant_id', TENANT_B], ['status', 'active'], ['version', 9], ['current_version_no', 7], ['created_by', USER], ['id', PLN(7)], ['is_active', false], ['effective_from', NOW], ['change_reason', 'x']])('body.%s', async (k, v) => {
    const { svc, ctx, fake } = setup(); await invalid(svc.createQcPlan(ctx, { body: body({ [k]: v }) }), `/${k}`, 'common.unknown_field'); expect(fake.mutations()).toHaveLength(0);
  });
  it.each([['tenant_id', TENANT_B], ['status', 'active'], ['version_no', 5], ['effective_from', NOW], ['created_by', USER]])('params.%s', async (k, v) => {
    const { svc, ctx, fake } = setup(); await invalid(svc.createQcPlan(ctx, { body: body({}, params2({ [k]: v })) }), `/params/${k}`, 'common.unknown_field'); expect(fake.mutations()).toHaveLength(0);
  });
});

// ================================================================================================================ catalog (CatalogPort fake) + instrument_code_unmapped
describe('createQcPlan: CatalogPort — test/analyte validation and the instrument_code_unmapped warning', () => {
  it('a mapped instrument code -> warnings: [] (always present); mapInstrumentCode got the outbound query', async () => {
    const { svc, ctx, catalog } = setup(); const r = await svc.createQcPlan(ctx, { body: body({ instrument_id: INS(2) }) });
    expect(r.body.warnings).toEqual([]); expect(catalog.mapCalls).toEqual([{ instrumentId: INS(2), direction: 'outbound', testId: TST(1), analyteId: ANA(1) }]);
  });
  it('catalog.instrument_code_unmapped -> 201 with warnings: ["instrument_code_unmapped"]; the plan IS created', async () => {
    const { svc, ctx, fake } = setup({ catalog: makeCatalog({ unmapped: true }) }); const r = await svc.createQcPlan(ctx, { body: body({ instrument_id: INS(2) }) });
    expect(r.status).toBe(201); expect(r.body.warnings).toEqual(['instrument_code_unmapped']); expect(r.body.status).toBe('inactive'); expect(fake.callsOf('insertPlan')).toHaveLength(1);
  });
  it('any OTHER mapInstrumentCode failure propagates (fail closed) and nothing is written', async () => {
    const { svc, ctx, fake } = setup({ catalog: makeCatalog({ mapFails: Object.assign(new Error('boom'), { code: 'common.dependency_unavailable' }) }) });
    expect(code(await rejection(svc.createQcPlan(ctx, { body: body() })))).toBe('common.dependency_unavailable'); expect(fake.mutations()).toHaveLength(0);
  });
  it('the warning is only on #15: getQcPlan / version bodies carry no `warnings`', async () => {
    const { svc, ctx } = setup({ catalog: makeCatalog({ unmapped: true }) });
    expect((await svc.getQcPlan(ctx, { planId: PLN(1) })).body).not.toHaveProperty('warnings');
    expect((await svc.createQcPlanVersion(ctx, { planId: PLN(1), expectedVersion: 1, body: { params: params2(), change_reason: 'r' } })).body).not.toHaveProperty('warnings');
  });
  it('unknown test (and tenant B\'s test, which CatalogPort answers not_found for) -> 400 /test_id; nothing written', async () => {
    const { svc, ctx, fake } = setup(); await invalid(svc.createQcPlan(ctx, { body: body({ test_id: TST(9) }) }), '/test_id'); expect(fake.mutations()).toHaveLength(0);
  });
  it('analyte that is not one of the test\'s analytes -> 400 /analyte_id', async () => {
    const { svc, ctx, fake } = setup(); await invalid(svc.createQcPlan(ctx, { body: body({ analyte_id: ANA(4) }) }), '/analyte_id'); expect(fake.mutations()).toHaveLength(0);   // ANA(4) belongs to TST(2)
  });
  it('a non-numeric analyte (ordinal) cannot carry a QC plan -> 400 /analyte_id', async () => {
    const { svc, ctx } = setup(); await invalid(svc.createQcPlan(ctx, { body: body({ analyte_id: ANA(5) }) }), '/analyte_id');
  });
  it('another CatalogPort failure (dependency down) propagates; nothing written', async () => {
    const { svc, ctx, fake } = setup({ catalog: makeCatalog({ getTestFails: Object.assign(new Error('down'), { code: 'common.dependency_unavailable' }) }) });
    expect(code(await rejection(svc.createQcPlan(ctx, { body: body() })))).toBe('common.dependency_unavailable'); expect(fake.mutations()).toHaveLength(0);
  });
  it('instrument of tenant B (or unknown) -> 400 /instrument_id (composite FK -> validation, not 500, not 404), nothing else written (S-04, AB-11)', async () => {
    for (const ins of [INS_B, INS(7)]) { const { svc, ctx, fake } = setup(); await invalid(svc.createQcPlan(ctx, { body: body({ instrument_id: ins }) }), '/instrument_id'); expect(fake.callsOf('insertVersion')).toHaveLength(0); }
  });
  it('DTO analyte fields come from the catalog: analyte_code/name, unit_code, decimals; instrument_label = "display_name (instrument_code)"', async () => {
    const { svc, ctx } = setup(); const r = await svc.createQcPlan(ctx, { body: body({ instrument_id: INS(2), analyte_id: ANA(3) }) });
    expect(r.body).toMatchObject({ analyte_code: 'GLU', analyte_name: 'Glucose', unit_code: 'mmol/L', decimals: 2, instrument_label: 'Second analyser (SIM-CHEM-2)' });
  });
});

// ================================================================================================================ AC-03.5 — duplicate pair
describe('createQcPlan: one plan per instrument × analyte (AC-03.5)', () => {
  it('an ACTIVE plan exists for (I1, K) -> 409 quality.code_duplicate; no version row, no other write', async () => {
    const { svc, ctx, fake } = setup(); const e = await rejection(svc.createQcPlan(ctx, { body: body({ instrument_id: INS(1), analyte_id: ANA(1) }) }));
    expect(code(e)).toBe('quality.code_duplicate'); expect(fake.callsOf('insertVersion')).toHaveLength(0); expect(fake.plans.filter((p) => p['tenant_id'] === TENANT_A)).toHaveLength(3);
  });
  it('an INACTIVE plan for the pair also blocks (the unique key ignores status)', async () => {
    const { svc, ctx } = setup(); expect(code(await rejection(svc.createQcPlan(ctx, { body: body({ analyte_id: ANA(3) }) })))).toBe('quality.code_duplicate');   // PLN(2) is inactive
  });
  it('same analyte on ANOTHER instrument is a different pair -> 201', async () => {
    const { svc, ctx } = setup(); expect((await svc.createQcPlan(ctx, { body: body({ instrument_id: INS(2), analyte_id: ANA(1) }) })).status).toBe(201);
  });
  it('tenant B holds a plan for its own pair; tenant A creating "the same" pair is unaffected (RLS-scoped uniqueness)', async () => {
    const { svc, ctx } = setup(); const r = await svc.createQcPlan(ctx, { body: body({ instrument_id: INS(2), analyte_id: ANA(4), test_id: TST(2) }, params4()) }); expect(r.status).toBe(201);
  });
  it('race: two concurrent creates for one pair -> exactly one 201 and one 409 quality.code_duplicate; exactly one plan row and one version row', async () => {
    const { svc, ctx, fake } = setup(); const b = body({ instrument_id: INS(2), analyte_id: ANA(3) });
    const res = await Promise.allSettled([svc.createQcPlan(ctx, { body: b }), svc.createQcPlan(ctx, { body: b })]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1); const bad: any = res.find((r) => r.status === 'rejected'); expect(code(bad.reason)).toBe('quality.code_duplicate');
    expect(fake.plans.filter((p) => p['instrument_id'] === INS(2))).toHaveLength(1); expect(fake.versions).toHaveLength(5);   // 4 seeded + exactly one new version 1
  });
});

// ================================================================================================================ reads #14 / #16
describe('listQcPlans (#14) and getQcPlan (#16)', () => {
  it('lists the tenant\'s plans only (tenant B\'s PLN(9) never appears) with the page envelope; DTO allowlist; no ETag version needed', async () => {
    const { svc, ctx } = setup(); const r = await svc.listQcPlans(ctx, {});
    expect(r.status).toBe(200); expect(r.body.data.map((p: Row) => p['id']).sort()).toEqual([PLN(1), PLN(2), PLN(3)].sort()); expect(r.body.page).toMatchObject({ limit: 50 });
    for (const p of r.body.data) { expect(Object.keys(p).every((k) => DTO_KEYS.includes(k)), JSON.stringify(Object.keys(p))).toBe(true); expect(JSON.stringify(p)).not.toContain(PLANTED); expect(JSON.stringify(p)).not.toContain('null'); }
  });
  it('filters instrument_id / analyte_id / status reach the repo (typed) and narrow the result', async () => {
    const { svc, ctx, fake } = setup();
    expect((await svc.listQcPlans(ctx, { status: 'active' })).body.data.map((p: Row) => p['id'])).toEqual([PLN(1)]);
    expect((await svc.listQcPlans(ctx, { analyteId: ANA(4) })).body.data.map((p: Row) => p['id'])).toEqual([PLN(3)]);
    expect((await svc.listQcPlans(ctx, { instrumentId: INS(2) })).body.data).toEqual([]);
    expect(fake.callsOf('listPlans')[0]!.args[0]).toMatchObject({ status: 'active', limit: 50 });
  });
  it('mixed-tenant filter: tenant A asking for tenant B\'s instrument gets an empty page, not B\'s plans (REQ-SEC-040)', async () => {
    const { svc, ctx } = setup(); expect((await svc.listQcPlans(ctx, { instrumentId: INS_B })).body.data).toEqual([]);
  });
  it.each([[{ status: 'retired' }, '/status'], [{ instrumentId: 'x' }, '/instrument_id'], [{ analyteId: 'x' }, '/analyte_id'], [{ limit: 0 }, '/limit'], [{ limit: 201 }, '/limit'], [{ limit: 1.5 }, '/limit']])('bad filter %j -> 400 %s', async (q, path) => {
    const { svc, ctx } = setup(); await invalid(svc.listQcPlans(ctx, q), path);
  });
  it('a list row carries the CURRENT version\'s params; instrument label resolved once for the page', async () => {
    const { svc, ctx, fake } = setup(); const r = await svc.listQcPlans(ctx, {}); const p3 = r.body.data.find((p: Row) => p['id'] === PLN(3));
    expect(p3.params).toMatchObject({ controls_per_run: 4, composition: [{ level_id: LVL(1), count: 2 }, { level_id: LVL(2), count: 2 }] }); expect(p3.instrument_label).toBe('Synthetic chemistry analyser (SIM-CHEM-1)');
    expect(fake.callsOf('listCurrentVersions')).toHaveLength(1); expect(fake.callsOf('listInstrumentLabels').length).toBeLessThanOrEqual(1);
  });
  it('catalog is read once per distinct test_id for a page (no N+1)', async () => {
    const { svc, ctx, catalog } = setup(); await svc.listQcPlans(ctx, {}); expect(catalog.getTestCalls.map((c) => c.testId).sort()).toEqual([TST(1), TST(2)].sort());
  });
  it('#16 returns the DTO + versions[] (newest data in params, version_no ascending, created_by_display from the user directory)', async () => {
    const { svc, ctx } = setup(); const r = await svc.getQcPlan(ctx, { planId: PLN(1) });
    expect(r.status).toBe(200); expect(r.version).toBe(1); expect(r.body).toMatchObject({ id: PLN(1), status: 'active', current_version_no: 1 });
    expect(Object.keys(r.body).every((k) => [...DTO_KEYS, 'versions'].includes(k))).toBe(true);
    expect(r.body.versions).toHaveLength(1); expect(r.body.versions[0]).toMatchObject({ version_no: 1, params: FULL2, created_by_display: 'Synthetic Lab Manager' });
    expect(Object.keys(r.body.versions[0]).every((k) => ['id', 'version_no', 'params', 'change_reason', 'effective_from', 'created_at', 'created_by_display'].includes(k))).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain(PLANTED); expect(JSON.stringify(r.body)).not.toContain(TENANT_A);
  });
  it.each([[PLN(9)], [PLN(7)], ['not-a-uuid'], ['']])('#16 with %j (tenant B\'s plan / missing / malformed) -> 404 common.not_found, identical for all (S-01)', async (id) => {
    const { svc, ctx } = setup(); expect(code(await rejection(svc.getQcPlan(ctx, { planId: id })))).toBe('common.not_found');
  });
  it('as tenant B, tenant A\'s plan is 404 and B reads only its own', async () => {
    const { svc, ctx } = setup({ tenantId: TENANT_B }); expect(code(await rejection(svc.getQcPlan(ctx, { planId: PLN(1) })))).toBe('common.not_found');
    expect((await svc.listQcPlans(ctx, {})).body.data.map((p: Row) => p['id'])).toEqual([PLN(9)]);
  });
  it('every repo call of every operation carries the ctx tenant (no cross-tenant fallthrough)', async () => {
    const { svc, ctx, fake } = setup(); await svc.listQcPlans(ctx, {}); await svc.getQcPlan(ctx, { planId: PLN(1) });
    await svc.createQcPlan(ctx, { body: body({ instrument_id: INS(2) }) }); await svc.activateQcPlan(ctx, { planId: PLN(3), expectedVersion: 1, body: {} });
    expect(fake.calls.length).toBeGreaterThan(5); for (const c of fake.calls) expect(c.tenantId, c.op).toBe(TENANT_A);
  });
});

// ================================================================================================================ AC-03.6 — #17 new version
describe('createQcPlanVersion (#17): append-only versions, runs keep theirs (AC-03.6)', () => {
  const vbody = (o: Row = {}) => ({ params: params3({ mean_rule: '9x' }), change_reason: 'Add third level after lot change', ...o });
  it('appends version 2 (version_no = current + 1, effective_from = now, change_reason stored); the plan\'s current_version_no and row version advance; 200 + new ETag', async () => {
    const { svc, ctx, fake } = setup({ now: AFTER });
    const r = await svc.createQcPlanVersion(ctx, { planId: PLN(1), expectedVersion: 1, body: vbody() });
    expect(r.status).toBe(200); expect(r.version).toBe(2);
    expect(r.body).toMatchObject({ id: PLN(1), current_version_no: 2, version: 2, effective_from: AFTER, params: { controls_per_run: 3, mean_rule: '9x' } });
    expect(r.body.rule_set_preview).toEqual({ warning: ['1-2s'], rejection: ['1-3s', '2of3-2s', 'R-4s', '3-1s', '9x'] });
    const [v] = fake.callsOf('insertVersion'); expect(v!.args[0]).toMatchObject({ plan_id: PLN(1), version_no: 2, controls_per_run: 3, mean_rule: '9x', change_reason: 'Add third level after lot change', effective_from: AFTER, created_by: USER });
    expect(fake.callsOf('updatePlan')[0]!.args.slice(0, 2)).toEqual([PLN(1), 1]); expect(fake.callsOf('updatePlan')[0]!.args[2]).toMatchObject({ current_version_no: 2 });
  });
  it('AC-03.6: version 1 is untouched — same row, same params, same effective_from — and both versions are listed by #16', async () => {
    const { svc, ctx, fake } = setup({ now: AFTER }); const before = structuredClone(fake.versionsOf(PLN(1))[0]);
    await svc.createQcPlanVersion(ctx, { planId: PLN(1), expectedVersion: 1, body: vbody() });
    expect(fake.versionsOf(PLN(1))[0]).toEqual(before);
    const g = await svc.getQcPlan(ctx, { planId: PLN(1) });
    expect(g.body.versions.map((v: Row) => v['version_no'])).toEqual([1, 2]); expect(g.body.versions[0].params).toEqual(FULL2); expect(g.body.versions[1].params.controls_per_run).toBe(3);
    expect(g.body.versions[0].effective_from).not.toBe(g.body.versions[1].effective_from);
  });
  it('AC-03.6: the only write to qc_plan_versions is INSERT — the repo has no method that updates or deletes a version row, and the service never calls one', async () => {
    const { svc, ctx, fake } = setup(); await svc.createQcPlanVersion(ctx, { planId: PLN(1), expectedVersion: 1, body: vbody() });
    expect(Object.keys(fake.repo).filter((k) => /version/i.test(k) && /^(update|delete|remove|set|patch|upsert)/i.test(k))).toEqual([]);
    expect(fake.mutations().map((m) => m.op).sort()).toEqual(['insertVersion', 'updatePlan']);
  });
  it('a version on an ACTIVE plan keeps it active (no deactivation, no re-activation guard, no enqueue)', async () => {
    const { svc, ctx, enqueues } = setup(); const r = await svc.createQcPlanVersion(ctx, { planId: PLN(1), expectedVersion: 1, body: vbody() });
    expect(r.body.status).toBe('active'); expect(enqueues()).toEqual([]);
  });
  it('a version on an INACTIVE plan stays inactive', async () => {
    const { svc, ctx } = setup(); expect((await svc.createQcPlanVersion(ctx, { planId: PLN(2), expectedVersion: 1, body: vbody() })).body.status).toBe('inactive');
  });
  it('consecutive versions number 2, 3, 4 with the fresh ETag each time', async () => {
    const { svc, ctx } = setup(); let v = 1;
    for (const n of [2, 3, 4]) { const r = await svc.createQcPlanVersion(ctx, { planId: PLN(1), expectedVersion: v, body: vbody() }); expect(r.body.current_version_no).toBe(n); v = r.version; }
    expect(v).toBe(4);
  });
  it('the new version is validated exactly like #15 (N, composition, mean rule; levels of this tenant)', async () => {
    const { svc, ctx, fake } = setup();
    await invalid(svc.createQcPlanVersion(ctx, { planId: PLN(1), expectedVersion: 1, body: vbody({ params: params2({ controls_per_run: 5 }) }) }), '/params/controls_per_run');
    await invalid(svc.createQcPlanVersion(ctx, { planId: PLN(1), expectedVersion: 1, body: vbody({ params: params3({ mean_rule: '10x' }) }) }), '/params/mean_rule');
    await invalid(svc.createQcPlanVersion(ctx, { planId: PLN(1), expectedVersion: 1, body: vbody({ params: params2({ composition: [{ level_id: LVL(1), count: 3 }] }) }) }), '/params/composition', 'common.field_invalid'); // sum 3 != N 2 (ruling C9.T-07)
    await invalid(svc.createQcPlanVersion(ctx, { planId: PLN(1), expectedVersion: 1, body: vbody({ params: params2({ composition: [{ level_id: LVL(9), count: 2 }] }) }) }), '/params/composition/0/level_id');
    expect(fake.mutations()).toHaveLength(0);
  });
  it('change_reason is required and 1..500 characters', async () => {
    const { svc, ctx, fake } = setup(); const b: Row = vbody(); delete b['change_reason'];
    await invalid(svc.createQcPlanVersion(ctx, { planId: PLN(1), expectedVersion: 1, body: b }), '/change_reason', 'common.field_required');
    await invalid(svc.createQcPlanVersion(ctx, { planId: PLN(1), expectedVersion: 1, body: vbody({ change_reason: '' }) }), '/change_reason');
    await invalid(svc.createQcPlanVersion(ctx, { planId: PLN(1), expectedVersion: 1, body: vbody({ change_reason: 'x'.repeat(501) }) }), '/change_reason');
    await invalid(svc.createQcPlanVersion(ctx, { planId: PLN(1), expectedVersion: 1, body: vbody({ change_reason: 7 }) }), '/change_reason');
    expect(fake.mutations()).toHaveLength(0);
    expect((await svc.createQcPlanVersion(ctx, { planId: PLN(1), expectedVersion: 1, body: vbody({ change_reason: 'x'.repeat(500) }) })).status).toBe(200);
  });
  it('params is required; unknown top-level fields (tenant_id, status, version_no, current_version_no) are common.unknown_field (S-03)', async () => {
    const { svc, ctx, fake } = setup(); const b: Row = vbody(); delete b['params'];
    await invalid(svc.createQcPlanVersion(ctx, { planId: PLN(1), expectedVersion: 1, body: b }), '/params', 'common.field_required');
    for (const k of ['tenant_id', 'status', 'version_no', 'current_version_no', 'instrument_id', 'analyte_id', 'test_id']) await invalid(svc.createQcPlanVersion(ctx, { planId: PLN(1), expectedVersion: 1, body: vbody({ [k]: 'x' }) }), `/${k}`, 'common.unknown_field');
    expect(fake.mutations()).toHaveLength(0);
  });
  it('If-Match absent -> 428 common.precondition_required; stale -> 409 common.version_conflict; nothing written in either case', async () => {
    const { svc, ctx, fake } = setup();
    expect(code(await rejection(svc.createQcPlanVersion(ctx, { planId: PLN(1), body: vbody() })))).toBe('common.precondition_required');
    expect(code(await rejection(svc.createQcPlanVersion(ctx, { planId: PLN(1), expectedVersion: 5, body: vbody() })))).toBe('common.version_conflict');
    expect(fake.mutations()).toHaveLength(0);
  });
  it('the plan row is updated BEFORE the version row is inserted, so a lost update leaves no orphan version: repo.updatePlan -> undefined => 409 and zero insertVersion', async () => {
    const { svc, ctx, fake } = setup(); const orig = fake.repo.updatePlan; fake.repo.updatePlan = async (...a) => { await orig(...a); return undefined; };
    expect(code(await rejection(svc.createQcPlanVersion(ctx, { planId: PLN(1), expectedVersion: 1, body: vbody() })))).toBe('common.version_conflict'); expect(fake.callsOf('insertVersion')).toHaveLength(0);
  });
  it('race: two writers with the same If-Match -> one 200, one 409 common.version_conflict, exactly ONE new version row (no duplicate version_no)', async () => {
    const { svc, ctx, fake } = setup();
    const res = await Promise.allSettled([svc.createQcPlanVersion(ctx, { planId: PLN(1), expectedVersion: 1, body: vbody() }), svc.createQcPlanVersion(ctx, { planId: PLN(1), expectedVersion: 1, body: vbody({ change_reason: 'second writer' }) })]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1); expect(code((res.find((r) => r.status === 'rejected') as any).reason)).toBe('common.version_conflict');
    expect(fake.versionsOf(PLN(1)).map((v) => v['version_no'])).toEqual([1, 2]);
  });
  it.each([[PLN(9)], [PLN(7)], ['not-a-uuid']])('plan %j (tenant B\'s / missing / malformed) -> 404 common.not_found, no write in any tenant (S-01)', async (id) => {
    const { svc, ctx, fake } = setup(); expect(code(await rejection(svc.createQcPlanVersion(ctx, { planId: id, expectedVersion: 1, body: vbody() })))).toBe('common.not_found');
    expect(fake.mutations()).toHaveLength(0); expect(fake.versions.filter((v) => v['tenant_id'] === TENANT_B)).toHaveLength(1);
  });
  it('a version never reaches other plans: only the target plan\'s rows change', async () => {
    const { svc, ctx, fake } = setup(); const others = structuredClone(fake.plans.filter((p) => p['id'] !== PLN(1)));
    await svc.createQcPlanVersion(ctx, { planId: PLN(1), expectedVersion: 1, body: vbody() }); expect(fake.plans.filter((p) => p['id'] !== PLN(1))).toEqual(others);
  });
});

// ================================================================================================================ #18 activate + guard
describe('activateQcPlan (#18): activation guard (done_when)', () => {
  it('every composition level has an active target (for an active lot) -> inactive -> active, 200 + new ETag, DTO status active', async () => {
    const { svc, ctx } = setup(); const r = await svc.activateQcPlan(ctx, { planId: PLN(3), expectedVersion: 1, body: {} });
    expect(r.status).toBe(200); expect(r.version).toBe(2); expect(r.body).toMatchObject({ id: PLN(3), status: 'active', version: 2 });
  });
  it('the guard asks the repo about exactly the CURRENT version\'s composition levels, for THIS plan, in this tenant', async () => {
    const { svc, ctx, fake } = setup(); await svc.activateQcPlan(ctx, { planId: PLN(3), expectedVersion: 1, body: {} });
    const [c] = fake.callsOf('coveredLevelIds'); expect(c!.tenantId).toBe(TENANT_A); expect(c!.args[0]).toBe(PLN(3)); expect([...(c!.args[1] as string[])].sort()).toEqual([LVL(1), LVL(2)].sort());
  });
  it('a composition level without an active target -> 422 quality.qc_target_missing; plan unchanged, no enqueue', async () => {
    const { svc, ctx, fake, enqueues } = setup(); const e = await rejection(svc.activateQcPlan(ctx, { planId: PLN(2), expectedVersion: 1, body: {} }));   // targets for L1 only
    expect(code(e)).toBe('quality.qc_target_missing'); expect(fake.callsOf('updatePlan')).toHaveLength(0); expect(fake.plans.find((p) => p['id'] === PLN(2))).toMatchObject({ status: 'inactive', version: 1 }); expect(enqueues()).toEqual([]);
  });
  it('NO targets at all for the plan -> 422 quality.qc_target_missing', async () => {
    const { svc, ctx } = setup({}, { ...baseSeed(), covered: [] });
    expect(code(await rejection(svc.activateQcPlan(ctx, { planId: PLN(2), expectedVersion: 1, body: {} })))).toBe('quality.qc_target_missing');
  });
  it('after a new version changes the composition, the guard follows the NEW version: PLN(3) gets a version {L3:4}-style composition without a target -> 422', async () => {
    const { svc, ctx } = setup(); const v = await svc.createQcPlanVersion(ctx, { planId: PLN(3), expectedVersion: 1, body: { params: params2({ composition: [{ level_id: LVL(1), count: 1 }, { level_id: LVL(3), count: 1 }] }), change_reason: 'swap L2 for L3' } });
    expect(code(await rejection(svc.activateQcPlan(ctx, { planId: PLN(3), expectedVersion: v.version, body: {} })))).toBe('quality.qc_target_missing');
  });
  it('the 422 carries no value from the request or other tenants (detail never echoes values)', async () => {
    const { svc, ctx } = setup(); const e = await rejection(svc.activateQcPlan(ctx, { planId: PLN(2), expectedVersion: 1, body: {} }));
    expect(JSON.stringify({ m: e?.message, d: e?.detail })).not.toContain(TENANT_B); expect(JSON.stringify({ m: e?.message, d: e?.detail })).not.toContain(PLANTED);
  });
  it('activation enqueues quality.reprocess_pending_observations for the plan, in the same tx, AFTER the update (02-TRD §6.4: history adoption)', async () => {
    const { svc, ctx, enqueues, queries } = setup(); await svc.activateQcPlan(ctx, { planId: PLN(3), expectedVersion: 1, body: {} });
    expect(enqueues()).toEqual([{ task: 'quality.reprocess_pending_observations', payload: { tenant_id: TENANT_A, plan_id: PLN(3) }, key: `reproc:${PLN(3)}` }]);
    expect(queries.filter((q) => /app\.enqueue_job/i.test(q.text))).toHaveLength(1);
  });
  it('a failing enqueue fails the request (the core rolls the tx back; no silent half-activation)', async () => {
    const { svc, ctx } = setup({ enqueueFails: true }); await rejection(svc.activateQcPlan(ctx, { planId: PLN(3), expectedVersion: 1, body: {} }));
  });
  it('If-Match absent -> 428; stale -> 409 (the version check comes BEFORE the guard: a stale call on a plan with missing targets is 409, not 422)', async () => {
    const { svc, ctx, fake } = setup();
    expect(code(await rejection(svc.activateQcPlan(ctx, { planId: PLN(3), body: {} })))).toBe('common.precondition_required');
    expect(code(await rejection(svc.activateQcPlan(ctx, { planId: PLN(2), expectedVersion: 9, body: {} })))).toBe('common.version_conflict');
    expect(fake.mutations()).toHaveLength(0);
  });
  it('lost update at the repo (updatePlan -> undefined) -> 409 common.version_conflict and no enqueue', async () => {
    const { svc, ctx, fake, enqueues } = setup(); fake.repo.updatePlan = async () => undefined;
    expect(code(await rejection(svc.activateQcPlan(ctx, { planId: PLN(3), expectedVersion: 1, body: {} })))).toBe('common.version_conflict'); expect(enqueues()).toEqual([]);
  });
  it('body must be {} — any field is common.unknown_field (e.g. status, tenant_id, force)', async () => {
    const { svc, ctx, fake } = setup();
    for (const k of ['status', 'tenant_id', 'force', 'skip_guard']) await invalid(svc.activateQcPlan(ctx, { planId: PLN(3), expectedVersion: 1, body: { [k]: true } }), `/${k}`, 'common.unknown_field');
    expect(fake.mutations()).toHaveLength(0);
  });
  it.each([[PLN(9)], [PLN(7)], ['not-a-uuid']])('plan %j -> 404 common.not_found (tenant B\'s plan cannot be activated by tenant A), no side effect', async (id) => {
    const { svc, ctx, fake, enqueues } = setup(); expect(code(await rejection(svc.activateQcPlan(ctx, { planId: id, expectedVersion: 1, body: {} })))).toBe('common.not_found');
    expect(fake.mutations()).toHaveLength(0); expect(enqueues()).toEqual([]); expect(fake.plans.find((p) => p['id'] === PLN(9))).toMatchObject({ status: 'active', version: 1 });
  });
  it('race: two activations with the same If-Match -> one 200 and one 409; exactly one enqueue', async () => {
    const { svc, ctx, enqueues } = setup();
    const res = await Promise.allSettled([svc.activateQcPlan(ctx, { planId: PLN(3), expectedVersion: 1, body: {} }), svc.activateQcPlan(ctx, { planId: PLN(3), expectedVersion: 1, body: {} })]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1); expect(code((res.find((r) => r.status === 'rejected') as any).reason)).toBe('common.version_conflict'); expect(enqueues()).toHaveLength(1);
  });
});

// ================================================================================================================ #19 deactivate
describe('deactivateQcPlan (#19)', () => {
  it('active -> inactive with a reason: 200, new ETag, status inactive; the reason is validated but is not a plan column (audit trail is the C0 trigger)', async () => {
    const { svc, ctx, fake } = setup(); const r = await svc.deactivateQcPlan(ctx, { planId: PLN(1), expectedVersion: 1, body: { reason: 'Analyser taken out of service' } });
    expect(r.status).toBe(200); expect(r.version).toBe(2); expect(r.body).toMatchObject({ id: PLN(1), status: 'inactive', version: 2, current_version_no: 1 });
    expect(fake.callsOf('updatePlan')[0]!.args[2]).toMatchObject({ status: 'inactive', updated_by: USER }); expect(fake.callsOf('insertVersion')).toHaveLength(0);
  });
  it('deactivation does not run the activation guard and does not enqueue adoption work', async () => {
    const { svc, ctx, fake, enqueues } = setup(); await svc.deactivateQcPlan(ctx, { planId: PLN(1), expectedVersion: 1, body: { reason: 'r' } });
    expect(fake.callsOf('coveredLevelIds')).toHaveLength(0); expect(enqueues()).toEqual([]);
  });
  it('reason is required and 1..500 chars; unknown fields rejected; nothing written', async () => {
    const { svc, ctx, fake } = setup();
    await invalid(svc.deactivateQcPlan(ctx, { planId: PLN(1), expectedVersion: 1, body: {} }), '/reason', 'common.field_required');
    await invalid(svc.deactivateQcPlan(ctx, { planId: PLN(1), expectedVersion: 1, body: { reason: '' } }), '/reason');
    await invalid(svc.deactivateQcPlan(ctx, { planId: PLN(1), expectedVersion: 1, body: { reason: 'x'.repeat(501) } }), '/reason');
    await invalid(svc.deactivateQcPlan(ctx, { planId: PLN(1), expectedVersion: 1, body: { reason: 5 } }), '/reason');
    await invalid(svc.deactivateQcPlan(ctx, { planId: PLN(1), expectedVersion: 1, body: { reason: 'r', status: 'active' } }), '/status', 'common.unknown_field');
    expect(fake.mutations()).toHaveLength(0);
    expect((await svc.deactivateQcPlan(ctx, { planId: PLN(1), expectedVersion: 1, body: { reason: 'x'.repeat(500) } })).status).toBe(200);
  });
  it('If-Match absent -> 428; stale -> 409; lost update -> 409', async () => {
    const { svc, ctx, fake } = setup();
    expect(code(await rejection(svc.deactivateQcPlan(ctx, { planId: PLN(1), body: { reason: 'r' } })))).toBe('common.precondition_required');
    expect(code(await rejection(svc.deactivateQcPlan(ctx, { planId: PLN(1), expectedVersion: 4, body: { reason: 'r' } })))).toBe('common.version_conflict'); expect(fake.mutations()).toHaveLength(0);
    fake.repo.updatePlan = async () => undefined; expect(code(await rejection(svc.deactivateQcPlan(ctx, { planId: PLN(1), expectedVersion: 1, body: { reason: 'r' } })))).toBe('common.version_conflict');
  });
  it.each([[PLN(9)], [PLN(7)], ['not-a-uuid']])('plan %j -> 404 common.not_found; tenant B\'s active plan stays active', async (id) => {
    const { svc, ctx, fake } = setup(); expect(code(await rejection(svc.deactivateQcPlan(ctx, { planId: id, expectedVersion: 1, body: { reason: 'r' } })))).toBe('common.not_found');
    expect(fake.mutations()).toHaveLength(0); expect(fake.plans.find((p) => p['id'] === PLN(9))?.['status']).toBe('active');
  });
  it('round trip: deactivate then activate again works (the guard is re-checked) and the version numbers keep rising', async () => {
    const { svc, ctx } = setup(); const d = await svc.deactivateQcPlan(ctx, { planId: PLN(1), expectedVersion: 1, body: { reason: 'maintenance' } });
    const a = await svc.activateQcPlan(ctx, { planId: PLN(1), expectedVersion: d.version, body: {} }); expect(a.body).toMatchObject({ status: 'active', version: 3 });
  });
});

// ================================================================================================================ authorisation (S-07) + wire hygiene
describe('authorisation: reads need quality.qc_run.read, writes quality.qc.manage; checked FIRST (S-07, REQ-SEC-099)', () => {
  const calls: Array<[string, (s: any) => Promise<unknown>, string]> = [
    ['listQcPlans', (s) => s.svc.listQcPlans(s.ctx, {}), 'quality.qc_run.read'],
    ['getQcPlan', (s) => s.svc.getQcPlan(s.ctx, { planId: PLN(1) }), 'quality.qc_run.read'],
    ['createQcPlan', (s) => s.svc.createQcPlan(s.ctx, { body: body({ instrument_id: INS(2) }) }), 'quality.qc.manage'],
    ['createQcPlanVersion', (s) => s.svc.createQcPlanVersion(s.ctx, { planId: PLN(1), expectedVersion: 1, body: { params: params2(), change_reason: 'r' } }), 'quality.qc.manage'],
    ['activateQcPlan', (s) => s.svc.activateQcPlan(s.ctx, { planId: PLN(3), expectedVersion: 1, body: {} }), 'quality.qc.manage'],
    ['deactivateQcPlan', (s) => s.svc.deactivateQcPlan(s.ctx, { planId: PLN(1), expectedVersion: 1, body: { reason: 'r' } }), 'quality.qc.manage'],
  ];
  const T = calls.map(([op, call, perm]) => ({ op, call, perm }));
  it('the table covers exactly #14-#19', () => { expect(calls.map((c) => c[0]).sort()).toEqual([...OPS].sort()); });
  it.each(T)('$op asks assertRole for $perm', async ({ call, perm }) => {
    const s = setup(); await call(s); expect(s.asserted[0]).toMatchObject({ permission: perm });
  });
  it.each(T.filter((t) => t.perm === 'quality.qc.manage'))('$op: a read-only principal (lab_technologist) -> auth.forbidden before ANY repo or catalog call', async ({ call }) => {
    const s = setup({ roles: readOnly }); expect(code(await rejection(call(s)))).toBe('auth.forbidden'); expect(s.fake.calls).toHaveLength(0); expect(s.catalog.getTestCalls).toHaveLength(0); expect(s.catalog.mapCalls).toHaveLength(0); expect(s.enqueues()).toEqual([]);
  });
  it.each(T)('$op: a principal with no quality rights -> auth.forbidden before ANY repo or catalog call', async ({ call }) => {
    const s = setup({ roles: noRights }); expect(code(await rejection(call(s)))).toBe('auth.forbidden'); expect(s.fake.calls).toHaveLength(0); expect(s.catalog.getTestCalls).toHaveLength(0);
  });
  it.each(T.filter((t) => t.perm === 'quality.qc_run.read'))('$op: a read-only principal may read', async ({ call }) => { const s = setup({ roles: readOnly }); await expect(call(s)).resolves.toBeTruthy(); });
  it('an invalid body from a principal without rights is auth.forbidden, never validation_failed (no information leak, 403 wins)', async () => {
    const s = setup({ roles: noRights }); expect(code(await rejection(s.svc.createQcPlan(s.ctx, { body: null })))).toBe('auth.forbidden');
  });
});

describe('DTO hygiene (02-TRD §5.10, REQ-SEC-081)', () => {
  it('every response body is on the allowlist: no tenant_id, created_by, updated_*, is_active, internal columns; no null; ids and timestamps are strings', async () => {
    const { svc, ctx } = setup(); const rs = [
      await svc.createQcPlan(ctx, { body: body({ instrument_id: INS(2) }) }), await svc.getQcPlan(ctx, { planId: PLN(1) }),
      await svc.createQcPlanVersion(ctx, { planId: PLN(1), expectedVersion: 1, body: { params: params2(), change_reason: 'r' } }),
      await svc.activateQcPlan(ctx, { planId: PLN(3), expectedVersion: 1, body: {} }), await svc.deactivateQcPlan(ctx, { planId: PLN(1), expectedVersion: 2, body: { reason: 'r' } }),
    ];
    for (const r of rs) { const s = JSON.stringify(r.body); expect(s).not.toMatch(/tenant_id|created_by"|updated_by|updated_at|is_active|internal_note|PLANTED/); expect(s).not.toContain('null'); }
    for (const r of rs) expect(Object.keys(r.body).every((k) => [...DTO_KEYS, 'versions', 'warnings'].includes(k)), JSON.stringify(Object.keys(r.body))).toBe(true);
  });
  it('a version whose author has no directory label still gets a non-empty created_by_display placeholder, never the raw user id (required field, OPEN seam of C9.T-15)', async () => {
    const { svc, ctx } = setup({}, { ...baseSeed(), users: [] }); const r = await svc.getQcPlan(ctx, { planId: PLN(1) }); const d = r.body.versions[0].created_by_display;
    expect(typeof d).toBe('string'); expect(d.length).toBeGreaterThan(0); expect(d.length).toBeLessThanOrEqual(200); expect(d).not.toContain(USER);
  });
  it('the service source never takes tenant_id from input: a body/params/query tenant is never forwarded to the repo', async () => {
    const { svc, ctx, fake } = setup(); await svc.listQcPlans(ctx, { instrumentId: INS(1), tenant_id: TENANT_B } as any).catch(() => undefined);
    for (const c of fake.calls) expect(c.tenantId).toBe(TENANT_A);
  });
});
