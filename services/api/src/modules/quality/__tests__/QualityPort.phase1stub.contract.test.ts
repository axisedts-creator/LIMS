// C9 T-01: `phase1Stub` subset of the shared QualityPort contract (packages/fakes/contract-tests/QualityPort.contract.ts, IC §4.11) run on the module's
// OWN port (manifest.ports.QualityPort), plus "returns exactly the stub results" (06-PLAN T-01 done_when; 02-TRD §11.1; 08 A17 P-20, D-56).
// Reference = packages/fakes/src/stubs/QualityPort.stub.ts: canAutoVerify -> { decision:'deny', reasons:['feature_disabled'] } and nothing else (no ruleSetVersion);
// qcStatusFor -> { status:'no_qc_data' } and nothing else; for ANY actor / tenant / input. The methods do not read quality.settings and open no
// transaction (02-TRD §11.1, §12.1): ctx.tx is never used. T-13 / T-16 replace the two methods and retire the "exact stub result" cases (not weaken them).
// Also: the paired C0-0D change removes QualityPort from core/ports/phase-stubs.ts (AC-0D-6.3).
// SEAM: `../ports/QualityPort.impl.ts` exports `qualityPort` (same naming as smartreport's `smartReportPort`) and manifest.ports.QualityPort is that object.
import { describe, expect, it } from 'vitest';
import { createQualityPortStub } from '../../../../../../packages/fakes/src/stubs/QualityPort.stub';
import { makeCtxFor } from '../../../../../../packages/fakes/src/harness';
import { PHASE_STUBS, assertPhaseStubsCurrent, findStalePhaseStubs } from '../../../core/ports/phase-stubs.js';
import { qualityPort } from '../ports/QualityPort.impl.js';
import { manifest } from '../index.js';

const impl = (): any => (manifest.ports as any).QualityPort;

// T-13: the shared contract suite (cases 1, 7, 9, 11, 12 of the phase1Stub subset, plus 6 and 8) now runs in QualityPort.qcStatusFor.contract.test.ts on a seeded harness: qcStatusFor reads data,
// so the seedless stub harness of T-01 no longer applies to it. The T-01 "exact stub result" cases for qcStatusFor are retired below (T-13 replaced the method); canAutoVerify's stay until T-16.

const IN = '01900000-0000-7000-8000-0000000c9001';
const AN = '01900000-0000-7000-8000-0000000c9002';
const good = { resultId: '01900000-0000-7000-8000-0000000c9201', analyteId: AN, instrumentId: IN, valueNumeric: '4.2', instrumentFlags: [] as string[],
  rangeFlag: 'N' as const, deltaCheckFailed: false, isCritical: false, resultedAt: '2026-11-05T04:15:00.000Z' };
const outcome = (p: Promise<unknown>) => p.then((v) => ({ ok: true as const, v }), (e: any) => ({ ok: false as const, code: e?.code ?? 'non_lims_error' }));

describe('C9 T-01: registered QualityPort', () => {
  it("manifest.ports.QualityPort is the module's own port: same method set as the phase stub, no fake controls exposed", () => {
    expect(impl()).toBe(qualityPort);
    const ref: any = createQualityPortStub();
    for (const m of Object.keys(ref)) expect(typeof impl()[m], m).toBe('function');
    for (const c of ['failNext', 'latency', 'calls', 'reset', 'seed', 'fixtures', '__seed', '__rollback']) expect(impl()[c], c).toBeUndefined();
  });
});

describe('C9 T-01: registered QualityPort returns exactly the stub results', () => {
  const h = makeCtxFor();
  const actors = ['A:user', 'A:system', 'A:device', 'B:user', 'B:system'];

  it('canAutoVerify -> deny [feature_disabled], deep-equal to the stub (no ruleSetVersion, no extra reason, never allow) for every actor and tenant', async () => {
    const ref: any = createQualityPortStub();
    const variants = [good, { ...good, isCritical: true }, { ...good, deltaCheckFailed: true, instrumentFlags: ['E'] }, { ...good, instrumentId: undefined },
      { ...good, valueNumeric: undefined }, {}];
    for (const a of actors) {
      for (const v of variants) {
        const got = await impl().canAutoVerify(h(a), v);
        expect(got, `${a} ${JSON.stringify(v)}`).toEqual({ decision: 'deny', reasons: ['feature_disabled'] });
        expect(got).toEqual(await ref.canAutoVerify(h(a), v));
        expect(Object.keys(got).sort()).toEqual(['decision', 'reasons']);
      }
    }
  });

  it('returns a fresh object each call (a caller mutating the result cannot poison the next answer)', async () => {
    const a: any = await impl().canAutoVerify(h('A:user'), good);
    a.reasons.push('x'); a.decision = 'allow';
    expect(await impl().canAutoVerify(h('A:user'), good)).toEqual({ decision: 'deny', reasons: ['feature_disabled'] });
  });

  it('is pure: no database touch and no transaction opened (ctx.tx is never used; 02-TRD §11.1 / §12.1: the port does not read quality.settings)', async () => {
    const tx = new Proxy({}, { get() { throw new Error('ctx.tx touched'); } });
    const ctx = h('A:system', { tx: tx as any });
    expect(await outcome(impl().canAutoVerify(ctx, good))).toEqual({ ok: true, v: { decision: 'deny', reasons: ['feature_disabled'] } });
  });

  it('answers even while LIMS_QUALITY_ENABLED=false (the port always answers; only the HTTP routes are gated, 02-TRD §12.2)', async () => {
    delete process.env['LIMS_QUALITY_ENABLED'];
    expect((await impl().canAutoVerify(h('A:user'), good)).decision).toBe('deny');
    process.env['LIMS_QUALITY_ENABLED'] = 'false';
    try { expect((await impl().canAutoVerify(h('A:user'), good)).decision).toBe('deny'); }
    finally { delete process.env['LIMS_QUALITY_ENABLED']; }
  });
});

describe('C9 T-01: phase-stub replacement (08 A17 P-20, C0 AC-0D-6.3) — the PR that creates modules/quality removes QualityPort from phase-stubs.ts', () => {
  it('PHASE_STUBS no longer lists QualityPort and lists nothing but EngagementPort (the only other owner not yet shipped)', () => {
    expect(PHASE_STUBS).not.toContain('QualityPort');
    for (const p of PHASE_STUBS) expect(['EngagementPort'], `unexpected stub entry ${p}`).toContain(p);
  });
  it('AC-0D-6.3 gate: quality/index.ts exists, so the port WOULD be stale if still listed; with the committed list nothing is stale', () => {
    expect(findStalePhaseStubs({ phaseStubs: ['QualityPort'] })).toEqual([{ port: 'QualityPort', owner: 'quality' }]);
    expect(() => assertPhaseStubsCurrent({ phaseStubs: ['QualityPort'] })).toThrow(/QualityPort/);
    expect(findStalePhaseStubs().filter((s) => s.port === 'QualityPort')).toEqual([]);
  });
});
