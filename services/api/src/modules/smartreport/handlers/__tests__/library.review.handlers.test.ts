// C14 T11 — #18 validateSmartLibraryVersion, #19 submitSmartLibraryVersion, #20 approveSmartLibraryVersion, #21 returnSmartLibraryVersion
// (06-PLAN T11; 02-TRD §5 + §9.4; 03-APP-FLOW §1.1 L3-L6, §2.1 steps 3-6). ACs: AC-06.5, AC-07.1, AC-07.2, AC-07.3, AC-07.4, AC-07.5 (+ AC-06.x/AC-03.3/AC-03.4 through #18).
// Security (07-SECURITY): privileged permissions need aal2 (IdentityPort.assertRole) 062/067; AB-1; approver identity recorded (P-17 display name via ctx.core.memberships.list).
// Approval setups run the REAL #19 first (so the stored content_sha256 is whatever the implementation computes); only AC-07.3 edits rows "as DB owner" afterwards.
// Seams: ../../__tests__/t11.helpers.ts header. Fails now: handlers 18-21 are T01 stubs.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../repository/library.repo.js', async () => (await import('../../__tests__/t11.fakes.js')).libraryRepoFake);
vi.mock('../../repository/blocks.repo.js', async () => (await import('../../__tests__/t11.fakes.js')).blocksRepoFake);
vi.mock('../../repository/rules.repo.js', async () => (await import('../../__tests__/t11.fakes.js')).rulesRepoFake);
vi.mock('../../repository/mappings.repo.js', async () => (await import('../../__tests__/t11.fakes.js')).mappingsRepoFake);
vi.mock('../../repository/groups.repo.js', async () => (await import('../../__tests__/t11.fakes.js')).groupsRepoFake);
vi.mock('../../repository/reviews.repo.js', async () => (await import('../../__tests__/t11.fakes.js')).reviewsRepoFake);
vi.mock('../../repository/codedSets.repo.js', async () => (await import('../../__tests__/t11.fakes.js')).codedSetsRepoFake);
vi.mock('../../repository/denyTerms.repo.js', async () => (await import('../../__tests__/t11.fakes.js')).denyTermsRepoFake);

import { idFor } from '../../../../../../../packages/fakes/src/base';
import { sid, starterLibrary, type LibInput } from '../../__tests__/t10.fixtures.js';
import { ANALYTE, MID, T0, TA, TB, VER, VERB, call, codeOf, fails, ifMatch, loadLibrary, nameOf, pointerOf, reid, request, responseProblems, reviewsRepoFake, seed, uid, world, type Persona } from '../../__tests__/t11.helpers.js';

const VALIDATE = 'validateSmartLibraryVersion', SUBMIT = 'submitSmartLibraryVersion', APPROVE = 'approveSmartLibraryVersion', RETURN = 'returnSmartLibraryVersion';
const MANAGE = 'smartreport.template.manage', APPROVE_PERM = 'smartreport.template.approve';
const good = (): LibInput => ({ ...starterLibrary(), mappings: [{ id: sid(900), analyteId: ANALYTE.a1, groupCode: 'liver' }] });
const row = (id: string) => world.versions.find((v) => v.id === id)!;
const p = (id: string, h: object = {}, body: unknown = {}) => request({ params: { library_version_id: id }, headers: h, body });
const nonAuthCalls = () => world.calls.filter((c) => c.fn !== 'assertRole');
const reviewsOf = (id: string) => world.reviews.filter((r) => r.library_version_id === id);
const HEX64 = /^[0-9a-f]{64}$/;

/** Draft -> real #19 -> in_review. Returns the #19 body. */
async function submitted(id = VER(4), versionNo = 4, lib: LibInput = good(), by: Persona = 'lab_manager', salt = 4): Promise<any> {
  loadLibrary(TA, id, reid(lib, salt), { version_no: versionNo });
  const r = await call(SUBMIT, by, p(id, ifMatch(1))).run();
  expect(r.status).toBe(200);
  return r.body;
}
beforeEach(() => { seed(); vi.clearAllMocks(); });

