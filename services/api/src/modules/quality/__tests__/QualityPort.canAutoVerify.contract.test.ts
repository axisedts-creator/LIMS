// C9 T-16 — QualityPort.canAutoVerify on the module's own port: the shared contract suite IN FULL (packages/fakes/contract-tests/QualityPort.contract.ts, IC §4.11, cases 1-12; T-16 owns 1-5, 10, 11)
// + default wiring + perf p95 <= 10 ms at 10x seed volume (06-PLAN T-16; PRD AC-13.6; 02-TRD §13).
// SEAMS (decision.helpers.ts header): createQualityPort({ status?, decision? }), qualityPort, createDecisionService({ autoverifyRepo, decisionRepo, status }), createDecisionRepo().
// The shared suite's seed shape ({ tenants, autoVerifyLimits, qcPlans }) is mapped by the harness below onto the fake AutoverifyRepo (active / simulating versions), the tenant setting, and the fake StatusRepo.
// Fails now: createQualityPort ignores `decision` and canAutoVerify is still the T-01 stub (cases 2-5, 10 answer feature_disabled); "Cannot find module ../service/decision.service.js".
import { describe, expect, it } from 'vitest';
import { runQualityPortContract } from '../../../../../../packages/fakes/contract-tests/QualityPort.contract';
import { makeCtxFor, type ContractHarness } from '../../../../../../packages/fakes/src/harness';
import { createEventSpy } from '../../../../../../packages/fakes/src/event-spy';
import { manifest } from '../index.js';
import { createQualityPort, qualityPort } from '../ports/QualityPort.impl.js';
import { createStatusService } from '../service/status.service.js';
import { createDecisionService } from '../service/decision.service.js';
import { makeStatusRepo, type StatusSeed } from './status.helpers.js';
import { DEF_V3, DEF_V4, I1, K, RESULT, RUN, TEST, TENANT_A, USER, V3, V4, VER, code, def, kAny, makeDecisionRepo, makeRepo, rc, rejection, rule, scenario, setRow, verRow } from './decision.helpers.js';

// ---- contract harness -----------------------------------------------------------------------------------------------------------------------------------------------------------------
interface CPlan { id: string; tenantId: string; instrumentId: string; analyteId: string; validityHours: number; runs: Array<{ runId: string; at: string; outcome: string; violatedRules?: string[] }> }
const LABEL_ID: Record<string, string> = { 'av-1': VER(31), 'av-2': VER(32) };

const harness = (): (() => Promise<ContractHarness>) => async () => {
  const events = createEventSpy();
  const statusSeed: StatusSeed = { plans: [], runs: [], activity: [] };
  const sfake = makeStatusRepo(statusSeed);
  const decisions = makeDecisionRepo();
  const enabled = new Map<string, boolean>();
  let av = makeRepo({ sets: [], versions: [], users: [] });
  const avRepo: any = new Proxy({}, { get: (_t, p) => (av.repo as any)[p] });
  const status = createStatusService({ repo: sfake.repo });
  const impl = createQualityPort({ status, decision: createDecisionService({ autoverifyRepo: avRepo, decisionRepo: decisions.repo as any, status }) });
  const base = makeCtxFor();
  return {
    impl, events,
    decisions,
    ctxFor: (key: string, over?: object) => base(key, { ports: { IdentityPort: { getTenantSettings: async (c: any) => ({ autoVerificationEnabled: enabled.get(c.tenantId) ?? false }) } }, ...(over ?? {}) } as any),
    async seed(fx: any) {
      for (const p of (fx.qcPlans ?? []) as CPlan[]) {
        sfake.state.plans = sfake.state.plans.filter((x) => x.id !== p.id); sfake.state.runs = sfake.state.runs.filter((r) => r.plan_id !== p.id);
        sfake.state.plans.push({ id: p.id, tenant_id: p.tenantId, instrument_id: p.instrumentId, analyte_id: p.analyteId, qc_validity_hours: p.validityHours, status: 'active' });
        for (const r of p.runs) sfake.state.runs.push({ id: r.runId, tenant_id: p.tenantId, plan_id: p.id, status: 'evaluated', outcome: r.outcome === 'warning' ? 'accepted_warning' : r.outcome, run_at: r.at, closed_at: null, rules_violated: r.violatedRules ?? [] });
      }
      const sets: any[] = [], versions: any[] = [];
      for (const [tenantId, t] of Object.entries<any>(fx.tenants ?? {})) {
        enabled.set(tenantId, !!t.autoVerificationEnabled);
        const defFor = (label: string) => def(...(fx.autoVerifyLimits ?? []).filter((l: any) => l.tenantId === tenantId && l.ruleSetVersion === label)
          .map((l: any, i: number) => rule(1, { key: `L_${i}`, test_id: TEST(1), analyte_id: l.analyteId, limits: { low: l.low, high: l.high }, allowed_range_flags: ['N'] })));
        const act = t.ruleSetVersion ? LABEL_ID[t.ruleSetVersion] : undefined, sim = t.shadowRuleSetVersion ? LABEL_ID[t.shadowRuleSetVersion] : undefined;
        if (act) versions.push(verRow(31, 'active', { id: act, tenant_id: tenantId, definition: defFor(t.ruleSetVersion) }));
        if (sim) versions.push(verRow(32, 'simulating', { id: sim, tenant_id: tenantId, definition: defFor(t.shadowRuleSetVersion), simulation_started_at: '2026-11-01T00:00:00.000Z' }));
        sets.push(setRow({ tenant_id: tenantId, active_version_id: act ?? null, simulating_version_id: sim ?? null }));
      }
      av = makeRepo({ sets, versions, users: [] });
    },
    rollback(tx: unknown) { decisions.rollback(tx); events.rollback(tx); },
  };
};

