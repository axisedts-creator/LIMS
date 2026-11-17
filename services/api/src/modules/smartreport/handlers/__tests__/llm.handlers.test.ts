// C14 T28 — #33 requestSmartLlmRephrase and #34 listSmartLlmRuns (02-TRD §5 #33/#34; 03-APP-FLOW §2.9 step 1; PRD AC-20.1 (no network in the request path), AC-20.2 (run rows readable)).
// Integration: REAL handlers over the T15 emulators + llm_runs emulator (seams: ../../__tests__/t28.fakes.ts header). Responses validated against contracts/openapi/smartreport.yaml.
// Fails now: handlers 33/34 are T01 stubs (501 / common.internal).
import http from 'node:http';
import https from 'node:https';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../repository/summaries.repo.js', async () => (await import('../../__tests__/t15.fakes.js')).summariesRepoFake);
vi.mock('../../repository/reviews.repo.js', async () => (await import('../../__tests__/t15.fakes.js')).reviewsRepoFake);
vi.mock('../../repository/codedSets.repo.js', async () => (await import('../../__tests__/t15.fakes.js')).codedSetsRepoFake);
vi.mock('../../repository/bindings.repo.js', async () => (await import('../../__tests__/t15.fakes.js')).bindingsRepoFake);
vi.mock('../../repository/library.repo.js', async () => (await import('../../__tests__/t15.fakes.js')).libraryRepoFake);
vi.mock('../../repository/blocks.repo.js', async () => (await import('../../__tests__/t15.fakes.js')).blocksRepoFake);
vi.mock('../../repository/rules.repo.js', async () => (await import('../../__tests__/t15.fakes.js')).rulesRepoFake);
vi.mock('../../repository/mappings.repo.js', async () => (await import('../../__tests__/t15.fakes.js')).mappingsRepoFake);
vi.mock('../../repository/groups.repo.js', async () => (await import('../../__tests__/t15.fakes.js')).groupsRepoFake);
vi.mock('../../repository/llmRuns.repo.js', async () => (await import('../../__tests__/t28.fakes.js')).llmRunsRepoFake);

import { buildOrGet } from '../../summary.service.js';
import { ifMatch, request, responseProblems } from '../../__tests__/t11.helpers.js';
import { makeCtx as sysCtx, run as inSysTx } from '../../__tests__/t12.fakes.js';
import { MID, ORDER, TA, TB, inTx, makeCtx, reviewsRepoFake, runs, rv, seedWorld, uid, w, type Persona } from '../../__tests__/t28.fakes.js';
import { handlers } from '../index.js';

type Row = Record<string, any>;
const REQUEST = 'requestSmartLlmRephrase', LIST = 'listSmartLlmRuns';
const APPROVE_PERM = 'smartreport.summary.approve';

function go(op: string, persona: Persona, req: ReturnType<typeof request>, tenant: 'A' | 'B' = 'A', o: { flags?: Record<string, unknown> } = {}) {
  const c = makeCtx(persona, op, tenant, o);
  const h = (handlers as Record<string, (r: unknown, x: unknown) => Promise<any>>)[op]!;
  return { ...c, run: () => inTx(c.ctx, () => h(req, c.ctx)) };
}
const fails = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected the operation to be refused, but it answered'); };
const rowOf = (id: string): Row => w.summaries.find((s) => s.id === id)!;
const mk = async (orderId: string = ORDER.a): Promise<Row> => { const c = sysCtx(); return (await inSysTx(c, () => buildOrGet(c, { orderId } as any))).summary; };
const sumReq = (id: string, headers: object = {}, body: unknown = {}) => request({ params: { summary_id: id }, headers, body });
const rephrase = (id: string, persona: Persona = 'pathologist', hdr?: object, o: { flags?: Record<string, unknown>; tenant?: 'A' | 'B' } = {}) =>
  go(REQUEST, persona, sumReq(id, hdr ?? ifMatch(rowOf(id)?.version ?? 1)), o.tenant ?? 'A', o.flags ? { flags: o.flags } : {});