// ================================================================= #18
describe('C14-T11 #18 validateSmartLibraryVersion (report only, no writes)', () => {
  it('fresh starter draft: valid=false, the ONLY issue is no_mappings (error); report validates against the contract; nothing written (AC-02.5)', async () => {
    loadLibrary(TA, VER(1), starterLibrary(), { version_no: 1 });
    const c = call(VALIDATE, 'lab_manager', p(VER(1)));
    const r = await c.run();
    expect(r.status).toBe(200);
    expect(responseProblems(VALIDATE, r)).toEqual([]);
    expect(r.body.valid).toBe(false);
    expect(r.body.issues).toEqual([expect.objectContaining({ code: 'no_mappings', severity: 'error' })]);
    expect(world.writes).toEqual([]);
    expect(c.asserted.map((a) => a.permission)).toEqual([MANAGE]);
  });
  it('with one mapping: { valid: true, issues: [] }', async () => {
    loadLibrary(TA, VER(1), good(), { version_no: 1 });
    const r = await call(VALIDATE, 'pathologist', p(VER(1))).run();
    expect(r.body).toEqual({ valid: true, issues: [] });
  });
  it('AC-06.1/06.4: no disclaimer and a deny term -> valid=false with disclaimer_missing and deny_term (+ block_key)', async () => {
    const l = good(); l.blocks = l.blocks.filter((b) => b.kind !== 'disclaimer'); l.blocks.find((b) => b.kind === 'advice')!.textEn = 'Try a supplement.';
    loadLibrary(TA, VER(1), l, { version_no: 1 });
    const r = await call(VALIDATE, 'lab_manager', p(VER(1))).run();
    expect(responseProblems(VALIDATE, r)).toEqual([]);
    expect(r.body.valid).toBe(false);
    expect(r.body.issues.map((i: any) => i.code)).toEqual(expect.arrayContaining(['disclaimer_missing', 'deny_term']));
    expect(r.body.issues.find((i: any) => i.code === 'deny_term')).toMatchObject({ severity: 'error', block_key: 'advice.all_in_range' });
  });
  it('warnings (block_unused) are reported with severity "warning" and do not make the library invalid', async () => {
    const l = good(); l.blocks.push({ id: sid(800), blockKey: 'advice.spare', kind: 'advice', textEn: 'A spare note.' });
    loadLibrary(TA, VER(1), l, { version_no: 1 });
    const r = await call(VALIDATE, 'lab_manager', p(VER(1))).run();
    expect(r.body.valid).toBe(true);
    expect(r.body.issues).toEqual([expect.objectContaining({ code: 'block_unused', severity: 'warning', block_key: 'advice.spare' })]);
  });
  it('AC-05.2 end to end: a follow-up test the catalog reports inactive -> followup_test_inactive (rule_id set)', async () => {
    const l = good(); const inactive = idFor(1, 107);
    l.blocks.push({ id: sid(700), blockKey: 'followup.repeat', kind: 'followup', textEn: 'Repeat {test_name} after {interval_days} days.' });
    l.rules.push({ id: sid(710), ruleKind: 'followup', triggerKind: 'any', direction: 'high', minSeverity: 'out_of_range', priority: 100, blockId: sid(700), blockKind: 'followup', suggestedTestId: inactive, intervalDays: 30 });
    loadLibrary(TA, VER(1), l, { version_no: 1 });
    const r = await call(VALIDATE, 'lab_manager', p(VER(1))).run();
    expect(r.body.issues.find((i: any) => i.code === 'followup_test_inactive')).toMatchObject({ severity: 'error', rule_id: sid(710) });
  });
  it('removed (inactive) rows are not validated: a deactivated block with a deny term raises nothing', async () => {
    loadLibrary(TA, VER(1), good(), { version_no: 1 });
    world.blocks.push({ ...world.blocks[0], id: uid(0xf001), block_key: 'advice.removed', kind: 'advice', text_en: 'Buy this supplement.', is_active: false });
    expect((await call(VALIDATE, 'lab_manager', p(VER(1))).run()).body).toEqual({ valid: true, issues: [] });
  });
  it.each([['front_desk', 'auth.forbidden'], ['lab_technologist', 'auth.forbidden'], ['ghost', 'auth.unauthenticated']] as const)('%s -> %s before any read', async (persona, code) => {
    loadLibrary(TA, VER(1), good(), { version_no: 1 });
    expect(codeOf(await fails(call(VALIDATE, persona, p(VER(1))).run()))).toBe(code);
    expect(nonAuthCalls()).toEqual([]);
  });
  it('unknown id / another tenant\'s id -> 404', async () => {
    loadLibrary(TB, VERB, good(), { version_no: 1 });
    expect(codeOf(await fails(call(VALIDATE, 'lab_manager', p(VERB)).run()))).toBe('common.not_found');
    expect(codeOf(await fails(call(VALIDATE, 'lab_manager', p(VER(9))).run()))).toBe('common.not_found');
  });
});

