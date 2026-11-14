// `analytics.refresh_tenant` (02-TRD §9.3; max_attempts 5): thin wrapper over the refresh engine. The payload tenant must be the job's tenant
// context (no cross-tenant refresh by payload); extra payload fields are ignored. A failing family rejects so Graphile backs off and retries.
import { refreshTenant } from '../../../../../api/src/modules/analytics/service/refresh.service.js';
import type { TaskHandler } from '../../../core/manifest.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const refreshTenantTask: TaskHandler = async (payload, ctx) => {
  const tenantId = (payload as { tenant_id?: unknown } | null)?.tenant_id;
  if (typeof tenantId !== 'string' || !UUID.test(tenantId)) throw new TypeError('analytics.refresh_tenant: payload.tenant_id must be a uuid');
  if (ctx.tenantId !== tenantId) throw new Error('analytics.refresh_tenant: payload tenant differs from the job tenant context');
  await refreshTenant(ctx as never, { tenantId, trigger: 'event' });
};
