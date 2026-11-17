// T0B-TESTMGMT-1 (LD-318, done_when 2, 4, 7): the 24 new Test fields, seven stage TAT targets, category link, list / search summary fields, in-place updates with audit.
// PINNED PICKS: stage_targets are written through setTestTatTargets (TatTargetsSet.stage_targets), UPSERT by stage in the SAME row (id kept, version +1, no DELETE),
// stages that are not sent keep their value, `targets` (seconds) is still required and untouched by this; the Test reply lists stage_targets in the order registration,
// sample_collection, accession, result, approval_1, approval_2, release (only the stages that have a value). Unset of an optional field clears the column.
import { beforeAll, describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_B, T, auditRows, call, catalogRevision, changedEvents, dbRow, expectCode, expectInvalid, fails, im, mkTest, ownerRows, req, schemaErrors, tag, testBody, uid, world, type World } from './helpers.js';

let A: World; let B: World;
beforeAll(async () => { A = await world(TENANT_A); B = await world(TENANT_B); }, T);

const ALL = (cat?: string) => ({
  short_name: 'CBC', display_name: 'COMPLETE BLOOD COUNT, EDTA(HM011)', tags: ['cbc', 'haemogram'], barcode_text: 'BC-0011', loyalty_points: 25, display_order: 12,
  description: 'Synthetic description', report_type: 'cbc_four_column', processing_type: 'branch_transfer', template_ref: 'TPL-CBC-1', outsource_name: 'Synthetic Reference Lab',
  is_outsourced: true, is_popular: true, smart_report: true, print_category_wise: true, nabl: true, accab_logo: true, auto_approval_enabled: true,
  use_normal_range_for_auto_approval: true, template_test: true, nabl_processing_centres: ['Centre One', 'Centre Two'], font: 'Arial', alert_before_expiry_minutes: 90,
  ...(cat ? { category_id: cat } : {}),
});
const DEFAULTS = { loyalty_points: 0, is_outsourced: false, is_popular: false, smart_report: false, print_category_wise: false, nabl: false, accab_logo: false,
  auto_approval_enabled: false, use_normal_range_for_auto_approval: false, template_test: false };
const category = async (w: World) => (await call('createTestCategory', req({ headers: { 'idempotency-key': uid() }, body: { department_id: w.dept.id, name: `Cat ${tag()}` } }), { tenant: w.tenant })).body;
const get = (id: string, tenant = TENANT_A) => call('getTestDetail', req({ params: { test_id: id } }), { tenant });
const patch = (id: string, version: number, body: object, tenant = TENANT_A) => call('updateTest', req({ params: { test_id: id }, headers: im(version), body }), { tenant });