// ================================================================= #19
describe('C14-T11 #19 submitSmartLibraryVersion (AC-06.5, L3)', () => {
  const submit = (id: string, h: object = ifMatch(1), persona: Persona = 'lab_manager') => call(SUBMIT, persona, p(id, h));
  it('AC-06.5: valid draft + current If-Match -> 200 in_review, content_sha256 stored (64 hex), submitted_at/by, library_reviews "submitted"', async () => {
    loadLibrary(TA, VER(1), good(), { version_no: 1 });
    const c = submit(VER(1));
    const r = await c.run();
    expect(r.status).toBe(200);
    expect(responseProblems(SUBMIT, r)).toEqual([]);
    expect(r.body).toMatchObject({ id: VER(1), status: 'in_review', submitted_by_membership_id: MID.A.lab_manager });
    expect(r.body.content_sha256).toMatch(HEX64);
    expect(r.body.submitted_at).toBeTruthy();
    expect(row(VER(1))).toMatchObject({ status: 'in_review', content_sha256: r.body.content_sha256 });
    const rev = reviewsOf(VER(1));
    expect(rev).toHaveLength(1);
    expect(rev[0]).toMatchObject({ action: 'submitted', tenant_id: TA, content_sha256: r.body.content_sha256, actor_membership_id: MID.A.lab_manager });
    expect(c.asserted.map((a) => a.permission)).toEqual([MANAGE]);
  });
  it('AC-06.5: invalid draft -> 422 smartreport.library_invalid with the issues in errors[] (path = JSON pointer, message starts with the issue code); state, hash and reviews untouched', async () => {
    loadLibrary(TA, VER(1), starterLibrary(), { version_no: 1 });             // no mapping -> V14
    const e = await fails(submit(VER(1)).run());
    expect(codeOf(e)).toBe('smartreport.library_invalid'); expect(e.statusCode).toBe(422);
    expect(e.errors.length).toBeGreaterThan(0);
    expect(e.errors.map((x: any) => String(x.message))).toEqual(expect.arrayContaining([expect.stringMatching(/^no_mappings/)]));
    for (const x of e.errors) { expect(x.code).toBe('common.field_invalid'); expect(typeof x.path).toBe('string'); }
    expect(row(VER(1))).toMatchObject({ status: 'draft', content_sha256: null, version: 1 });
    expect(world.reviews).toHaveLength(0);
  });
  it('error issues do not echo block text (no content in errors[])', async () => {
    const l = good(); l.blocks.find((b) => b.kind === 'advice')!.textEn = 'Buy this SECRETWORDXYZ supplement.';
    loadLibrary(TA, VER(1), l, { version_no: 1 });
    const e = await fails(submit(VER(1)).run());
    expect(codeOf(e)).toBe('smartreport.library_invalid');
    expect(e.errors?.length).toBeGreaterThan(0);
    expect(JSON.stringify(e.errors)).not.toContain('SECRETWORDXYZ');
  });
  it('warnings alone do not block submit', async () => {
    const l = good(); l.blocks.push({ id: sid(800), blockKey: 'advice.spare', kind: 'advice', textEn: 'A spare note.' });
    loadLibrary(TA, VER(1), l, { version_no: 1 });
    expect((await submit(VER(1)).run()).status).toBe(200);
  });
  it('If-Match: missing -> 428, stale -> 409 common.version_conflict; nothing changes', async () => {
    loadLibrary(TA, VER(1), good(), { version_no: 1, version: 4 });
    expect(codeOf(await fails(submit(VER(1), {}).run()))).toBe('common.precondition_required');
    expect(codeOf(await fails(submit(VER(1), ifMatch(3)).run()))).toBe('common.version_conflict');
    expect(row(VER(1)).status).toBe('draft'); expect(world.reviews).toHaveLength(0);
  });
  it.each(['in_review', 'approved', 'retired'])('library in %s -> 409 smartreport.library_invalid_transition', async (status) => {
    loadLibrary(TA, VER(1), good(), { version_no: 1, status, content_sha256: 'a'.repeat(64), approved_at: T0, approved_by_membership_id: MID.A.pathologist, retired_at: T0 });
    expect(codeOf(await fails(submit(VER(1)).run()))).toBe('smartreport.library_invalid_transition');
    expect(world.reviews).toHaveLength(0);
  });
  it('pathologist (also at aal1: template.manage is not privileged) may submit; front_desk/lab_technologist -> 403 before any read', async () => {
    loadLibrary(TA, VER(1), good(), { version_no: 1 });
    expect((await submit(VER(1), ifMatch(1), 'pathologist_aal1').run()).status).toBe(200);
    seed(); loadLibrary(TA, VER(1), good(), { version_no: 1 });
    for (const persona of ['front_desk', 'lab_technologist'] as const) { expect(codeOf(await fails(submit(VER(1), ifMatch(1), persona).run()))).toBe('auth.forbidden'); }
    expect(nonAuthCalls()).toEqual([]);
  });
  it('another tenant\'s version -> 404', async () => {
    loadLibrary(TB, VERB, good(), { version_no: 1 });
    expect(codeOf(await fails(submit(VERB).run()))).toBe('common.not_found');
    expect(row(VERB).status).toBe('draft');
  });

  describe('content_sha256 = SHA-256 of the canonical library JSON of ACTIVE rows (03-APP-FLOW L3; 02-TRD §4.10)', () => {
    async function hashOf(o: { reverse?: boolean; junk?: boolean; edit?: (l: LibInput) => void } = {}): Promise<string> {
      seed();
      const l = good(); o.edit?.(l);
      loadLibrary(TA, VER(1), l, { version_no: 1 });
      if (o.junk) world.blocks.push({ ...world.blocks[0], id: uid(0xf010), block_key: 'advice.junk', kind: 'advice', text_en: 'Junk.', is_active: false });
      world.opts.reverseLists = o.reverse === true;
      const r = await submit(VER(1)).run();
      world.opts.reverseLists = false;
      return r.body.content_sha256;
    }
    it('same content gives the same hash whatever order the repository returns rows in', async () => {
      const a = await hashOf(); const b = await hashOf({ reverse: true });
      expect(a).toMatch(HEX64); expect(b).toBe(a);
    });
    it('deactivated rows do not take part in the hash', async () => {
      expect(await hashOf({ junk: true })).toBe(await hashOf());
    });
    it('any text change changes the hash', async () => {
      expect(await hashOf({ edit: (l) => { l.blocks[0]!.textEn = '{analyte_name} is higher than the reference range.'; } })).not.toBe(await hashOf());
    });
  });
});

