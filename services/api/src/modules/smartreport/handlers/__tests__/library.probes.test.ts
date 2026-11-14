// C14 T11 — probes across ALL library operations #1-#21 (06-PLAN T11 "probes"; 02-TRD §14 Probes; 07-SECURITY §5 P1 cross-tenant, AB-1, AB-6, 062/067 aal2, REQ-SEC-022..024).
// Matrices (generated from one case table so no operation is forgotten): handler is not a stub; permission asserted == x-permission of smartreport.yaml (tenant-wide, no centreId);
// authz before any repository access; cross-tenant -> 404 with zero writes and tenant A untouched; If-Match 428/409; non-draft -> 409 library_invalid_transition with zero writes.
// Seams: ../../__tests__/t11.helpers.ts header. Fails now: all 21 are T01 stubs (common.internal / 501).
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
import { ANALYTE, MID, T0, TA, TB, VER, VERB, call, codeOf, declaredOperationIds, fails, ifMatch, loadLibrary, permissionOf, request, seed, snapshot, uid, world, type Persona } from '../../__tests__/t11.helpers.js';

const D = VER(1);
const MANAGE = 'smartreport.template.manage', APPROVE = 'smartreport.template.approve';
const lib = (): LibInput => {
  const l: LibInput = { ...starterLibrary(), mappings: [{ id: sid(900), analyteId: ANALYTE.a1, groupCode: 'liver' }] };
  l.blocks.push({ id: sid(700), blockKey: 'followup.repeat', kind: 'followup', textEn: 'Repeat {test_name} after {interval_days} days.' });
  return l;
};
type H = Record<string, string>;
interface Case { op: string; perm: string; write: boolean; draftOnly: boolean; needsIfMatch: boolean; req: (h: H) => ReturnType<typeof request> }
const P = (extra: object = {}) => ({ library_version_id: D, ...extra });
const CASES: Case[] = [
  { op: 'listSmartLibraryVersions', perm: MANAGE, write: false, draftOnly: false, needsIfMatch: false, req: () => request() },
  { op: 'createSmartLibraryVersion', perm: MANAGE, write: true, draftOnly: false, needsIfMatch: false, req: () => request({ body: { source: 'clone_version', source_version_id: D } }) },
  { op: 'getSmartLibraryVersion', perm: MANAGE, write: false, draftOnly: false, needsIfMatch: false, req: () => request({ params: P() }) },
  { op: 'updateSmartLibraryVersion', perm: MANAGE, write: true, draftOnly: true, needsIfMatch: true, req: (h) => request({ params: P(), headers: h, body: { change_summary: 'x' } }) },
  { op: 'listSmartTemplateBlocks', perm: MANAGE, write: false, draftOnly: false, needsIfMatch: false, req: () => request({ params: P() }) },
  { op: 'createSmartTemplateBlock', perm: MANAGE, write: true, draftOnly: true, needsIfMatch: false, req: () => request({ params: P(), body: { block_key: 'advice.new', kind: 'advice', text_en: 'A note.' } }) },
  { op: 'replaceSmartTemplateBlock', perm: MANAGE, write: true, draftOnly: true, needsIfMatch: true,
    req: (h) => request({ params: P({ block_id: sid(4) }), headers: h, body: { block_key: 'advice.all_in_range', kind: 'advice', text_en: 'Changed note.' } }) },
  { op: 'deleteSmartTemplateBlock', perm: MANAGE, write: true, draftOnly: true, needsIfMatch: true, req: (h) => request({ params: P({ block_id: sid(700) }), headers: h }) },
  { op: 'listSmartRules', perm: MANAGE, write: false, draftOnly: false, needsIfMatch: false, req: () => request({ params: P() }) },
  { op: 'createSmartRule', perm: MANAGE, write: true, draftOnly: true, needsIfMatch: false,
    req: () => request({ params: P(), body: { rule_kind: 'deranged', trigger_kind: 'analyte', analyte_id: ANALYTE.a1, direction: 'high', min_severity: 'out_of_range', block_id: sid(1) } }) },
  { op: 'replaceSmartRule', perm: MANAGE, write: true, draftOnly: true, needsIfMatch: true,
    req: (h) => request({ params: P({ rule_id: sid(11) }), headers: h, body: { rule_kind: 'deranged', trigger_kind: 'any', direction: 'high', min_severity: 'borderline', priority: 900, block_id: sid(1) } }) },
  { op: 'deleteSmartRule', perm: MANAGE, write: true, draftOnly: true, needsIfMatch: true, req: (h) => request({ params: P({ rule_id: sid(11) }), headers: h }) },
  { op: 'listSmartAnalyteGroups', perm: MANAGE, write: false, draftOnly: false, needsIfMatch: false, req: () => request({ params: P() }) },
  { op: 'putSmartAnalyteGroup', perm: MANAGE, write: true, draftOnly: true, needsIfMatch: true, req: (h) => request({ params: P({ analyte_id: ANALYTE.a1 }), headers: h, body: { group_code: 'kidney' } }) },
  { op: 'deleteSmartAnalyteGroup', perm: MANAGE, write: true, draftOnly: true, needsIfMatch: true, req: (h) => request({ params: P({ analyte_id: ANALYTE.a1 }), headers: h }) },
  { op: 'listSmartGroupSettings', perm: MANAGE, write: false, draftOnly: false, needsIfMatch: false, req: () => request({ params: P() }) },
  { op: 'putSmartGroupSetting', perm: MANAGE, write: true, draftOnly: true, needsIfMatch: true,
    req: (h) => request({ params: P({ group_code: 'liver' }), headers: h, body: { display_en: 'Liver', score_weight: 1, sort_order: 40, is_shown: true } }) },
  { op: 'validateSmartLibraryVersion', perm: MANAGE, write: false, draftOnly: false, needsIfMatch: false, req: () => request({ params: P(), body: {} }) },
  { op: 'submitSmartLibraryVersion', perm: MANAGE, write: true, draftOnly: false, needsIfMatch: true, req: (h) => request({ params: P(), headers: h, body: {} }) },
  { op: 'approveSmartLibraryVersion', perm: APPROVE, write: true, draftOnly: false, needsIfMatch: true, req: (h) => request({ params: P(), headers: h, body: { attestation: true } }) },
  { op: 'returnSmartLibraryVersion', perm: APPROVE, write: true, draftOnly: false, needsIfMatch: true, req: (h) => request({ params: P(), headers: h, body: { comment: 'x' } }) },
];
const ALL21 = CASES.map((c) => c.op);
const persona = (c: Case): Persona => 'pathologist';
const nonAuthCalls = () => world.calls.filter((c) => c.fn !== 'assertRole');
const tenantA = () => JSON.stringify(JSON.parse(snapshot()), (_k, v) => v);
beforeEach(() => { seed(); loadLibrary(TA, D, lib(), { version_no: 1, groups: true }); });

