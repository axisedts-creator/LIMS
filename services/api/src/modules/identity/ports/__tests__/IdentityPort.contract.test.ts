// T5: 03-IC §4.6 contract cases (1)-(13) + extras, run verbatim against the REAL impl (02-TRD §7 "Contract cases").
// The shared suite (packages/fakes/contract-tests/IdentityPort.contract.ts, C0-owned, not edited here) seeds fake-fixture-shaped
// memberships; this file is the "real-impl harness maps them" part: fixtures -> in-memory CoreAdminRepo -> createIdentityPort.
// Expected now: fails on missing ../IdentityPort.impl.js.
import { describe, expect, it } from 'vitest';
import { runIdentityPortContract } from '../../../../../../../packages/fakes/contract-tests/IdentityPort.contract';
import { makeCtxFor, type ContractHarness } from '../../../../../../../packages/fakes/src/harness';
import { ROLE_GRANTS } from '../../../../../../../contracts/ports/generated/permissions';
import { makeFakeRepo, type MemberRow, FIXED_NOW } from './helpers';
import { createIdentityPort } from '../IdentityPort.impl.js';

async function makeRealImpl(): Promise<ContractHarness> {
  const { repo, st } = makeFakeRepo();
  const impl = createIdentityPort({ repo: repo as any, systemActorPermissions: () => ['identity.signatory.read'] });
  return {
    impl,
    events: { rollback() {} } as any,
    ctxFor: makeCtxFor(),
    async seed(fixtures: any) {
      for (const r of fixtures.memberships ?? []) {
        const m: MemberRow = {
          membershipId: r.id, userId: r.id.replace(/.$/, 'f'), tenantId: r.tenantId, actorId: r.actorId, actorType: r.actorType,
          status: r.status, lockedAt: r.isLocked ? FIXED_NOW : null, displayName: r.displayName, email: r.email, roleCodes: [...r.roles],
          permissions: r.status === 'active' ? [...new Set<string>((r.roles as string[]).flatMap((x) => ROLE_GRANTS[x] ?? []))] : [],
          allCentres: r.centreScope.all, centreIds: [...r.centreScope.centreIds], branchIds: [...r.branchIds], mfaEnrolled: r.mfaLevel === 'aal2',
          version: r.version, ...(r.partnerRole ? { partnerRole: r.partnerRole } : {}),
        };
        st.members.push(m);
      }
    },
    rollback() {},
  };
}

describe('IdentityPort real impl: shape', () => {
  it('exposes all twelve methods (02-TRD §7)', async () => {
    const h = await makeRealImpl();
    for (const k of ['getActor', 'assertRole', 'getTenantSettings', 'getSignatories', 'readBrandingAsset', 'provisionPartnerMembership',
      'updatePartnerMembership', 'provisionPatientMembership', 'openPatientSession', 'revokePatientSessions', 'getStaffNotificationContact',
      'readSignatureImage']) expect(typeof (h.impl as any)[k], k).toBe('function');
  });
});

runIdentityPortContract(makeRealImpl);
