// T0C-PARTYSET-1 (LD-321, LD-325(b)) — the 13 party settings operations must not break module boot:
// every operationId of partners.yaml has a handler OR is listed in the manifest's pendingOperations (core/module.ts checkHandlers, AC-0D-1.2 with BOOTGATE-1);
// every pending id is a real operationId. The T0B-PARTYSET-1 handler task moves the ids from pending to handlers; this test stays green on both sides of that move.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSpec, REPO_ROOT } from '../../../../core/module.js';
import { manifest } from '../../index.js';

const NEW_OPS = ['getPartyCommercialSetting', 'setPartyCommercialSetting', 'listPartyOnboarding', 'decidePartyOnboarding', 'listNonCompliancePenalties', 'createNonCompliancePenalty',
  'updateNonCompliancePenalty', 'deactivateNonCompliancePenalty', 'listNonComplianceEvents', 'raiseNonComplianceEvent', 'waiveNonComplianceEvent', 'chargeNonComplianceEvent', 'revealPartyIdNumber'];
const NEW_CODES = ['partners.party_setting.read', 'partners.party_setting.manage', 'partners.onboarding.decide', 'partners.party_id_number.read', 'partners.penalty.manage'];
const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/partners.yaml'));
const specIds: string[] = Object.values<any>(spec.paths).flatMap((p) => Object.values<any>(p).map((m) => m?.operationId).filter(Boolean));
const handlerIds = Object.keys(manifest.handlers);
const pending: string[] = [...(((manifest as { pendingOperations?: readonly string[] }).pendingOperations) ?? [])];

describe('T0C-PARTYSET-1: partners manifest covers the party settings operations (handler or pending)', () => {
  it('the 13 operations are in the spec, each with one of the five partners codes', () => {
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
  it('each new id is handled or pending; no original partners operation was made pending to hide a missing handler', () => {
    for (const id of NEW_OPS) expect(handlerIds.includes(id) || pending.includes(id), `${id} neither handled nor pending`).toBe(true);
    for (const id of ['listPartners', 'createPartner', 'getPartner', 'updatePartner', 'suspendPartner', 'createManifest', 'getPartnerSettings']) expect(handlerIds, `${id} keeps its handler`).toContain(id);
  });
  it('the partners permission list holds the five new codes (services/api/src/modules/partners/permissions.ts)', async () => {
    const { PARTNERS_PERMISSIONS } = await import('../../permissions.js');
    expect(PARTNERS_PERMISSIONS).toEqual(expect.arrayContaining(NEW_CODES));
  });
});
