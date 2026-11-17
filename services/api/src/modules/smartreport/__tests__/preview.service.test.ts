// C14 T16 — preview.service.previewLibraryVersion (#22): no writes, synthetic fixtures, lab.result.read for real orders (06-PLAN row T16; 02-TRD #22, §13 access-log table; 03-APP-FLOW §2.7).
// ACs: AC-19.1, AC-19.2. Security: AB-13 (preview must not read an order the author may not see; access-logged), REQ-SEC 136 (synthetic fixtures only), tenant from ctx.
// Integration: the REAL service + engine over the T12 repository/port emulators. Fails now: ../preview.service.js and the fixtures module do not exist.
//
// SEAMS pinned (the spec fixes behaviour, not TypeScript shapes):
//   preview.service.ts  previewLibraryVersion(ctx, input: { libraryVersionId: string; orderId?: string; fixtureCode?: 'synthetic_basic'|'synthetic_all_in_range'|'synthetic_critical' }): Promise<Row>
//     Exactly one of orderId / fixtureCode, else LimsError common.validation_failed (nothing read, nothing logged). Non-uuid orderId -> common.validation_failed.
//     Row = the smartreport.summaries column shape of buildOrGet's row (snake_case), but status 'preview' and NO `id` (the handler maps it with the SmartSummaryView mapper):
//       { status:'preview', library_version_id, template_library_version (String(version_no)), formula_version, language, content, built_at (= ctx.now()), health_score_value?/band?,
//         panels_scored, deranged_count, critical_count, unmapped_result_count, ignored_duplicate_count, order_id (order path only) }.
//     Library: ctx tenant's version `libraryVersionId` of ANY status (draft/in_review/approved/retired); unknown / other tenant's / malformed id -> common.not_found.
//     Authorisation: the handler does template.manage. The SERVICE does IdentityPort.assertRole(ctx, { permission: 'lab.result.read', centreId: <FrontdeskPort.getOrderSummary(...).centreId> })
//       on the order path ONLY (after getOrderSummary, before LabPort.getOrderResults); a rejection (auth.forbidden) propagates unchanged. Fixture path: no assertRole, no Lab/Frontdesk/Catalog call.
//     Order path = buildOrGet steps 3,4,7c (same eligibility, min_mapped_results -> smartreport.no_eligible_results, analytes via CatalogPort.getTest, history in a savepoint) but
//       WITHOUT the advisory lock, WITHOUT reading/writing summaries or bindings, and WITHOUT touching the library tables other than reads. Results scope 'approved'.
//     Access log (order path only, on success): ctx.audit.access({ action:'smart_summary.view', entityType:'smart_summary_preview', outcome:'allowed', ... }) exactly once;
//       core audit/access.ts only accepts outcome 'allowed'|'denied' (03-APP-FLOW's "success" would throw common.internal), so 'allowed'. No PHI (registration no, patient id) in the entry.
//   packages/test-fixtures/src/smartreport/index.ts  SMART_PREVIEW_FIXTURES: Record<fixtureCode, { results: EngineResult[]; analytes: EngineAnalyte[] }>   (domain/engine.ts input shapes, camelCase)
//     each has >= 3 distinct analytes (min_mapped_results default 3); basic: >=1 deranged, 0 critical; all_in_range: 0 deranged; critical: >=1 critical. Synthetic only, no real names.
//     The library under preview supplies the mappings; the fixture supplies results + analyte names (no CatalogPort).
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../repository/summaries.repo.js', async () => (await import('./t12.fakes.js')).summariesRepoFake);
vi.mock('../repository/bindings.repo.js', async () => (await import('./t12.fakes.js')).bindingsRepoFake);
vi.mock('../repository/library.repo.js', async () => (await import('./t12.fakes.js')).libraryRepoFake);
vi.mock('../repository/blocks.repo.js', async () => (await import('./t12.fakes.js')).blocksRepoFake);
vi.mock('../repository/rules.repo.js', async () => (await import('./t12.fakes.js')).rulesRepoFake);
vi.mock('../repository/mappings.repo.js', async () => (await import('./t12.fakes.js')).mappingsRepoFake);
vi.mock('../repository/groups.repo.js', async () => (await import('./t12.fakes.js')).groupsRepoFake);
vi.mock('../repository/codedSets.repo.js', async () => (await import('./t12.fakes.js')).codedSetsRepoFake);

