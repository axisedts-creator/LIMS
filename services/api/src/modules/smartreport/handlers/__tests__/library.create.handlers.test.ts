// C14 T11 — #1 listSmartLibraryVersions, #2 createSmartLibraryVersion, #3 getSmartLibraryVersion, #4 updateSmartLibraryVersion
// (06-PLAN T11; 02-TRD §5 + §5.1; 03-APP-FLOW §1.1 L1/L2, §2.1). ACs: AC-02.1, AC-02.2, AC-02.3 (AC-02.4 = core Idempotency pipeline, not testable at handler level), AC-03.6 (#4 outside draft).
// Security (07-SECURITY): REQ-SEC-022..024 tenant isolation, AB-1, P-17 display names, mass assignment. Seams: ../../__tests__/t11.helpers.ts header.
// Fails now: handlers 1-4 are T01 stubs (common.internal / 501); seed/starter-library.v1.json and library.state.ts do not exist.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../repository/library.repo.js', async () => (await import('../../__tests__/t11.fakes.js')).libraryRepoFake);
vi.mock('../../repository/blocks.repo.js', async () => (await import('../../__tests__/t11.fakes.js')).blocksRepoFake);
vi.mock('../../repository/rules.repo.js', async () => (await import('../../__tests__/t11.fakes.js')).rulesRepoFake);
vi.mock('../../repository/mappings.repo.js', async () => (await import('../../__tests__/t11.fakes.js')).mappingsRepoFake);
vi.mock('../../repository/groups.repo.js', async () => (await import('../../__tests__/t11.fakes.js')).groupsRepoFake);
vi.mock('../../repository/reviews.repo.js', async () => (await import('../../__tests__/t11.fakes.js')).reviewsRepoFake);
vi.mock('../../repository/codedSets.repo.js', async () => (await import('../../__tests__/t11.fakes.js')).codedSetsRepoFake);
vi.mock('../../repository/denyTerms.repo.js', async () => (await import('../../__tests__/t11.fakes.js')).denyTermsRepoFake);

import { actorIdFor } from '../../../../../../../packages/fakes/src/base';
import { starterLibrary, type LibInput } from '../../__tests__/t10.fixtures.js';
import { ANALYTE, MID, ORGAN_GROUPS, PARAMS, T0, TA, TB, VER, VERB, call, callsOf, codeOf, fails, ifMatch, loadLibrary, nameOf, reid, request, responseProblems, seed, uid, world, writesOf } from '../../__tests__/t11.helpers.js';

const CREATE = 'createSmartLibraryVersion', LIST = 'listSmartLibraryVersions', GET = 'getSmartLibraryVersion', PATCH = 'updateSmartLibraryVersion';
const MANAGE = 'smartreport.template.manage';
const withMapping = (): LibInput => ({ ...starterLibrary(), mappings: [{ id: '01900000-7100-7000-8000-000000000900', analyteId: ANALYTE.a1, groupCode: 'liver' }] });
const rowsOf = (versionId: string) => ({
  blocks: world.blocks.filter((b) => b.library_version_id === versionId), rules: world.rules.filter((r) => r.library_version_id === versionId),
  mappings: world.mappings.filter((m) => m.library_version_id === versionId), groups: world.groupSettings.filter((g) => g.library_version_id === versionId),
});
const nonAuthCalls = () => world.calls.filter((c) => c.fn !== 'assertRole');
beforeEach(() => { seed(); vi.clearAllMocks(); });