describe('(2) persist, read and map every new field', () => {
  it('createTest with all 24 fields -> 201 Test (schema valid) echoing each; getTestDetail returns the same; every column is stored', { timeout: T }, async () => {
    const cat = await category(A);
    const input = ALL(cat.id);
    const r = await call('createTest', req({ headers: { 'idempotency-key': uid() }, body: testBody(A, input) }));
    expect(r.status).toBe(201);
    expect(schemaErrors('Test', r.body)).toEqual([]);
    for (const [k, v] of Object.entries(input)) expect(r.body[k], k).toEqual(v);
    const g = await get(r.body.id);
    expect(schemaErrors('Test', g.body)).toEqual([]);
    for (const [k, v] of Object.entries(input)) expect(g.body[k], `get ${k}`).toEqual(v);
    const row = await dbRow('tests', r.body.id);
    for (const k of Object.keys(input)) expect(row[k], `column ${k}`).toEqual((input as any)[k]);
    expect(row.tenant_id).toBe(TENANT_A);
  });
  it('a test created the old way (no new field, no tags) is unchanged: 201, the 10 booleans / counters take their defaults, optional fields are absent', { timeout: T }, async () => {
    const { tags: _t, ...legacy } = testBody(A);
    const r = await call('createTest', req({ headers: { 'idempotency-key': uid() }, body: legacy }));
    expect(r.status).toBe(201);
    expect(schemaErrors('Test', r.body)).toEqual([]);
    for (const [k, v] of Object.entries(DEFAULTS)) expect(r.body[k], k).toBe(v);
    for (const k of ['short_name', 'display_name', 'barcode_text', 'description', 'report_type', 'processing_type', 'template_ref', 'outsource_name', 'font', 'category_id', 'alert_before_expiry_minutes']) expect(r.body[k], k).toBeUndefined();
    expect(r.body.stage_targets ?? []).toEqual([]);
  });
  it('every enum value is accepted: 10 report types, 3 processing types', { timeout: T }, async () => {
    for (const report_type of ['four_column', 'three_column', 'two_column', 'graph', 'template_based_html', 'micro_automated', 'cbc_four_column', 'micro_manual', 'histo', 'four_column_10_font']) {
      expect((await call('createTest', req({ headers: { 'idempotency-key': uid() }, body: testBody(A, { report_type }) }))).body.report_type, report_type).toBe(report_type);
    }
    for (const processing_type of ['local', 'branch_transfer', 'outsource_branch']) {
      expect((await call('createTest', req({ headers: { 'idempotency-key': uid() }, body: testBody(A, { processing_type }) }))).body.processing_type, processing_type).toBe(processing_type);
    }
  });
  it('boundary values are accepted: display_name 3 and 300 chars, loyalty_points 0 and 1000000, display_order 0 and 9999, alert 0 and 525600, 20 tags, 20 centres', { timeout: T }, async () => {
    const r = await call('createTest', req({ headers: { 'idempotency-key': uid() }, body: testBody(A, {
      display_name: 'x'.repeat(300), loyalty_points: 1_000_000, display_order: 9999, alert_before_expiry_minutes: 525600,
      tags: Array.from({ length: 20 }, (_, i) => `t${i}`), nabl_processing_centres: Array.from({ length: 20 }, (_, i) => `c${i}`) }) }));
    expect(r.status).toBe(201);
    const s = await call('createTest', req({ headers: { 'idempotency-key': uid() }, body: testBody(A, { display_name: 'abc', loyalty_points: 0, display_order: 0, alert_before_expiry_minutes: 0 }) }));
    expect(s.status).toBe(201);
  });
  it('a test can be linked to a category of its tenant; unknown / other tenant category: 404 common.not_found; a deactivated category: 400 at /category_id', { timeout: T }, async () => {
    const cat = await category(A);
    expect((await call('createTest', req({ headers: { 'idempotency-key': uid() }, body: testBody(A, { category_id: cat.id }) }))).body.category_id).toBe(cat.id);
    const foreign = await category(B);
    for (const id of [uid(), foreign.id]) expectCode(await fails('createTest', req({ headers: { 'idempotency-key': uid() }, body: testBody(A, { category_id: id }) })), 'common.not_found', 404);
    const off = await category(A);
    await call('updateTestCategory', req({ params: { category_id: off.id }, headers: im(1), body: { is_active: false } }));
    await expectInvalid('createTest', req({ headers: { 'idempotency-key': uid() }, body: testBody(A, { category_id: off.id }) }), '/category_id');
  });
});

