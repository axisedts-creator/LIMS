// T0B-TESTMGMT-1 (LD-318, done_when 2, 3, 4, 7): analytes (parameters) and their draft versions. Display-only fields live on the analyte row and change in place with an audit
// line; every field that changes what a result means (result_type, unit, decimals, method, value set, equation, default / long text value, high_low, require_verification)
// lives on the VERSION, is only writable on a draft and goes live only through publishAnalyteVersion (catalog.reference_range.publish). Real PG17, RLS on.
// PINNED PICKS: an equation may only reference analytes of the SAME test (checked wherever the owning test is known: createAnalyte, updateAnalyteVersionDraft, publish);
// failures there are the existing 422 catalog.formula_invalid with the path /initial_version/formula_expression (create) or /formula_expression (draft update);
// unknown specimen_type_id (or another tenant's) on an analyte is 404 common.not_found.
import { beforeAll, describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_B, T, auditRows, call, changedEvents, dbRow, errPaths, expectCode, expectInvalid, fails, im, mkAnalyte, mkLegacyTest as mkTest, ownerRows, publishVersion, req, schemaErrors, tag, uid, world, type World } from './helpers.js';

let A: World; let B: World;
beforeAll(async () => { A = await world(TENANT_A); B = await world(TENANT_B); }, T);

const create = (testId: string, body: object, tenant = TENANT_A) => call('createAnalyte', req({ params: { test_id: testId }, body, headers: { 'idempotency-key': uid() } }), { tenant });
const detail = async (id: string, tenant = TENANT_A) => (await call('getAnalyte', req({ params: { analyte_id: id } }), { tenant })).body;
const draftOf = async (id: string) => (await detail(id)).versions.find((v: any) => v.status === 'draft');
const updDraft = (vid: string, version: number, body: object, tenant = TENANT_A) => call('updateAnalyteVersionDraft', req({ params: { analyte_version_id: vid }, headers: im(version), body }), { tenant });
const updAnalyte = (id: string, version: number, body: object, tenant = TENANT_A) => call('updateAnalyte', req({ params: { analyte_id: id }, headers: im(version), body }), { tenant });
const code = () => `P${tag(6)}`;
const formulaFails = async (promise: Promise<unknown>, path: string) => {
  const e = await promise.then(() => undefined, (x) => x);
  expectCode(e, 'catalog.formula_invalid', 422);
  expect(errPaths(e)).toContain(path);
};

const DISPLAY = { trend_name: 'Haemoglobin trend', font: 'Arial', result_display_type: 'four_column', print_on_negative: false, print_on_worksheet: true, send_in_sms: true, nabl: true, accab_logo: true, is_trend: true };

