// C14 T11 — #5-#17: blocks, rules, analyte mappings, group settings of a DRAFT library (06-PLAN T11; 02-TRD §5, §5.1; 03-APP-FLOW §1.1 L2, §2.1 step "Edit"; 05-SCHEMA §3.7).
// ACs: AC-03.1, AC-03.2, AC-03.5, AC-03.6, AC-03.7, AC-04.1, AC-04.2, AC-04.3, AC-05.1, AC-05.3, AC-05.4 (+ AC-03.3/03.4 end to end through #18).
// Cross-cutting matrices (authz, cross-tenant, If-Match, non-draft) for ALL 21 operations: library.probes.test.ts. Seams: ../../__tests__/t11.helpers.ts header.
// Fails now: handlers 5-17 are T01 stubs.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../repository/library.repo.js', async () => (await import('../../__tests__/t11.fakes.js')).libraryRepoFake);
vi.mock('../../repository/blocks.repo.js', async () => (await import('../../__tests__/t11.fakes.js')).blocksRepoFake);
vi.mock('../../repository/rules.repo.js', async () => (await import('../../__tests__/t11.fakes.js')).rulesRepoFake);
vi.mock('../../repository/mappings.repo.js', async () => (await import('../../__tests__/t11.fakes.js')).mappingsRepoFake);
vi.mock('../../repository/groups.repo.js', async () => (await import('../../__tests__/t11.fakes.js')).groupsRepoFake);
vi.mock('../../repository/reviews.repo.js', async () => (await import('../../__tests__/t11.fakes.js')).reviewsRepoFake);
vi.mock('../../repository/codedSets.repo.js', async () => (await import('../../__tests__/t11.fakes.js')).codedSetsRepoFake);
vi.mock('../../repository/denyTerms.repo.js', async () => (await import('../../__tests__/t11.fakes.js')).denyTermsRepoFake);

import { sid, starterLibrary, type LibInput } from '../../__tests__/t10.fixtures.js';
import { ANALYTE, ORGAN_GROUPS, TA, TB, VER, VERB, call, codeOf, fails, ifMatch, loadLibrary, pointerOf, reid, request, requestProblems, responseProblems, seed, uid, world } from '../../__tests__/t11.helpers.js';

const D = VER(1);
const MAP_ID = sid(900);
const BLOCK = { high: sid(1), advice: sid(4), disclaimer: sid(5), followup: sid(700) };
const lib = (): LibInput => {
  const l: LibInput = { ...starterLibrary(), mappings: [{ id: MAP_ID, analyteId: ANALYTE.a1, groupCode: 'liver' }] };
  l.blocks.push({ id: BLOCK.followup, blockKey: 'followup.repeat', kind: 'followup', textEn: 'Repeat {test_name} after {interval_days} days.' });
  return l;
};
const parent = () => world.versions.find((v) => v.id === D)!;
const vp = (extra: object = {}) => ({ library_version_id: D, ...extra });
const blockBody = (o: object = {}) => ({ block_key: 'deranged.alt.high', kind: 'deranged', text_en: '{analyte_name} is above the reference range of your laboratory.', ...o });
const ruleBody = (o: object = {}) => ({ rule_kind: 'deranged', trigger_kind: 'analyte', analyte_id: ANALYTE.a1, direction: 'high', min_severity: 'out_of_range', block_id: BLOCK.high, ...o });
const followBody = (o: object = {}) => ({ rule_kind: 'followup', trigger_kind: 'any', direction: 'high', min_severity: 'out_of_range', block_id: BLOCK.followup, suggested_test_id: uid(0x700), interval_days: 30, ...o });
const freeze = () => { parent().status = 'in_review'; parent().content_sha256 = 'a'.repeat(64); };
const writes = () => world.writes.length;
beforeEach(() => { seed(); loadLibrary(TA, D, lib(), { version_no: 1, groups: true }); });