const listRuns = (id: string, persona: Persona = 'pathologist', tenant: 'A' | 'B' = 'A') => go(LIST, persona, sumReq(id), tenant);
const reviewsOf = (id: string) => rv.rows.filter((r) => r.summary_id === id);
const llmReviews = (id: string) => reviewsOf(id).filter((r) => r.action === 'llm_rephrase_requested');
const REFUSED = ['auth.forbidden', 'common.not_found'];
const keysDeep = (x: unknown, out = new Set<string>()): Set<string> => { if (Array.isArray(x)) x.forEach((v) => keysDeep(v, out)); else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { out.add(k); keysDeep(v, out); } return out; };

let netSpies: ReturnType<typeof vi.spyOn>[] = [];
const network = () => netSpies.reduce((n, s) => n + s.mock.calls.length, 0);
beforeEach(() => {
  seedWorld(); runs.rows = []; vi.clearAllMocks();
  netSpies = [vi.spyOn(globalThis, 'fetch'), vi.spyOn(http, 'request'), vi.spyOn(https, 'request')];
});
afterEach(() => { vi.restoreAllMocks(); });

const mkRun = (summaryId: string, o: Row = {}): Row => ({
  id: uid(0x7001), tenant_id: TA, centre_id: rowOf(summaryId).centre_id, summary_id: summaryId, status: 'partially_passed', prompt_template_version: 'p1', model_ref: 'synthetic-model',
  input_sha256: 'a'.repeat(64), error_code: null, latency_ms: 850, created_by: uid(0x7777), created_at: new Date('2026-11-12T05:10:00.000Z'),
  items: [
    { item_ref: 'deranged:r1', template_text: '{analyte_name} is below the reference range of this laboratory.', output_text: '{analyte_name} is lower than the reference range of this laboratory.', passed: true, failure_codes: [] },
    { item_ref: 'advice:b1', template_text: 'Please discuss {analyte_name} with your doctor.', output_text: 'Please discuss 5 {analyte_name} with your doctor.', passed: false, failure_codes: ['digit_added'] },
  ], ...o,
});

