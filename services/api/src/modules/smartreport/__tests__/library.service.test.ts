// C14 T10 — library.service.validateLibraryVersion (06-PLAN row T10; 02-TRD §9.4; 03-APP-FLOW §2 step "Validate"; 08 A19 P-44, D-108).
// Integration: the REAL service over repository emulators (vi.mock of the T02 repositories) and the REAL CatalogPort fake. ACs: AC-02.5 (starter -> only no_mappings),
// AC-05.2 (inactive follow-up test, via CatalogPort), AC-06.1/06.2/06.4 end-to-end. Security: REQ-SEC-022..024 tenant isolation, read-only, savepoint around port calls (P-44), AB-2.
// Seams: ./t10.fixtures.ts header. Fails now: ../library.service.js does not exist.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LimsError } from '../../../core/errors.js';

vi.mock('../repository/library.repo.js', async () => (await import('./t10.fakes.js')).libraryRepoFake);
vi.mock('../repository/blocks.repo.js', async () => (await import('./t10.fakes.js')).blocksRepoFake);
vi.mock('../repository/rules.repo.js', async () => (await import('./t10.fakes.js')).rulesRepoFake);
vi.mock('../repository/mappings.repo.js', async () => (await import('./t10.fakes.js')).mappingsRepoFake);
vi.mock('../repository/denyTerms.repo.js', async () => (await import('./t10.fakes.js')).denyTermsRepoFake);
vi.mock('../repository/groups.repo.js', async () => (await import('./t10.fakes.js')).groupsRepoFake);
vi.mock('../repository/codedSets.repo.js', async () => (await import('./t10.fakes.js')).codedSetsRepoFake);

import { validateLibraryVersion } from '../library.service.js';
import { GLOBAL_DENY, sid, starterLibrary, type LibInput } from './t10.fixtures.js';
import { TA, TB, TEST, VA, VB, callsOf, catalog, load, makeCtx, seed, world } from './t10.fakes.js';

const MAP = { id: sid(900), analyteId: sid(901), groupCode: 'blood_counts' };
const codes = (r: any) => r.errors.map((i: any) => i.code);
const issues = (r: any, code: string) => [...r.errors, ...r.warnings].filter((i: any) => i.code === code);
const good = (): LibInput => ({ ...starterLibrary(), mappings: [{ ...MAP }] });
const fails = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected the call to be refused'); };
const withFollowup = (l: LibInput, ...tests: string[]): LibInput => {
  l.blocks.push({ id: sid(700), blockKey: 'followup.repeat', kind: 'followup', textEn: 'Repeat {test_name} after {interval_days} days.' });
  tests.forEach((t, i) => l.rules.push({ id: sid(710 + i), ruleKind: 'followup', triggerKind: 'any', direction: 'high', minSeverity: 'out_of_range', priority: 100 + i, blockId: sid(700), blockKind: 'followup', suggestedTestId: t, intervalDays: 30 + i }));
  return l;
};
beforeEach(() => { seed(GLOBAL_DENY); vi.clearAllMocks(); });

describe('C14-T10 validateLibraryVersion — starter library (AC-02.5, D-108)', () => {
  it('a fresh starter draft: the ONLY error is no_mappings; no warnings; valid=false', async () => {
    load(TA, VA, starterLibrary());
    const r = await validateLibraryVersion(makeCtx().ctx, VA);
    expect(codes(r)).toEqual(['no_mappings']); expect(r.warnings).toEqual([]); expect(r.valid).toBe(false);
  });
  it('starter + one mapping validates clean (valid=true) through the service', async () => {
    load(TA, VA, good());
    expect(await validateLibraryVersion(makeCtx().ctx, VA)).toEqual({ valid: true, errors: [], warnings: [] });
  });
  it('the starter score explanation passes the global deny term "diagnos"; "diagnosis" in it would fail (AB-2 / D-108)', async () => {
    const bad = good(); bad.blocks.find((b) => b.kind === 'score_explanation')!.textEn = 'This score is not a diagnosis.';
    load(TA, VA, bad);
    expect(issues(await validateLibraryVersion(makeCtx().ctx, VA), 'deny_term')[0]).toMatchObject({ blockKey: 'score.explanation', term: 'diagnos' });
  });
});

