// T-28a (C3) — the REAL CatalogPort, non-price methods: getTest, getPanel, resolveOrderables, referenceRangeFor, criticalLimitsFor.
// Spec: 03-IC §4.2 contract cases (1) (2) (3) (4) (5) (9) (10) (13) and, from 02-TRD §14 / 08 A13 D-9 / A17.1, (31) (32) (33); 02-TRD §6.1 (method table), §7.3, §7.7;
//       PRD AC-19.1, AC-02.7, AC-07.1, AC-07.2, AC-07.3 (resolve side), AC-07.5, AC-05.11, AC-06.5; 07-SECURITY S-1 (port probes).
// The shared suite packages/fakes/contract-tests/CatalogPort.contract.ts runs ALL 31 cases and so cannot be pointed at a half-built port; T-29 wires it with this world's
// mapping. Here the same case numbers are asserted against rows seeded in the SQL fake. Interface: helpers/t28a.ts (SEAM header). Notes: .orchestra/notes/T-28a-tests.md.
import { describe, expect, it } from 'vitest';
import {
  ADDON, B_ADU2, B_AGED_ADU, B_B, B_FEM2, B_GEN, B_NEO1, B_NEO2, B_SERUM, B_UNK_ADU, B_UNK_NEO, B_UNR, BASIC, CB_AGED, CB_HB, CBC, CY1, DEAD, EDTA, FBS, HASOLD, HDL, HP_ELITE_M, HAEM,
  LAB, LAV, LDL, LHB, LIPID, M1, M2, NOW, OLD, PANEL_B, REV, RAGED, RB, RFUT, RHB, RSP, RTXT, RUNK, SERUM, T, TC, TEST_B, TG, ID,
  codeOf, idsOf, inB, keysOf, one, setup28a,
} from '../helpers/t28a.js';

const MARCH = '2026-03-01T00:00:00.000Z', SEPT = '2026-09-01T00:00:00.000Z';
const rq = (analyteId: string, extra: Record<string, unknown> = {}) => ({ analyteId, sex: 'male', ageDays: 400, at: NOW, ...extra });

describe('CatalogPort real impl: shape (AC-19.1)', () => {
  it('exposes the five T-28a methods as functions', { timeout: T }, () => {
    const { port } = setup28a();
    for (const m of ['getTest', 'getPanel', 'resolveOrderables', 'referenceRangeFor', 'criticalLimitsFor']) expect(typeof port[m], m).toBe('function');
  });
});

describe('contract (1)(2)(13) getTest — AC-02.7', () => {
  it('(1) unknown id -> common.not_found', { timeout: T }, async () => {
    expect(await codeOf(one(setup28a(), 'getTest', { testId: ID(0xdead) }))).toBe('common.not_found');
  });
  it('(2) another tenant\'s tenant-specific test -> common.not_found; the owner reads it', { timeout: T }, async () => {
    const env = setup28a();
    expect(await codeOf(one(env, 'getTest', { testId: TEST_B.test.id }))).toBe('common.not_found');
    expect((await one(env, 'getTest', { testId: TEST_B.test.id }, inB)).id).toBe(TEST_B.test.id);
    expect((await one(env, 'getTest', { testId: CBC.test.id })).id).toBe(CBC.test.id);
    expect(await codeOf(one(env, 'getTest', { testId: CBC.test.id }, inB))).toBe('common.not_found');
  });
  it('a panel id is not a test: getTest(panel) -> common.not_found', { timeout: T }, async () => {
    expect(await codeOf(one(setup28a(), 'getTest', { testId: LIPID.panel.id }))).toBe('common.not_found');
  });
  it('(13) AC-02.7 a deactivated test is readable without requireActive (isActive false), rejected with requireActive:true -> catalog.test_inactive', { timeout: T }, async () => {
    const env = setup28a();
    const t = await one(env, 'getTest', { testId: OLD.test.id });
    expect([t.id, t.code, t.isActive]).toEqual([OLD.test.id, 'OLD', false]);
    expect(await codeOf(one(env, 'getTest', { testId: OLD.test.id, requireActive: true }))).toBe('catalog.test_inactive');
    expect((await one(env, 'getTest', { testId: OLD.test.id, requireActive: false })).isActive).toBe(false);
    expect((await one(env, 'getTest', { testId: CBC.test.id, requireActive: true })).isActive).toBe(true);
  });
});

