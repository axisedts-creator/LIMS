// T-06 (C3) — tests service: createTest / getTestDetail / updateTest / replaceTestSpecimenRequirements / listTests (operations #23–#27).
// Spec: 06-PLAN row T-06 (done_when: code unique across tests/panels; workflow-type rules), 02-TRD §5.0 (If-Match, lists, codes), §5.1 Test/OrderableSummary,
//       §5.2 #23–#27, §9.1 (catalog.changed.v1: created / updated / deactivated, entity_type test), 05-SCHEMA orderables/tests/test_specimen_types;
//       PRD AC-02.1 (getTest analytes in sortOrder with report_subheading + version effective at asOf), AC-02.2 (code upper-cased; the analyte-code half is
//       domain/codes.test.ts), AC-01.2/01.3 semantics for orderable codes, AC-01.6 (428 / 409); 07-SECURITY S-1 (cross-tenant), S-5 (mass assignment),
//       AB-20 (no value echo), REQ-SEC-082 (parameterised SQL), explicit `tenant_id = $n` predicate (defence in depth under RLS).
// Real core `createEvents({producer:'catalog'})` over the SQL fake in helpers/testsDb.ts (RLS, row locks, UNIQUE/CHECK/FK, READ COMMITTED).
// The revision bump is T-03's real service — T-06 must call it in the same transaction (entityType 'test'; it stamps orderables.revision).
// Interface: see helpers/t6.ts (SEAM header). Authoring notes in .orchestra/notes/T-06-tests.md.
import { describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_B, USER, UUIDV7 } from '../helpers/catalogDb.js';
import { meth } from '../helpers/mastersDb.js';
import { ID, ana, anv, pnl, tsr, tst } from '../helpers/testsDb.js';
import { BIOC, EDTA, EDTA_B, HAEM, HAEM_B, ISO_UTC, LAV, LAV_B, SERUM, T, body, errPaths, events, lims, rejection, setup, t6Own, validation400 } from '../helpers/t6.js';

const NOW_AS_OF = '2026-11-07T12:00:00.000Z';                 // ctx.now() of the fake
const seedTests = (...ts: Array<ReturnType<typeof tst>>) => ({ orderables: ts.map((t) => t.orderable), tests: ts.map((t) => t.test) });