// ================================================================= blocks (#5-#8)
describe('C14-T11 #5 listSmartTemplateBlocks', () => {
  it('200 ACTIVE blocks ordered by block_key; valid TemplateBlock shapes (null fields omitted, placeholders always present)', async () => {
    world.blocks.push({ ...world.blocks[0], id: uid(0xf001), block_key: 'removed.block', is_active: false });
    const r = await call('listSmartTemplateBlocks', 'lab_manager', request({ params: vp() })).run();
    expect(r.status).toBe(200);
    expect(responseProblems('listSmartTemplateBlocks', r)).toEqual([]);
    const keys = r.body.data.map((b: any) => b.block_key);
    expect(keys).toEqual([...keys].sort());
    expect(keys).toHaveLength(7); expect(keys).not.toContain('removed.block');
    const high = r.body.data.find((b: any) => b.block_key === 'deranged.generic.high');
    expect(high).toMatchObject({ id: BLOCK.high, kind: 'deranged', placeholders: ['analyte_name'], version: 1 });
    expect(high).not.toHaveProperty('text_ne'); expect(high).not.toHaveProperty('note');
    for (const k of ['tenant_id', 'library_version_id', 'is_active', 'created_by']) expect(high).not.toHaveProperty(k);
  });
  it('kind filter', async () => {
    const r = await call('listSmartTemplateBlocks', 'lab_manager', request({ params: vp(), query: { kind: 'disclaimer' } })).run();
    expect(r.body.data.map((b: any) => b.block_key)).toEqual(['disclaimer.main']);
  });
  it('readable when the library is in_review / approved (reads are not draft-only)', async () => {
    freeze();
    expect((await call('listSmartTemplateBlocks', 'lab_manager', request({ params: vp() })).run()).status).toBe(200);
  });
});

describe('C14-T11 #6 createSmartTemplateBlock (AC-03.1, AC-03.2, AC-03.5, AC-03.7)', () => {
  const create = (body: unknown, persona: 'lab_manager' | 'pathologist' = 'lab_manager') => call('createSmartTemplateBlock', persona, request({ params: vp(), body }));
  it('AC-03.1: stored NFC-normalised, returned with placeholders ["analyte_name"], 201; parent version + 1', async () => {
    const r = await create(blockBody({ text_en: '{analyte_name} is above the reference range of your café.' })).run();
    expect(r.status).toBe(201);
    expect(responseProblems('createSmartTemplateBlock', r)).toEqual([]);
    expect(r.body).toMatchObject({ block_key: 'deranged.alt.high', kind: 'deranged', placeholders: ['analyte_name'], version: 1, text_en: '{analyte_name} is above the reference range of your café.' });
    const row = world.blocks.find((b) => b.id === r.body.id)!;
    expect(row).toMatchObject({ tenant_id: TA, library_version_id: D, is_active: true, text_en: '{analyte_name} is above the reference range of your café.' });
    expect(parent().version).toBe(2);
  });
  it('AC-03.5: Devanagari text_ne is stored and returned unchanged (NFC); placeholders are the union of both texts', async () => {
    const ne = '{analyte_name} प्रयोगशालाको सामान्य सीमा भन्दा माथि छ।';
    const r = await create(blockBody({ block_key: 'deranged.alt.ne', text_ne: ne })).run();
    expect(r.body.text_ne).toBe(ne);
    expect(world.blocks.find((b) => b.id === r.body.id)!.text_ne).toBe(ne);
    expect([...r.body.placeholders].sort()).toEqual(['analyte_name']);
  });
  it('a block with a note and no text_en but a text_ne is valid (at least one text)', async () => {
    const r = await create(blockBody({ block_key: 'deranged.only.ne', text_en: undefined, text_ne: 'सामान्य सीमा भन्दा माथि', note: 'Review with the lab' })).run();
    expect(r.status).toBe(201); expect(r.body.note).toBe('Review with the lab');
  });
  it('digits and unknown placeholders are NOT refused on write (AC-03.3/03.4 are validation findings): 201, then #18 reports digits_not_allowed / placeholder_unknown', async () => {
    const a = await create(blockBody({ block_key: 'advice.digit', kind: 'advice', text_en: 'Please repeat in 3 months.' })).run();
    const b = await create(blockBody({ block_key: 'deranged.dose', text_en: '{analyte_name} {dose}' })).run();
    expect(a.status).toBe(201); expect(b.status).toBe(201); expect(b.body.placeholders).toContain('dose');
    const v = await call('validateSmartLibraryVersion', 'lab_manager', request({ params: vp(), body: {} })).run();
    const codes = (k: string) => v.body.issues.filter((i: any) => i.code === k).map((i: any) => i.block_key);
    expect(codes('digits_not_allowed')).toContain('advice.digit');
    expect(codes('placeholder_unknown')).toContain('deranged.dose');
  });
  it('AC-03.2: text_en of 601 chars -> 400 common.validation_failed with errors[0].path "/text_en"; exactly 600 is fine', async () => {
    const e = await fails(create(blockBody({ text_en: 'a'.repeat(601) })).run());
    expect(codeOf(e)).toBe('common.validation_failed'); expect(pointerOf(e)[0]).toBe('/text_en');
    expect(world.writes).toEqual([]);
    expect((await create(blockBody({ text_en: 'a'.repeat(600) })).run()).status).toBe(201);
  });
  it.each([['text_ne', { text_en: undefined, text_ne: 'अ'.repeat(601) }], ['note', { note: 'n'.repeat(501) }]])('over-long %s -> 400 with that pointer', async (field, over) => {
    const e = await fails(create(blockBody(over)).run());
    expect(codeOf(e)).toBe('common.validation_failed'); expect(pointerOf(e)).toContain(`/${field}`);
  });
  it.each([
    ['block_key with a capital', { block_key: 'Deranged.alt' }, '/block_key'], ['block_key too short', { block_key: 'ab' }, '/block_key'], ['block_key with a space', { block_key: 'a b c' }, '/block_key'],
    ['kind unknown', { kind: 'other' }, '/kind'], ['no text at all', { text_en: undefined }, undefined], ['text_en not a string', { text_en: 5 }, '/text_en'],
  ])('invalid body (%s) -> 400 common.validation_failed, nothing written', async (_n, over, path) => {
    const e = await fails(create(blockBody(over)).run());
    expect(codeOf(e)).toBe('common.validation_failed');
    if (path) expect(pointerOf(e)).toContain(path);
    expect(world.writes).toEqual([]);
  });
  it.each(['placeholders', 'library_version_id', 'tenant_id', 'is_active', 'id', 'version'])('server-owned field %s in the body -> 400 (placeholders are extracted server-side)', async (k) => {
    const e = await fails(create(blockBody({ [k]: k === 'placeholders' ? ['x'] : k === 'is_active' ? false : TB })).run());
    expect(codeOf(e)).toBe('common.validation_failed'); expect(world.writes).toEqual([]);
  });
  it('duplicate ACTIVE block_key -> 422 smartreport.library_invalid, no row', async () => {
    const e = await fails(create(blockBody({ block_key: 'disclaimer.main', kind: 'disclaimer' })).run());
    expect(codeOf(e)).toBe('smartreport.library_invalid'); expect(e.statusCode).toBe(422);
    expect(world.blocks.filter((b) => b.block_key === 'disclaimer.main')).toHaveLength(1);
  });
  it('AC-03.7: after #8 deactivates a block, a new block with the same block_key can be created', async () => {
    const adv = world.blocks.find((b) => b.block_key === 'deranged.generic.abnormal')!;
    world.rules.filter((r) => r.block_id === adv.id).forEach((r) => { r.is_active = false; });
    expect((await call('deleteSmartTemplateBlock', 'lab_manager', request({ params: vp({ block_id: adv.id }), headers: ifMatch(1) })).run()).status).toBe(204);
    const r = await create(blockBody({ block_key: 'deranged.generic.abnormal' })).run();
    expect(r.status).toBe(201); expect(r.body.id).not.toBe(adv.id);
  });
  it('pathologist may author too', async () => { expect((await create(blockBody(), 'pathologist').run()).status).toBe(201); });
});