describe('(2) every new analyte and version field is stored and returned', () => {
  it('createAnalyte with all display fields and all version fields: 201 Analyte (schema valid); AnalyteDetail.versions[0] carries the version fields; columns stored', { timeout: T }, async () => {
    const t = await mkTest(A);
    const r = await create(t.id, { code: code(), name: 'Haemoglobin', specimen_type_id: A.spec.id, ...DISPLAY,
      initial_version: { result_type: 'numeric', decimals: 1, unit_code: A.unit.code, method_id: A.method.id, default_value: '12.5', long_text_value: 'Synthetic long text', high_low: '2.5', require_verification: true } });
    expect(r.status).toBe(201);
    expect(schemaErrors('Analyte', r.body)).toEqual([]);
    for (const [k, v] of Object.entries({ ...DISPLAY, specimen_type_id: A.spec.id })) expect(r.body[k], k).toEqual(v);
    const d = await detail(r.body.id);
    expect(schemaErrors('AnalyteDetail', d)).toEqual([]);
    expect(d.versions[0]).toMatchObject({ status: 'draft', result_type: 'numeric', decimals: 1, default_value: '12.5', long_text_value: 'Synthetic long text', require_verification: true });
    expect(Number(d.versions[0].high_low)).toBe(2.5);
    const row = await dbRow('analytes', r.body.id);
    expect(row).toMatchObject({ tenant_id: TENANT_A, trend_name: 'Haemoglobin trend', font: 'Arial', result_display_type: 'four_column', print_on_negative: false, specimen_type_id: A.spec.id });
    const v = (await ownerRows('catalog.analyte_versions', 'analyte_id = $1', [r.body.id]))[0];
    expect(v).toMatchObject({ default_value: '12.5', long_text_value: 'Synthetic long text', require_verification: true });
  });
  it('an analyte created the old way keeps its meaning: print_on_negative true, the other flags false, the new version fields absent', { timeout: T }, async () => {
    const t = await mkTest(A);
    const a = await mkAnalyte(A, t.id);
    expect(a).toMatchObject({ print_on_negative: true, print_on_worksheet: false, send_in_sms: false, nabl: false, accab_logo: false, is_trend: false });
    const v = (await detail(a.id)).versions[0];
    for (const k of ['default_value', 'long_text_value', 'high_low']) expect(v[k], k).toBeUndefined();
    expect(v.require_verification).toBe(false);
  });
  it('the 11 result types are accepted on a draft (Integer / Float / Equation = numeric, List = coded, Long Text / Single Line Text = text, Descriptive = narrative, Image = attachment, plus boolean, test_footer, space, graph, html_descriptive)', { timeout: T }, async () => {
    const t = await mkTest(A);
    const need: Record<string, object> = { numeric: { decimals: 2 }, coded: { value_set_code: A.valueSet.code } };
    for (const rt of ['numeric', 'text', 'coded', 'attachment', 'narrative', 'boolean', 'test_footer', 'space', 'graph', 'html_descriptive']) {
      const r = await create(t.id, { code: code(), name: `Type ${rt}`, is_reportable: rt !== 'narrative', initial_version: { result_type: rt, ...(need[rt] ?? {}) } });
      expect(r.status, `${rt}: ${JSON.stringify(r.body)}`).toBe(201);
      expect((await draftOf(r.body.id)).result_type).toBe(rt);
    }
  });
  it('updateAnalyteVersionDraft writes the four version fields; unset clears default_value / long_text_value / high_low; the DTO validates', { timeout: T }, async () => {
    const t = await mkTest(A);
    const a = await mkAnalyte(A, t.id);
    const d = await draftOf(a.id);
    const r = await updDraft(d.id, d.version, { default_value: 'NIL', long_text_value: 'text', high_low: '1.25', require_verification: true });
    expect(r.status).toBe(200);
    expect(schemaErrors('AnalyteVersion', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ default_value: 'NIL', long_text_value: 'text', require_verification: true, version: d.version + 1 });
    const c = await updDraft(d.id, d.version + 1, { unset: ['default_value', 'long_text_value', 'high_low'] });
    for (const k of ['default_value', 'long_text_value', 'high_low']) expect(c.body[k], k).toBeUndefined();
    expect(c.body.require_verification).toBe(true);
  });
});