// ============================================================================================================ createTest
describe('createTest (#24) — AC-02.2 (code), F-02', () => {
  it('201 Test DTO: code upper-cased, defaults, specimen requirements echoed, revision = new catalog revision, no internal columns', { timeout: T }, async () => {
    const { db, svc } = setup();
    const out = await db.run((ctx) => svc['createTest']!(ctx, body()));
    expect(out).toMatchObject({
      kind: 'test', code: 'CBC', name: 'Complete blood count', department_id: HAEM.id, department_code: 'HAEM', workflow_type: 'standard', report_order: 10,
      is_orderable: true, uses_existing_material: false, is_active: true, version: 1, revision: 418, analytes: [], tat_targets: [],
    });
    expect(out.id).toMatch(UUIDV7);
    expect(out.specimen_requirements).toEqual([{ specimen_type_id: EDTA.id, container_id: LAV.id, is_preferred: true, min_volume_ul: 2000 }]);
    for (const k of ['tenant_id', 'created_by', 'updated_by', 'created_at', 'updated_at', 'panel_kind']) expect(out).not.toHaveProperty(k);
  });

  it('writes one orderables row + one tests row with the SAME id, and the specimen rows; stamps orderables.revision', { timeout: T }, async () => {
    const { db, svc } = setup();
    const out = await db.run((ctx) => svc['createTest']!(ctx, body({ specimen_requirements: [
      { specimen_type_id: EDTA.id, container_id: LAV.id, is_preferred: true, min_volume_ul: 2000 }, { specimen_type_id: SERUM.id, is_preferred: false }] })));
    expect(db.row('orderables', out.id)).toMatchObject({ tenant_id: TENANT_A, kind: 'test', code: 'CBC', name: 'Complete blood count', department_id: HAEM.id, is_orderable: true, revision: 418, is_active: true, created_by: USER, updated_by: USER });
    expect(db.row('tests', out.id)).toMatchObject({ tenant_id: TENANT_A, kind: 'test', workflow_type: 'standard', report_order: 10, uses_existing_material: false, version: 1, is_active: true });
    const rows = db.rows('test_specimen_types', TENANT_A).sort((a, b) => String(a['specimen_type_id']).localeCompare(String(b['specimen_type_id'])));
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r['specimen_type_id'] === EDTA.id)).toMatchObject({ test_id: out.id, container_id: LAV.id, is_preferred: true, min_volume_ul: 2000, created_by: USER });
    expect(rows.find((r) => r['specimen_type_id'] === SERUM.id)).toMatchObject({ test_id: out.id, container_id: null, is_preferred: false, min_volume_ul: null });
    expect(out.specimen_requirements).toHaveLength(2);
  });

  it('omitted optionals take the schema defaults (report_order 100, is_orderable true, uses_existing_material false)', { timeout: T }, async () => {
    const { db, svc } = setup();
    const out = await db.run((ctx) => svc['createTest']!(ctx, body({ report_order: undefined })));
    expect(out).toMatchObject({ report_order: 100, is_orderable: true, uses_existing_material: false });
  });

  it('an add-on test on existing material (CR-C11-009) may have no specimen requirement', { timeout: T }, async () => {
    const { db, svc } = setup();
    const out = await db.run((ctx) => svc['createTest']!(ctx, body({ uses_existing_material: true, specimen_requirements: [] })));
    expect(out).toMatchObject({ uses_existing_material: true, specimen_requirements: [] });
    expect(db.rows('test_specimen_types')).toHaveLength(0);
  });

  it('publishes catalog.changed.v1 {entity_type test, change_kind created, entity_id = new id, revision 418} in the SAME transaction as the rows', { timeout: T }, async () => {
    const { db, svc } = setup();
    const out = await db.run((ctx) => svc['createTest']!(ctx, body()));
    const ev = events(db);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.envelope.payload).toMatchObject({ catalog_revision: 418, entity_type: 'test', entity_id: out.id, change_kind: 'created' });
    expect(ev[0]!.envelope.payload.effective_from).toMatch(ISO_UTC);
    expect(ev[0]!.key).toBe(`${TENANT_A}:catalog:418`);
    expect(db.revisionOf(TENANT_A)).toBe(418);
    const mine = db.stmts.filter((s) => s.tenantId === TENANT_A);
    const at = (re: RegExp) => mine.findIndex((s) => re.test(s.text));
    const o = at(/^\s*INSERT\s+INTO\s+catalog\.orderables\b/i), t = at(/^\s*INSERT\s+INTO\s+catalog\.tests\b/i), s = at(/^\s*INSERT\s+INTO\s+catalog\.test_specimen_types\b/i), e = at(/INSERT INTO core\.event_log/i);
    expect(o).toBeGreaterThanOrEqual(0);
    expect(t).toBeGreaterThan(o);                               // FK tests -> orderables
    expect(s).toBeGreaterThan(t);                               // FK test_specimen_types -> tests
    expect(e).toBeGreaterThan(s);
    expect(new Set(mine.map((x) => x.txId)).size).toBe(1);
  });

  it('rollback discards orderable, test, specimen rows, revision and event together; a failing event insert or specimen insert leaves nothing', { timeout: T }, async () => {
    const a = setup();
    await rejection(a.db.run((ctx) => a.svc['createTest']!(ctx, body()), { rollback: true }));
    const b = setup(); b.db.fail(/INSERT INTO core\.event_log/i);
    await rejection(b.db.run((ctx) => b.svc['createTest']!(ctx, body())));
    const c = setup(); c.db.fail(/INSERT INTO catalog\.test_specimen_types/i);
    await rejection(c.db.run((ctx) => c.svc['createTest']!(ctx, body())));
    for (const { db } of [a, b, c]) {
      expect(db.rows('orderables')).toHaveLength(0); expect(db.rows('tests')).toHaveLength(0); expect(db.rows('test_specimen_types')).toHaveLength(0);
      expect(events(db)).toHaveLength(0); expect(db.revisionOf(TENANT_A)).toBe(417);
    }
  });

  it('the first write of a tenant with no catalog_state row works (revision 1)', { timeout: T }, async () => {
    const { db, svc } = setup({ catalog: {} });
    const out = await db.run((ctx) => svc['createTest']!(ctx, body()));
    expect(out.revision).toBe(1);
    expect(db.revisionOf(TENANT_A)).toBe(1);
  });

  it.each([[' padded '], ['MiXeD'], ['a-b.c+d_1']])('code %j is trimmed and upper-cased on write (orderable regex allows - . + _)', { timeout: T }, async (raw) => {
    const { db, svc } = setup();
    const out = await db.run((ctx) => svc['createTest']!(ctx, body({ code: raw })));
    expect(out.code).toBe(raw.trim().toUpperCase());
    expect(db.row('orderables', out.id)!['code']).toBe(raw.trim().toUpperCase());
  });

  it.each([
    ['empty', ''], ['blank', '   '], ['space inside', 'bad code'], ['leading hyphen', '-X'], ['leading underscore', '_X'], ['33 chars', 'x'.repeat(33)], ['slash', 'A/B'],
    ['dotless i (case-fold forgery)', 'ıdx'], ['long s (case-fold forgery)', 'ſugar'], ['fullwidth letters', 'ＡＢＣ'], ['newline', 'A\nB'], ['number', 123], ['null', null], ['object', { a: 1 }],
  ])('invalid code (%s) -> 400 path /code, nothing written', { timeout: T }, async (_n, code) => {
    const { db, svc } = setup();
    const e = await rejection(db.run((ctx) => svc['createTest']!(ctx, { ...body(), code })));
    validation400(e);
    if (e.code === 'common.validation_failed') expect(errPaths(e)).toContain('/code');
    expect(db.rows('orderables')).toHaveLength(0); expect(events(db)).toHaveLength(0);
  });

  it.each(['code', 'name', 'department_id', 'workflow_type', 'specimen_requirements'])('missing required %s -> 400 path /%s', { timeout: T }, async (field) => {
    const { db, svc } = setup();
    const e = await rejection(db.run((ctx) => svc['createTest']!(ctx, body({ [field]: undefined }))));
    validation400(e);
    if (e.code === 'common.validation_failed') expect(errPaths(e)).toContain(`/${field}`);
    expect(db.rows('orderables')).toHaveLength(0);
  });

  it.each([
    ['name empty', { name: '' }], ['name 201', { name: 'n'.repeat(201) }], ['name number', { name: 5 }], ['workflow_type unknown', { workflow_type: 'urgent' }], ['workflow_type case', { workflow_type: 'Standard' }],
    ['report_order -1', { report_order: -1 }], ['report_order 10000', { report_order: 10000 }], ['report_order 1.5', { report_order: 1.5 }], ['report_order string', { report_order: '10' }],
    ['is_orderable string', { is_orderable: 'yes' }], ['uses_existing_material 1', { uses_existing_material: 1 }], ['department_id not a uuid', { department_id: 'nope' }],
    ['specimen_requirements not an array', { specimen_requirements: {} }],
  ])('invalid field: %s -> 400 before any write (the service validates itself; import commits call it directly)', { timeout: T }, async (_n, over) => {
    const { db, svc } = setup();
    validation400(await rejection(db.run((ctx) => svc['createTest']!(ctx, body(over)))));
    expect(db.rows('orderables')).toHaveLength(0); expect(events(db)).toHaveLength(0);
  });

  it.each([
    ['tenant_id', TENANT_B], ['id', ID(0xbad)], ['kind', 'panel'], ['version', 9], ['revision', 5], ['created_by', USER], ['updated_at', '2020-01-01T00:00:00.000Z'], ['is_active', false],
    ['status', 'published'], ['analytes', []], ['tat_targets', []], ['department_code', 'X'], ['panel_kind', 'package'], ['__proto__x', 1],
  ])('S-5 mass assignment: undeclared field %s -> 400, nothing written', { timeout: T }, async (k, v) => {
    const { db, svc } = setup();
    validation400(await rejection(db.run((ctx) => svc['createTest']!(ctx, { ...body(), [k]: v }))));
    expect(db.rows('orderables')).toHaveLength(0);
  });

  it('SQL stays parameterised: quote/semicolon in name round-trips verbatim and the code/name never appear in statement text', { timeout: T }, async () => {
    const { db, svc } = setup();
    const planted = "O'Brien; DROP TABLE x;--";
    const out = await db.run((ctx) => svc['createTest']!(ctx, body({ name: planted })));
    expect(out.name).toBe(planted);
    expect(db.row('orderables', out.id)!['name']).toBe(planted);
    for (const s of db.stmts) { expect(s.text).not.toContain('DROP TABLE'); expect(s.text).not.toContain('CBC'); }
  });

  it('error detail never echoes submitted values (AB-20)', { timeout: T }, async () => {
    const { db, svc } = setup();
    const planted = 'PLANTED-VALUE-7f3a';
    for (const over of [{ code: planted + ' bad!' }, { name: 5, workflow_type: planted }, { specimen_requirements: [{ specimen_type_id: planted, is_preferred: true }] }]) {
      const e = await rejection(db.run((ctx) => svc['createTest']!(ctx, body(over))));
      expect(JSON.stringify({ m: e.message, d: e.detail, errs: e.errors })).not.toContain('PLANTED-VALUE');
    }
  });

  it('every statement on the new tables carries an explicit tenant_id = $n predicate (defence in depth under RLS)', { timeout: T }, async () => {
    const { db, svc } = setup();
    await db.run((ctx) => svc['createTest']!(ctx, body()));
    const reads = t6Own(db).filter((s) => /^\s*(SELECT|UPDATE|DELETE)/i.test(s.text));
    for (const s of reads) expect(s.text, s.text).toMatch(/\btenant_id\s*=\s*\$\d+/i);
    for (const s of t6Own(db).filter((x) => /^\s*INSERT/i.test(x.text))) expect(s.values).toContain(TENANT_A);
  });

  // ---- AC: code unique across tests AND panels (orderables supertype)
  it('AC-01.2 analogue: the same code in any case -> 409 catalog.code_duplicate; no second row, no event, no revision bump', { timeout: T }, async () => {
    const { db, svc } = setup();
    await db.run((ctx) => svc['createTest']!(ctx, body()));
    for (const variant of ['cbc', 'CBC', ' Cbc ']) lims(await rejection(db.run((ctx) => svc['createTest']!(ctx, body({ code: variant })))), 'catalog.code_duplicate', 409);
    expect(db.rows('orderables', TENANT_A)).toHaveLength(1); expect(db.rows('tests', TENANT_A)).toHaveLength(1);
    expect(events(db)).toHaveLength(1); expect(db.revisionOf(TENANT_A)).toBe(418);
  });

  it('a PANEL (or package) already owns the code -> 409 catalog.code_duplicate (one code space for tests and panels)', { timeout: T }, async () => {
    const p = pnl(1, TENANT_A, { code: 'CBC', panel_kind: 'clinical' });
    const { db, svc } = setup({ t6: { orderables: [p.orderable], panels: [p.panel] } });
    lims(await rejection(db.run((ctx) => svc['createTest']!(ctx, body()))), 'catalog.code_duplicate', 409);
    expect(db.rows('tests')).toHaveLength(0); expect(db.rows('orderables', TENANT_A)).toHaveLength(1);
  });

  it('an INACTIVE or non-orderable orderable still owns its code', { timeout: T }, async () => {
    const a = tst(1, TENANT_A, HAEM.id, { code: 'CBC', is_active: false });
    const b = tst(2, TENANT_A, HAEM.id, { code: 'HB', is_orderable: false });
    const { db, svc } = setup({ t6: seedTests(a, b) });
    lims(await rejection(db.run((ctx) => svc['createTest']!(ctx, body()))), 'catalog.code_duplicate', 409);
    lims(await rejection(db.run((ctx) => svc['createTest']!(ctx, body({ code: 'hb' })))), 'catalog.code_duplicate', 409);
  });

  it('AC-01.3 analogue: tenant B owning the code does not block tenant A; B is untouched', { timeout: T }, async () => {
    const b = tst(1, TENANT_B, HAEM_B.id, { code: 'CBC' });
    const { db, svc } = setup({ t6: seedTests(b) });
    const out = await db.run((ctx) => svc['createTest']!(ctx, body()));
    expect(out.code).toBe('CBC');
    expect(db.rows('orderables', TENANT_B)).toHaveLength(1); expect(db.rows('orderables', TENANT_A)).toHaveLength(1);
    expect(events(db, TENANT_B)).toHaveLength(0);
  });

  it('race: two concurrent creates of the same code -> exactly one wins, the loser gets catalog.code_duplicate (not a raw 23505), one event, one orphan-free row set', { timeout: T }, async () => {
    const { db, svc } = setup();
    const res = await Promise.allSettled([
      db.run((ctx) => svc['createTest']!(ctx, body())),
      db.run((ctx) => svc['createTest']!(ctx, body({ code: 'Cbc' }))),
    ]);
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    lims((res.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason, 'catalog.code_duplicate', 409);
    expect(db.rows('orderables', TENANT_A)).toHaveLength(1); expect(db.rows('tests', TENANT_A)).toHaveLength(1); expect(db.rows('test_specimen_types', TENANT_A)).toHaveLength(1);
    expect(events(db)).toHaveLength(1); expect(db.revisionOf(TENANT_A)).toBe(418);
  });

  it('concurrent creates of DIFFERENT codes both succeed with gapless revisions 418 and 419', { timeout: T }, async () => {
    const { db, svc } = setup();
    const out = await Promise.all([db.run((ctx) => svc['createTest']!(ctx, body({ code: 'a1' }))), db.run((ctx) => svc['createTest']!(ctx, body({ code: 'a2' })))]);
    expect(out.map((o) => o.revision).sort()).toEqual([418, 419]);
    expect(events(db).map((e) => e.envelope.payload.catalog_revision).sort()).toEqual([418, 419]);
  });

  // ---- S-1: ids of another tenant / unknown ids in the body
  it.each([
    ['department of tenant B', { department_id: HAEM_B.id }], ['unknown department', { department_id: ID(0xdead) }],
    ['specimen type of tenant B', { specimen_requirements: [{ specimen_type_id: EDTA_B.id, is_preferred: true }] }],
    ['unknown specimen type', { specimen_requirements: [{ specimen_type_id: ID(0xdead), is_preferred: true }] }],
    ['container of tenant B', { specimen_requirements: [{ specimen_type_id: EDTA.id, container_id: LAV_B.id, is_preferred: true }] }],
    ['unknown container', { specimen_requirements: [{ specimen_type_id: EDTA.id, container_id: ID(0xdead), is_preferred: true }] }],
  ])('S-1: %s -> 404 common.not_found, nothing written, no event', { timeout: T }, async (_n, over) => {
    const { db, svc } = setup();
    lims(await rejection(db.run((ctx) => svc['createTest']!(ctx, body(over)))), 'common.not_found', 404);
    expect(db.rows('orderables')).toHaveLength(0); expect(db.rows('tests')).toHaveLength(0); expect(events(db)).toHaveLength(0); expect(db.revisionOf(TENANT_A)).toBe(417);
  });

  // ---- specimen requirement rules (TRD #24/#27: <=10, exactly one preferred; schema min_volume_ul 1..100000)
  describe('specimen requirement rules', () => {
    const one = (o: Record<string, unknown> = {}) => ({ specimen_type_id: EDTA.id, is_preferred: true, ...o });
    it.each([
      ['no preferred', [{ specimen_type_id: EDTA.id, is_preferred: false }]],
      ['no preferred of two', [{ specimen_type_id: EDTA.id, is_preferred: false }, { specimen_type_id: SERUM.id, is_preferred: false }]],
      ['two preferred', [one(), { specimen_type_id: SERUM.id, is_preferred: true }]],
      ['same specimen type twice', [one(), { specimen_type_id: EDTA.id, is_preferred: false }]],
      ['11 entries', Array.from({ length: 11 }, (_, i) => ({ specimen_type_id: i === 0 ? EDTA.id : ID(0x900 + i), is_preferred: i === 0 }))],
      ['min_volume_ul 0', [one({ min_volume_ul: 0 })]], ['min_volume_ul 100001', [one({ min_volume_ul: 100001 })]], ['min_volume_ul 1.5', [one({ min_volume_ul: 1.5 })]],
      ['is_preferred missing', [{ specimen_type_id: EDTA.id }]], ['specimen_type_id missing', [{ is_preferred: true }]], ['undeclared key', [one({ report_label: 'x' })]],
      ['entry not an object', ['EDTA']],
    ])('%s -> 400 on /specimen_requirements…, nothing written', { timeout: T }, async (_n, specimen_requirements) => {
      const { db, svc } = setup();
      const e = await rejection(db.run((ctx) => svc['createTest']!(ctx, body({ specimen_requirements }))));
      validation400(e);
      if (e.code === 'common.validation_failed') expect(errPaths(e).some((p) => p.startsWith('/specimen_requirements')), errPaths(e).join(',')).toBe(true);
      expect(db.rows('orderables')).toHaveLength(0); expect(db.rows('test_specimen_types')).toHaveLength(0); expect(events(db)).toHaveLength(0);
    });
    it('boundaries accepted: min_volume_ul 1 and 100000; exactly one preferred among several; 10 entries', { timeout: T }, async () => {
      const { db, svc } = setup();
      const ten = Array.from({ length: 10 }, (_, i) => ({ specimen_type_id: i === 0 ? EDTA.id : i === 1 ? SERUM.id : ID(0x900 + i), is_preferred: i === 0, min_volume_ul: i === 0 ? 1 : 100000 }));
      lims(await rejection(db.run((ctx) => svc['createTest']!(ctx, body({ specimen_requirements: ten })))), 'common.not_found', 404);   // 10 entries pass validation; 8 of the types do not exist
      const ok = await db.run((ctx) => svc['createTest']!(ctx, body({ specimen_requirements: ten.slice(0, 2) })));
      expect(ok.specimen_requirements.map((r: any) => r.min_volume_ul).sort((a: number, b: number) => a - b)).toEqual([1, 100000]);
    });
  });
});