describe('C14-T11 #2 createSmartLibraryVersion — source starter (AC-02.1)', () => {
  it('no version exists: pathologist gets 201 version 1 draft with the starter blocks, rules and one group setting per ACTIVE organ group; no mappings, no follow-ups', async () => {
    const c = call(CREATE, 'pathologist', request({ body: { source: 'starter', change_summary: 'First library' } }));
    const r = await c.run();
    expect(r.status).toBe(201);
    expect(responseProblems(CREATE, r)).toEqual([]);
    expect(r.body).toMatchObject({ version_no: 1, status: 'draft', language: 'en', formula_version: 'hs-1', change_summary: 'First library', version: 1,
      counts: { blocks: 6, rules: 4, analyte_groups: 0, groups_shown: ORGAN_GROUPS.length } });
    expect(r.body).not.toHaveProperty('source_version_id');
    expect(r.body.params).toMatchObject({ score_enabled: true });
    expect(c.asserted.map((a) => a.permission)).toEqual([MANAGE]);
    expect(c.asserted[0]).not.toHaveProperty('centreId');

    const rows = rowsOf(r.body.id);
    const want = new Map(starterLibrary().blocks.map((b) => [b.blockKey, b]));
    expect(rows.blocks.map((b) => b.block_key).sort()).toEqual([...want.keys()].sort());
    for (const b of rows.blocks) { expect(b.text_en).toBe(want.get(b.block_key)!.textEn); expect(b.kind).toBe(want.get(b.block_key)!.kind); expect(b.tenant_id).toBe(TA); }
    expect(rows.rules).toHaveLength(4);
    for (const rule of rows.rules) { const blk = rows.blocks.find((b) => b.id === rule.block_id)!; expect(blk.kind).toBe(rule.rule_kind); expect(rule.block_kind).toBe(rule.rule_kind); }
    expect(rows.rules.filter((x) => x.rule_kind === 'deranged').map((x) => [x.trigger_kind, x.direction, x.min_severity, x.priority]).sort())
      .toEqual([['any', 'abnormal', 'borderline', 900], ['any', 'high', 'borderline', 900], ['any', 'low', 'borderline', 900]]);
    expect(rows.rules.filter((x) => x.rule_kind === 'followup')).toHaveLength(0);
    expect(rows.mappings).toHaveLength(0);
    expect(rows.groups.map((g) => g.group_code).sort()).toEqual(ORGAN_GROUPS.map(([code]) => code).sort());       // 'retired_group' (inactive) is not copied
    for (const g of rows.groups) { expect(g.display_en).toBe(ORGAN_GROUPS.find(([code]) => code === g.group_code)![1]); expect(g.score_weight).toBe(1); expect(g.is_shown).toBe(true); }
    expect(world.reviews).toHaveLength(0);
  });
  it('the new row is stamped with the authenticated tenant and actor only', async () => {
    const r = await call(CREATE, 'pathologist', request({ body: { source: 'starter' } })).run();
    const v = world.versions.find((x) => x.id === r.body.id)!;
    expect(v.tenant_id).toBe(TA);
    expect(v.created_by).toBe(actorIdFor('A', 'user', 'pathologist'));
    expect(v.status).toBe('draft');
  });
  it('lab_manager (template.manage) may create too', async () => {
    expect((await call(CREATE, 'lab_manager', request({ body: { source: 'starter' } })).run()).status).toBe(201);
  });
  it('takes the advisory lock smartreport:library:<tenant> BEFORE reading open versions / max version_no / inserting (L1)', async () => {
    await call(CREATE, 'pathologist', request({ body: { source: 'starter' } })).run();
    const lock = callsOf('lock');
    expect(lock).toHaveLength(1);
    expect(JSON.stringify(lock[0]!.args)).toContain(`smartreport:library:${TA}`);
    expect(lock[0]!.tenantId).toBe(TA);
    const first = world.calls.findIndex((c) => ['getOpenLibraryVersion', 'listLibraryVersions', 'insertLibraryVersion'].includes(c.fn));
    expect(first).toBeGreaterThan(world.calls.findIndex((c) => c.fn === 'lock'));
  });
});

