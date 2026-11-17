// Global env of module analytics (02-TRD §11, `LIMS_ANALYTICS_*`). Fails fast at boot: an invalid value throws an Error
// naming the key. [CONV] field names camelCase; integers only decimal digits >= 1; booleans only `true`/`false`; time `HH:MM`.

export interface AnalyticsConfig {
  readonly maxRangeDays: number;
  readonly debounceSeconds: number;
  readonly sweepChunkDays: number;
  readonly nightlyDays: number;
  readonly staleDirtyMinutes: number;
  readonly staleSuccessMinutes: number;
  readonly backlogLookbackDays: number;
  readonly yesterdayUntilLocal: string;
  readonly manualRefreshMinutes: number;
  readonly exportsPerUserHour: number;
  readonly exportsPerTenantDay: number;
  readonly exportMaxRows: number;
  readonly exportMaxBytes: number;
  readonly exportTtlHours: number;
  readonly exportDownloads: number;
  readonly pdfEnabled: boolean;
  readonly maxSchedulesPerTenant: number;
  readonly tatRetentionFy: number;
}

type Env = Readonly<Record<string, string | undefined>>;

function posInt(env: Env, key: string, dflt: number): number {
  const v = env[key];
  if (v === undefined) return dflt;
  const n = /^[0-9]{1,15}$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`config: ${key} must be an integer >= 1`);
  return n;
}

function bool(env: Env, key: string, dflt: boolean): boolean {
  const v = env[key];
  if (v === undefined) return dflt;
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new Error(`config: ${key} must be 'true' or 'false'`);
}

function hhmm(env: Env, key: string, dflt: string): string {
  const v = env[key];
  if (v === undefined) return dflt;
  if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(v)) throw new Error(`config: ${key} must be HH:MM`);
  return v;
}

export function loadAnalyticsConfig(env: Env = process.env): AnalyticsConfig {
  return Object.freeze({
    maxRangeDays: posInt(env, 'LIMS_ANALYTICS_MAX_RANGE_DAYS', 366),
    debounceSeconds: posInt(env, 'LIMS_ANALYTICS_DEBOUNCE_SECONDS', 60),
    sweepChunkDays: posInt(env, 'LIMS_ANALYTICS_SWEEP_CHUNK_DAYS', 7),
    nightlyDays: posInt(env, 'LIMS_ANALYTICS_NIGHTLY_DAYS', 40),
    staleDirtyMinutes: posInt(env, 'LIMS_ANALYTICS_STALE_DIRTY_MINUTES', 20),
    staleSuccessMinutes: posInt(env, 'LIMS_ANALYTICS_STALE_SUCCESS_MINUTES', 30),
    backlogLookbackDays: posInt(env, 'LIMS_ANALYTICS_BACKLOG_LOOKBACK_DAYS', 30),
    yesterdayUntilLocal: hhmm(env, 'LIMS_ANALYTICS_YESTERDAY_UNTIL_LOCAL', '06:00'),
    manualRefreshMinutes: posInt(env, 'LIMS_ANALYTICS_MANUAL_REFRESH_MINUTES', 5),
    exportsPerUserHour: posInt(env, 'LIMS_ANALYTICS_EXPORTS_PER_USER_HOUR', 10),
    exportsPerTenantDay: posInt(env, 'LIMS_ANALYTICS_EXPORTS_PER_TENANT_DAY', 50),
    exportMaxRows: posInt(env, 'LIMS_ANALYTICS_EXPORT_MAX_ROWS', 100000),
    exportMaxBytes: posInt(env, 'LIMS_ANALYTICS_EXPORT_MAX_BYTES', 20971520),
    exportTtlHours: posInt(env, 'LIMS_ANALYTICS_EXPORT_TTL_HOURS', 24),
    exportDownloads: posInt(env, 'LIMS_ANALYTICS_EXPORT_DOWNLOADS', 3),
    pdfEnabled: bool(env, 'LIMS_ANALYTICS_PDF_ENABLED', false),
    maxSchedulesPerTenant: posInt(env, 'LIMS_ANALYTICS_MAX_SCHEDULES_PER_TENANT', 20),
    tatRetentionFy: posInt(env, 'LIMS_ANALYTICS_TAT_RETENTION_FY', 3),
  });
}
