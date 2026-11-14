// T-20 (C3) test fixture: fake IdentityPort.assertRole (03-IC §4 IdentityPort; 08 A13 P-10).
// Semantics copied from the port: a missing permission -> LimsError auth.forbidden; a `privileged: true` permission
// (contracts/permissions.yaml: catalog.price_list.manage, catalog.referrer.export, catalog.reference_range.publish)
// requires aal2, else auth.mfa_required. Every call is recorded so tests can check WHICH permission was asserted.
import { LimsError } from '../../../../core/errors.js';

export const PRIVILEGED = new Set(['catalog.price_list.manage', 'catalog.referrer.export', 'catalog.reference_range.publish', 'catalog.instrument_code_map.manage']);   // last: 08 A13 D-18 (T-27)

export interface AssertCall { readonly ctx: unknown; readonly permission: string }

export function makeIdentity(grants: readonly string[], aal: 1 | 2 = 2) {
  const calls: AssertCall[] = [];
  return {
    calls,
    async assertRole(ctx: unknown, requirement: { permission: string }): Promise<void> {
      calls.push({ ctx, permission: requirement?.permission });
      if (!grants.includes(requirement?.permission)) throw new LimsError('auth.forbidden');
      if (PRIVILEGED.has(requirement.permission) && aal < 2) throw new LimsError('auth.mfa_required');
    },
  };
}
export type FakeIdentity = ReturnType<typeof makeIdentity>;
