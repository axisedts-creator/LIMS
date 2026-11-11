// C14 T15 — #27 listSmartSummaries, #28 getSmartSummary, #29 getCurrentSmartSummary, #30 buildSmartSummary, #31 approveSmartSummary, #32 rejectSmartSummary + field allowlist + access log.
// ACs: AC-01.3, AC-14.1-AC-14.7, AC-21.1, AC-21.2. Spec: 06-PLAN T15; 02-TRD §5 (#27-#32), §5.1 (SmartSummaryView, reviews[], allowlist REQ-SEC-081); 03-APP-FLOW §1.2 S2-S4, §2.2, E5; 07-SECURITY T2, 062/067/081; 08 A22.1.
// Integration: REAL handlers + REAL summary.service/engine (summaries are built, not hand-made) over the repository emulators of ../../__tests__/t15.fakes.ts (seams pinned in its header).
// Responses are validated against contracts/openapi/smartreport.yaml (additionalProperties false => the field allowlist is enforced by the contract validator too).
// Fails now: handlers 27-32 are T01 stubs.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../repository/summaries.repo.js', async () => (await import('../../__tests__/t15.fakes.js')).summariesRepoFake);
vi.mock('../../repository/reviews.repo.js', async () => (await import('../../__tests__/t15.fakes.js')).reviewsRepoFake);
vi.mock('../../repository/codedSets.repo.js', async () => (await import('../../__tests__/t15.fakes.js')).codedSetsRepoFake);
vi.mock('../../repository/bindings.repo.js', async () => (await import('../../__tests__/t15.fakes.js')).bindingsRepoFake);
vi.mock('../../repository/library.repo.js', async () => (await import('../../__tests__/t15.fakes.js')).libraryRepoFake);
vi.mock('../../repository/blocks.repo.js', async () => (await import('../../__tests__/t15.fakes.js')).blocksRepoFake);
vi.mock('../../repository/rules.repo.js', async () => (await import('../../__tests__/t15.fakes.js')).rulesRepoFake);
vi.mock('../../repository/mappings.repo.js', async () => (await import('../../__tests__/t15.fakes.js')).mappingsRepoFake);
vi.mock('../../repository/groups.repo.js', async () => (await import('../../__tests__/t15.fakes.js')).groupsRepoFake);

import { toSmartSummary } from '../../mappers/port.mapper.js';
import { buildOrGet } from '../../summary.service.js';
import { declaredOperationIds, ifMatch, request, responseProblems } from '../../__tests__/t11.helpers.js';
import { makeCtx as sysCtx, run } from '../../__tests__/t12.fakes.js';
import {
  FD_CENTRE, HGB_RESULT, MID, ORDER, ORDER3, REGISTRATION, TA, TB, VER, amend, approveLibrary, inTx, makeCtx, portCallsOf, retireLibrary, reviewsRepoFake, rv, seedWorld, w,
  type Persona,
} from '../../__tests__/t15.fakes.js';
import { handlers } from '../index.js';

type Row = Record<string, any>;
const LIST = 'listSmartSummaries', GET = 'getSmartSummary', CURRENT = 'getCurrentSmartSummary', BUILD = 'buildSmartSummary', APPROVE = 'approveSmartSummary', REJECT = 'rejectSmartSummary';
const READ = 'smartreport.summary.read', APPROVE_PERM = 'smartreport.summary.approve';

function go(op: string, persona: Persona, req: ReturnType<typeof request>, tenant: 'A' | 'B' = 'A', o: { flag?: boolean; shared?: boolean } = {}) {
  const c = makeCtx(persona, op, tenant, o);
  const h = (handlers as Record<string, (r: unknown, x: unknown) => Promise<any>>)[op]!;
  return { ...c, run: () => inTx(c.ctx, () => h(req, c.ctx), { shared: o.shared === true }) };
}
const fails = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected the operation to be refused, but it answered'); };
const codeOf = (e: any): string | undefined => e?.code;
const rowOf = (id: string): Row => w.summaries.find((s) => s.id === id)!;
const mk = async (orderId: string = ORDER.a): Promise<Row> => { const c = sysCtx(); return (await run(c, () => buildOrGet(c, { orderId } as any))).summary; };
const reset = (): void => { w.writes.length = 0; w.calls.length = 0; w.updates.length = 0; w.portCalls.length = 0; vi.clearAllMocks(); };
const sumReq = (id: string, headers: object = {}, body: unknown = {}) => request({ params: { summary_id: id }, headers, body });
const approve = (id: string, persona: Persona = 'pathologist', hdr?: object, body: unknown = { attestation: true }, tenant: 'A' | 'B' = 'A') =>
  go(APPROVE, persona, sumReq(id, hdr ?? ifMatch(rowOf(id)?.version ?? 1), body), tenant);