import { previewLibraryVersion } from '../preview.service.js';
import {
  AN, CENTRE, LimsError, ORDER, REG_NO, TA, VER, approveLibrary, callsOf, enableTrend, libOf, lib, makeCtx as baseCtx, portCallsOf, result, seed, setResults, uid, w, ac081, withRange,
} from './t12.fakes.js';
import { loadLibrary, reid, snapshot } from './t11.fakes.js';

type Code = 'synthetic_basic' | 'synthetic_all_in_range' | 'synthetic_critical';
const CODES: Code[] = ['synthetic_basic', 'synthetic_all_in_range', 'synthetic_critical'];
const fixture = async (code: Code): Promise<{ results: any[]; analytes: any[] }> => (await import('../../../../../../packages/test-fixtures/src/smartreport/index.js')).SMART_PREVIEW_FIXTURES[code];

const fails = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected the call to be refused'); };

/** A user ctx (tenant A) with IdentityPort.assertRole + audit.access spies; `deny` = permissions the caller lacks. */
function makeCtx(o: { tenant?: 'A' | 'B'; deny?: string[] } = {}): any {
  const ctx = baseCtx(o.tenant ?? 'A', 'user');
  ctx.ports.IdentityPort = {
    assertRole: vi.fn(async (_c: unknown, req: { permission: string; centreId?: string }) => {
      w.calls.push({ fn: 'assertRole', tenantId: ctx.tenantId, args: [req] });
      if (o.deny?.includes(req.permission)) throw new LimsError('auth.forbidden');
    }),
  };
  ctx.requestId = uid(0xfe01);
  ctx.audit = { access: vi.fn(async (e: unknown) => { w.calls.push({ fn: 'audit.access', tenantId: ctx.tenantId, args: [e] }); }) };
  return ctx;
}

/** Tenant-A library `no` containing mappings for every analyte given (fixture analytes or the order's analytes). status draft by default. */
function loadMapped(no: number, analyteIds: string[], status: 'draft' | 'in_review' | 'approved' | 'retired' = 'draft'): string {
  const groups = ['blood_counts', 'liver', 'kidney'];
  const l = libOf();
  l.mappings = analyteIds.map((analyteId, i) => ({ id: uid(0x5200 + i), analyteId, groupCode: groups[i % 3]! }));
  const extra: Record<string, unknown> = status === 'draft' ? {} : { content_sha256: 'a'.repeat(64) };
  if (status === 'approved' || status === 'retired') Object.assign(extra, { approved_at: new Date('2026-11-01T00:00:00.000Z'), approved_by_membership_id: uid(0x7500) });
  if (status === 'retired') Object.assign(extra, { retired_at: new Date('2026-11-02T00:00:00.000Z') });
  loadLibrary(TA, VER(no), reid(l, no), { groups: true, status, version_no: no, ...extra });
  return VER(no);
}
const orderAnalytes = [AN.HGB, AN.WBC, AN.PLT, AN.ALT, AN.AST, AN.CREAT];
const fixtureLibrary = async (code: Code, no = 2, status: 'draft' | 'approved' = 'draft'): Promise<string> => loadMapped(no, (await fixture(code)).analytes.map((a: any) => a.analyteId), status);

