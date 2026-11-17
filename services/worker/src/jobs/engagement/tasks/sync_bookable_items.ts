// engagement.sync_bookable_items (02-TRD §8.1, max_attempts 5; US-EN-26.2/26.3) and its nightly cron task engagement.sync_bookable_items_nightly (§8.2, 01:40 Asia/Kathmandu).
// Sync: for every bookable item of the job tenant, re-read C3 as the system actor (getTest/getPanel, priceFor tenant default) and refresh the snapshot.
//   catalog-inactive -> is_active=false; catalog.no_price -> price NULL (item stays bookable); common.not_found (gone from C3) -> deactivated, the others continue.
//   [CONV] a sync never RE-activates an item staff switched off, and does not bump `version` (staff If-Match stays valid across a sync). Any other port error fails the task (queue retries; the tx rolls back).
// Tenant guard (REQ-SEC-024): both tasks act only when payload.tenant_id is a uuid equal to the job's tenant; otherwise they resolve without running a statement or port call.
import { LimsError } from '../../../../../api/src/core/errors.js';
import { ENQUEUE_SQL, SYNC_MAX_ATTEMPTS, SYNC_TASK, fetchSnapshot, syncJobKey } from '../../../../../api/src/modules/engagement/service/bookable.service.js';
import * as repo from '../../../../../api/src/modules/engagement/repository/bookable.repo.js';
import type { TaskHandler } from '../../../core/manifest.js';

export const SYNC_NIGHTLY = 'engagement.sync_bookable_items_nightly';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ownTenant = (payload: any, ctx: any): string | undefined => {
  const t = payload?.tenant_id;
  return typeof t === 'string' && UUID.test(t) && ctx.tenantId === t ? t : undefined;
};

/** Enqueue (or collapse into) the one sync job of this tenant; runAt null = as soon as possible. */
export async function enqueueSync(ctx: any, tenantId: string, runAt: string | null): Promise<void> {
  await ctx.tx.query(ENQUEUE_SQL, [SYNC_TASK, JSON.stringify({ tenant_id: tenantId }), syncJobKey(tenantId), runAt, SYNC_MAX_ATTEMPTS]);
}

export const syncBookableItems: TaskHandler = async (payload, jobCtx) => {
  const ctx = jobCtx as any;
  const tenantId = ownTenant(payload, ctx);
  if (!tenantId) { ctx.log?.warn?.({ event: 'sync_bookable_items_skipped', reason: 'bad_payload' }); return; }
  const userId = ctx.actor.id as string;
  // ponytail: sequential C3 calls, one pair per item; fine for a catalogue of hundreds. Batch via resolveOrderables if a tenant outgrows the job timeout.
  for (const item of await repo.listAll(ctx.tx, { tenantId })) {
    const id = item['id'] as string;
    try {
      const { snap, catalogActive } = await fetchSnapshot(ctx, { kind: item['orderable_kind'], orderableId: item['orderable_id'], requireActive: false });
      await repo.syncSnapshot(ctx.tx, { tenantId, userId, id, isActive: item['is_active'] === true && catalogActive, syncedAt: ctx.now(), snap });
    } catch (e) {
      if (!(e instanceof LimsError && e.code === 'common.not_found')) throw e;
      await repo.deactivate(ctx.tx, { tenantId, userId, id });
    }
  }
};

export const syncBookableItemsNightly: TaskHandler = async (payload, jobCtx) => {
  const ctx = jobCtx as any;
  const tenantId = ownTenant(payload, ctx);
  if (!tenantId) return;
  await enqueueSync(ctx, tenantId, null);
};
