// T0B-TESTMGMT-1 (LD-318, done_when 3): strict validation of the Test fields in the domain layer, never only in the database. Every rejection must be the standard
// validation error (400 common.validation_failed) naming the field path AND must happen before any write statement (expectInvalid asserts both), so a database CHECK
// can never be the only guard.
// PINNED PICK (flagged to the lead): "tags required for an orderable test" cannot apply to a legacy request, because dozens of existing catalog tests (and the import
//  commit) create tests with none of the new fields and must stay green unchanged. The rule therefore fires when the request touches ANY new parity field (the 24 of
//  TestCreate / TestUpdate) and the resulting test is orderable with no tags; a body with none of the new fields behaves exactly as before.
import { beforeAll, describe, expect, it } from 'vitest';
import { T, call, expectInvalid, im, mkTest, req, testBody, uid, world, type World } from './helpers.js';

let W: World;
beforeAll(async () => { W = await world(); }, T);

const create = (over: Record<string, unknown>, drop: string[] = []) => {
  const b: Record<string, unknown> = testBody(W, over);
  for (const k of drop) delete b[k];
  return req({ headers: { 'idempotency-key': uid() }, body: b });
};
const long = (n: number) => 'x'.repeat(n);

const BAD: Array<[string, Record<string, unknown>, string]> = [
  ['display_name of 2 characters', { display_name: 'ab' }, '/display_name'],
  ['display_name of 1 character', { display_name: 'a' }, '/display_name'],
  ['display_name over 300', { display_name: long(301) }, '/display_name'],
  ['display_name not a string', { display_name: 12345 }, '/display_name'],
  ['short_name empty', { short_name: '' }, '/short_name'],
  ['short_name over 60', { short_name: long(61) }, '/short_name'],
  ['barcode_text empty', { barcode_text: '' }, '/barcode_text'],
  ['barcode_text over 64', { barcode_text: long(65) }, '/barcode_text'],
  ['description empty', { description: '' }, '/description'],
  ['description over 2000', { description: long(2001) }, '/description'],
  ['template_ref over 120', { template_ref: long(121) }, '/template_ref'],
  ['outsource_name over 200', { outsource_name: long(201) }, '/outsource_name'],
  ['font over 60', { font: long(61) }, '/font'],
  ['loyalty_points negative', { loyalty_points: -1 }, '/loyalty_points'],
  ['loyalty_points above 1000000', { loyalty_points: 1_000_001 }, '/loyalty_points'],
  ['loyalty_points fractional', { loyalty_points: 1.5 }, '/loyalty_points'],
  ['loyalty_points as text', { loyalty_points: '5' }, '/loyalty_points'],
  ['display_order negative', { display_order: -1 }, '/display_order'],
  ['display_order above 9999', { display_order: 10_000 }, '/display_order'],
  ['alert_before_expiry_minutes negative', { alert_before_expiry_minutes: -5 }, '/alert_before_expiry_minutes'],
  ['alert_before_expiry_minutes above 525600', { alert_before_expiry_minutes: 525_601 }, '/alert_before_expiry_minutes'],
  ['report_type outside the list', { report_type: 'five_column' }, '/report_type'],
  ['report_type in the wrong case', { report_type: 'FOUR_COLUMN' }, '/report_type'],
  ['processing_type outside the list', { processing_type: 'remote' }, '/processing_type'],
  ['tag empty', { tags: [''] }, '/tags/0'],
  ['tag over 60', { tags: [long(61)] }, '/tags/0'],
  ['21 tags', { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }, '/tags'],
  ['duplicate tags', { tags: ['a', 'a'] }, '/tags'],
  ['tags not a list', { tags: 'cbc' }, '/tags'],
  ['21 NABL centres', { nabl_processing_centres: Array.from({ length: 21 }, (_, i) => `c${i}`) }, '/nabl_processing_centres'],
  ['duplicate NABL centres', { nabl_processing_centres: ['a', 'a'] }, '/nabl_processing_centres'],
  ['NABL centre over 200', { nabl_processing_centres: [long(201)] }, '/nabl_processing_centres/0'],
  ['category_id not a uuid', { category_id: 'abc' }, '/category_id'],
  ...['is_outsourced', 'is_popular', 'smart_report', 'print_category_wise', 'nabl', 'accab_logo', 'auto_approval_enabled', 'use_normal_range_for_auto_approval', 'template_test']
    .map((k): [string, Record<string, unknown>, string] => [`${k} not a boolean`, { [k]: 'true' }, `/${k}`]),
  ['an unknown field', { loyalty_pts: 3 }, '/loyalty_pts'],
  ['stage_targets on create (they go through setTestTatTargets)', { stage_targets: [{ stage: 'result', target_minutes: 5 }] }, '/stage_targets'],
];

