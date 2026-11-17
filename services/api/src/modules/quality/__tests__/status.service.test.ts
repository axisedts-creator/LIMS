// C9 T-13 — status service: qcStatusFor (02-TRD §7.8 S1-S8, §11.1) and the status board #34 (§5.5, §5.10 QcStatusRowDto, §14 gauge); PRD AC-09.1-09.5; 07-SECURITY REQ-SEC-024/081/098.
// No database: fake StatusRepo (status.helpers.ts, SEAMS in its header). The pure rules themselves are domain/__tests__/qc-status.test.ts (T-05); here: wiring, tenancy, input hygiene, board.
// Fails now: "Cannot find module ../service/status.service.js" (and ../repository/status.repo.js).
import { describe, expect, it } from 'vitest';
import { createStatusService } from '../service/status.service.js';
import { ANA, BOARD_KEYS, BOARD_REQUIRED, HOUR, INS, PLANTED, PLN, RUN, T, TENANT_A, TENANT_B, UUID7, code, makeStatusCtx, makeStatusRepo, noRights, plan, readOnly, rejection, run, timelineSeed,
  type StatusSeed } from './status.helpers.js';

const setup = (seed?: StatusSeed, ctxOver: Parameters<typeof makeStatusCtx>[0] = {}) => {
  const fake = makeStatusRepo(seed); const c = makeStatusCtx({ ...ctxOver, plans: (seed ?? timelineSeed()).plans });
  return { fake, ...c, svc: createStatusService({ repo: fake.repo }) };
};
const q = (at: string, o: object = {}) => ({ instrumentId: INS(1), analyteId: ANA(1), at, ...o });