const reject = (id: string, body: unknown, persona: Persona = 'pathologist', hdr?: object) => go(REJECT, persona, sumReq(id, hdr ?? ifMatch(rowOf(id)?.version ?? 1), body));
const view = (id: string, persona: Persona = 'pathologist', tenant: 'A' | 'B' = 'A') => go(GET, persona, sumReq(id), tenant);
const list = (query: object = {}, persona: Persona = 'pathologist', tenant: 'A' | 'B' = 'A') => go(LIST, persona, request({ query }), tenant);
const keysDeep = (x: unknown, out = new Set<string>()): Set<string> => { if (Array.isArray(x)) x.forEach((v) => keysDeep(v, out)); else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { out.add(k); keysDeep(v, out); } return out; };
const accessOf = (c: { access: Row[] }) => c.access.filter((a) => a.action === 'smart_summary.view');
const REFUSED = ['auth.forbidden', 'common.not_found'];
/** Three drafts with distinct built_at (oldest: a, then a2 (front_desk centre), then 3). */
async function threeDrafts(): Promise<[Row, Row, Row]> {
  const s = [await mk(ORDER.a), await mk(ORDER.a2), await mk(ORDER3)] as [Row, Row, Row];
  s.forEach((x, i) => { rowOf(x.id).built_at = `2026-11-1${i}T04:00:00.000Z`; });
  reset(); return s;
}
beforeEach(() => { seedWorld(); vi.clearAllMocks(); });

// ================================================================= #27
describe('C14-T15 #27 listSmartSummaries — AC-14.1', () => {
  it('AC-14.1: three drafts listed oldest first with status, centre, built time, deranged and critical counts; contract-valid; registration_no from FrontdeskPort', async () => {
    const [a, b, c] = await threeDrafts();
    const x = list(); const r = await x.run();
    expect(r.status).toBe(200);
    expect(responseProblems(LIST, r)).toEqual([]);
    expect(r.body.data.map((i: Row) => i.id)).toEqual([a.id, b.id, c.id]);
    expect(r.body.data[0]).toMatchObject({ order_id: ORDER.a, centre_id: rowOf(a.id).centre_id, status: 'draft', built_at: '2026-11-10T04:00:00.000Z', registration_no: REGISTRATION, version: 1 });
    expect(typeof r.body.data[0].deranged_count).toBe('number'); expect(typeof r.body.data[0].critical_count).toBe('number');
    expect(x.asserted.map((p) => p.permission)).toContain(READ);
    expect(w.writes).toEqual([]);
  });
  it('default status is draft; ?status=draft,approved,rejected,superseded widens; an approved summary is not in the default queue', async () => {
    const [a, b] = await threeDrafts();
    rowOf(b.id).status = 'approved';
    expect((await list().run()).body.data.map((i: Row) => i.id)).not.toContain(b.id);
    const all = (await list({ status: 'draft,approved' }).run()).body.data.map((i: Row) => i.id);
    expect(all).toContain(a.id); expect(all).toContain(b.id);
    expect((await list({ status: 'approved' }).run()).body.data.map((i: Row) => i.id)).toEqual([b.id]);
  });
  it('AC-14.1: a centre-scoped front_desk sees only their centre\'s rows', async () => {
    const [, b] = await threeDrafts();
    const r = await list({}, 'front_desk').run();
    expect(r.status).toBe(200);
    expect(r.body.data.map((i: Row) => i.id)).toEqual([b.id]);
    expect(r.body.data.every((i: Row) => i.centre_id === FD_CENTRE)).toBe(true);
  });
  it('centre_id filter, has_critical, built_at_from and sort=-built_at', async () => {
    const [a, b, c] = await threeDrafts();
    rowOf(c.id).critical_count = 2;
    expect((await list({ centre_id: FD_CENTRE }).run()).body.data.map((i: Row) => i.id)).toEqual([b.id]);
    expect((await list({ has_critical: 'true' }).run()).body.data.map((i: Row) => i.id)).toEqual([c.id]);
    expect((await list({ built_at_from: '2026-11-11T00:00:00.000Z' }).run()).body.data.map((i: Row) => i.id)).toEqual([b.id, c.id]);
    expect((await list({ sort: '-built_at' }).run()).body.data.map((i: Row) => i.id)).toEqual([c.id, b.id, a.id]);
  });
  it('paging: limit=2 gives two rows + page.next_cursor; the cursor gives the rest and no next_cursor; limit is echoed', async () => {
    const [a, b, c] = await threeDrafts();
    const p1 = await list({ limit: '2' }).run();
    expect(responseProblems(LIST, p1)).toEqual([]);
    expect(p1.body.data.map((i: Row) => i.id)).toEqual([a.id, b.id]);
    expect(p1.body.page).toMatchObject({ limit: 2, next_cursor: expect.any(String) });
    const p2 = await list({ limit: '2', cursor: p1.body.page.next_cursor }).run();
    expect(p2.body.data.map((i: Row) => i.id)).toEqual([c.id]);
    expect(p2.body.page.next_cursor).toBeUndefined();
  });
  it('probes: bad status / limit / centre_id / sort / dates -> common.validation_failed; garbage cursor -> common.invalid_cursor; nothing read', async () => {
    await threeDrafts();
    for (const q of [{ status: 'bogus' }, { status: 'draft,bogus' }, { status: "draft'; DROP TABLE smartreport.summaries;--" }, { status: 'draft,approved,rejected,superseded,draft' }, { limit: '0' }, { limit: '201' }, { limit: 'abc' },
      { centre_id: 'not-a-uuid' }, { sort: 'built_at;x' }, { built_at_from: 'yesterday' }, { has_critical: 'maybe' }]) {
      const x = list(q); expect(codeOf(await fails(x.run())), JSON.stringify(q)).toBe('common.validation_failed');
      expect(w.calls.filter((c) => c.fn === 'listReviewQueue'), JSON.stringify(q)).toEqual([]);
    }
    expect(codeOf(await fails(list({ cursor: '%%%not-a-cursor' }).run()))).toBe('common.invalid_cursor');
  });
  it('auth: lab_technologist / lab_manager / revoked pathologist -> auth.forbidden before any repository read; tenant B sees nothing of tenant A', async () => {
    await threeDrafts();
    for (const p of ['lab_technologist', 'lab_manager', 'revoked_pathologist'] as Persona[]) { expect(codeOf(await fails(list({}, p).run())), p).toBe('auth.forbidden'); }
    expect(w.calls).toEqual([]);
    const r = await list({ status: 'draft,approved,rejected,superseded' }, 'pathologist', 'B').run();
    expect(r.body.data).toEqual([]);
    expect(w.calls.filter((c) => c.tenantId !== undefined && c.tenantId !== TB)).toEqual([]);
  });
});

