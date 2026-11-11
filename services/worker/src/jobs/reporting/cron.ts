// reporting crontab (02-TRD §9). sweep_assembly: reports with needs_assembly older than 2 min -> keyed assembly job (covers lost debounce races).
// Only enqueues; the keyed job `assemble:<report_id>` is the same one the consumers use, so a duplicate collapses in the queue.
import type { CronEntry, TaskHandler } from '../../core/manifest.js';
import { ENQUEUE_SQL } from '../../core/fanout.js';

export const SWEEP_ASSEMBLY = 'reporting.sweep_assembly';
const STALE_MS = 120_000;
const BATCH = 200;   // ponytail: one tick enqueues <= 200 reports; the rest follow on the next tick (5 min). Raise if backlogs outlast that.

export const sweepAssembly: TaskHandler = async (payload, jobCtx) => {
  const ctx = jobCtx as any;
  const tenantId = ctx.tenantId;
  if (typeof tenantId !== 'string' || payload?.tenant_id !== tenantId) {
    ctx.log?.warn?.({ event: 'sweep_assembly_skipped', reason: 'bad_payload' });
    return;
  }
  const cutoff = new Date(Date.parse(ctx.now()) - STALE_MS).toISOString();
  const { rows } = await ctx.tx.query(
    `SELECT id FROM reporting.reports WHERE tenant_id = $1 AND needs_assembly = true AND needs_assembly_since < $2 ORDER BY needs_assembly_since LIMIT ${BATCH}`,
    [tenantId, cutoff]);
  for (const r of rows as { id: string }[]) {
    await ctx.tx.query(ENQUEUE_SQL, ['reporting.assemble_report', JSON.stringify({ tenant_id: tenantId, report_id: r.id }), `assemble:${r.id}`, null, 10]);
  }
};

/** T33 alert gauges: age in seconds of the oldest of `rows` (0 when none, so a cleared alert resolves). Aggregated in JS (the rows are the few in-flight / held versions of one tenant). */
const oldestSeconds = (nowMs: number, stamps: unknown[]): number =>
  stamps.length ? Math.max(0, Math.floor((nowMs - Math.min(...stamps.map((t) => new Date(t as string).getTime()))) / 1000)) : 0;

export const SWEEP_RENDERS = 'reporting.sweep_stuck_renders';
const STUCK_RENDER_MS = 900_000;   // 15 min (02-TRD §9, E10)

/** `rendering` for > 15 min without finishing (lost enqueue, dead worker) -> the same keyed render job the assembly / retry-render enqueue, so a live job collapses.
 *  Age = rendering_started_at (set by retry-render), falling back to created_at when it is NULL. Only enqueues. */
export const sweepStuckRenders: TaskHandler = async (payload, jobCtx) => {
  const ctx = jobCtx as any;
  const tenantId = ctx.tenantId;
  if (typeof tenantId !== 'string' || payload?.tenant_id !== tenantId) {
    ctx.log?.warn?.({ event: 'sweep_stuck_renders_skipped', reason: 'bad_payload' });
    return;
  }
  const nowMs = Date.parse(ctx.now());
  const cutoff = new Date(nowMs - STUCK_RENDER_MS).toISOString();
  const inflight = (await ctx.tx.query(`SELECT rendering_started_at, created_at FROM reporting.report_versions WHERE tenant_id = $1 AND status = 'rendering'`, [tenantId])).rows as { rendering_started_at: unknown; created_at: unknown }[];
  ctx.metrics?.set?.('lims_reporting_versions_rendering_oldest_seconds', oldestSeconds(nowMs, inflight.map((r) => r.rendering_started_at ?? r.created_at)), { tenant_id: tenantId });   // alert: > 900 for 5m (02-TRD §12)
  const select = (age: string) => ctx.tx.query(`SELECT id, report_id FROM reporting.report_versions WHERE tenant_id = $1 AND status = 'rendering' AND ${age} LIMIT ${BATCH}`, [tenantId, cutoff]);
  const stuck = [...(await select('rendering_started_at < $2')).rows, ...(await select('rendering_started_at IS NULL AND created_at < $2')).rows] as { id: string; report_id: string }[];
  for (const r of stuck.slice(0, BATCH)) {
    await ctx.tx.query(ENQUEUE_SQL, ['reporting.render_report_version', JSON.stringify({ tenant_id: tenantId, report_id: r.report_id, report_version_id: r.id }), `render:${r.id}`, null, 5]);
  }
};

export const SWEEP_HELD = 'reporting.sweep_held_releases';

/** Rendered versions held for dues (held_basis set by the release task) in auto mode -> the keyed release task, which asks BillingPort. Hints are not authoritative, so a
 *  missed billing.balance.changed.v1 only delays a release by one tick. Only enqueues: no BillingPort call, no write. */
