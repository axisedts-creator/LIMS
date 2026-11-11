// PlatformAuthz (02-TRD §5.10, §7.2 step 3; 03-APP-FLOW §9; 08 R10 item 4): the ONLY check for platform.* permissions.
// Pure. Role -> permission from the generated contracts/permissions.yaml registry; privileged codes need aal2 (REQ-SEC-067).
// The platform IP allowlist is enforced by the claims resolver (T4, identity.platform_ip_denied), not here.
import { LimsError } from '../../../core/errors.js';
import { PRIVILEGED, ROLE_GRANTS } from '../../../../../../contracts/ports/generated/permissions.js';

// [CR-C2-T21] `aal` is not yet on the core PlatformRequestContext (CR-C2-004); requested in .orchestra/cr/C2.T21.md.
export interface PlatformAuthzCtx {
  readonly actor: { readonly type: string; readonly id: string; readonly supportSessionId?: string };
  readonly platformRole: string;
  readonly aal?: string;
}

const GRANTS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries(ROLE_GRANTS as Readonly<Record<string, readonly string[]>>)
    .filter(([role]) => role.startsWith('platform_'))
    .map(([role, codes]) => [role, new Set(codes.filter((c) => c.startsWith('platform.')))]),
);

export const PlatformAuthz = {
  assertPlatform(ctx: PlatformAuthzCtx, permission: string): void {
    if (typeof ctx !== 'object' || ctx === null) throw new LimsError('auth.unauthenticated');
    const c = ctx as Partial<PlatformAuthzCtx>;
    if (c.actor?.type !== 'user' || typeof c.actor.id !== 'string' || typeof c.platformRole !== 'string') throw new LimsError('auth.forbidden');
    const held = GRANTS.get(c.platformRole);
    if (!held || typeof permission !== 'string' || !held.has(permission)) throw new LimsError('auth.forbidden');
    if ((PRIVILEGED as ReadonlySet<string>).has(permission) && c.aal !== 'aal2') throw new LimsError('auth.mfa_required');
  },
};