// ================================================================= #28 / #29
describe('C14-T15 #28 getSmartSummary / #29 getCurrentSmartSummary — view, field allowlist (REQ-SEC-081), access log (AC-21.2)', () => {
  it('pathologist (summary.read + approve): 200, contract-valid, review_inputs present with the approved results; registration_no shown but never stored', async () => {
    const s = await mk(); reset();
    const x = view(s.id); const r = await x.run();
    expect(r.status).toBe(200);
    expect(responseProblems(GET, r)).toEqual([]);
    expect(r.body).toMatchObject({ id: s.id, order_id: ORDER.a, centre_id: s.centre_id, status: 'draft', registration_no: REGISTRATION, reviews: [], version: 1, library_version_id: VER(1) });
    expect(r.body.review_inputs).toEqual(expect.arrayContaining([expect.objectContaining({ result_id: HGB_RESULT.a, analyte_name: 'Hemoglobin', flag: 'L', unit_code: 'g_dL' })]));
    expect(x.asserted.map((p) => p.permission)).toContain(READ);
    expect(JSON.stringify(w.summaries)).not.toContain(REGISTRATION);
    expect(w.writes).toEqual([]);
  });
  it('front_desk (summary.read only, own centre): 200 without review_inputs and without any llm_text; contract-valid; same registration_no', async () => {
    const s = await mk(ORDER.a2); rowOf(s.id).llm_overlay = { run_id: uid1(), items: { 'deranged:0': 'LLM WORDING MUST NOT LEAK' } }; reset();
    const r = await view(s.id, 'front_desk').run();
    expect(r.status).toBe(200);
    expect(responseProblems(GET, r)).toEqual([]);
    expect('review_inputs' in r.body).toBe(false);
    expect(keysDeep(r.body).has('llm_text')).toBe(false);
    expect(JSON.stringify(r.body)).not.toContain('LLM WORDING MUST NOT LEAK');
    expect(r.body.registration_no).toBe(REGISTRATION);
  });
  it('the response never carries internal columns (tenant/patient ids, hashes, llm overlay, audit columns)', async () => {
    const s = await mk(); reset();
    const k = keysDeep((await view(s.id).run()).body);
    for (const bad of ['tenant_id', 'patient_id', 'content', 'content_sha256', 'approved_set_hash', 'input_result_versions', 'llm_overlay', 'created_by', 'updated_by', 'unmapped_result_count', 'ignored_duplicate_count', 'built_by']) expect(k.has(bad), bad).toBe(false);
  });
  it('AC-21.2: a view writes ONE ctx.audit.access { action smart_summary.view, entityType smart_summary, entityId, outcome allowed }; #29 does the same with the summary id', async () => {
    const s = await mk(); reset();
    const a = view(s.id); await a.run();
    expect(accessOf(a)).toEqual([expect.objectContaining({ action: 'smart_summary.view', entityType: 'smart_summary', entityId: s.id, outcome: 'allowed' })]);
    const b = go(CURRENT, 'pathologist', request({ params: { order_id: ORDER.a } })); const r = await b.run();
    expect(r.body.id).toBe(s.id);
    expect(accessOf(b)).toEqual([expect.objectContaining({ action: 'smart_summary.view', entityType: 'smart_summary', entityId: s.id, outcome: 'allowed' })]);
    expect(responseProblems(CURRENT, r)).toEqual([]);
  });
  it('a refused view (no permission / other centre / other tenant / unknown id) returns no body and records no "allowed" view', async () => {
    const s = await mk(ORDER.a); reset();                                             // centre CENTRE.a: not the front_desk centre
    for (const [persona, tenant] of [['front_desk', 'A'], ['lab_technologist', 'A'], ['pathologist', 'B']] as const) {
      const x = view(s.id, persona, tenant);
      expect(REFUSED, `${persona}/${tenant}`).toContain(codeOf(await fails(x.run())));
      expect(accessOf(x).filter((a) => a.outcome === 'allowed')).toEqual([]);
    }
    expect(w.calls.filter((c) => c.tenantId !== undefined && c.tenantId !== TA && c.tenantId !== TB)).toEqual([]);
    for (const id of ['01900000-7200-7000-8000-0000000fffff', 'not-a-uuid', `${s.id},${s.id}`]) expect(['common.not_found', 'common.validation_failed'], id).toContain(codeOf(await fails(view(id).run())));
  });
  it('#29: an order without a live summary -> common.not_found (a superseded-only order too); front_desk of another centre -> refused', async () => {
    expect(codeOf(await fails(go(CURRENT, 'pathologist', request({ params: { order_id: ORDER.a } })).run()))).toBe('common.not_found');
    const s = await mk();
    rowOf(s.id).status = 'superseded'; rowOf(s.id).superseded_at = '2026-11-12T00:00:00.000Z'; rowOf(s.id).superseded_reason = 'results_changed';
    expect(codeOf(await fails(go(CURRENT, 'pathologist', request({ params: { order_id: ORDER.a } })).run()))).toBe('common.not_found');
    await mk(ORDER3);
    expect(REFUSED).toContain(codeOf(await fails(go(CURRENT, 'front_desk', request({ params: { order_id: ORDER3 } })).run())));
  });
  it('AC-14.7: reviews[] oldest first — approved (with approver name) then superseded (system, no actor) — only action/actor_display_name/reason_code/at, names batched in one memberships.list call', async () => {
    const s = await mk();
    await approve(s.id).run();
    amend(ORDER.a, HGB_RESULT.a);
    const c = sysCtx(); const next = (await run(c, () => buildOrGet(c, { orderId: ORDER.a } as any))).summary;     // supersedes the approved row (results_changed)
    await reviewsRepoFake.insertSummaryReview({ tenantId: TA, actorId: 'sys' }, { id: uid2(), centre_id: s.centre_id, summary_id: s.id, action: 'superseded' });   // the system supersede history row
    reset();
    const x = view(s.id); const r = await x.run();
    expect(responseProblems(GET, r)).toEqual([]);
    expect(r.body).toMatchObject({ status: 'superseded', superseded_reason: 'results_changed', superseded_by_summary_id: next.id });
    expect(r.body.reviews).toHaveLength(2);
    expect(r.body.reviews[0]).toEqual({ action: 'approved', actor_display_name: 'Test A-pathologist', at: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/) });
    expect(r.body.reviews[1]).toEqual({ action: 'superseded', at: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/) });
    expect(r.body.reviews[0].at <= r.body.reviews[1].at).toBe(true);
    expect(x.ctx.core.memberships.list.mock.calls.length).toBeLessThanOrEqual(1);
  });
  it('AC-14.7: a rejected summary\'s history item carries its reason_code but never the free-text comment (the view keeps reject_comment as a field of its own)', async () => {
    const s = await mk(); const rj = await reject(s.id, { reason_code: 'wording_problem', comment: 'PRIVATE-COMMENT-TEXT' }).run();
    expect(rj.status).toBe(200);
    const r = await view(s.id).run();
    expect(r.body.reviews).toEqual([{ action: 'rejected', actor_display_name: 'Test A-pathologist', reason_code: 'wording_problem', at: expect.any(String) }]);
    expect(JSON.stringify(r.body.reviews)).not.toContain('PRIVATE-COMMENT-TEXT');
    expect(r.body).toMatchObject({ status: 'rejected', reject_reason_code: 'wording_problem', reject_comment: 'PRIVATE-COMMENT-TEXT', rejected_by_display_name: 'Test A-pathologist' });
  });
});