describe('C14-T11 #2 createSmartLibraryVersion — clone (AC-02.2)', () => {
  function seedV3Approved(): void {
    loadLibrary(TA, VER(1), reid(starterLibrary(), 1), { version_no: 1, status: 'retired', content_sha256: 'b'.repeat(64), approved_at: T0, approved_by_membership_id: MID.A.pathologist, retired_at: T0 });
    loadLibrary(TA, VER(3), reid(withMapping(), 3), { version_no: 3, status: 'approved', content_sha256: 'a'.repeat(64), approved_at: T0, approved_by_membership_id: MID.A.pathologist, groups: true, change_summary: 'v3' });
    // removed children of v3 (is_active = false): must NOT be cloned
    world.blocks.push({ ...world.blocks.find((b) => b.library_version_id === VER(3))!, id: uid(0xf001), block_key: 'removed.block', is_active: false });
    world.mappings.push({ ...world.mappings.find((m) => m.library_version_id === VER(3))!, id: uid(0xf002), analyte_id: ANALYTE.a2, is_active: false });
  }
  it('clone_active: version 4 draft copies every ACTIVE block, rule, mapping and group setting of v3 with NEW ids; source_version_id = v3', async () => {
    seedV3Approved();
    const before = rowsOf(VER(3));
    const r = await call(CREATE, 'pathologist', request({ body: { source: 'clone_active' } })).run();
    expect(r.status).toBe(201);
    expect(responseProblems(CREATE, r)).toEqual([]);
    expect(r.body).toMatchObject({ version_no: 4, status: 'draft', source_version_id: VER(3), counts: { blocks: 6, rules: 4, analyte_groups: 1, groups_shown: ORGAN_GROUPS.length } });
    expect(r.body).not.toHaveProperty('content_sha256');
    expect(r.body).not.toHaveProperty('approved_at');
    const after = rowsOf(r.body.id);
    const activeBefore = { blocks: before.blocks.filter((b) => b.is_active), rules: before.rules.filter((x) => x.is_active), mappings: before.mappings.filter((x) => x.is_active), groups: before.groups };
    expect(after.blocks.map((b) => b.block_key).sort()).toEqual(activeBefore.blocks.map((b) => b.block_key).sort());
    expect(after.blocks.some((b) => b.block_key === 'removed.block')).toBe(false);
    for (const b of after.blocks) { const o = activeBefore.blocks.find((x) => x.block_key === b.block_key)!; expect(b.id).not.toBe(o.id); expect(b.text_en).toBe(o.text_en); expect(b.kind).toBe(o.kind); expect(b.is_active).toBe(true); }
    expect(after.rules).toHaveLength(4);
    for (const rule of after.rules) { expect(activeBefore.rules.some((x) => x.id === rule.id)).toBe(false); const blk = after.blocks.find((b) => b.id === rule.block_id); expect(blk, 'rule.block_id must point at a block of the NEW version').toBeDefined(); expect(blk!.kind).toBe(rule.rule_kind); }
    expect(after.mappings.map((m) => [m.analyte_id, m.group_code])).toEqual([[ANALYTE.a1, 'liver']]);
    expect(after.mappings[0]!.id).not.toBe(activeBefore.mappings[0]!.id);
    expect(after.groups).toHaveLength(ORGAN_GROUPS.length);
    expect(after.groups.every((g) => !activeBefore.groups.some((o) => o.id === g.id))).toBe(true);
    // the source is untouched
    expect(rowsOf(VER(3)).blocks).toHaveLength(before.blocks.length);
    expect(world.versions.find((v) => v.id === VER(3))!.status).toBe('approved');
  });
  it('clone_version: clones the chosen (retired) version; source_version_id required (and only then)', async () => {
    seedV3Approved();
    const r = await call(CREATE, 'pathologist', request({ body: { source: 'clone_version', source_version_id: VER(1), change_summary: 'from v1' } })).run();
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ version_no: 4, status: 'draft', source_version_id: VER(1), change_summary: 'from v1', counts: { blocks: 6, rules: 4, analyte_groups: 0 } });
  });
  it('clone_version of another tenant\'s version -> 404 common.not_found, nothing written', async () => {
    seedV3Approved();
    loadLibrary(TB, VERB, starterLibrary(), { version_no: 1, status: 'retired', content_sha256: 'c'.repeat(64) });
    const e = await fails(call(CREATE, 'pathologist', request({ body: { source: 'clone_version', source_version_id: VERB } })).run());
    expect(codeOf(e)).toBe('common.not_found');
    expect(world.versions.filter((v) => v.tenant_id === TA)).toHaveLength(2);
    expect(writesOf(/insert/i)).toEqual([]);
  });
  it('clone_version of an unknown id -> 404', async () => {
    expect(codeOf(await fails(call(CREATE, 'pathologist', request({ body: { source: 'clone_version', source_version_id: VER(9) } })).run()))).toBe('common.not_found');
  });
});