describe('C14-T11 probe P0 — the case table covers exactly operations #1-#21 of smartreport.yaml, with the permission the contract declares', () => {
  it('21 operationIds, in contract order', () => {
    expect(ALL21).toEqual(declaredOperationIds().slice(0, 21));
  });
  it.each(CASES.map((c) => [c.op, c.perm]))('%s x-permission = %s (one floor per operation, 08 A19 P-43)', (op, perm) => { expect(permissionOf(op)).toBe(perm); });
});

describe('C14-T11 probe P1 — authorisation first, tenant-wide, exact permission', () => {
  it.each(CASES.map((c) => [c.op, c] as const))('%s: asserts exactly its x-permission, without centreId; never a stub', async (_op, c) => {
    const call_ = call(c.op, persona(c), c.req(ifMatch(1)));
    let err: unknown; try { await call_.run(); } catch (e) { err = e; }
    expect(call_.asserted.map((a) => a.permission)).toEqual([c.perm]);
    expect(call_.asserted[0]).not.toHaveProperty('centreId');
    expect(codeOf(err)).not.toBe('common.internal');
  });
  it.each(CASES.filter((c) => c.perm === MANAGE).flatMap((c) => (['front_desk', 'lab_technologist', 'revoked_pathologist'] as const).map((p) => [c.op, p, c] as const)))(
    '%s as %s -> 403 auth.forbidden, zero repository access', async (_op, p, c) => {
      expect(codeOf(await fails(call(c.op, p, c.req(ifMatch(1))).run()))).toBe('auth.forbidden');
      expect(nonAuthCalls()).toEqual([]);
    });
  it.each(CASES.map((c) => [c.op, c] as const))('%s as an unknown actor -> 401 auth.unauthenticated, zero repository access', async (_op, c) => {
    expect(codeOf(await fails(call(c.op, 'ghost', c.req(ifMatch(1))).run()))).toBe('auth.unauthenticated');
    expect(nonAuthCalls()).toEqual([]);
  });
  it.each(CASES.filter((c) => c.perm === APPROVE).map((c) => [c.op, c] as const))('%s: lab_manager -> 403 auth.forbidden; pathologist at aal1 -> 403 auth.mfa_required; both before any repository access (062/067)', async (_op, c) => {
    expect(codeOf(await fails(call(c.op, 'lab_manager', c.req(ifMatch(1))).run()))).toBe('auth.forbidden');
    expect(codeOf(await fails(call(c.op, 'pathologist_aal1', c.req(ifMatch(1))).run()))).toBe('auth.mfa_required');
    expect(nonAuthCalls()).toEqual([]);
  });
  it.each(CASES.filter((c) => c.perm === MANAGE).map((c) => [c.op, c] as const))('%s: template.manage is NOT privileged — pathologist at aal1 is not refused for aal2', async (_op, c) => {
    let err: unknown; try { await call(c.op, 'pathologist_aal1', c.req(ifMatch(1))).run(); } catch (e) { err = e; }
    expect(codeOf(err)).not.toBe('auth.mfa_required'); expect(codeOf(err)).not.toBe('auth.forbidden');
  });
});

