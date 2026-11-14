// T-11 (C3) — formula validation inside the analyte-version mutations: createAnalyte (#29), updateAnalyteVersionDraft (#33), publishAnalyteVersion (#34).
// Spec: 06-PLAN T-11 (grammar errors, unknown refs, non-numeric target, cycle path, chain depth, dependency order; `formula_dependencies` written at publish), 02-TRD §5.2 rows 29/33/34
//       (422 catalog.formula_invalid on mutations), §7.1 (Stored: formula_expression whitespace-normalised, formula_inputs = refs in order of first appearance, formula_input_units = {code: unit_code}
//       of each input's effective version at publish), §7.2 (graph from published + scheduled formula_dependencies, A's edges replaced by the draft's; cycle error
//       {path:'/formula_expression', message:'cycle: B -> A -> B'}; chain depth > 5 -> "formula chain too deep"; edges inserted BEFORE the status UPDATE), PRD AC-04.1–04.7,
//       07-SECURITY S-1, S-5, AB-9 (published rows immutable), AB-17.
// Real core createEvents + T-03 revision service over the SQL fake. Service under test: createAnalyteVersionsService (T-07; the writer wires formulas.service.ts into it — no new seam
// beyond: formula_input_codes in the AnalyteVersion DTO, formula_inputs / formula_input_units columns written). Permissions are the handler's (T-07 / T-09 tests).
// ASSUMPTIONS (spec silent; see .orchestra/notes/C3.T-11-tests.md): a draft PATCH validates the formula it would store (#33 lists 422); validation errors outrank nothing but the state errors
//   (non-draft -> 409 first); a formula with a non-numeric target is 422 catalog.formula_invalid (AC-04.5), not 400; two concurrent publishes that would together close a cycle must not both succeed
//   (some per-tenant serialisation — the TRD leaves the mechanism open).
import { describe, expect, it } from 'vitest';
import { formulaRefs, parseFormula } from '../../../../../../../packages/shared-ts/src/formula/index.js';
import { USER } from '../helpers/catalogDb.js';
import { errPaths, events, lims, rejection } from '../helpers/t6.js';
import { A, CBC, HB, MICRO, RBC, chain, draftOf, fnode, leaf, pubOf, snap, world, type Env7 } from '../helpers/t11.js';
import { ID, T, ana, orderableRev, pBody } from '../helpers/t7.js';

const patch = (e: Env7, id: unknown, p: Record<string, unknown>, ev = 1) => e.db.run((ctx) => e.svc['updateAnalyteVersionDraft']!(ctx, { id, expectedVersion: ev, patch: p }));
const publish = (e: Env7, id: unknown, body: Record<string, unknown> = pBody({ change_reason: 'initial release' }), ev = 1) =>
  e.db.run((ctx) => e.svc['publishAnalyteVersion']!(ctx, { id, expectedVersion: ev, body }));
