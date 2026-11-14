// identity.remove_mfa_factors (02-TRD §10 row; 01-PRD US-B5; 05-SCHEMA §4.2 identity.mfa_factors).
// Payload {tenant_id, user_id, membership_id} | {user_id, platform_staff_id}. Every non-removed mirror factor -> adminDeleteFactor
// (404 = already gone), then ONE markRemoved('admin_reset'). Any other failure is rethrown before the mark (tx rolls back; the retry re-lists).
import type { TaskHandler } from '../../../core/manifest.js';
import type { GoTrueGateway } from '../../../../../api/src/modules/identity/gotrue/gateway.js';
import { coreErrors, gone, gotrue, isUuid, malformed, platformUnwired, q, sameTenant, shapeOf } from './shared.js';

export const REMOVE_MFA_FACTORS = 'identity.remove_mfa_factors';
const GONE = ['mfa_factor_not_found', 'user_not_found'];

export interface MirrorFactor { id: string; gotrue_factor_id: string; status: string }
export interface RemoveMfaFactorsDeps {
  gotrue: Pick<GoTrueGateway, 'adminDeleteFactor'>;
  repo: {
    listFactors(tx: unknown, a: { tenantId: string | undefined; userId: string }): Promise<MirrorFactor[]>;
    markRemoved(tx: unknown, a: { tenantId: string | undefined; userId: string; factorIds: string[]; removedAt: string; removedBy: string; reason: 'admin_reset' }): Promise<void>;
  };
}

const SHAPES = { tenant: ['tenant_id', 'user_id', 'membership_id'], platform: ['user_id', 'platform_staff_id'] } as const;

export function createRemoveMfaFactors(deps: RemoveMfaFactorsDeps): TaskHandler {
  return coreErrors(async (payload, ctx) => {
    const s = shapeOf(payload, SHAPES);
    if (!s || !sameTenant(s[1], ctx)) return malformed(REMOVE_MFA_FACTORS);
    const [shape, p] = s;
    if (!isUuid(p['user_id']) || !isUuid(p[shape === 'tenant' ? 'membership_id' : 'platform_staff_id'])) return malformed(REMOVE_MFA_FACTORS);
    const userId = p['user_id'] as string; const tenantId = ctx.tenantId;
    const live = (await deps.repo.listFactors(ctx.tx, { tenantId, userId })).filter((f) => f.status !== 'removed');
    if (!live.length) return;
    for (const f of live) await deps.gotrue.adminDeleteFactor(userId, f.gotrue_factor_id).catch((e) => { if (!gone(e, GONE)) throw e; });
    await deps.repo.markRemoved(ctx.tx, { tenantId, userId, factorIds: live.map((f) => f.id), removedAt: ctx.now(), removedBy: ctx.actor.id, reason: 'admin_reset' });
  });
}

// ---------- default wiring (tenant rows; platform rows fail closed, see shared.platformUnwired) ----------
const LIST_SQL = `SELECT id, gotrue_factor_id, status FROM identity.mfa_factors WHERE tenant_id = $1 AND user_id = $2 AND status <> 'removed' FOR UPDATE`;
const REMOVE_SQL = `UPDATE identity.mfa_factors SET status = 'removed', removed_at = $4, removed_by = $5, removal_reason = $6, updated_at = now(), updated_by = $5,
    version = version + 1
  WHERE tenant_id = $1 AND user_id = $2 AND id = ANY($3::uuid[]) AND status <> 'removed'`;
const tenantOnly = (t: string | undefined) => t ?? platformUnwired('mfa factors');
export const removeMfaFactors: TaskHandler = createRemoveMfaFactors({
  gotrue: { adminDeleteFactor: (u, f) => gotrue().adminDeleteFactor(u, f) },
  repo: {
    listFactors: async (tx, a) => (await q(tx, LIST_SQL, [tenantOnly(a.tenantId), a.userId])) as unknown as MirrorFactor[],
    markRemoved: async (tx, a) => { await q(tx, REMOVE_SQL, [tenantOnly(a.tenantId), a.userId, a.factorIds, a.removedAt, a.removedBy, a.reason]); },
  },
});
