// engagement.expire_memberships (02-TRD §8.2 cron; PRD US-EN-17.6): active cards with valid_to < today (Asia/Kathmandu) -> 'expired'. Idempotent: a rerun matches nothing.
// Acts as the system actor (holds engagement.membership.enrol "(expiry)", 02-TRD §9.3). Never INSERT/DELETE; cancelled and expired rows are not matched.
// Tenant guard (REQ-SEC-024): acts only when payload.tenant_id is a uuid equal to the job's tenant; otherwise it resolves without running a statement.
import type { TaskHandler } from '../../../core/manifest.js';
import { businessDate } from '../../../../../api/src/modules/engagement/domain/queueToken.state.js';

export const EXPIRE_MEMBERSHIPS = 'engagement.expire_memberships';
const TENANT_TZ = 'Asia/Kathmandu'; // [CONV] 05-SCHEMA P-15: the only v1 tenant timezone
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const expireMemberships: TaskHandler = async (payload, ctx) => {
  const tenantId = payload?.tenant_id;
  if (typeof tenantId !== 'string' || !UUID.test(tenantId) || ctx.tenantId !== tenantId) return;
  await ctx.tx.query(
    `UPDATE engagement.patient_memberships SET status = 'expired', version = version + 1, updated_at = now(), updated_by = $2
     WHERE tenant_id = $1 AND status = 'active' AND valid_to < $3::date`,
    [tenantId, ctx.actor.id, businessDate(new Date(ctx.now()), TENANT_TZ)]);
};
