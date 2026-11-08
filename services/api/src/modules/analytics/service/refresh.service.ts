// Refresh engine (02-TRD §9.2 partition replace, §9.3 `analytics.refresh_tenant`; PRD US-20.2-4; 08 A17 P-22).
// run_started_at = ctx.now() read ONCE, before the marks are read; it is the `last_marked_at <=` guard of every mark delete of the run, so a mark made
// during the run survives. Marks are read in their own write-free tx (no row locks: consumers' ON CONFLICT never waits). Each contiguous <= chunkDays range of
// one family is ONE tx: advisory xact lock, §9.2 replace, guarded mark delete, refresh_runs row, lazy refresh_state upsert. A failed range rolls back as a
// whole; a SEPARATE tx records the failure (error CODE only - messages can carry PHI). Other ranges still run; the first error is rethrown (Graphile backoff).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { FAMILIES, isSnapshotFamily, type Family } from '../domain/families.js';
import { assertTrigger, assertUuid, replacePartition, type RefreshTrigger, type RefreshTx } from '../repository/refresh.repo.js';

export interface RefreshCtx {
  readonly actor: { readonly id: string };
  readonly db: { tx<T>(fn: (c: { tx: RefreshTx }) => Promise<T>): Promise<T> };
  now(): string;
}
export interface RefreshInput {
  readonly tenantId: string; readonly trigger?: RefreshTrigger | undefined;
  readonly chunkDays?: number | undefined;           // [CONV] LIMS_ANALYTICS_SWEEP_CHUNK_DAYS, default 7
  readonly backlogLookbackDays?: number | undefined; // [CONV] LIMS_ANALYTICS_BACKLOG_LOOKBACK_DAYS, default 30 (validated by the repository)
}
interface Range { readonly family: Family; readonly from: string | null; readonly to: string | null }

const DEFAULT_CHUNK_DAYS = 7;
const DAY_MS = 86_400_000;
const addDay = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

const READ_MARKS = `SELECT family, business_date::text AS business_date FROM analytics.dirty_partitions WHERE tenant_id = $1 ORDER BY family, business_date`;
const LOCK = `SELECT pg_advisory_xact_lock(hashtext('analytics:' || $1::text || ':' || $2::text))`; // [CONV] per tenant+family, released at tx end
const DEL_MARKS_RANGE = `DELETE FROM analytics.dirty_partitions
 WHERE tenant_id = $1 AND family = $2 AND business_date >= $3 AND business_date < $4 AND last_marked_at <= $5`;
const DEL_MARKS_SNAPSHOT = `DELETE FROM analytics.dirty_partitions WHERE tenant_id = $1 AND family = $2 AND last_marked_at <= $3`; // only the sentinel date exists (CHECK)
const RUN_OK = `INSERT INTO analytics.refresh_runs (id, tenant_id, family, trigger, date_from, date_to, started_at, finished_at, status, rows_written, created_by, expires_at)
VALUES ($1, $2, $3, $4, $5, $6, now(), clock_timestamp(), 'succeeded', $7, $8, now() + interval '90 days')`;
const RUN_FAILED = `INSERT INTO analytics.refresh_runs (id, tenant_id, family, trigger, date_from, date_to, started_at, finished_at, status, error_code, created_by, expires_at)
VALUES ($1, $2, $3, $4, $5, $6, now(), now(), 'failed', $7, $8, now() + interval '90 days')`;
const STATE_OK = `INSERT INTO analytics.refresh_state (tenant_id, family, last_success_at, last_attempt_at, last_error_code, consecutive_failures, last_run_id, created_by)
VALUES ($1, $2, now(), now(), NULL, 0, $3, $4)
ON CONFLICT (tenant_id, family) DO UPDATE
   SET last_success_at = now(), last_attempt_at = now(), last_error_code = NULL, consecutive_failures = 0, last_run_id = $3`;
const STATE_FAILED = `INSERT INTO analytics.refresh_state (tenant_id, family, last_attempt_at, last_error_code, consecutive_failures, created_by)
VALUES ($1, $2, now(), $3, 1, $4)
ON CONFLICT (tenant_id, family) DO UPDATE
   SET last_attempt_at = now(), last_error_code = EXCLUDED.last_error_code, consecutive_failures = analytics.refresh_state.consecutive_failures + 1`;