// ================================================================= #30
describe('C14-T15 #30 buildSmartSummary — AC-01.3', () => {
  const build = (persona: Persona = 'pathologist', body: unknown = { mode: 'current' }, orderId = ORDER.a, tenant: 'A' | 'B' = 'A', o: { flag?: boolean } = {}) =>
    go(BUILD, persona, request({ params: { order_id: orderId }, headers: { 'idempotency-key': 'k-0001' }, body }), tenant, o);
  it('AC-01.3: flag false -> 403 smartreport.feature_disabled for a permitted pathologist; nothing built', async () => {
    expect(codeOf(await fails(build('pathologist', { mode: 'current' }, ORDER.a, 'A', { flag: false }).run()))).toBe('smartreport.feature_disabled');
    expect(w.summaries).toEqual([]); expect(w.writes).toEqual([]);
  });
  it('first call -> 201 draft SmartSummaryView (contract-valid, with review_inputs for the approver); same hash again -> 200 and the same id; one row', async () => {
    const x = build(); const r = await x.run();
    expect(r.status).toBe(201);
    expect(responseProblems(BUILD, r)).toEqual([]);
    expect(r.body).toMatchObject({ status: 'draft', order_id: ORDER.a, registration_no: REGISTRATION, reviews: [] });
    expect(Array.isArray(r.body.review_inputs)).toBe(true);
    expect(x.asserted.map((p) => p.permission)).toContain(APPROVE_PERM);
    const again = await build().run();
    expect(again.status).toBe(200); expect(again.body.id).toBe(r.body.id);
    expect(w.summaries).toHaveLength(1);
  });
  it('auth: front_desk / lab_manager -> auth.forbidden, aal1 pathologist -> auth.mfa_required (before the feature flag answer and any build)', async () => {
    expect(codeOf(await fails(build('front_desk', { mode: 'current' }, ORDER.a, 'A', { flag: false }).run()))).toBe('auth.forbidden');
    expect(codeOf(await fails(build('lab_manager').run()))).toBe('auth.forbidden');
    expect(codeOf(await fails(build('pathologist_aal1').run()))).toBe('auth.mfa_required');
    expect(w.summaries).toEqual([]);
  });
  it('body: mode other than current|rebuild_with_active_library (prebuild), missing mode, extra key -> common.validation_failed; nothing built', async () => {
    for (const b of [{ mode: 'prebuild' }, {}, { mode: 'current', order_id: ORDER.a2 }, { mode: 7 }]) expect(codeOf(await fails(build('pathologist', b).run())), JSON.stringify(b)).toBe('common.validation_failed');
    expect(w.summaries).toEqual([]);
  });
  it('another tenant\'s order -> common.not_found; an order without approved results -> smartreport.no_eligible_results; no approved library -> smartreport.template_not_approved', async () => {
    expect(codeOf(await fails(build('pathologist', { mode: 'current' }, ORDER.a, 'B').run()))).toBe('common.not_found');
    w.results.set(ORDER.a, []);
    expect(codeOf(await fails(build().run()))).toBe('smartreport.no_eligible_results');
    seedWorld(); retireLibrary(1);
    expect(codeOf(await fails(build().run()))).toBe('smartreport.template_not_approved');
    expect(w.summaries).toEqual([]);
  });
  it('rebuild_with_active_library: live summary on library v1, active v2 -> 201, old superseded (library_rebuild)', async () => {
    const old = await mk(); retireLibrary(1); approveLibrary(2); reset();
    const r = await build('pathologist', { mode: 'rebuild_with_active_library' }).run();
    expect(r.status).toBe(201);
    expect(r.body.library_version_id).toBe(VER(2)); expect(r.body.id).not.toBe(old.id);
    expect(rowOf(old.id)).toMatchObject({ status: 'superseded', superseded_reason: 'library_rebuild', superseded_by_summary_id: r.body.id });
  });
});