// ================================================================= #21
describe('C14-T11 #21 returnSmartLibraryVersion (AC-07.4, L4)', () => {
  let ver = 0;
  const ret = (id: string, body: unknown, h: object = ifMatch(ver), persona: Persona = 'pathologist') => call(RETURN, persona, p(id, h, body));
  beforeEach(async () => { ver = (await submitted(VER(1), 1, good(), 'lab_manager', 1)).version; });          // in_review
  it('AC-07.4: pathologist (aal2) + comment -> 200 draft, return_comment/returned_at/returned_by stored, library_reviews "returned" with the comment', async () => {
    const c = ret(VER(1), { comment: 'Please reword the advice block.' });
    const r = await c.run();
    expect(r.status).toBe(200);
    expect(responseProblems(RETURN, r)).toEqual([]);
    expect(r.body).toMatchObject({ id: VER(1), status: 'draft', return_comment: 'Please reword the advice block.' });
    expect(r.body.returned_at).toBeTruthy();
    expect(row(VER(1))).toMatchObject({ status: 'draft', return_comment: 'Please reword the advice block.', returned_by_membership_id: MID.A.pathologist });
    const rev = reviewsOf(VER(1)).filter((x) => x.action === 'returned');
    expect(rev).toHaveLength(1);
    expect(rev[0]).toMatchObject({ comment: 'Please reword the advice block.', actor_membership_id: MID.A.pathologist });
    expect(c.asserted.map((a) => a.permission)).toEqual([APPROVE_PERM]);
  });
  it('after the return the library is editable again and can be re-submitted', async () => {
    await ret(VER(1), { comment: 'Fix it.' }).run();
    const b = await call('createSmartTemplateBlock', 'lab_manager', request({ params: { library_version_id: VER(1) }, body: { block_key: 'advice.extra', kind: 'advice', text_en: 'Another note.' } })).run();
    expect(b.status).toBe(201);
    const s = await call(SUBMIT, 'lab_manager', p(VER(1), ifMatch(row(VER(1)).version))).run();
    expect(s.status).toBe(200); expect(s.body.status).toBe('in_review');
  });
  it('AC-07.2: aal1 pathologist -> 403 auth.mfa_required; lab_manager -> 403 auth.forbidden; front_desk/revoked -> 403; before any repository access; state unchanged', async () => {
    world.calls = [];
    expect(codeOf(await fails(ret(VER(1), { comment: 'x' }, ifMatch(ver), 'pathologist_aal1').run()))).toBe('auth.mfa_required');
    for (const persona of ['lab_manager', 'front_desk', 'revoked_pathologist'] as const) expect(codeOf(await fails(ret(VER(1), { comment: 'x' }, ifMatch(ver), persona).run())), persona).toBe('auth.forbidden');
    expect(nonAuthCalls()).toEqual([]);
    expect(row(VER(1)).status).toBe('in_review');
  });
  it.each([['no comment', {}], ['empty comment', { comment: '' }], ['1001 chars', { comment: 'x'.repeat(1001) }], ['not a string', { comment: 5 }], ['extra field', { comment: 'x', status: 'approved' }]])(
    'invalid body (%s) -> 400 common.validation_failed, status unchanged', async (_n, body) => {
      expect(codeOf(await fails(ret(VER(1), body).run()))).toBe('common.validation_failed');
      expect(row(VER(1)).status).toBe('in_review');
    });
  it('1000 chars is accepted', async () => { expect((await ret(VER(1), { comment: 'x'.repeat(1000) }).run()).status).toBe(200); });
  it('If-Match: missing 428, stale 409', async () => {
    expect(codeOf(await fails(ret(VER(1), { comment: 'x' }, {}).run()))).toBe('common.precondition_required');
    expect(codeOf(await fails(ret(VER(1), { comment: 'x' }, ifMatch(ver - 1)).run()))).toBe('common.version_conflict');
  });
  it.each(['draft', 'approved', 'retired'])('library in %s -> 409 smartreport.library_invalid_transition (only in_review can be returned)', async (status) => {
    row(VER(1)).status = status; row(VER(1)).approved_at = T0; row(VER(1)).approved_by_membership_id = MID.A.pathologist; row(VER(1)).retired_at = T0;
    expect(codeOf(await fails(ret(VER(1), { comment: 'x' }).run()))).toBe('smartreport.library_invalid_transition');
  });
  it('another tenant\'s id -> 404', async () => {
    expect(codeOf(await fails(call(RETURN, 'pathologist', p(VER(1), ifMatch(ver), { comment: 'x' }), 'B').run()))).toBe('common.not_found');
  });
});

