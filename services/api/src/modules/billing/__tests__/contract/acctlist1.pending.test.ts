// T0C-ACCTLIST-1 (LD-358, LD-325(b)) — listAccountSummaries must not break module boot: every operationId of billing.yaml has a handler OR is listed in the manifest's pendingOperations
// (core/module.ts checkHandlers, AC-0D-1.2 with BOOTGATE-1). The T0B-ACCTLIST-1 handler task moves the id from pending to handlers; this test stays green on both sides of that move.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSpec, REPO_ROOT } from '../../../../core/module.js';
import { manifest } from '../../index.js';

const ID = 'listAccountSummaries';
const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/billing.yaml'));
const specIds: string[] = Object.values<any>(spec.paths).flatMap((p) => Object.values<any>(p).map((m) => m?.operationId).filter(Boolean));
const handlerIds = Object.keys(manifest.handlers);
const pending: string[] = [...(((manifest as { pendingOperations?: readonly string[] }).pendingOperations) ?? [])];

describe('T0C-ACCTLIST-1: billing manifest covers listAccountSummaries (handler or pending)', () => {
  it('the operation is in the spec', () => {
    expect(specIds).toContain(ID);
  });
  it('every spec operation has a handler or is listed pending (boot check would pass)', () => {
    const uncovered = specIds.filter((id) => !handlerIds.includes(id) && !pending.includes(id));
    expect(uncovered, `no handler and not pending: ${uncovered.join(', ')}`).toEqual([]);
  });
  it('the id is pending until T0B-ACCTLIST-1 (LD-325(b)): in pendingOperations, once, and not also a handler key', () => {
    expect(pending, `${ID} must be in pendingOperations`).toContain(ID);
    expect(pending.filter((id) => id === ID)).toHaveLength(1);
    expect(handlerIds, 'a pending operation has no handler key').not.toContain(ID);
  });
  it('every pending id is a real spec operationId and appears once; nothing else is pending but this task\'s id', () => {
    expect(pending.filter((id) => !specIds.includes(id))).toEqual([]);
    expect(new Set(pending).size).toBe(pending.length);
    // T0C-FINCTRL-1 (LD-321, LD-325(b)): its 16 operations are pending until T0B-FINCTRL-1 (pinned in finctrl1.pending.test.ts); nothing else may be pending.
    const FINCTRL = ['listDiscountReasons', 'createDiscountReason', 'updateDiscountReason', 'listPartyDiscountSlabs', 'createPartyDiscountSlab', 'updatePartyDiscountSlab', 'deactivatePartyDiscountSlab',
      'resolveDiscountSlab', 'listUserDiscountLimits', 'setUserDiscountLimit', 'listDiscountAuthorities', 'createDiscountAuthority', 'deactivateDiscountAuthority', 'getMyDiscountPolicy', 'holdLedgerEntry', 'releaseLedgerEntry'];
    expect(pending.filter((id) => id !== ID && !FINCTRL.includes(id)), 'T0B-ACCT-2 left no billing operation pending; only listAccountSummaries and the T0C-FINCTRL-1 ids may be').toEqual([]);
  });
  it('a handler key that is not a spec operation does not exist (nothing was invented)', () => {
    expect(handlerIds.filter((id) => !specIds.includes(id))).toEqual([]);
  });
});