/** Dirty marks -> per-family contiguous ranges of <= chunkDays; the snapshot family is one range with no dates. Unknown families are dropped. */
function toRanges(marks: readonly { family: string; business_date: string }[], chunkDays: number): Range[] {
  const out: Range[] = [];
  const byFamily = new Map<Family, string[]>();
  for (const m of marks) {
    if (!(FAMILIES as readonly string[]).includes(m.family)) continue;
    const f = m.family as Family;
    (byFamily.get(f) ?? byFamily.set(f, []).get(f)!).push(m.business_date);
  }
  for (const [family, dates] of byFamily) {
    if (isSnapshotFamily(family)) { out.push({ family, from: null, to: null }); continue; }
    let start = '', prev = '', len = 0;
    for (const d of [...new Set(dates)].sort()) {
      if (len > 0 && d === addDay(prev, 1) && len < chunkDays) { prev = d; len++; continue; }
      if (len > 0) out.push({ family, from: start, to: addDay(prev, 1) });
      start = prev = d; len = 1;
    }
    if (len > 0) out.push({ family, from: start, to: addDay(prev, 1) });
  }
  return out;
}

/** Only a short machine code is stored (refresh_state__error__ck <= 64): never the message. */
const errorCode = (e: unknown): string => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' && /^[\w.:-]{1,64}$/.test(c) ? c : 'refresh_error';
};

async function refreshRange(ctx: RefreshCtx, a: Required<Pick<RefreshInput, 'tenantId'>> & { trigger: RefreshTrigger; runStartedAt: string; backlogLookbackDays?: number | undefined }, r: Range): Promise<void> {
  const runId = uuidv7();
  const actor = ctx.actor.id;
  try {
    await ctx.db.tx(async ({ tx }) => {
      await tx.query(LOCK, [a.tenantId, r.family]);
      const { rowsWritten } = await replacePartition(tx, {
        tenantId: a.tenantId, family: r.family, runId, ...(r.from && r.to ? { from: r.from, to: r.to } : {}),
        ...(a.backlogLookbackDays !== undefined ? { backlogLookbackDays: a.backlogLookbackDays } : {}),
      });
      if (r.from && r.to) await tx.query(DEL_MARKS_RANGE, [a.tenantId, r.family, r.from, r.to, a.runStartedAt]);
      else await tx.query(DEL_MARKS_SNAPSHOT, [a.tenantId, r.family, a.runStartedAt]);
      await tx.query(RUN_OK, [runId, a.tenantId, r.family, a.trigger, r.from, r.to, rowsWritten, actor]);
      await tx.query(STATE_OK, [a.tenantId, r.family, runId, actor]);
    });
  } catch (err) {
    const code = errorCode(err);
    try {
      await ctx.db.tx(async ({ tx }) => {
        await tx.query(RUN_FAILED, [uuidv7(), a.tenantId, r.family, a.trigger, r.from, r.to, code, actor]);
        await tx.query(STATE_FAILED, [a.tenantId, r.family, code, actor]);
      });
    } catch { /* recording the failure must not mask the original error */ }
    throw err;
  }
}

export async function refreshTenant(ctx: RefreshCtx, input: RefreshInput): Promise<{ ranges: number }> {
  assertUuid(input.tenantId, 'tenantId');
  const trigger = input.trigger ?? 'event';
  assertTrigger(trigger);
  const chunkDays = input.chunkDays ?? DEFAULT_CHUNK_DAYS;
  if (!Number.isInteger(chunkDays) || chunkDays < 1) throw new TypeError('chunkDays: positive integer expected');

  const runStartedAt = ctx.now(); // before the marks are read
  const marks = await ctx.db.tx(async ({ tx }) => (await tx.query(READ_MARKS, [input.tenantId])).rows as { family: string; business_date: string }[]);
  const ranges = toRanges(marks, chunkDays);

  let firstError: unknown, failed = false;
  for (const r of ranges) {
    try { await refreshRange(ctx, { tenantId: input.tenantId, trigger, runStartedAt, backlogLookbackDays: input.backlogLookbackDays }, r); }
    catch (e) { if (!failed) { failed = true; firstError = e; } }
  }
  if (failed) throw firstError;
  return { ranges: ranges.length };
}