describe('C14-T11 #7 replaceSmartTemplateBlock', () => {
  const put = (blockId: string, body: unknown, h: object = ifMatch(1)) => call('replaceSmartTemplateBlock', 'lab_manager', request({ params: vp({ block_id: blockId }), headers: h, body }));
  const same = (o: object = {}) => ({ block_key: 'deranged.generic.high', kind: 'deranged', text_en: '{analyte_name} is higher than the reference range.', ...o });
  it('200: texts replaced (NFC), block version + 1, parent version + 1; an omitted text_ne is cleared (PUT = replace)', async () => {
    world.blocks.find((b) => b.id === BLOCK.high)!.text_ne = 'माथि';
    const r = await put(BLOCK.high, same({ text_en: 'Café {analyte_name}' })).run();
    expect(r.status).toBe(200);
    expect(responseProblems('replaceSmartTemplateBlock', r)).toEqual([]);
    expect(r.body).toMatchObject({ id: BLOCK.high, text_en: 'Café {analyte_name}', version: 2 });
    expect(r.body).not.toHaveProperty('text_ne');
    expect(world.blocks.find((b) => b.id === BLOCK.high)!.text_ne).toBeNull();
    expect(parent().version).toBe(2);
  });
  it.each([['block_key', { block_key: 'deranged.renamed' }], ['kind', { kind: 'advice' }]])('%s is immutable -> 422 smartreport.library_invalid, row unchanged', async (_k, over) => {
    const e = await fails(put(BLOCK.high, same(over)).run());
    expect(codeOf(e)).toBe('smartreport.library_invalid');
    expect(world.blocks.find((b) => b.id === BLOCK.high)!.block_key).toBe('deranged.generic.high');
  });
  it('text_en 601 chars -> 400 "/text_en"', async () => {
    const e = await fails(put(BLOCK.high, same({ text_en: 'a'.repeat(601) })).run());
    expect(codeOf(e)).toBe('common.validation_failed'); expect(pointerOf(e)[0]).toBe('/text_en');
  });
  it('a block that was deactivated, or belongs to another tenant, is 404', async () => {
    world.blocks.find((b) => b.id === BLOCK.advice)!.is_active = false;
    expect(codeOf(await fails(put(BLOCK.advice, same({ block_key: 'advice.all_in_range', kind: 'advice' })).run()))).toBe('common.not_found');
    loadLibrary(TB, VERB, reid(starterLibrary(), 9),{ version_no: 1 });
    expect(codeOf(await fails(put(world.blocks.find((b) => b.tenant_id === TB)!.id, same()).run()))).toBe('common.not_found');
  });
});

