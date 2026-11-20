// T0C-SYNC-1 (LD-322, LD-325(b)) — the 7 sync operations of core.yaml must not break boot:
// core had no pendingOperations path (bootstrap.ts called checkHandlers('core', spec, handlers) without a pending list), so the implementer adds
// services/api/src/core/core-pending.ts (CORE_PENDING_OPERATIONS) and passes it to checkHandlers and mountSpec. T0B-SYNC-1 moves the ids from pending to handlers;
// this test stays green on both sides of that move (a handler wins over a stale pending id, as in core/module.ts checkHandlers).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkHandlers, loadSpec, REPO_ROOT } from '../module.js';
import { CORE_PENDING_OPERATIONS } from '../core-pending.js';
import { createHealthHandlers } from '../health.js';
import { syncHandlers, syncPart2Handlers } from '../sync/index.js';
import { okChecks } from '../observability/__tests__/helpers.js';

const NEW_OPS = ['registerSyncDevice', 'listSyncDevices', 'revokeSyncDevice', 'requestSyncDeviceWipe', 'ackDeviceWipe', 'getSyncStatus', 'reserveNumberBlock'];
const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/core.yaml'));
const specIds: string[] = Object.values<any>(spec.paths).flatMap((p) => Object.values<any>(p).map((m) => m?.operationId).filter(Boolean));
// LD-325 (a)/(b): a handler wins over a pending id, so the covered set is the handlers bootstrap builds (health + sync part 1 + part 2, what bootstrap builds; LD-374 ruling 3.2), as in registry.static.test.ts.
const allHandlers = { ...createHealthHandlers(okChecks()), ...syncHandlers, ...syncPart2Handlers };
const pending: string[] = [...CORE_PENDING_OPERATIONS];

describe('T0C-SYNC-1: core manifest covers the sync operations (handler or pending)', () => {
  it('the 7 sync operations and the 2 health operations are in the spec', () => {
    for (const id of [...NEW_OPS, 'getLiveness', 'getReadiness']) expect(specIds, id).toContain(id);
  });
  it('every spec operation has a handler or is listed pending; checkHandlers(core) passes with the pending list (boot check would pass)', () => {
    const uncovered = specIds.filter((id) => !(id in allHandlers) && !pending.includes(id));
    expect(uncovered, `no handler and not pending: ${uncovered.join(', ')}`).toEqual([]);
    expect(() => checkHandlers('core', spec, allHandlers, pending)).not.toThrow();
  });
  it('without the pending list the boot check would fail while the handlers are not merged (the reason the list exists)', () => {
    if (pending.length === 0) return; // T0B-SYNC-1 merged: nothing pending, nothing to prove
    expect(() => checkHandlers('core', spec, healthHandlers)).toThrow();
  });
  it('every pending id is a spec operationId and appears once; a pending id never names a health operation', () => {
    expect(pending.filter((id) => !specIds.includes(id))).toEqual([]);
    expect(new Set(pending).size).toBe(pending.length);
    expect(pending).not.toContain('getLiveness');
    expect(pending).not.toContain('getReadiness');
  });
  it('only the sync operations may be pending in core', () => {
    // T0C-SYNC-2 adds pushSyncBatch, pullChanges, listSyncConflicts, getSyncConflict, resolveSyncConflict to the same list (sync2.pending.test.ts)
    const SYNC2_OPS = ['pushSyncBatch', 'pullChanges', 'listSyncConflicts', 'getSyncConflict', 'resolveSyncConflict'];
    expect(pending.filter((id) => ![...NEW_OPS, ...SYNC2_OPS].includes(id)), 'only the sync operations may be pending in core').toEqual([]);
  });
  it('bootstrap passes the list to both checkHandlers and mountSpec for core (so a pending id answers 501 operation_pending after auth, not 404)', () => {
    const boot = readFileSync(join(REPO_ROOT, 'services/api/src/core/bootstrap.ts'), 'utf8');
    expect(boot).toMatch(/CORE_PENDING_OPERATIONS/);
    expect(boot).toMatch(/checkHandlers\('core',\s*spec,\s*handlers,\s*CORE_PENDING_OPERATIONS\)/);
    expect(boot).toMatch(/mountSpec\(app,\s*'core',\s*spec,\s*handlers,\s*auth,\s*pipes\.pipelineFor\('core'\),\s*CORE_PENDING_OPERATIONS\)/);
  });
  it('the production gate counts core pending ids too: bootstrap builds the pending list for the production refusal from core and the modules', () => {
    const boot = readFileSync(join(REPO_ROOT, 'services/api/src/core/bootstrap.ts'), 'utf8');
    expect(boot, 'a non empty CORE_PENDING_OPERATIONS must make production boot refuse unless LIMS_ALLOW_PENDING_OPS=1').toMatch(/pendingIds[\s\S]{0,400}CORE_PENDING_OPERATIONS|CORE_PENDING_OPERATIONS[\s\S]{0,400}pendingIds/);
  });
});