export const sweepHeldReleases: TaskHandler = async (payload, jobCtx) => {
  const ctx = jobCtx as any;
  const tenantId = ctx.tenantId;
  if (typeof tenantId !== 'string' || payload?.tenant_id !== tenantId) {
    ctx.log?.warn?.({ event: 'sweep_held_releases_skipped', reason: 'bad_payload' });
    return;
  }
  const held = (await ctx.tx.query(`SELECT rendered_at, created_at FROM reporting.report_versions WHERE tenant_id = $1 AND status = 'rendered' AND held_basis IS NOT NULL`, [tenantId])).rows as { rendered_at: unknown; created_at: unknown }[];
  ctx.metrics?.set?.('lims_reporting_held_oldest_seconds', oldestSeconds(Date.parse(ctx.now()), held.map((r) => r.rendered_at ?? r.created_at)), { tenant_id: tenantId });   // alert: > 7 d for 1h (02-TRD §12)
  ctx.metrics?.set?.('lims_reporting_held_versions', held.length, { tenant_id: tenantId });
  const s = (await ctx.tx.query('SELECT auto_release FROM reporting.settings WHERE tenant_id = $1', [tenantId])).rows[0];
  if ((s?.auto_release ?? 'when_eligible') !== 'when_eligible') return;
  const { rows } = await ctx.tx.query(`SELECT id, report_id FROM reporting.report_versions WHERE tenant_id = $1 AND status = 'rendered' AND held_basis IS NOT NULL ORDER BY held_checked_at ASC NULLS FIRST, id LIMIT ${BATCH}`, [tenantId]);
  for (const r of rows as { id: string; report_id: string }[]) {
    await ctx.tx.query(ENQUEUE_SQL, ['reporting.release_if_eligible', JSON.stringify({ tenant_id: tenantId, report_id: r.report_id, report_version_id: r.id }), `release:${r.id}`, null, 10]);
  }
};

export const EXPIRE_PAYMENTS = 'reporting.expire_portal_payment_requests';
const READY_GRACE_MS = 30 * 60_000;     // `ready` expires 30 min after the gateway intent's own expiry (02-TRD §9, 08 A11.1)
const QUEUED_TIMEOUT_MS = 15 * 60_000;  // a `queued` request nobody picked up in 15 min fails `timeout` [CONV]

/** Frees the order's open slot: stale `ready` -> expired and `queued` too long -> failed `timeout`. Table writes only: no BillingPort / PaymentProviderPort call (as C16 expire_payment_requests). */
export const expirePortalPaymentRequests: TaskHandler = async (payload, jobCtx) => {
  const ctx = jobCtx as any;
  const tenantId = ctx.tenantId;
  if (typeof tenantId !== 'string' || payload?.tenant_id !== tenantId) {
    ctx.log?.warn?.({ event: 'expire_portal_payment_requests_skipped', reason: 'bad_payload' });
    return;
  }
  const now: string = ctx.now(); const nowMs = Date.parse(now); const actorId: string = ctx.actor.id;
  await ctx.tx.query(`UPDATE reporting.portal_payment_requests SET status = 'expired', review = false, action_json = NULL, updated_at = $2, updated_by = $3, version = version + 1
      WHERE tenant_id = $1 AND status = 'ready' AND intent_expires_at < $4`, [tenantId, now, actorId, new Date(nowMs - READY_GRACE_MS).toISOString()]);
  await ctx.tx.query(`UPDATE reporting.portal_payment_requests SET status = 'failed', failure_code = 'timeout', updated_at = $2, updated_by = $3, version = version + 1
      WHERE tenant_id = $1 AND status = 'queued' AND created_at < $4`, [tenantId, now, actorId, new Date(nowMs - QUEUED_TIMEOUT_MS).toISOString()]);
};

export const PURGE_EPHEMERAL = 'reporting.purge_ephemeral';   // body: tasks/purge_ephemeral.ts (C6-T16: print_jobs part)

export const crontab: readonly CronEntry[] = Object.freeze([
  Object.freeze({ identifier: PURGE_EPHEMERAL, schedule: '17 20 * * *', tenantScope: 'per_tenant' as const, maxAttempts: 5 }),
  Object.freeze({ identifier: SWEEP_ASSEMBLY, schedule: '*/5 * * * *', tenantScope: 'per_tenant' as const, maxAttempts: 5 }),
  Object.freeze({ identifier: SWEEP_RENDERS, schedule: '*/10 * * * *', tenantScope: 'per_tenant' as const, maxAttempts: 5 }),
  Object.freeze({ identifier: SWEEP_HELD, schedule: '*/15 * * * *', tenantScope: 'per_tenant' as const, maxAttempts: 5 }),
  Object.freeze({ identifier: EXPIRE_PAYMENTS, schedule: '*/10 * * * *', tenantScope: 'per_tenant' as const, maxAttempts: 5 }),
]);