describe('getTest — TestDefinition (02-TRD §6.1 getTest row)', () => {
  it('scalar fields: department id/code/name, workflow, revision = orderables.revision, usesExistingMaterial, specimen requirement (preferred first, then by code), TAT', { timeout: T }, async () => {
    const t = await one(setup28a(), 'getTest', { testId: LAB.test.id });
    expect(t).toMatchObject({
      id: LAB.test.id, code: 'LAB', name: 'Lab profile test', departmentId: HAEM.id, departmentCode: 'HAEM', departmentName: HAEM.name, workflowType: 'standard',
      isActive: true, revision: 77, usesExistingMaterial: false,
      specimenTypeCodes: ['SERUM', 'EDTA_WB'], containerCode: LAV.code, specimenReportLabel: SERUM.report_label,
      tatTargetSeconds: { routine: 14400, urgent: 3600 }, tatTargetSegment: 'total',
    });
  });
  it('(25) departmentName is present on every definition', { timeout: T }, async () => {
    expect((await one(setup28a(), 'getTest', { testId: CBC.test.id })).departmentName).toBe(HAEM.name);
  });
  it('specimenTypeCodes / containerCode / specimenReportLabel come from the PREFERRED requirement (CBC: EDTA + LAV, SERUM second)', { timeout: T }, async () => {
    const t = await one(setup28a(), 'getTest', { testId: CBC.test.id });
    expect(t).toMatchObject({ specimenTypeCodes: ['EDTA_WB', 'SERUM'], containerCode: 'LAV_TOP', specimenReportLabel: EDTA.report_label });
    expect(t.tatTargetSeconds).toBeUndefined();
  });
  it('a test without specimen requirements (uses_existing_material) has specimenTypeCodes [] and no containerCode / specimenReportLabel', { timeout: T }, async () => {
    const t = await one(setup28a(), 'getTest', { testId: ADDON.test.id });
    expect(t).toMatchObject({ specimenTypeCodes: [], usesExistingMaterial: true });
    expect(t).not.toHaveProperty('containerCode');
    expect(t).not.toHaveProperty('specimenReportLabel');
  });
  it('revision is the orderable\'s own stamp, not the tenant catalog revision', { timeout: T }, async () => {
    const env = setup28a();
    expect((await one(env, 'getTest', { testId: LAB.test.id })).revision).toBe(77);
    expect((await one(env, 'getTest', { testId: TC.test.id })).revision).toBe(0);
  });
  it('analytes at NOW: the version effective then; draft and superseded-before versions are ignored; sorted by sortOrder; every field mapped', { timeout: T }, async () => {
    const t = await one(setup28a(), 'getTest', { testId: LAB.test.id });
    expect(t.analytes.map((a: any) => a.code)).toEqual(['LHB', 'LNEW', 'LORD', 'LTEN', 'LFRM', 'LHID']);
    expect(t.analytes[0]).toMatchObject({
      id: LHB.id, code: 'LHB', name: 'Haemoglobin (lab)', resultType: 'numeric', unitCode: 'g_dl', decimals: 2, methodName: M2.name,
      reportable: true, sortOrder: 10, reportSubheading: 'RBC parameters', printName: 'Haemoglobin',
    });
    expect(t.analytes[5]).toMatchObject({ code: 'LHID', resultType: 'text', reportable: false, sortOrder: 50 });
    expect(t.analytes[5]).not.toHaveProperty('unitCode');
    expect(t.analytes[5]).not.toHaveProperty('methodName');
  });
  it('asOf before a new analyte version returns the old one (decimals 1, method M1); an analyte with no version effective at asOf is omitted', { timeout: T }, async () => {
    const env = setup28a();
    const t = await one(env, 'getTest', { testId: LAB.test.id, asOf: MARCH });
    expect(t.analytes.map((a: any) => a.code)).toEqual(['LHB', 'LORD', 'LTEN', 'LFRM', 'LHID']);
    expect(t.analytes[0]).toMatchObject({ decimals: 1, methodName: M1.name });
    expect(t.tatTargetSeconds).toEqual({ routine: 7200, urgent: 3600 });
    expect((await one(env, 'getTest', { testId: LAB.test.id, asOf: SEPT })).analytes.map((a: any) => a.code)).toContain('LNEW');
  });
  it('asOf defaults to ctx.now(), not the wall clock', { timeout: T }, async () => {
    const env = setup28a();
    const t = await one(env, 'getTest', { testId: LAB.test.id }, { ctx: { now: () => MARCH } });
    expect(t.analytes[0]).toMatchObject({ decimals: 1, methodName: M1.name });
    expect(t.analytes.map((a: any) => a.code)).not.toContain('LNEW');
  });
  it('a formula analyte carries formula {expression, inputAnalyteCodes, inputUnitCodes}; others have none', { timeout: T }, async () => {
    const t = await one(setup28a(), 'getTest', { testId: LAB.test.id });
    expect(t.analytes.find((a: any) => a.code === 'LFRM').formula).toEqual({ expression: 'LHB / 10', inputAnalyteCodes: ['LHB'], inputUnitCodes: { LHB: 'g_dl' } });
    expect(t.analytes.find((a: any) => a.code === 'LHB')).not.toHaveProperty('formula');
  });
  it('(31) analyte with ordinalSetCode -> ordinalSetValues equals the ACTIVE values of that set, sortOrder asc; analytes without ordinalSetCode have neither key', { timeout: T }, async () => {
    const t = await one(setup28a(), 'getTest', { testId: LAB.test.id });
    const ord = t.analytes.find((a: any) => a.code === 'LORD');
    expect(ord.ordinalSetCode).toBe('LAB_SEMIQ');
    expect(ord.ordinalSetValues).toEqual([{ code: 'NEG', display: 'Negative', sortOrder: 1 }, { code: '1+', display: 'One plus', sortOrder: 2 }, { code: '2+', display: 'Two plus', sortOrder: 3 }]);
    const hb = t.analytes.find((a: any) => a.code === 'LHB');
    expect(hb).not.toHaveProperty('ordinalSetCode');
    expect(hb).not.toHaveProperty('ordinalSetValues');
  });
  it('(31) a tenant set with the code shadows the global one (own values only, not tenant B\'s, not the global\'s)', { timeout: T }, async () => {
    const ten = (await one(setup28a(), 'getTest', { testId: LAB.test.id })).analytes.find((a: any) => a.code === 'LTEN');
    expect(ten.ordinalSetValues).toEqual([{ code: 'T1', display: 'Ten one', sortOrder: 1 }, { code: 'T2', display: 'Ten two', sortOrder: 2 }]);
  });
  it('the result has only port keys: no snake_case, no tenant / audit internals', { timeout: T }, async () => {
    const t = await one(setup28a(), 'getTest', { testId: LAB.test.id });
    expect(keysOf(t).filter((k) => /_|^(tenantId|createdBy|updatedBy|version)$/.test(k))).toEqual([]);
  });
  it('input validation: a malformed asOf -> common.validation_failed; a non-uuid id never reaches a query as text', { timeout: T }, async () => {
    const env = setup28a();
    expect(await codeOf(one(env, 'getTest', { testId: CBC.test.id, asOf: 'yesterday' }))).toBe('common.validation_failed');
    expect(['common.validation_failed', 'common.not_found']).toContain(await codeOf(one(env, 'getTest', { testId: "x'; DROP TABLE catalog.tests; --" })));
  });
});