const WRITE_FNS = ['insertSummary', 'updateSummary', 'insertBinding', 'insertLibraryVersion', 'updateLibraryVersion', 'insertBlock', 'updateBlock', 'insertRule', 'updateRule'];
/** Row counts + full content of every table the preview could touch. */
const state = () => JSON.stringify({ snap: snapshot(), bindings: w.bindings, summaries: w.summaries });
const noWrites = (ctx: any, before: string): void => {
  expect(w.writes).toEqual([]);
  expect(callsOf(...WRITE_FNS)).toEqual([]);
  expect(state()).toBe(before);
  expect(ctx.tx.query).not.toHaveBeenCalled();                    // no advisory lock either: nothing is serialised, nothing is written
  expect(callsOf('getLiveSummaryByOrder', 'findSummaryByDeterminismKey', 'listSummariesByOrder', 'getSummary')).toEqual([]);   // independent of any stored summary
};
const views = (ctx: any) => ctx.audit.access.mock.calls.map((c: any[]) => c[0]);

beforeEach(() => { seed(); vi.clearAllMocks(); });

describe('C14-T16 AC-19.1 fixture preview', () => {
  for (const code of CODES) {
    it(`${code}: a preview row (status preview, no id) built from the fixture against the DRAFT library; nothing stored`, async () => {
      const id = await fixtureLibrary(code);
      const ctx = makeCtx(); const before = state();
      const row = await previewLibraryVersion(ctx, { libraryVersionId: id, fixtureCode: code });
      expect(row.status).toBe('preview');
      expect(row).not.toHaveProperty('id');
      expect(row).toMatchObject({ library_version_id: id, template_library_version: '2', formula_version: 'hs-1', language: 'en', built_at: '2026-11-12T00:00:00.000Z' });
      expect(row.content.builtAt).toBe('2026-11-12T00:00:00.000Z');
      expect(row.content.panels.length).toBeGreaterThan(0);
      expect(row.content.disclaimerText.length).toBeGreaterThan(0);
      expect(row.deranged_count).toBe(row.content.deranged.length);
      expect(row.critical_count).toBe(row.content.deranged.filter((d: any) => d.severity === 'critical').length);
      for (const k of ['unmapped_result_count', 'ignored_duplicate_count', 'panels_scored']) expect(typeof row[k]).toBe('number');
      noWrites(ctx, before);
      expect(w.summaries).toHaveLength(0); expect(w.bindings).toHaveLength(0);
    });
  }
  it('placeholders are filled from the fixture: deranged text names a fixture analyte and no {token} is left', async () => {
    const code: Code = 'synthetic_basic'; const f = await fixture(code);
    const row = await previewLibraryVersion(makeCtx(), { libraryVersionId: await fixtureLibrary(code), fixtureCode: code });
    expect(row.content.deranged.length).toBeGreaterThanOrEqual(1);
    const names = f.analytes.map((a: any) => a.printName ?? a.name);
    for (const d of row.content.deranged) {
      expect(JSON.stringify(d)).not.toMatch(/\{[a-z_]+\}/);
      expect(names.some((n: string) => String(d.text ?? d.analyteName ?? JSON.stringify(d)).includes(n))).toBe(true);
    }
    expect(JSON.stringify(row.content)).not.toMatch(/\{[a-z_]+\}/);
  });
  it('fixture bands: basic has deranged and no critical; all_in_range has none (all tiles in range); critical has a critical and the score band needs_attention', async () => {
    const run = async (code: Code, no: number) => previewLibraryVersion(makeCtx(), { libraryVersionId: await fixtureLibrary(code, no), fixtureCode: code });
    const basic = await run('synthetic_basic', 2); const calm = await run('synthetic_all_in_range', 3); const crit = await run('synthetic_critical', 4);
    expect(basic.deranged_count).toBeGreaterThanOrEqual(1); expect(basic.critical_count).toBe(0);
    expect(calm.deranged_count).toBe(0); expect(calm.content.panels.every((p: any) => p.status === 'in_range')).toBe(true);
    expect(crit.critical_count).toBeGreaterThanOrEqual(1); expect(crit.content.healthScore.band).toBe('needs_attention');
  });
  it('the fixture path touches no port at all (synthetic data only, no PHI path) and writes no access-log entry', async () => {
    const ctx = makeCtx();
    await previewLibraryVersion(ctx, { libraryVersionId: await fixtureLibrary('synthetic_basic'), fixtureCode: 'synthetic_basic' });
    expect(w.portCalls).toEqual([]);
    expect(callsOf('getOrderSummary', 'getOrderResults', 'getTest', 'getAnalyteHistory', 'assertRole')).toEqual([]);
    expect(ctx.audit.access).not.toHaveBeenCalled();
  });
  it('fixture preview does not need lab.result.read (a caller lacking it still previews fixtures)', async () => {
    const row = await previewLibraryVersion(makeCtx({ deny: ['lab.result.read'] }), { libraryVersionId: await fixtureLibrary('synthetic_basic'), fixtureCode: 'synthetic_basic' });
    expect(row.status).toBe('preview');
  });
  it('previews the NAMED version, whatever its status, not the approved one (draft, in_review, approved, retired)', async () => {
    const f = (await fixture('synthetic_basic')).analytes.map((a: any) => a.analyteId);
    loadMapped(1, f, 'approved');
    for (const [no, status] of [[2, 'draft'], [3, 'in_review'], [4, 'retired']] as const) {
      const id = loadMapped(no, f, status);
      const row = await previewLibraryVersion(makeCtx(), { libraryVersionId: id, fixtureCode: 'synthetic_basic' });
      expect(row).toMatchObject({ library_version_id: id, template_library_version: String(no) });
    }
    const row = await previewLibraryVersion(makeCtx(), { libraryVersionId: VER(1), fixtureCode: 'synthetic_basic' });   // approved v1 maps the fixture analytes (ruling): the NAMED approved version is previewed
    expect(row.library_version_id).toBe(VER(1));
    expect(row.template_library_version).toBe('1');
  });
  it('is deterministic and parallel-safe: 12 concurrent previews give identical content and still write nothing', async () => {
    const id = await fixtureLibrary('synthetic_critical'); const before = state();
    const rows = await Promise.all(Array.from({ length: 12 }, () => previewLibraryVersion(makeCtx(), { libraryVersionId: id, fixtureCode: 'synthetic_critical' })));
    for (const r of rows) expect(JSON.stringify(r.content)).toBe(JSON.stringify(rows[0]!.content));
    expect(w.writes).toEqual([]); expect(state()).toBe(before);
  });
});