describe('C14-T11 #8 deleteSmartTemplateBlock deactivates (AC-03.7, 08 A17 P-18(a))', () => {
  const del = (blockId: string, h: object = ifMatch(1)) => call('deleteSmartTemplateBlock', 'lab_manager', request({ params: vp({ block_id: blockId }), headers: h }));
  it('204 no body: the row stays with is_active=false (no DELETE), disappears from #5, parent version + 1', async () => {
    const r = await del(BLOCK.followup).run();
    expect(r.status).toBe(204); expect(responseProblems('deleteSmartTemplateBlock', r)).toEqual([]);
    const row = world.blocks.find((b) => b.id === BLOCK.followup)!;
    expect(row.is_active).toBe(false); expect(row.version).toBe(2);
    expect(parent().version).toBe(2);
    const list = await call('listSmartTemplateBlocks', 'lab_manager', request({ params: vp() })).run();
    expect(list.body.data.map((b: any) => b.id)).not.toContain(BLOCK.followup);
    expect(world.writes.every((w) => !/delete|remove/i.test(w))).toBe(true);
  });
  it('referenced by an ACTIVE rule -> 422 smartreport.library_invalid, row untouched; once the rule is deactivated (#12) the block can go', async () => {
    const e = await fails(del(BLOCK.high).run());
    expect(codeOf(e)).toBe('smartreport.library_invalid'); expect(e.statusCode).toBe(422);
    expect(world.blocks.find((b) => b.id === BLOCK.high)!.is_active).toBe(true);
    const rule = world.rules.find((r) => r.block_id === BLOCK.high)!;
    expect((await call('deleteSmartRule', 'lab_manager', request({ params: vp({ rule_id: rule.id }), headers: ifMatch(1) })).run()).status).toBe(204);
    expect((await del(BLOCK.high).run()).status).toBe(204);
  });
});

// ================================================================= rules (#9-#12)
describe('C14-T11 #9 listSmartRules', () => {
  it('200 ACTIVE rules by priority; Rule shapes validate; rule_kind filter', async () => {
    world.rules.push({ ...world.rules[0], id: uid(0xf002), is_active: false });
    const r = await call('listSmartRules', 'lab_manager', request({ params: vp() })).run();
    expect(r.status).toBe(200); expect(responseProblems('listSmartRules', r)).toEqual([]);
    expect(r.body.data).toHaveLength(4);
    const p = r.body.data.map((x: any) => x.priority); expect(p).toEqual([...p].sort((a: number, b: number) => a - b));
    for (const x of r.body.data) for (const k of ['tenant_id', 'library_version_id', 'is_active', 'block_kind']) expect(x).not.toHaveProperty(k);
    const adv = await call('listSmartRules', 'lab_manager', request({ params: vp(), query: { rule_kind: 'advice' } })).run();
    expect(adv.body.data.map((x: any) => x.rule_kind)).toEqual(['advice']);
  });
});