describe('C14-T11 probe P2 — cross-tenant (REQ-SEC-022..024, AB-6): tenant B actor against tenant A ids -> 404, zero writes, tenant A untouched', () => {
  // #1 is a list: tenant B legitimately gets 200 with ITS OWN versions only (asserted in library.create.handlers.test.ts "tenant isolation")
  it.each(CASES.filter((c) => c.op !== 'listSmartLibraryVersions').map((c) => [c.op, c] as const))('%s', async (_op, c) => {
    loadLibrary(TB, VERB, starterLibrary(), { version_no: 1 });
    const before = tenantA(); const writesBefore = world.writes.length;
    const e = await fails(call(c.op, 'pathologist', c.req(ifMatch(1)), 'B').run());
    expect(codeOf(e)).toBe('common.not_found');
    expect(world.writes.length).toBe(writesBefore);
    expect(tenantA()).toBe(before);
  });
  it('a request body cannot move a write into another tenant (tenant_id in the body is refused or ignored; the row carries the caller\'s tenant)', async () => {
    const r = await call('createSmartTemplateBlock', 'pathologist', request({ params: P(), body: { block_key: 'advice.new', kind: 'advice', text_en: 'A note.', tenant_id: TB } })).run().catch((e) => e);
    if (r instanceof Error) expect(codeOf(r)).toBe('common.validation_failed');
    expect(world.blocks.filter((b) => b.tenant_id === TB)).toHaveLength(0);
  });
  it('every repository call of a tenant B request carries tenant B', async () => {
    loadLibrary(TB, VERB, starterLibrary(), { version_no: 1 });
    await call('getSmartLibraryVersion', 'pathologist', request({ params: { library_version_id: VERB } }), 'B').run();
    await call('listSmartTemplateBlocks', 'pathologist', request({ params: { library_version_id: VERB } }), 'B').run();
    const tenants = world.calls.filter((c) => c.tenantId !== undefined).map((c) => c.tenantId);
    expect(tenants.length).toBeGreaterThan(0);
    expect(tenants.every((t) => t === TB)).toBe(true);
  });
});