describe('seven stage TAT targets (minutes) through setTestTatTargets', () => {
  const ROUTINE = [{ priority: 'routine', segment: 'total', target_seconds: 3600 }];
  const stages = (o: Record<string, number> = {}) => Object.entries({ registration: 5, sample_collection: 15, accession: 10, result: 120, approval_1: 30, approval_2: 30, release: 10, ...o }).map(([stage, target_minutes]) => ({ stage, target_minutes }));
  const setTat = (id: string, version: number, body: object) => call('setTestTatTargets', req({ params: { test_id: id }, headers: im(version), body }));

  it('all seven stages are stored and returned in stage order; the routine/urgent seconds targets are written as before', { timeout: T }, async () => {
    const t = await mkTest(A);
    const r = await setTat(t.id, 1, { targets: ROUTINE, stage_targets: stages() });
    expect(r.status).toBe(200);
    expect(schemaErrors('Test', r.body)).toEqual([]);
    expect(r.body.stage_targets).toEqual(stages());
    expect(r.body.tat_targets).toHaveLength(1);
    expect(r.body.version).toBe(2);
    const rows = await ownerRows('catalog.test_stage_tat_targets', 'tenant_id = $1 AND test_id = $2', [TENANT_A, t.id]);
    expect(rows).toHaveLength(7);
    expect(rows.every((x: any) => x.tenant_id === TENANT_A && x.is_active === true)).toBe(true);
  });
  it('a second call updates in place: same row ids, same row count, only the sent stage changes, the others keep their value; absent stage_targets changes nothing', { timeout: T }, async () => {
    const t = await mkTest(A);
    await setTat(t.id, 1, { targets: ROUTINE, stage_targets: stages() });
    const before = await ownerRows('catalog.test_stage_tat_targets', 'test_id = $1 ORDER BY stage', [t.id]);
    const r = await setTat(t.id, 2, { targets: ROUTINE, stage_targets: [{ stage: 'result', target_minutes: 90 }] });
    expect(r.body.stage_targets).toEqual(stages({ result: 90 }));
    const after = await ownerRows('catalog.test_stage_tat_targets', 'test_id = $1 ORDER BY stage', [t.id]);
    expect(after.map((x: any) => x.id)).toEqual(before.map((x: any) => x.id));
    expect(after.find((x: any) => x.stage === 'result').target_minutes).toBe(90);
    const same = await setTat(t.id, 3, { targets: ROUTINE });
    expect(same.body.stage_targets).toEqual(stages({ result: 90 }));
  });
  it.each([
    ['unknown stage', [{ stage: 'billing', target_minutes: 5 }], '/stage_targets/0/stage'],
    ['negative minutes', [{ stage: 'result', target_minutes: -1 }], '/stage_targets/0/target_minutes'],
    ['minutes above 43200', [{ stage: 'result', target_minutes: 43201 }], '/stage_targets/0/target_minutes'],
    ['fractional minutes', [{ stage: 'result', target_minutes: 1.5 }], '/stage_targets/0/target_minutes'],
    ['the same stage twice', [{ stage: 'result', target_minutes: 5 }, { stage: 'result', target_minutes: 6 }], '/stage_targets/1/stage'],
    ['more than seven', Array.from({ length: 8 }, (_, i) => ({ stage: 'result', target_minutes: i })), '/stage_targets'],
    ['an unknown key', [{ stage: 'result', target_minutes: 5, note: 'x' }], '/stage_targets/0/note'],
  ])('rejected before any write: %s', { timeout: T }, async (_n, stage_targets, path) => {
    const t = await mkTest(A);
    await expectInvalid('setTestTatTargets', req({ params: { test_id: t.id }, headers: im(1), body: { targets: ROUTINE, stage_targets } }), path);
  });
  it('another tenant cannot set or read them: 404 common.not_found, nothing written', { timeout: T }, async () => {
    const t = await mkTest(A);
    expectCode(await fails('setTestTatTargets', req({ params: { test_id: t.id }, headers: im(1), body: { targets: ROUTINE, stage_targets: stages() } }), { tenant: TENANT_B }), 'common.not_found', 404);
    expect(await ownerRows('catalog.test_stage_tat_targets', 'test_id = $1', [t.id])).toHaveLength(0);
  });
});

