// Shared by the T-26 per_tenant cron tasks (08 A13 P-6): the job runs under ONE tenant's claims; the payload {tenant_id} must agree with them.
import type { JobContext } from '../../../core/manifest.js';

export function claimedTenant(payload: { tenant_id?: string }, ctx: JobContext): string {
  const tenantId = ctx.tenantId;
  if (!tenantId) throw Object.assign(new Error('common.internal'), { code: 'common.internal' });
  if (payload.tenant_id !== undefined && payload.tenant_id !== tenantId) throw Object.assign(new Error('common.forbidden'), { code: 'common.forbidden' });
  return tenantId;
}