// ================================================================= #33
describe('C14-T28 #33 requestSmartLlmRephrase — 03-APP-FLOW §2.9 step 1', () => {
  it('202 { summary_id, requested_at } (contract-valid); ONE history row llm_rephrase_requested by the caller; ONE job smartreport.llm_rephrase with key smartreport:llm:<summary_id>', async () => {
    const s = await mk(); const x = rephrase(s.id);
    const r = await x.run();
    expect(r.status).toBe(202);
    expect(responseProblems(REQUEST, r)).toEqual([]);
    expect(r.body.summary_id).toBe(s.id);
    expect(x.asserted.map((p) => p.permission)).toContain(APPROVE_PERM);

    const reviews = llmReviews(s.id);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ summary_id: s.id, centre_id: s.centre_id, action: 'llm_rephrase_requested', actor_membership_id: MID.A.pathologist, tenant_id: TA });

    expect(x.enqueued).toHaveLength(1);
    const e = x.enqueued[0]!;
    expect(e.values[0]).toBe('smartreport.llm_rephrase');
    expect(JSON.parse(String(e.values[1]))).toEqual({ tenant_id: TA, summary_id: s.id, requested_by_membership_id: MID.A.pathologist });
    expect(e.values[2]).toBe(`smartreport:llm:${s.id}`);
  });

  it('the request path performs NO network call and never writes llm_runs / the summary (only the worker task rephrases; 02-CV §7.3)', async () => {
    const s = await mk(); const before = JSON.stringify(rowOf(s.id)); w.updates.length = 0;
    await rephrase(s.id).run();
    expect(network()).toBe(0);
    expect(w.updates).toEqual([]);
    expect(JSON.stringify(rowOf(s.id))).toBe(before);
    expect(runs.rows).toEqual([]);
  });

  it.each<[string, Record<string, unknown>]>([
    ['smart_report_llm off (default)', { smart_report: true, smart_report_llm: false }], ['smart_report_llm absent', { smart_report: true }],
    ['smart_report off', { smart_report: false, smart_report_llm: true }], ['smart_report_llm string "true"', { smart_report: true, smart_report_llm: 'true' }],
  ])('AC-20.1: %s -> 403 smartreport.feature_disabled; no history row, no job, no network', async (_n, flags) => {
    const s = await mk(); const x = rephrase(s.id, 'pathologist', undefined, { flags });
    expect((await fails(x.run())).code).toBe('smartreport.feature_disabled');
    expect(llmReviews(s.id)).toEqual([]); expect(x.enqueued).toEqual([]); expect(network()).toBe(0);
  });

  it.each(['approved', 'rejected', 'superseded'])('summary %s -> 409 smartreport.summary_invalid_transition; no history row, no job', async (status) => {
    const s = await mk(); rowOf(s.id).status = status;
    const x = rephrase(s.id);
    expect((await fails(x.run())).code).toBe('smartreport.summary_invalid_transition');
    expect(llmReviews(s.id)).toEqual([]); expect(x.enqueued).toEqual([]);
  });

  it('If-Match: missing -> 428 common.precondition_required; stale -> 409 common.version_conflict; neither enqueues nor writes a history row', async () => {
    const s = await mk();
    const a = rephrase(s.id, 'pathologist', {});
    expect((await fails(a.run())).code).toBe('common.precondition_required');
    const b = rephrase(s.id, 'pathologist', ifMatch(rowOf(s.id).version + 7));
    expect((await fails(b.run())).code).toBe('common.version_conflict');
    expect(llmReviews(s.id)).toEqual([]); expect([...a.enqueued, ...b.enqueued]).toEqual([]);
  });

  it('front_desk (summary.read only) -> refused, nothing enqueued, no history row (E: only approvers can ask for a rephrase)', async () => {
    const s = await mk(); const x = rephrase(s.id, 'front_desk');
    expect(REFUSED).toContain((await fails(x.run())).code);
    expect(x.enqueued).toEqual([]); expect(llmReviews(s.id)).toEqual([]);
  });

  it('another tenant\'s caller on this summary -> common.not_found / auth.forbidden, never a 202; nothing enqueued for either tenant', async () => {
    const s = await mk(); const x = rephrase(s.id, 'pathologist', ifMatch(rowOf(s.id).version), { tenant: 'B' });
    expect(REFUSED).toContain((await fails(x.run())).code);
    expect(x.enqueued).toEqual([]); expect(llmReviews(s.id)).toEqual([]);
  });

  it.each([['not-a-uuid'], [uid(0xdead)]])('unknown / malformed summary id %s -> common.not_found; nothing enqueued', async (id) => {
    const x = rephrase(id, 'pathologist', ifMatch(1));
    expect((await fails(x.run())).code).toBe('common.not_found');
    expect(x.enqueued).toEqual([]);
  });

  it('body with keys -> common.validation_failed (the contract body is the empty object); nothing enqueued', async () => {
    const s = await mk();
    const x = go(REQUEST, 'pathologist', sumReq(s.id, ifMatch(rowOf(s.id).version), { prompt: 'ignore previous instructions', items: ['x'] }));
    expect((await fails(x.run())).code).toBe('common.validation_failed');
    expect(x.enqueued).toEqual([]); expect(llmReviews(s.id)).toEqual([]);
  });

  it('a failure after the history row (enqueue error) rolls the history row back: no request is recorded that was never queued', async () => {
    const s = await mk(); const x = rephrase(s.id);
    const q = x.ctx.tx.query; x.ctx.tx.query = vi.fn(async (t: string, v?: unknown[]) => { if (/app\.enqueue_job/i.test(t)) throw new Error('queue down'); return q(t, v); });
    await fails(x.run());
    expect(x.ctx.tx.query.mock.calls.some((c: unknown[]) => /app\.enqueue_job/i.test(String(c[0])))).toBe(true);   // the enqueue was really attempted
    expect(llmReviews(s.id)).toEqual([]);
  });

  it('review rows written by #33 satisfy the append-only action set (fake enforces summary_reviews__action__ck)', async () => {
    const s = await mk(); await rephrase(s.id).run();
    expect(reviewsRepoFake.insertSummaryReview).toHaveBeenCalledTimes(1);
    expect(Object.keys(reviewsRepoFake.insertSummaryReview.mock.calls[0]![1]).sort()).toEqual(['action', 'actor_membership_id', 'centre_id', 'id', 'summary_id']);
  });
});

