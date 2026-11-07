// T-12 (C3) — panels service: listPanels / createPanel / getPanelDetail / updatePanel / replacePanelMembers (operations #52–#56).
// Spec: 06-PLAN row T-12 (done_when: cycle + depth + inactive member checks), 02-TRD §5.1 Panel, §5.2 #52–#56, §7.7 (write-time DFS, depth > LIMS_CATALOG_PANEL_MAX_DEPTH (4)
//       -> common.validation_failed, members must be active -> catalog.test_inactive), §3 (revision stamping: a panel bump stamps the panel's OWN orderable row; panels
//       containing a changed test are not re-stamped), §9.1 (catalog.changed.v1: entity_type panel; created / updated / deactivated), 05-SCHEMA panels / panel_members;
//       PRD AC-07.3 (cycle -> 422 catalog.panel_cycle, membership unchanged), AC-07.4 (depth > 4 -> 400 common.validation_failed path /members), AC-07.1 (the structure it
//       describes can be created); 07-SECURITY S-1 (cross-tenant), S-5 (mass assignment), AB-20 (no value echo), REQ-SEC-082 (parameterised SQL), explicit tenant predicate.
// Real core createEvents({producer:'catalog'}) over the SQL fake (helpers/testsDb.ts: RLS, row locks, UNIQUE/CHECK/FK, READ COMMITTED). The revision bump is T-03's real
// service. Interface: see helpers/t12.ts (SEAM header). Authoring notes in .orchestra/notes/T-12-tests.md.
import { describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_B, USER, UUIDV7 } from '../helpers/catalogDb.js';
import {
  A1C, BASIC, BIOC, CBC, DEAD, FBS, HAEM_B, HDL, HP_ELITE_M, ID, ISO_UTC, LDL, LIPID, OLD, PANEL_B, SEED_REVISION, T, TC, TEST_B, TG,
  chainSeed, errPaths, events, lims, mem, membersOf, panelStmts, pBody, pmb, pnl, rejection, setup12, tst, validation400, type Env12,
} from '../helpers/t12.js';

/** Everything a failed write must leave alone. */
const snap = (db: Env12['db']) => JSON.stringify({ o: db.rows('orderables'), p: db.rows('panels'), m: db.rows('panel_members'), rev: db.revisionOf(TENANT_A), ev: db.events.length });
const call = (env: Env12, op: string, input?: unknown) => env.db.run((ctx) => env.svc[op]!(ctx, input));
/** `expectedVersion` is passed through verbatim (undefined = If-Match header absent), so there is no default parameter here. */
const replaceRaw = (env: Env12, id: string, members: unknown, expectedVersion: unknown) => call(env, 'replacePanelMembers', { id, expectedVersion, body: { members } });
const replace = (env: Env12, id: string, members: unknown, expectedVersion: unknown = 1) => replaceRaw(env, id, members, expectedVersion);

