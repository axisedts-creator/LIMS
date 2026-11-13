// C16-T01 — "phase1Stub contract subset passes against C16's implementation" (06-PLAN T-01; 08 A17 P-20; IC §4.17).
// The shared EngagementPort contract runs with { phase1Stub: true }: cases (1) other tenant -> not_found / undefined and (3) expired membership -> undefined
// must pass on the registered implementation; the full-owner cases are skipped here (T-EP1 runs them with the real impl).
// SEAM: the registered impl is manifest.ports.EngagementPort (../index.ts). At T-01 it returns exactly the stub results and needs no database.
// Fails now: ../index.js does not exist.
import { describe, expect, it } from 'vitest';
import { runEngagementPortContract } from '../../../../../../packages/fakes/contract-tests/EngagementPort.contract';
import { createEventSpy } from '../../../../../../packages/fakes/src/event-spy';
import { makeCtxFor, type ContractHarness } from '../../../../../../packages/fakes/src/harness';
import { createEngagementPortStub } from '../../../../../../packages/fakes/src/stubs/EngagementPort.stub';
import { manifest } from '../index.js';

const impl: any = (manifest.ports as any)?.EngagementPort;

const harness = (): Promise<ContractHarness> => {
  const events = createEventSpy();
  return Promise.resolve({ impl, events, ctxFor: makeCtxFor(), async seed() {}, rollback: (tx) => events.rollback(tx) });
};

runEngagementPortContract(harness, { phase1Stub: true });

describe('C16-T01: registered EngagementPort', () => {
  it('manifest.ports owns exactly EngagementPort: same method set as the phase stub, no fake controls exposed', () => {
    expect(Object.keys(manifest.ports ?? {})).toEqual(['EngagementPort']);
    const ref: any = createEngagementPortStub();
    for (const m of Object.keys(ref)) expect(typeof impl[m], m).toBe('function');
    for (const c of ['failNext', 'latency', 'calls', 'reset', 'seed', 'fixtures', '__seed', '__rollback']) expect(impl[c], c).toBeUndefined();
  });

  it('returns exactly the stub results on any input: getHomeAddress -> common.not_found, getActiveMembership -> undefined', async () => {
    const h = await harness();
    const ctx = h.ctxFor('A');
    const e: any = await impl.getHomeAddress(ctx, { homeAddressId: '01900000-0000-7000-8000-0000000e0101', purpose: 'home_visit' }).then(() => undefined, (x: unknown) => x);
    expect(e?.code).toBe('common.not_found');
    await expect(impl.getActiveMembership(ctx, { patientId: '01900000-0000-7000-8000-0000000e0001' })).resolves.toBeUndefined();
  });

  it('is pure at T-01: ctx.tx is never used (no database yet)', async () => {
    const tx = new Proxy({}, { get() { throw new Error('tx must not be touched'); } });
    const ctx: any = { ...(await harness()).ctxFor('A'), tx };
    await expect(impl.getActiveMembership(ctx, { patientId: '01900000-0000-7000-8000-0000000e0001' })).resolves.toBeUndefined();
    await impl.getHomeAddress(ctx, { homeAddressId: '01900000-0000-7000-8000-0000000e0101', purpose: 'home_visit' }).catch(() => undefined);
  });
});
