// C9 T-13 — QualityPort.qcStatusFor on the module's own port: shared contract (packages/fakes/contract-tests/QualityPort.contract.ts, IC §4.11) cases 1, 6, 7, 8, 9, 12 + the P95 <= 10 ms perf check
// (06-PLAN T-13 done_when; 02-TRD §11.1, §13; PRD AC-09.1-09.4, AC-13.6 for qcStatusFor). T-13 replaces the T-01 stub-equivalent qcStatusFor (08 A17 P-20); canAutoVerify stays the stub until T-16.
// SEAMS (status.helpers.ts header): ../ports/QualityPort.impl.ts exports `qualityPort` (manifest.ports.QualityPort; real default wiring: status service + status repo on ctx.tx) and
// `createQualityPort({ status })` (inject a status service). The shared contract suite cannot select single cases, so the phase1Stub subset (cases 1, 7, 9, 11, 12) runs through it and the two cases it
// SKIPS for a stub and that belong to T-13 — (6) and (8) — are copied here verbatim (same ids, same seed shape). Cases 2-5, 10, 11-full are T-16's.
// Fails now: "createQualityPort is not a function" / cases 6, 8 and the default-wiring tests answer the stub's no_qc_data.
import { describe, expect, it } from 'vitest';
import { runQualityPortContract } from '../../../../../../packages/fakes/contract-tests/QualityPort.contract';
import { makeCtxFor, type ContractHarness } from '../../../../../../packages/fakes/src/harness';
import { createEventSpy } from '../../../../../../packages/fakes/src/event-spy';
import { manifest } from '../index.js';
import { createQualityPort, qualityPort } from '../ports/QualityPort.impl.js';
import { createStatusService } from '../service/status.service.js';
import { ANA, INS, PLN, RUN, T, TENANT_A, code, rejection, timelineSeed, type RunSeed, type StatusRepo, type StatusSeed } from './status.helpers.js';
import { makeStatusRepo } from './status.helpers.js';

// ---- contract harness: the shared suite's seed shape -> the fake StatusRepo behind the real status service behind the real port --------------------------------------------------------
interface CPlan { id: string; tenantId: string; instrumentId: string; analyteId: string; validityHours: number; runs: Array<{ runId: string; at: string; outcome: string; violatedRules?: string[] }> }
const harness = (): (() => Promise<ContractHarness>) => async () => {
  const events = createEventSpy();
  const seeded: StatusSeed = { plans: [], runs: [], activity: [] };
  const fake = makeStatusRepo(seeded);
  const impl = createQualityPort({ status: createStatusService({ repo: fake.repo }) });
  return {
    impl, events, ctxFor: makeCtxFor(),
    async seed(fx: any) {
      for (const p of (fx.qcPlans ?? []) as CPlan[]) {
        fake.state.plans = fake.state.plans.filter((x) => x.id !== p.id);
        fake.state.runs = fake.state.runs.filter((r) => r.plan_id !== p.id);
        fake.state.plans.push({ id: p.id, tenant_id: p.tenantId, instrument_id: p.instrumentId, analyte_id: p.analyteId, qc_validity_hours: p.validityHours, status: 'active' });
        for (const r of p.runs) fake.state.runs.push({ id: r.runId, tenant_id: p.tenantId, plan_id: p.id, status: 'evaluated', outcome: r.outcome === 'warning' ? 'accepted_warning' : r.outcome, run_at: r.at, closed_at: null, rules_violated: r.violatedRules ?? [] });
      }
    },
    rollback(tx: unknown) { events.rollback(tx); },
  };
};

runQualityPortContract(harness(), { phase1Stub: true });   // cases 1, 7, 9, 11, 12 on the module's own port (qcStatusFor cases 7, 9, 12 are now answered from data, see below)

const NOW = '2026-11-05T04:15:00.000Z';
const IN = '01900000-0000-7000-8000-0000000c9001', AN = '01900000-0000-7000-8000-0000000c9002', PLAN = '01900000-0000-7000-8000-0000000c9003';
const R_OK = '01900000-0000-7000-8000-0000000c9101', R_BAD = '01900000-0000-7000-8000-0000000c9102', R_WARN = '01900000-0000-7000-8000-0000000c9103';