describe('C14-T11 #10 createSmartRule (AC-05.1, AC-05.3, AC-05.4)', () => {
  const create = (body: unknown) => call('createSmartRule', 'lab_manager', request({ params: vp(), body }));
  it('201 Rule = input + id + version; default priority 100; block_kind derived from the block; parent version + 1', async () => {
    const r = await create(ruleBody()).run();
    expect(r.status).toBe(201); expect(responseProblems('createSmartRule', r)).toEqual([]);
    expect(r.body).toMatchObject({ rule_kind: 'deranged', trigger_kind: 'analyte', analyte_id: ANALYTE.a1, direction: 'high', min_severity: 'out_of_range', priority: 100, block_id: BLOCK.high, version: 1 });
    expect(world.rules.find((x) => x.id === r.body.id)).toMatchObject({ tenant_id: TA, library_version_id: D, block_kind: 'deranged', is_active: true });
    expect(parent().version).toBe(2);
  });
  it('a valid follow-up rule: 201 with suggested_test_id and interval_days (intervals are tenant data, no default)', async () => {
    const r = await create(followBody({ priority: 50 })).run();
    expect(r.status).toBe(201); expect(r.body).toMatchObject({ rule_kind: 'followup', interval_days: 30, suggested_test_id: uid(0x700), priority: 50 });
  });
  it('group trigger, any trigger, and advice all_in_range are accepted', async () => {
    expect((await create(ruleBody({ trigger_kind: 'group', analyte_id: undefined, group_code: 'liver' })).run()).status).toBe(201);
    expect((await create(ruleBody({ trigger_kind: 'any', analyte_id: undefined })).run()).status).toBe(201);
    expect((await create({ rule_kind: 'advice', trigger_kind: 'all_in_range', direction: 'any', block_id: BLOCK.advice }).run()).status).toBe(201);
  });
  it.each([
    ['AC-05.1 follow-up without interval_days', followBody({ interval_days: undefined }), '/interval_days'],
    ['follow-up interval_days 0', followBody({ interval_days: 0 }), '/interval_days'],
    ['follow-up interval_days 731', followBody({ interval_days: 731 }), '/interval_days'],
    ['follow-up without suggested_test_id', followBody({ suggested_test_id: undefined }), '/suggested_test_id'],
    ['AC-05.3 follow-up with all_in_range (conflict-of-interest guard, AB-3)', followBody({ trigger_kind: 'all_in_range', min_severity: undefined, direction: 'any' }), '/trigger_kind'],
    ['AC-05.4 rule_kind deranged but block of kind advice', ruleBody({ block_id: BLOCK.advice }), '/block_id'],
    ['rule_kind follow-up but block of kind deranged', followBody({ block_id: BLOCK.high }), '/block_id'],
    ['block id unknown', ruleBody({ block_id: uid(0xdead) }), '/block_id'],
    ['block of another tenant (no existence oracle)', ruleBody({ block_id: '__TB_BLOCK__' }), '/block_id'],
    ['block deactivated', ruleBody({ block_id: '__DEAD_BLOCK__' }), '/block_id'],
    ['analyte trigger without analyte_id', ruleBody({ analyte_id: undefined }), '/analyte_id'],
    ['group trigger without group_code', ruleBody({ trigger_kind: 'group', analyte_id: undefined }), '/group_code'],
    ['any trigger with an analyte_id', ruleBody({ trigger_kind: 'any' }), '/analyte_id'],
    ['analyte trigger with a group_code', ruleBody({ group_code: 'liver' }), '/group_code'],
    ['finding trigger without min_severity', ruleBody({ min_severity: undefined }), '/min_severity'],
    ['all_in_range with a min_severity', { rule_kind: 'advice', trigger_kind: 'all_in_range', direction: 'any', min_severity: 'critical', block_id: BLOCK.advice }, '/min_severity'],
    ['all_in_range with direction high', { rule_kind: 'advice', trigger_kind: 'all_in_range', direction: 'high', block_id: BLOCK.advice }, '/direction'],
    ['all_in_range on a deranged rule', { rule_kind: 'deranged', trigger_kind: 'all_in_range', direction: 'any', block_id: BLOCK.high }, '/trigger_kind'],
    ['non-follow-up with interval_days', ruleBody({ interval_days: 30 }), '/interval_days'],
    ['non-follow-up with suggested_test_id', ruleBody({ suggested_test_id: uid(0x700) }), '/suggested_test_id'],
    ['priority 0', ruleBody({ priority: 0 }), '/priority'], ['priority 1000', ruleBody({ priority: 1000 }), '/priority'],
    ['direction unknown', ruleBody({ direction: 'sideways' }), '/direction'], ['min_severity unknown', ruleBody({ min_severity: 'mild' }), '/min_severity'],
    ['tenant_id smuggled', ruleBody({ tenant_id: TB }), undefined], ['library_version_id smuggled', ruleBody({ library_version_id: VERB }), undefined],
    ['block_kind smuggled', ruleBody({ block_kind: 'advice' }), undefined], ['is_active smuggled', ruleBody({ is_active: false }), undefined],
  ])('%s -> 400 common.validation_failed, nothing written', async (_n, body, path) => {
    loadLibrary(TB, VERB, reid(starterLibrary(), 9),{ version_no: 1 });
    const tbBlock = world.blocks.find((b) => b.tenant_id === TB && b.kind === 'deranged')!.id;
    const dead = uid(0xf003); world.blocks.push({ ...world.blocks.find((b) => b.id === BLOCK.high)!, id: dead, block_key: 'dead.block', is_active: false });
    const b = { ...(body as any) }; if (b.block_id === '__TB_BLOCK__') b.block_id = tbBlock; if (b.block_id === '__DEAD_BLOCK__') b.block_id = dead;
    const before = writes();
    const e = await fails(create(b).run());
    expect(codeOf(e)).toBe('common.validation_failed');
    if (path) expect(pointerOf(e)).toContain(path);
    expect(writes()).toBe(before);
    expect(world.rules.filter((r) => r.library_version_id === D)).toHaveLength(4);
  });
});