runQualityPortContract(harness());   // FULL: cases 1-12 (T-13's 6-9, 12 re-run here with the decision service wired; T-16's 1-5, 10, 11)

describe('QualityPort.canAutoVerify through the contract harness: audit rows and rollback', () => {
  it('(rollback) a call inside a transaction that rolls back leaves no decision row; a committed one does', async () => {
    const h: any = await harness()(); const A = h.ctxFor('A').tenantId;
    await h.seed({ tenants: { [A]: { autoVerificationEnabled: true, ruleSetVersion: 'av-1' } }, autoVerifyLimits: [{ id: 'x', tenantId: A, analyteId: K, ruleSetVersion: 'av-1', low: '3.5', high: '5.5' }],
      qcPlans: [{ id: '01900000-0000-7000-8000-0000000c9003', tenantId: A, instrumentId: I1, analyteId: K, validityHours: 24, runs: [{ runId: RUN(1), at: '2026-11-05T02:00:00.000Z', outcome: 'accepted' }] }] });
    const c1 = h.ctxFor('A:system'), c2 = h.ctxFor('A:system');
    expect(await h.impl.canAutoVerify(c1, rc({ resultedAt: '2026-11-05T04:15:00.000Z' }))).toMatchObject({ decision: 'allow', reasons: [] });
    expect(await h.impl.canAutoVerify(c2, rc({ resultedAt: '2026-11-05T04:15:00.000Z' }))).toMatchObject({ decision: 'allow' });
    expect(h.decisions.rows('live')).toHaveLength(2);
    h.rollback(c1.tx);
    expect(c1.tx).not.toBe(c2.tx);
    expect(h.decisions.inTx(c1.tx)).toHaveLength(1); expect(h.decisions.inTx(c2.tx)).toHaveLength(1);
    expect(h.decisions.rows('live')).toHaveLength(1);
  });
});