describe('(4) display-only fields update in place, with an audit event', () => {
  it('updateTest changes the display fields in the same row: version +1, audit row names the changed columns, one catalog.changed.v1, revision +1', { timeout: T }, async () => {
    const t = await mkTest(A, ALL());
    const r0 = await catalogRevision(TENANT_A);
    const r = await patch(t.id, 1, { short_name: 'CBC2', is_popular: false, loyalty_points: 3, font: 'Times', tags: ['one'] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: t.id, short_name: 'CBC2', is_popular: false, loyalty_points: 3, font: 'Times', tags: ['one'], version: 2, display_name: ALL().display_name });
    expect(await catalogRevision(TENANT_A)).toBe(r0 + 1);
    const audit = (await auditRows('tests', t.id)).filter((x: any) => x.action === 'UPDATE');
    expect(audit).toHaveLength(1);
    for (const c of ['short_name', 'is_popular', 'loyalty_points', 'font', 'tags']) expect(audit[0].changed_columns, c).toContain(c);
    expect(audit[0].changed_columns).not.toContain('report_type');
    expect(audit[0].old_values.short_name).toBe('CBC');
    expect(audit[0].new_values.short_name).toBe('CBC2');
    expect((await changedEvents(TENANT_A, t.id)).map((e: any) => e.envelope.payload.change_kind)).toEqual(['created', 'updated']);
  });
  it('unset clears optional fields (and only those): the column goes NULL, the reply omits it', { timeout: T }, async () => {
    const cat = await category(A);
    const t = await mkTest(A, ALL(cat.id));
    const r = await patch(t.id, 1, { unset: ['short_name', 'display_name', 'barcode_text', 'description', 'template_ref', 'outsource_name', 'nabl_processing_centres', 'font', 'alert_before_expiry_minutes', 'category_id', 'report_type', 'processing_type'] });
    expect(r.status).toBe(200);
    for (const k of ['short_name', 'display_name', 'barcode_text', 'description', 'template_ref', 'outsource_name', 'nabl_processing_centres', 'font', 'alert_before_expiry_minutes', 'category_id', 'report_type', 'processing_type']) {
      expect(r.body[k], k).toBeUndefined();
      expect((await dbRow('tests', t.id))[k], `column ${k}`).toBeNull();
    }
    expect(r.body.tags).toEqual(['cbc', 'haemogram']);
    await expectInvalid('updateTest', req({ params: { test_id: t.id }, headers: im(2), body: { unset: ['tags'] } }), '/unset');
    await expectInvalid('updateTest', req({ params: { test_id: t.id }, headers: im(2), body: { font: 'Arial', unset: ['font'] } }), '/unset');
  });
  it('stale If-Match is 409 common.version_conflict and writes nothing; missing is 428', { timeout: T }, async () => {
    const t = await mkTest(A);
    await patch(t.id, 1, { short_name: 'ONE' });
    expectCode(await fails('updateTest', req({ params: { test_id: t.id }, headers: im(1), body: { short_name: 'TWO' } })), 'common.version_conflict', 409);
    expectCode(await fails('updateTest', req({ params: { test_id: t.id }, body: { short_name: 'TWO' } })), 'common.precondition_required', 428);
    expect((await dbRow('tests', t.id)).short_name).toBe('ONE');
  });
  it('another tenant: 404 and the row is untouched', { timeout: T }, async () => {
    const t = await mkTest(A, { short_name: 'MINE' });
    expectCode(await fails('updateTest', req({ params: { test_id: t.id }, headers: im(1), body: { short_name: 'THEIRS' } }), { tenant: TENANT_B }), 'common.not_found', 404);
    expect((await dbRow('tests', t.id)).short_name).toBe('MINE');
    expectCode(await fails('getTestDetail', req({ params: { test_id: t.id } }), { tenant: TENANT_B }), 'common.not_found', 404);
  });
});

describe('list and search summaries (OrderableSummary)', () => {
  it('listTests filters by category_id and each summary carries category_id, category_name, short_name, display_name; default_price_paisa is absent without a price', { timeout: T }, async () => {
    const w = await world(TENANT_A);
    const cat = await category(w);
    const inCat = await mkTest(w, { category_id: cat.id, short_name: 'SHORT', display_name: 'Display name 1' });
    await mkTest(w);
    const r = await call('listTests', req({ query: { category_id: cat.id, department_id: w.dept.id } }));
    expect(schemaErrors('OrderableSummaryPage', r.body)).toEqual([]);
    expect(r.body.data.map((x: any) => x.id)).toEqual([inCat.id]);
    expect(r.body.data[0]).toMatchObject({ category_id: cat.id, category_name: cat.name, short_name: 'SHORT', display_name: 'Display name 1' });
    expect(r.body.data[0].default_price_paisa).toBeUndefined();
    const s = await call('searchOrderables', req({ query: { q: inCat.code } }));
    expect(s.body.data.find((x: any) => x.id === inCat.id)).toMatchObject({ short_name: 'SHORT', category_name: cat.name });
  });
  it('listTests category_id of another tenant returns nothing; a malformed one is a validation error', { timeout: T }, async () => {
    const foreign = await category(B);
    expect((await call('listTests', req({ query: { category_id: foreign.id } }))).body.data).toEqual([]);
    await expectInvalid('listTests', req({ query: { category_id: 'nope' } }), '/category_id');
  });
});