// ============================================================================================================ getTestDetail
describe('getTestDetail (#25) — AC-02.1', () => {
  const METH = meth(1, TENANT_A, { code: 'IMPEDANCE' });
  const T1 = tst(1, TENANT_A, HAEM.id, { code: 'CBC', name: 'Complete blood count', workflow_type: 'standard', report_order: 10, revision: 400 });
  const A_HB = ana(1, TENANT_A, T1.test.id, { code: 'HB', name: 'Haemoglobin', sort_order: 20, report_subheading: 'RBC parameters', print_name: 'Hb' });
  const A_RBC = ana(2, TENANT_A, T1.test.id, { code: 'RBC', name: 'RBC count', sort_order: 10, report_subheading: 'RBC parameters' });
  const A_WBC = ana(3, TENANT_A, T1.test.id, { code: 'WBC', name: 'WBC count', sort_order: 30, report_subheading: 'WBC parameters' });
  const D = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
  const versions = [
    anv(1, TENANT_A, A_HB.id, { version_no: 1, status: 'superseded', decimals: 1, unit_code: 'G_DL', effective_from: D(2026, 1, 1), effective_to: D(2026, 6, 1) }),
    anv(2, TENANT_A, A_HB.id, { version_no: 2, status: 'published', decimals: 2, unit_code: 'G_DL', method_id: METH.id, effective_from: D(2026, 6, 1) }),
    anv(3, TENANT_A, A_HB.id, { version_no: 3, status: 'draft', decimals: 3, unit_code: 'G_DL', effective_from: null, published_at: null, change_reason: null }),
    anv(4, TENANT_A, A_RBC.id, { version_no: 1, decimals: 2, unit_code: 'MILL_UL' }),
    anv(5, TENANT_A, A_WBC.id, { version_no: 1, status: 'draft', result_type: 'numeric', decimals: 0, effective_from: null, published_at: null, change_reason: null }),
  ];
  const leak = ana(99, TENANT_B, T1.test.id, { code: 'LEAK' });
  const seed = () => setup({
    t6: { ...seedTests(T1), analytes: [A_HB, A_RBC, A_WBC, leak], analyte_versions: versions,
      test_specimen_types: [tsr(T1.test.id, EDTA.id, TENANT_A, { is_preferred: true, container_id: LAV.id, min_volume_ul: 2000 }), tsr(T1.test.id, SERUM.id, TENANT_A)] },
  });
  const get = (e: ReturnType<typeof seed>, input: Record<string, unknown>) => e.db.run((ctx) => e.svc['getTestDetail']!(ctx, { id: T1.test.id, ...input }));

  it('AC-02.1: analytes come in sort_order with report_subheading; current_version = the version effective at as_of (default now); the draft is never "current"', { timeout: T }, async () => {
    const e = seed();
    const out = await get(e, {});
    expect(out.analytes.map((a: any) => a.code)).toEqual(['RBC', 'HB', 'WBC']);
    expect(out.analytes.map((a: any) => a.sort_order)).toEqual([10, 20, 30]);
    expect(out.analytes.map((a: any) => a.report_subheading)).toEqual(['RBC parameters', 'RBC parameters', 'WBC parameters']);
    const hb = out.analytes.find((a: any) => a.code === 'HB');
    expect(hb).toMatchObject({ id: A_HB.id, test_id: T1.test.id, name: 'Haemoglobin', print_name: 'Hb', is_reportable: true, is_active: true, version: 1 });
    expect(hb.current_version).toMatchObject({ id: versions[1]!.id, analyte_id: A_HB.id, version_no: 2, status: 'published', result_type: 'numeric', decimals: 2, unit_code: 'G_DL', method_id: METH.id, version: 1 });
    expect(hb.current_version.effective_from).toBe('2026-06-01T00:00:00.000Z');
    expect(hb.draft_version_id).toBe(versions[2]!.id);
    const rbc = out.analytes.find((a: any) => a.code === 'RBC');
    expect(rbc.current_version).toMatchObject({ version_no: 1, decimals: 2, unit_code: 'MILL_UL' });
    expect(rbc).not.toHaveProperty('draft_version_id');
    const wbc = out.analytes.find((a: any) => a.code === 'WBC');
    expect(wbc).not.toHaveProperty('current_version');                // only a draft exists
    expect(wbc.draft_version_id).toBe(versions[4]!.id);
  });

  it('as_of selects the version in force then: [effective_from, effective_to) — boundary instant belongs to the NEW version; before the first -> no current_version', { timeout: T }, async () => {
    const e = seed();
    const hbAt = async (as_of: string) => (await get(e, { as_of })).analytes.find((a: any) => a.code === 'HB');
    expect((await hbAt('2026-03-01T00:00:00.000Z')).current_version).toMatchObject({ version_no: 1, decimals: 1, status: 'superseded' });
    expect((await hbAt('2026-05-31T23:59:59.999Z')).current_version.version_no).toBe(1);
    expect((await hbAt('2026-06-01T00:00:00.000Z')).current_version.version_no).toBe(2);
    expect((await hbAt(NOW_AS_OF)).current_version.version_no).toBe(2);
    expect(await hbAt('2025-12-31T23:59:59.999Z')).not.toHaveProperty('current_version');
  });

  it('as_of that is not an ISO-UTC instant -> 400 path /as_of', { timeout: T }, async () => {
    const e = seed();
    for (const as_of of ['yesterday', '2026-03-01', '2026-03-01T00:00:00+05:45', '', 5]) {
      const err = await rejection(get(e, { as_of }));
      validation400(err);
      if (err.code === 'common.validation_failed') expect(errPaths(err)).toContain('/as_of');
    }
  });

  it('Test DTO: version/revision from the rows, specimen requirements without null keys, empty tat_targets, department_code, no leakage of the other tenant\'s analytes', { timeout: T }, async () => {
    const e = seed();
    const out = await get(e, {});
    expect(out).toMatchObject({ id: T1.test.id, kind: 'test', code: 'CBC', department_id: HAEM.id, department_code: 'HAEM', workflow_type: 'standard', report_order: 10, version: 1, revision: 400, is_orderable: true, is_active: true, tat_targets: [] });
    const reqs = [...out.specimen_requirements].sort((a: any, b: any) => a.specimen_type_id.localeCompare(b.specimen_type_id));
    expect(reqs).toEqual([
      { specimen_type_id: EDTA.id, container_id: LAV.id, is_preferred: true, min_volume_ul: 2000 },
      { specimen_type_id: SERUM.id, is_preferred: false },                       // null container / volume are OMITTED (schema has no nulls)
    ]);
    expect(JSON.stringify(out)).not.toContain('LEAK');
    expect(out.analytes).toHaveLength(3);
    for (const k of ['tenant_id', 'created_by', 'updated_by', 'created_at', 'updated_at']) expect(out).not.toHaveProperty(k);
  });

  it('an inactive test is still readable by id (is_active false)', { timeout: T }, async () => {
    const off = tst(5, TENANT_A, HAEM.id, { code: 'OLD', is_active: false });
    const e = setup({ t6: seedTests(off) });
    expect(await e.db.run((ctx) => e.svc['getTestDetail']!(ctx, { id: off.test.id }))).toMatchObject({ code: 'OLD', is_active: false });
  });

  it('S-1: another tenant\'s test, an unknown id, and a PANEL id -> 404 common.not_found (no existence leak)', { timeout: T }, async () => {
    const b = tst(7, TENANT_B, HAEM_B.id, { code: 'BONLY' });
    const p = pnl(1, TENANT_A, { code: 'PKG' });
    const e = setup({ t6: { ...seedTests(T1, b), orderables: [T1.orderable, b.orderable, p.orderable], panels: [p.panel] } });
    for (const id of [b.test.id, ID(0xdead), p.panel.id]) lims(await rejection(e.db.run((ctx) => e.svc['getTestDetail']!(ctx, { id }))), 'common.not_found', 404);
  });

  it('id that is not a uuid -> 400', { timeout: T }, async () => {
    const e = seed();
    validation400(await rejection(get(e, { id: 'not-a-uuid' })));
  });

  it('read-only: no INSERT/UPDATE/DELETE, no event, no revision bump; every statement has an explicit tenant predicate; bounded statement count (no per-analyte queries)', { timeout: T }, async () => {
    const e = seed();
    await get(e, {});
    const own = t6Own(e.db);
    for (const s of own) { expect(s.text).toMatch(/^\s*SELECT/i); expect(s.text, s.text).toMatch(/\btenant_id\s*=\s*\$\d+/i); }
    expect(events(e.db)).toHaveLength(0); expect(e.db.revisionOf(TENANT_A)).toBe(417);
    expect(e.db.stmts.filter((s) => s.tenantId === TENANT_A).length).toBeLessThanOrEqual(8);   // 3 analytes + 5 versions must not become N+1 queries
  });
});

