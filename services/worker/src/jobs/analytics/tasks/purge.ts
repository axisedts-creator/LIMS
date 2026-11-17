// `analytics.purge` (02-TRD §9.5; cron 15 21 * * * UTC; max_attempts 3; 05-SCHEMA §3 / 08 A17 P-18(c)): retention DELETEs of ONE tenant, as the system actor, in
// batches of 10,000 rows per statement (`WHERE ctid IN (SELECT ctid ... LIMIT 10000)`) to stay under the 5 s statement timeout.
//   E tables: expires_at < now() (order_index, refresh_runs, report_runs, report_run_recipients); exports metadata: requested_at < now() - 400 days (its own
//   expires_at is the FILE expiry); export_files: at expires_at or when downloads are exhausted (parent export -> 'expired').
//   R tables: business_date < fiscalYearBs(today - retentionYears years).startsOn (15 daily_*), tat_facts the same with config.tatRetentionFy (3) fiscal years [CONV].
// [CONV] report_backlog has no business_date (05-SCHEMA; TRD §9.5 lists it in the R row by slip): it is a whole snapshot rewritten by every refresh, never purged here.
// retentionYears is read through IdentityPort and validated BEFORE anything is deleted: a bad value rejects (fail closed).
import { fiscalYearBs, type IsoDate } from '../../../../../../packages/shared-ts/src/bsdate/index.js';
import { loadAnalyticsConfig } from '../../../../../api/src/modules/analytics/config.js';
import { FAMILY_TABLE } from '../../../../../api/src/modules/analytics/domain/families.js';
import type { TaskHandler } from '../../../core/manifest.js';
import { DATED_FAMILIES, jobTenant, localNow } from './shared.js';

const BATCH = 10_000;
const MAX_YEARS = 100;   // sanity ceiling; an absurd value would only keep everything, but it signals a broken setting

/** The calendar date `years` before `iso` (29 Feb -> 28 Feb). */
function yearsBefore(iso: string, years: number): IsoDate {
  const [y, m, d] = iso.split('-') as [string, string, string];
  return `${Number(y) - years}-${m}-${m === '02' && d === '29' ? '28' : d}` as IsoDate;
}

export const purgeTask: TaskHandler = async (payload, ctx) => {
  const tenantId = jobTenant(payload, ctx, 'analytics.purge');
  const settings = await (ctx as any).ports.IdentityPort.getTenantSettings(ctx, { keys: ['retentionYears'] });
  const years = settings?.retentionYears;
  if (typeof years !== 'number' || !Number.isInteger(years) || years < 1 || years > MAX_YEARS) throw new RangeError('analytics.purge: tenant setting retentionYears must be an integer >= 1');
  const cfg = loadAnalyticsConfig();
  const { today } = localNow(ctx);
  const rollupCutoff = fiscalYearBs(yearsBefore(today, years)).startsOn as string;
  const tatCutoff = fiscalYearBs(yearsBefore(today, cfg.tatRetentionFy)).startsOn as string;

  /** Repeats one batch until it deletes fewer than BATCH rows (an exact multiple ends with one empty batch). */
  const batched = async (table: string, where: string, extra: unknown[] = []): Promise<void> => {
    const sql = `DELETE FROM analytics.${table} WHERE ctid IN (SELECT ctid FROM analytics.${table} WHERE tenant_id = $1 AND ${where} LIMIT ${BATCH})`;
    for (;;) if (Number((await ctx.tx.query(sql, [tenantId, ...extra])).rowCount ?? 0) < BATCH) return;
  };

  // exports whose file is expired or exhausted become 'expired' (the row stays as metadata), then the file rows go
  await ctx.tx.query(
    `UPDATE analytics.exports SET status = 'expired', version = version + 1, updated_at = now(), updated_by = $2
      WHERE tenant_id = $1 AND status = 'ready' AND (expires_at < now() OR downloads_used >= downloads_allowed)`, [tenantId, ctx.actor.id]);
  await batched('export_files', `(expires_at < now() OR export_id IN (SELECT id FROM analytics.exports WHERE tenant_id = $1 AND downloads_used >= downloads_allowed))`);
  await batched('exports', `requested_at < now() - interval '400 days'`);
  for (const t of ['report_run_recipients', 'report_runs', 'refresh_runs', 'order_index']) await batched(t, 'expires_at < now()');   // children first (FKs)
  for (const family of DATED_FAMILIES) {
    const table = FAMILY_TABLE[family];
    await batched(table, 'business_date < $2::date', [table === 'tat_facts' ? tatCutoff : rollupCutoff]);
  }
};