describe('(3) domain rules on the analyte and its draft version (400 + path, before any write)', () => {
  const body = (over: Record<string, unknown> = {}, v: Record<string, unknown> = {}) => ({ code: code(), name: 'Rule probe', ...over, initial_version: { result_type: 'numeric', decimals: 1, ...v } });
  const ANALYTE_BAD: Array<[string, Record<string, unknown>, string]> = [
    ['trend_name empty', { trend_name: '' }, '/trend_name'], ['trend_name over 120', { trend_name: 'x'.repeat(121) }, '/trend_name'], ['font over 60', { font: 'x'.repeat(61) }, '/font'],
    ['result_display_type outside the list', { result_display_type: 'five_column' }, '/result_display_type'], ['specimen_type_id not a uuid', { specimen_type_id: 'abc' }, '/specimen_type_id'],
    ...['print_on_negative', 'print_on_worksheet', 'send_in_sms', 'nabl', 'accab_logo', 'is_trend'].map((k): [string, Record<string, unknown>, string] => [`${k} not a boolean`, { [k]: 1 }, `/${k}`]),
    ['sort_order negative', { sort_order: -1 }, '/sort_order'], ['an unknown field', { is_trending: true }, '/is_trending'],
  ];
  it.each(ANALYTE_BAD)('createAnalyte: %s', { timeout: T }, async (_n, over, path) => {
    const t = await mkTest(A);
    await expectInvalid('createAnalyte', req({ params: { test_id: t.id }, body: body(over), headers: { 'idempotency-key': uid() } }), path);
  });
  const VERSION_BAD: Array<[string, Record<string, unknown>, string]> = [
    ['unknown result_type', { result_type: 'float' }, '/initial_version/result_type'], ['numeric without decimals', { decimals: undefined }, '/initial_version/decimals'],
    ['decimals 7', { decimals: 7 }, '/initial_version/decimals'], ['negative decimals', { decimals: -1 }, '/initial_version/decimals'], ['fractional decimals', { decimals: 1.5 }, '/initial_version/decimals'],
    ['coded (List) without a value set', { result_type: 'coded', decimals: undefined }, '/initial_version/value_set_code'],
    ['coded with an unknown value set', { result_type: 'coded', decimals: undefined, value_set_code: 'NO_SUCH_SET' }, '/initial_version/value_set_code'],
    ['ordinal with an unordered value set', { result_type: 'ordinal', decimals: undefined, value_set_code: 'WILL_BE_SET' }, '/initial_version/value_set_code'],
    ['default_value empty', { default_value: '' }, '/initial_version/default_value'], ['default_value over 500', { default_value: 'x'.repeat(501) }, '/initial_version/default_value'],
    ['long_text_value over 20000', { long_text_value: 'x'.repeat(20001) }, '/initial_version/long_text_value'], ['high_low not a decimal', { high_low: 'abc' }, '/initial_version/high_low'],
    ['require_verification not a boolean', { require_verification: 'yes' }, '/initial_version/require_verification'], ['an unknown version field', { sign_off: true }, '/initial_version/sign_off'],
  ];
  it.each(VERSION_BAD)('createAnalyte version: %s', { timeout: T }, async (_n, v, path) => {
    const t = await mkTest(A);
    const vv = { ...v } as Record<string, unknown>;
    if (vv['value_set_code'] === 'WILL_BE_SET') vv['value_set_code'] = A.valueSet.code;
    await expectInvalid('createAnalyte', req({ params: { test_id: t.id }, body: body({}, vv), headers: { 'idempotency-key': uid() } }), path);
  });
  it('updateAnalyteVersionDraft applies the same rules to the resulting draft (coded without a set, numeric losing decimals, bad enum)', { timeout: T }, async () => {
    const t = await mkTest(A);
    const a = await mkAnalyte(A, t.id);
    const d = await draftOf(a.id);
    await expectInvalid('updateAnalyteVersionDraft', req({ params: { analyte_version_id: d.id }, headers: im(d.version), body: { result_type: 'coded' } }), '/value_set_code');
    await expectInvalid('updateAnalyteVersionDraft', req({ params: { analyte_version_id: d.id }, headers: im(d.version), body: { unset: ['decimals'] } }), '/decimals');
    await expectInvalid('updateAnalyteVersionDraft', req({ params: { analyte_version_id: d.id }, headers: im(d.version), body: { result_type: 'bool' } }), '/result_type');
    await expectInvalid('updateAnalyteVersionDraft', req({ params: { analyte_version_id: d.id }, headers: im(d.version), body: { default_value: '' } }), '/default_value');
  });
  it('specimen_type_id of an unknown or another tenant\'s specimen type is 404 common.not_found', { timeout: T }, async () => {
    const t = await mkTest(A);
    for (const specimen_type_id of [uid(), B.spec.id]) expectCode(await fails('createAnalyte', req({ params: { test_id: t.id }, body: body({ specimen_type_id }), headers: { 'idempotency-key': uid() } })), 'common.not_found', 404);
  });

  describe('Equation (numeric + formula_expression): a formula validateFormula accepts that references only analytes of the same test', () => {
    it('accepts CHOL - HDL over two analytes of the same test; the version stores the formula and its input codes', { timeout: T }, async () => {
      const t = await mkTest(A);
      const chol = await mkAnalyte(A, t.id, { code: `CH${tag(4)}` }); const hdl = await mkAnalyte(A, t.id, { code: `HD${tag(4)}` });
      const r = await create(t.id, { code: code(), name: 'Non HDL', initial_version: { result_type: 'numeric', decimals: 1, formula_expression: `${chol.code} - ${hdl.code}` } });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      const v = (await draftOf(r.body.id));
      expect(v.formula_input_codes.sort()).toEqual([chol.code, hdl.code].sort());
    });
    it('rejects an unknown code, a reference to an analyte of ANOTHER test of the same tenant, a self reference and a syntax error with 422 catalog.formula_invalid at /initial_version/formula_expression', { timeout: T }, async () => {
      const t = await mkTest(A); const t2 = await mkTest(A);
      const other = await mkAnalyte(A, t2.id, { code: `OT${tag(4)}` });
      const mine = await mkAnalyte(A, t.id, { code: `MI${tag(4)}` });
      const c = code();
      const p = '/initial_version/formula_expression';
      for (const f of ['NOSUCHCODE + 1', `${mine.code} + ${other.code}`, `${c} + 1`, `${mine.code} +`]) {
        await formulaFails(create(t.id, { code: c, name: 'Bad equation', initial_version: { result_type: 'numeric', decimals: 1, formula_expression: f } }), p);
      }
      expect((await ownerRows('catalog.analytes', 'tenant_id = $1 AND code = $2', [TENANT_A, c])), 'nothing stored by the rejected creates').toHaveLength(0);
    });
    it('rejects a formula on a non numeric result type, and a formula whose input is not numeric', { timeout: T }, async () => {
      const t = await mkTest(A);
      const txt = await mkAnalyte(A, t.id, { code: `TX${tag(4)}` }, { result_type: 'text', decimals: undefined });
      await formulaFails(create(t.id, { code: code(), name: 'Text equation', initial_version: { result_type: 'text', formula_expression: `${txt.code}` } }), '/initial_version/formula_expression');
      await formulaFails(create(t.id, { code: code(), name: 'Over text', initial_version: { result_type: 'numeric', decimals: 1, formula_expression: `${txt.code} * 2` } }), '/initial_version/formula_expression');
    });
    it('a draft update that adds a formula to another test\'s analyte, or closes a cycle, is 422 at /formula_expression', { timeout: T }, async () => {
      const t = await mkTest(A); const t2 = await mkTest(A);
      const other = await mkAnalyte(A, t2.id, { code: `OX${tag(4)}` });
      const a = await mkAnalyte(A, t.id, { code: `AA${tag(4)}` }); const b = await mkAnalyte(A, t.id, { code: `BB${tag(4)}` });
      const da = await draftOf(a.id), db = await draftOf(b.id);
      await formulaFails(updDraft(da.id, da.version, { formula_expression: `${other.code} + 1` }), '/formula_expression');
      expect((await updDraft(da.id, da.version, { formula_expression: `${b.code} + 1` })).status).toBe(200);
      await formulaFails(updDraft(db.id, db.version, { formula_expression: `${a.code} + 1` }), '/formula_expression');
    });
  });
});