describe('C14-T16 AC-19.2 order preview + lab.result.read', () => {
  const draft = (): string => loadMapped(2, orderAnalytes);
  it('without lab.result.read: auth.forbidden, the order results are never read, nothing logged as viewed, nothing written (AB-13)', async () => {
    const id = draft(); const ctx = makeCtx({ deny: ['lab.result.read'] }); const before = state();
    const e = await fails(previewLibraryVersion(ctx, { libraryVersionId: id, orderId: ORDER.a }));
    expect(e.code).toBe('auth.forbidden');
    expect(callsOf('getOrderResults', 'getTest', 'getAnalyteHistory')).toEqual([]);
    expect(views(ctx).filter((x: any) => x.outcome === 'allowed')).toEqual([]);
    expect(w.writes).toEqual([]); expect(state()).toBe(before);
  });
  it('with it: assertRole(lab.result.read, { centreId = the ORDER centre }) runs after getOrderSummary and before getOrderResults (scope approved)', async () => {
    const ctx = makeCtx();
    await previewLibraryVersion(ctx, { libraryVersionId: draft(), orderId: ORDER.a });
    expect(callsOf('getOrderSummary', 'assertRole', 'getOrderResults').map((c) => c.fn)).toEqual(['getOrderSummary', 'assertRole', 'getOrderResults']);
    expect(callsOf('assertRole')[0]!.args[0]).toEqual({ permission: 'lab.result.read', centreId: CENTRE.a });
    expect(portCallsOf('getOrderResults')[0]!.input).toMatchObject({ orderId: ORDER.a, scope: 'approved' });
  });
  it('with it: a preview row (status preview, no id, order_id) and exactly one access-log entry smart_summary.view / smart_summary_preview', async () => {
    const ctx = makeCtx(); const id = draft(); const before = state();
    const row = await previewLibraryVersion(ctx, { libraryVersionId: id, orderId: ORDER.a });
    expect(row.status).toBe('preview'); expect(row).not.toHaveProperty('id');
    expect(row).toMatchObject({ order_id: ORDER.a, library_version_id: id, deranged_count: 1, critical_count: 0, unmapped_result_count: 0 });
    expect(row.content.deranged[0]).toMatchObject({ analyteId: AN.HGB, direction: 'low', severity: 'out_of_range' });
    expect(views(ctx)).toHaveLength(1);
    expect(views(ctx)[0]).toMatchObject({ action: 'smart_summary.view', entityType: 'smart_summary_preview', outcome: 'allowed' });
    noWrites(ctx, before);
  });
  it('the access-log entry carries no PHI and the row never carries the registration number', async () => {
    const ctx = makeCtx();
    const row = await previewLibraryVersion(ctx, { libraryVersionId: draft(), orderId: ORDER.a });
    expect(JSON.stringify(views(ctx))).not.toContain(REG_NO);
    expect(JSON.stringify(row)).not.toContain(REG_NO);
    expect(JSON.stringify(views(ctx))).not.toMatch(/patient/i);
  });
  it('the access-log entry is written only after the results were read OK: a not-eligible order (2 mapped < min 3) throws no_eligible_results and writes nothing', async () => {
    const id = draft(); setResults(ORDER.a, [result(1, 'HGB', 'L'), result(2, 'WBC')]);
    const ctx = makeCtx(); const before = state();
    const e = await fails(previewLibraryVersion(ctx, { libraryVersionId: id, orderId: ORDER.a }));
    expect(e.code).toBe('smartreport.no_eligible_results');
    expect(views(ctx).filter((x: any) => x.outcome === 'allowed')).toEqual([]);
    expect(w.writes).toEqual([]); expect(state()).toBe(before);
  });
  it('reports unmapped_result_count (AC-08.4 staff preview): an unmapped text result is counted, not summarised', async () => {
    const id = draft(); setResults(ORDER.a, [...ac081(), result(7, 'TXT')]);
    const row = await previewLibraryVersion(makeCtx(), { libraryVersionId: id, orderId: ORDER.a });
    expect(row.unmapped_result_count).toBe(1);
    expect(row.content.deranged.every((d: any) => d.analyteId !== AN.TXT)).toBe(true);
  });
  it('order path writes nothing, takes no advisory lock, reads no stored summary — even when a live summary exists for the order', async () => {
    const id = draft();
    const { buildOrGet } = await import('../summary.service.js');
    approveLibrary(1); await buildOrGet(makeCtx(), { orderId: ORDER.a });           // a stored live summary + its library
    vi.clearAllMocks(); w.calls = []; w.writes = []; w.updates = [];
    const ctx = makeCtx(); const before = state();
    await previewLibraryVersion(ctx, { libraryVersionId: id, orderId: ORDER.a });
    noWrites(ctx, before);
    expect(w.summaries).toHaveLength(1); expect(w.summaries[0]!.status).toBe('draft'); expect(w.summaries[0]!.version).toBe(1);
  });
  it('history failure is not fatal: trends empty, the call ran in a savepoint, nothing written (P-44)', async () => {
    const id = draft(); enableTrend('HGB'); setResults(ORDER.a, ac081().map(withRange)); w.opts.history = 'internal';
    const ctx = makeCtx(); const before = state();
    const row = await previewLibraryVersion(ctx, { libraryVersionId: id, orderId: ORDER.a });
    expect(row.content.trends).toEqual([]);
    expect(portCallsOf('getAnalyteHistory')[0]!.inSavepoint).toBe(true);
    expect(w.markers).toEqual([]);
    noWrites(ctx, before);
  });
  it('an order of another tenant (or an unknown one) is common.not_found; nothing is read beyond the order summary, nothing logged', async () => {
    const id = draft(); const ctx = makeCtx();
    for (const orderId of [ORDER.b, uid(0xdead)]) {
      const e = await fails(previewLibraryVersion(ctx, { libraryVersionId: id, orderId }));
      expect(e.code).toBe('common.not_found');
    }
    expect(callsOf('getOrderResults', 'assertRole')).toEqual([]); expect(ctx.audit.access).not.toHaveBeenCalled(); expect(w.writes).toEqual([]);
  });
});