// ============================================================================================================ updateTest
describe('updateTest (#26) — If-Match, workflow-type rule', () => {
  const seed = (extra: { analytes?: any[]; versions?: any[] } = {}) => {
    const t1 = tst(1, TENANT_A, HAEM.id, { code: 'CBC', name: 'Complete blood count', report_order: 10, workflow_type: 'standard' });
    const other = tst(2, TENANT_A, HAEM.id, { code: 'HB', workflow_type: 'standard' });
    return { t1, other, ...setup({ t6: { ...seedTests(t1, other), analytes: extra.analytes ?? [], analyte_versions: extra.versions ?? [] } }) };
  };
  /** expectedVersion: null = no If-Match header (undefined would trigger the default). */
  const upd = (e: ReturnType<typeof seed>, id: string, patch: Record<string, unknown>, expectedVersion: number | null = 1) =>
    e.db.run((ctx) => e.svc['updateTest']!(ctx, { id, expectedVersion: expectedVersion ?? undefined, patch }));

  it('200 Test with the patch applied to orderables AND tests, version 2, revision = new catalog revision, event "updated"', { timeout: T }, async () => {
    const e = seed();
    const patch = { name: 'CBC (3-part)', department_id: BIOC.id, report_order: 20, is_orderable: false, uses_existing_material: true };
    const out = await upd(e, e.t1.test.id, patch);
    expect(out).toMatchObject({ ...patch, id: e.t1.test.id, code: 'CBC', department_code: 'BIOC', version: 2, revision: 418, is_active: true });
    expect(e.db.row('orderables', e.t1.test.id)).toMatchObject({ name: 'CBC (3-part)', department_id: BIOC.id, is_orderable: false, revision: 418, code: 'CBC', updated_by: USER });
    expect(e.db.row('tests', e.t1.test.id)).toMatchObject({ report_order: 20, uses_existing_material: true, version: 2, workflow_type: 'standard' });
    const ev = events(e.db);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.envelope.payload).toMatchObject({ catalog_revision: 418, entity_type: 'test', entity_id: e.t1.test.id, change_kind: 'updated' });
    expect(e.db.row('orderables', e.other.test.id)).toMatchObject({ name: 'Test 2', revision: 0 });   // the neighbour is untouched
  });

  it('is_active=false -> BOTH rows inactive (mirror), event "deactivated"; reactivation -> "updated"; the test stays readable', { timeout: T }, async () => {
    const e = seed();
    const off = await upd(e, e.t1.test.id, { is_active: false });
    expect(off).toMatchObject({ is_active: false, version: 2 });
    expect(e.db.row('orderables', e.t1.test.id)!['is_active']).toBe(false);
    expect(e.db.row('tests', e.t1.test.id)!['is_active']).toBe(false);
    const on = await upd(e, e.t1.test.id, { is_active: true }, 2);
    expect(on).toMatchObject({ is_active: true, version: 3 });
    expect(e.db.row('orderables', e.t1.test.id)!['is_active']).toBe(true);
    expect(e.db.row('tests', e.t1.test.id)!['is_active']).toBe(true);
    expect(events(e.db).map((x) => x.envelope.payload.change_kind)).toEqual(['deactivated', 'updated']);
  });

  it('AC-01.6 analogue: no If-Match -> 428 common.precondition_required; stale -> 409 common.version_conflict; row, revision and events untouched', { timeout: T }, async () => {
    const e = seed();
    lims(await rejection(upd(e, e.t1.test.id, { name: 'x' }, null)), 'common.precondition_required', 428);
    lims(await rejection(upd(e, e.t1.test.id, { name: 'x' }, 99)), 'common.version_conflict', 409);
    expect(e.db.row('tests', e.t1.test.id)!['version']).toBe(1);
    expect(e.db.row('orderables', e.t1.test.id)!['name']).toBe('Complete blood count');
    expect(events(e.db)).toHaveLength(0); expect(e.db.revisionOf(TENANT_A)).toBe(417);
  });

  it('race: two concurrent updates with the same If-Match -> exactly one wins (409 for the other), version 2, one event', { timeout: T }, async () => {
    const e = seed();
    const res = await Promise.allSettled([upd(e, e.t1.test.id, { name: 'A' }), upd(e, e.t1.test.id, { name: 'B' })]);
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    lims((res.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason, 'common.version_conflict', 409);
    expect(e.db.row('tests', e.t1.test.id)!['version']).toBe(2);
    expect(events(e.db)).toHaveLength(1); expect(e.db.revisionOf(TENANT_A)).toBe(418);
  });

  it('a failing event insert rolls the whole update back', { timeout: T }, async () => {
    const e = seed(); e.db.fail(/INSERT INTO core\.event_log/i);
    await rejection(upd(e, e.t1.test.id, { name: 'x', report_order: 5 }));
    expect(e.db.row('orderables', e.t1.test.id)!['name']).toBe('Complete blood count');
    expect(e.db.row('tests', e.t1.test.id)).toMatchObject({ report_order: 10, version: 1 });
    expect(e.db.revisionOf(TENANT_A)).toBe(417);
  });

  it.each([
    ['code (immutable)', { code: 'NEW' }], ['kind', { kind: 'panel' }], ['tenant_id', { tenant_id: TENANT_B }], ['id', { id: ID(0xbad) }], ['version', { version: 9 }], ['revision', { revision: 5 }],
    ['specimen_requirements (own endpoint)', { specimen_requirements: [] }], ['analytes', { analytes: [] }], ['created_by', { created_by: USER }], ['sex_restriction', { sex_restriction: 'male' }],
  ])('S-5 mass assignment: %s -> 400, nothing written', { timeout: T }, async (_n, patch) => {
    const e = seed();
    validation400(await rejection(upd(e, e.t1.test.id, { name: 'ok', ...patch })));
    expect(e.db.row('tests', e.t1.test.id)!['version']).toBe(1); expect(events(e.db)).toHaveLength(0);
  });

  it.each([
    ['name empty', { name: '' }], ['name 201', { name: 'n'.repeat(201) }], ['workflow_type unknown', { workflow_type: 'urgent' }], ['report_order 10000', { report_order: 10000 }],
    ['is_active string', { is_active: 'false' }], ['department_id not a uuid', { department_id: 'nope' }], ['uses_existing_material null', { uses_existing_material: null }],
  ])('invalid field: %s -> 400, nothing written', { timeout: T }, async (_n, patch) => {
    const e = seed();
    validation400(await rejection(upd(e, e.t1.test.id, patch)));
    expect(e.db.row('tests', e.t1.test.id)!['version']).toBe(1);
  });

  it('S-1: department of tenant B / unknown department -> 404 common.not_found; nothing written', { timeout: T }, async () => {
    const e = seed();
    for (const department_id of [HAEM_B.id, ID(0xdead)]) lims(await rejection(upd(e, e.t1.test.id, { department_id })), 'common.not_found', 404);
    expect(e.db.row('orderables', e.t1.test.id)!['department_id']).toBe(HAEM.id); expect(events(e.db)).toHaveLength(0);
  });

  it('S-1: another tenant\'s test, an unknown id and a panel id -> 404 common.not_found; tenant B row untouched', { timeout: T }, async () => {
    const b = tst(7, TENANT_B, HAEM_B.id, { code: 'BONLY' });
    const p = pnl(1, TENANT_A, { code: 'PKG' });
    const e = setup({ t6: { ...seedTests(b), orderables: [b.orderable, p.orderable], panels: [p.panel] } });
    for (const id of [b.test.id, ID(0xdead), p.panel.id]) lims(await rejection(e.db.run((ctx) => e.svc['updateTest']!(ctx, { id, expectedVersion: 1, patch: { name: 'hijack' } }))), 'common.not_found', 404);
    expect(e.db.row('orderables', b.test.id)!['name']).toBe('Test 7'); expect(e.db.row('tests', b.test.id)!['version']).toBe(1);
  });

  it('every UPDATE/SELECT on the new tables carries an explicit tenant_id = $n predicate', { timeout: T }, async () => {
    const e = seed();
    await upd(e, e.t1.test.id, { name: 'x' });
    for (const s of t6Own(e.db).filter((x) => /^\s*(SELECT|UPDATE|DELETE)/i.test(x.text))) expect(s.text, s.text).toMatch(/\btenant_id\s*=\s*\$\d+/i);
  });

  // ---- workflow-type rule [CONV]: change only while no analyte version is published
  describe('workflow_type change (TRD #26 [CONV]): only while no analyte version is published', () => {
    const published = () => {
      const t1 = tst(1, TENANT_A, HAEM.id, { code: 'CBC' });
      const an = ana(1, TENANT_A, t1.test.id, { code: 'HB' });
      return { an, v: anv(1, TENANT_A, an.id, { status: 'published' }) };
    };
    const idOf = () => ID(0x1001);

    it('a published analyte version blocks the change -> 409 catalog.version_in_use; nothing written, no event', { timeout: T }, async () => {
      const { an, v } = published();
      const e = seed({ analytes: [an], versions: [v] });
      lims(await rejection(upd(e, idOf(), { workflow_type: 'microbiology' })), 'catalog.version_in_use', 409);
      expect(e.db.row('tests', idOf())).toMatchObject({ workflow_type: 'standard', version: 1 }); expect(events(e.db)).toHaveLength(0); expect(e.db.revisionOf(TENANT_A)).toBe(417);
    });
    it('the block is all-or-nothing: other fields in the same patch are not applied either', { timeout: T }, async () => {
      const { an, v } = published();
      const e = seed({ analytes: [an], versions: [v] });
      lims(await rejection(upd(e, idOf(), { name: 'renamed', workflow_type: 'attachment' })), 'catalog.version_in_use', 409);
      expect(e.db.row('orderables', idOf())!['name']).toBe('Complete blood count');
    });
    it('the same value is not a change (allowed), and other fields stay editable while a version is published', { timeout: T }, async () => {
      const { an, v } = published();
      const e = seed({ analytes: [an], versions: [v] });
      expect(await upd(e, idOf(), { workflow_type: 'standard', name: 'renamed' })).toMatchObject({ workflow_type: 'standard', name: 'renamed', version: 2 });
    });
    it('no analytes at all -> the change is allowed (200) and stored', { timeout: T }, async () => {
      const e = seed();
      expect((await upd(e, idOf(), { workflow_type: 'microbiology' })).workflow_type).toBe('microbiology');
      expect(e.db.row('tests', idOf())!['workflow_type']).toBe('microbiology');
    });
    it('only a DRAFT (or discarded) analyte version -> the change is allowed (200) and stored', { timeout: T }, async () => {
      const an = ana(1, TENANT_A, idOf(), { code: 'HB' });
      const draft = anv(1, TENANT_A, an.id, { status: 'draft', effective_from: null, published_at: null, change_reason: null });
      const gone = anv(2, TENANT_A, an.id, { version_no: 2, status: 'discarded', effective_from: null, published_at: null, change_reason: null });
      const e = seed({ analytes: [an], versions: [draft, gone] });
      expect((await upd(e, idOf(), { workflow_type: 'narrative' })).workflow_type).toBe('narrative');
    });
    it('a published version of ANOTHER test does not block this one', { timeout: T }, async () => {
      const t1 = tst(1, TENANT_A, HAEM.id, { code: 'CBC' });
      const t2 = tst(2, TENANT_A, HAEM.id, { code: 'HB' });
      const an = ana(1, TENANT_A, t2.test.id, { code: 'HBX' });
      const e = setup({ t6: { ...seedTests(t1, t2), analytes: [an], analyte_versions: [anv(1, TENANT_A, an.id)] } });
      expect(await e.db.run((ctx) => e.svc['updateTest']!(ctx, { id: t1.test.id, expectedVersion: 1, patch: { workflow_type: 'anatomic' } }))).toMatchObject({ workflow_type: 'anatomic' });
    });
    it('every allowed enum value can be set when nothing is published', { timeout: T }, async () => {
      const e = seed();
      let v = 1;
      for (const wf of ['narrative', 'microbiology', 'anatomic', 'molecular', 'attachment', 'outsourced', 'standard']) {
        expect((await upd(e, idOf(), { workflow_type: wf }, v++)).workflow_type).toBe(wf);
      }
    });
  });
});

