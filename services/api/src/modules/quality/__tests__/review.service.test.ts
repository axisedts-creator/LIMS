// C9 T-12 — service/review.service.ts #26-#33 (02-TRD §5.5, §5.10, §7.7; 03-APP-FLOW QR5/QR7, §2.2; PRD AC-07.1-07.5; 07-SECURITY S-09/S-10/S-11/S-16, AB-02, AB-10, REQ-SEC-100).
// SEAMS (repo, run repo, evaluate-now delegate, order of checks, coded sets, labels) are pinned in review.helpers.ts. Run-service behaviour of evaluate-now: review.evaluate.integration.test.ts.
// Fails now: "Cannot find module ../service/review.service.js" (nothing of T-12 exists yet).
import { describe, expect, it, vi } from 'vitest';
import { createReviewService } from '../service/review.service.js';
import {
  CA, CA_KEYS, DAY_MS, FULL, NOW, OBS, OPS, PLANTED, PLN, REQ_ID, REV, REVIEW_KEYS, RUN, SUMMARY_KEYS, SYSTEM, TENANT_A, TENANT_B, USER, at, baseSeed, caRow, code, idN, immutableRow, makeReviewCtx, makeReviewRepo,
  makeRunRepoDouble, noRights, obsRow, pgErr, readOnly, rejection, runRow, type Row, type Seed,
} from './review.helpers.js';

const MEM_ID = idN(0xd2);
function setup(seed: Seed = baseSeed(), o: { roles?: (c: { permission: string }) => void; now?: string; evalImpl?: (c: any, a: { runId: string }) => Promise<Row>; onLock?: () => void } = {}) {
  const fake = makeReviewRepo(seed); const rr = makeRunRepoDouble(fake);
  if (o.onLock) { const orig = rr.repo.lockPlan; rr.repo.lockPlan = async (...a: any[]) => { const r = await orig(...a); o.onLock!(); return r; }; }
  const runs = { evaluateNow: vi.fn(o.evalImpl ?? (async (c: any, a: { runId: string }) => {
    const r = fake.state.runs.find((x) => x['id'] === a.runId)!;
    Object.assign(r, { status: 'evaluated', outcome: 'incomplete', is_complete: false, evaluated_at: c.now(), evaluated_by: c.actor.id, version: r['version'] + 1 }); return structuredClone(r);
  })) };
  const svc: any = createReviewService({ repo: fake.repo, runRepo: rr.repo, runs });
  const c = makeReviewCtx({ ...(o.roles ? { roles: o.roles } : {}), ...(o.now ? { now: o.now } : {}) });
  return { svc, fake, rr, runs, ...c };
}
const ca = (o: Row = {}) => ({ action_code: 'recalibration', description: 'Recalibrated the analyser', performed_at: at('08:30:00'), ...o });
const seedWith = (f: (s: Seed) => void): Seed => { const s = baseSeed(); f(s); return s; };
const withCa = (s: Seed) => { s.correctives = [caRow(1, 1)]; };
const later = (n: number, o: Row) => (s: Seed) => { s.runs!.push(runRow(n, { outcome: 'accepted', rules_violated: [], rule_detail: [], hold_since: null, last_in_control_run_at: null, rejection_event_id: null, ...o })); };
const NOW_ISO = NOW;

describe('permissions: assertRole is the FIRST step; no repo call happens before it (REQ-SEC-023)', () => {
  const calls: Array<[string, string, (s: any) => Promise<unknown>]> = [
    ['listQcObservations', 'quality.qc_run.read', (s) => s.svc.listQcObservations(s.ctx, {})],
    ['excludeQcObservation', 'quality.qc.manage', (s) => s.svc.excludeQcObservation(s.ctx, { observationId: OBS(2), expectedVersion: 1, body: { reason_code: 'wrong_material' } })],
    ['listQcRuns', 'quality.qc_run.read', (s) => s.svc.listQcRuns(s.ctx, {})],
    ['getQcRun', 'quality.qc_run.read', (s) => s.svc.getQcRun(s.ctx, { runId: RUN(1) })],
    ['evaluateQcRunNow', 'quality.qc_run.review', (s) => s.svc.evaluateQcRunNow(s.ctx, { runId: RUN(2), expectedVersion: 1, body: {} })],
    ['recordCorrectiveAction', 'quality.qc_run.review', (s) => s.svc.recordCorrectiveAction(s.ctx, { runId: RUN(1), body: ca() })],
    ['closeQcRun', 'quality.qc_run.review', (s) => s.svc.closeQcRun(s.ctx, { runId: RUN(1), expectedVersion: 2, body: {} })],
    ['acknowledgeQcRun', 'quality.qc_run.review', (s) => s.svc.acknowledgeQcRun(s.ctx, { runId: RUN(3), body: { comment: 'Reviewed the 1-2s warning' } })],
  ];
  it('the table covers exactly #26-#33', () => { expect(calls.map((c) => c[0]).sort()).toEqual([...OPS].sort()); });
  it.each(calls)('%s asks for %s; a principal without it -> auth.forbidden, repo / run repo / evaluate-now never called', async (_op, perm, run) => {
    const s = setup(baseSeed(), { roles: noRights });
    expect(code(await rejection(run(s)))).toBe('auth.forbidden');
    expect(s.asserted.map((a) => a.permission)).toEqual([perm]);
    expect(s.fake.calls).toEqual([]); expect(s.rr.calls).toEqual([]); expect(s.runs.evaluateNow).not.toHaveBeenCalled();
  });
  it.each(calls.filter((c) => c[1] !== 'quality.qc_run.read'))('%s: a read-only technologist (qc_run.read only) cannot write', async (_op, _p, run) => {
    const s = setup(baseSeed(), { roles: readOnly });
    expect(code(await rejection(run(s)))).toBe('auth.forbidden'); expect(s.fake.writes()).toEqual([]); expect(s.rr.calls).toEqual([]);
  });
});