describe('C14-T11 #11 replaceSmartRule / #12 deleteSmartRule', () => {
  const RULE = sid(11);   // deranged any/high borderline 900 -> block 1
  const put = (body: unknown, h: object = ifMatch(1), id = RULE) => call('replaceSmartRule', 'lab_manager', request({ params: vp({ rule_id: id }), headers: h, body }));
  it('#11 200: replaced, rule version + 1, parent + 1, same validity rules (AC-05.1/05.4 apply on PUT too)', async () => {
    const r = await put(ruleBody({ priority: 10, trigger_kind: 'any', analyte_id: undefined, min_severity: 'critical' })).run();
    expect(r.status).toBe(200); expect(responseProblems('replaceSmartRule', r)).toEqual([]);
    expect(r.body).toMatchObject({ id: RULE, priority: 10, min_severity: 'critical', version: 2 });
    expect(parent().version).toBe(2);
    expect(codeOf(await fails(put(followBody({ interval_days: undefined }), ifMatch(2)).run()))).toBe('common.validation_failed');
    expect(codeOf(await fails(put(ruleBody({ block_id: BLOCK.advice }), ifMatch(2)).run()))).toBe('common.validation_failed');
  });
  it('#11 deactivated rule -> 404', async () => {
    world.rules.find((r) => r.id === RULE)!.is_active = false;
    expect(codeOf(await fails(put(ruleBody()).run()))).toBe('common.not_found');
  });
  it('#12 204: deactivated (row kept, is_active=false), gone from #9, parent + 1; never a delete', async () => {
    const r = await call('deleteSmartRule', 'lab_manager', request({ params: vp({ rule_id: RULE }), headers: ifMatch(1) })).run();
    expect(r.status).toBe(204); expect(responseProblems('deleteSmartRule', r)).toEqual([]);
    expect(world.rules.find((x) => x.id === RULE)).toMatchObject({ is_active: false, version: 2 });
    expect(parent().version).toBe(2);
    expect((await call('listSmartRules', 'lab_manager', request({ params: vp() })).run()).body.data.map((x: any) => x.id)).not.toContain(RULE);
    expect(world.writes.every((w) => !/delete|remove/i.test(w))).toBe(true);
  });
});