describe('qcStatusFor: the §7.8 timeline S1-S8 (AC-09.1) through the service', () => {
  const R = (n: number) => RUN(n);
  const V: Array<[string, string, string, string | undefined, string | undefined, string[] | undefined]> = [
    ['S1', T('00:30:00'), 'no_qc_data', undefined, undefined, undefined],
    ['S2', T('03:00:00'), 'in_control', T('01:00:00'), R(1), undefined],
    ['S3', T('07:00:00'), 'warning', T('06:00:00'), R(2), ['1-2s']],
    ['S4', T('09:30:00'), 'out_of_control', T('06:00:00'), R(3), ['1-3s']],
    ['S5', T('10:15:00'), 'out_of_control', T('10:00:00'), R(3), ['1-3s']],
    ['S6', T('11:00:00'), 'in_control', T('10:00:00'), R(4), undefined],
    ['S7', T('15:00:00'), 'warning', T('10:00:00'), R(5), ['incomplete_run']],
    ['S8', T('10:30:00', '2026-11-06'), 'no_qc_data', T('10:00:00'), R(5), ['incomplete_run']],
  ];
  it.each(V)('%s at %s -> %s', async (_id, at, status, last, current, rules) => {
    const s = setup();
    const r = await s.svc.qcStatusFor(s.ctx, q(at));
    expect(r).toEqual({ status, ...(last ? { lastInControlRunAt: last } : {}), ...(current ? { currentRunId: current } : {}), ...(rules ? { violatedRules: rules } : {}) });
    // absent values are absent KEYS (the port contract), never undefined / null
    expect(Object.keys(r).sort()).toEqual(Object.keys({ status, ...(last ? { lastInControlRunAt: 1 } : {}), ...(current ? { currentRunId: 1 } : {}), ...(rules ? { violatedRules: 1 } : {}) }).sort());
  });
  it('AC-09.3 / port case 8: an open rejected run masks a newer accepted run (S5) and stays out_of_control however old it is', async () => {
    const s = setup({ plans: [plan(1)], runs: [run(1, PLN(1), 'rejected', T('02:00:00'), { rules_violated: ['1-3s'] }), run(2, PLN(1), 'accepted', T('03:00:00'))] });
    expect(await s.svc.qcStatusFor(s.ctx, q(T('04:15:00')))).toMatchObject({ status: 'out_of_control', currentRunId: RUN(1), violatedRules: ['1-3s'], lastInControlRunAt: T('03:00:00') });
    expect((await s.svc.qcStatusFor(s.ctx, q('2026-12-31T00:00:00.000Z'))).status).toBe('out_of_control');   // no staleness applies to an open rejection
  });
  it('an open rejected run older than the 20 latest runs still wins (the open set is read separately from the latest-20 window, §7.8 query note)', async () => {
    const runs = [run(1, PLN(1), 'rejected', '2026-11-01T01:00:00.000Z', { rules_violated: ['R-4s'] })];
    for (let i = 0; i < 25; i++) runs.push(run(100 + i, PLN(1), 'accepted', `2026-11-05T${String(i % 24).padStart(2, '0')}:30:00.000Z`));
    const s = setup({ plans: [plan(1)], runs });
    expect(await s.svc.qcStatusFor(s.ctx, q(T('23:59:00')))).toMatchObject({ status: 'out_of_control', currentRunId: RUN(1), violatedRules: ['R-4s'] });
  });
  it('AC-09.4: the validity comes from the plan (48 h makes S8 a warning again; exactly the validity is still valid)', async () => {
    const s = setup({ ...timelineSeed(), plans: [plan(1, { qc_validity_hours: 48 })] });
    expect(await s.svc.qcStatusFor(s.ctx, q(T('10:30:00', '2026-11-06')))).toMatchObject({ status: 'warning', currentRunId: RUN(5) });
    const e = setup({ plans: [plan(1)], runs: [run(1, PLN(1), 'accepted', T('10:00:00'))] });
    expect((await e.svc.qcStatusFor(e.ctx, q(T('10:00:00', '2026-11-06')))).status).toBe('in_control');
    expect((await e.svc.qcStatusFor(e.ctx, q('2026-11-06T10:00:00.001Z'))).status).toBe('no_qc_data');
  });
  it('a plan with no run, a plan whose runs are only collecting, and an inactive plan still found (step 1 "any status")', async () => {
    const a = setup({ plans: [plan(1)], runs: [] }); expect(await a.svc.qcStatusFor(a.ctx, q(T('12:00:00')))).toEqual({ status: 'no_qc_data' });
    const b = setup({ plans: [plan(1)], runs: [run(1, PLN(1), null, T('11:00:00'), { status: 'collecting' })] }); expect(await b.svc.qcStatusFor(b.ctx, q(T('12:00:00')))).toEqual({ status: 'no_qc_data' });
    const c = setup({ plans: [plan(1, { status: 'inactive' })], runs: [run(1, PLN(1), 'accepted', T('11:00:00'))] }); expect((await c.svc.qcStatusFor(c.ctx, q(T('12:00:00')))).status).toBe('in_control');
  });
  it('no plan for the pair -> no_qc_data and the runs are not even read', async () => {
    const s = setup();
    expect(await s.svc.qcStatusFor(s.ctx, { instrumentId: INS(7), analyteId: ANA(7), at: T('12:00:00') })).toEqual({ status: 'no_qc_data' });
    expect(s.fake.ops()).toEqual(['findPlanForPair']);
  });
});

