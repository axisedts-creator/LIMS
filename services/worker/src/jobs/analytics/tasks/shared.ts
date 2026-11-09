// Helpers of the AN-T06 tasks (sweeps, self-check, purge, backfill; 02-TRD §9.3): payload trust, Asia/Kathmandu "today" from the INJECTED clock, dirty marking.
import { FAMILIES, SNAPSHOT_DATE, isSnapshotFamily, type Family } from '../../../../../api/src/modules/analytics/domain/families.js';
import { assertUuid, markDirty, type RefreshTrigger } from '../../../../../api/src/modules/analytics/repository/refresh.repo.js';
import type { JobContext } from '../../../core/manifest.js';

export const DATED_FAMILIES: readonly Family[] = FAMILIES.filter((f) => !isSnapshotFamily(f));
const DAY_MS = 86_400_000;
const KTM_OFFSET_MS = (5 * 60 + 45) * 60_000; // Asia/Kathmandu is UTC+05:45, no DST

/** The tenant of a per-tenant job is the one of its claims; a payload naming another tenant (or none) is refused before any statement (REQ-SEC-024). */
export function jobTenant(payload: unknown, ctx: JobContext, task: string): string {
  const tenantId = (payload as { tenant_id?: unknown } | null)?.tenant_id;
  assertUuid(tenantId, `${task}: payload.tenant_id`);
  assertUuid(ctx.tenantId, `${task}: job tenant`);
  if (ctx.tenantId !== tenantId) throw new Error(`${task}: payload tenant differs from the job tenant context`);
  return tenantId;
}

export const addDays = (iso: string, n: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** Local (Asia/Kathmandu) calendar date and minutes since local midnight of the injected job clock. */
export function localNow(ctx: JobContext): { today: string; minutes: number } {
  const t = Date.parse(ctx.now());
  if (Number.isNaN(t)) throw new TypeError('ctx.now(): ISO timestamp expected');
  const local = new Date(t + KTM_OFFSET_MS);
  return { today: local.toISOString().slice(0, 10), minutes: local.getUTCHours() * 60 + local.getUTCMinutes() };
}

/** Marks `families` x `days` dirty (dated families only get days; the snapshot family gets its sentinel date once). */
export async function markAll(ctx: JobContext, tenantId: string, reason: RefreshTrigger, days: readonly string[], families: readonly Family[] = FAMILIES): Promise<void> {
  // ponytail: one INSERT per (family, day) - 600 for the nightly; a multi-row insert if the 120 s budget is ever tight
  for (const family of families) {
    if (isSnapshotFamily(family)) { await markDirty(ctx.tx, { tenantId, family, businessDate: SNAPSHOT_DATE, reason, actorId: ctx.actor.id }); continue; }
    for (const businessDate of days) await markDirty(ctx.tx, { tenantId, family, businessDate, reason, actorId: ctx.actor.id });
  }
}
