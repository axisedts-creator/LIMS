// T0C-FINCTRL-1 (LD-321, LD-325(b)) — the 16 accounting control operations must not break module boot:
// every operationId of billing.yaml has a handler OR is listed in the manifest's pendingOperations (core/module.ts checkHandlers, AC-0D-1.2 with BOOTGATE-1);
// every pending id is a real operationId. The T0B-FINCTRL-1 handler task moves the ids from pending to handlers; this test stays green on both sides of that move.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSpec, REPO_ROOT } from '../../../../core/module.js';
import { manifest } from '../../index.js';

const NEW_OPS = ['listDiscountReasons', 'createDiscountReason', 'updateDiscountReason', 'listPartyDiscountSlabs', 'createPartyDiscountSlab', 'updatePartyDiscountSlab', 'deactivatePartyDiscountSlab',
  'resolveDiscountSlab', 'listUserDiscountLimits', 'setUserDiscountLimit', 'listDiscountAuthorities', 'createDiscountAuthority', 'deactivateDiscountAuthority', 'getMyDiscountPolicy', 'holdLedgerEntry', 'releaseLedgerEntry'];
const NEW_CODES = ['billing.discount_policy.read', 'billing.discount_policy.manage', 'billing.account.manage'];
const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/billing.yaml'));
const specIds: string[] = Object.values<any>(spec.paths).flatMap((p) => Object.values<any>(p).map((m) => m?.operationId).filter(Boolean));
const handlerIds = Object.keys(manifest.handlers);
const pending: string[] = [...(((manifest as { pendingOperations?: readonly string[] }).pendingOperations) ?? [])];

describe('T0C-FINCTRL-1: billing manifest covers the accounting control operations (handler or pending)', () => {
  it('the 16 operations are in the spec, each with one of the three billing codes', () => {
    for (const id of NEW_OPS) {
      expect(specIds, id).toContain(id);
      const op = Object.values<any>(spec.paths).flatMap((p) => Object.values<any>(p)).find((m) => m?.operationId === id);
      expect(NEW_CODES, `${id} permission`).toContain(op['x-permission']);
    }
  });
  it('every spec operation has a handler or is listed pending (boot check would pass)', () => {
    const uncovered = specIds.filter((id) => !handlerIds.includes(id) && !pending.includes(id));
    expect(uncovered, `no handler and not pending: ${uncovered.join(', ')}`).toEqual([]);
  });
  it('every pending id is a spec operationId and appears once', () => {
    expect(pending.filter((id) => !specIds.includes(id))).toEqual([]);
    expect(new Set(pending).size).toBe(pending.length);
  });
  it('a handler key that is not a spec operation does not exist (nothing was invented)', () => {
    expect(handlerIds.filter((id) => !specIds.includes(id))).toEqual([]);
  });
  it('each new id is handled or pending; no original billing operation was made pending to hide a missing handler', () => {
    for (const id of NEW_OPS) expect(handlerIds.includes(id) || pending.includes(id), `${id} neither handled nor pending`).toBe(true);
    for (const id of ['listInvoices', 'recordPayment', 'getMyCashSession', 'closeCashSession', 'getDailyCash', 'listAccountLedgerEntries', 'reverseAccountLedgerEntry', 'createAccountLedgerEntry'])
      expect(handlerIds, `${id} keeps its handler`).toContain(id);
  });
  it('a pending id never also has a handler key (a handler wins and the stale entry only warns, but the T0C task must not create the clash)', () => {
    for (const id of NEW_OPS) expect(handlerIds.includes(id) && pending.includes(id), `${id} is both handled and pending`).toBe(false);
  });
});
