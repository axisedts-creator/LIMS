// T0C-SALES-1 (LD-321, LD-325(b)) — the 15 sales hierarchy operations must not break module boot:
// every operationId of partners.yaml has a handler OR is listed in the manifest's pendingOperations (core/module.ts checkHandlers, AC-0D-1.2 with BOOTGATE-1);
// every pending id is a real operationId. The T0B-SALES-1 handler task moves the ids from pending to handlers; this test stays green on both sides of that move.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSpec, REPO_ROOT } from '../../../../core/module.js';
import { manifest } from '../../index.js';

const NEW_OPS = ['listSalesDesignations', 'createSalesDesignation', 'updateSalesDesignation', 'listSalesRepresentatives', 'createSalesRepresentative', 'updateSalesRepresentative',
  'deactivateSalesRepresentative', 'getSalesTree', 'assignPartyToRepresentative', 'unassignPartyFromRepresentative', 'listRepresentativeClients', 'listServiceAreas', 'createServiceArea',
  'updateServiceArea', 'deactivateServiceArea'];
const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/partners.yaml'));
const specIds: string[] = Object.values<any>(spec.paths).flatMap((p) => Object.values<any>(p).map((m) => m?.operationId).filter(Boolean));
const handlerIds = Object.keys(manifest.handlers);
const pending: string[] = [...(((manifest as { pendingOperations?: readonly string[] }).pendingOperations) ?? [])];

describe('T0C-SALES-1: partners manifest covers the sales operations (handler or pending)', () => {
  it('the 15 sales operations are in the spec', () => {
    for (const id of NEW_OPS) expect(specIds, id).toContain(id);
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
  it('each new id is handled or pending, and none of the 68 original operations was made pending to hide a missing handler', () => {
    for (const id of NEW_OPS) expect(handlerIds.includes(id) || pending.includes(id), `${id} neither handled nor pending`).toBe(true);
    // other pending ids must be partners.ticket operations of the contract (T0C-MSGDESK-1, until T0B-MSGDESK-1), read from the spec
    const ticketIds = Object.values<any>(spec.paths).flatMap((p) => Object.values<any>(p))
      .filter((m) => m?.operationId && ['partners.ticket.read', 'partners.ticket.manage'].includes(m['x-permission'])).map((m) => m.operationId as string);
    // T0C-PARTYSET-1 (LD-321): its 13 operations (partners.party_setting / onboarding / party_id_number / penalty codes) are pending until T0B-PARTYSET-1
    const partysetIds = Object.values<any>(spec.paths).flatMap((p) => Object.values<any>(p))
      .filter((m) => m?.operationId && /^partners\.(party_setting|onboarding|party_id_number|penalty)\./.test(m['x-permission'] ?? '')).map((m) => m.operationId as string);
    expect(pending.filter((id) => !NEW_OPS.includes(id) && !ticketIds.includes(id) && !partysetIds.includes(id)), 'only sales, ticket or party settings operations may be pending in partners').toEqual([]);
  });
  it('the partners permission list holds the two sales codes (services/api/src/modules/partners/permissions.ts)', async () => {
    const { PARTNERS_PERMISSIONS } = await import('../../permissions.js');
    expect(PARTNERS_PERMISSIONS).toEqual(expect.arrayContaining(['partners.sales.read', 'partners.sales.manage']));
  });
});