describe('C14-T11 #2 createSmartLibraryVersion — refusals (AC-02.3, L1 guards)', () => {
  it.each(['draft', 'in_review'])('a %s version already exists -> 409 smartreport.library_invalid_transition and nothing is written', async (status) => {
    loadLibrary(TA, VER(1), starterLibrary(), { version_no: 1, status, content_sha256: status === 'draft' ? null : 'a'.repeat(64) });
    const e = await fails(call(CREATE, 'pathologist', request({ body: { source: 'starter' } })).run());
    expect(codeOf(e)).toBe('smartreport.library_invalid_transition');
    expect(e.statusCode).toBe(409);
    expect(world.writes).toEqual([]);
    expect(world.versions).toHaveLength(1);
  });
  it('an approved version alone does not block a new draft', async () => {
    loadLibrary(TA, VER(2), withMapping(), { version_no: 2, status: 'approved', content_sha256: 'a'.repeat(64), approved_at: T0, approved_by_membership_id: MID.A.pathologist });
    const r = await call(CREATE, 'pathologist', request({ body: { source: 'clone_active' } })).run();
    expect(r.status).toBe(201); expect(r.body.version_no).toBe(3);
  });
  it('another tenant\'s open draft does not block tenant A (the guard is per tenant)', async () => {
    loadLibrary(TB, VERB, starterLibrary(), { version_no: 1 });
    expect((await call(CREATE, 'pathologist', request({ body: { source: 'starter' } })).run()).status).toBe(201);
  });
  it('lost race: the open-draft unique index fires after the pre-check -> 409 smartreport.library_invalid_transition (not a 500), no partial rows', async () => {
    world.opts.raceOpenInsert = true;
    const e = await fails(call(CREATE, 'pathologist', request({ body: { source: 'starter' } })).run());
    expect(codeOf(e)).toBe('smartreport.library_invalid_transition');
    expect(world.versions).toHaveLength(0); expect(world.blocks).toHaveLength(0);
  });
  it.each([
    ['empty body', {}], ['unknown source', { source: 'import' }], ['status smuggled', { source: 'starter', status: 'approved' }], ['tenant_id smuggled', { source: 'starter', tenant_id: TB }],
    ['version_no smuggled', { source: 'starter', version_no: 99 }], ['clone_version without id', { source: 'clone_version' }], ['id with a non-clone source', { source: 'starter', source_version_id: VER(1) }],
    ['id not a uuid', { source: 'clone_version', source_version_id: 'nope' }], ['change_summary 501 chars', { source: 'starter', change_summary: 'x'.repeat(501) }],
    ['change_summary not a string', { source: 'starter', change_summary: 7 }],
  ])('invalid body (%s) -> 400 common.validation_failed and nothing is written', async (_n, body) => {
    const e = await fails(call(CREATE, 'pathologist', request({ body })).run());
    expect(codeOf(e)).toBe('common.validation_failed');
    expect(world.writes).toEqual([]);
  });
  it.each(['front_desk', 'lab_technologist', 'revoked_pathologist'] as const)('%s -> 403 auth.forbidden before any repository access or lock', async (p) => {
    const e = await fails(call(CREATE, p, request({ body: { source: 'starter' } })).run());
    expect(codeOf(e)).toBe('auth.forbidden');
    expect(nonAuthCalls()).toEqual([]);
  });
  it('unknown actor -> auth.unauthenticated', async () => {
    expect(codeOf(await fails(call(CREATE, 'ghost', request({ body: { source: 'starter' } })).run()))).toBe('auth.unauthenticated');
  });
});

