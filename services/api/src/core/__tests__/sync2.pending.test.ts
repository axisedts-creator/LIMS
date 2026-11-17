// T0C-SYNC-2 (LD-322, LD-325 b) — the 5 offline sync part 2 operations of core.yaml must not break boot: each new operationId is in CORE_PENDING_OPERATIONS until T0B-SYNC-2..5 add the handlers
// (a handler wins over a stale pending id, as in core/module.ts checkHandlers, so this test stays green on both sides of that move).
// Boot warning of the brief: a contract task that adds operations leaves main failing the module boot check until its API task merges; the pending list is how LD-325 avoids that.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkHandlers, loadSpec, REPO_ROOT } from '../module.js';
import { CORE_PENDING_OPERATIONS } from '../core-pending.js';
import { createHealthHandlers } from '../health.js';
import { okChecks } from '../observability/__tests__/helpers.js';

const SYNC2_OPS = ['pushSyncBatch', 'pullChanges', 'listSyncConflicts', 'getSyncConflict', 'resolveSyncConflict'];
const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/core.yaml'));
const specIds: string[] = Object.values<any>(spec.paths).flatMap((p) => Object.values<any>(p).map((m) => m?.operationId).filter(Boolean));
const healthHandlers = createHealthHandlers(okChecks());
const pending: string[] = [...CORE_PENDING_OPERATIONS];

describe('T0C-SYNC-2: core manifest covers the part 2 sync operations (handler or pending)', () => {
  it('the 5 part 2 operations are in the spec next to the part 1 operations and the 2 health operations (14 in all)', () => {
    for (const id of SYNC2_OPS) expect(specIds, id).toContain(id);
    expect(specIds.length).toBe(14);
    expect(new Set(specIds).size).toBe(14);
  });
  it('every part 2 operation has a handler or is listed pending', () => {
    const uncovered = SYNC2_OPS.filter((id) => !(id in healthHandlers) && !pending.includes(id));
    expect(uncovered, `no handler and not pending: ${uncovered.join(', ')}`).toEqual([]);
  });
  it('checkHandlers(core) passes with the pending list: every spec operation is a handler or pending (boot check would pass on main)', () => {
    const uncovered = specIds.filter((id) => !(id in healthHandlers) && !pending.includes(id));
    expect(uncovered, `no handler and not pending: ${uncovered.join(', ')}`).toEqual([]);
    expect(() => checkHandlers('core', spec, healthHandlers, pending)).not.toThrow();
  });
  it('without the pending list the boot check would fail while the handlers are not merged (the reason the list exists)', () => {
    if (SYNC2_OPS.every((id) => id in healthHandlers)) return; // T0B-SYNC-2..5 merged: nothing pending, nothing to prove
    expect(() => checkHandlers('core', spec, healthHandlers)).toThrow();
  });
  it('the pending list stays duplicate free and names only spec operations; health operations are never pending', () => {
    expect(new Set(pending).size).toBe(pending.length);
    expect(pending.filter((id) => !specIds.includes(id))).toEqual([]);
    expect(pending).not.toContain('getLiveness');
    expect(pending).not.toContain('getReadiness');
  });
});