// ================================================================= #20
describe('C14-T11 #20 approveSmartLibraryVersion (AC-07.1, AC-07.3, AC-07.5, L5/L6)', () => {
  const approve = (id: string, version: number, body: unknown = { attestation: true }, persona: Persona = 'pathologist') => call(APPROVE, persona, p(id, ifMatch(version), body));
  async function v3approvedAndV4submitted(): Promise<any> {
    loadLibrary(TA, VER(3), reid(good(), 3), { version_no: 3, status: 'approved', content_sha256: 'c'.repeat(64), approved_at: T0, approved_by_membership_id: MID.A.lab_manager, version: 5 });
    return submitted(VER(4), 4, good(), 'lab_manager', 4);
  }
  it('AC-07.1: v4 in_review + v3 approved, pathologist at aal2 with attestation -> v4 approved (approved_by/at/note/display name), v3 retired, review rows written', async () => {
    const s = await v3approvedAndV4submitted();
    world.coreCalls = [];
    const c = approve(VER(4), s.version, { attestation: true, note: 'Reviewed every text.' });
    const r = await c.run();
    expect(r.status).toBe(200);
    expect(responseProblems(APPROVE, r)).toEqual([]);
    expect(r.body).toMatchObject({ id: VER(4), status: 'approved', approved_by_membership_id: MID.A.pathologist, approved_by_display_name: nameOf('A', 'pathologist'), approval_note: 'Reviewed every text.', content_sha256: s.content_sha256 });
    expect(r.body.approved_at).toBeTruthy();
    expect(row(VER(4))).toMatchObject({ status: 'approved', approved_by_membership_id: MID.A.pathologist, approval_note: 'Reviewed every text.' });
    expect(row(VER(3)).status).toBe('retired'); expect(row(VER(3)).retired_at).toBeTruthy();
    expect(world.versions.filter((v) => v.tenant_id === TA && v.status === 'approved').map((v) => v.id)).toEqual([VER(4)]);   // exactly one approved version
    const a = reviewsOf(VER(4)).find((x) => x.action === 'approved')!;
    expect(a).toMatchObject({ tenant_id: TA, actor_membership_id: MID.A.pathologist, content_sha256: s.content_sha256 });
    expect(reviewsOf(VER(3)).map((x) => x.action)).toEqual(['retired']);
    expect(world.coreCalls.filter((x) => x.fn === 'memberships.list')).toHaveLength(1);                       // one batched lookup, memoised per request
    expect(c.asserted.map((x) => x.permission)).toEqual([APPROVE_PERM]);
  });
  it('first approval (no previous approved version) works and writes no "retired" review', async () => {
    const s = await submitted(VER(1), 1, good(), 'lab_manager', 1);
    const r = await approve(VER(1), s.version).run();
    expect(r.status).toBe(200); expect(r.body.status).toBe('approved');
    expect(world.reviews.filter((x) => x.action === 'retired')).toHaveLength(0);
  });
  it('the approver may be the author (small labs): submit and approve by the same pathologist', async () => {
    const s = await submitted(VER(1), 1, good(), 'pathologist', 1);
    expect((await approve(VER(1), s.version).run()).status).toBe(200);
    expect(row(VER(1)).submitted_by_membership_id).toBe(MID.A.pathologist);
  });
  it('AC-07.5: summaries built with v3 are unchanged (pinned) and new work uses v4; the approval never touches summaries', async () => {
    const s = await v3approvedAndV4submitted();
    const pinned = { id: uid(0xa001), tenant_id: TA, library_version_id: VER(3), status: 'approved', content: { score: 90 }, template_library_version: 3 };
    world.summaries.push(JSON.parse(JSON.stringify(pinned)));
    expect((await approve(VER(4), s.version).run()).status).toBe(200);
    expect(world.summaries).toEqual([pinned]);
    const { libraryRepoFake } = await import('../../__tests__/t11.fakes.js');
    const cur = await libraryRepoFake.getApprovedLibraryVersion({ tenantId: TA, actorId: 'x' });
    expect(cur!.id).toBe(VER(4));
  });
  it('AC-07.2: aal1 pathologist -> 403 auth.mfa_required; lab_manager -> 403 auth.forbidden (before any repository access); nothing changes', async () => {
    const s = await v3approvedAndV4submitted();
    world.calls = []; const writesBefore = world.writes.length;
    expect(codeOf(await fails(approve(VER(4), s.version, { attestation: true }, 'pathologist_aal1').run()))).toBe('auth.mfa_required');
    for (const persona of ['lab_manager', 'front_desk', 'lab_technologist', 'revoked_pathologist'] as const) expect(codeOf(await fails(approve(VER(4), s.version, { attestation: true }, persona).run())), persona).toBe('auth.forbidden');
    expect(codeOf(await fails(approve(VER(4), s.version, { attestation: true }, 'ghost').run()))).toBe('auth.unauthenticated');
    expect(nonAuthCalls()).toEqual([]); expect(world.writes.length).toBe(writesBefore);
    expect(row(VER(4)).status).toBe('in_review'); expect(row(VER(3)).status).toBe('approved');
  });
  it.each([['attestation false', { attestation: false }], ['attestation missing', {}], ['attestation "true"', { attestation: 'true' }], ['note 501 chars', { attestation: true, note: 'n'.repeat(501) }],
    ['extra field', { attestation: true, status: 'approved' }], ['approved_by smuggled', { attestation: true, approved_by_membership_id: MID.A.lab_manager }]])(
    'invalid body (%s) -> 400 common.validation_failed; nothing changes', async (_n, body) => {
      const s = await v3approvedAndV4submitted();
      const e = await fails(approve(VER(4), s.version, body).run());
      expect(codeOf(e)).toBe('common.validation_failed');
      expect(row(VER(4)).status).toBe('in_review'); expect(row(VER(3)).status).toBe('approved');
    });
  it('attestation false points at /attestation', async () => {
    const s = await v3approvedAndV4submitted();
    expect(pointerOf(await fails(approve(VER(4), s.version, { attestation: false }).run()))).toContain('/attestation');
  });
  it('AC-07.3: content changed after submit (edited as DB owner) -> 409 smartreport.library_invalid_transition; v4 stays in_review, v3 stays approved, no new review rows', async () => {
    const s = await v3approvedAndV4submitted();
    world.blocks.find((b) => b.library_version_id === VER(4) && b.kind === 'advice')!.text_en = 'Quietly changed after submit.';
    const reviews = world.reviews.length;
    const e = await fails(approve(VER(4), s.version).run());
    expect(codeOf(e)).toBe('smartreport.library_invalid_transition'); expect(e.statusCode).toBe(409);
    expect(row(VER(4)).status).toBe('in_review'); expect(row(VER(3)).status).toBe('approved');
    expect(world.reviews).toHaveLength(reviews);
  });
  it('a deactivated-after-submit block also changes the active content -> 409 (hash is over active rows)', async () => {
    const s = await v3approvedAndV4submitted();
    world.blocks.find((b) => b.library_version_id === VER(4) && b.kind === 'advice')!.is_active = false;
    expect(codeOf(await fails(approve(VER(4), s.version).run()))).toBe('smartreport.library_invalid_transition');
  });
  it.each(['draft', 'approved', 'retired'])('library in %s -> 409 smartreport.library_invalid_transition (draft -> approved is forbidden)', async (status) => {
    loadLibrary(TA, VER(1), good(), { version_no: 1, status, content_sha256: status === 'draft' ? null : 'a'.repeat(64), approved_at: T0, approved_by_membership_id: MID.A.lab_manager, retired_at: T0 });
    const e = await fails(approve(VER(1), 1).run());
    expect(codeOf(e)).toBe('smartreport.library_invalid_transition'); expect(e.statusCode).toBe(409);
    expect(row(VER(1)).status).toBe(status);
  });
  it('If-Match: missing 428, stale 409 common.version_conflict', async () => {
    const s = await v3approvedAndV4submitted();
    expect(codeOf(await fails(call(APPROVE, 'pathologist', p(VER(4), {}, { attestation: true })).run()))).toBe('common.precondition_required');
    expect(codeOf(await fails(approve(VER(4), s.version - 1).run()))).toBe('common.version_conflict');
  });
  it('a failing review insert fails the whole approval (reviews are part of the same transaction): v4 stays in_review, v3 stays approved', async () => {
    const s = await v3approvedAndV4submitted();
    reviewsRepoFake.insertLibraryReview.mockRejectedValueOnce(new Error('review store down'));
    await fails(approve(VER(4), s.version).run());
    expect(row(VER(4)).status).toBe('in_review'); expect(row(VER(3)).status).toBe('approved');
  });
  it('another tenant\'s version -> 404 and tenant B cannot approve tenant A\'s', async () => {
    const s = await v3approvedAndV4submitted();
    expect(codeOf(await fails(call(APPROVE, 'pathologist', p(VER(4), ifMatch(s.version), { attestation: true }), 'B').run()))).toBe('common.not_found');
    loadLibrary(TB, VERB, good(), { version_no: 1 });
    expect(row(VER(4)).status).toBe('in_review');
  });
});