// ================================================================= #31
describe('C14-T15 #31 approveSmartSummary — AC-14.2, AC-14.3, AC-14.5, AC-21.1; S2/S3', () => {
  it('AC-14.2: draft with a current set + attestation + current If-Match -> 200 approved; approver/time recorded; ONE summary_reviews row; content and hashes untouched; contract-valid', async () => {
    const s = await mk(); const before = structuredClone(rowOf(s.id)); reset();
    const x = approve(s.id); const r = await x.run();
    expect(r.status).toBe(200);
    expect(responseProblems(APPROVE, r)).toEqual([]);
    expect(r.body).toMatchObject({ id: s.id, status: 'approved', approved_by_membership_id: MID.A.pathologist, approved_by_display_name: 'Test A-pathologist', version: before.version + 1 });
    expect(r.body.approved_at).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    expect(r.body.reviews).toEqual([{ action: 'approved', actor_display_name: 'Test A-pathologist', at: expect.any(String) }]);
    const after = rowOf(s.id);
    expect(after).toMatchObject({ status: 'approved', approved_by_membership_id: MID.A.pathologist, use_llm_text: false, version: before.version + 1 });
    expect(after.approved_at).toBeTruthy();
    expect(after.content).toEqual(before.content); expect(after.content_sha256).toBe(before.content_sha256); expect(after.approved_set_hash).toBe(before.approved_set_hash);
    expect(rv.rows).toEqual([expect.objectContaining({ summary_id: s.id, centre_id: s.centre_id, action: 'approved', actor_membership_id: MID.A.pathologist, tenant_id: TA })]);   // AC-21.1
    expect(x.asserted.map((p) => p.permission)).toContain(APPROVE_PERM);
  });
  it('AC-14.2: afterwards buildOrGet (the port path) returns the approved row and the port DTO says approved with approvedAt + approver', async () => {
    const s = await mk(); await approve(s.id).run();
    const again = await mk();
    expect(again.id).toBe(s.id); expect(again.status).toBe('approved');
    const dto = toSmartSummary(again, 1);
    expect(dto).toMatchObject({ status: 'approved', approvedByMembershipId: MID.A.pathologist });
    expect(typeof dto.approvedAt).toBe('string');
  });
  it('re-check under the advisory lock (TRD §4.10, E5): the lock (tenant + order) is taken BEFORE LabPort.getOrderResults(scope approved) is read', async () => {
    const s = await mk(); reset();
    await approve(s.id).run();
    const lock = w.calls.findIndex((c) => c.fn === 'lock'); const lab = w.calls.findIndex((c) => c.fn === 'getOrderResults');
    expect(lock).toBeGreaterThanOrEqual(0); expect(lab).toBeGreaterThan(lock);
    expect(w.calls[lock]!.args[0]).toMatch(/pg_advisory_xact_lock\(hashtextextended\(/);
    expect(JSON.stringify(w.calls[lock]!.args)).toContain(TA); expect(JSON.stringify(w.calls[lock]!.args)).toContain(ORDER.a);
    expect(w.calls[lab]!.args).toEqual([ORDER.a, 'approved']);
  });
  it('AC-14.3: an amendment changed the approved set -> 409 smartreport.summary_superseded AND the supersede commits (commitOnError): row superseded/results_changed, not approved, no approval review row', async () => {
    const s = await mk(); amend(ORDER.a, HGB_RESULT.a); reset();
    const x = approve(s.id);
    expect(codeOf(await fails(x.run()))).toBe('smartreport.summary_superseded');
    expect(x.ctx.commitOnError).toHaveBeenCalled();
    expect(rowOf(s.id)).toMatchObject({ status: 'superseded', superseded_reason: 'results_changed', approved_by_membership_id: null, approved_at: null });
    expect(rowOf(s.id).superseded_at).toBeTruthy();
    expect(rv.rows.filter((r) => r.action === 'approved')).toEqual([]);
    expect(w.summaries.filter((q) => q.order_id === ORDER.a && q.status !== 'superseded')).toEqual([]);   // no approved summary is left for the order
  });
  it('E5: the consumer superseded it first -> approve is refused (summary_superseded | summary_invalid_transition) and nothing changes', async () => {
    const s = await mk(); amend(ORDER.a, HGB_RESULT.a);
    const c = sysCtx(); await run(c, () => buildOrGet(c, { orderId: ORDER.a } as any)); reset();
    const before = structuredClone(rowOf(s.id));
    expect(['smartreport.summary_superseded', 'smartreport.summary_invalid_transition']).toContain(codeOf(await fails(approve(s.id).run())));
    expect(rowOf(s.id)).toEqual(before); expect(w.writes).toEqual([]);
  });
  it('AC-14.5: approve again -> 409 summary_invalid_transition; reject after approve -> 409; approve after reject -> 409; nothing written, no second review row', async () => {
    const a = await mk(ORDER.a); const b = await mk(ORDER.a2);
    await approve(a.id).run(); await reject(b.id, { reason_code: 'library_error' }).run(); reset();
    const rows = rv.rows.length;
    expect(codeOf(await fails(approve(a.id).run()))).toBe('smartreport.summary_invalid_transition');
    expect(codeOf(await fails(reject(a.id, { reason_code: 'wording_problem' }).run()))).toBe('smartreport.summary_invalid_transition');
    expect(codeOf(await fails(approve(b.id).run()))).toBe('smartreport.summary_invalid_transition');
    expect(w.writes).toEqual([]); expect(rv.rows).toHaveLength(rows);
    expect(rowOf(a.id).status).toBe('approved'); expect(rowOf(b.id).status).toBe('rejected');
  });
  it('If-Match: missing -> common.precondition_required; stale -> common.version_conflict; both write nothing', async () => {
    const s = await mk(); reset();
    expect(codeOf(await fails(go(APPROVE, 'pathologist', sumReq(s.id, {}, { attestation: true })).run()))).toBe('common.precondition_required');
    expect(codeOf(await fails(approve(s.id, 'pathologist', ifMatch(s.version + 5)).run()))).toBe('common.version_conflict');
    expect(w.writes).toEqual([]); expect(rowOf(s.id).status).toBe('draft');
  });
  it('body: attestation false / missing / "true" / extra keys (status, approved_by_membership_id, summary_ids) / use_llm_text not boolean -> common.validation_failed; still a draft', async () => {
    const s = await mk(); reset();
    for (const b of [{ attestation: false }, {}, { attestation: 'true' }, { attestation: true, status: 'approved' }, { attestation: true, approved_by_membership_id: MID.A.lab_manager },
      { attestation: true, summary_ids: [s.id] }, { attestation: true, use_llm_text: 'yes' }]) {
      expect(codeOf(await fails(approve(s.id, 'pathologist', undefined, b).run())), JSON.stringify(b)).toBe('common.validation_failed');
    }
    expect(w.writes).toEqual([]); expect(rowOf(s.id).status).toBe('draft');
  });
  it('auth (062/067): front_desk / lab_manager / lab_technologist -> auth.forbidden; aal1 pathologist -> auth.mfa_required; revoked pathologist -> forbidden; nothing written, no results read', async () => {
    const s = await mk(ORDER.a2); reset();
    for (const [p, code] of [['front_desk', 'auth.forbidden'], ['lab_manager', 'auth.forbidden'], ['lab_technologist', 'auth.forbidden'], ['pathologist_aal1', 'auth.mfa_required'], ['revoked_pathologist', 'auth.forbidden']] as const) {
      expect(codeOf(await fails(approve(s.id, p).run())), p).toBe(code);
    }
    expect(w.writes).toEqual([]); expect(portCallsOf('getOrderResults')).toEqual([]); expect(rowOf(s.id).status).toBe('draft');
  });
  it('tenant isolation: tenant B\'s pathologist cannot approve tenant A\'s summary -> common.not_found; unknown id -> common.not_found; comma-separated ids are not a bulk approval', async () => {
    const a = await mk(ORDER.a); const b = await mk(ORDER.a2); reset();
    expect(codeOf(await fails(approve(a.id, 'pathologist', ifMatch(a.version), { attestation: true }, 'B').run()))).toBe('common.not_found');
    expect(['common.not_found', 'common.validation_failed']).toContain(codeOf(await fails(approve(`${a.id},${b.id}`, 'pathologist', ifMatch(1)).run())));
    expect(w.writes).toEqual([]); expect(rowOf(a.id).status).toBe('draft'); expect(rowOf(b.id).status).toBe('draft');
  });
  it('AC-14.6: no bulk approval — one approve operation, no bulk/batch operation in the contract or the handler map, and approving one summary leaves the others drafts', async () => {
    const ids = declaredOperationIds();
    expect(ids.filter((i) => /approve/i.test(i)).sort()).toEqual(['approveSmartLibraryVersion', 'approveSmartSummary']);
    expect(ids.filter((i) => /bulk|batch|many|all/i.test(i))).toEqual([]);
    expect(Object.keys(handlers).filter((i) => /bulk|batch|many/i.test(i))).toEqual([]);
    const [a, b, c] = await threeDrafts();
    await approve(a.id).run();
    expect([b.id, c.id].map((id) => rowOf(id).status)).toEqual(['draft', 'draft']);
  });
  it('concurrency: two simultaneous approvals of one version -> exactly one succeeds (the other version_conflict | summary_invalid_transition); the row is approved exactly once (version +1)', async () => {
    const s = await mk(); reset();   // ponytail: the emulator has no per-request rollback here, so the loser's review row is not asserted (the real tx rolls it back)
    const out = await Promise.allSettled([0, 1].map(() => go(APPROVE, 'pathologist', sumReq(s.id, ifMatch(s.version), { attestation: true }), 'A', { shared: true }).run()));
    expect(out.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const lost = out.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(['common.version_conflict', 'smartreport.summary_invalid_transition']).toContain(codeOf(lost.reason));
    expect(rowOf(s.id)).toMatchObject({ status: 'approved', version: s.version + 1 });
  });
  it('failure of a dependency: LabPort down while re-checking -> the error propagates, the summary stays a draft, nothing is approved', async () => {
    const s = await mk(); reset();
    w.orders = w.orders.filter((o) => o.orderId !== ORDER.a);                         // LabPort now answers common.not_found for the order
    expect(codeOf(await fails(approve(s.id).run()))).toBe('common.not_found');          // port errors propagate with their own code (P-23)
    expect(rowOf(s.id).status).not.toBe('approved'); expect(rv.rows.filter((r) => r.action === 'approved')).toEqual([]);
  });
});

// ================================================================= #32
describe('C14-T15 #32 rejectSmartSummary — AC-14.4, AC-14.5, AC-21.1; S4', () => {
  it('AC-14.4: wording_problem -> status rejected; rejecter/time/reason/comment stored; ONE summary_reviews row (reason_code, comment, actor); contract-valid; port shows draft', async () => {
    const s = await mk(); const before = structuredClone(rowOf(s.id)); reset();
    const x = reject(s.id, { reason_code: 'wording_problem', comment: 'Synthetic wording comment' }); const r = await x.run();
    expect(r.status).toBe(200);
    expect(responseProblems(REJECT, r)).toEqual([]);
    expect(r.body).toMatchObject({ status: 'rejected', reject_reason_code: 'wording_problem', reject_comment: 'Synthetic wording comment', rejected_by_display_name: 'Test A-pathologist', version: before.version + 1 });
    expect(r.body.reviews).toEqual([{ action: 'rejected', actor_display_name: 'Test A-pathologist', reason_code: 'wording_problem', at: expect.any(String) }]);
    expect(rowOf(s.id)).toMatchObject({ status: 'rejected', rejected_by_membership_id: MID.A.pathologist, reject_reason_code: 'wording_problem', reject_comment: 'Synthetic wording comment' });
    expect(rowOf(s.id).rejected_at).toBeTruthy();
    expect(rowOf(s.id).content).toEqual(before.content);
    expect(rv.rows).toEqual([expect.objectContaining({ summary_id: s.id, action: 'rejected', reason_code: 'wording_problem', comment: 'Synthetic wording comment', actor_membership_id: MID.A.pathologist, centre_id: s.centre_id })]);   // AC-21.1
    expect(x.asserted.map((p) => p.permission)).toContain(APPROVE_PERM);
    const again = await mk(); expect(again.status).toBe('rejected');
    const dto = toSmartSummary(again, 1);
    expect(dto.status).toBe('draft'); expect('approvedAt' in dto).toBe(false); expect(JSON.stringify(dto)).not.toContain('Synthetic wording comment');   // CR-C14-006
  });
  it('reason codes: omitted comment is fine for a coded reason; "other" needs a comment; unknown / malformed reason, comment > 500, extra keys -> common.validation_failed (with the field path)', async () => {
    const s = await mk(); reset();
    for (const [b, path] of [[{}, '/reason_code'], [{ reason_code: 'made_up' }, '/reason_code'], [{ reason_code: 'Bad-Code' }, '/reason_code'], [{ reason_code: 'other' }, '/comment'],
      [{ reason_code: 'other', comment: '' }, '/comment'], [{ reason_code: 'wording_problem', comment: 'x'.repeat(501) }, '/comment'], [{ reason_code: 'wording_problem', status: 'rejected' }, undefined]] as const) {
      const e = await fails(reject(s.id, b).run());
      expect(codeOf(e), JSON.stringify(b)).toBe('common.validation_failed');
      if (path) expect((e.errors ?? []).map((x: any) => x.path), JSON.stringify(b)).toContain(path);
    }
    expect(w.writes).toEqual([]); expect(rowOf(s.id).status).toBe('draft');
    expect((await reject(s.id, { reason_code: 'other', comment: 'Synthetic other reason' }).run()).status).toBe(200);
  });
  it('If-Match: missing -> common.precondition_required; stale -> common.version_conflict; nothing written', async () => {
    const s = await mk(); reset();
    expect(codeOf(await fails(go(REJECT, 'pathologist', sumReq(s.id, {}, { reason_code: 'library_error' })).run()))).toBe('common.precondition_required');
    expect(codeOf(await fails(reject(s.id, { reason_code: 'library_error' }, 'pathologist', ifMatch(s.version + 3)).run()))).toBe('common.version_conflict');
    expect(w.writes).toEqual([]);
  });
  it('AC-14.5: reject twice -> 409 summary_invalid_transition; a superseded summary cannot be rejected', async () => {
    const a = await mk(ORDER.a); const b = await mk(ORDER.a2);
    await reject(a.id, { reason_code: 'library_error' }).run();
    rowOf(b.id).status = 'superseded'; rowOf(b.id).superseded_at = '2026-11-12T00:00:00.000Z'; rowOf(b.id).superseded_reason = 'results_changed'; reset();
    expect(codeOf(await fails(reject(a.id, { reason_code: 'library_error' }).run()))).toBe('smartreport.summary_invalid_transition');
    expect(['smartreport.summary_invalid_transition', 'smartreport.summary_superseded']).toContain(codeOf(await fails(reject(b.id, { reason_code: 'library_error' }).run())));
    expect(w.writes).toEqual([]);
  });
  it('auth: front_desk / lab_manager -> auth.forbidden; aal1 pathologist -> auth.mfa_required; tenant B -> common.not_found; nothing written', async () => {
    const s = await mk(ORDER.a2); reset();
    expect(codeOf(await fails(reject(s.id, { reason_code: 'library_error' }, 'front_desk').run()))).toBe('auth.forbidden');
    expect(codeOf(await fails(reject(s.id, { reason_code: 'library_error' }, 'lab_manager').run()))).toBe('auth.forbidden');
    expect(codeOf(await fails(reject(s.id, { reason_code: 'library_error' }, 'pathologist_aal1').run()))).toBe('auth.mfa_required');
    expect(codeOf(await fails(go(REJECT, 'pathologist', sumReq(s.id, ifMatch(s.version), { reason_code: 'library_error' }), 'B').run()))).toBe('common.not_found');
    expect(w.writes).toEqual([]); expect(rowOf(s.id).status).toBe('draft');
  });
});

// ================================================================= probes: logs
describe('C14-T15 probes — no block text, values, patient data or registration numbers in logs (AC-21.3 style) and no summary content in the access log', () => {
  it('view + approve + reject + refused calls: log/metric calls and access-log entries contain neither the registration number nor result values nor template text', async () => {
    const s = await mk(); const t = await mk(ORDER.a2); reset();
    const calls = [view(s.id), approve(s.id), reject(t.id, { reason_code: 'wording_problem', comment: 'free text' }), view(s.id, 'front_desk')];
    const out: (number | string)[] = [];
    for (const c of calls) { try { out.push((await c.run()).status); } catch (e) { out.push(codeOf(e) ?? 'error'); } }
    expect(out.slice(0, 3)).toEqual([200, 200, 200]);                                  // the scan only means something when the operations really ran
    expect(REFUSED).toContain(out[3]);
    const text = JSON.stringify(calls.map((c) => [c.ctx.log.info.mock.calls, c.ctx.log.warn.mock.calls, c.ctx.log.error.mock.calls, c.ctx.metrics.inc.mock.calls, c.access]));
    for (const secret of [REGISTRATION, '13.40', 'Hemoglobin', 'free text', 'not a diagnosis']) expect(text, secret).not.toContain(secret);
  });
});

const uid1 = (): string => '01900000-7200-7000-8000-0000000b0001';
const uid2 = (): string => '01900000-7200-7000-8000-0000000b0002';