// ---- registered port + default wiring ---------------------------------------------------------------------------------------------------------------------------------------------
describe('manifest.ports.QualityPort is the real canAutoVerify (T-01 stub-equivalent replaced; 08 A17 P-20)', () => {
  const h = makeCtxFor();
  it('manifest.ports.QualityPort === qualityPort; both methods are functions; no fake controls exposed', () => {
    expect((manifest.ports as any).QualityPort).toBe(qualityPort);
    for (const m of ['canAutoVerify', 'qcStatusFor']) expect(typeof (qualityPort as any)[m], m).toBe('function');
    for (const c of ['failNext', 'latency', 'calls', 'reset', 'seed', 'fixtures', '__seed', '__rollback']) expect((qualityPort as any)[c], c).toBeUndefined();
  });
  it('createQualityPort delegates canAutoVerify to the injected decision service with (ctx, input) and returns its result unchanged; qcStatusFor still to the status service', async () => {
    const seen: unknown[][] = [], qseen: unknown[][] = []; const result = { decision: 'deny', reasons: ['rule_missing'], ruleSetVersion: V3 }, qres = { status: 'warning', currentRunId: RUN(2) };
    const p: any = createQualityPort({ decision: { async canAutoVerify(...a: unknown[]) { seen.push(a); return result; } } as any, status: { async qcStatusFor(...a: unknown[]) { qseen.push(a); return qres; } } as any });
    const ctx = h('A:system'), input = rc();
    expect(await p.canAutoVerify(ctx, input)).toBe(result); expect(seen).toEqual([[ctx, input]]);
    const q = { instrumentId: I1, analyteId: K, at: '2026-11-05T04:15:00.000Z' }; expect(await p.qcStatusFor(ctx, q)).toBe(qres); expect(qseen).toEqual([[ctx, q]]);
  });
  it('with only { status } injected, the default decision service uses THAT status service for its QC lookups', async () => {
    const qcCalls: unknown[] = [];
    const tx = scriptedTx(); const p: any = createQualityPort({ status: { async qcStatusFor(_c: unknown, i: unknown) { qcCalls.push(i); return { status: 'in_control', currentRunId: RUN(1) }; } } as any });
    const ctx = tenantCtx(tx.tx, true);
    expect(await p.canAutoVerify(ctx, rc())).toEqual({ decision: 'allow', reasons: [], ruleSetVersion: V3 });
    expect(qcCalls).toEqual([{ instrumentId: I1, analyteId: K, at: '2026-11-05T04:15:00.000Z' }]);
  });
  it('DEFAULT wiring end to end (real service + real repos on ctx.tx; a scripted tx stands in for Postgres): reads rule set + versions, evaluates, INSERTs the live row; tenant bound on every statement', async () => {
    const tx = scriptedTx(); const ctx = tenantCtx(tx.tx, true);
    const r = await qualityPort.canAutoVerify(ctx, rc());
    expect(r).toEqual({ decision: 'allow', reasons: [], ruleSetVersion: V3 });
    const inserts = tx.statements.filter((s) => /^\s*INSERT INTO quality\.autoverify_decisions\b/i.test(s.text));
    expect(inserts).toHaveLength(1); expect(inserts[0]!.values).toEqual(expect.arrayContaining([ctx.tenantId, RESULT, 'live', 'allow', V3, USER]));
    for (const s of tx.statements) { expect(s.text, s.text).toMatch(/^\s*(SELECT|WITH|INSERT)\b/i); expect(s.values, s.text).toContain(ctx.tenantId); }
    expect(tx.statements.filter((s) => /quality\.autoverify_/i.test(s.text) && /^\s*(UPDATE|DELETE)/i.test(s.text))).toEqual([]);
  });
  it('input validation happens BEFORE the transaction is touched: a bad input is common.validation_failed (never internal) even when ctx.tx would throw', async () => {
    const tx = new Proxy({}, { get() { throw new Error('ctx.tx touched'); } });
    for (const bad of [{}, rc({ resultId: 'nope' }), rc({ valueNumeric: 'abc' })]) expect(code(await rejection(qualityPort.canAutoVerify(tenantCtx(tx as any, true), bad as any))), JSON.stringify(bad)).toBe('common.validation_failed');
  });
  it('a failing transaction surfaces as common.internal (fail closed: never allow) with no driver text', async () => {
    const tx = { async query() { throw new Error('relation "quality.autoverify_rule_sets" does not exist PLANTED-SQL'); } };
    const e = await rejection(qualityPort.canAutoVerify(tenantCtx(tx as any, true), rc()));
    expect(code(e)).toBe('common.internal'); expect(JSON.stringify({ m: e?.message, d: e?.detail })).not.toMatch(/relation|PLANTED|autoverify_rule_sets/);
  });
  it('answers while LIMS_QUALITY_ENABLED=false (the port always answers; only the HTTP routes are gated, 02-TRD §12.2): a disabled tenant -> deny feature_disabled', async () => {
    const was = process.env['LIMS_QUALITY_ENABLED'];
    try {
      for (const v of [undefined, 'false', 'true']) {
        if (v === undefined) delete process.env['LIMS_QUALITY_ENABLED']; else process.env['LIMS_QUALITY_ENABLED'] = v;
        expect(await qualityPort.canAutoVerify(tenantCtx(scriptedTx().tx, false), rc()), String(v)).toEqual({ decision: 'deny', reasons: ['feature_disabled'] });
      }
    } finally { if (was === undefined) delete process.env['LIMS_QUALITY_ENABLED']; else process.env['LIMS_QUALITY_ENABLED'] = was; }
  });
});