describe('qcStatusFor: port semantics (03-IC §4.11, 02-TRD §11.1) — tenancy, read-only, no permission, input hygiene', () => {
  it('reads with the caller tx and the tenant of ctx only: at most two repo calls, both on ctx.tx / ctx.tenantId; the runs call gets exactly [planId] and `at`', async () => {
    const s = setup(); await s.svc.qcStatusFor(s.ctx, q(T('03:00:00')));
    expect(s.fake.ops()).toEqual(['findPlanForPair', 'listRunsForStatus']);
    for (const c of s.fake.calls) { expect(c.tx).toBe(s.ctx.tx); expect(c.tenantId).toBe(TENANT_A); }
    expect(s.fake.calls[1]!.args).toEqual([[PLN(1)], T('03:00:00')]);
  });
  it('port case 12: another tenant\'s plan is invisible -> no_qc_data; a tenantId smuggled in the input is ignored (REQ-SEC-024)', async () => {
    const s = setup(undefined, { tenantId: TENANT_B });
    expect(await s.svc.qcStatusFor(s.ctx, q(T('12:00:00')))).toEqual({ status: 'no_qc_data' });
    expect(await s.svc.qcStatusFor(s.ctx, { ...q(T('12:00:00')), tenantId: TENANT_A } as any)).toEqual({ status: 'no_qc_data' });
    for (const c of s.fake.calls) expect(c.tenantId).toBe(TENANT_B);
  });
  it('performs no permission check and reads no settings / identity (the C5 caller authorised its own action); writes nothing (no tx statement at all from the service itself)', async () => {
    const s = setup(); await s.svc.qcStatusFor(s.ctx, q(T('03:00:00')));
    expect(s.asserted).toEqual([]); expect(s.queries).toEqual([]);
    const noPorts = { ...s.ctx, ports: new Proxy({}, { get() { throw new Error('port touched'); } }) };
    expect((await s.svc.qcStatusFor(noPorts, q(T('03:00:00')))).status).toBe('in_control');
  });
  it('does not mutate its input and returns a fresh object each call', async () => {
    const s = setup(); const input = Object.freeze(q(T('07:00:00')));
    const a: any = await s.svc.qcStatusFor(s.ctx, input); a.violatedRules.push('x'); a.status = 'in_control';
    expect(await s.svc.qcStatusFor(s.ctx, input)).toMatchObject({ status: 'warning', violatedRules: ['1-2s'] });
  });
  it.each([[{ instrumentId: 'not-a-uuid' }], [{ analyteId: 'x' }], [{ instrumentId: undefined }], [{ analyteId: null }], [{ at: '2026-11-05' }], [{ at: 'garbage' }], [{ at: '2026-11-05T04:15:00+05:45' }], [{ at: 12345 }], [{ at: undefined }], [{ instrumentId: { $ne: 1 } }]])(
    'bad input %j -> common.validation_failed before any repo call', async (o) => {
      const s = setup(); const e = await rejection(s.svc.qcStatusFor(s.ctx, { ...q(T('03:00:00')), ...o } as any));
      expect(code(e)).toBe('common.validation_failed'); expect(s.fake.calls).toEqual([]);
    });
  it('a missing / empty input object is common.validation_failed too (the port throws only validation_failed / internal)', async () => {
    for (const bad of [undefined, null, {}, 'x']) { const s = setup(); expect(code(await rejection(s.svc.qcStatusFor(s.ctx, bad as any)))).toBe('common.validation_failed'); }
  });
  it('a repo failure surfaces as common.internal with no SQL / driver text; a LimsError passes through unchanged', async () => {
    const s = setup(); s.fake.repo.findPlanForPair = async () => { throw new Error(`relation quality.qc_plans does not exist ${PLANTED}`); };
    const e = await rejection(s.svc.qcStatusFor(s.ctx, q(T('03:00:00'))));
    expect(code(e)).toBe('common.internal'); expect(JSON.stringify({ m: e?.message, d: e?.detail })).not.toMatch(/relation|PLANTED|qc_plans/);
    const t = setup(); t.fake.repo.listRunsForStatus = async () => { throw Object.assign(new Error('x'), { code: 'common.dependency_unavailable' }); };
    expect(code(await rejection(t.svc.qcStatusFor(t.ctx, q(T('03:00:00')))))).toBe('common.dependency_unavailable');
  });
});