describe('#26 listQcObservations: window of at most 92 days (REQ-SEC-100, S-16), filters, DTO allowlist', () => {
  const FROM = '2026-08-13T00:00:00.000Z', TO92 = new Date(Date.parse(FROM) + 92 * DAY_MS).toISOString();
  const win = (s: ReturnType<typeof setup>) => (s.fake.callsOf('listObservations')[0]!.args[0] as any);
  it('both bounds given: a span of exactly 92 days is accepted and passed through unchanged', async () => {
    const s = setup(); const r = await s.svc.listQcObservations(s.ctx, { observedAtFrom: FROM, observedAtTo: TO92 });
    expect(r.status).toBe(200); expect(win(s)).toMatchObject({ from: FROM, to: TO92 });
  });
  it('a span of 92 days + 1 ms -> 400 common.validation_failed at /observed_at_to; the repo is never asked', async () => {
    const s = setup(); const e = await rejection(s.svc.listQcObservations(s.ctx, { observedAtFrom: FROM, observedAtTo: new Date(Date.parse(TO92) + 1).toISOString() }));
    expect(code(e)).toBe('common.validation_failed'); expect(e.errors ?? e.details).toEqual(expect.arrayContaining([expect.objectContaining({ path: '/observed_at_to' })])); expect(s.fake.calls).toEqual([]);
  });
  it('to before from -> 400 at /observed_at_to', async () => {
    const s = setup(); const e = await rejection(s.svc.listQcObservations(s.ctx, { observedAtFrom: TO92, observedAtTo: FROM }));
    expect(code(e)).toBe('common.validation_failed'); expect(s.fake.calls).toEqual([]);
  });
  it('only `from` given: the other bound defaults to from + 92 d; only `to` given: from = to - 92 d', async () => {
    const a = setup(); await a.svc.listQcObservations(a.ctx, { observedAtFrom: FROM }); expect(win(a)).toMatchObject({ from: FROM, to: TO92 });
    const b = setup(); await b.svc.listQcObservations(b.ctx, { observedAtTo: TO92 }); expect(win(b)).toMatchObject({ from: FROM, to: TO92 });
  });
  it('neither bound: still bounded — the window ends at ctx.now() and starts 92 days earlier (pinned beyond spec; an unbounded read would break REQ-SEC-100)', async () => {
    const s = setup(); await s.svc.listQcObservations(s.ctx, {});
    expect(win(s)).toMatchObject({ to: NOW_ISO, from: new Date(Date.parse(NOW_ISO) - 92 * DAY_MS).toISOString() });
  });
  it('filters reach the repo typed: uuids, status csv split, default sort -observed_at, limit as number, cursor', async () => {
    const s = setup(); await s.svc.listQcObservations(s.ctx, { planId: PLN(1), status: 'assigned,excluded', limit: 25, cursor: 'C1', observedAtFrom: FROM, observedAtTo: TO92, sort: 'observed_at' });
    expect(win(s)).toMatchObject({ planId: PLN(1), statuses: ['assigned', 'excluded'], limit: 25, cursor: 'C1', sort: 'observed_at' });
    const d = setup(); await d.svc.listQcObservations(d.ctx, { observedAtFrom: FROM }); expect(win(d)).toMatchObject({ sort: '-observed_at' }); expect(win(d).limit).toBeGreaterThan(0);
  });
  it.each([[{ planId: 'x' }], [{ levelId: 'not-a-uuid' }], [{ status: 'assigned,bogus' }], [{ sort: 'value' }], [{ limit: 201 }], [{ limit: 0 }], [{ observedAtFrom: '2026-08-13' }]])('bad query %j -> 400, repo not called', async (q) => {
    const s = setup(); expect(code(await rejection(s.svc.listQcObservations(s.ctx, q)))).toBe('common.validation_failed'); expect(s.fake.calls).toEqual([]);
  });
  it('lists this tenant only (OBS(9) of tenant B never appears); the DTO is the QcObservationDto allowlist: no tenant_id, internal columns, created_by, source_qc_result_id, excluded_* raw columns; z has 3 dp', async () => {
    const s = setup(); const r = await s.svc.listQcObservations(s.ctx, { observedAtFrom: at('00:00:00') });
    const ids = r.body.data.map((o: Row) => o.id); expect(ids).toEqual(expect.arrayContaining([OBS(1), OBS(2), OBS(3)])); expect(ids).not.toContain(OBS(9));
    const o = r.body.data.find((x: Row) => x.id === OBS(1));
    expect(o).toMatchObject({ id: OBS(1), version: 1, plan_id: PLN(1), status: 'assigned', qc_run_id: RUN(1), value: '106.000000', z: '3.000', observed_at_basis: 'instrument', source: 'instrument' });
    const all = JSON.stringify(r.body); for (const k of ['tenant_id', 'internal_note', PLANTED, 'created_by', 'source_qc_result_id', 'excluded_reason_code', 'excluded_by"']) expect(all, k).not.toContain(k);
    expect(r.body.page).toMatchObject({ limit: expect.any(Number) }); expect(r.version).toBeUndefined();
  });
  it('an unassigned observation (no plan) omits plan_id/level_id/lot_id/target_id/z instead of sending null', async () => {
    const s = setup(); const o = (await s.svc.listQcObservations(s.ctx, { observedAtFrom: at('00:00:00') })).body.data.find((x: Row) => x.id === OBS(3));
    for (const k of ['plan_id', 'level_id', 'lot_id', 'target_id', 'z', 'excluded']) expect(o, k).not.toHaveProperty(k);
  });
  it('an excluded observation carries excluded { reason_code, comment, by_display, at } with a label, never the user id', async () => {
    const sd = seedWith((x) => { x.observations![0] = obsRow(1, { status: 'excluded', excluded_reason_code: 'wrong_material', excluded_comment: 'wrong vial', excluded_by: USER, excluded_at: at('07:00:00'), qc_run_id: RUN(2) }); });
    const s = setup(sd); const o = (await s.svc.listQcObservations(s.ctx, { observedAtFrom: at('00:00:00') })).body.data.find((x: Row) => x.id === OBS(1));
    expect(o.excluded).toEqual({ reason_code: 'wrong_material', comment: 'wrong vial', by_display: 'Synthetic Technologist', at: at('07:00:00') }); expect(JSON.stringify(o)).not.toContain(USER);
  });
  it('nextCursor from the repo is returned as page.next_cursor', async () => {
    const s = setup(); s.fake.repo.listObservations = async () => ({ rows: [], nextCursor: 'NEXT' }); const r = await s.svc.listQcObservations(s.ctx, { limit: 1, observedAtFrom: FROM });
    expect(r.body.page).toEqual({ limit: 1, next_cursor: 'NEXT' });
  });
});