// ============================================================================================================ createPanel
describe('createPanel (#53) — F-06', () => {
  it('201 Panel DTO: code upper-cased, defaults, members sorted by sort_order, revision = new catalog revision, no internal columns', { timeout: T }, async () => {
    const env = setup12();
    const out = await call(env, 'createPanel', pBody({ code: 'lipid2', members: [mem('test', HDL.test.id, 20), mem('test', TC.test.id, 10), mem('panel', BASIC.panel.id, 30)] }));
    expect(out).toMatchObject({ kind: 'panel', code: 'LIPID2', name: 'New panel', panel_kind: 'clinical', is_orderable: true, is_active: true, version: 1, revision: SEED_REVISION + 1 });
    expect(out.id).toMatch(UUIDV7);
    expect(out.members).toEqual([mem('test', TC.test.id, 10), mem('test', HDL.test.id, 20), mem('panel', BASIC.panel.id, 30)]);
    for (const k of ['tenant_id', 'created_by', 'updated_by', 'created_at', 'updated_at', 'sex_restriction', 'department_id', 'workflow_type']) expect(out).not.toHaveProperty(k);
  });

  it('writes one orderables row (kind panel) + one panels row with the SAME id + one panel_members row per member; stamps the panel\'s own orderables.revision', { timeout: T }, async () => {
    const env = setup12();
    const out = await call(env, 'createPanel', pBody({ code: 'pk1', panel_kind: 'package', sex_restriction: 'female', department_id: BIOC.id,
      members: [mem('test', CBC.test.id, 1), mem('panel', LIPID.panel.id, 2)] }));
    expect(env.db.row('orderables', out.id)).toMatchObject({ tenant_id: TENANT_A, kind: 'panel', code: 'PK1', name: 'New panel', department_id: BIOC.id, sex_restriction: 'female',
      is_orderable: true, is_active: true, revision: SEED_REVISION + 1, created_by: USER, updated_by: USER });
    expect(env.db.row('panels', out.id)).toMatchObject({ tenant_id: TENANT_A, kind: 'panel', panel_kind: 'package', version: 1, is_active: true });
    expect(env.db.rows('panel_members').filter((r) => r['panel_id'] === out.id).map((r) => ({ m: r['member_orderable_id'], s: r['sort_order'], c: r['created_by'], t: r['tenant_id'] })))
      .toEqual([{ m: CBC.test.id, s: 1, c: USER, t: TENANT_A }, { m: LIPID.panel.id, s: 2, c: USER, t: TENANT_A }]);
    expect(out).toMatchObject({ panel_kind: 'package', sex_restriction: 'female', department_id: BIOC.id, department_code: 'BIOC' });
  });

  it('AC-07.1 structure: a package (male) of {CBC test, LIPID panel, FBS test} can be created, nested panel members keep kind panel', { timeout: T }, async () => {
    const env = setup12({ base: false, t6: { orderables: [CBC.orderable, FBS.orderable, LIPID.orderable, TC.orderable, HDL.orderable, TG.orderable, LDL.orderable],
      tests: [CBC.test, FBS.test, TC.test, HDL.test, TG.test, LDL.test], panels: [LIPID.panel],
      panel_members: [TC, HDL, TG, LDL].map((t, i) => pmb(LIPID.panel.id, t.test.id, TENANT_A, i + 1)) } });
    const out = await call(env, 'createPanel', pBody({ code: 'hp_elite_m', name: 'Health package elite male', panel_kind: 'package', sex_restriction: 'male',
      members: [mem('test', CBC.test.id, 1), mem('panel', LIPID.panel.id, 2), mem('test', FBS.test.id, 3)] }));
    expect(out).toMatchObject({ code: 'HP_ELITE_M', panel_kind: 'package', sex_restriction: 'male' });
    expect(out.members.map((m: any) => [m.kind, m.orderable_id])).toEqual([['test', CBC.test.id], ['panel', LIPID.panel.id], ['test', FBS.test.id]]);
  });

  it('publishes catalog.changed.v1 {entity_type panel, change_kind created, entity_id = new id, revision 418} in the SAME transaction, after the member rows', { timeout: T }, async () => {
    const env = setup12();
    const out = await call(env, 'createPanel', pBody());
    const ev = events(env.db);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.envelope.payload).toMatchObject({ catalog_revision: SEED_REVISION + 1, entity_type: 'panel', entity_id: out.id, change_kind: 'created' });
    expect(ev[0]!.envelope.payload.effective_from).toMatch(ISO_UTC);
    expect(env.db.revisionOf(TENANT_A)).toBe(SEED_REVISION + 1);
    const mine = env.db.stmts.filter((s) => s.tenantId === TENANT_A);
    const at = (re: RegExp) => mine.findIndex((s) => re.test(s.text));
    const o = at(/^\s*INSERT\s+INTO\s+catalog\.orderables\b/i), p = at(/^\s*INSERT\s+INTO\s+catalog\.panels\b/i), m = at(/^\s*INSERT\s+INTO\s+catalog\.panel_members\b/i), e = at(/INSERT INTO core\.event_log/i);
    expect(o).toBeGreaterThanOrEqual(0);
    expect(p).toBeGreaterThan(o);                                // FK panels -> orderables
    expect(m).toBeGreaterThan(p);                                // FK panel_members -> panels
    expect(e).toBeGreaterThan(m);
    expect(new Set(mine.map((x) => x.txId)).size).toBe(1);
  });

  it('rollback discards orderable, panel, member rows, revision and event together; a failing event insert or member insert leaves nothing', { timeout: T }, async () => {
    const a = setup12();
    const before = snap(a.db);
    await rejection(a.db.run((ctx) => a.svc['createPanel']!(ctx, pBody()), { rollback: true }));
    const b = setup12(); b.db.fail(/INSERT INTO core\.event_log/i);
    await rejection(b.db.run((ctx) => b.svc['createPanel']!(ctx, pBody())));
    const c = setup12(); c.db.fail(/INSERT INTO catalog\.panel_members/i);
    await rejection(c.db.run((ctx) => c.svc['createPanel']!(ctx, pBody())));
    for (const env of [a, b, c]) expect(snap(env.db)).toBe(before);
  });

  it('the first write of a tenant with no catalog_state row works (revision 1)', { timeout: T }, async () => {
    const env = setup12({ catalog: {} });
    expect((await call(env, 'createPanel', pBody())).revision).toBe(1);
    expect(env.db.revisionOf(TENANT_A)).toBe(1);
  });

  it.each([[' padded '], ['MiXeD'], ['a-b.c+d_1']])('code %j is trimmed and upper-cased on write (orderable regex allows - . + _)', { timeout: T }, async (raw) => {
    const env = setup12();
    const out = await call(env, 'createPanel', pBody({ code: raw }));
    expect(out.code).toBe(raw.trim().toUpperCase());
    expect(env.db.row('orderables', out.id)!['code']).toBe(raw.trim().toUpperCase());
  });

  it.each([
    ['empty', ''], ['blank', '   '], ['space inside', 'bad code'], ['leading hyphen', '-X'], ['leading underscore', '_X'], ['33 chars', 'x'.repeat(33)], ['slash', 'A/B'],
    ['dotless i (case-fold forgery)', 'ıdx'], ['long s (case-fold forgery)', 'ſugar'], ['fullwidth letters', 'ＡＢＣ'], ['newline', 'A\nB'], ['number', 123], ['null', null], ['object', { a: 1 }],
  ])('invalid code (%s) -> 400 path /code, nothing written', { timeout: T }, async (_n, code) => {
    const env = setup12(); const before = snap(env.db);
    const e = await rejection(call(env, 'createPanel', { ...pBody(), code }));
    validation400(e);
    if (e.code === 'common.validation_failed') expect(errPaths(e)).toContain('/code');
    expect(snap(env.db)).toBe(before);
  });

  it.each(['code', 'name', 'panel_kind', 'members'])('missing required %s -> 400 path /%s', { timeout: T }, async (field) => {
    const env = setup12(); const before = snap(env.db);
    const e = await rejection(call(env, 'createPanel', pBody({ [field]: undefined })));
    validation400(e);
    if (e.code === 'common.validation_failed') expect(errPaths(e)).toContain(`/${field}`);
    expect(snap(env.db)).toBe(before);
  });

  it.each([
    ['name empty', { name: '' }], ['name 201', { name: 'n'.repeat(201) }], ['name number', { name: 5 }], ['panel_kind unknown', { panel_kind: 'bundle' }], ['panel_kind case', { panel_kind: 'Package' }],
    ['sex_restriction unknown', { sex_restriction: 'other' }], ['sex_restriction case', { sex_restriction: 'Male' }], ['sex_restriction null', { sex_restriction: null }],
    ['department_id not a uuid', { department_id: 'nope' }], ['members not an array', { members: {} }], ['members null', { members: null }],
  ])('invalid field: %s -> 400 before any write (the service validates itself; import commits call it directly)', { timeout: T }, async (_n, over) => {
    const env = setup12(); const before = snap(env.db);
    validation400(await rejection(call(env, 'createPanel', pBody(over))));
    expect(snap(env.db)).toBe(before);
  });

  it.each([
    ['tenant_id', TENANT_B], ['id', ID(0xbad)], ['kind', 'test'], ['version', 9], ['revision', 5], ['created_by', USER], ['updated_at', '2020-01-01T00:00:00.000Z'], ['is_active', false],
    ['is_orderable', false], ['status', 'published'], ['department_code', 'X'], ['workflow_type', 'standard'], ['__proto__x', 1],
  ])('S-5 mass assignment: undeclared field %s -> 400, nothing written', { timeout: T }, async (k, v) => {
    const env = setup12(); const before = snap(env.db);
    validation400(await rejection(call(env, 'createPanel', { ...pBody(), [k]: v })));
    expect(snap(env.db)).toBe(before);
  });

  it('SQL stays parameterised: quote/semicolon in name round-trips verbatim and the code/name never appear in statement text', { timeout: T }, async () => {
    const env = setup12();
    const planted = "O'Brien; DROP TABLE x;--";
    const out = await call(env, 'createPanel', pBody({ name: planted, code: 'plant' }));
    expect(out.name).toBe(planted);
    expect(env.db.row('orderables', out.id)!['name']).toBe(planted);
    for (const s of env.db.stmts) { expect(s.text).not.toContain('DROP TABLE'); expect(s.text).not.toContain('PLANT'); }
  });

  it('error detail never echoes submitted values (AB-20)', { timeout: T }, async () => {
    const env = setup12();
    const planted = 'PLANTED-VALUE-7f3a';
    for (const over of [{ code: planted + ' bad!' }, { name: 5, panel_kind: planted }, { members: [{ kind: planted, orderable_id: planted, sort_order: 1 }] }, { department_id: planted }]) {
      const e = await rejection(call(env, 'createPanel', pBody(over)));
      expect(JSON.stringify({ m: e.message, d: e.detail, errs: e.errors })).not.toContain('PLANTED-VALUE');
    }
  });

  it('every SELECT/UPDATE/DELETE on the panel tables carries an explicit tenant_id = $n predicate and every INSERT binds the tenant (defence in depth under RLS)', { timeout: T }, async () => {
    const env = setup12();
    await call(env, 'createPanel', pBody({ members: [mem('test', TC.test.id, 1), mem('panel', LIPID.panel.id, 2)] }));
    const own = panelStmts(env.db);
    expect(own.length).toBeGreaterThan(0);
    for (const s of own.filter((x) => /^\s*(SELECT|UPDATE|DELETE)/i.test(x.text))) expect(s.text, s.text).toMatch(/\btenant_id\s*=\s*\$\d+/i);
    for (const s of own.filter((x) => /^\s*INSERT/i.test(x.text))) expect(s.values).toContain(TENANT_A);
  });

  // ---- one code space for tests AND panels
  it('the same code in any case -> 409 catalog.code_duplicate; no second row, no event, no revision bump', { timeout: T }, async () => {
    const env = setup12();
    const before = snap(env.db);
    for (const variant of ['lipid', 'LIPID', ' Lipid ']) lims(await rejection(call(env, 'createPanel', pBody({ code: variant }))), 'catalog.code_duplicate', 409);
    expect(snap(env.db)).toBe(before);
  });
  it('a TEST already owns the code, or an INACTIVE panel does -> 409 catalog.code_duplicate (one code space for tests and panels)', { timeout: T }, async () => {
    const env = setup12();
    lims(await rejection(call(env, 'createPanel', pBody({ code: 'cbc' }))), 'catalog.code_duplicate', 409);
    lims(await rejection(call(env, 'createPanel', pBody({ code: 'dead' }))), 'catalog.code_duplicate', 409);
    expect(env.db.rows('panels', TENANT_A)).toHaveLength(4);
  });
  it('tenant B owning the code does not block tenant A; B is untouched', { timeout: T }, async () => {
    const env = setup12();
    const out = await call(env, 'createPanel', pBody({ code: 'bpanel' }));
    expect(out.code).toBe('BPANEL');
    expect(env.db.rows('orderables', TENANT_B).filter((r) => r['kind'] === 'panel')).toHaveLength(1);
    expect(events(env.db, TENANT_B)).toHaveLength(0);
  });
  it('race: two concurrent creates of the same code -> exactly one wins, the loser gets catalog.code_duplicate (not a raw 23505), one event, no orphan rows', { timeout: T }, async () => {
    const env = setup12();
    const res = await Promise.allSettled([call(env, 'createPanel', pBody()), call(env, 'createPanel', pBody({ code: 'NewP' }))]);
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    lims((res.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason, 'catalog.code_duplicate', 409);
    expect(env.db.rows('panels', TENANT_A)).toHaveLength(5);
    expect(env.db.rows('panel_members', TENANT_A)).toHaveLength(10 + 2);                          // the 10 seeded A rows + the winner's 2
    expect(events(env.db)).toHaveLength(1); expect(env.db.revisionOf(TENANT_A)).toBe(SEED_REVISION + 1);
  });
  it('concurrent creates of DIFFERENT codes both succeed with gapless revisions 418 and 419', { timeout: T }, async () => {
    const env = setup12();
    const out = await Promise.all([call(env, 'createPanel', pBody({ code: 'c1' })), call(env, 'createPanel', pBody({ code: 'c2' }))]);
    expect(out.map((o) => o.revision).sort()).toEqual([SEED_REVISION + 1, SEED_REVISION + 2]);
  });

  // ---- references: S-1 + inactive members
  it.each([['department of tenant B', { department_id: HAEM_B.id }], ['unknown department', { department_id: ID(0xdead) }]])('S-1: %s -> 404 common.not_found, nothing written', { timeout: T }, async (_n, over) => {
    const env = setup12(); const before = snap(env.db);
    lims(await rejection(call(env, 'createPanel', pBody(over))), 'common.not_found', 404);
    expect(snap(env.db)).toBe(before);
  });
  it('department is optional (a package without department) and sex_restriction is optional', { timeout: T }, async () => {
    const env = setup12();
    const out = await call(env, 'createPanel', pBody({ code: 'nodept' }));
    expect(env.db.row('orderables', out.id)).toMatchObject({ department_id: null, sex_restriction: null });
  });
});