describe('QualityPort contract (IC §4.11) — cases the phase1Stub subset skips, owned by T-13', () => {
  const setup = async () => { const h = await harness()(); const A = h.ctxFor('A').tenantId; return { h, A, ctx: () => h.ctxFor('A:system') }; };
  const plan = (A: string, runs: object[]) => ({ id: PLAN, tenantId: A, instrumentId: IN, analyteId: AN, validityHours: 24, runs });
  it('(6) qcStatusFor with only 1-2s → warning', async () => {
    const { h, A, ctx } = await setup();
    await h.seed({ qcPlans: [plan(A, [{ runId: R_WARN, at: '2026-11-05T02:00:00.000Z', outcome: 'warning', violatedRules: ['1-2s'] }])] });
    const q = await h.impl.qcStatusFor(ctx(), { instrumentId: IN, analyteId: AN, at: NOW });
    expect(q.status).toBe('warning');
  });
  it('(8) open rejected run masks a newer accepted run', async () => {
    const { h, A, ctx } = await setup();
    await h.seed({ qcPlans: [plan(A, [{ runId: R_BAD, at: '2026-11-05T02:00:00.000Z', outcome: 'rejected', violatedRules: ['1-3s'] }, { runId: R_OK, at: '2026-11-05T03:00:00.000Z', outcome: 'accepted' }])] });
    const q = await h.impl.qcStatusFor(ctx(), { instrumentId: IN, analyteId: AN, at: NOW });
    expect(q.status).toBe('out_of_control'); expect(q.currentRunId).toBe(R_BAD);
  });
  it('(7)/(9)/(12) answered from DATA, not by the stub: an accepted run 2 h old is in_control at NOW (so the "no_qc_data" of 7/9/12 is earned by time, staleness and tenancy)', async () => {
    const { h, A, ctx } = await setup();
    await h.seed({ qcPlans: [plan(A, [{ runId: R_OK, at: '2026-11-05T02:00:00.000Z', outcome: 'accepted' }])] });
    expect(await h.impl.qcStatusFor(ctx(), { instrumentId: IN, analyteId: AN, at: NOW })).toEqual({ status: 'in_control', lastInControlRunAt: '2026-11-05T02:00:00.000Z', currentRunId: R_OK });
    expect((await h.impl.qcStatusFor(ctx(), { instrumentId: IN, analyteId: AN, at: '2026-11-01T00:00:00.000Z' })).status).toBe('no_qc_data');   // case 7
    expect((await h.impl.qcStatusFor(h.ctxFor('B:system'), { instrumentId: IN, analyteId: AN, at: NOW })).status).toBe('no_qc_data');            // case 12 (tenant B)
  });
});