describe('#27 excludeQcObservation: only while its run is collecting or it has no run (service check + trigger backstop; S-10, AB-02)', () => {
  const ex = (s: ReturnType<typeof setup>, o: Row = {}) => s.svc.excludeQcObservation(s.ctx, { observationId: OBS(2), expectedVersion: 1, body: { reason_code: 'wrong_material', comment: 'wrong vial' }, ...o });
  it('an observation of a COLLECTING run is excluded: 200, status excluded, excluded {…, by_display, at = ctx.now()}, version + 1 (ETag)', async () => {
    const s = setup(); const r = await ex(s);
    expect(r.status).toBe(200); expect(r.version).toBe(2); expect(r.body).toMatchObject({ id: OBS(2), status: 'excluded', version: 2, excluded: { reason_code: 'wrong_material', comment: 'wrong vial', by_display: 'Synthetic Technologist', at: NOW } });
    expect(s.fake.obs(2)).toMatchObject({ status: 'excluded', excluded_by: USER, excluded_at: NOW, excluded_reason_code: 'wrong_material' });
  });
  it('an observation with NO run (e.g. no_plan) can be excluded', async () => {
    const s = setup(); const r = await ex(s, { observationId: OBS(3) }); expect(r.status).toBe(200); expect(r.body.status).toBe('excluded');
  });
  it('an observation whose run is EVALUATED -> 409 quality.qc_run_already_evaluated; nothing is written (service check precedes the write)', async () => {
    const s = setup(); expect(code(await rejection(ex(s, { observationId: OBS(1) })))).toBe('quality.qc_run_already_evaluated');
    expect(s.fake.callsOf('excludeObservation')).toEqual([]); expect(s.fake.obs(1)).toMatchObject({ status: 'assigned', excluded_at: null });
  });
  it('an observation whose run is CLOSED is refused the same way', async () => {
    const s = setup(seedWith((x) => { x.observations![0] = obsRow(1, { qc_run_id: RUN(5) }); })); expect(code(await rejection(ex(s, { observationId: OBS(1), expectedVersion: 1 })))).toBe('quality.qc_run_already_evaluated');
  });
  it('trigger backstop: the run was evaluated between the read and the update (P0001 immutable_row) -> the same 409 quality.qc_run_already_evaluated, not 500', async () => {
    const s = setup(); const find = s.fake.repo.findObservation;
    s.fake.repo.findObservation = async (...a) => { const o = await find(...a); if (o) o['run_status'] = 'collecting'; return o; };   // stale read
    s.fake.run(2)['status'] = 'evaluated';
    expect(code(await rejection(ex(s)))).toBe('quality.qc_run_already_evaluated');
  });
  it('If-Match absent -> 428 common.precondition_required; stale version -> 409 common.version_conflict; neither writes', async () => {
    const a = setup(); expect(code(await rejection(ex(a, { expectedVersion: undefined })))).toBe('common.precondition_required');
    const b = setup(); expect(code(await rejection(ex(b, { expectedVersion: 7 })))).toBe('common.version_conflict'); expect(a.fake.writes()).toEqual([]); expect(b.fake.writes()).toEqual([]);
  });
  it('unknown / invisible observation, and tenant B\'s OBS(9) -> 404 common.not_found (identical)', async () => {
    const s = setup(); const a = await rejection(ex(s, { observationId: OBS(9) })), b = await rejection(ex(s, { observationId: OBS(77) }));
    expect(code(a)).toBe('common.not_found'); expect(code(b)).toBe('common.not_found'); expect(a.message).toBe(b.message);
  });
  it.each([[{ reason_code: 'not_in_the_set' }], [{ reason_code: 'retired_reason' }]])('reason code %j that is unknown or inactive -> 400 at /reason_code; nothing written', async (b) => {
    const s = setup(); const e = await rejection(ex(s, { body: b })); expect(code(e)).toBe('common.validation_failed'); expect(e.errors ?? e.details).toEqual(expect.arrayContaining([expect.objectContaining({ path: '/reason_code' })])); expect(s.fake.writes()).toEqual([]);
  });
  it.each([[{}], [{ reason_code: 'wrong_material', comment: 'x'.repeat(501) }], [{ reason_code: 'wrong_material', tenant_id: TENANT_B }], [{ reason_code: 'wrong_material', status: 'assigned' }], [{ reason_code: 'wrong_material', excluded_by: USER }], [{ reason_code: 5 }]])('body %j -> 400, nothing written (mass assignment, S-03)', async (b) => {
    const s = setup(); expect(code(await rejection(ex(s, { body: b })))).toBe('common.validation_failed'); expect(s.fake.writes()).toEqual([]);
  });
  it('a 500-character comment is accepted; the comment is optional', async () => {
    expect((await ex(setup(), { body: { reason_code: 'wrong_material', comment: 'x'.repeat(500) } })).status).toBe(200);
    const r = await ex(setup(), { body: { reason_code: 'wrong_material' } }); expect(r.body.excluded).not.toHaveProperty('comment');
  });
});