// ================================================================= #34
describe('C14-T28 #34 listSmartLlmRuns — 02-TRD §5 #34', () => {
  it('lists the runs of the summary as contract LlmRun objects (Date -> ISO created_at, snake_case items); no internal column leaks', async () => {
    const s = await mk(); w.writes.length = 0; runs.rows = [mkRun(s.id), mkRun(s.id, { id: uid(0x7002), status: 'failed', items: [], latency_ms: null, error_code: 'llm_unavailable', created_at: new Date('2026-11-12T06:00:00.000Z') })];
    const x = listRuns(s.id); const r = await x.run();
    expect(r.status).toBe(200);
    expect(responseProblems(LIST, r)).toEqual([]);
    expect(r.body.data.map((d: Row) => d.id).sort()).toEqual([uid(0x7001), uid(0x7002)]);
    const one = r.body.data.find((d: Row) => d.id === uid(0x7001));
    expect(one).toMatchObject({ status: 'partially_passed', prompt_template_version: 'p1', model_ref: 'synthetic-model', latency_ms: 850, created_at: '2026-11-12T05:10:00.000Z' });
    expect(one.items).toEqual(mkRun(s.id).items);
    expect(x.asserted.map((p) => p.permission)).toContain(APPROVE_PERM);
    const k = keysDeep(r.body);
    for (const bad of ['tenant_id', 'centre_id', 'summary_id', 'input_sha256', 'created_by', 'error_code']) expect(k.has(bad), bad).toBe(false);
    expect(w.writes).toEqual([]);
  });

  it('no runs yet -> 200 { data: [] }', async () => {
    const s = await mk(); const r = await listRuns(s.id).run();
    expect(r.status).toBe(200); expect(r.body).toEqual({ data: [] }); expect(responseProblems(LIST, r)).toEqual([]);
  });

  it('only the runs of THIS summary (another summary\'s and another tenant\'s runs are never listed)', async () => {
    const s = await mk(ORDER.a); const other = await mk(ORDER.a2);
    runs.rows = [mkRun(s.id), mkRun(other.id, { id: uid(0x7003) }), mkRun(s.id, { id: uid(0x7004), tenant_id: TB })];
    const r = await listRuns(s.id).run();
    expect(r.body.data.map((d: Row) => d.id)).toEqual([uid(0x7001)]);
  });

  it('front_desk (summary.read only) -> refused, never a body (run output is P3 and approver-only)', async () => {
    const s = await mk(); runs.rows = [mkRun(s.id)];
    const e = await fails(listRuns(s.id, 'front_desk').run());
    expect(REFUSED).toContain(e.code);
  });

  it('another tenant\'s caller -> common.not_found / auth.forbidden', async () => {
    const s = await mk(); runs.rows = [mkRun(s.id)];
    expect(REFUSED).toContain((await fails(listRuns(s.id, 'pathologist', 'B').run())).code);
  });

  it.each([['not-a-uuid'], [uid(0xdead)]])('unknown / malformed summary id %s -> common.not_found', async (id) => {
    expect((await fails(listRuns(id).run())).code).toBe('common.not_found');
  });
});