describe('C14-T11 #1 listSmartLibraryVersions', () => {
  beforeEach(() => {
    loadLibrary(TA, VER(1), starterLibrary(), { version_no: 1, status: 'retired', content_sha256: 'a'.repeat(64), approved_at: T0, approved_by_membership_id: MID.A.pathologist, retired_at: T0 });
    loadLibrary(TA, VER(2), starterLibrary(), { version_no: 2, status: 'retired', content_sha256: 'b'.repeat(64), approved_at: T0, approved_by_membership_id: MID.A.pathologist, retired_at: T0 });
    loadLibrary(TA, VER(3), starterLibrary(), { version_no: 3, status: 'approved', content_sha256: 'c'.repeat(64), approved_at: T0, approved_by_membership_id: MID.A.lab_manager });
    loadLibrary(TA, VER(4), starterLibrary(), { version_no: 4, status: 'draft' });
    loadLibrary(TB, VERB, starterLibrary(), { version_no: 1, status: 'draft' });
  });
  it('200 newest first, valid LibraryVersionSummary shapes, tenant A rows only, no hidden columns', async () => {
    const c = call(LIST, 'lab_manager', request());
    const r = await c.run();
    expect(r.status).toBe(200);
    expect(responseProblems(LIST, r)).toEqual([]);
    expect(r.body.data.map((v: any) => v.version_no)).toEqual([4, 3, 2, 1]);
    expect(r.body.data.map((v: any) => v.id)).not.toContain(VERB);
    expect(c.asserted.map((a) => a.permission)).toEqual([MANAGE]);
    expect(r.body.data[0]).not.toHaveProperty('approved_by_membership_id');                      // draft: null columns omitted
  });
  it('approved_by_display_name comes from ONE batched ctx.core.memberships.list call (P-17), ids de-duplicated, activeOnly=false', async () => {
    const c = call(LIST, 'lab_manager', request());
    const r = await c.run();
    const byNo = Object.fromEntries(r.body.data.map((v: any) => [v.version_no, v]));
    expect(byNo[3]).toMatchObject({ approved_by_membership_id: MID.A.lab_manager, approved_by_display_name: nameOf('A', 'lab_manager') });
    expect(byNo[1].approved_by_display_name).toBe(nameOf('A', 'pathologist'));
    expect(world.coreCalls).toHaveLength(1);
    expect([...world.coreCalls[0]!.input.membershipIds].sort()).toEqual([MID.A.lab_manager, MID.A.pathologist].sort());
    expect(world.coreCalls[0]!.input.activeOnly).toBe(false);
  });
  it('an unknown membership name is omitted, never invented', async () => {
    const r = await call(LIST, 'lab_manager', request(), 'A', { names: false }).run();
    expect(r.body.data.every((v: any) => !('approved_by_display_name' in v))).toBe(true);
  });
  it('status filter (comma list): approved,retired -> versions 3,2,1', async () => {
    const r = await call(LIST, 'lab_manager', request({ query: { status: 'approved,retired' } })).run();
    expect(r.body.data.map((v: any) => v.version_no)).toEqual([3, 2, 1]);
    expect((await call(LIST, 'lab_manager', request({ query: { status: 'draft' } })).run()).body.data.map((v: any) => v.version_no)).toEqual([4]);
  });
  it('limit + cursor: limit=1 pages newest to oldest; the last page has no next_cursor; a garbage cursor -> common.invalid_cursor', async () => {
    const p1 = await call(LIST, 'lab_manager', request({ query: { limit: 1 } })).run();
    expect(p1.body.data.map((v: any) => v.version_no)).toEqual([4]);
    expect(typeof p1.body.page.next_cursor).toBe('string');
    const p2 = await call(LIST, 'lab_manager', request({ query: { limit: 1, cursor: p1.body.page.next_cursor } })).run();
    expect(p2.body.data.map((v: any) => v.version_no)).toEqual([3]);
    const all = await call(LIST, 'lab_manager', request({ query: { limit: 200 } })).run();
    expect(all.body.page).not.toHaveProperty('next_cursor');
    expect(codeOf(await fails(call(LIST, 'lab_manager', request({ query: { cursor: '%%%not-a-cursor' } })).run()))).toBe('common.invalid_cursor');
  });
  it('tenant isolation: tenant B sees only its own version and its own names', async () => {
    const r = await call(LIST, 'pathologist', request(), 'B').run();
    expect(r.body.data.map((v: any) => v.id)).toEqual([VERB]);
    expect(callsOf('listLibraryVersions').every((c) => c.tenantId === TB)).toBe(true);
  });
  it.each(['front_desk', 'lab_technologist'] as const)('%s -> 403 before any read', async (p) => {
    expect(codeOf(await fails(call(LIST, p, request()).run()))).toBe('auth.forbidden');
    expect(nonAuthCalls()).toEqual([]);
  });
});