describe('#28 listQcRuns: window <= 92 days, needs_action and needs_action_reason (TRD §5.10), DTO allowlist', () => {
  const FROM = '2026-08-13T00:00:00.000Z', TO92 = new Date(Date.parse(FROM) + 92 * DAY_MS).toISOString();
  const q = (s: ReturnType<typeof setup>) => s.fake.callsOf('listRuns')[0]!.args[0] as any;
  const list = (s: ReturnType<typeof setup>, o: Row = {}) => s.svc.listQcRuns(s.ctx, { runAtFrom: at('00:00:00'), ...o });
  it('92 days exactly is accepted; 92 days + 1 ms -> 400 at /run_at_to; only one bound -> the other is +/- 92 d; neither -> now - 92 d .. now', async () => {
    const a = setup(); expect((await a.svc.listQcRuns(a.ctx, { runAtFrom: FROM, runAtTo: TO92 })).status).toBe(200);
    const b = setup(); const e = await rejection(b.svc.listQcRuns(b.ctx, { runAtFrom: FROM, runAtTo: new Date(Date.parse(TO92) + 1).toISOString() }));
    expect(code(e)).toBe('common.validation_failed'); expect(e.errors ?? e.details).toEqual(expect.arrayContaining([expect.objectContaining({ path: '/run_at_to' })])); expect(b.fake.calls).toEqual([]);
    const c = setup(); await c.svc.listQcRuns(c.ctx, { runAtFrom: FROM }); expect(q(c)).toMatchObject({ from: FROM, to: TO92 });
    const d = setup(); await d.svc.listQcRuns(d.ctx, { runAtTo: TO92 }); expect(q(d)).toMatchObject({ from: FROM, to: TO92 });
    const f = setup(); await f.svc.listQcRuns(f.ctx, {}); expect(q(f)).toMatchObject({ to: NOW_ISO, from: new Date(Date.parse(NOW_ISO) - 92 * DAY_MS).toISOString() });
  });
  it.each([[{ status: 'evaluated,bogus' }], [{ outcome: 'accepted,nope' }], [{ needsAction: 'yes' }], [{ planId: 'x' }], [{ sort: 'run_at' }], [{ limit: 201 }]])('bad query %j -> 400', async (b) => {
    const s = setup(); expect(code(await rejection(list(s, b)))).toBe('common.validation_failed'); expect(s.fake.calls).toEqual([]);
  });
  it('status / outcome csv are split; needs_action boolean and ids reach the repo', async () => {
    const s = setup(); await list(s, { status: 'evaluated,closed', outcome: 'rejected,incomplete', needsAction: true, planId: PLN(1), limit: 10 });
    expect(q(s)).toMatchObject({ statuses: ['evaluated', 'closed'], outcomes: ['rejected', 'incomplete'], needsAction: true, planId: PLN(1), limit: 10 });
  });
  it('needs_action = rejected and not closed; reason is `corrective_action` while no corrective action exists, `rerun` once one does; absent (not null) otherwise', async () => {
    const s = setup(seedWith((x) => { x.correctives = [caRow(1, 6)]; x.runs!.push(runRow(6, { run_at: at('09:00:00') })); }));
    const by = Object.fromEntries((await list(s)).body.data.map((r: Row) => [r.id, r]));
    expect(by[RUN(1)]).toMatchObject({ needs_action: true, needs_action_reason: 'corrective_action' }); expect(by[RUN(6)]).toMatchObject({ needs_action: true, needs_action_reason: 'rerun' });
    for (const n of [2, 3, 4, 5]) { expect(by[RUN(n)].needs_action, `RUN(${n})`).toBe(false); expect(by[RUN(n)], `RUN(${n})`).not.toHaveProperty('needs_action_reason'); }
  });
  it('AC-07.1 -> list: after a corrective action is recorded the same run flips from corrective_action to rerun', async () => {
    const s = setup(); await s.svc.recordCorrectiveAction(s.ctx, { runId: RUN(1), body: ca() });
    expect((await list(s, { needsAction: true })).body.data.find((r: Row) => r.id === RUN(1))).toMatchObject({ needs_action: true, needs_action_reason: 'rerun' });
  });
  it('lists this tenant only (RUN(9) never appears); items are QcRunSummaryDto exactly (+ needs_action_reason when needed): no tenant_id, evaluated_by, hold, internal columns; newest run first', async () => {
    const s = setup(); const r = await list(s); const ids = r.body.data.map((x: Row) => x.id); expect(ids).not.toContain(RUN(9)); expect(ids.length).toBe(5);
    // 02-CONVENTIONS:348 no null on the wire — closed_at is omitted unless the run is closed (ruling C9.T-12-ruling.md #2)
    const open = SUMMARY_KEYS.filter((k) => k !== 'closed_at');
    const one = r.body.data.find((x: Row) => x.id === RUN(4)); expect(Object.keys(one).sort()).toEqual(open);
    expect(Object.keys(r.body.data.find((x: Row) => x.id === RUN(1))).sort()).toEqual([...open, 'needs_action_reason'].sort());
    expect(Object.keys(r.body.data.find((x: Row) => x.id === RUN(5))).sort()).toEqual(SUMMARY_KEYS);
    const all = JSON.stringify(r.body); for (const k of ['tenant_id', 'internal_note', PLANTED, 'evaluated_by', 'hold_since', 'rejection_event_id', 'created_by']) expect(all, k).not.toContain(k);
    expect(r.body.page).toMatchObject({ limit: expect.any(Number) }); expect(r.version).toBeUndefined();
  });
  it('a collecting run: outcome and closed_at are omitted/null per the DTO, never fabricated', async () => {
    const s = setup(); const c = (await list(s)).body.data.find((x: Row) => x.id === RUN(2)); expect(c).toMatchObject({ status: 'collecting', needs_action: false }); expect(c.outcome ?? null).toBeNull(); expect(c).not.toHaveProperty('closed_at');
  });
});

describe('#29 getQcRun: QcRunDto (observations with z and rule hits, plan version, hold info, corrective actions, reviews)', () => {
  const full = () => seedWith((x) => {
    x.correctives = [caRow(1, 1)]; x.reviews = [{ id: REV(1), tenant_id: TENANT_A, qc_run_id: RUN(1), kind: 'evaluate_now', comment: 'ok', reviewed_by_membership_id: MEM_ID, created_at: at('08:05:00'), created_by: USER }];
    x.observations!.push(obsRow(5, { level_id: idN(0x4002), z: '0.500000', value: '101.000000', qc_run_id: RUN(1), observed_at: at('08:00:30') }));
  });
  it('returns the run with plan_version_no, observations (z 3 dp, rule_hits per observation from rule_detail), rule_detail, hold {hold_since, last_in_control_run_at, event_id}, evaluated_by "system"', async () => {
    const s = setup(full()); const r = await s.svc.getQcRun(s.ctx, { runId: RUN(1) });
    expect(r.status).toBe(200); expect(r.version).toBe(2);
    expect(r.body).toMatchObject({ id: RUN(1), plan_version_no: 3, status: 'evaluated', outcome: 'rejected', needs_action: true, needs_action_reason: 'rerun', rules_violated: ['1-3s'], rule_detail: [{ rule: '1-3s', observation_ids: [OBS(1)] }],
      hold: { hold_since: at('06:00:00'), last_in_control_run_at: at('06:00:00'), event_id: idN(0xe501) }, evaluated_by: 'system', evaluated_at: at('08:00:06') });
    const by = Object.fromEntries(r.body.observations.map((o: Row) => [o.id, o]));
    expect(by[OBS(1)]).toMatchObject({ z: '3.000', rule_hits: ['1-3s'] }); expect(by[OBS(5)]).toMatchObject({ z: '0.500', rule_hits: [] });
  });
  it('embeds corrective_actions (CorrectiveActionDto) and reviews (QcRunReviewDto); display names are labels, ids and internal columns never leak', async () => {
    const s = setup(full()); const r = await s.svc.getQcRun(s.ctx, { runId: RUN(1) });
    expect(Object.keys(r.body.corrective_actions[0]).sort()).toEqual(CA_KEYS); expect(r.body.corrective_actions[0]).toMatchObject({ action_code: 'recalibration', action_display: 'Recalibrated', performed_by_display: 'Synthetic Technologist' });
    expect(Object.keys(r.body.reviews[0]).sort()).toEqual(REVIEW_KEYS); expect(r.body.reviews[0]).toMatchObject({ kind: 'evaluate_now', reviewed_by_display: 'Synthetic Technologist' });
    const all = JSON.stringify(r.body); for (const k of ['tenant_id', 'internal_note', PLANTED, 'performed_by_membership_id', 'reviewed_by_membership_id', 'created_by', 'source_qc_result_id', 'rejection_event_id']) expect(all, k).not.toContain(k);
    expect(all).not.toContain(MEM_ID); expect(all).not.toContain(USER);
  });
  it('an evaluated_by that is a user shows the user label; no hold block for a run that was never rejected', async () => {
    const s = setup(seedWith((x) => { x.runs![2]!['evaluated_by'] = USER; })); const r = await s.svc.getQcRun(s.ctx, { runId: RUN(3) });
    expect(r.body.evaluated_by).toBe('Synthetic Technologist'); expect(r.body).not.toHaveProperty('hold'); expect(r.body.needs_action).toBe(false);
  });
  it('a collecting run has no evaluated_by / evaluated_at / hold', async () => {
    const s = setup(); const r = await s.svc.getQcRun(s.ctx, { runId: RUN(2) }); for (const k of ['hold']) expect(r.body).not.toHaveProperty(k); expect(r.body.evaluated_by ?? null).toBeNull();
  });
  it('tenant B\'s RUN(9), an unknown id and a non-uuid are indistinguishable: 404 common.not_found (S-01, AB-06) / 400 for the malformed id', async () => {
    const s = setup(); const a = await rejection(s.svc.getQcRun(s.ctx, { runId: RUN(9) })), b = await rejection(s.svc.getQcRun(s.ctx, { runId: RUN(99) }));
    expect(code(a)).toBe('common.not_found'); expect(code(b)).toBe('common.not_found'); expect(a.message).toBe(b.message);
    expect(code(await rejection(s.svc.getQcRun(s.ctx, { runId: 'nope' })))).toMatch(/^common\.(validation_failed|not_found)$/);
  });
});