// ================================================================= analyte mappings (#13-#15)
describe('C14-T11 #13-#15 analyte -> organ group mappings (AC-04.1-04.3, AC-03.7)', () => {
  const putMap = (analyte: string, body: unknown, h: object = {}, persona: 'lab_manager' | 'pathologist' = 'lab_manager', tenant: 'A' | 'B' = 'A', ver = D) =>
    call('putSmartAnalyteGroup', persona, request({ params: { library_version_id: ver, analyte_id: analyte }, headers: h, body }), tenant);
  const active = (analyte: string) => world.mappings.filter((m) => m.library_version_id === D && m.analyte_id === analyte && m.is_active);
  it('#13 lists ACTIVE mappings (AnalyteGroup shape, no id/tenant), valid against the contract', async () => {
    world.mappings.push({ ...world.mappings[0], id: uid(0xf004), analyte_id: ANALYTE.a2, is_active: false });
    const r = await call('listSmartAnalyteGroups', 'lab_manager', request({ params: vp() })).run();
    expect(r.status).toBe(200); expect(responseProblems('listSmartAnalyteGroups', r)).toEqual([]);
    expect(r.body.data).toEqual([expect.objectContaining({ analyte_id: ANALYTE.a1, group_code: 'liver', include_in_score: true, trend_enabled: false, version: 1 })]);
    expect(r.body.data[0]).not.toHaveProperty('id');
  });
  it('AC-04.1: PUT a new analyte -> 201 AnalyteGroup with defaults (include_in_score true, trend_enabled false); stored for tenant A; parent + 1', async () => {
    const r = await putMap(ANALYTE.a2, { group_code: 'kidney' }).run();
    expect(r.status).toBe(201); expect(responseProblems('putSmartAnalyteGroup', r)).toEqual([]);
    expect(r.body).toMatchObject({ analyte_id: ANALYTE.a2, group_code: 'kidney', include_in_score: true, trend_enabled: false, version: 1 });
    expect(active(ANALYTE.a2)[0]).toMatchObject({ tenant_id: TA, library_version_id: D, group_code: 'kidney' });
    expect(parent().version).toBe(2);
  });
  it('optional fields are stored: include_in_score false, trend_enabled true, borderline_fraction_bp, trend_stable_bp, sort_order', async () => {
    const r = await putMap(ANALYTE.a2, { group_code: 'glucose', include_in_score: false, trend_enabled: true, borderline_fraction_bp: 1500, trend_stable_bp: 300, sort_order: 7 }).run();
    expect(r.body).toMatchObject({ include_in_score: false, trend_enabled: true, borderline_fraction_bp: 1500, trend_stable_bp: 300, sort_order: 7 });
  });
  it('AC-04.3: re-mapping ALT liver -> kidney replaces the mapping (exactly one ACTIVE group per analyte); If-Match is required when the row exists', async () => {
    expect(codeOf(await fails(putMap(ANALYTE.a1, { group_code: 'kidney' }).run()))).toBe('common.precondition_required');
    expect(codeOf(await fails(putMap(ANALYTE.a1, { group_code: 'kidney' }, ifMatch(5)).run()))).toBe('common.version_conflict');
    const r = await putMap(ANALYTE.a1, { group_code: 'kidney' }, ifMatch(1)).run();
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ analyte_id: ANALYTE.a1, group_code: 'kidney' });
    expect(active(ANALYTE.a1)).toHaveLength(1); expect(active(ANALYTE.a1)[0]!.group_code).toBe('kidney');
  });
  it('AC-04.2: tenant A maps a tenant B analyte -> 404 common.not_found (FK + RLS), nothing stored; an unknown analyte too', async () => {
    for (const a of [ANALYTE.b1, uid(0xdead)]) {
      const e = await fails(putMap(a, { group_code: 'liver' }).run());
      expect(codeOf(e), a).toBe('common.not_found');
      expect(world.mappings.some((m) => m.analyte_id === a)).toBe(false);
    }
  });
  it('tenant B can map its own analyte in its own draft, not tenant A\'s', async () => {
    loadLibrary(TB, VERB, reid(starterLibrary(), 9),{ version_no: 1 });
    expect((await putMap(ANALYTE.b1, { group_code: 'liver' }, {}, 'pathologist', 'B', VERB).run()).status).toBe(201);
    expect(codeOf(await fails(putMap(ANALYTE.a1, { group_code: 'liver' }, {}, 'pathologist', 'B', VERB).run()))).toBe('common.not_found');
  });
  it.each([
    ['group_code missing', {}], ['group_code not a code', { group_code: 'Liver!' }], ['borderline_fraction_bp 2501', { group_code: 'liver', borderline_fraction_bp: 2501 }],
    ['trend_stable_bp 5001', { group_code: 'liver', trend_stable_bp: 5001 }], ['sort_order 10000', { group_code: 'liver', sort_order: 10000 }],
    ['include_in_score not boolean', { group_code: 'liver', include_in_score: 'yes' }], ['analyte_id in the body', { group_code: 'liver', analyte_id: ANALYTE.a2 }],
    ['tenant_id smuggled', { group_code: 'liver', tenant_id: TB }], ['is_active smuggled', { group_code: 'liver', is_active: false }],
  ])('invalid body (%s) -> 400 common.validation_failed, nothing written', async (_n, body) => {
    expect(codeOf(await fails(putMap(ANALYTE.a2, body).run()))).toBe('common.validation_failed');
    expect(world.writes).toEqual([]);
  });
  it('AC-03.7 #15: DELETE deactivates the mapping (204, row kept, If-Match required); a new PUT for the same analyte inserts a NEW active row (201)', async () => {
    const del = (h: object) => call('deleteSmartAnalyteGroup', 'lab_manager', request({ params: vp({ analyte_id: ANALYTE.a1 }), headers: h }));
    expect(codeOf(await fails(del({}).run()))).toBe('common.precondition_required');
    const r = await del(ifMatch(1)).run();
    expect(r.status).toBe(204); expect(responseProblems('deleteSmartAnalyteGroup', r)).toEqual([]);
    expect(world.mappings.find((m) => m.id === MAP_ID)).toMatchObject({ is_active: false });
    expect((await call('listSmartAnalyteGroups', 'lab_manager', request({ params: vp() })).run()).body.data).toEqual([]);
    expect(codeOf(await fails(del(ifMatch(2)).run()))).toBe('common.not_found');                         // nothing active to remove
    const again = await putMap(ANALYTE.a1, { group_code: 'liver' }).run();
    expect(again.status).toBe(201);
    expect(world.mappings.filter((m) => m.analyte_id === ANALYTE.a1)).toHaveLength(2);
    expect(active(ANALYTE.a1)).toHaveLength(1);
  });
});

