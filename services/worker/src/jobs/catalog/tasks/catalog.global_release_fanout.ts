// catalog.global_release_fanout (02-TRD §10, §9.1; AC-19.5; per_tenant, every 10 min): if catalog.g_reference_release.release_no is ahead of the
// tenant's catalog_state.global_release_seen, bump the revision once, record the release as seen and publish ONE catalog.changed.v1
// {entity_type global_reference, change_kind updated, entity_id = catalog_root_id, effective_from = job time} — one transaction, so a failed
// publish rolls the bump back and the retry (max_attempts 3) bumps exactly once. The row lock on catalog_state serialises with writers.
// [CONV] several releases behind = one bump; no release row, or seen >= release_no = no-op; a missing catalog_state row is created lazily
// (as bumpRevision does). The event envelope mirrors services/api/.../events/publish.ts (aggregate {catalog, root, seq}, key `<tenant>:catalog:<rev>`).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { TaskHandler } from '../../../core/manifest.js';
import { claimedTenant } from './tenant.js';

export const GLOBAL_RELEASE_FANOUT = 'catalog.global_release_fanout';

const LOCK_STATE = 'SELECT global_release_seen FROM catalog.catalog_state WHERE tenant_id = $1 FOR UPDATE';

export const globalReleaseFanout: TaskHandler = async (payload, ctx) => {
  const tenantId = claimedTenant(payload, ctx);
  const release = (await ctx.tx.query('SELECT release_no FROM catalog.g_reference_release WHERE id = 1', [])).rows[0];
  if (!release) return;
  const releaseNo = Number(release.release_no);

  let state = (await ctx.tx.query(LOCK_STATE, [tenantId])).rows[0];
  if (!state) {
    await ctx.tx.query(
      'INSERT INTO catalog.catalog_state (tenant_id, catalog_root_id, created_by) VALUES ($1, $2, $3) ON CONFLICT (tenant_id) DO NOTHING',
      [tenantId, uuidv7(), ctx.actor.id],
    );
    state = (await ctx.tx.query(LOCK_STATE, [tenantId])).rows[0];
  }
  if (!state || Number(state.global_release_seen) >= releaseNo) return;

  const bumped = (await ctx.tx.query(
    `UPDATE catalog.catalog_state SET catalog_revision = catalog_revision + 1, global_release_seen = $2, updated_at = now()
     WHERE tenant_id = $1 AND global_release_seen < $2 RETURNING catalog_revision, catalog_root_id`,
    [tenantId, releaseNo],
  )).rows[0];
  if (!bumped) return;                                                  // another session already recorded this release
  const revision = Number(bumped.catalog_revision);                     // bigint arrives as string

  await (ctx.events as { publish(c: unknown, type: string, input: object): Promise<unknown> }).publish(ctx, 'catalog.changed.v1', {
    aggregate: { type: 'catalog', id: bumped.catalog_root_id, seq: revision },
    idempotencyKey: `${tenantId}:catalog:${revision}`,
    payload: { catalog_revision: revision, entity_type: 'global_reference', entity_id: bumped.catalog_root_id, change_kind: 'updated', effective_from: ctx.now() },
  });
  ctx.log.info({ revision, release_no: releaseNo }, 'catalog.global_release_fanout bumped');
};