describe('C14-T11 #3 getSmartLibraryVersion', () => {
  beforeEach(() => {
    loadLibrary(TA, VER(2), withMapping(), { version_no: 2, status: 'approved', content_sha256: 'a'.repeat(64), approved_at: T0, approved_by_membership_id: MID.A.pathologist, approval_note: 'Reviewed', groups: true, submitted_at: T0, submitted_by_membership_id: MID.A.lab_manager });
    world.blocks.push({ ...world.blocks[0], id: '01900000-7200-7000-8000-00000000f001', block_key: 'removed.one', is_active: false });
    world.groupSettings[0]!.is_shown = false;
    loadLibrary(TB, VERB, starterLibrary(), { version_no: 1 });
  });
  it('200 full LibraryVersion: params, ACTIVE counts, display name via memberships.list, no internal columns', async () => {
    const r = await call(GET, 'lab_manager', request({ params: { library_version_id: VER(2) } })).run();
    expect(r.status).toBe(200);
    expect(responseProblems(GET, r)).toEqual([]);
    expect(r.body).toMatchObject({ id: VER(2), version_no: 2, status: 'approved', language: 'en', formula_version: 'hs-1', content_sha256: 'a'.repeat(64), approval_note: 'Reviewed',
      approved_by_membership_id: MID.A.pathologist, approved_by_display_name: nameOf('A', 'pathologist'), submitted_by_membership_id: MID.A.lab_manager,
      counts: { blocks: 6, rules: 4, analyte_groups: 1, groups_shown: ORGAN_GROUPS.length - 1 }, version: 1 });
    expect(r.body.params).toEqual(PARAMS);
    for (const k of ['tenant_id', 'created_by', 'updated_by', 'is_active']) expect(r.body).not.toHaveProperty(k);
    expect(world.coreCalls).toHaveLength(1);
  });
  it('unknown id, malformed id and another tenant\'s id all -> 404 common.not_found', async () => {
    for (const id of [VER(9), 'not-a-uuid', VERB]) expect(codeOf(await fails(call(GET, 'pathologist', request({ params: { library_version_id: id } })).run())), id).toBe('common.not_found');
  });
  it('tenant B cannot read tenant A\'s version (404) and reads its own', async () => {
    expect(codeOf(await fails(call(GET, 'pathologist', request({ params: { library_version_id: VER(2) } }), 'B').run()))).toBe('common.not_found');
    expect((await call(GET, 'pathologist', request({ params: { library_version_id: VERB } }), 'B').run()).status).toBe(200);
  });
  it('front_desk -> 403', async () => {
    expect(codeOf(await fails(call(GET, 'front_desk', request({ params: { library_version_id: VER(2) } })).run()))).toBe('auth.forbidden');
  });
});