describe('createTest: every rule returns 400 with the field path, before any write', () => {
  it.each(BAD)('%s', { timeout: T }, async (_n, over, path) => { await expectInvalid('createTest', create(over), path); });

  it('tags: an orderable test that touches a parity field needs at least one tag (empty list and missing list both fail at /tags)', { timeout: T }, async () => {
    await expectInvalid('createTest', create({ display_name: 'Haemoglobin test', tags: [] }), '/tags');
    await expectInvalid('createTest', create({ display_name: 'Haemoglobin test' }, ['tags']), '/tags');
    await expectInvalid('createTest', create({ short_name: 'HB', is_orderable: true }, ['tags']), '/tags');
  });
  it('tags: not required when the test is not orderable, and not required for a legacy body (none of the new fields)', { timeout: T }, async () => {
    expect((await call('createTest', create({ display_name: 'Not orderable', is_orderable: false }, ['tags']))).status).toBe(201);
    expect((await call('createTest', create({}, ['tags']))).status).toBe(201);
  });
  it('several broken fields are ALL reported in one answer (errors[] lists every path, not only the first)', { timeout: T }, async () => {
    const e = await call('createTest', create({ display_name: 'ab', loyalty_points: -1, report_type: 'nope', display_order: 99999 })).then(() => undefined, (x) => x);
    expect(e?.code).toBe('common.validation_failed');
    for (const p of ['/display_name', '/loyalty_points', '/report_type', '/display_order']) expect((e.errors ?? []).map((x: any) => x.path), p).toContain(p);
  });
  it('a rejected create leaves no orderable, test or specimen row behind', { timeout: T }, async () => {
    const code = `RJ${uid().slice(-6).toUpperCase()}`;
    await call('createTest', create({ code, display_name: 'ab' })).then(() => undefined, () => undefined);
    const rows = await call('listTests', req({ query: { is_active: 'all', department_id: W.dept.id, limit: 200 } }));
    expect(rows.body.data.map((x: any) => x.code)).not.toContain(code);
  });
});

describe('updateTest: the same rules, evaluated on the resulting test', () => {
  it.each(BAD.filter(([, o]) => !('stage_targets' in o)))('%s', { timeout: T }, async (_n, over, path) => {
    const t = await mkTest(W);
    const { tags, ...rest } = over as Record<string, unknown>;
    await expectInvalid('updateTest', req({ params: { test_id: t.id }, headers: im(1), body: tags === undefined ? rest : { ...rest, tags } }), path);
  });
  it('removing the last tag from an orderable test fails at /tags; making a tagless parity test orderable fails at /tags; a non orderable test may have no tags', { timeout: T }, async () => {
    const t = await mkTest(W, { tags: ['one'], display_name: 'Has a tag' });
    await expectInvalid('updateTest', req({ params: { test_id: t.id }, headers: im(1), body: { tags: [] } }), '/tags');
    const off = await mkTest(W, { display_name: 'Not orderable', is_orderable: false, tags: undefined });
    expect((await call('updateTest', req({ params: { test_id: off.id }, headers: im(1), body: { short_name: 'NO' } }))).status).toBe(200);
    await expectInvalid('updateTest', req({ params: { test_id: off.id }, headers: im(2), body: { is_orderable: true } }), '/tags');
  });
  it('code and the specimen requirements are not update fields (unchanged contract)', { timeout: T }, async () => {
    const t = await mkTest(W);
    await expectInvalid('updateTest', req({ params: { test_id: t.id }, headers: im(1), body: { code: 'NEWCODE' } }), '/code');
  });
});