describe('status board #34 (TRD §5.5, §5.10; AC-09.5)', () => {
  const NOW = T('15:00:00');
  const A = (planN: number, o: object = {}) => ({ tenant_id: TENANT_A, plan_id: PLN(planN), ...o });
  function boardSeed(): StatusSeed {
    const tl = timelineSeed();
    return {
      plans: [plan(1), plan(2), plan(3), plan(4, { status: 'inactive' }), plan(5), plan(6), plan(7), plan(9, { tenant_id: TENANT_B })],
      runs: [
        ...tl.runs!,                                                                                                                         // PLN(1): at 15:00 -> S7 warning R5 [incomplete_run]
        run(11, PLN(3), 'accepted', T('01:00:00')), run(12, PLN(3), 'rejected', T('12:00:00'), { rules_violated: ['1-3s'] }),                    // open rejection
        run(13, PLN(3), 'rejected', T('11:00:00'), { status: 'closed', closed_at: T('11:30:00'), rules_violated: ['2-2s'] }),                    // closed: not open
        run(14, PLN(5), 'accepted', T('14:00:00')), run(15, PLN(6), 'accepted', T('14:00:00')), run(16, PLN(7), 'accepted', T('14:00:00')),
        run(19, PLN(9), 'rejected', T('12:00:00'), { tenant_id: TENANT_B, rules_violated: ['1-3s'] }),
      ],
      activity: [
        A(1, { patient_results_since_last_qc: 12, last_patient_result_at: T('14:50:00'), last_qc_run_at: T('10:00:00') }),                       // fresh QC: not overdue
        A(2, { patient_results_since_last_qc: 7, last_patient_result_at: T('14:30:00'), last_qc_run_at: '2026-11-03T10:00:00.000Z' }),          // 53 h old + patients: overdue
        A(3, { patient_results_since_last_qc: 4, last_patient_result_at: T('14:00:00'), last_qc_run_at: null }),                                // never QC'd + patients: overdue
        A(4, { patient_results_since_last_qc: 9, last_qc_run_at: null }),                                                                       // inactive plan: neither listed nor counted
        A(5, { patient_results_since_last_qc: 0, last_qc_run_at: '2026-11-01T00:00:00.000Z' }),                                                 // old QC but no patients: not overdue
        A(6, { patient_results_since_last_qc: 3, last_patient_result_at: T('14:59:00'), last_qc_run_at: new Date(Date.parse(NOW) - 24 * HOUR).toISOString() }),             // exactly 24 h: not overdue (strict)
        A(7, { patient_results_since_last_qc: 3, last_patient_result_at: T('14:59:00'), last_qc_run_at: new Date(Date.parse(NOW) - 24 * HOUR - 1).toISOString() }),         // 24 h + 1 ms: overdue
        A(9, { tenant_id: TENANT_B, patient_results_since_last_qc: 50, last_qc_run_at: null }),
      ],
      instruments: [{ tenant_id: TENANT_A, instrument_id: INS(1), instrument_code: 'SYN-AN-1', display_name: 'Synthetic Analyzer' }, { tenant_id: TENANT_B, instrument_id: INS(2), instrument_code: 'LEAK', display_name: 'Other Tenant Analyzer' }],
    };
  }
  const board = (s: ReturnType<typeof setup>, input: object = {}) => s.svc.getQcStatusBoard(s.ctx, input as any);
  const rowOf = (r: any, n: number) => r.body.data.find((x: any) => x.plan_id === PLN(n));

  it('permission: assertRole quality.qc_run.read FIRST, before any repo call; no rights -> auth.forbidden and nothing is read, no gauge set', async () => {
    const s = setup(boardSeed(), { now: NOW, roles: noRights });
    expect(code(await rejection(board(s)))).toBe('auth.forbidden'); expect(s.fake.calls).toEqual([]); expect(s.sets).toEqual([]);
    expect(s.asserted[0]).toMatchObject({ permission: 'quality.qc_run.read' });
    const ok = setup(boardSeed(), { now: NOW, roles: readOnly });
    expect((await board(ok)).status).toBe(200);
  });
  it('lists the ACTIVE plans of THIS tenant only, ordered by (instrument_id, analyte_code, plan_id); generated_at = ctx.now(); page.limit 50 and no next_cursor', async () => {
    const s = setup(boardSeed(), { now: NOW }); const r: any = await board(s);
    expect(r.status).toBe(200);
    expect(r.body.data.map((x: any) => x.plan_id)).toEqual([PLN(1), PLN(2), PLN(3), PLN(5), PLN(6), PLN(7)]);   // not PLN(4) inactive, not PLN(9) tenant B
    expect(r.body.generated_at).toBe(NOW); expect(r.body.page).toEqual({ limit: 50 });
    expect(Object.keys(r.body).sort()).toEqual(['data', 'generated_at', 'page']);
    for (const c of s.fake.calls) { expect(c.tenantId).toBe(TENANT_A); expect(c.tx).toBe(s.ctx.tx); }
  });
  it('row = QcStatusRowDto allowlist (no tenant_id, no internal column, no run internals); required keys always present; absent optional values are absent keys', async () => {
    const s = setup(boardSeed(), { now: NOW }); const r: any = await board(s);
    for (const row of r.body.data) {
      expect(Object.keys(row).every((k) => BOARD_KEYS.includes(k)), JSON.stringify(Object.keys(row))).toBe(true);
      for (const k of BOARD_REQUIRED) expect(row, k).toHaveProperty(k);
      for (const k of Object.keys(row)) expect(row[k], k).not.toBeUndefined();
      expect(typeof row.qc_overdue).toBe('boolean'); expect(Number.isInteger(row.patient_results_since_last_qc)).toBe(true);
    }
    const all = JSON.stringify(r.body); for (const k of ['tenant_id', 'internal_note', PLANTED, 'created_by', 'rule_detail', 'LEAK']) expect(all, k).not.toContain(k);
  });
  it('status per §7.8 at ctx.now(): PLN(1) is S7 (warning, R5, [incomplete_run], last in control 10:00); PLN(2) no runs -> no_qc_data; PLN(3) open rejection -> out_of_control', async () => {
    const s = setup(boardSeed(), { now: NOW }); const r: any = await board(s);
    expect(rowOf(r, 1)).toMatchObject({ status: 'warning', current_run_id: RUN(5), violated_rules: ['incomplete_run'], last_in_control_run_at: T('10:00:00'), open_rejected_run_ids: [], instrument_label: 'Synthetic Analyzer (SYN-AN-1)' });
    expect(rowOf(r, 2)).toMatchObject({ status: 'no_qc_data', violated_rules: [], open_rejected_run_ids: [] });
    expect(rowOf(r, 2)).not.toHaveProperty('current_run_id'); expect(rowOf(r, 2)).not.toHaveProperty('last_in_control_run_at');
    expect(rowOf(r, 3)).toMatchObject({ status: 'out_of_control', current_run_id: RUN(12), violated_rules: ['1-3s'], open_rejected_run_ids: [RUN(12)], last_in_control_run_at: T('01:00:00') });
  });
  it('open_rejected_run_ids lists every open rejected run (not only the latest), never a closed one', async () => {
    const seed = boardSeed(); seed.runs!.push(run(20, PLN(3), 'rejected', T('13:00:00'), { rules_violated: ['R-4s'] }));
    const s = setup(seed, { now: NOW }); const r: any = await board(s);
    expect([...rowOf(r, 3).open_rejected_run_ids].sort()).toEqual([RUN(12), RUN(20)].sort()); expect(rowOf(r, 3).current_run_id).toBe(RUN(20));
  });
  it('AC-09.5: patients since QC + last_patient_result_at come from qc_activity; qc_overdue = patients since > 0 and QC older than the plan validity (strict) or never run; no activity row -> 0, not overdue', async () => {
    const s = setup(boardSeed(), { now: NOW }); const r: any = await board(s);
    expect(rowOf(r, 1)).toMatchObject({ patient_results_since_last_qc: 12, last_patient_result_at: T('14:50:00'), qc_overdue: false });
    expect(rowOf(r, 2)).toMatchObject({ patient_results_since_last_qc: 7, qc_overdue: true });
    expect(rowOf(r, 3)).toMatchObject({ patient_results_since_last_qc: 4, qc_overdue: true });
    expect(rowOf(r, 5)).toMatchObject({ patient_results_since_last_qc: 0, qc_overdue: false });
    expect(rowOf(r, 6).qc_overdue).toBe(false); expect(rowOf(r, 7).qc_overdue).toBe(true);
    const bare = setup({ plans: [plan(1)], runs: [] }, { now: NOW }); const b: any = await board(bare);
    expect(b.body.data[0]).toMatchObject({ patient_results_since_last_qc: 0, qc_overdue: false }); expect(b.body.data[0]).not.toHaveProperty('last_patient_result_at');
  });
  it('the overdue window uses the plan\'s own validity (PLN(2) with 100 h: 53 h old QC is not overdue)', async () => {
    const seed = boardSeed(); seed.plans = seed.plans!.map((p) => (p.id === PLN(2) ? { ...p, qc_validity_hours: 100 } : p));
    const s = setup(seed, { now: NOW }); expect(rowOf(await board(s), 2).qc_overdue).toBe(false);
  });
  it('gauge lims_quality_qc_overdue_pairs{tenant_id} = overdue pairs of the WHOLE tenant (here 3), set once, unaffected by filters and paging; 0 when none (so the alert clears)', async () => {
    const s = setup(boardSeed(), { now: NOW }); await board(s);
    expect(s.sets).toEqual([{ name: 'lims_quality_qc_overdue_pairs', value: 3, labels: { tenant_id: TENANT_A } }]);
    const f = setup(boardSeed(), { now: NOW }); await board(f, { status: 'in_control', limit: 1 });
    expect(f.sets).toEqual([{ name: 'lims_quality_qc_overdue_pairs', value: 3, labels: { tenant_id: TENANT_A } }]);
    const z = setup({ plans: [plan(1)], runs: [] }, { now: NOW }); await board(z); expect(z.sets).toEqual([{ name: 'lims_quality_qc_overdue_pairs', value: 0, labels: { tenant_id: TENANT_A } }]);
  });
  it('a missing ctx.metrics is fine (no crash); the board still answers', async () => {
    const s = setup(boardSeed(), { now: NOW, metrics: false }); expect((await board(s)).status).toBe(200);
  });
  it('filters: instrument_id; status csv (any of); overdue_only; all combined with AND', async () => {
    const s = setup(boardSeed(), { now: NOW });
    expect((await board(s, { instrumentId: INS(3) }) as any).body.data.map((x: any) => x.plan_id)).toEqual([PLN(3)]);
    expect((await board(s, { status: 'out_of_control,warning' }) as any).body.data.map((x: any) => x.plan_id)).toEqual([PLN(1), PLN(3)]);
    expect((await board(s, { overdueOnly: true }) as any).body.data.map((x: any) => x.plan_id)).toEqual([PLN(2), PLN(3), PLN(7)]);
    expect((await board(s, { overdueOnly: true, status: 'no_qc_data' }) as any).body.data.map((x: any) => x.plan_id)).toEqual([PLN(2)]);
    expect((await board(s, { overdueOnly: false }) as any).body.data).toHaveLength(6);
  });
  it.each([[{ instrumentId: 'x' }], [{ status: 'bogus' }], [{ status: 'in_control,' }], [{ status: 'in_control,in_control,in_control,in_control,in_control' }], [{ overdueOnly: 'yes' }], [{ limit: 0 }], [{ limit: 201 }], [{ limit: 1.5 }]])(
    'bad query %j -> 400 common.validation_failed, nothing read', async (o) => {
      const s = setup(boardSeed(), { now: NOW }); expect(code(await rejection(board(s, o)))).toBe('common.validation_failed'); expect(s.fake.calls).toEqual([]); expect(s.sets).toEqual([]);
    });
  it('pagination: limit 2 over 6 rows -> pages of 2 with next_cursor until the end; the union is the full list, no duplicate, no gap; the same walk works under a filter', async () => {
    const walk = async (extra: object) => {
      const s = setup(boardSeed(), { now: NOW }); const ids: string[] = []; let cursor: string | undefined; let pages = 0;
      do { const r: any = await board(s, { ...extra, limit: 2, ...(cursor ? { cursor } : {}) }); expect(r.body.data.length).toBeLessThanOrEqual(2); ids.push(...r.body.data.map((x: any) => x.plan_id)); cursor = r.body.page.next_cursor; pages++; expect(r.body.page.limit).toBe(2); } while (cursor && pages < 10);
      return { ids, pages };
    };
    expect(await walk({})).toEqual({ ids: [PLN(1), PLN(2), PLN(3), PLN(5), PLN(6), PLN(7)], pages: 3 });
    expect((await walk({ status: 'no_qc_data' })).ids.sort()).toEqual([PLN(2)]);
    expect((await walk({ overdueOnly: true })).ids).toEqual([PLN(2), PLN(3), PLN(7)]);
    const last = setup(boardSeed(), { now: NOW }); const r: any = await board(last, { limit: 200 }); expect(r.body.page).toEqual({ limit: 200 });
  });
  it('a malformed or foreign cursor -> 400 common.invalid_cursor (never a crash, never rows of another tenant)', async () => {
    for (const c of ['garbage', 'AAAA', Buffer.from('{"x":1}').toString('base64url'), Buffer.from(JSON.stringify(['id', 'not-a-uuid'])).toString('base64url')]) {
      const s = setup(boardSeed(), { now: NOW }); expect(code(await rejection(board(s, { cursor: c }))), c).toBe('common.invalid_cursor');
    }
  });
  it('query budget: exactly four repo calls whatever the number of plans (no N+1); the runs call gets every active plan id once', async () => {
    const plans = Array.from({ length: 40 }, (_, i) => plan(i + 1, { analyte_code: `A${i}` }));
    const s = setup({ plans, runs: [], activity: [] }, { now: NOW }); await board(s);
    expect(s.fake.ops().sort()).toEqual(['listActivity', 'listBoardPlans', 'listInstrumentLabels', 'listRunsForStatus']);
    const runsCall = s.fake.calls.find((c) => c.op === 'listRunsForStatus')!; expect([...(runsCall.args[0] as string[])].sort()).toEqual(plans.map((p) => p.id).sort()); expect(runsCall.args[1]).toBe(NOW);
  });
  it('tenant B sees only tenant B (and none of A\'s instrument labels); every repo call carries the ctx tenant', async () => {
    const s = setup(boardSeed(), { now: NOW, tenantId: TENANT_B }); const r: any = await board(s);
    expect(r.body.data.map((x: any) => x.plan_id)).toEqual([PLN(9)]); expect(r.body.data[0]).toMatchObject({ status: 'out_of_control', patient_results_since_last_qc: 50, qc_overdue: true });
    expect(JSON.stringify(r.body)).not.toContain('Synthetic Analyzer'); for (const c of s.fake.calls) expect(c.tenantId).toBe(TENANT_B);
    expect(s.sets).toEqual([{ name: 'lims_quality_qc_overdue_pairs', value: 1, labels: { tenant_id: TENANT_B } }]);
  });
  it('an instrument without a directory label has no instrument_label key (never the raw id, never null)', async () => {
    const s = setup(boardSeed(), { now: NOW }); const r: any = await board(s); expect(rowOf(r, 2)).not.toHaveProperty('instrument_label'); expect(rowOf(r, 2).instrument_id).toBe(INS(2)); expect(Object.entries(rowOf(r, 2)).filter(([k, v]) => k !== 'instrument_id' && JSON.stringify(v).includes(INS(2)))).toEqual([]); // per C9.T-13-ruling.md: INS(2) allowed only as instrument_id
  });
  it('an empty tenant: 200 with data [] (the UI shows "No QC plans yet"), not an error; row ids are uuids', async () => {
    const e = setup({ plans: [], runs: [] }, { now: NOW }); expect((await board(e) as any).body.data).toEqual([]);
    const s = setup(boardSeed(), { now: NOW }); for (const row of ((await board(s)) as any).body.data) { expect(row.plan_id).toMatch(UUID7); expect(row.instrument_id).toMatch(UUID7); }
  });
  it('a repo failure surfaces as common.internal without SQL text and sets no gauge', async () => {
    const s = setup(boardSeed(), { now: NOW }); s.fake.repo.listActivity = async () => { throw new Error('syntax error at or near SELECT'); };
    const e = await rejection(board(s)); expect(code(e)).toBe('common.internal'); expect(String(e?.message)).not.toMatch(/syntax|SELECT/); expect(s.sets).toEqual([]);
  });
});