describe('#30 evaluateQcRunNow (QR5): finalises a COLLECTING run through the run service and records an evaluate_now review', () => {
  const ev = (s: ReturnType<typeof setup>, o: Row = {}) => s.svc.evaluateQcRunNow(s.ctx, { runId: RUN(2), expectedVersion: 1, body: { comment: 'Shift ending' }, ...o });
  it('delegates to runs.evaluateNow(ctx, { runId }) once, writes ONE review {kind evaluate_now, comment, reviewer = actor membership}, returns 200 QcRunDto with the NEW version (ETag)', async () => {
    const s = setup(); const r = await ev(s);
    expect(s.runs.evaluateNow).toHaveBeenCalledTimes(1); expect(s.runs.evaluateNow.mock.calls[0]![1]).toEqual({ runId: RUN(2), planId: PLN(1) });
    expect(s.fake.state.reviews).toEqual([expect.objectContaining({ tenant_id: TENANT_A, qc_run_id: RUN(2), kind: 'evaluate_now', comment: 'Shift ending', reviewed_by_membership_id: MEM_ID, created_by: USER })]);
    expect(r.status).toBe(200); expect(r.version).toBe(2); expect(r.body).toMatchObject({ id: RUN(2), status: 'evaluated', outcome: 'incomplete', evaluated_by: 'Synthetic Technologist' }); expect(r.body.reviews).toHaveLength(1);
  });
  it('the comment is optional (review row without comment)', async () => {
    const s = setup(); await ev(s, { body: {} }); expect(s.fake.state.reviews[0]!['comment'] ?? null).toBeNull();
  });
  it('an already evaluated or closed run -> 409 quality.qc_run_already_evaluated; the delegate is not called; no review row', async () => {
    for (const n of [1, 3, 4, 5]) { const s = setup(); expect(code(await rejection(ev(s, { runId: RUN(n), expectedVersion: s.fake.run(n)['version'] }))), `RUN(${n})`).toBe('quality.qc_run_already_evaluated'); expect(s.runs.evaluateNow).not.toHaveBeenCalled(); expect(s.fake.state.reviews).toEqual([]); }
  });
  it('the run service lost the race (it throws quality.qc_run_already_evaluated under the pair lock) -> same 409 and NO review row is written', async () => {
    const s = setup(baseSeed(), { evalImpl: async () => { throw Object.assign(new Error('x'), { code: 'quality.qc_run_already_evaluated' }); } });
    expect(code(await rejection(ev(s)))).toBe('quality.qc_run_already_evaluated'); expect(s.fake.state.reviews).toEqual([]);
  });
  it('If-Match absent -> 428; stale -> 409 common.version_conflict; neither calls the delegate', async () => {
    const a = setup(); expect(code(await rejection(ev(a, { expectedVersion: undefined })))).toBe('common.precondition_required');
    const b = setup(); expect(code(await rejection(ev(b, { expectedVersion: 5 })))).toBe('common.version_conflict'); expect(a.runs.evaluateNow).not.toHaveBeenCalled(); expect(b.runs.evaluateNow).not.toHaveBeenCalled();
  });
  it.each([[{ comment: 'x'.repeat(501) }], [{ comment: 5 }], [{ outcome: 'accepted' }], [{ tenant_id: TENANT_B }]])('body %j -> 400; nothing evaluated', async (b) => {
    const s = setup(); expect(code(await rejection(ev(s, { body: b })))).toBe('common.validation_failed'); expect(s.runs.evaluateNow).not.toHaveBeenCalled();
  });
  it('tenant B\'s RUN(9) / unknown run -> 404; the delegate is never reached', async () => {
    const s = setup(); expect(code(await rejection(ev(s, { runId: RUN(9), expectedVersion: 2 })))).toBe('common.not_found'); expect(s.runs.evaluateNow).not.toHaveBeenCalled();
  });
});