describe('getPanel (02-TRD §6.1 getPanel row)', () => {
  it('PanelDefinition: members in sort order as {kind, id}, sexRestriction, panelKind, revision = the panel\'s orderables.revision', { timeout: T }, async () => {
    const p = await one(setup28a(), 'getPanel', { panelId: HP_ELITE_M.panel.id });
    expect(p).toMatchObject({
      id: HP_ELITE_M.panel.id, code: 'HP_ELITE_M', name: 'Health package elite male', panelKind: 'package', sexRestriction: 'male', isActive: true, revision: 91,
      members: [{ kind: 'test', id: CBC.test.id }, { kind: 'panel', id: LIPID.panel.id }, { kind: 'test', id: FBS.test.id }],
    });
    expect(p.members).toHaveLength(3);
  });
  it('a panel without sex restriction has no sexRestriction key; clinical panelKind', { timeout: T }, async () => {
    const p = await one(setup28a(), 'getPanel', { panelId: LIPID.panel.id });
    expect(p.panelKind).toBe('clinical');
    expect(p).not.toHaveProperty('sexRestriction');
    expect(p.members.map((m: any) => m.id)).toEqual(idsOf(TC, HDL, TG, LDL));
  });
  it('unknown, other tenant\'s, and a test id -> common.not_found', { timeout: T }, async () => {
    const env = setup28a();
    expect(await codeOf(one(env, 'getPanel', { panelId: ID(0xdead) }))).toBe('common.not_found');
    expect(await codeOf(one(env, 'getPanel', { panelId: PANEL_B.panel.id }))).toBe('common.not_found');
    expect((await one(env, 'getPanel', { panelId: PANEL_B.panel.id }, inB)).id).toBe(PANEL_B.panel.id);
    expect(await codeOf(one(env, 'getPanel', { panelId: TC.test.id }))).toBe('common.not_found');
  });
  it('an inactive panel is readable; requireActive:true -> catalog.test_inactive (same rule as tests)', { timeout: T }, async () => {
    const env = setup28a();
    expect((await one(env, 'getPanel', { panelId: DEAD.panel.id })).isActive).toBe(false);
    expect(await codeOf(one(env, 'getPanel', { panelId: DEAD.panel.id, requireActive: true }))).toBe('catalog.test_inactive');
  });
});