// ============================================================================================================ member rules (create + replace)
describe.each([['createPanel'], ['replacePanelMembers']])('member rules — %s', (op) => {
  const run = (env: Env12, members: unknown) => (op === 'createPanel' ? call(env, 'createPanel', pBody({ members })) : replace(env, BASIC.panel.id, members));

  it.each([
    ['empty list', []], ['not an array', { kind: 'test' }], ['member is a string', ['x']], ['member is null', [null]],
    ['kind missing', [{ orderable_id: TC.test.id, sort_order: 1 }]], ['kind unknown', [{ kind: 'analyte', orderable_id: TC.test.id, sort_order: 1 }]],
    ['orderable_id missing', [{ kind: 'test', sort_order: 1 }]], ['orderable_id not a uuid', [{ kind: 'test', orderable_id: 'nope', sort_order: 1 }]],
    ['sort_order missing', [{ kind: 'test', orderable_id: TC.test.id }]], ['sort_order -1', [mem('test', TC.test.id, -1)]], ['sort_order 10000', [mem('test', TC.test.id, 10000)]],
    ['sort_order 1.5', [mem('test', TC.test.id, 1.5)]], ['sort_order string', [{ kind: 'test', orderable_id: TC.test.id, sort_order: '1' }]],
    ['undeclared member field (status)', [{ ...mem('test', TC.test.id, 1), status: 'active' }]], ['undeclared member field (tenant_id)', [{ ...mem('test', TC.test.id, 1), tenant_id: TENANT_B }]],
    ['the same orderable twice', [mem('test', TC.test.id, 1), mem('test', TC.test.id, 2)]],
    ['101 members', Array.from({ length: 101 }, (_v, i) => mem('test', ID(0x7000 + i), i))],
  ])('invalid members (%s) -> 400, path under /members, nothing written', { timeout: T }, async (_n, members) => {
    const env = setup12(); const before = snap(env.db);
    const e = await rejection(run(env, members));
    validation400(e);
    if (e.code === 'common.validation_failed') expect(errPaths(e).some((p) => p === '/members' || p.startsWith('/members/')), String(errPaths(e))).toBe(true);
    expect(snap(env.db)).toBe(before);
  });

  it('a member whose kind does not match the orderable (a panel id sent as test, a test id sent as panel) -> 400 under /members/0, nothing written [ASSUMPTION: spec silent]', { timeout: T }, async () => {
    const env = setup12(); const before = snap(env.db);
    for (const members of [[mem('test', LIPID.panel.id, 1)], [mem('panel', TC.test.id, 1)]]) {
      const e = await rejection(run(env, members));
      validation400(e);
      if (e.code === 'common.validation_failed') expect(errPaths(e).some((p) => p.startsWith('/members/0')), String(errPaths(e))).toBe(true);
    }
    expect(snap(env.db)).toBe(before);
  });

  it.each([['unknown test', mem('test', ID(0xdead), 1)], ['unknown panel', mem('panel', ID(0xdead), 1)], ['test of tenant B', mem('test', TEST_B.test.id, 1)], ['panel of tenant B', mem('panel', PANEL_B.panel.id, 1)]])(
    'S-1: %s -> 404 common.not_found (tenant B ids are indistinguishable from unknown), nothing written', { timeout: T }, async (_n, m) => {
      const env = setup12(); const before = snap(env.db);
      lims(await rejection(run(env, [mem('test', TC.test.id, 1), m])), 'common.not_found', 404);
      expect(snap(env.db)).toBe(before);
    });

  it('an inactive TEST member -> 409 catalog.test_inactive (AC-07.5 at write time), nothing written', { timeout: T }, async () => {
    const env = setup12(); const before = snap(env.db);
    lims(await rejection(run(env, [mem('test', TC.test.id, 1), mem('test', OLD.test.id, 2)])), 'catalog.test_inactive', 409);
    expect(snap(env.db)).toBe(before);
  });
  it('an inactive PANEL member -> 409 catalog.test_inactive, nothing written', { timeout: T }, async () => {
    const env = setup12(); const before = snap(env.db);
    lims(await rejection(run(env, [mem('test', TC.test.id, 1), mem('panel', DEAD.panel.id, 2)])), 'catalog.test_inactive', 409);
    expect(snap(env.db)).toBe(before);
  });
  it('an inactive member that is NOT in the new list does not block the write (only the new members are checked)', { timeout: T }, async () => {
    const env = setup12({ t6: { panel_members: [pmb(BASIC.panel.id, OLD.test.id, TENANT_A, 9)] } });
    const out = await run(env, [mem('test', TC.test.id, 1)]);
    expect(out.members).toEqual([mem('test', TC.test.id, 1)]);
  });
  it('a non-orderable but active test is a valid member', { timeout: T }, async () => {
    const hidden = tst(300, TENANT_A, BIOC.id, { code: 'HIDDEN', is_orderable: false });
    const env = setup12({ t6: { orderables: [hidden.orderable], tests: [hidden.test] } });
    const out = await run(env, [mem('test', hidden.test.id, 1)]);
    expect(out.members).toHaveLength(1);
  });
  it('exactly 100 members is allowed, and the statement count does not grow with the member count (no N+1)', { timeout: T }, async () => {
    const bulk = Array.from({ length: 100 }, (_v, i) => tst(500 + i, TENANT_A, BIOC.id, { code: `BULK${i}` }));
    const big = setup12({ t6: { orderables: bulk.map((t) => t.orderable), tests: bulk.map((t) => t.test) } });
    const small = setup12({ t6: { orderables: bulk.map((t) => t.orderable), tests: bulk.map((t) => t.test) } });
    const out = await run(big, bulk.map((t, i) => mem('test', t.test.id, i)));
    await run(small, [mem('test', bulk[0]!.test.id, 0), mem('test', bulk[1]!.test.id, 1)]);
    expect(out.members).toHaveLength(100);
    expect(big.db.stmts.length).toBeLessThanOrEqual(small.db.stmts.length + 5);
  });
});