describe('C14-T11 #4 updateSmartLibraryVersion (L2)', () => {
  beforeEach(() => { loadLibrary(TA, VER(1), withMapping(), { version_no: 1, status: 'draft', version: 3 }); });
  const patch = (body: unknown, h: object = ifMatch(3), id = VER(1)) => request({ params: { library_version_id: id }, headers: h, body });
  it('draft: params/language/change_summary are updated, version + 1, response validates', async () => {
    const r = await call(PATCH, 'lab_manager', patch({ change_summary: 'Tuned', language: 'ne', params: { min_mapped_results: 5, score_enabled: false } })).run();
    expect(r.status).toBe(200);
    expect(responseProblems(PATCH, r)).toEqual([]);
    expect(r.body).toMatchObject({ change_summary: 'Tuned', language: 'ne', version: 4 });
    expect(r.body.params).toMatchObject({ min_mapped_results: 5, score_enabled: false, band_good_min: PARAMS.band_good_min });
    const row = world.versions.find((v) => v.id === VER(1))!;
    expect(row).toMatchObject({ language: 'ne', min_mapped_results: 5, score_enabled: false, change_summary: 'Tuned', version: 4 });
  });
  it('If-Match: missing -> 428 common.precondition_required; stale -> 409 common.version_conflict; malformed -> 400', async () => {
    expect(codeOf(await fails(call(PATCH, 'lab_manager', patch({ change_summary: 'x' }, {})).run()))).toBe('common.precondition_required');
    expect(codeOf(await fails(call(PATCH, 'lab_manager', patch({ change_summary: 'x' }, ifMatch(2))).run()))).toBe('common.version_conflict');
    expect(codeOf(await fails(call(PATCH, 'lab_manager', patch({ change_summary: 'x' }, ifMatch('abc'))).run()))).toBe('common.validation_failed');
    expect(world.versions[0]!.version).toBe(3);
  });
  it.each(['in_review', 'approved', 'retired'])('library in %s -> 409 smartreport.library_invalid_transition, row unchanged (AB-1, AC-03.6)', async (status) => {
    world.versions[0]!.status = status; world.versions[0]!.content_sha256 = 'a'.repeat(64);
    const e = await fails(call(PATCH, 'lab_manager', patch({ change_summary: 'sneaky' })).run());
    expect(codeOf(e)).toBe('smartreport.library_invalid_transition');
    expect(world.versions[0]!.change_summary).toBeNull(); expect(world.versions[0]!.version).toBe(3);
  });
  it('the draft-only DB trigger is the backstop: a trigger rejection (immutable_row) after the service check is mapped to 409 common.immutable_record', async () => {
    // status flips between the handler's read and write (concurrent submit): the read says draft, the UPDATE sees in_review
    const { libraryRepoFake } = await import('../../__tests__/t11.fakes.js');
    libraryRepoFake.getLibraryVersion.mockImplementationOnce(async (_rc: any, id: string) => ({ ...world.versions.find((v) => v.id === id)!, status: 'draft' }));
    world.versions[0]!.status = 'in_review'; world.versions[0]!.content_sha256 = 'a'.repeat(64);
    const e = await fails(call(PATCH, 'lab_manager', patch({ change_summary: 'race' })).run());
    expect(['common.immutable_record', 'smartreport.library_invalid_transition']).toContain(codeOf(e));
    expect(world.versions[0]!.change_summary).toBeNull();
  });
  it.each([
    ['status', { status: 'approved' }], ['tenant_id', { tenant_id: TB }], ['version_no', { version_no: 9 }], ['content_sha256', { content_sha256: 'a'.repeat(64) }],
    ['source_version_id', { source_version_id: VER(1) }], ['approved_by_membership_id', { approved_by_membership_id: MID.A.pathologist }],
    ['unknown param', { params: { not_a_param: 1 } }], ['credit_in_range_bp out of range', { params: { credit_in_range_bp: 10001 } }], ['min_mapped_results 0', { params: { min_mapped_results: 0 } }],
    ['trend_max_points 7', { params: { trend_max_points: 7 } }], ['language xx', { language: 'xx' }], ['change_summary 501', { change_summary: 'x'.repeat(501) }],
  ])('invalid/mass-assignment body (%s) -> 400 common.validation_failed, nothing written', async (_n, body) => {
    const e = await fails(call(PATCH, 'lab_manager', patch(body)).run());
    expect(codeOf(e)).toBe('common.validation_failed');
    expect(world.writes).toEqual([]);
  });
  it('another tenant\'s version -> 404; front_desk -> 403 before any read', async () => {
    loadLibrary(TB, VERB, starterLibrary(), { version_no: 1, version: 3 });
    expect(codeOf(await fails(call(PATCH, 'pathologist', patch({ change_summary: 'x' }, ifMatch(3), VERB)).run()))).toBe('common.not_found');
    world.calls = [];
    expect(codeOf(await fails(call(PATCH, 'front_desk', patch({ change_summary: 'x' })).run()))).toBe('auth.forbidden');
    expect(nonAuthCalls()).toEqual([]);
  });
});

describe('C14-T11 starter seed file is the source of #2 starter', () => {
  it('seed/starter-library.v1.json exists next to the service (T11 files)', () => {
    expect(() => readFileSync(join(import.meta.dirname, '..', '..', 'seed', 'starter-library.v1.json'), 'utf8')).not.toThrow();
  });
});
