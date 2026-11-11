// Task smartreport.prebuild_summary {tenant_id, order_id} (02-TRD §9.1; PRD AC-15.5; 08 A19 P-44).
// flag off / no approved library -> done; any non-cancelled result not approved (all_visible) -> done; else buildOrGet(mode 'prebuild') in a savepoint:
// no_eligible_results / template_not_approved roll the savepoint back and finish; every other error propagates (queue retry).
import type { TaskHandler } from '../../../core/manifest.js';
import { LimsError } from '../../../../../api/src/core/errors.js';
import * as libraryRepo from '../../../../../api/src/modules/smartreport/repository/library.repo.js';
import { buildOrGet, type BuildCtx } from '../../../../../api/src/modules/smartreport/summary.service.js';
import { portOf } from '../consumers/supersede.js';

type Row = Record<string, any>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SKIPPED = ['smartreport.no_eligible_results', 'smartreport.template_not_approved'];

/** The worker tx has no .savepoint (reporting precedent); BuildCtx needs one. Names are unique per task run, so nested savepoints are safe. */
function withSavepoint(base: any): any {
  let n = 0;
  const wrapped: any = Object.assign(Object.create(base), {
    async savepoint<T>(fn: (t: any) => Promise<T>): Promise<T> {
      const name = 'sr_sp_' + String(++n);
      await base.query('SAVEPOINT ' + name);
      try {
        const r = await fn(wrapped);
        await base.query('RELEASE SAVEPOINT ' + name);
        return r;
      } catch (e) {
        await base.query('ROLLBACK TO SAVEPOINT ' + name);
        await base.query('RELEASE SAVEPOINT ' + name);
        throw e;
      }
    },
  });
  return wrapped;
}

export const prebuildSummary: TaskHandler = async (payload, jobCtx) => {
  const ctx = jobCtx as unknown as Row;
  const tenantId: string | undefined = ctx['tenantId'];
  const orderId = payload?.['order_id'];
  if (!tenantId || payload?.tenant_id !== tenantId || typeof orderId !== 'string' || !UUID.test(orderId)) {
    ctx['log']?.warn?.({ event: 'prebuild_summary_skipped', reason: 'bad_payload' });
    return;
  }
  const rc = { tx: ctx['tx'], tenantId, actorId: ctx['actor'].id };
  const flags = (await portOf(ctx, 'Identity').getTenantSettings(ctx, { keys: ['featureFlags'] }))?.featureFlags;
  if (flags?.smart_report !== true) return;
  if ((await libraryRepo.getApprovedLibraryVersion(rc)) === null) return;

  const lab = await portOf(ctx, 'Lab').getOrderResults(ctx, { orderId, scope: 'all_visible' });
  const results = (lab.items as Row[]).flatMap((i) => i['results'] as Row[]).filter((r) => r['status'] !== 'cancelled');
  if (results.length === 0 || results.some((r) => r['status'] !== 'approved')) return;           // not complete: a later approval re-enqueues

  const tx = withSavepoint(ctx['tx']);
  const bctx = { ...ctx, tx, now: () => ctx['now'](), ports: { FrontdeskPort: portOf(ctx, 'Frontdesk'), LabPort: portOf(ctx, 'Lab'), CatalogPort: portOf(ctx, 'Catalog') } } as unknown as BuildCtx;
  try {
    await tx.savepoint(() => buildOrGet(bctx, { orderId, mode: 'prebuild' }));
  } catch (e) {
    if (!(e instanceof LimsError && SKIPPED.includes(e.code))) throw e;                           // savepoint already rolled back
  }
};
