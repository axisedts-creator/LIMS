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

// T-16 retired the "returns exactly the stub results" cases for canAutoVerify (stub result, purity / no-tx, fresh-object, ENABLED=false): canAutoVerify is now the real decision service.
// Their successors live in QualityPort.canAutoVerify.contract.test.ts (default wiring, validation before tx, fail-closed, answers while LIMS_QUALITY_ENABLED=false) and decision.service.test.ts.
void [good, outcome, createQualityPortStub, makeCtxFor];

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
