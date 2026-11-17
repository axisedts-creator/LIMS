// T0C-MSGDESK-1 (LD-321, LD-325(b)) — the 10 partner ticket operations must not break module boot:
// every operationId of partners.yaml has a handler OR is listed in the manifest's pendingOperations (core/module.ts checkHandlers, AC-0D-1.2 with BOOTGATE-1);
// every pending id is a real operationId. The T0B-MSGDESK-1 handler task moves the ids from pending to handlers; this test stays green on both sides of that move.
// (partners/index.ts builds a 'not implemented' stub for every spec operation without a handler; the list of pending ids is still required by LD-325(b) and checked in the impl notes test of msgdesk1-openapi.test.ts.)
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSpec, REPO_ROOT } from '../../../../core/module.js';
import { manifest } from '../../index.js';

const NEW_OPS = ['createPartnerTicket', 'listPartnerTickets', 'getPartnerTicket', 'replyPartnerTicket', 'closePartnerTicket', 'reopenPartnerTicket',
  'listMyPartnerTickets', 'createMyPartnerTicket', 'getMyPartnerTicket', 'replyMyPartnerTicket'];
const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/partners.yaml'));
const specIds: string[] = Object.values<any>(spec.paths).flatMap((p) => Object.values<any>(p).map((m) => m?.operationId).filter(Boolean));
const handlerIds = Object.keys(manifest.handlers);
const pending: string[] = [...(((manifest as { pendingOperations?: readonly string[] }).pendingOperations) ?? [])];

describe('T0C-MSGDESK-1: partners manifest covers the new operations (handler or pending)', () => {
  it('the 10 new operations are in the spec', () => {
    for (const id of NEW_OPS) expect(specIds, id).toContain(id);
  });
  it('every spec operation has a handler or is listed pending (boot check would pass)', () => {
    const uncovered = specIds.filter((id) => !handlerIds.includes(id) && !pending.includes(id));
    expect(uncovered, `no handler and not pending: ${uncovered.join(', ')}`).toEqual([]);
  });
  it('every pending id is a spec operationId and appears once; none of the new operations is still pending', () => {
    expect(pending.filter((id) => !specIds.includes(id))).toEqual([]);
    expect(new Set(pending).size).toBe(pending.length);
    expect(pending.filter((id) => NEW_OPS.includes(id)), 'T0B-MSGDESK-1 handles all 10 ticket operations; none may stay pending').toEqual([]);
  });
  it('a handler key that is not a spec operation does not exist (nothing was invented)', () => {
    expect(handlerIds.filter((id) => !specIds.includes(id))).toEqual([]);
  });
  it('each new id is handled or pending (LD-325(b): the contract task lists it, T0B-MSGDESK-1 removes it when the real handler lands)', () => {
    for (const id of NEW_OPS) expect(handlerIds.includes(id) || pending.includes(id), `${id} neither handled nor pending`).toBe(true);
  });
});
