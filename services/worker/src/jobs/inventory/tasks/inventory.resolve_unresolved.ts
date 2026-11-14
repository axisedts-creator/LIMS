// inventory.resolve_unresolved (02-TRD §9; PRD AC-17.2; 03-APP-FLOW E10): re-runs TRD §8.2-§8.4 for `unresolved` consumption facts of ONE tenant (system actor), at most LIMS_INVENTORY_RESOLVE_BATCH
// (default 1,000) per run, oldest first, and re-enqueues itself while more remain. Enqueued by putInstrumentBinding, updateInventoryStore (default flag set) and updateInventorySettings (default store set).
// Each fact is posted at its ORIGINAL occurred_at / business_date with the rules of that time (§8.3.4) and moves unresolved -> posted in one optimistic update (C2). A fact that still has no store stays
// unresolved (no alert, no write). A run that fails on one fact rolls back that fact only (savepoint) and carries on; the next run retries it.
// The payload tenant must equal the job's tenant (REQ-SEC-024); the optional `after` cursor ({occurred_at, id}) only moves the batch window, so facts that stay unresolved can never starve newer ones.
import type { TaskHandler } from '../../../core/manifest.js';
import { loadInventoryConfig } from '../../../../../api/src/modules/inventory/config.js';
import { assertZone } from '../../../../../api/src/modules/inventory/domain/tenantTime.js';
import { listUnresolvedBatch, lockFact, postUnresolvedFact, resolveStore } from '../../../../../api/src/modules/inventory/service/consumers.service.js';

export const RESOLVE_UNRESOLVED = 'inventory.resolve_unresolved';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

function cursorOf(v: unknown): { occurred_at: string; id: string } | undefined {
  const c = v as { occurred_at?: unknown; id?: unknown } | null | undefined;
  return typeof c?.occurred_at === 'string' && ISO.test(c.occurred_at) && typeof c.id === 'string' && UUID.test(c.id) ? { occurred_at: c.occurred_at, id: c.id } : undefined;
}

export const resolveUnresolved: TaskHandler = async (payload, jobCtx) => {
  const ctx = jobCtx as any;
  const tenantId = ctx.tenantId;
  if (typeof tenantId !== 'string' || payload?.tenant_id !== tenantId) { // the payload can never widen the tenant scope
    ctx.log?.warn?.({ event: 'resolve_unresolved_skipped', reason: 'bad_payload' });
    return;
  }
  const rc = { tx: ctx.tx, tenantId, actorId: ctx.actor.id as string };
  const limit = (await loadInventoryConfig()).resolveBatch;
  const batch = await listUnresolvedBatch(rc, { limit, ...(cursorOf(payload['after']) === undefined ? {} : { after: cursorOf(payload['after'])! }) });
  const facts = batch.slice(0, limit);
  if (facts.length === 0) return;

  const tz = assertZone((await ctx.core.tenant(ctx)).timezone);
  const nowMs = Date.parse(ctx.now());
  const clock = { tz, nowMs };
  const nowIso = new Date(nowMs).toISOString();
  let posted = 0;
  let failed = 0;
  for (const f of facts) {
    try {
      await ctx.db.tx(async () => {
        const fact = await lockFact(rc, f['id']); // a parallel #77 / #78 may have moved it: re-read under the lock
        if (fact === null || fact['status'] !== 'unresolved') return;
        const res = await resolveStore(rc, { instrument_id: fact['instrument_id'], centre_id: fact['centre_id'], processing_branch_id: fact['processing_branch_id'] });
        if (res.store_id === null) return;
        await postUnresolvedFact(rc, fact, res.store_id, fact['version'], clock, nowIso);
        posted += 1;
      });
    } catch (e) {
      failed += 1;
      ctx.log?.error?.({ event: 'resolve_unresolved_fact_failed', fact_id: f['id'], code: (e as { code?: string })?.code }, 'resolve_unresolved fact failed');
    }
  }
  ctx.log?.info?.({ event: 'resolve_unresolved_done', examined: facts.length, posted, failed });

  if (batch.length > limit) { // more remain after this window: continue after the last fact examined
    const last = facts[facts.length - 1]!;
    await ctx.tx.query('SELECT app.enqueue_job($1, $2::jsonb, $3)', [
      RESOLVE_UNRESOLVED, JSON.stringify({ tenant_id: tenantId, after: { occurred_at: last['occurred_at_text'], id: last['id'] } }), `resolve:${tenantId}:all:${last['id']}`,
    ]);
  }
};