const create = (e: Env7, body: Record<string, unknown>, testId: unknown = CBC.test.id) => e.db.run((ctx) => e.svc['createAnalyte']!(ctx, { test_id: testId, body }));
/** 422 catalog.formula_invalid at …/formula_expression; returns the error. */
const invalid = (x: any, ...needles: Array<string | RegExp>) => {
  lims(x, 'catalog.formula_invalid', 422);
  expect(errPaths(x)[0], JSON.stringify(x.errors)).toMatch(/\/formula_expression$/);
  const msg = JSON.stringify(x.errors ?? []);
  for (const n of needles) expect(msg).toMatch(n instanceof RegExp ? n : new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  return x;
};
const nest = (n: number) => '('.repeat(n) + 'MCV' + ')'.repeat(n);

// ---- fixtures (synthetic) ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
const MCV = leaf(101, 'MCV', { version: { unit_code: 'fl' } });                       // RBC (base world) is 10e12_l
const [TC, HDL, TG] = [leaf(121, 'TC'), leaf(122, 'HDL'), leaf(123, 'TG')];
const TXT = leaf(131, 'TXT', { version: { result_type: 'text', decimals: null, unit_code: null } });
const GRADE = leaf(132, 'GRADE', { version: { result_type: 'ordinal', decimals: null, unit_code: null, value_set_code: 'MY_ORD' } });
const OFF = leaf(133, 'OFF', { analyte: { is_active: false } });
const MENT = ana(110, A, CBC.test.id as string, { code: 'MENTZER', name: 'Mentzer index' });
const MENT_D = draftOf(110, MENT['id'], { version_no: 1, unit_code: null, method_id: null, decimals: 1 });   // numeric draft, no formula yet
const MID = MENT_D['id'];
const TXT_AN = ana(111, A, CBC.test.id as string, { code: 'TXTF', name: 'Text analyte' });
const TXT_D = draftOf(111, TXT_AN['id'], { version_no: 1, result_type: 'text', decimals: null, unit_code: null, method_id: null });
const base = (extra: { versions?: any[]; analytes?: any[]; edges?: any[] } = {}) =>
  world([MCV, TC, HDL, TG, TXT, GRADE, OFF], { analytes: [MENT, TXT_AN, ...(extra.analytes ?? [])], versions: [MENT_D, TXT_D, ...(extra.versions ?? [])], edges: extra.edges });
const draftWith = (n: number, analyte: any, expr: string, o: Record<string, unknown> = {}) =>
  draftOf(n, analyte['id'], { version_no: 1, unit_code: null, method_id: null, decimals: 1, formula_expression: expr, ...o });

// ============================================================================================================ valid formulas: stored shape (AC-04.1, AC-04.2)
describe('valid formulas are stored normalised, with their inputs in order of first appearance (AC-04.1, AC-04.2)', () => {
  it('PATCH MENTZER draft `MCV  /   RBC` -> 200; stored `MCV / RBC` (single spaces); formula_input_codes ["MCV","RBC"] in the DTO and formula_inputs on the row; draft = no event, no revision, no edges yet', { timeout: T }, async () => {
    const e = base();
    const out = await patch(e, MID, { formula_expression: 'MCV  /   RBC' });
    expect(out).toMatchObject({ id: MID, status: 'draft', formula_expression: 'MCV / RBC', formula_input_codes: ['MCV', 'RBC'], version: 2 });
    expect(e.db.row('analyte_versions', MID)).toMatchObject({ formula_expression: 'MCV / RBC', formula_inputs: ['MCV', 'RBC'], status: 'draft' });
    expect(e.db.events).toHaveLength(0); expect(e.db.revisionOf(A)).toBe(417); expect(orderableRev(e.db, CBC.test.id)).toBe(0);
    expect(e.db.rows('formula_dependencies')).toHaveLength(0);               // edges are written at PUBLISH only (§7.2 step 6)
  });

  it('AC-04.2 LDL: `if(TG >= 400, invalid("tg_over_400"), TC - HDL - TG / 5)` is stored exactly; its inputs are TC, HDL, TG in the order the shared parser reports them (first appearance)', { timeout: T }, async () => {
    // SPEC CONFLICT (notes): AC-04.2 lists ["TC","HDL","TG"], but TG is the first ref in the text; TRD §7.1 says "order of first appearance" and C3 uses the shared parser,
    // so the order is pinned to formulaRefs(parseFormula(expr)) and the SET to {TC, HDL, TG}.
    const expr = 'if(TG >= 400, invalid("tg_over_400"), TC - HDL - TG / 5)';
    const lib = [...formulaRefs(parseFormula(expr).ast as never)];
    expect([...lib].sort()).toEqual(['HDL', 'TC', 'TG']);
    const e = base();
    const out = await patch(e, MID, { formula_expression: expr });
    expect(out['formula_expression']).toBe(expr);
    expect(out['formula_input_codes']).toEqual(lib);
    expect(e.db.row('analyte_versions', MID)!['formula_inputs']).toEqual(lib);
  });

  it('a repeated input appears once in formula_input_codes', { timeout: T }, async () => {
    const out = await patch(base(), MID, { formula_expression: 'MCV / RBC + MCV' });
    expect(out['formula_input_codes']).toEqual(['MCV', 'RBC']);
  });

  it('replacing the expression replaces the inputs; `unset: ["formula_expression"]` clears both (no stale inputs)', { timeout: T }, async () => {
    const e = base();
    await patch(e, MID, { formula_expression: 'MCV / RBC' });
    const out = await patch(e, MID, { formula_expression: 'TC - HDL' }, 2);
    expect(out['formula_input_codes']).toEqual(['TC', 'HDL']);
    const cleared = await patch(e, MID, { unset: ['formula_expression'] }, 3);
    expect(cleared).not.toHaveProperty('formula_expression');
    expect(cleared['formula_input_codes'] ?? []).toEqual([]);
    expect(e.db.row('analyte_versions', MID)!['formula_inputs'] ?? []).toEqual([]);
  });

  it('createAnalyte with a valid initial_version formula -> 201, the draft stores the normalised expression and inputs', { timeout: T }, async () => {
    const e = base();
    const out = await create(e, { code: 'ment2', name: 'Mentzer 2', initial_version: { result_type: 'numeric', decimals: 1, formula_expression: 'MCV  / RBC' } });
    expect(out['draft_version_id']).toBeDefined();
    expect(e.db.row('analyte_versions', out['draft_version_id'])).toMatchObject({ formula_expression: 'MCV / RBC', formula_inputs: ['MCV', 'RBC'], status: 'draft' });
  });

});

// ============================================================================================================ 422 catalog.formula_invalid on PATCH
describe('updateAnalyteVersionDraft — invalid formulas -> 422 catalog.formula_invalid at /formula_expression; nothing changes (grammar, AC-04.4, AC-04.5, AC-04.6)', () => {
  it.each([
    ['AC-04.4 unknown analyte code XYZ (named)', 'MCV / XYZ', 'XYZ'],
    ['S-1 a code that exists only for tenant B (named like any unknown)', 'MCV / ONLYB', 'ONLYB'],
    ['an inactive analyte', 'MCV + OFF', 'OFF'],
    ['AC-04.5 a non-numeric input used in arithmetic (ordinal)', 'GRADE * 2', 'GRADE'],
    ['AC-04.5 a non-numeric input used in arithmetic (text)', 'TXT + MCV', 'TXT'],
    ['self-reference', 'MENTZER * 2', 'MENTZER -> MENTZER'],
    ['dangling operator', 'MCV /', ''], ['unbalanced parenthesis', '(MCV / RBC', ''], ['foreign character', 'MCV $ RBC', ''], ['lowercase identifier', 'mcv / rbc', ''],
    ['unknown function', 'frobnicate(MCV)', ''], ['wrong arity', 'if(MCV)', ''], ['exponent notation', 'MCV * 1e3', ''], ['C5 ternary', 'MCV > 1 ? 2 : 3', ''],
    ['AC-04.6 nesting deeper than 32', nest(40), ''],
    ['SQL-looking payload', "MCV'; DROP TABLE catalog.analytes;--", ''], ['Cyrillic look-alike code', 'МCV / RBC', ''],
  ])('%s', { timeout: T }, async (_n, expr, needle) => {
    const e = base(); const before = snap(e.db);
    invalid(await rejection(patch(e, MID, { formula_expression: expr })), ...(needle ? [needle] : []));
    expect(snap(e.db)).toBe(before);
    expect(JSON.stringify(e.db.stmts.map((s) => s.text))).not.toMatch(/DROP TABLE/i);
  });

  it('every unknown code is named, not just the first', { timeout: T }, async () => {
    invalid(await rejection(patch(base(), MID, { formula_expression: 'QQ1 + QQ2 + MCV' })), 'QQ1', 'QQ2');
  });

  it('AC-04.6 more than 20 distinct analyte refs -> 422', { timeout: T }, async () => {
    const codes = Array.from({ length: 21 }, (_, i) => `Q${i + 1}`);
    const e = world(codes.map((c, i) => leaf(400 + i, c)), { analytes: [MENT], versions: [MENT_D] });
    invalid(await rejection(patch(e, MID, { formula_expression: codes.join(' + ') })));
    expect((await patch(e, MID, { formula_expression: codes.slice(0, 20).join(' + ') }))['formula_input_codes']).toHaveLength(20);
  });

  it('AC-04.6 length: a 501-character expression is rejected (400 at the field, as the schema says, or 422 catalog.formula_invalid); 500 is accepted', { timeout: T }, async () => {
    const core = 'min(' + 'MCV,'.repeat(123) + 'MCV)';
    expect(core).toHaveLength(500);
    const e = base();
    const x = await rejection(patch(e, MID, { formula_expression: core + ' ' }));
    expect([400, 422]).toContain(x.statusCode);
    expect(['common.validation_failed', 'catalog.formula_invalid']).toContain(x.code);
    expect(errPaths(x)[0]).toMatch(/\/formula_expression$/);
    expect((await patch(e, MID, { formula_expression: core }))['formula_expression']).toBeDefined();
  });

  it('AB-17: 10 000 nested parentheses -> a structured 4xx, never a stack overflow; the service keeps working', { timeout: T }, async () => {
    const e = base();
    const x = await rejection(patch(e, MID, { formula_expression: nest(10_000) }));
    expect([400, 422]).toContain(x.statusCode); expect(x.code).not.toBe('common.internal_error');
    expect((await patch(e, MID, { formula_expression: 'MCV / RBC' }))['formula_input_codes']).toEqual(['MCV', 'RBC']);
  });

  it('AC-04.5 the target must be numeric: a formula on a TEXT draft -> 422', { timeout: T }, async () => {
    const e = base(); const before = snap(e.db);
    const x = await rejection(patch(e, TXT_D['id'], { formula_expression: 'MCV * 2' }));
    lims(x, 'catalog.formula_invalid', 422);
    expect(snap(e.db)).toBe(before);
  });

  it('AC-04.5 ... changing the result type of a draft that has a formula to text -> 422 (the formula would be left on a non-numeric analyte)', { timeout: T }, async () => {
    const e = base({ versions: [] });
    await patch(e, MID, { formula_expression: 'MCV / RBC' });
    const before = snap(e.db);
    lims(await rejection(patch(e, MID, { result_type: 'text' }, 2)), 'catalog.formula_invalid', 422);
    expect(snap(e.db)).toBe(before);
    expect(await patch(e, MID, { result_type: 'text', unset: ['formula_expression', 'decimals'] }, 2)).toMatchObject({ result_type: 'text' });   // dropping the formula in the same patch is fine
  });

  it('AC-04.5 ... and in the same patch: result_type text + a formula -> 422', { timeout: T }, async () => {
    lims(await rejection(patch(base(), MID, { result_type: 'text', formula_expression: 'MCV * 2' })), 'catalog.formula_invalid', 422);
  });

  it('state errors still win: PATCH of a published version -> 409 catalog.version_in_use even with an invalid formula (AB-9)', { timeout: T }, async () => {
    const e = base();
    lims(await rejection(patch(e, MCV.version['id'], { formula_expression: 'MCV /' }, 1)), 'catalog.version_in_use', 409);
  });

  it('S-5: formula_inputs / formula_input_units cannot be written by the client -> 400 (derived data)', { timeout: T }, async () => {
    for (const p of [{ formula_inputs: ['HB'] }, { formula_input_units: { HB: 'g_dl' } }, { formula_input_codes: ['HB'] }]) {
      const x = await rejection(patch(base(), MID, { formula_expression: 'MCV / RBC', ...p }));
      expect(x.statusCode).toBe(400);
    }
  });
});

// ============================================================================================================ createAnalyte
describe('createAnalyte — invalid initial_version formulas -> 422 and no analyte / version is created', () => {
  it.each([
    ['unknown code XYZ', { result_type: 'numeric', decimals: 1, formula_expression: 'MCV / XYZ' }, 'XYZ'],
    ['grammar error', { result_type: 'numeric', decimals: 1, formula_expression: 'MCV /' }, ''],
    ['self-reference by the new code (the analyte does not exist yet: unknown or self-cycle, either way invalid)', { result_type: 'numeric', decimals: 1, formula_expression: 'NEWA * 2' }, 'NEWA'],
    ['AC-04.5 non-numeric target', { result_type: 'text', formula_expression: 'MCV * 2' }, ''],
  ])('%s', { timeout: T }, async (_n, iv, needle) => {
    const e = base(); const before = snap(e.db);
    const x = await rejection(create(e, { code: 'newa', name: 'New analyte', initial_version: iv }));
    lims(x, 'catalog.formula_invalid', 422);
    expect(errPaths(x)[0]).toMatch(/formula_expression$|result_type$/);
    if (needle) expect(JSON.stringify(x.errors)).toContain(needle);
    expect(snap(e.db)).toBe(before);
  });
});

// ============================================================================================================ publish: validation and writes
describe('publishAnalyteVersion — the formula is validated again at publish; edges, inputs and input units are written in the same transaction', () => {
  const mentzerDraft = () => draftWith(150, MENT, 'MCV / RBC');          // seeded WITHOUT formula_inputs: publish derives them from the expression, it does not trust stored data
  const world1 = () => world([MCV], { analytes: [MENT], versions: [mentzerDraft()] });
  const DID = mentzerDraft()['id'];

  it('AC-04.1 publish MENTZER = MCV / RBC: published; formula_inputs [MCV, RBC]; formula_input_units {MCV: fl, RBC: 10e12_l} (each input\'s effective unit); one edge per input; one analyte event', { timeout: T }, async () => {
    const e = world1();
    const out = await publish(e, DID);
    expect(out).toMatchObject({ id: DID, status: 'published', formula_expression: 'MCV / RBC', formula_input_codes: ['MCV', 'RBC'] });
    expect(e.db.row('analyte_versions', DID)).toMatchObject({ status: 'published', formula_inputs: ['MCV', 'RBC'], formula_input_units: { MCV: 'fl', RBC: '10e12_l' } });
    const edges = e.db.rows('formula_dependencies').filter((r) => r['analyte_id'] === MENT['id']);
    expect(edges.map((r) => r['input_analyte_id']).sort()).toEqual([MCV.analyte['id'], RBC.id].sort());
    for (const r of edges) expect(r).toMatchObject({ tenant_id: A, analyte_version_id: DID, created_by: USER });
    expect(events(e.db)).toHaveLength(1);
  });

  it('an input without a unit contributes no (or a null) unit entry — never the string "undefined"', { timeout: T }, async () => {
    const e = world([leaf(160, 'NOUNIT', { version: { unit_code: null } })], { analytes: [MENT], versions: [draftWith(150, MENT, 'NOUNIT + 1')] });
    await publish(e, DID);
    const units = e.db.row('analyte_versions', DID)!['formula_input_units'] ?? {};
    expect(JSON.stringify(units)).not.toMatch(/undefined/);
    expect(units['NOUNIT'] ?? null).toBeNull();
  });

  it('publishing a formula whose input has a SCHEDULED newer version records the unit of the version effective at publish time', { timeout: T }, async () => {
    const T1D = new Date('2026-12-01T00:00:00.000Z');
    const mcv = leaf(101, 'MCV', { version: { unit_code: 'fl', effective_to: T1D } });
    const sched = pubOf(170, MCV.analyte['id'], { version_no: 2, unit_code: 'l_per_l', formula_expression: null, effective_from: T1D, method_id: null, decimals: 1 });
    const e = world([mcv], { analytes: [MENT], versions: [mentzerDraft(), sched] });
    await publish(e, DID);
    expect(e.db.row('analyte_versions', DID)!['formula_input_units']).toMatchObject({ MCV: 'fl' });
  });

  it('AC-04.4 an invalid draft cannot be published (unknown XYZ): 422, the version stays a draft, no edge, no event, no revision', { timeout: T }, async () => {
    const e = world([MCV], { analytes: [MENT], versions: [draftWith(150, MENT, 'MCV / XYZ')] }); const before = snap(e.db);
    invalid(await rejection(publish(e, DID)), 'XYZ');
    expect(snap(e.db)).toBe(before);
    expect(e.db.row('analyte_versions', DID)!['status']).toBe('draft');
    expect(e.db.rows('formula_dependencies')).toHaveLength(0);
  });

  it('an inactive or tenant-B input at publish time -> 422 (a code can go inactive between draft and publish)', { timeout: T }, async () => {
    for (const code of ['OFF', 'ONLYB']) {
      const e = world([MCV, OFF], { analytes: [MENT], versions: [draftWith(150, MENT, `MCV + ${code}`)] });
      invalid(await rejection(publish(e, DID)), code);
      expect(e.db.rows('formula_dependencies')).toHaveLength(0);
    }
  });

  it('a draft carrying a grammar error (seeded behind the API\'s back) cannot be published', { timeout: T }, async () => {
    const e = world([MCV], { analytes: [MENT], versions: [draftWith(150, MENT, 'MCV /')] });
    invalid(await rejection(publish(e, DID)));
  });

  it('no formula -> no formula validation, no edges, no inputs/units written (T-09 behaviour preserved)', { timeout: T }, async () => {
    const e = world([MCV], { analytes: [MENT], versions: [draftOf(150, MENT['id'], { version_no: 1, unit_code: null, method_id: null, decimals: 1 })] });
    await publish(e, DID);
    expect(e.db.rows('formula_dependencies')).toHaveLength(0);
    expect(e.db.row('analyte_versions', DID)!['formula_inputs'] ?? []).toEqual([]);
  });

  it('a published formula version is immutable through the API (AB-9): PATCH -> 409, and a client cannot rewrite its inputs', { timeout: T }, async () => {
    const e = world1(); await publish(e, DID);
    lims(await rejection(patch(e, DID, { formula_expression: 'MCV * 2' }, 2)), 'catalog.version_in_use', 409);
  });
});

// ============================================================================================================ AC-04.3 cycles on mutations
describe('AC-04.3 — a cycle is a 422 whose first error is {path: "/formula_expression"} with the path in the message', () => {
  const AA = fnode(150, 'A', 'B + 1', [leaf(151, 'B').analyte]);                          // published A = B + 1, edge A -> B
  const BB = leaf(151, 'B');
  const B_DRAFT = draftOf(152, BB.analyte['id'], { version_no: 2, unit_code: null, method_id: null, decimals: 1 });
  const cyc = (extra: { versions?: any[] } = {}) => world([AA, BB], { versions: [B_DRAFT, ...(extra.versions ?? [])] });

  it('PATCH draft B = A * 2 -> 422 "B -> A -> B"', { timeout: T }, async () => {
    const e = cyc(); const before = snap(e.db);
    const x = invalid(await rejection(patch(e, B_DRAFT['id'], { formula_expression: 'A * 2' })), 'B -> A -> B');
    expect(x.errors[0].path).toBe('/formula_expression');
    expect(snap(e.db)).toBe(before);
  });

  it('publishing a draft that closes the cycle (seeded: it was valid when saved) -> 422 "B -> A -> B", draft stays, no edge, no event', { timeout: T }, async () => {
    const closing = draftOf(152, BB.analyte['id'], { version_no: 2, unit_code: 'u_151', method_id: null, decimals: 1, formula_expression: 'A * 2' });   // same unit as B v1: AC-03.5 must not answer first
    const e = world([AA, BB], { versions: [closing] }); const before = snap(e.db);
    const x = invalid(await rejection(publish(e, closing['id'])), 'B -> A -> B');
    expect(x.errors[0].path).toBe('/formula_expression');
    expect(snap(e.db)).toBe(before);
    expect(e.db.row('analyte_versions', closing['id'])!['status']).toBe('draft');
  });

  it('three-cycle: A = B + 1, B = C + 1 published; C = A + 1 -> 422 naming C -> A -> B -> C', { timeout: T }, async () => {
    const C = leaf(162, 'C');
    const n1 = fnode(160, 'A', 'B + 1', [leaf(161, 'B').analyte]);
    const n2 = fnode(161, 'B', 'C + 1', [C.analyte]);
    const draftC = draftOf(163, C.analyte['id'], { version_no: 2, unit_code: null, method_id: null, decimals: 1 });
    const e = world([n1, n2, C], { versions: [draftC] });
    invalid(await rejection(patch(e, draftC['id'], { formula_expression: 'A + 1' })), 'C -> A -> B -> C');
  });

  it('self-cycle on an existing analyte: HB draft = HB * 3 -> 422 "HB -> HB"', { timeout: T }, async () => {
    const hbDraft = draftOf(2, HB.id, { unit_code: 'g_dl', method_id: null, decimals: 2 });
    const e = world([], { versions: [hbDraft] });
    invalid(await rejection(patch(e, hbDraft['id'], { formula_expression: 'HB * 3' })), 'HB -> HB');
  });

  it('a draft elsewhere is not an edge: A = B + 1 is publishable while B\'s open draft reads A (the cycle only exists once both are published)', { timeout: T }, async () => {
    const draftB = draftOf(152, BB.analyte['id'], { version_no: 2, unit_code: 'u_151', method_id: null, decimals: 1, formula_expression: 'A * 2' });
    const aDraft = draftOf(153, AA.analyte['id'], { version_no: 2, unit_code: 'u_150', method_id: null, decimals: 2, formula_expression: 'B + 1' });
    const e = world([AA, BB], { versions: [draftB, aDraft] });
    expect((await publish(e, aDraft['id'])).status).toBe('published');
  });

  it('race: two publishes that together close a cycle (X = Y + 1 and Y = X + 1, different tests) never both succeed, and the graph has no 2-cycle afterwards', { timeout: T }, async () => {
    const X = ana(180, A, CBC.test.id as string, { code: 'XA' }), Y = ana(181, A, MICRO.test.id as string, { code: 'YB' });
    const xv = pubOf(180, X['id'], { unit_code: 'u', method_id: null }), yv = pubOf(181, Y['id'], { unit_code: 'u', method_id: null });
    const xd = draftOf(182, X['id'], { version_no: 2, unit_code: 'u', method_id: null, decimals: 1, formula_expression: 'YB + 1' });
    const yd = draftOf(183, Y['id'], { version_no: 2, unit_code: 'u', method_id: null, decimals: 1, formula_expression: 'XA + 1' });
    const e = world([], { analytes: [X, Y], versions: [xv, yv, xd, yd] });
    const res = await Promise.allSettled([publish(e, xd['id']), publish(e, yd['id'])]);
    const ok = res.filter((r) => r.status === 'fulfilled');
    expect(ok.length, JSON.stringify(res.map((r) => (r.status === 'rejected' ? (r.reason as any)?.code : 'ok')))).toBeLessThanOrEqual(1);
    for (const r of res) if (r.status === 'rejected') expect((r.reason as any)?.statusCode).toBeGreaterThanOrEqual(400);
    const edge = new Set(e.db.rows('formula_dependencies').map((r) => `${r['analyte_id']}>${r['input_analyte_id']}`));
    expect(edge.has(`${X['id']}>${Y['id']}`) && edge.has(`${Y['id']}>${X['id']}`)).toBe(false);
  });
});

// ============================================================================================================ AC-04.7 chain depth on mutations
describe('AC-04.7 — chain depth: the formula analyte plus the formula analytes below it may not exceed 5', () => {
  const nodes = (len: number) => chain(200, len, { analyte: HB });
  const TOP = ana(260, A, CBC.test.id as string, { code: 'TOP', name: 'Top of the chain' });
  const topDraft = (expr: string) => draftOf(260, TOP['id'], { version_no: 1, unit_code: null, method_id: null, decimals: 1, ...(expr ? { formula_expression: expr } : {}) });
  const w = (len: number, expr = '') => world(nodes(len), { analytes: [TOP], versions: [topDraft(expr)] });
  const TID = topDraft('')['id'];

  it('TOP = C4 + 1 (TOP + 4 formula analytes = 5 levels) is accepted by PATCH and publishable; the edge to C4 is written', { timeout: T }, async () => {
    const e = w(4);
    expect((await patch(e, TID, { formula_expression: 'C4 + 1' }))['formula_input_codes']).toEqual(['C4']);
    expect((await publish(e, TID, pBody({ change_reason: 'chain of five' }), 2)).status).toBe('published');
    expect(e.db.rows('formula_dependencies').filter((r) => r['analyte_id'] === TOP['id'])).toHaveLength(1);
  });

  it('TOP = C5 + 1 (6 levels) -> 422 "formula chain too deep" on PATCH; nothing changes', { timeout: T }, async () => {
    const e = w(5); const before = snap(e.db);
    invalid(await rejection(patch(e, TID, { formula_expression: 'C5 + 1' })), /formula chain too deep/i);
    expect(snap(e.db)).toBe(before);
  });

  it('... and on PUBLISH of a seeded draft; the version stays a draft and no edge is written', { timeout: T }, async () => {
    const e = w(5, 'C5 + 1'); const before = snap(e.db);
    invalid(await rejection(publish(e, TID)), /formula chain too deep/i);
    expect(snap(e.db)).toBe(before);
    expect(e.db.rows('formula_dependencies').filter((r) => r['analyte_id'] === TOP['id'])).toHaveLength(0);
  });

  it('the depth that counts is the LONGEST branch: a short second input does not rescue a deep one', { timeout: T }, async () => {
    invalid(await rejection(patch(w(5), TID, { formula_expression: 'C5 + TC' })), /too deep/i);
  });

  it('the rule is applied to the analyte being edited only for chains that exist today — an edit deep inside the chain is also checked (C1 edited to read C5 would be a cycle)', { timeout: T }, async () => {
    const c1Draft = draftOf(270, ID(0x3000 + 201), { version_no: 2, unit_code: 'u_201', method_id: null, decimals: 2 });
    const e = world(nodes(5), { versions: [c1Draft] });
    invalid(await rejection(patch(e, c1Draft['id'], { formula_expression: 'C5 + 1' })), 'C1 -> C5 -> C4 -> C3 -> C2 -> C1');
  });
});