// ============================================================================================================ replaceTestSpecimenRequirements
describe('replaceTestSpecimenRequirements (#27)', () => {
  const seed = () => {
    const t1 = tst(1, TENANT_A, HAEM.id, { code: 'CBC' });
    const t2 = tst(2, TENANT_A, HAEM.id, { code: 'HB' });
    return { t1, t2, ...setup({ t6: { ...seedTests(t1, t2), test_specimen_types: [
      tsr(t1.test.id, EDTA.id, TENANT_A, { is_preferred: true, container_id: LAV.id, min_volume_ul: 2000 }), tsr(t1.test.id, SERUM.id, TENANT_A),
      tsr(t2.test.id, EDTA.id, TENANT_A, { is_preferred: true }),
    ] } }) };
  };
  const put = (e: ReturnType<typeof seed>, id: string, specimen_requirements: unknown, expectedVersion: number | null = 1) =>
    e.db.run((ctx) => e.svc['replaceTestSpecimenRequirements']!(ctx, { id, expectedVersion: expectedVersion ?? undefined, body: { specimen_requirements } }));
  const rowsOf = (e: ReturnType<typeof seed>, id: string) => e.db.rows('test_specimen_types', TENANT_A).filter((r) => r['test_id'] === id);

  it('replaces the set: old rows gone, new rows present, DTO lists the new set, version 2, revision stamped, event "updated"', { timeout: T }, async () => {
    const e = seed();
    const out = await put(e, e.t1.test.id, [{ specimen_type_id: SERUM.id, is_preferred: true, min_volume_ul: 500 }]);
    expect(out.specimen_requirements).toEqual([{ specimen_type_id: SERUM.id, is_preferred: true, min_volume_ul: 500 }]);
    expect(out).toMatchObject({ id: e.t1.test.id, version: 2, revision: 418 });
    expect(rowsOf(e, e.t1.test.id)).toHaveLength(1);
    expect(rowsOf(e, e.t1.test.id)[0]).toMatchObject({ specimen_type_id: SERUM.id, is_preferred: true, container_id: null, min_volume_ul: 500, created_by: USER });
    expect(e.db.row('tests', e.t1.test.id)!['version']).toBe(2);
    expect(e.db.row('orderables', e.t1.test.id)!['revision']).toBe(418);
    expect(events(e.db)).toHaveLength(1);
    expect(events(e.db)[0]!.envelope.payload).toMatchObject({ entity_type: 'test', entity_id: e.t1.test.id, change_kind: 'updated', catalog_revision: 418 });
  });

  it('moving the preferred flag from one specimen type to another works (old rows are deleted before the new ones are inserted)', { timeout: T }, async () => {
    const e = seed();
    const out = await put(e, e.t1.test.id, [{ specimen_type_id: EDTA.id, is_preferred: false }, { specimen_type_id: SERUM.id, is_preferred: true }]);
    expect(out.specimen_requirements.find((r: any) => r.is_preferred).specimen_type_id).toBe(SERUM.id);
    expect(rowsOf(e, e.t1.test.id).filter((r) => r['is_preferred'])).toHaveLength(1);
  });

  it('other tests\' specimen rows are untouched (delete is scoped by tenant and test)', { timeout: T }, async () => {
    const e = seed();
    await put(e, e.t1.test.id, [{ specimen_type_id: SERUM.id, is_preferred: true }]);
    expect(rowsOf(e, e.t2.test.id)).toHaveLength(1);
    expect(rowsOf(e, e.t2.test.id)[0]).toMatchObject({ specimen_type_id: EDTA.id, is_preferred: true });
    for (const s of t6Own(e.db).filter((x) => /^\s*DELETE/i.test(x.text))) { expect(s.text).toMatch(/\btenant_id\s*=\s*\$\d+/i); expect(s.text).toMatch(/\btest_id\s*=\s*\$\d+/i); }
  });

  it('atomic: a failing insert (or event) restores the previous set, version and revision', { timeout: T }, async () => {
    const a = seed(); a.db.fail(/INSERT INTO catalog\.test_specimen_types/i);
    await rejection(put(a, a.t1.test.id, [{ specimen_type_id: SERUM.id, is_preferred: true }]));
    const b = seed(); b.db.fail(/INSERT INTO core\.event_log/i);
    await rejection(put(b, b.t1.test.id, [{ specimen_type_id: SERUM.id, is_preferred: true }]));
    for (const e of [a, b]) {
      expect(rowsOf(e, e.t1.test.id).map((r) => r['specimen_type_id']).sort()).toEqual([EDTA.id, SERUM.id].sort());
      expect(e.db.row('tests', e.t1.test.id)!['version']).toBe(1); expect(e.db.revisionOf(TENANT_A)).toBe(417); expect(events(e.db)).toHaveLength(0);
    }
  });

  it('If-Match: absent -> 428, stale -> 409; nothing changed', { timeout: T }, async () => {
    const e = seed();
    const next = [{ specimen_type_id: SERUM.id, is_preferred: true }];
    lims(await rejection(put(e, e.t1.test.id, next, null)), 'common.precondition_required', 428);
    lims(await rejection(put(e, e.t1.test.id, next, 7)), 'common.version_conflict', 409);
    expect(rowsOf(e, e.t1.test.id)).toHaveLength(2); expect(events(e.db)).toHaveLength(0);
  });

  it('race: two concurrent replaces with the same If-Match -> one wins, the other 409; exactly one preferred row remains', { timeout: T }, async () => {
    const e = seed();
    const res = await Promise.allSettled([
      put(e, e.t1.test.id, [{ specimen_type_id: SERUM.id, is_preferred: true }]),
      put(e, e.t1.test.id, [{ specimen_type_id: EDTA.id, is_preferred: true }]),
    ]);
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    lims((res.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason, 'common.version_conflict', 409);
    expect(rowsOf(e, e.t1.test.id).filter((r) => r['is_preferred'])).toHaveLength(1);
    expect(events(e.db)).toHaveLength(1);
  });

  const one = (o: Record<string, unknown> = {}) => ({ specimen_type_id: EDTA.id, is_preferred: true, ...o });
  it.each([
    ['empty array (1–10 required)', []], ['no preferred', [{ specimen_type_id: EDTA.id, is_preferred: false }]], ['two preferred', [one(), { specimen_type_id: SERUM.id, is_preferred: true }]],
    ['duplicate specimen type', [one(), { specimen_type_id: EDTA.id, is_preferred: false }]], ['11 entries', Array.from({ length: 11 }, (_, i) => ({ specimen_type_id: ID(0x900 + i), is_preferred: i === 0 }))],
    ['min_volume_ul 0', [one({ min_volume_ul: 0 })]], ['min_volume_ul 100001', [one({ min_volume_ul: 100001 })]], ['undeclared key', [one({ report_label: 'x' })]], ['not an array', { a: 1 }],
  ])('%s -> 400 on /specimen_requirements…; the old set survives', { timeout: T }, async (_n, specimen_requirements) => {
    const e = seed();
    const err = await rejection(put(e, e.t1.test.id, specimen_requirements));
    validation400(err);
    if (err.code === 'common.validation_failed') expect(errPaths(err).some((p) => p.startsWith('/specimen_requirements'))).toBe(true);
    expect(rowsOf(e, e.t1.test.id)).toHaveLength(2); expect(events(e.db)).toHaveLength(0);
  });

  it('a body with extra keys (tenant_id, test_id) -> 400', { timeout: T }, async () => {
    const e = seed();
    for (const extra of [{ tenant_id: TENANT_B }, { test_id: ID(1) }, { version: 4 }]) {
      validation400(await rejection(e.db.run((ctx) => e.svc['replaceTestSpecimenRequirements']!(ctx, { id: e.t1.test.id, expectedVersion: 1, body: { specimen_requirements: [one()], ...extra } }))));
    }
  });

  it.each([
    ['specimen type of tenant B', [one({ specimen_type_id: EDTA_B.id })]], ['unknown specimen type', [one({ specimen_type_id: ID(0xdead) })]],
    ['container of tenant B', [one({ container_id: LAV_B.id })]], ['unknown container', [one({ container_id: ID(0xdead) })]],
  ])('S-1: %s -> 404 common.not_found; the old set survives', { timeout: T }, async (_n, specimen_requirements) => {
    const e = seed();
    lims(await rejection(put(e, e.t1.test.id, specimen_requirements)), 'common.not_found', 404);
    expect(rowsOf(e, e.t1.test.id)).toHaveLength(2); expect(events(e.db)).toHaveLength(0);
  });

  it('S-1: another tenant\'s test, an unknown id and a panel id -> 404 common.not_found; B\'s rows untouched', { timeout: T }, async () => {
    const b = tst(7, TENANT_B, HAEM_B.id, { code: 'BONLY' });
    const p = pnl(1, TENANT_A, { code: 'PKG' });
    const e = setup({ t6: { ...seedTests(b), orderables: [b.orderable, p.orderable], panels: [p.panel], test_specimen_types: [tsr(b.test.id, EDTA_B.id, TENANT_B, { is_preferred: true })] } });
    for (const id of [b.test.id, ID(0xdead), p.panel.id]) {
      lims(await rejection(e.db.run((ctx) => e.svc['replaceTestSpecimenRequirements']!(ctx, { id, expectedVersion: 1, body: { specimen_requirements: [one()] } }))), 'common.not_found', 404);
    }
    expect(e.db.rows('test_specimen_types', TENANT_B)).toHaveLength(1);
    expect(e.db.rows('test_specimen_types', TENANT_B)[0]).toMatchObject({ specimen_type_id: EDTA_B.id });
  });
});

// ============================================================================================================ listTests
describe('listTests (#23)', () => {
  const T1 = tst(1, TENANT_A, HAEM.id, { code: 'CBC', name: 'Complete blood count', workflow_type: 'standard', report_order: 30 });
  const T2 = tst(2, TENANT_A, HAEM.id, { code: 'ESR', name: 'Erythrocyte sedimentation', workflow_type: 'standard', report_order: 10 });
  const T3 = tst(3, TENANT_A, BIOC.id, { code: 'GLU', name: 'Glucose', workflow_type: 'standard', report_order: 10 });
  const T4 = tst(4, TENANT_A, BIOC.id, { code: 'CULT', name: 'Culture', workflow_type: 'microbiology', report_order: 20, sex_restriction: 'female' });
  const T5 = tst(5, TENANT_A, HAEM.id, { code: 'OLD', name: 'Retired test', workflow_type: 'standard', is_active: false });
  const TB = tst(6, TENANT_B, HAEM_B.id, { code: 'BONLY', name: 'Tenant B only', workflow_type: 'standard' });
  const P1 = pnl(1, TENANT_A, { code: 'PKG', name: 'Health package', panel_kind: 'package' });
  const seed = () => setup({ t6: { ...seedTests(T1, T2, T3, T4, T5, TB), orderables: [T1, T2, T3, T4, T5, TB].map((x) => x.orderable).concat(P1.orderable), panels: [P1.panel] } });
  const list = (e: ReturnType<typeof seed>, query: Record<string, unknown> = {}) => e.db.run((ctx) => e.svc['listTests']!(ctx, query));
  const codes = (r: { data: any[] }) => r.data.map((x) => x.code);

  it('default: active tests of the tenant only (no panels, no tenant B, no inactive), sorted by code; items are exactly OrderableSummary', { timeout: T }, async () => {
    const e = seed();
    const r = await list(e);
    expect(codes(r)).toEqual(['CBC', 'CULT', 'ESR', 'GLU']);
    expect(r.page).toMatchObject({ limit: 50 });
    expect(r.page).not.toHaveProperty('next_cursor');
    expect(r.data.find((x) => x.code === 'CBC')).toEqual({
      id: T1.test.id, kind: 'test', code: 'CBC', name: 'Complete blood count', department_id: HAEM.id, department_code: 'HAEM', workflow_type: 'standard', is_orderable: true, is_active: true, revision: 0,
    });
    expect(r.data.find((x) => x.code === 'CULT')).toMatchObject({ workflow_type: 'microbiology', sex_restriction: 'female', department_code: 'BIOC' });
    expect(JSON.stringify(r)).not.toContain('BONLY');
  });

  it('is_active: false -> only inactive; all -> both', { timeout: T }, async () => {
    const e = seed();
    expect(codes(await list(e, { is_active: 'false' }))).toEqual(['OLD']);
    expect(codes(await list(e, { is_active: 'all' }))).toEqual(['CBC', 'CULT', 'ESR', 'GLU', 'OLD']);
  });

  it('filters: department_id, workflow_type, and both together', { timeout: T }, async () => {
    const e = seed();
    expect(codes(await list(e, { department_id: BIOC.id }))).toEqual(['CULT', 'GLU']);
    expect(codes(await list(e, { workflow_type: 'microbiology' }))).toEqual(['CULT']);
    expect(codes(await list(e, { department_id: HAEM.id, workflow_type: 'microbiology' }))).toEqual([]);
    expect(codes(await list(e, { department_id: HAEM_B.id }))).toEqual([]);          // tenant B's department id matches nothing and leaks nothing
  });

  it.each([
    ['code', ['CBC', 'CULT', 'ESR', 'GLU']], ['-code', ['GLU', 'ESR', 'CULT', 'CBC']], ['name', ['CBC', 'CULT', 'ESR', 'GLU']], ['-name', ['GLU', 'ESR', 'CULT', 'CBC']],
    ['report_order', ['ESR', 'GLU', 'CULT', 'CBC']],                       // ESR and GLU tie on 10: ties break on id ascending (seed order)
  ])('sort=%s', { timeout: T }, async (sort, expected) => {
    const e = seed();
    expect(codes(await list(e, { sort }))).toEqual(expected);
  });

  it('keyset pagination: limit 2 walks all pages exactly once, in order, with opaque URL-safe cursors', { timeout: T }, async () => {
    const e = seed();
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const r = await list(e, { limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...codes(r));
      expect(r.data.length).toBeLessThanOrEqual(2);
      cursor = r.page.next_cursor;
      if (cursor === undefined) break;
      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    }
    expect(seen).toEqual(['CBC', 'CULT', 'ESR', 'GLU']);
  });

  it('a cursor made for another sort, or garbage -> 400 common.invalid_cursor (or validation_failed); invalid sort / limit / filters -> 400', { timeout: T }, async () => {
    const e = seed();
    const first = await list(e, { limit: 1 });
    for (const q of [{ cursor: '!!!not-a-cursor!!!' }, { cursor: 'AAAA' }, { cursor: first.page.next_cursor, sort: 'name' }]) {
      const err = await rejection(list(e, q));
      expect(err.statusCode).toBe(400); expect(['common.invalid_cursor', 'common.validation_failed']).toContain(err.code);
    }
    for (const q of [{ sort: 'id' }, { sort: 'password' }, { limit: 0 }, { limit: 201 }, { limit: 1.5 }, { workflow_type: 'urgent' }, { is_active: 'maybe' }, { department_id: 'nope' }, { tenant_id: TENANT_B }, { q: 'x' }]) {
      validation400(await rejection(list(e, q)));
    }
  });

  it('S-1: tenant B sees only its own test (never A\'s); statements are parameterised and tenant-scoped', { timeout: T }, async () => {
    const e = seed();
    const r = await e.db.run((ctx) => e.svc['listTests']!(ctx, {}), { tenantId: TENANT_B });
    expect(codes(r)).toEqual(['BONLY']);
    const own = t6Own(e.db);
    expect(own.length).toBeGreaterThan(0);
    for (const s of own) { expect(s.text, s.text).toMatch(/\btenant_id\s*=\s*\$\d+/i); expect(s.text).not.toMatch(/BONLY|CBC/); }
  });
});