describe('manifest.ports.QualityPort is the real qcStatusFor (T-01 stub-equivalent replaced)', () => {
  const h = makeCtxFor();
  const input = { instrumentId: INS(1), analyteId: ANA(1), at: T('03:00:00') };
  it('manifest.ports.QualityPort === qualityPort; both methods are functions; no fake controls exposed', () => {
    expect((manifest.ports as any).QualityPort).toBe(qualityPort);
    for (const m of ['canAutoVerify', 'qcStatusFor']) expect(typeof (qualityPort as any)[m], m).toBe('function');
    for (const c of ['failNext', 'latency', 'calls', 'reset', 'seed', 'fixtures', '__seed', '__rollback']) expect((qualityPort as any)[c], c).toBeUndefined();
    expect(typeof createQualityPort).toBe('function');
  });
  it('createQualityPort delegates qcStatusFor to the injected status service with (ctx, input) and returns its result unchanged; canAutoVerify is still the T-01 stub (T-16 replaces it)', async () => {
    const seen: unknown[][] = []; const result = { status: 'warning', currentRunId: RUN(2), violatedRules: ['1-2s'] };
    const p: any = createQualityPort({ status: { async qcStatusFor(...a: unknown[]) { seen.push(a); return result; } } as any });
    const ctx = h('A:system');
    expect(await p.qcStatusFor(ctx, input)).toEqual(result); expect(seen).toEqual([[ctx, input]]);
    expect(await p.canAutoVerify(ctx, {})).toEqual({ decision: 'deny', reasons: ['feature_disabled'] });
  });
  it('DEFAULT wiring end to end (real service + real repo on ctx.tx; a scripted tx stands in for Postgres): plan row + run rows -> S2 in_control, S4 out_of_control', async () => {
    const seed = timelineSeed(); const planRow = { plan_id: PLN(1), qc_validity_hours: 24 };
    const statements: Array<{ text: string; values: unknown[] }> = [];
    const tx = { async query(text: string, values: unknown[] = []) {
      statements.push({ text, values });
      if (/qc_plan_versions/.test(text)) return { rows: [planRow] };
      if (/FROM quality\.qc_runs/i.test(text)) { const at = values.find((v) => typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v)) as string;
        return { rows: seed.runs!.filter((r) => (r.status === 'evaluated' || r.status === 'closed') && Date.parse(r.run_at) <= Date.parse(at)).map((r) => ({ plan_id: r.plan_id, id: r.id, status: r.status, outcome: r.outcome, run_at: r.run_at, closed_at: r.closed_at ?? null, rules_violated: r.rules_violated ?? [] })) }; }
      return { rows: [] };
    } };
    const ctx = h('A:system', { tx: tx as any });
    expect(await qualityPort.qcStatusFor(ctx, { ...input, at: T('03:00:00') })).toEqual({ status: 'in_control', lastInControlRunAt: T('01:00:00'), currentRunId: RUN(1) });
    expect(await qualityPort.qcStatusFor(ctx, { ...input, at: T('09:30:00') })).toEqual({ status: 'out_of_control', lastInControlRunAt: T('06:00:00'), currentRunId: RUN(3), violatedRules: ['1-3s'] });
    for (const s of statements) { expect(s.text, s.text).toMatch(/^\s*(SELECT|WITH)\b/i); expect(s.values, s.text).toContain(ctx.tenantId); }
    expect(statements.length).toBeLessThanOrEqual(4);   // <= 2 statements per call
  });
  it('input validation happens BEFORE the transaction is touched: a bad input is common.validation_failed (never internal) even when ctx.tx would throw', async () => {
    const tx = new Proxy({}, { get() { throw new Error('ctx.tx touched'); } });
    for (const bad of [{}, { ...input, instrumentId: 'nope' }, { ...input, at: 'yesterday' }]) expect(code(await rejection(qualityPort.qcStatusFor(h('A:system', { tx: tx as any }), bad as any))), JSON.stringify(bad)).toBe('common.validation_failed');
  });
  it('a failing transaction surfaces as common.internal (fail closed: C5 must never read a failure as in_control) with no driver text', async () => {
    const tx = { async query() { throw new Error('relation "quality.qc_plans" does not exist PLANTED-SQL'); } };
    const e = await rejection(qualityPort.qcStatusFor(h('A:system', { tx: tx as any }), input));
    expect(code(e)).toBe('common.internal'); expect(JSON.stringify({ m: e?.message, d: e?.detail })).not.toMatch(/relation|PLANTED|qc_plans/);
  });
  it('answers while LIMS_QUALITY_ENABLED=false (the port always answers; only the HTTP routes are gated, 02-TRD §12.2)', async () => {
    const was = process.env['LIMS_QUALITY_ENABLED'];
    try {
      for (const v of [undefined, 'false', 'true']) {
        if (v === undefined) delete process.env['LIMS_QUALITY_ENABLED']; else process.env['LIMS_QUALITY_ENABLED'] = v;
        const tx = { async query() { return { rows: [] }; } };
        expect(await qualityPort.qcStatusFor(h('A:system', { tx: tx as any }), input), String(v)).toEqual({ status: 'no_qc_data' });
      }
    } finally { if (was === undefined) delete process.env['LIMS_QUALITY_ENABLED']; else process.env['LIMS_QUALITY_ENABLED'] = was; }
  });
});