/** Scripted tx: rule set row (V3 active), V3 version row (K_ANY + K_I2_OFF), QC plan + one accepted run for (I1, K), INSERT recorded. Anything else -> no rows. */
function scriptedTx() {
  const statements: Array<{ text: string; values: unknown[] }> = [];
  const tx = { async query(text: string, values: unknown[] = []) {
    statements.push({ text, values });
    if (/FROM quality\.autoverify_rule_sets/i.test(text)) return { rows: [setRow({ active_version_id: V3, tenant_id: values[0] })] };
    if (/FROM quality\.autoverify_versions/i.test(text)) return { rows: [verRow(3, 'active', { tenant_id: values[0], definition: DEF_V3 })] };
    if (/qc_plan_versions/.test(text)) return { rows: [{ plan_id: '01900000-0000-7000-8000-0000000c9003', qc_validity_hours: 24 }] };
    if (/FROM quality\.qc_runs/i.test(text)) return { rows: [{ plan_id: '01900000-0000-7000-8000-0000000c9003', id: RUN(1), status: 'evaluated', outcome: 'accepted', run_at: '2026-11-05T02:00:00.000Z', closed_at: null, rules_violated: [] }] };
    return { rows: [] };
  } };
  return { tx, statements };
}
function tenantCtx(tx: any, enabled: boolean): any {
  const ctx: any = makeCtxFor()('A:system', { tx, now: () => '2026-11-05T04:20:00.000Z', ports: { IdentityPort: { getTenantSettings: async () => ({ autoVerificationEnabled: enabled }) } } } as any);
  ctx.actor = { type: 'user', id: USER }; return ctx;
}

// ---- perf -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe('perf: canAutoVerify p95 <= 10 ms in-process at 10x seed volume (03-IC §4.11, 02-TRD §13, AC-13.6)', () => {
  // 10x seed = a 2,000-rule active version (the DSL cap) + a 2,000-rule simulating version (live AND shadow row on every call, the worst case) + 1,000 QC pairs x 20 runs.
  // Repos are indexed in-memory fakes, so the measurement is the service + domain + mapping overhead; compiled rules are cached after the first call per version.
  const RULES = 2000;
  const aid = (i: number) => `01a1a98a-ac40-7000-8000-${(0x600000 + i).toString(16).padStart(12, '0')}`;
  const big = (limits: { low: string; high: string }) => def(...Array.from({ length: RULES }, (_, i) => rule(1, { key: `R_${i}`, test_id: TEST(1), analyte_id: aid(i), limits })));
  const status = { async qcStatusFor() { return { status: 'in_control', currentRunId: RUN(1) }; } };
  const run = async (enabled: boolean, simulating: boolean) => {
    const repo = scenario({ active: big({ low: '3.5', high: '5.1' }), ...(simulating ? { simulating: big({ low: '3.0', high: '6.0' }) } : {}) }); const dec = makeDecisionRepo();
    const port = createQualityPort({ status: status as any, decision: createDecisionService({ autoverifyRepo: repo.repo as any, decisionRepo: dec.repo as any, status: status as any }) });
    const mk = (): any => ({ tenantId: TENANT_A, actor: { type: 'user', id: USER }, now: () => '2026-11-05T04:20:00.000Z', tx: { __brand: 'DbTx' }, ports: { IdentityPort: { getTenantSettings: async () => ({ autoVerificationEnabled: enabled }) } } });
    for (let i = 0; i < 50; i++) await port.canAutoVerify(mk(), rc({ analyteId: aid(i) }));   // warm-up (compiles both versions)
    const before = repo.callsOf('findVersion').length; const ms: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const t0 = performance.now(); const r = await port.canAutoVerify(mk(), rc({ resultId: `01a1a98a-ac40-7000-8000-${(0x700000 + i).toString(16).padStart(12, '0')}`, analyteId: aid((i * 7) % RULES), valueNumeric: i % 5 === 0 ? '9' : '4.2', rangeFlag: i % 5 === 0 ? 'H' : 'N' }));
      ms.push(performance.now() - t0); expect(['allow', 'deny']).toContain(r.decision);
    }
    ms.sort((a, b) => a - b);
    return { p95: ms[Math.floor(ms.length * 0.95)]!, p99: ms[Math.floor(ms.length * 0.99)]!, reloads: repo.callsOf('findVersion').length - before, rows: dec.rows().length };
  };
  it('1,000 evaluated calls (live + shadow, 2,000 rules each): p95 <= 10 ms, p99 <= 25 ms, compiled rules reused (no per-call version load), two rows per call', async () => {
    const r = await run(true, true);
    expect(r.p95, `p95 ${r.p95.toFixed(3)} ms`).toBeLessThanOrEqual(10); expect(r.p99, `p99 ${r.p99.toFixed(3)} ms`).toBeLessThanOrEqual(25);
    expect(r.reloads).toBe(0); expect(r.rows).toBe(2 * (50 + 1000));
  });
  it('1,000 short-circuited calls (tenant disabled, no simulating version): p95 <= 10 ms and no row at all', async () => {
    const r = await run(false, false);
    expect(r.p95, `p95 ${r.p95.toFixed(3)} ms`).toBeLessThanOrEqual(10); expect(r.rows).toBe(0);
  });
});

void [DEF_V4, V4, kAny];