// ============================================================================================================ replacePanelMembers
describe('replacePanelMembers (#56) — AC-07.3 cycle, AC-07.4 depth', () => {
  it('replaces the member set as a whole: new members in sort_order, old ones gone, version 2, panel row + orderable row updated, revision bumped once', { timeout: T }, async () => {
    const env = setup12();
    const out = await replace(env, BASIC.panel.id, [mem('test', FBS.test.id, 5), mem('test', A1C.test.id, 1), mem('panel', LIPID.panel.id, 3)]);
    expect(out.members).toEqual([mem('test', A1C.test.id, 1), mem('panel', LIPID.panel.id, 3), mem('test', FBS.test.id, 5)]);
    expect(out).toMatchObject({ id: BASIC.panel.id, code: 'BASIC', version: 2, revision: SEED_REVISION + 1 });
    expect(membersOf(env.db, BASIC.panel.id)).toEqual([A1C.test.id, LIPID.panel.id, FBS.test.id]);
    expect(env.db.row('panels', BASIC.panel.id)!['version']).toBe(2);
    expect(env.db.orderableRevision(BASIC.panel.id)).toBe(SEED_REVISION + 1);
    expect(env.db.revisionOf(TENANT_A)).toBe(SEED_REVISION + 1);
  });

  it('publishes ONE catalog.changed.v1 {entity_type panel, entity_id = the panel, change_kind updated}; panels that CONTAIN the changed panel are not re-stamped (TRD §3)', { timeout: T }, async () => {
    const env = setup12();
    await replace(env, LIPID.panel.id, [mem('test', TC.test.id, 1)]);
    const ev = events(env.db);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.envelope.payload).toMatchObject({ catalog_revision: SEED_REVISION + 1, entity_type: 'panel', entity_id: LIPID.panel.id, change_kind: 'updated' });
    expect(env.db.orderableRevision(HP_ELITE_M.panel.id)).toBe(0);           // HP_ELITE_M contains LIPID, untouched
    expect(env.db.row('panels', HP_ELITE_M.panel.id)!['version']).toBe(1);
  });

  it('re-adding an existing member with a new sort_order, and the same list again, both work (no PK clash from the replace)', { timeout: T }, async () => {
    const env = setup12();
    await replace(env, BASIC.panel.id, [mem('test', FBS.test.id, 1), mem('test', CBC.test.id, 2)]);
    const out = await replace(env, BASIC.panel.id, [mem('test', FBS.test.id, 1), mem('test', CBC.test.id, 2)], 2);
    expect(out.version).toBe(3);
    expect(membersOf(env.db, BASIC.panel.id)).toEqual([FBS.test.id, CBC.test.id]);
  });

  it('AC-07.3: P1 contains P2; adding P1 into P2 -> 422 catalog.panel_cycle; membership, version, revision and events are all unchanged', { timeout: T }, async () => {
    const p1 = pnl(60, TENANT_A, { code: 'P1' }), p2 = pnl(61, TENANT_A, { code: 'P2' });
    const env = setup12({ t6: { orderables: [p1.orderable, p2.orderable], panels: [p1.panel, p2.panel], panel_members: [pmb(p1.panel.id, p2.panel.id, TENANT_A, 1), pmb(p2.panel.id, TC.test.id, TENANT_A, 1)] } });
    const before = snap(env.db);
    lims(await rejection(replace(env, p2.panel.id, [mem('test', TC.test.id, 1), mem('panel', p1.panel.id, 2)])), 'catalog.panel_cycle', 422);
    expect(snap(env.db)).toBe(before);
    expect(membersOf(env.db, p2.panel.id)).toEqual([TC.test.id]);
    expect(env.db.row('panels', p2.panel.id)!['version']).toBe(1);
  });
  it('a panel as a member of itself -> 422 catalog.panel_cycle (not a raw check-constraint 500), nothing written', { timeout: T }, async () => {
    const env = setup12(); const before = snap(env.db);
    lims(await rejection(replace(env, BASIC.panel.id, [mem('test', CBC.test.id, 1), mem('panel', BASIC.panel.id, 2)])), 'catalog.panel_cycle', 422);
    expect(snap(env.db)).toBe(before);
  });
  it('indirect cycles: last panel of a 3-chain and of a 4-chain pointing back at the first -> 422', { timeout: T }, async () => {
    for (const n of [3, 4]) {
      const c = chainSeed('k', n, 100 + n * 10);
      const env = setup12({ t6: c.rows }); const before = snap(env.db);
      lims(await rejection(replace(env, c.ids[n - 1]!, [mem('panel', c.ids[0]!, 1)])), 'catalog.panel_cycle', 422);
      expect(snap(env.db)).toBe(before);
    }
  });
  it('a cycle through the panel\'s ANCESTORS: HP_ELITE_M contains LIPID, so putting HP_ELITE_M into LIPID -> 422', { timeout: T }, async () => {
    const env = setup12(); const before = snap(env.db);
    lims(await rejection(replace(env, LIPID.panel.id, [mem('test', TC.test.id, 1), mem('panel', HP_ELITE_M.panel.id, 2)])), 'catalog.panel_cycle', 422);
    expect(snap(env.db)).toBe(before);
  });
  it('a diamond is NOT a cycle: BASIC and LIPID both contained by a new package that also holds the shared CBC is fine', { timeout: T }, async () => {
    const env = setup12();
    const out = await replace(env, BASIC.panel.id, [mem('panel', LIPID.panel.id, 1)]);                 // HP_ELITE_M ⊃ LIPID and BASIC ⊃ LIPID: LIPID has two parents
    expect(out.members).toEqual([mem('panel', LIPID.panel.id, 1)]);
  });
  it('a list that is both cyclic and holds an inactive member is rejected (422 cycle or 409 inactive) and never partially written', { timeout: T }, async () => {
    const env = setup12(); const before = snap(env.db);
    const e = await rejection(replace(env, LIPID.panel.id, [mem('panel', LIPID.panel.id, 1), mem('test', OLD.test.id, 2)]));
    expect(['catalog.panel_cycle', 'catalog.test_inactive']).toContain(e.code);
    expect(snap(env.db)).toBe(before);
  });

  it('race: P1 := [P2] and P2 := [P1] at the same time -> exactly one commits, the other gets 422 catalog.panel_cycle; the stored graph stays acyclic (one revision, one event)', { timeout: T }, async () => {
    const p1 = pnl(70, TENANT_A, { code: 'RACE1' }), p2 = pnl(71, TENANT_A, { code: 'RACE2' });
    const env = setup12({ t6: { orderables: [p1.orderable, p2.orderable], panels: [p1.panel, p2.panel], panel_members: [pmb(p1.panel.id, TC.test.id, TENANT_A, 1), pmb(p2.panel.id, TC.test.id, TENANT_A, 1)] } });
    const res = await Promise.allSettled([replace(env, p1.panel.id, [mem('panel', p2.panel.id, 1)]), replace(env, p2.panel.id, [mem('panel', p1.panel.id, 1)])]);
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    lims((res.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason, 'catalog.panel_cycle', 422);
    const both = [membersOf(env.db, p1.panel.id), membersOf(env.db, p2.panel.id)];
    expect(both.filter((m) => m.length === 1 && m[0] !== TC.test.id)).toHaveLength(1);              // exactly one panel points at the other
    expect(events(env.db)).toHaveLength(1); expect(env.db.revisionOf(TENANT_A)).toBe(SEED_REVISION + 1);
  });
  it('race: two replaces of the same panel with the same If-Match -> one 200, one 409 common.version_conflict; the winner\'s members stay intact', { timeout: T }, async () => {
    const env = setup12();
    const res = await Promise.allSettled([replace(env, BASIC.panel.id, [mem('test', TC.test.id, 1)]), replace(env, BASIC.panel.id, [mem('test', HDL.test.id, 1)])]);
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    lims((res.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason, 'common.version_conflict', 409);
    expect(membersOf(env.db, BASIC.panel.id)).toHaveLength(1);
    expect(env.db.row('panels', BASIC.panel.id)!['version']).toBe(2);
    expect(events(env.db)).toHaveLength(1);
  });

  // ---- AC-07.4 depth
  // DEPTH UNIT (02-TRD §11: 4 = "package -> panel -> panel -> test", levels INCLUDING the leaf test; T-12-review item 1): at most 3 panels on a chain.
  it('AC-07.4: nesting depth > 4 levels (incl. the leaf test) -> 400 common.validation_failed with path /members (a new link makes the chain 4 panels deep); nothing written', { timeout: T }, async () => {
    const c = chainSeed('d', 3);                                           // d1 ⊃ d2 ⊃ d3 ⊃ test: already 4 levels
    const env = setup12({ t6: c.rows }); const before = snap(env.db);
    const e = await rejection(replace(env, BASIC.panel.id, [mem('panel', c.ids[0]!, 1)]));         // BASIC + 3 = 4 panels = 5 levels
    expect(e.statusCode).toBe(400); expect(e.code).toBe('common.validation_failed');
    expect(errPaths(e)).toContain('/members');
    expect(snap(env.db)).toBe(before);
  });
  it('depth counts the ANCESTORS above the edited panel: u1 ⊃ u2, then u2 := [c1 ⊃ c2 ⊃ c3] makes 5 panels -> 400 /members; u2 := [c2] (4 panels) -> 400; u2 := [c3] (3 panels) -> ok', { timeout: T }, async () => {
    const u = chainSeed('u', 2, 200), c = chainSeed('c', 3, 300);
    const env = setup12({ t6: { orderables: [...u.rows.orderables!, ...c.rows.orderables!], panels: [...u.rows.panels!, ...c.rows.panels!], panel_members: [...u.rows.panel_members!, ...c.rows.panel_members!] } });
    const before = snap(env.db);
    for (const target of [c.ids[0]!, c.ids[1]!]) {
      const e = await rejection(replace(env, u.ids[1]!, [mem('panel', target, 1)]));
      expect(e.code).toBe('common.validation_failed'); expect(e.statusCode).toBe(400); expect(errPaths(e)).toContain('/members');
    }
    expect(snap(env.db)).toBe(before);
    const ok = await replace(env, u.ids[1]!, [mem('panel', c.ids[2]!, 1)]);                          // u1,u2,c3 = 3 panels = 4 levels with the test
    expect(ok.members).toEqual([mem('panel', c.ids[2]!, 1)]);
  });
  it('4 levels incl. the leaf test (3 panels on a chain) is allowed; package -> panel -> panel -> test (the TRD §11 example) is allowed', { timeout: T }, async () => {
    const c = chainSeed('e', 2);
    const env = setup12({ t6: c.rows });
    const out = await replace(env, BASIC.panel.id, [mem('panel', c.ids[0]!, 1)]);                  // BASIC + e1,e2 = 3 panels -> test
    expect(out.members).toEqual([mem('panel', c.ids[0]!, 1)]);
    const pkg = await call(env, 'createPanel', pBody({ code: 'pkg3', panel_kind: 'package', members: [mem('panel', LIPID.panel.id, 1)] }));
    expect(pkg.members).toHaveLength(1);                                                            // package -> LIPID -> test (3 levels)
  });
  it('createPanel enforces the same depth: a new panel over a 3-chain is 4 panels (5 levels) -> 400 /members, nothing written', { timeout: T }, async () => {
    const c = chainSeed('f', 3);
    const env = setup12({ t6: c.rows }); const before = snap(env.db);
    const e = await rejection(call(env, 'createPanel', pBody({ members: [mem('panel', c.ids[0]!, 1)] })));
    expect(e.code).toBe('common.validation_failed'); expect(e.statusCode).toBe(400); expect(errPaths(e)).toContain('/members');
    expect(snap(env.db)).toBe(before);
  });
  it('when a list is both cyclic and (in the stored data) too deep, the cycle wins: 422 catalog.panel_cycle, not 400 [ASSUMPTION: TRD §7.7 lists the cycle first]', { timeout: T }, async () => {
    const c = chainSeed('g', 5);
    const env = setup12({ t6: c.rows });
    expect((await rejection(replace(env, c.ids[4]!, [mem('panel', c.ids[0]!, 1)]))).code).toBe('catalog.panel_cycle');
  });

  // ---- optimistic concurrency, tenant isolation, atomicity
  it('no If-Match -> 428 common.precondition_required; stale -> 409 common.version_conflict; nothing written either way', { timeout: T }, async () => {
    const env = setup12(); const before = snap(env.db);
    lims(await rejection(replaceRaw(env, BASIC.panel.id, [mem('test', TC.test.id, 1)], undefined)), 'common.precondition_required', 428);
    lims(await rejection(replace(env, BASIC.panel.id, [mem('test', TC.test.id, 1)], 2)), 'common.version_conflict', 409);
    expect(snap(env.db)).toBe(before);
  });
  it.each([[0], [-1], [1.5], [2147483648], ['1'], [null], [Number.NaN]])('malformed expectedVersion %j -> 400, never a write', { timeout: T }, async (v) => {
    const env = setup12(); const before = snap(env.db);
    const e = await rejection(replace(env, BASIC.panel.id, [mem('test', TC.test.id, 1)], v as never));
    expect(e.statusCode).toBe(400);
    expect(snap(env.db)).toBe(before);
  });
  it('S-1: the id of a tenant B panel, a test id, an unknown id, a non-uuid -> 404 / 400; B untouched', { timeout: T }, async () => {
    const env = setup12(); const before = snap(env.db);
    for (const id of [PANEL_B.panel.id, TC.test.id, ID(0xdead)]) lims(await rejection(replace(env, id, [mem('test', TC.test.id, 1)])), 'common.not_found', 404);
    expect((await rejection(replace(env, 'not-a-uuid', [mem('test', TC.test.id, 1)]))).statusCode).toBe(400);
    expect(snap(env.db)).toBe(before);
    expect(membersOf(env.db, PANEL_B.panel.id)).toEqual([TEST_B.test.id]);
  });
  it('a failing member insert or event insert rolls back the delete of the old members too (old members intact, version 1, no event)', { timeout: T }, async () => {
    for (const re of [/INSERT INTO catalog\.panel_members/i, /INSERT INTO core\.event_log/i]) {
      const env = setup12(); const before = snap(env.db);
      env.db.fail(re);
      await rejection(replace(env, BASIC.panel.id, [mem('test', TC.test.id, 1)]));
      expect(snap(env.db)).toBe(before);
      expect(membersOf(env.db, BASIC.panel.id)).toEqual([CBC.test.id, FBS.test.id]);
    }
  });
  it('every SELECT/UPDATE/DELETE on the panel tables carries an explicit tenant_id = $n predicate (defence in depth under RLS)', { timeout: T }, async () => {
    const env = setup12();
    await replace(env, BASIC.panel.id, [mem('test', TC.test.id, 1), mem('panel', LIPID.panel.id, 2)]);
    const own = panelStmts(env.db).filter((x) => /^\s*(SELECT|UPDATE|DELETE)/i.test(x.text));
    expect(own.length).toBeGreaterThan(0);
    for (const s of own) expect(s.text, s.text).toMatch(/\btenant_id\s*=\s*\$\d+/i);
  });
  it('S-5: undeclared body fields -> 400 and nothing written', { timeout: T }, async () => {
    const env = setup12(); const before = snap(env.db);
    for (const extra of [{ tenant_id: TENANT_B }, { panel_id: LIPID.panel.id }, { version: 9 }, { name: 'x' }]) {
      validation400(await rejection(call(env, 'replacePanelMembers', { id: BASIC.panel.id, expectedVersion: 1, body: { members: [mem('test', TC.test.id, 1)], ...extra } })));
    }
    validation400(await rejection(call(env, 'replacePanelMembers', { id: BASIC.panel.id, expectedVersion: 1, body: {} })));
    expect(snap(env.db)).toBe(before);
  });
});

// ============================================================================================================ getPanelDetail
describe('getPanelDetail (#54)', () => {
  it('returns the Panel DTO: members in sort_order with kind + orderable_id + sort_order, department_code, sex_restriction, revision = orderables.revision, version', { timeout: T }, async () => {
    const env = setup12();
    const p = await call(env, 'getPanelDetail', { id: HP_ELITE_M.panel.id });
    expect(p).toEqual({ id: HP_ELITE_M.panel.id, kind: 'panel', code: 'HP_ELITE_M', name: 'Health package elite male', panel_kind: 'package', sex_restriction: 'male', is_orderable: true, is_active: true,
      revision: 0, version: 1, members: [mem('test', CBC.test.id, 1), mem('panel', LIPID.panel.id, 2), mem('test', FBS.test.id, 3)] });
    const l = await call(env, 'getPanelDetail', { id: LIPID.panel.id });
    expect(l).toMatchObject({ code: 'LIPID', panel_kind: 'clinical', department_id: BIOC.id, department_code: 'BIOC' });
    expect(l.members.map((m: any) => m.orderable_id)).toEqual([TC, HDL, TG, LDL].map((t) => t.test.id));
  });
  it('members come back in sort_order whatever the insertion order was', { timeout: T }, async () => {
    const p = pnl(80, TENANT_A, { code: 'SHUF' });
    const env = setup12({ t6: { orderables: [p.orderable], panels: [p.panel], panel_members: [pmb(p.panel.id, LDL.test.id, TENANT_A, 30), pmb(p.panel.id, TC.test.id, TENANT_A, 10), pmb(p.panel.id, TG.test.id, TENANT_A, 20)] } });
    expect((await call(env, 'getPanelDetail', { id: p.panel.id })).members.map((m: any) => m.sort_order)).toEqual([10, 20, 30]);
  });
  it('an inactive panel is readable (is_active false)', { timeout: T }, async () => {
    const env = setup12();
    expect(await call(env, 'getPanelDetail', { id: DEAD.panel.id })).toMatchObject({ code: 'DEAD', is_active: false });
  });
  it('S-1: tenant B panel, a TEST id, an unknown id -> 404 common.not_found; a non-uuid -> 400; no write, no event', { timeout: T }, async () => {
    const env = setup12();
    for (const id of [PANEL_B.panel.id, TC.test.id, ID(0xdead)]) lims(await rejection(call(env, 'getPanelDetail', { id })), 'common.not_found', 404);
    expect((await rejection(call(env, 'getPanelDetail', { id: 'x' }))).statusCode).toBe(400);
    expect((await rejection(call(env, 'getPanelDetail', {}))).statusCode).toBe(400);
    expect(env.db.events).toHaveLength(0);
    expect(env.db.t6Stmts().every((s) => /^\s*SELECT/i.test(s.text))).toBe(true);
  });
  it('a read never returns other tenants\' member rows (a tenant B member row planted under a tenant A panel id is ignored)', { timeout: T }, async () => {
    const env = setup12({ t6: { panel_members: [pmb(BASIC.panel.id, TEST_B.test.id, TENANT_B, 99)] } });
    const out = await call(env, 'getPanelDetail', { id: BASIC.panel.id });
    expect(JSON.stringify(out)).not.toContain(TEST_B.test.id);
  });
});

// ============================================================================================================ listPanels
describe('listPanels (#52)', () => {
  const codes = (r: any) => r.data.map((p: any) => p.code);
  it('default: active panels and packages of the tenant, ordered by code, each a full Panel with members; no tests, no tenant B', { timeout: T }, async () => {
    const env = setup12();
    const r = await call(env, 'listPanels', {});
    expect(codes(r)).toEqual(['BASIC', 'HP_ELITE_M', 'LIPID']);
    expect(r.data[1]).toMatchObject({ kind: 'panel', panel_kind: 'package', sex_restriction: 'male', version: 1 });
    expect(r.data[1].members).toEqual([mem('test', CBC.test.id, 1), mem('panel', LIPID.panel.id, 2), mem('test', FBS.test.id, 3)]);
    expect(r.page).toMatchObject({ limit: expect.any(Number) });
    expect(JSON.stringify(r)).not.toContain('BPANEL');
  });
  it('panel_kind filter, is_active=false / all', { timeout: T }, async () => {
    const env = setup12();
    expect(codes(await call(env, 'listPanels', { panel_kind: 'package' }))).toEqual(['HP_ELITE_M']);
    expect(codes(await call(env, 'listPanels', { panel_kind: 'clinical' }))).toEqual(['BASIC', 'LIPID']);
    expect(codes(await call(env, 'listPanels', { is_active: 'false' }))).toEqual(['DEAD']);
    expect(codes(await call(env, 'listPanels', { is_active: 'all' }))).toEqual(['BASIC', 'DEAD', 'HP_ELITE_M', 'LIPID']);
  });
  it('cursor pagination: limit 1 walks every panel once, in order, with next_cursor only while more rows exist', { timeout: T }, async () => {
    const env = setup12();
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const r = await call(env, 'listPanels', { is_active: 'all', limit: 1, ...(cursor ? { cursor } : {}) });
      expect(r.data.length).toBeLessThanOrEqual(1);
      seen.push(...codes(r));
      cursor = r.page.next_cursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(['BASIC', 'DEAD', 'HP_ELITE_M', 'LIPID']);
  });
  it.each([[{ panel_kind: 'bundle' }], [{ is_active: 'maybe' }], [{ limit: 0 }], [{ limit: 'x' }], [{ cursor: 'not-a-cursor' }], [{ sort: 'password' }], [{ tenant_id: TENANT_B }]])(
    'bad query %j -> 400 before any SQL', { timeout: T }, async (query) => {
      const env = setup12();
      expect((await rejection(call(env, 'listPanels', query))).statusCode).toBe(400);
      expect(env.db.stmts.filter((s) => s.tenantId === TENANT_A)).toHaveLength(0);
    });
  it('the number of statements does not grow with the number of panels (no N+1 for members)', { timeout: T }, async () => {
    const many = Array.from({ length: 40 }, (_v, i) => pnl(400 + i, TENANT_A, { code: `MANY${i}` }));
    const rows = { orderables: many.map((p) => p.orderable), panels: many.map((p) => p.panel), panel_members: many.map((p) => pmb(p.panel.id, TC.test.id, TENANT_A, 1)) };
    const big = setup12({ t6: rows }), small = setup12();
    await call(big, 'listPanels', { limit: 50 }); await call(small, 'listPanels', { limit: 50 });
    expect(big.db.stmts.length).toBeLessThanOrEqual(small.db.stmts.length + 1);
  });
  it('S-1: tenant B sees only its own panel and none of tenant A\'s', { timeout: T }, async () => {
    const env = setup12();
    const r = await env.db.run((ctx) => env.svc['listPanels']!(ctx, {}), { tenantId: TENANT_B });
    expect(codes(r)).toEqual(['BPANEL']);
    expect(JSON.stringify(r)).not.toContain(LIPID.panel.id);
  });
});

// ============================================================================================================ updatePanel
describe('updatePanel (#55)', () => {
  const updRaw = (env: Env12, patch: unknown, id: string, expectedVersion: unknown) => call(env, 'updatePanel', { id, expectedVersion, patch });
  const upd = (env: Env12, patch: unknown, id = BASIC.panel.id, expectedVersion: unknown = 1) => updRaw(env, patch, id, expectedVersion);

  it('renames: 200 Panel with version 2 and the new name, members untouched; one event {panel, updated}; revision bumped; orderable stamped', { timeout: T }, async () => {
    const env = setup12();
    const out = await upd(env, { name: 'Basic screen v2' });
    expect(out).toMatchObject({ id: BASIC.panel.id, name: 'Basic screen v2', code: 'BASIC', panel_kind: 'clinical', version: 2, revision: SEED_REVISION + 1 });
    expect(out.members).toEqual([mem('test', CBC.test.id, 1), mem('test', FBS.test.id, 2)]);
    expect(env.db.row('orderables', BASIC.panel.id)).toMatchObject({ name: 'Basic screen v2', revision: SEED_REVISION + 1, updated_by: USER });
    expect(env.db.row('panels', BASIC.panel.id)).toMatchObject({ version: 2 });
    const ev = events(env.db);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.envelope.payload).toMatchObject({ entity_type: 'panel', entity_id: BASIC.panel.id, change_kind: 'updated', catalog_revision: SEED_REVISION + 1 });
  });
  it('sets and unsets sex_restriction and department_id; code and panel_kind never change', { timeout: T }, async () => {
    const env = setup12();
    const a = await upd(env, { sex_restriction: 'female', department_id: BIOC.id });
    expect(a).toMatchObject({ sex_restriction: 'female', department_id: BIOC.id, department_code: 'BIOC', version: 2 });
    const b = await upd(env, { unset: ['sex_restriction', 'department_id'] }, BASIC.panel.id, 2);
    expect(b).not.toHaveProperty('sex_restriction'); expect(b).not.toHaveProperty('department_id'); expect(b).not.toHaveProperty('department_code');
    expect(b).toMatchObject({ version: 3, code: 'BASIC', panel_kind: 'clinical' });
    expect(env.db.row('orderables', BASIC.panel.id)).toMatchObject({ sex_restriction: null, department_id: null });
  });
  it('is_active false -> change_kind deactivated and BOTH rows (orderables, panels) inactive; reactivating -> updated', { timeout: T }, async () => {
    const env = setup12();
    const off = await upd(env, { is_active: false });
    expect(off.is_active).toBe(false);
    expect(env.db.row('orderables', BASIC.panel.id)!['is_active']).toBe(false); expect(env.db.row('panels', BASIC.panel.id)!['is_active']).toBe(false);
    expect(events(env.db)[0]!.envelope.payload.change_kind).toBe('deactivated');
    const on = await upd(env, { is_active: true }, BASIC.panel.id, 2);
    expect(on.is_active).toBe(true);
    expect(events(env.db)[1]!.envelope.payload.change_kind).toBe('updated');
    expect(env.db.row('orderables', BASIC.panel.id)!['is_active']).toBe(true); expect(env.db.row('panels', BASIC.panel.id)!['is_active']).toBe(true);
  });
  it('deactivating a panel that other panels contain is allowed (resolve then reports catalog.test_inactive — see panels.resolve.test.ts)', { timeout: T }, async () => {
    const env = setup12();
    expect((await upd(env, { is_active: false }, LIPID.panel.id)).is_active).toBe(false);
    expect(membersOf(env.db, HP_ELITE_M.panel.id)).toContain(LIPID.panel.id);
  });
  it('no If-Match -> 428; stale -> 409; nothing written', { timeout: T }, async () => {
    const env = setup12(); const before = snap(env.db);
    lims(await rejection(updRaw(env, { name: 'x' }, BASIC.panel.id, undefined)), 'common.precondition_required', 428);
    lims(await rejection(upd(env, { name: 'x' }, BASIC.panel.id, 2)), 'common.version_conflict', 409);
    expect(snap(env.db)).toBe(before);
  });
  it('race: two updates with the same If-Match -> one 200, one 409; one revision bump', { timeout: T }, async () => {
    const env = setup12();
    const res = await Promise.allSettled([upd(env, { name: 'first' }), upd(env, { name: 'second' })]);
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    lims((res.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason, 'common.version_conflict', 409);
    expect(env.db.revisionOf(TENANT_A)).toBe(SEED_REVISION + 1);
  });
  it.each([
    ['name empty', { name: '' }], ['name 201', { name: 'n'.repeat(201) }], ['sex_restriction unknown', { sex_restriction: 'x' }], ['department_id not a uuid', { department_id: 'nope' }],
    ['is_active string', { is_active: 'no' }], ['unset unknown field', { unset: ['name'] }], ['unset not an array', { unset: 'sex_restriction' }], ['unset 3 entries', { unset: ['sex_restriction', 'department_id', 'sex_restriction'] }],
    ['set and unset the same field', { sex_restriction: 'male', unset: ['sex_restriction'] }], ['department set and unset', { department_id: ID(0x101), unset: ['department_id'] }],
  ])('invalid patch: %s -> 400, nothing written', { timeout: T }, async (_n, patch) => {
    const env = setup12(); const before = snap(env.db);
    validation400(await rejection(upd(env, patch)));
    expect(snap(env.db)).toBe(before);
  });
  it.each([
    ['code', 'OTHER'], ['panel_kind', 'package'], ['members', []], ['id', ID(0xbad)], ['tenant_id', TENANT_B], ['kind', 'test'], ['version', 9], ['revision', 5], ['is_orderable', false],
    ['created_by', USER], ['merged_into_id', ID(1)], ['status', 'published'],
  ])('S-5 mass assignment: %s -> 400 (code and panel_kind are immutable; members only via #56), nothing written', { timeout: T }, async (k, v) => {
    const env = setup12(); const before = snap(env.db);
    validation400(await rejection(upd(env, { name: 'ok', [k]: v })));
    expect(snap(env.db)).toBe(before);
  });
  it.each([['department of tenant B', { department_id: HAEM_B.id }], ['unknown department', { department_id: ID(0xdead) }]])('S-1: %s -> 404, nothing written', { timeout: T }, async (_n, patch) => {
    const env = setup12(); const before = snap(env.db);
    lims(await rejection(upd(env, patch)), 'common.not_found', 404);
    expect(snap(env.db)).toBe(before);
  });
  it('S-1: tenant B panel, a test id, an unknown id -> 404; B\'s panel untouched', { timeout: T }, async () => {
    const env = setup12(); const before = snap(env.db);
    for (const id of [PANEL_B.panel.id, TC.test.id, ID(0xdead)]) lims(await rejection(upd(env, { name: 'hijack' }, id)), 'common.not_found', 404);
    expect(snap(env.db)).toBe(before);
    expect(env.db.row('orderables', PANEL_B.panel.id)).toMatchObject({ name: 'Tenant B panel', tenant_id: TENANT_B });
    expect(env.db.row('panels', PANEL_B.panel.id)!['version']).toBe(1);
  });
  it('a failing event insert rolls the update back', { timeout: T }, async () => {
    const env = setup12(); const before = snap(env.db);
    env.db.fail(/INSERT INTO core\.event_log/i);
    await rejection(upd(env, { name: 'x' }));
    expect(snap(env.db)).toBe(before);
  });
  it('every statement on the panel tables carries an explicit tenant_id = $n predicate', { timeout: T }, async () => {
    const env = setup12();
    await upd(env, { name: 'x', is_active: false });
    for (const s of panelStmts(env.db).filter((x) => /^\s*(SELECT|UPDATE|DELETE)/i.test(x.text))) expect(s.text, s.text).toMatch(/\btenant_id\s*=\s*\$\d+/i);
  });
});
