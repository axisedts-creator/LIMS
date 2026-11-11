// C14 T01: `phase1Stub` subset of the shared SmartReportPort contract (packages/fakes/contract-tests/SmartReportPort.contract.ts, IC §4.10) run on the
// module's OWN port (manifest.ports.SmartReportPort), plus "returns exactly the stub result" (06-PLAN T01 done_when; 08 A17 P-20; D-111).
// Reference = packages/fakes/src/stubs/SmartReportPort.stub.ts: buildSummary rejects LimsError smartreport.feature_disabled for ANY actor/tenant/input,
// never smartreport.summary_not_ready, never auth.forbidden/validation. Also: the paired C0-0D change removes SmartReportPort from phase-stubs.ts.
// Fails now: ../index.js does not exist.
import { describe, expect, it } from 'vitest';
import { runSmartReportPortContract } from '../../../../../../packages/fakes/contract-tests/SmartReportPort.contract';
import { createSmartReportPortStub } from '../../../../../../packages/fakes/src/stubs/SmartReportPort.stub';
import { makeCtxFor, type ContractHarness } from '../../../../../../packages/fakes/src/harness';
import { createEventSpy } from '../../../../../../packages/fakes/src/event-spy';
import { PHASE_STUBS, assertPhaseStubsCurrent, findStalePhaseStubs } from '../../../core/ports/phase-stubs.js';
import { manifest } from '../index.js';

const impl = (): any => (manifest.ports as any).SmartReportPort;

const moduleHarness = (): (() => Promise<ContractHarness>) => async () => {
  const events = createEventSpy();
  return { impl: impl(), events, ctxFor: makeCtxFor(), async seed() {}, rollback(tx: unknown) { events.rollback(tx); } };
};

runSmartReportPortContract(moduleHarness(), { phase1Stub: true });

const O = '01900000-0000-7000-8000-0000000c1401';
const codeOf = async (p: Promise<unknown>): Promise<string> => { try { await p; return 'resolved'; } catch (e: any) { return e?.code ?? 'non_lims_error'; } };

describe('C14 T01: registered SmartReportPort returns exactly the stub result', () => {
  const h = makeCtxFor();
  it('same method set as the phase stub, no fake controls exposed', () => {
    const ref: any = createSmartReportPortStub();
    for (const m of Object.keys(ref)) expect(typeof impl()[m], m).toBe('function');
    for (const c of ['failNext', 'latency', 'calls', 'reset', 'seed', 'fixtures']) expect(impl()[c], c).toBeUndefined();
  });

  it('buildSummary -> smartreport.feature_disabled for every actor type and both tenants, identical to the stub (no summary_not_ready, no forbidden)', async () => {
    const ref: any = createSmartReportPortStub();
    for (const a of ['A:user', 'A:system', 'A:device', 'B:user', 'B:system']) {
      for (const input of [{ orderId: O, version: 1 }, { orderId: O }, { orderId: 'not-a-uuid', version: 0 }, {}]) {
        const got = await codeOf(impl().buildSummary(h(a), input));
        expect(got, `${a} ${JSON.stringify(input)}`).toBe('smartreport.feature_disabled');
        expect(got).toBe(await codeOf(ref.buildSummary(h(a), input)));
      }
    }
  });

  it('is pure: no database touch (ctx.tx is never used)', async () => {
    const tx = new Proxy({}, { get() { throw new Error('ctx.tx touched'); } });
    const ctx = h('A:system', { tx: tx as any });
    expect(await codeOf(impl().buildSummary(ctx, { orderId: O, version: 1 }))).toBe('smartreport.feature_disabled');
  });
});

describe('C14 T01: phase-stub replacement (08 A17 P-20) — the PR that creates modules/smartreport removes SmartReportPort from phase-stubs.ts', () => {
  it('PHASE_STUBS no longer lists SmartReportPort and still lists the others', () => {
    expect(PHASE_STUBS).not.toContain('SmartReportPort');
    expect([...PHASE_STUBS].sort()).toEqual(['EngagementPort', 'QualityPort']);
  });
  it('AC-0D-6.3 gate: smartreport/index.ts exists, so the port WOULD be stale if still listed; with the committed list nothing is stale', () => {
    expect(findStalePhaseStubs({ phaseStubs: ['SmartReportPort'] })).toEqual([{ port: 'SmartReportPort', owner: 'smartreport' }]);
    expect(() => assertPhaseStubsCurrent({ phaseStubs: ['SmartReportPort'] })).toThrow(/SmartReportPort/);
    expect(findStalePhaseStubs()).toEqual([]);
    expect(() => assertPhaseStubsCurrent()).not.toThrow();
  });
});