describe('C14-T10 service reads the version as stored (AC-06.x end to end)', () => {
  it('uses the version row: score_enabled=false lifts V2; ne language switches V9', async () => {
    const l = good(); l.scoreEnabled = false; l.blocks = l.blocks.filter((b) => b.kind !== 'score_explanation');
    load(TA, VA, l);
    expect(codes(await validateLibraryVersion(makeCtx().ctx, VA))).toEqual([]);
    world.versions.find((v) => v.id === VA)!.language = 'ne';
    expect(codes(await validateLibraryVersion(makeCtx().ctx, VA))).toContain('language_text_missing');
  });
  it('no disclaimer -> disclaimer_missing (AC-06.1); score on without explanation -> score_explanation_missing (AC-06.2)', async () => {
    const l = good(); l.blocks = l.blocks.filter((b) => b.kind !== 'disclaimer' && b.kind !== 'score_explanation');
    load(TA, VA, l);
    expect(codes(await validateLibraryVersion(makeCtx().ctx, VA))).toEqual(expect.arrayContaining(['disclaimer_missing', 'score_explanation_missing']));
  });
  it('works for in_review and approved versions too (read-only report on any status)', async () => {
    load(TA, VA, good(), { status: 'in_review' });
    expect((await validateLibraryVersion(makeCtx().ctx, VA)).valid).toBe(true);
    world.versions.find((v) => v.id === VA)!.status = 'approved';
    expect((await validateLibraryVersion(makeCtx().ctx, VA)).valid).toBe(true);
  });
  it('deny terms = global active + the tenant\'s active terms; an inactive tenant term and another tenant\'s term are not applied', async () => {
    const l = good(); l.blocks.find((b) => b.blockKey === 'advice.all_in_range')!.textEn = 'zeta term old term b-only-term supplement.';
    load(TA, VA, l);
    const hits = issues(await validateLibraryVersion(makeCtx().ctx, VA), 'deny_term').map((i: any) => i.term).sort();
    expect(hits).toEqual(['supplement', 'zeta term']);
    const o = callsOf('listDenyTerms')[0]!.args[0] as any;
    expect(o?.includeInactive).not.toBe(true);
  });
  it('inactive (removed) blocks, rules and mappings are ignored: reads never ask for includeInactive', async () => {
    load(TA, VA, good());
    world.blocks.push({ ...world.blocks[4]!, id: sid(777), block_key: 'disclaimer.removed', is_active: false });                     // 2nd disclaimer, removed
    world.blocks.push({ id: sid(778), tenant_id: TA, library_version_id: VA, block_key: 'advice.removed', kind: 'advice', text_en: 'Take 3 doses.', text_ne: null, is_active: false });
    const r = await validateLibraryVersion(makeCtx().ctx, VA);
    expect(r).toEqual({ valid: true, errors: [], warnings: [] });
    for (const c of callsOf('listBlocks', 'listRules', 'listMappings')) expect((c.args[1] as any)?.includeInactive).not.toBe(true);
  });
});