describe('resolveOrderables — contract (4)(5), AC-07.1, AC-07.2, AC-07.3, AC-07.5, 02-TRD §7.7', () => {
  const resolve = (env: ReturnType<typeof setup28a>, ids: string[], extra: Record<string, unknown> = {}, o = {}) => one(env, 'resolveOrderables', { orderableIds: ids, ...extra }, o);

  it('AC-07.1 package HP_ELITE_M = {CBC, LIPID{TC,HDL,TG,LDL}, FBS}: orderables[0].testIds lists the 6 test ids, tests holds each once, specimenRequirements group by (preferred specimen type, container) sorted by type code', { timeout: T }, async () => {
    const r = await resolve(setup28a(), [HP_ELITE_M.panel.id]);
    const six = idsOf(CBC, TC, HDL, TG, LDL, FBS);
    expect(r.orderables).toEqual([{ orderableId: HP_ELITE_M.panel.id, kind: 'panel', testIds: six }]);
    expect(r.tests.map((t: any) => t.id)).toEqual(six);
    expect(r.specimenRequirements).toEqual([
      { specimenTypeCode: 'EDTA_WB', containerCode: 'LAV_TOP', testIds: idsOf(CBC) },
      { specimenTypeCode: 'FL_PLASMA', containerCode: 'GREY_TOP', testIds: idsOf(FBS) },
      { specimenTypeCode: 'SERUM', testIds: idsOf(TC, HDL, TG, LDL) },
    ]);
    expect(r.specimenRequirements[2]).not.toHaveProperty('containerCode');
    expect(r.catalogRevision).toBe(REV);
  });
  it('the result has exactly the port keys, camelCase', { timeout: T }, async () => {
    const r = await resolve(setup28a(), [LIPID.panel.id]);
    expect(Object.keys(r).sort()).toEqual(['catalogRevision', 'orderables', 'specimenRequirements', 'tests']);
    expect(Object.keys(r.orderables[0]).sort()).toEqual(['kind', 'orderableId', 'testIds']);
    expect(keysOf(r).filter((k) => /_/.test(k))).toEqual([]);
  });
  it('a test id resolves to itself: orderables [{kind:test, testIds:[id]}]; tests are full TestDefinitions (analytes, departmentName, revision)', { timeout: T }, async () => {
    const r = await resolve(setup28a(), [LAB.test.id]);
    expect(r.orderables).toEqual([{ orderableId: LAB.test.id, kind: 'test', testIds: [LAB.test.id] }]);
    expect(r.tests[0]).toMatchObject({ id: LAB.test.id, revision: 77, departmentName: HAEM.name });
    expect(r.tests[0].analytes).toHaveLength(6);
  });
  it('(4) AC-07.2 a test present in two ordered panels appears once in tests and once across specimenRequirements; one orderables entry per input id, in input order', { timeout: T }, async () => {
    const r = await resolve(setup28a(), [BASIC.panel.id, HP_ELITE_M.panel.id]);
    expect(r.tests.map((t: any) => t.id)).toEqual(idsOf(CBC, FBS, TC, HDL, TG, LDL));             // first-seen order, CBC and FBS once
    expect(r.orderables.map((o: any) => o.orderableId)).toEqual([BASIC.panel.id, HP_ELITE_M.panel.id]);
    expect(r.orderables[0].testIds).toEqual(idsOf(CBC, FBS));
    expect([...r.orderables[1].testIds].sort()).toEqual(idsOf(CBC, TC, HDL, TG, LDL, FBS).sort());
    const grouped = r.specimenRequirements.flatMap((s: any) => s.testIds);
    expect([...grouped].sort()).toEqual(idsOf(CBC, FBS, TC, HDL, TG, LDL).sort());
    expect(new Set(grouped).size).toBe(grouped.length);
    expect(typeof r.catalogRevision).toBe('number');
  });
  it('a mix of a test id and a panel: tests = union in first-seen order', { timeout: T }, async () => {
    const r = await resolve(setup28a(), [TG.test.id, LIPID.panel.id]);
    expect(r.orderables.map((o: any) => [o.kind, o.testIds.length])).toEqual([['test', 1], ['panel', 4]]);
    expect(r.tests.map((t: any) => t.id)).toEqual(idsOf(TG, TC, HDL, LDL));
  });
  it('a uses_existing_material test is in tests (specimenTypeCodes []) but in no specimenRequirements group', { timeout: T }, async () => {
    const r = await resolve(setup28a(), [ADDON.test.id, TC.test.id]);
    expect(r.tests.find((t: any) => t.id === ADDON.test.id)).toMatchObject({ specimenTypeCodes: [], usesExistingMaterial: true });
    expect(r.specimenRequirements.flatMap((g: any) => g.testIds)).toEqual(idsOf(TC));
  });
  it('(5) AC-07.3 a panel cycle (defensive, seeded past the write-time check) -> catalog.panel_cycle', { timeout: T }, async () => {
    const env = setup28a();
    expect(await codeOf(resolve(env, [CY1.panel.id]))).toBe('catalog.panel_cycle');
    expect(await codeOf(resolve(env, [TC.test.id, CY1.panel.id]))).toBe('catalog.panel_cycle');
  });
  it('AC-07.5 a panel containing an inactive test, an inactive panel, and an inactive test ordered directly -> catalog.test_inactive', { timeout: T }, async () => {
    const env = setup28a();
    expect(await codeOf(resolve(env, [HASOLD.panel.id]))).toBe('catalog.test_inactive');
    expect(await codeOf(resolve(env, [DEAD.panel.id]))).toBe('catalog.test_inactive');
    expect(await codeOf(resolve(env, [OLD.test.id]))).toBe('catalog.test_inactive');
    expect(await codeOf(resolve(env, [TC.test.id, HASOLD.panel.id]))).toBe('catalog.test_inactive');
  });
  it('unknown id, another tenant\'s id (test or panel), or one bad id among good ones -> common.not_found for the whole call', { timeout: T }, async () => {
    const env = setup28a();
    expect(await codeOf(resolve(env, [ID(0xdead)]))).toBe('common.not_found');
    expect(await codeOf(resolve(env, [TEST_B.test.id]))).toBe('common.not_found');
    expect(await codeOf(resolve(env, [PANEL_B.panel.id]))).toBe('common.not_found');
    expect(await codeOf(resolve(env, [TC.test.id, TEST_B.test.id]))).toBe('common.not_found');
    expect((await resolve(env, [TEST_B.test.id, PANEL_B.panel.id], {}, inB)).tests.map((t: any) => t.id)).toEqual([TEST_B.test.id]);
    expect(await codeOf(resolve(env, [TC.test.id], {}, inB))).toBe('common.not_found');
  });
  it('asOf is applied to every returned TestDefinition (analyte versions as of then)', { timeout: T }, async () => {
    const r = await resolve(setup28a(), [LAB.test.id], { asOf: MARCH });
    expect(r.tests[0].analytes.map((a: any) => a.code)).not.toContain('LNEW');
    expect(r.tests[0].analytes[0]).toMatchObject({ decimals: 1, methodName: M1.name });
  });
  it('determinism: same input + same revision -> deeply equal output (also from a fresh request)', { timeout: T }, async () => {
    const env = setup28a();
    const a = await resolve(env, [HP_ELITE_M.panel.id, LAB.test.id]);
    const b = await resolve(env, [HP_ELITE_M.panel.id, LAB.test.id]);
    expect(b).toEqual(a);
  });
  it('input validation: an empty list is rejected or returns nothing (never throws an untyped error); a non-uuid id -> validation_failed / not_found', { timeout: T }, async () => {
    const env = setup28a();
    const code = await codeOf(resolve(env, []));
    if (code === undefined) expect((await resolve(env, [])).tests).toEqual([]); else expect(code).toBe('common.validation_failed');
    expect(['common.validation_failed', 'common.not_found']).toContain(await codeOf(resolve(env, ['not-a-uuid'])));
  });
});

