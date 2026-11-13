// C14 T01: phase-stub replacement (08 A17 P-20) — the PR that creates modules/smartreport removes SmartReportPort from phase-stubs.ts.
// C14 T13 edit: the T01 sections "phase1Stub subset of the shared contract on the module port" and "returns exactly the stub result / pure, ctx.tx never used" are
// RETIRED, not weakened: 02-TRD §7.1 ("returns exactly the stub result … until T13 replaces buildSummary") and 06-PLAN T13 supersede them — the real port reads
// IdentityPort and the build tables, validates input first, and refuses non-staff. Their useful cases now run on the real impl: (4) disabled tenant and the D-111
// case in SmartReportPort.impl.contract.test.ts (full contract), feature flag / actors / validation in SmartReportPort.impl.test.ts.
// The registration check (manifest.ports.SmartReportPort is the module's own port, no fake controls) and the stub-replacement gate stay.
import { describe, expect, it } from 'vitest';
import { createSmartReportPortStub } from '../../../../../../packages/fakes/src/stubs/SmartReportPort.stub';
import { PHASE_STUBS, assertPhaseStubsCurrent, findStalePhaseStubs } from '../../../core/ports/phase-stubs.js';
import { smartReportPort } from '../ports/SmartReportPort.impl.js';
import { manifest } from '../index.js';

describe('C14 T01: registered SmartReportPort', () => {
  it('manifest.ports.SmartReportPort is the module\'s own port: same method set as the phase stub, no fake controls exposed', () => {
    const impl: any = (manifest.ports as any).SmartReportPort;
    expect(impl).toBe(smartReportPort);
    const ref: any = createSmartReportPortStub();
    for (const m of Object.keys(ref)) expect(typeof impl[m], m).toBe('function');
    for (const c of ['failNext', 'latency', 'calls', 'reset', 'seed', 'fixtures']) expect(impl[c], c).toBeUndefined();
  });
});

describe('C14 T01: phase-stub replacement (08 A17 P-20) — the PR that creates modules/smartreport removes SmartReportPort from phase-stubs.ts', () => {
  it('PHASE_STUBS no longer lists SmartReportPort and still lists the others', () => {
    expect(PHASE_STUBS).not.toContain('SmartReportPort');
    expect([...PHASE_STUBS].sort()).toEqual(['EngagementPort']); // QualityPort removed by C9 T-01 (08 A17 P-20)
  });
  it('AC-0D-6.3 gate: smartreport/index.ts exists, so the port WOULD be stale if still listed; with the committed list nothing is stale', () => {
    expect(findStalePhaseStubs({ phaseStubs: ['SmartReportPort'] })).toEqual([{ port: 'SmartReportPort', owner: 'smartreport' }]);
    expect(() => assertPhaseStubsCurrent({ phaseStubs: ['SmartReportPort'] })).toThrow(/SmartReportPort/);
    expect(findStalePhaseStubs()).toEqual([]);
    expect(() => assertPhaseStubsCurrent()).not.toThrow();
  });
});