describe('C14-T11 probe P3 — If-Match on every ✓ operation (02-CV §4.2)', () => {
  const needing = CASES.filter((c) => c.needsIfMatch);
  const setup = (c: Case) => { if (c.op === 'approveSmartLibraryVersion' || c.op === 'returnSmartLibraryVersion') { world.versions[0]!.status = 'in_review'; world.versions[0]!.content_sha256 = 'a'.repeat(64); } };
  it('the ✓ set is #4 #7 #8 #11 #12 #14 #15 #17 #19 #20 #21', () => {
    expect(needing.map((c) => c.op)).toEqual(['updateSmartLibraryVersion', 'replaceSmartTemplateBlock', 'deleteSmartTemplateBlock', 'replaceSmartRule', 'deleteSmartRule', 'putSmartAnalyteGroup',
      'deleteSmartAnalyteGroup', 'putSmartGroupSetting', 'submitSmartLibraryVersion', 'approveSmartLibraryVersion', 'returnSmartLibraryVersion']);
  });
  it.each(needing.map((c) => [c.op, c] as const))('%s without If-Match -> 428 common.precondition_required, nothing written', async (_op, c) => {
    setup(c); const w = world.writes.length;
    const e = await fails(call(c.op, 'pathologist', c.req({})).run());
    expect(codeOf(e)).toBe('common.precondition_required'); expect(e.statusCode).toBe(428);
    expect(world.writes.length).toBe(w);
  });
  it.each(needing.filter((c) => c.op !== 'approveSmartLibraryVersion').map((c) => [c.op, c] as const))('%s with a stale If-Match -> 409 common.version_conflict, nothing written', async (_op, c) => {
    setup(c);
    // every row of the fixture is at version 1 except the parent; version 99 is stale for parent and children alike
    const w = world.writes.length;
    const e = await fails(call(c.op, 'pathologist', c.req(ifMatch(99))).run());
    expect(codeOf(e)).toBe('common.version_conflict'); expect(e.statusCode).toBe(409);
    expect(world.writes.length).toBe(w);
  });
  it.each(needing.map((c) => [c.op, c] as const))('%s with a malformed If-Match -> 400 common.validation_failed', async (_op, c) => {
    setup(c);
    for (const bad of ['abc', '"0"', '"-1"', '"1.5"', '""']) expect(codeOf(await fails(call(c.op, 'pathologist', c.req({ 'if-match': bad })).run())), bad).toBe('common.validation_failed');
  });
});

describe('C14-T11 probe P4 — nothing but a draft is editable (AB-1, AC-03.6, L2 forbidden transitions); the immutability is checked before any write', () => {
  const edits = CASES.filter((c) => c.draftOnly);
  it('the draft-only set is #4 #6 #7 #8 #10 #11 #12 #14 #15 #17', () => {
    expect(edits.map((c) => c.op)).toEqual(['updateSmartLibraryVersion', 'createSmartTemplateBlock', 'replaceSmartTemplateBlock', 'deleteSmartTemplateBlock', 'createSmartRule', 'replaceSmartRule',
      'deleteSmartRule', 'putSmartAnalyteGroup', 'deleteSmartAnalyteGroup', 'putSmartGroupSetting']);
  });
  it.each(edits.flatMap((c) => ['in_review', 'approved', 'retired'].map((s) => [c.op, s, c] as const)))('%s on a %s library -> 409 smartreport.library_invalid_transition, zero writes, rows unchanged', async (_op, status, c) => {
    world.versions[0]!.status = status; world.versions[0]!.content_sha256 = 'a'.repeat(64); world.versions[0]!.approved_at = T0; world.versions[0]!.approved_by_membership_id = MID.A.pathologist; world.versions[0]!.retired_at = T0;
    const before = tenantA();
    const e = await fails(call(c.op, 'pathologist', c.req(ifMatch(1))).run());
    expect(codeOf(e)).toBe('smartreport.library_invalid_transition'); expect(e.statusCode).toBe(409);
    expect(world.writes).toEqual([]);
    expect(tenantA()).toBe(before);
  });
  it('reads still work on non-draft versions', async () => {
    world.versions[0]!.status = 'approved'; world.versions[0]!.content_sha256 = 'a'.repeat(64); world.versions[0]!.approved_at = T0; world.versions[0]!.approved_by_membership_id = MID.A.pathologist;
    for (const op of ['getSmartLibraryVersion', 'listSmartTemplateBlocks', 'listSmartRules', 'listSmartAnalyteGroups', 'listSmartGroupSettings']) {
      expect((await call(op, 'pathologist', CASES.find((c) => c.op === op)!.req({})).run()).status, op).toBe(200);
    }
  });
});