describe('perf: qcStatusFor p95 <= 10 ms in-process at 10x seed volume (03-IC §4.11, 02-TRD §13: "<= 20 run rows via index"; AC-13.6)', () => {
  // 10x seed = 1,000 planned pairs x 20 evaluated runs each (the 100-pair seed x 10). Repo = an indexed in-memory fake (Map lookups), so the measurement is the service + domain + mapping overhead.
  const PLANS = 1000, RUNS = 20;
  function perfRepo() {
    const byPair = new Map<string, { plan_id: string; qc_validity_hours: number }>(); const byPlan = new Map<string, any[]>(); let calls = 0;
    for (let p = 1; p <= PLANS; p++) {
      const pid = `01900000-0000-7000-8000-${(0xf0000 + p).toString(16).padStart(12, '0')}`, ins = `01900000-0000-7000-8000-${(0xe0000 + p).toString(16).padStart(12, '0')}`, ana = `01900000-0000-7000-8000-${(0xd0000 + p).toString(16).padStart(12, '0')}`;
      byPair.set(`${ins}|${ana}`, { plan_id: pid, qc_validity_hours: 24 });
      const runs: RunSeed[] = []; for (let r = 0; r < RUNS; r++) runs.push({ id: `01900000-0000-7000-8000-${(0xc0000 + p * 100 + r).toString(16).padStart(12, '0')}`, tenant_id: TENANT_A, plan_id: pid, status: 'evaluated', outcome: r % 7 === 3 ? 'accepted_warning' : r === 5 ? 'rejected' : 'accepted', run_at: `2026-11-05T${String(r % 24).padStart(2, '0')}:00:00.000Z`, closed_at: r === 5 ? '2026-11-05T09:00:00.000Z' : null, rules_violated: r === 5 ? ['1-3s'] : [] });
      byPlan.set(pid, runs);
    }
    const repo: StatusRepo = {
      async findPlanForPair(_tx, _t, i, a) { calls++; return byPair.get(`${i}|${a}`); },
      async listRunsForStatus(_tx, _t, ids, at) { calls++; return ids.flatMap((id) => (byPlan.get(id) ?? []).filter((r) => Date.parse(r.run_at) <= Date.parse(at)).map((r) => ({ ...r, closed_at: r.closed_at ?? null }))); },
      async listBoardPlans() { return []; }, async listActivity() { return []; }, async listInstrumentLabels() { return []; },
    };
    return { repo, pairs: [...byPair.keys()].map((k) => k.split('|') as [string, string]), calls: () => calls };
  }
  it('1,000 calls over the 10x seed: p95 <= 10 ms, p99 <= 25 ms, and every call stays within two repo calls (no N+1, no per-run query)', async () => {
    const p = perfRepo(); const port = createQualityPort({ status: createStatusService({ repo: p.repo }) }); const ctx = makeCtxFor()('A:system');
    for (let i = 0; i < 50; i++) await port.qcStatusFor(ctx, { instrumentId: p.pairs[i]![0], analyteId: p.pairs[i]![1], at: '2026-11-05T23:30:00.000Z' });   // warm-up
    const before = p.calls(); const ms: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const [ins, ana] = p.pairs[(i * 7) % p.pairs.length]!; const t0 = performance.now();
      const r = await port.qcStatusFor(ctx, { instrumentId: ins, analyteId: ana, at: `2026-11-05T${String(12 + (i % 12)).padStart(2, '0')}:30:00.000Z` });
      ms.push(performance.now() - t0); expect(['in_control', 'warning', 'out_of_control', 'no_qc_data']).toContain(r.status);
    }
    expect(p.calls() - before).toBeLessThanOrEqual(2000);
    ms.sort((a, b) => a - b); const p95 = ms[Math.floor(ms.length * 0.95)]!, p99 = ms[Math.floor(ms.length * 0.99)]!;
    expect(p95, `p95 ${p95.toFixed(3)} ms`).toBeLessThanOrEqual(10); expect(p99, `p99 ${p99.toFixed(3)} ms`).toBeLessThanOrEqual(25);
  });
});