// ================================================================= group settings (#16-#17)
describe('C14-T11 #16 listSmartGroupSettings / #17 putSmartGroupSetting', () => {
  const put = (code: string, body: unknown, h: object = ifMatch(1)) => call('putSmartGroupSetting', 'lab_manager', request({ params: vp({ group_code: code }), headers: h, body }));
  const gs = { display_en: 'Liver panel', score_weight: 2, sort_order: 5, is_shown: false };
  it('#16 lists one ACTIVE setting per organ group in sort order; GroupSetting shape (no id)', async () => {
    const r = await call('listSmartGroupSettings', 'lab_manager', request({ params: vp() })).run();
    expect(r.status).toBe(200); expect(responseProblems('listSmartGroupSettings', r)).toEqual([]);
    expect(r.body.data.map((g: any) => g.group_code)).toEqual(ORGAN_GROUPS.map(([c]) => c));
    expect(r.body.data[0]).toMatchObject({ group_code: 'blood_counts', display_en: 'Blood counts', score_weight: 1, is_shown: true, version: 1 });
    expect(r.body.data[0]).not.toHaveProperty('id');
  });
  it('#17 200: updated, version + 1, parent + 1; display_ne optional', async () => {
    const r = await put('liver', { ...gs, display_ne: 'कलेजो' }).run();
    expect(r.status).toBe(200); expect(responseProblems('putSmartGroupSetting', r)).toEqual([]);
    expect(r.body).toMatchObject({ group_code: 'liver', display_en: 'Liver panel', display_ne: 'कलेजो', score_weight: 2, sort_order: 5, is_shown: false, version: 2 });
    expect(parent().version).toBe(2);
  });
  it.each([
    ['display_en empty', { ...gs, display_en: '' }], ['display_en 61 chars', { ...gs, display_en: 'x'.repeat(61) }], ['display_ne 61 chars', { ...gs, display_ne: 'x'.repeat(61) }],
    ['score_weight 11', { ...gs, score_weight: 11 }], ['score_weight -1', { ...gs, score_weight: -1 }], ['sort_order 10000', { ...gs, sort_order: 10000 }],
    ['is_shown missing', { display_en: 'x', score_weight: 1, sort_order: 1 }], ['group_code in body', { ...gs, group_code: 'kidney' }], ['tenant_id smuggled', { ...gs, tenant_id: TB }],
  ])('invalid body (%s) -> 400, nothing written', async (_n, body) => {
    expect(codeOf(await fails(put('liver', body).run()))).toBe('common.validation_failed');
    expect(world.writes).toEqual([]);
  });
  it('If-Match: missing 428, stale 409', async () => {
    expect(codeOf(await fails(put('liver', gs, {}).run()))).toBe('common.precondition_required');
    expect(codeOf(await fails(put('liver', gs, ifMatch(3)).run()))).toBe('common.version_conflict');
  });
});

describe('C14-T11 request bodies of the contract examples are accepted by the openapi request schemas (sanity of the fixtures above)', () => {
  it.each([['createSmartTemplateBlock', blockBody()], ['createSmartRule', ruleBody()], ['createSmartRule', followBody()], ['putSmartAnalyteGroup', { group_code: 'liver' }],
    ['putSmartGroupSetting', { display_en: 'x', score_weight: 1, sort_order: 1, is_shown: true }]] as const)('%s', (op, body) => {
    expect(requestProblems(op, JSON.parse(JSON.stringify(body)))).toEqual([]);
  });
});
