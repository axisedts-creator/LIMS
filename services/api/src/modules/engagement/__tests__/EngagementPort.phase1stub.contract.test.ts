// C16-T01 — registered EngagementPort manifest shape (06-PLAN T-01; 08 A17 P-20; IC §4.17).
// T-EP1 ruling (.orchestra/notes/T-EP1-ruling.md): the stub-behaviour assertions and the { phase1Stub: true } contract run were time-bound to T-01
// and are retired by T-EP1 (P-20: stub results only for methods not yet built). Cases 1-3 run in EngagementPort.impl.test.ts.
import { describe, expect, it } from 'vitest';
import { createEngagementPortStub } from '../../../../../../packages/fakes/src/stubs/EngagementPort.stub';
import { manifest } from '../index.js';

const impl: any = (manifest.ports as any)?.EngagementPort;

describe('C16-T01: registered EngagementPort', () => {
  it('manifest.ports owns exactly EngagementPort: same method set as the phase stub, no fake controls exposed', () => {
    expect(Object.keys(manifest.ports ?? {})).toEqual(['EngagementPort']);
    const ref: any = createEngagementPortStub();
    for (const m of Object.keys(ref)) expect(typeof impl[m], m).toBe('function');
    for (const c of ['failNext', 'latency', 'calls', 'reset', 'seed', 'fixtures', '__seed', '__rollback']) expect(impl[c], c).toBeUndefined();
  });
});