describe('referenceRangeFor — contract (3)(9), (32)(33), 02-TRD §7.3, AC-05.11', () => {
  it('(9) picks the age band at the boundaries: day 0 and day 29 -> neonate, day 30 (exact upper age) -> adult', { timeout: T }, async () => {
    const env = setup28a();
    const at = async (ageDays: number, sex = 'male') => (await one(env, 'referenceRangeFor', rq(RHB.id, { ageDays, sex }))).referenceRangeId;
    expect(await at(0)).toBe(B_NEO2.id);
    expect(await at(29)).toBe(B_NEO2.id);
    expect(await at(30)).toBe(B_ADU2.id);
    expect(await at(30, 'female')).toBe(B_FEM2.id);                       // sex-exact beats sex 'any'
    expect(await at(400)).toBe(B_ADU2.id);
    expect(await at(400, 'female')).toBe(B_FEM2.id);
  });
  it('(3) `at` before a new range version returns the old version (v1 neonate 14.0-24.0); now returns v2 (15.0-25.0)', { timeout: T }, async () => {
    const env = setup28a();
    const old = await one(env, 'referenceRangeFor', rq(RHB.id, { ageDays: 5, at: SEPT }));
    const cur = await one(env, 'referenceRangeFor', rq(RHB.id, { ageDays: 5 }));
    expect([old.referenceRangeId, old.version, old.low, old.high]).toEqual([B_NEO1.id, 1, '14.0', '24.0']);
    expect([cur.referenceRangeId, cur.version, cur.low, cur.high]).toEqual([B_NEO2.id, 2, '15.0', '25.0']);
  });
  it('the match carries unitCode, kind and the generated text "<low> - <high>" (scale preserved as stored)', { timeout: T }, async () => {
    expect(await one(setup28a(), 'referenceRangeFor', rq(RHB.id, { ageDays: 5 }))).toMatchObject({ unitCode: 'g_dl', kind: 'numeric', text: '15.0 - 25.0', low: '15.0', high: '25.0' });
  });
  it('a malformed `at` -> common.validation_failed (03-IC §4.2 common errors)', { timeout: T }, async () => {
    expect(await codeOf(one(setup28a(), 'referenceRangeFor', rq(RHB.id, { at: 'not-a-date' })))).toBe('common.validation_failed');
  });
  it('a draft set is never used (its age-unrestricted band must not answer an age-unknown query)', { timeout: T }, async () => {
    expect(await codeOf(one(setup28a(), 'referenceRangeFor', { analyteId: RHB.id, sex: 'male', at: NOW }))).toBe('catalog.no_reference_range');
  });
  it('specimenTypeCode selects the specimen-specific band (higher specificity); a query without it, or with another type, gets the generic band', { timeout: T }, async () => {
    const env = setup28a();
    expect((await one(env, 'referenceRangeFor', rq(RSP.id, { specimenTypeCode: 'SERUM' }))).referenceRangeId).toBe(B_SERUM.id);
    expect((await one(env, 'referenceRangeFor', rq(RSP.id))).referenceRangeId).toBe(B_GEN.id);
    expect((await one(env, 'referenceRangeFor', rq(RSP.id, { specimenTypeCode: 'EDTA_WB' }))).referenceRangeId).toBe(B_GEN.id);
  });
  it('no set effective at `at` (only a future set) -> catalog.no_reference_range; the same set answers once `at` is inside its window', { timeout: T }, async () => {
    const env = setup28a();
    expect(await codeOf(one(env, 'referenceRangeFor', rq(RFUT.id)))).toBe('catalog.no_reference_range');
    expect((await one(env, 'referenceRangeFor', rq(RFUT.id, { at: '2027-02-01T00:00:00.000Z' }))).low).toBe('1.0');
  });
  it('an analyte with no range set at all -> catalog.no_reference_range', { timeout: T }, async () => {
    expect(await codeOf(one(setup28a(), 'referenceRangeFor', rq(RTXT.id)))).toBe('catalog.no_reference_range');
  });
  it('unknown analyte and another tenant\'s analyte -> common.not_found (not no_reference_range)', { timeout: T }, async () => {
    const env = setup28a();
    expect(await codeOf(one(env, 'referenceRangeFor', rq(ID(0xdead))))).toBe('common.not_found');
    expect(await codeOf(one(env, 'referenceRangeFor', rq(RB.id)))).toBe('common.not_found');
    expect(await codeOf(one(env, 'referenceRangeFor', rq(RHB.id), inB))).toBe('common.not_found');
    expect((await one(env, 'referenceRangeFor', rq(RB.id), inB)).low).toBe('1.0');
    expect((await one(env, 'referenceRangeFor', rq(RB.id), inB)).referenceRangeId).toBe(B_B.id);
  });
  it('(32) AC-05.11 age unknown (ageDays absent): the age-unrestricted band is returned — not the open-ended adult band, not the neonate band; birthOn is ignored', { timeout: T }, async () => {
    const env = setup28a();
    const q = (extra: Record<string, unknown> = {}) => ({ analyteId: RUNK.id, sex: 'male', at: NOW, ...extra });
    const r = await one(env, 'referenceRangeFor', q());
    expect([r.referenceRangeId, r.low, r.high]).toEqual([B_UNR.id, '11.0', '17.0']);
    expect((await one(env, 'referenceRangeFor', q({ birthOn: '1990-01-01' }))).referenceRangeId).toBe(B_UNR.id);
    // control: with ageDays the age-bound bands win on sort_order (50 < 200), proving the unrestricted band is not simply "first"
    expect((await one(env, 'referenceRangeFor', q({ ageDays: 9000 }))).referenceRangeId).toBe(B_UNK_ADU.id);
    expect((await one(env, 'referenceRangeFor', q({ ageDays: 5 }))).referenceRangeId).toBe(B_UNK_NEO.id);
  });
  it('(33) AC-05.11 age unknown and every band carries an age bound (incl. open-ended 30 d - inf) -> catalog.no_reference_range; with ageDays the same set answers', { timeout: T }, async () => {
    const env = setup28a();
    expect(await codeOf(one(env, 'referenceRangeFor', { analyteId: RAGED.id, sex: 'male', at: NOW }))).toBe('catalog.no_reference_range');
    expect(await codeOf(one(env, 'referenceRangeFor', { analyteId: RAGED.id, sex: 'male', birthOn: '1990-01-01', at: NOW }))).toBe('catalog.no_reference_range');
    expect((await one(env, 'referenceRangeFor', rq(RAGED.id))).referenceRangeId).toBe(B_AGED_ADU.id);
  });
});