describe('C14-T16 input, tenant isolation, bad input', () => {
  it('exactly one of orderId / fixtureCode: neither, both, unknown fixture, malformed order id -> common.validation_failed, nothing read or logged', async () => {
    const id = loadMapped(2, orderAnalytes); const ctx = makeCtx();
    for (const input of [{}, { orderId: ORDER.a, fixtureCode: 'synthetic_basic' }, { fixtureCode: 'synthetic_everything' }, { fixtureCode: '' }, { orderId: 'not-a-uuid' }, { orderId: '' }, { fixtureCode: null }, { orderId: 7 }]) {
      const e = await fails(previewLibraryVersion(ctx, { libraryVersionId: id, ...input } as any));
      expect(e.code, JSON.stringify(input)).toBe('common.validation_failed');
    }
    expect(w.portCalls).toEqual([]); expect(callsOf('assertRole')).toEqual([]); expect(ctx.audit.access).not.toHaveBeenCalled(); expect(w.writes).toEqual([]);
  });
  it('unknown, malformed, or another tenant’s library version -> common.not_found (tenant comes from ctx, never input); no order read, no log', async () => {
    const id = loadMapped(2, orderAnalytes); const ctxB = makeCtx({ tenant: 'B' }); const ctxA = makeCtx();
    for (const [ctx, libraryVersionId] of [[ctxB, id], [ctxA, uid(0xbeef)], [ctxA, 'nope'], [ctxA, '']] as const) {
      const e = await fails(previewLibraryVersion(ctx, { libraryVersionId, orderId: ORDER.a } as any));
      expect(e.code).toBe('common.not_found');
    }
    const e = await fails(previewLibraryVersion(ctxB, { libraryVersionId: id, fixtureCode: 'synthetic_basic' }));
    expect(e.code).toBe('common.not_found');
    expect(w.portCalls).toEqual([]); expect(ctxA.audit.access).not.toHaveBeenCalled(); expect(ctxB.audit.access).not.toHaveBeenCalled(); expect(w.writes).toEqual([]);
  });
  it('a tenant-supplied tenant id in the input is ignored: the library and order are resolved for ctx.tenantId', async () => {
    const id = loadMapped(2, orderAnalytes);
    const e = await fails(previewLibraryVersion(makeCtx({ tenant: 'B' }), { libraryVersionId: id, orderId: ORDER.a, tenantId: TA } as any));
    expect(e.code).toBe('common.not_found');
    expect(lib.versions.filter((v) => v.tenant_id === TA)).toHaveLength(1);
  });
  it('every repository call carries ctx.tenantId', async () => {
    const id = loadMapped(2, orderAnalytes); await previewLibraryVersion(makeCtx(), { libraryVersionId: id, orderId: ORDER.a });
    for (const c of w.calls.filter((x) => x.tenantId !== undefined)) expect(c.tenantId).toBe(TA);
  });
});
