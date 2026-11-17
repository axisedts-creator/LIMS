// inventory.purge_alerts (02-TRD §9; 05-SCHEMA §4.3, §5; 08 A17 D-72, P-18(c)): weekly, per_tenant. Calls the SECURITY INVOKER `app.purge_inventory_alerts()` under the tenant's claims as the
// `inventory` system actor; the function deletes `tenant_id = current tenant AND expires_at < now()` (10,000 per call) through policy alerts__delete__tenant (system actor only), so this task has no
// DELETE of its own and a user actor deletes nothing (the policy matches no row). The call repeats while it returns 10,000.
import type { TaskHandler } from '../../../core/manifest.js';
import { jobScope } from './_shared.js';

export const PURGE_ALERTS = 'inventory.purge_alerts';
const BATCH = 10_000; // the function's LIMIT

export const purgeAlerts: TaskHandler = async (payload, jobCtx) => {
  const ctx = jobCtx as any;
  const rc = jobScope('purge_alerts', payload, jobCtx);
  if (rc === null) return;
  let total = 0;
  for (;;) {
    const n = Number((await rc.tx.query('SELECT app.purge_inventory_alerts() AS n')).rows[0]?.n ?? 0);
    total += n;
    if (n < BATCH) break;
  }
  ctx.log?.info?.({ event: 'purge_alerts_done', deleted: total });
};