describe('criticalLimitsFor — contract (10), (33), AC-06.5', () => {
  it('(10) returns undefined when the analyte has no critical limits configured; returns the band when set', { timeout: T }, async () => {
    const env = setup28a();
    expect(await one(env, 'criticalLimitsFor', rq(RTXT.id))).toBeUndefined();
    const c = await one(env, 'criticalLimitsFor', rq(RHB.id));
    expect([c.criticalLimitId, c.version, c.low, c.high]).toEqual([CB_HB.id, 1, '5.0', '22.0']);
  });
  it('AC-06.5 age unknown: the all-ages band matches; a set whose bands all carry age bounds returns undefined', { timeout: T }, async () => {
    const env = setup28a();
    const noAge = (analyteId: string) => ({ analyteId, sex: 'male', at: NOW });
    expect((await one(env, 'criticalLimitsFor', noAge(RHB.id))).criticalLimitId).toBe(CB_HB.id);
    expect(await one(env, 'criticalLimitsFor', noAge(RAGED.id))).toBeUndefined();
    expect((await one(env, 'criticalLimitsFor', rq(RAGED.id))).criticalLimitId).toBe(CB_AGED.id);        // control: with ageDays 400 (>= 1 y) it matches
    expect(await one(env, 'criticalLimitsFor', rq(RAGED.id, { ageDays: 100 }))).toBeUndefined();         // below the 1-year lower bound
  });
  it('unknown analyte and another tenant\'s analyte -> common.not_found (undefined is only for "none configured")', { timeout: T }, async () => {
    const env = setup28a();
    expect(await codeOf(one(env, 'criticalLimitsFor', rq(ID(0xdead))))).toBe('common.not_found');
    expect(await codeOf(one(env, 'criticalLimitsFor', rq(RB.id)))).toBe('common.not_found');
    expect(await one(env, 'criticalLimitsFor', rq(RB.id), inB)).toBeUndefined();                          // B's analyte exists but has no critical set
  });
  it('a critical set not yet effective at `at` -> undefined (not an error)', { timeout: T }, async () => {
    expect(await one(setup28a(), 'criticalLimitsFor', rq(RHB.id, { at: '2025-06-01T00:00:00.000Z' }))).toBeUndefined();
  });
});

describe('version windows: effective_from inclusive, effective_to exclusive (02-TRD §6.1)', () => {
  it('LNEW (version from 2026-09-01) is absent 1 ms before and present at the instant; LHB v1 ends exactly where v2 starts (2026-06-01)', { timeout: T }, async () => {
    const env = setup28a();
    const test = async (asOf: string) => (await one(env, 'getTest', { testId: LAB.test.id, asOf })).analytes;
    expect((await test('2026-08-31T23:59:59.999Z')).map((a: any) => a.code)).not.toContain('LNEW');
    expect((await test('2026-09-01T00:00:00.000Z')).map((a: any) => a.code)).toContain('LNEW');
    expect((await test('2026-05-31T23:59:59.999Z'))[0].decimals).toBe(1);
    expect((await test('2026-06-01T00:00:00.000Z'))[0].decimals).toBe(2);
  });
});