describe('C14-T10 V6 via CatalogPort (AC-05.2, 08 A19 P-44)', () => {
  it('active test passes; inactive, unknown and other-tenant tests -> followup_test_inactive on the rule that uses them', async () => {
    load(TA, VA, withFollowup(good(), TEST.active, TEST.inactive, TEST.unknown, TEST.otherTenant));
    const r = await validateLibraryVersion(makeCtx().ctx, VA);
    expect(issues(r, 'followup_test_inactive').map((i: any) => i.path).sort()).toEqual([sid(711), sid(712), sid(713)].map((id) => `/rules/${id}`));
    expect(r.valid).toBe(false);
  });
  it('all follow-up tests active -> no V6 issue', async () => {
    load(TA, VA, withFollowup(good(), TEST.active, TEST.glu));
    expect(issues(await validateLibraryVersion(makeCtx().ctx, VA), 'followup_test_inactive')).toEqual([]);
  });
  it('one getTest per DISTINCT test with requireActive: true, as the caller\'s tenant, in a savepoint; a shared test flags every rule using it', async () => {
    load(TA, VA, withFollowup(good(), TEST.inactive, TEST.inactive, TEST.active));
    const r = await validateLibraryVersion(makeCtx().ctx, VA);
    expect(world.catalogCalls.map((c) => c.input).sort((a, b) => a.testId.localeCompare(b.testId))).toEqual([{ testId: TEST.active, requireActive: true }, { testId: TEST.inactive, requireActive: true }].sort((a, b) => a.testId.localeCompare(b.testId)));
    expect(world.catalogCalls.every((c) => c.inSavepoint && c.tenantId === TA)).toBe(true);
    expect(issues(r, 'followup_test_inactive')).toHaveLength(2);
  });
  it('P-44 marker: the port writes a marker row then fails; the service catches after the rollback -> the marker is NOT in the committed state', async () => {
    load(TA, VA, withFollowup(good(), TEST.inactive));
    const r = await validateLibraryVersion(makeCtx().ctx, VA);
    expect(issues(r, 'followup_test_inactive')).toHaveLength(1);
    expect(world.catalogCalls).toHaveLength(1);
    expect(world.markers).toEqual([]);
  });
  it('P-44 marker, failNext(catalog.test_inactive) on a test that is active: still an issue, marker rolled back', async () => {
    load(TA, VA, withFollowup(good(), TEST.active));
    catalog.failNext('getTest', 'catalog.test_inactive');
    const wrapped = makeCtx();
    // the wrapper delegates to the module-level catalog fake, so the queued failure applies to the first call
    const r = await validateLibraryVersion(wrapped.ctx, VA);
    expect(issues(r, 'followup_test_inactive')).toHaveLength(1); expect(world.markers).toEqual([]);
  });
  it('a passing lookup is not rolled back (marker kept) — the savepoint only undoes failures', async () => {
    load(TA, VA, withFollowup(good(), TEST.active));
    await validateLibraryVersion(makeCtx().ctx, VA);
    expect(world.markers).toEqual([`marker:${TEST.active}`]);
  });
  it('an unexpected port error (not catalog.test_inactive / common.not_found) is not swallowed into an issue', async () => {
    load(TA, VA, withFollowup(good(), TEST.active));
    catalog.failNext('getTest', 'common.internal');
    const e = await fails(validateLibraryVersion(makeCtx().ctx, VA));
    expect(e).toBeInstanceOf(LimsError); expect(e.code).toBe('common.internal');
  });
  it('no follow-up rules -> the catalog is not called at all', async () => {
    load(TA, VA, good());
    await validateLibraryVersion(makeCtx().ctx, VA);
    expect(world.catalogCalls).toEqual([]);
  });
});

describe('C14-T10 isolation and read-only (REQ-SEC-022..024)', () => {
  it('unknown version id -> common.not_found', async () => {
    load(TA, VA, good());
    const e = await fails(validateLibraryVersion(makeCtx().ctx, sid(0xbad)));
    expect(e).toBeInstanceOf(LimsError); expect(e.code).toBe('common.not_found');
  });
  it('tenant B asking for tenant A\'s version -> common.not_found (same as unknown), nothing of A is read', async () => {
    load(TA, VA, good()); load(TB, VB, good());
    const e = await fails(validateLibraryVersion(makeCtx('B').ctx, VA));
    expect(e.code).toBe('common.not_found');
    expect(callsOf('listBlocks', 'listRules', 'listMappings')).toEqual([]);
    expect(world.catalogCalls).toEqual([]);
  });
  it('every repository call is scoped to the caller\'s tenant; tenant A\'s deny terms never leak into B\'s validation', async () => {
    const lb = good(); lb.blocks.find((b) => b.blockKey === 'advice.all_in_range')!.textEn = 'zeta term b-only-term.';
    load(TA, VA, good()); load(TB, VB, lb);
    const r = await validateLibraryVersion(makeCtx('B').ctx, VB);
    expect(issues(r, 'deny_term').map((i: any) => i.term)).toEqual(['b-only-term']);
    expect(world.calls.every((c) => c.tenantId === TB)).toBe(true);
  });
  it('writes nothing: no insert/update on any repository, and no database access except through the repositories', async () => {
    load(TA, VA, withFollowup(good(), TEST.inactive, TEST.active));
    const ctx = makeCtx().ctx;
    await validateLibraryVersion(ctx, VA);
    expect(world.writes).toEqual([]);
    expect(ctx.tx.query).not.toHaveBeenCalled();
  });
  it('is repeatable: validating twice gives the same report', async () => {
    load(TA, VA, withFollowup(good(), TEST.inactive));
    expect(await validateLibraryVersion(makeCtx().ctx, VA)).toEqual(await validateLibraryVersion(makeCtx().ctx, VA));
  });
});