describe('(4) clinical sign-off model untouched', () => {
  it('updateAnalyte accepts display fields only: every clinical field is an unknown field (400 + path, no write)', { timeout: T }, async () => {
    const t = await mkTest(A);
    const a = await mkAnalyte(A, t.id);
    for (const [k, v] of Object.entries({ result_type: 'text', unit_code: 'g', decimals: 2, method_id: A.method.id, value_set_code: 'X', formula_expression: '1', default_value: 'x', long_text_value: 'x', high_low: '1', require_verification: true })) {
      await expectInvalid('updateAnalyte', req({ params: { analyte_id: a.id }, headers: im(1), body: { [k]: v } }), `/${k}`);
    }
  });
  it('display fields update in place: same row, version +1, audit line with the changed columns, one catalog.changed.v1 entity analyte / updated; the published version row is byte-identical', { timeout: T }, async () => {
    const t = await mkTest(A);
    const a = await mkAnalyte(A, t.id, { ...DISPLAY, print_on_negative: true });
    const pub = await publishVersion(a);
    const before = await ownerRows('catalog.analyte_versions', 'analyte_id = $1', [a.id]);
    const r = await updAnalyte(a.id, a.version, { trend_name: 'New trend', font: 'Verdana', send_in_sms: false, print_on_negative: false, result_display_type: 'hidden' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: a.id, trend_name: 'New trend', font: 'Verdana', send_in_sms: false, print_on_negative: false, result_display_type: 'hidden', version: a.version + 1 });
    expect(r.body.current_version).toMatchObject({ id: pub.id, status: 'published' });
    const after = await ownerRows('catalog.analyte_versions', 'analyte_id = $1', [a.id]);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    const audit = (await auditRows('analytes', a.id)).filter((x: any) => x.action === 'UPDATE');
    expect(audit).toHaveLength(1);
    for (const c of ['trend_name', 'font', 'send_in_sms', 'print_on_negative', 'result_display_type']) expect(audit[0].changed_columns, c).toContain(c);
    expect(audit[0].changed_columns).not.toContain('nabl');
    expect((await changedEvents(TENANT_A, a.id)).map((e: any) => `${e.envelope.payload.entity_type}:${e.envelope.payload.change_kind}`)).toEqual(['analyte:created', 'analyte:versioned', 'analyte:updated']);
  });
  it('unset clears trend_name / specimen_type_id / font / result_display_type; a stale If-Match is 409; another tenant is 404', { timeout: T }, async () => {
    const t = await mkTest(A);
    const a = await mkAnalyte(A, t.id, { ...DISPLAY, specimen_type_id: A.spec.id });
    const r = await updAnalyte(a.id, a.version, { unset: ['trend_name', 'specimen_type_id', 'font', 'result_display_type'] });
    for (const k of ['trend_name', 'specimen_type_id', 'font', 'result_display_type']) { expect(r.body[k], k).toBeUndefined(); expect((await dbRow('analytes', a.id))[k], `column ${k}`).toBeNull(); }
    expectCode(await fails('updateAnalyte', req({ params: { analyte_id: a.id }, headers: im(1), body: { font: 'x' } })), 'common.version_conflict', 409);
    expectCode(await fails('updateAnalyte', req({ params: { analyte_id: a.id }, headers: im(2), body: { font: 'x' } }), { tenant: TENANT_B }), 'common.not_found', 404);
  });
  it('a change to result type, unit, decimals and equation can only go into a draft: the published version keeps serving until publishAnalyteVersion publishes the draft', { timeout: T }, async () => {
    const t = await mkTest(A);
    const a = await mkAnalyte(A, t.id, {}, { decimals: 1 });
    const v1 = await publishVersion(a);
    const g = (await call('createAnalyteVersionDraft', req({ params: { analyte_id: a.id }, body: {}, headers: { 'idempotency-key': uid() } }))).body;
    const u = await updDraft(g.id, g.version, { decimals: 3, default_value: 'x', require_verification: true });
    expect(u.body).toMatchObject({ decimals: 3, status: 'draft' });
    const live = await detail(a.id);
    expect(live.current_version).toMatchObject({ id: v1.id, status: 'published', decimals: 1 });
    expect(live.draft_version_id).toBe(g.id);
    expect(live.current_version.default_value).toBeUndefined();
    // the published version row itself rejects an update through the service (catalog.version_in_use) and through the database
    expectCode(await fails('updateAnalyteVersionDraft', req({ params: { analyte_version_id: v1.id }, headers: im(v1.version), body: { decimals: 5 } })), 'catalog.version_in_use', 409);
    const e = await ownerRows('catalog.analyte_versions', 'id = $1', [v1.id]);
    expect(e[0]).toMatchObject({ decimals: 1, status: 'published' });
    const pub = await call('publishAnalyteVersion', req({ params: { analyte_version_id: g.id }, headers: im(u.body.version), body: { change_reason: 'synthetic decimals change', allow_without_ranges: true } }));
    expect(pub.status).toBe(200);
    expect(pub.assertCalls, 'both permissions asserted, in this order').toEqual(['catalog.test.manage', 'catalog.reference_range.publish']);
    const after = await detail(a.id);
    expect(after.current_version).toMatchObject({ id: g.id, status: 'published', decimals: 3, default_value: 'x', require_verification: true });
  });
  it('without catalog.reference_range.publish nothing goes live: 403 auth.forbidden, the draft stays a draft, no write', { timeout: T }, async () => {
    const t = await mkTest(A);
    const a = await mkAnalyte(A, t.id);
    const d = await draftOf(a.id);
    const e = await fails('publishAnalyteVersion', req({ params: { analyte_version_id: d.id }, headers: im(d.version), body: { change_reason: 'no right', allow_without_ranges: true } }), { grants: ['catalog.test.manage', 'catalog.test.read'] });
    expectCode(e, 'auth.forbidden', 403);
    expect((await ownerRows('catalog.analyte_versions', 'id = $1', [d.id]))[0].status).toBe('draft');
  });
  it('another tenant cannot edit, publish or create a draft on this analyte (404, nothing changes)', { timeout: T }, async () => {
    const t = await mkTest(A);
    const a = await mkAnalyte(A, t.id);
    const d = await draftOf(a.id);
    expectCode(await fails('updateAnalyteVersionDraft', req({ params: { analyte_version_id: d.id }, headers: im(d.version), body: { default_value: 'x' } }), { tenant: TENANT_B }), 'common.not_found', 404);
    expectCode(await fails('publishAnalyteVersion', req({ params: { analyte_version_id: d.id }, headers: im(d.version), body: { change_reason: 'x', allow_without_ranges: true } }), { tenant: TENANT_B }), 'common.not_found', 404);
    expectCode(await fails('createAnalyte', req({ params: { test_id: t.id }, body: { code: code(), name: 'Intruder', initial_version: { result_type: 'text' } }, headers: { 'idempotency-key': uid() } }), { tenant: TENANT_B }), 'common.not_found', 404);
    expect((await ownerRows('catalog.analyte_versions', 'id = $1', [d.id]))[0]).toMatchObject({ status: 'draft', default_value: null });
  });
});