describe('#31 recordCorrectiveAction (AC-07.1): append-only row with actor and time, only for a REJECTED run', () => {
  const rec = (s: ReturnType<typeof setup>, o: Row = {}) => s.svc.recordCorrectiveAction(s.ctx, { runId: RUN(1), body: ca(), ...o });
  it('AC-07.1: 201 CorrectiveActionDto; the stored row has tenant (from ctx), run, code, description, performed_at, performed_by_membership_id = actor membership, created_by = actor, created_at = now', async () => {
    const s = setup(); const r = await rec(s);
    expect(r.status).toBe(201); expect(r.version).toBeUndefined(); expect(Object.keys(r.body).sort()).toEqual(CA_KEYS);
    expect(r.body).toMatchObject({ qc_run_id: RUN(1), action_code: 'recalibration', action_display: 'Recalibrated', description: 'Recalibrated the analyser', performed_at: at('08:30:00'), performed_by_display: 'Synthetic Technologist', created_at: NOW });
    expect(s.fake.state.correctives).toEqual([expect.objectContaining({ tenant_id: TENANT_A, qc_run_id: RUN(1), action_code: 'recalibration', description: 'Recalibrated the analyser', performed_at: at('08:30:00'), performed_by_membership_id: MEM_ID, created_by: USER, created_at: NOW })]);
    expect(s.fake.state.correctives[0]!['id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/); expect(JSON.stringify(r.body)).not.toContain(MEM_ID);
  });
  it('append-only: a second action adds a second row; no update or delete is ever issued', async () => {
    const s = setup(); await rec(s); await rec(s, { body: ca({ action_code: 'recalibration', description: 'Second attempt' }) });
    expect(s.fake.state.correctives).toHaveLength(2); expect(s.fake.calls.map((c) => c.op).filter((o) => /update|delete/i.test(o))).toEqual([]);
  });
  it.each([[2, 'collecting'], [3, 'accepted_warning'], [4, 'accepted']])('RUN(%i) (%s) is not rejected -> 409 common.immutable_record; nothing written', async (n) => {
    const s = setup(); expect(code(await rejection(rec(s, { runId: RUN(n) })))).toBe('common.immutable_record'); expect(s.fake.state.correctives).toEqual([]);
  });
  it('tenant B\'s RUN(9) / unknown -> 404 common.not_found; the tenant column of the new row can never come from the body', async () => {
    const s = setup(); expect(code(await rejection(rec(s, { runId: RUN(9) })))).toBe('common.not_found');
    expect(code(await rejection(rec(s, { body: ca({ tenant_id: TENANT_B }) })))).toBe('common.validation_failed'); expect(s.fake.state.correctives).toEqual([]);
  });
  it.each([[{ action_code: 'not_in_the_set' }], [{ action_code: 'retired_code' }]])('action code %j unknown or inactive -> 400 at /action_code', async (b) => {
    const s = setup(); const e = await rejection(rec(s, { body: ca(b) })); expect(code(e)).toBe('common.validation_failed'); expect(e.errors ?? e.details).toEqual(expect.arrayContaining([expect.objectContaining({ path: '/action_code' })])); expect(s.fake.writes()).toEqual([]);
  });
  it('description 1..1000 code points: 1 and 1000 accepted; empty, 1001 and a non-string rejected', async () => {
    expect((await rec(setup(), { body: ca({ description: 'x' }) })).status).toBe(201); expect((await rec(setup(), { body: ca({ description: 'é'.repeat(1000) }) })).status).toBe(201);
    for (const d of ['', 'x'.repeat(1001), 5, null]) expect(code(await rejection(rec(setup(), { body: ca({ description: d }) }))), String(d)).toBe('common.validation_failed');
  });
  it('performed_at bounds: <= now + 5 min and >= run_at - 24 h (both inclusive); outside, or not IsoUtc -> 400 at /performed_at', async () => {
    const inc = [new Date(Date.parse(NOW) + 5 * 60_000).toISOString(), new Date(Date.parse(at('08:00:00')) - 24 * 3_600_000).toISOString()];
    for (const p of inc) expect((await rec(setup(), { body: ca({ performed_at: p }) })).status, p).toBe(201);
    const bad = [new Date(Date.parse(NOW) + 5 * 60_000 + 1).toISOString(), new Date(Date.parse(at('08:00:00')) - 24 * 3_600_000 - 1).toISOString(), '2026-11-13T08:30:00Z', '2026-11-13 08:30:00', 'tomorrow', 5];
    for (const p of bad) { const e = await rejection(rec(setup(), { body: ca({ performed_at: p }) })); expect(code(e), String(p)).toBe('common.validation_failed'); expect(e.errors ?? e.details).toEqual(expect.arrayContaining([expect.objectContaining({ path: '/performed_at' })])); }
  });
  it.each([[{ description: undefined }], [{ action_code: undefined }], [{ performed_at: undefined }], [{ extra: 1 }], [{ performed_by_membership_id: MEM_ID }], [{ created_by: USER }]])('body override %j -> 400 (required fields; no extra / actor fields), nothing written', async (o) => {
    const s = setup(); const b: Row = { ...ca(), ...o }; for (const k of Object.keys(b)) if (b[k] === undefined) delete b[k];
    expect(code(await rejection(rec(s, { body: b })))).toBe('common.validation_failed'); expect(s.fake.state.correctives).toEqual([]);
  });
  it('stored description is not echoed in errors (REQ-SEC-088): a rejected body leaks nothing back', async () => {
    const e = await rejection(recFail()); expect(JSON.stringify({ c: e.code, m: e.message, d: e.errors ?? e.details })).not.toContain('PLANTED-TOKEN-9f3a');
    function recFail() { const s = setup(); return s.svc.recordCorrectiveAction(s.ctx, { runId: RUN(1), body: ca({ description: 'PLANTED-TOKEN-9f3a'.repeat(100), action_code: 'nope' }) }); }
  });
});

describe('#32 closeQcRun (AC-07.2, AC-07.3, AC-07.4; QR7; 08 A17 D-52): the close-out guard', () => {
  const close = (s: ReturnType<typeof setup>, o: Row = {}) => s.svc.closeQcRun(s.ctx, { runId: RUN(1), expectedVersion: 2, body: {}, ...o });
  const R_AT = Date.parse(at('08:00:00')), WIN = 30 * 60_000;
  it('AC-07.2: a rejected run WITHOUT any corrective action -> 409 quality.corrective_action_required; no review, no update', async () => {
    const s = setup(); expect(code(await rejection(close(s)))).toBe('quality.corrective_action_required'); expect(s.fake.state.reviews).toEqual([]); expect(s.rr.calls.filter((c) => c.op === 'updateRun')).toEqual([]);
  });
  it('AC-07.3: corrective action but NO later accepted run -> 409 quality.rerun_required', async () => {
    const s = setup(seedWith(withCa)); expect(code(await rejection(close(s)))).toBe('quality.rerun_required'); expect(s.fake.state.reviews).toEqual([]); expect(s.rr.calls.filter((c) => c.op === 'updateRun')).toEqual([]);
  });
  it('the guard order: corrective_action_required is answered before rerun_required (neither exists -> the first)', async () => {
    const s = setup(); expect(code(await rejection(close(s)))).toBe('quality.corrective_action_required'); expect(s.fake.callsOf('hasLaterAcceptedRun')).toEqual([]);
  });
  it('D-52: an accepted run INSIDE the window (the remainder of the same QC event, run_at <= R.run_at + run_window_minutes) does not count — exactly at the boundary too', async () => {
    for (const t of [at('08:10:00'), new Date(R_AT + WIN).toISOString()]) {
      const s = setup(seedWith((x) => { withCa(x); later(6, { run_at: t, status: 'evaluated' })(x); })); expect(code(await rejection(close(s))), t).toBe('quality.rerun_required');
    }
  });
  it('D-52: an accepted run 1 ms after the window closes the rejected run', async () => {
    const t = new Date(R_AT + WIN + 1).toISOString(); const s = setup(seedWith((x) => { withCa(x); later(6, { run_at: t })(x); })); expect((await close(s)).status).toBe(200);
  });
  it('accepted_warning counts as a rerun; incomplete, rejected, collecting and another plan\'s accepted run do not', async () => {
    const t = at('09:00:00');
    const ok = setup(seedWith((x) => { withCa(x); later(6, { run_at: t, outcome: 'accepted_warning', warning_rules: ['1-2s'] })(x); })); expect((await close(ok)).status).toBe(200);
    for (const [name, o] of [['incomplete', { outcome: 'incomplete' }], ['rejected', { outcome: 'rejected', rules_violated: ['1-3s'] }], ['collecting', { status: 'collecting', outcome: null }], ['other plan', { plan_id: PLN(2) }]] as Array<[string, Row]>) {
      const s = setup(seedWith((x) => { withCa(x); later(6, { run_at: t, ...o })(x); })); expect(code(await rejection(close(s))), name).toBe('quality.rerun_required');
    }
  });
  it('the repo is asked with this run\'s plan and the strict threshold run_at + run_window_minutes (the plan\'s window, not a constant)', async () => {
    const s = setup(seedWith((x) => { withCa(x); x.plans = [{ ...x.plans![0]!, run_window_minutes: 45 }]; })); await rejection(close(s));
    expect(s.fake.callsOf('hasLaterAcceptedRun')[0]!.args).toEqual([PLN(1), new Date(R_AT + 45 * 60_000).toISOString()]);
  });
  it('AC-07.4: with both, the run becomes `closed` with closed_at = now and closed_by = actor; 200 QcRunDto, ETag = new version; a `close` review is written with the comment', async () => {
    const s = setup(seedWith((x) => { withCa(x); later(6, { run_at: at('09:00:00') })(x); })); const r = await close(s, { body: { comment: 'Rerun passed' } });
    expect(r.status).toBe(200); expect(r.version).toBe(3);
    expect(r.body).toMatchObject({ id: RUN(1), status: 'closed', outcome: 'rejected', closed_at: NOW, needs_action: false }); expect(r.body).not.toHaveProperty('needs_action_reason');
    expect(s.fake.run(1)).toMatchObject({ status: 'closed', closed_at: NOW, closed_by: USER, version: 3 });
    expect(s.fake.state.reviews).toEqual([expect.objectContaining({ tenant_id: TENANT_A, qc_run_id: RUN(1), kind: 'close', comment: 'Rerun passed', reviewed_by_membership_id: MEM_ID })]);
    expect(r.body.reviews.map((x: Row) => x.kind)).toEqual(['close']);
  });
  it('the update is a single run-repo updateRun with ONLY status/closed_at/closed_by/updated_by — outcome, rules_violated, hold are never in the patch (frozen, S-09)', async () => {
    const s = setup(seedWith((x) => { withCa(x); later(6, { run_at: at('09:00:00') })(x); })); await close(s);
    const up = s.rr.calls.filter((c) => c.op === 'updateRun'); expect(up).toHaveLength(1); expect(up[0]!.args[1]).toEqual({ status: 'closed', closed_at: NOW, closed_by: USER, updated_by: USER });
  });
  it('the pair lock (runRepo.lockPlan on the run\'s plan) is taken BEFORE the guards are evaluated and before the update, on the request tx', async () => {
    const s = setup(seedWith((x) => { withCa(x); later(6, { run_at: at('09:00:00') })(x); })); await close(s);
    const lock = s.rr.calls.find((c) => c.op === 'lockPlan')!; expect(lock.args).toEqual([PLN(1)]); expect(lock.tx).toBe(s.ctx.tx);
    expect(s.rr.order.indexOf('lockPlan')).toBeLessThan(s.rr.order.indexOf('updateRun'));
    const firstGuard = s.fake.calls.findIndex((c) => c.op === 'hasLaterAcceptedRun'); expect(firstGuard).toBeGreaterThan(-1);
  });
  it('the run is re-read UNDER the lock: closed by someone else after the first read -> 409 common.immutable_record, no second review', async () => {
    const s = setup(seedWith((x) => { withCa(x); later(6, { run_at: at('09:00:00') })(x); }), { onLock: () => { Object.assign(s0().fake.run(1), { status: 'closed', closed_at: at('09:30:00'), closed_by: USER, version: 3 }); } });
    function s0() { return s; }
    const e = await rejection(close(s)); expect(['common.immutable_record', 'common.version_conflict']).toContain(code(e)); expect(s.fake.state.reviews).toEqual([]);
  });
  it.each([[2, 'collecting'], [3, 'accepted_warning'], [4, 'accepted'], [5, 'closed']])('RUN(%i) (%s) is not a rejected evaluated run -> 409 common.immutable_record (before any guard)', async (n) => {
    const s = setup(); expect(code(await rejection(close(s, { runId: RUN(n), expectedVersion: s.fake.run(n)['version'] })))).toBe('common.immutable_record'); expect(s.fake.callsOf('hasLaterAcceptedRun')).toEqual([]);
  });
  it('If-Match absent -> 428; stale -> 409 common.version_conflict (answered before the guards); unknown / tenant B run -> 404', async () => {
    expect(code(await rejection(close(setup(), { expectedVersion: undefined })))).toBe('common.precondition_required');
    const s = setup(); expect(code(await rejection(close(s, { expectedVersion: 1 })))).toBe('common.version_conflict'); expect(s.fake.callsOf('hasLaterAcceptedRun')).toEqual([]);
    expect(code(await rejection(close(setup(), { runId: RUN(9), expectedVersion: 2 })))).toBe('common.not_found');
  });
  it('closing twice: the second call (same If-Match) is 409 common.version_conflict; a fresh If-Match -> 409 common.immutable_record; one review only', async () => {
    const s = setup(seedWith((x) => { withCa(x); later(6, { run_at: at('09:00:00') })(x); })); await close(s);
    expect(code(await rejection(close(s)))).toBe('common.version_conflict'); expect(code(await rejection(close(s, { expectedVersion: 3 })))).toBe('common.immutable_record'); expect(s.fake.state.reviews).toHaveLength(1);
  });
  it('trigger backstop (quality.enforce_run_frozen P0001 immutable_row) -> 409 common.immutable_record; any other database error -> common.internal without the driver message', async () => {
    const mk = (err: Error) => { const s = setup(seedWith((x) => { withCa(x); later(6, { run_at: at('09:00:00') })(x); })); s.rr.repo.updateRun = async () => { throw err; }; return s; };
    expect(code(await rejection(close(mk(immutableRow()))))).toBe('common.immutable_record');
    const e = await rejection(close(mk(pgErr('08006', 'connection to host 10.0.0.5 failed')))); expect(code(e)).toBe('common.internal'); expect(String(e.message)).not.toContain('10.0.0.5');
  });
  it.each([[{ comment: 'x'.repeat(501) }], [{ status: 'closed' }], [{ outcome: 'accepted' }], [{ tenant_id: TENANT_B }]])('body %j -> 400; nothing written', async (b) => {
    const s = setup(seedWith((x) => { withCa(x); later(6, { run_at: at('09:00:00') })(x); })); expect(code(await rejection(close(s, { body: b })))).toBe('common.validation_failed'); expect(s.fake.writes()).toEqual([]); expect(s.rr.calls.filter((c) => c.op === 'updateRun')).toEqual([]);
  });
  it('AB-10 end to end: corrective action -> still not closable; accepted rerun -> closable; the rejected run no longer needs action afterwards', async () => {
    const s = setup(seedWith(later(6, { run_at: at('09:00:00') })));
    expect(code(await rejection(close(s)))).toBe('quality.corrective_action_required');
    await s.svc.recordCorrectiveAction(s.ctx, { runId: RUN(1), body: ca() });
    expect((await close(s)).status).toBe(200);
    expect((await s.svc.listQcRuns(s.ctx, { runAtFrom: at('00:00:00'), needsAction: true })).body.data.map((r: Row) => r.id)).not.toContain(RUN(1));
  });
});

describe('#33 acknowledgeQcRun (AC-07.5): a comment makes an acknowledgement row; the run shows "Reviewed"', () => {
  const ack = (s: ReturnType<typeof setup>, o: Row = {}) => s.svc.acknowledgeQcRun(s.ctx, { runId: RUN(3), body: { comment: 'Reviewed the 1-2s warning' }, ...o });
  it('AC-07.5: 201 QcRunReviewDto; stored row kind `acknowledge`, comment, reviewer = actor membership, created_by = actor, tenant from ctx', async () => {
    const s = setup(); const r = await ack(s);
    expect(r.status).toBe(201); expect(r.version).toBeUndefined(); expect(Object.keys(r.body).sort()).toEqual(REVIEW_KEYS);
    expect(r.body).toMatchObject({ qc_run_id: RUN(3), kind: 'acknowledge', comment: 'Reviewed the 1-2s warning', reviewed_by_display: 'Synthetic Technologist', created_at: NOW });
    expect(s.fake.state.reviews).toEqual([expect.objectContaining({ tenant_id: TENANT_A, qc_run_id: RUN(3), kind: 'acknowledge', comment: 'Reviewed the 1-2s warning', reviewed_by_membership_id: MEM_ID, created_by: USER })]);
    expect(JSON.stringify(r.body)).not.toContain(MEM_ID);
  });
  it('the run detail then lists the acknowledgement among its reviews (the UI "Reviewed" state)', async () => {
    const s = setup(); await ack(s); const d = await s.svc.getQcRun(s.ctx, { runId: RUN(3) });
    expect(d.body.reviews).toEqual([expect.objectContaining({ kind: 'acknowledge', comment: 'Reviewed the 1-2s warning', reviewed_by_display: 'Synthetic Technologist' })]);
  });
  it('a run that is still collecting -> 409 common.immutable_record; nothing written', async () => {
    const s = setup(); expect(code(await rejection(ack(s, { runId: RUN(2) })))).toBe('common.immutable_record'); expect(s.fake.state.reviews).toEqual([]);
  });
  it('comment is required, 1..500 code points: missing, empty and 501 -> 400 at /comment; 1 and 500 accepted', async () => {
    for (const b of [{}, { comment: '' }, { comment: 'x'.repeat(501) }, { comment: 7 }]) { const s = setup(); const e = await rejection(ack(s, { body: b })); expect(code(e)).toBe('common.validation_failed'); expect(e.errors ?? e.details).toEqual(expect.arrayContaining([expect.objectContaining({ path: '/comment' })])); expect(s.fake.state.reviews).toEqual([]); }
    expect((await ack(setup(), { body: { comment: 'x' } })).status).toBe(201); expect((await ack(setup(), { body: { comment: 'é'.repeat(500) } })).status).toBe(201);
  });
  it('unknown fields (kind, reviewed_by, tenant_id) -> 400: the kind of the row is fixed by the endpoint', async () => {
    for (const x of [{ kind: 'close' }, { reviewed_by_membership_id: MEM_ID }, { tenant_id: TENANT_B }]) { const s = setup(); expect(code(await rejection(ack(s, { body: { comment: 'ok', ...x } })))).toBe('common.validation_failed'); expect(s.fake.state.reviews).toEqual([]); }
  });
  it('tenant B\'s RUN(9) / unknown -> 404 common.not_found', async () => {
    const s = setup(); expect(code(await rejection(ack(s, { runId: RUN(9) })))).toBe('common.not_found'); expect(code(await rejection(ack(s, { runId: RUN(99) })))).toBe('common.not_found');
  });
});

describe('cross-cutting: tenant predicate, request transaction, clock, no secrets in errors', () => {
  it('every repo call carries the context tenant and the request transaction; nothing runs on another tx', async () => {
    const s = setup(seedWith((x) => { withCa(x); later(6, { run_at: at('09:00:00') })(x); }));
    await s.svc.listQcObservations(s.ctx, { observedAtFrom: at('00:00:00') }); await s.svc.listQcRuns(s.ctx, { runAtFrom: at('00:00:00') }); await s.svc.getQcRun(s.ctx, { runId: RUN(1) });
    await s.svc.excludeQcObservation(s.ctx, { observationId: OBS(2), expectedVersion: 1, body: { reason_code: 'wrong_material' } }); await s.svc.evaluateQcRunNow(s.ctx, { runId: RUN(2), expectedVersion: 1, body: {} });
    await s.svc.recordCorrectiveAction(s.ctx, { runId: RUN(1), body: ca() }); await s.svc.closeQcRun(s.ctx, { runId: RUN(1), expectedVersion: 2, body: {} }); await s.svc.acknowledgeQcRun(s.ctx, { runId: RUN(3), body: { comment: 'ok' } });
    expect(s.fake.calls.length).toBeGreaterThan(10);
    for (const c of s.fake.calls) { expect(c.tenantId, c.op).toBe(TENANT_A); expect(c.tx, c.op).toBe(s.ctx.tx); }
    for (const c of s.rr.calls) expect(c.tx, c.op).toBe(s.ctx.tx);
    expect(s.queries).toEqual([]);   // the service itself issues no SQL; it goes through the repos
  });
  it('a failed call echoes no request input in code / message / details', async () => {
    const s = setup(); const planted = 'PLANTED-TOKEN-9f3a'; const e = await rejection(s.svc.acknowledgeQcRun(s.ctx, { runId: planted, body: { comment: planted, [planted]: 1 } }));
    expect(JSON.stringify({ c: e.code, m: e.message, d: e.errors ?? e.details })).not.toContain(planted);
  });
  it('the clock is ctx.now(): a fixed context time drives closed_at, excluded_at, created_at', async () => {
    const T = '2026-11-14T03:04:05.678Z'; const s = setup(baseSeed(), { now: T });
    await s.svc.excludeQcObservation(s.ctx, { observationId: OBS(2), expectedVersion: 1, body: { reason_code: 'wrong_material' } }); await s.svc.acknowledgeQcRun(s.ctx, { runId: RUN(3), body: { comment: 'ok' } });
    expect(s.fake.obs(2)['excluded_at']).toBe(T); expect(s.fake.state.reviews[0]!['created_at']).toBe(T);
  });
  it('SYSTEM and REQ_ID are not used as actor of a staff action (the actor is the request user)', async () => {
    const s = setup(); await s.svc.acknowledgeQcRun(s.ctx, { runId: RUN(3), body: { comment: 'ok' } }); expect(s.fake.state.reviews[0]!['created_by']).not.toBe(SYSTEM); expect(REQ_ID).toBeTruthy(); expect(TENANT_B).not.toBe(TENANT_A); expect(CA(1)).not.toBe(REV(1));
  });
});