describe('C14-T11 probe P5 — removals never delete (08 A17 P-18(a)): the rows survive as is_active=false', () => {
  it.each([['deleteSmartTemplateBlock', 'blocks', sid(700)], ['deleteSmartRule', 'rules', sid(11)]] as const)('%s', async (op, table, id) => {
    const c = CASES.find((x) => x.op === op)!;
    const n = world[table].length;
    expect((await call(op, 'pathologist', c.req(ifMatch(1))).run()).status).toBe(204);
    expect(world[table]).toHaveLength(n);
    expect(world[table].find((r) => r.id === id)!.is_active).toBe(false);
  });
  it('deleteSmartAnalyteGroup', async () => {
    const c = CASES.find((x) => x.op === 'deleteSmartAnalyteGroup')!;
    expect((await call(c.op, 'pathologist', c.req(ifMatch(1))).run()).status).toBe(204);
    expect(world.mappings).toHaveLength(1); expect(world.mappings[0]!.is_active).toBe(false);
  });
});

describe('C14-T11 probe P6 — injection / malformed ids', () => {
  it.each(["' OR 1=1 --", '../../etc/passwd', '00000000-0000-0000-0000-000000000000', 'x'.repeat(5000), '%00'])('library_version_id %j -> 404 (no 500, no oracle)', async (id) => {
    for (const op of ['getSmartLibraryVersion', 'listSmartTemplateBlocks', 'validateSmartLibraryVersion']) {
      const e = await fails(call(op, 'pathologist', request({ params: { library_version_id: id }, body: {} })).run());
      expect(codeOf(e), op).toBe('common.not_found');
    }
  });
  it.each([null, [], 'str', 42])('body %j on a body operation -> 400 common.validation_failed', async (body) => {
    for (const op of ['createSmartLibraryVersion', 'createSmartTemplateBlock', 'createSmartRule']) {
      const e = await fails(call(op, 'pathologist', { params: op === 'createSmartLibraryVersion' ? {} : P(), query: {}, headers: {}, body } as any).run());
      expect(codeOf(e), op).toBe('common.validation_failed');
    }
  });
  it('block text with markup is stored as text, byte for byte (AB-9: escaping is the renderer\'s job)', async () => {
    const text = '<script>alert(1)</script> {analyte_name}';
    const r = await call('createSmartTemplateBlock', 'pathologist', request({ params: P(), body: { block_key: 'advice.markup', kind: 'advice', text_en: text } })).run();
    expect(r.status).toBe(201); expect(r.body.text_en).toBe(text);
  });
  it('uuids used for new rows are generated server-side (a client id in the body is refused)', async () => {
    const e = await fails(call('createSmartTemplateBlock', 'pathologist', request({ params: P(), body: { id: uid(0x1), block_key: 'advice.new', kind: 'advice', text_en: 'x' } })).run());
    expect(codeOf(e)).toBe('common.validation_failed');
  });
});
