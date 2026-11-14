// Global env of module quality (02-TRD §12.2, `LIMS_QUALITY_*`). Fails fast: an invalid value throws an Error naming the key.
// [CONV] field names camelCase; integers only decimal digits, >= 1 (0 / empty / signs / decimals / exponents rejected); booleans only `true`/`false`.
// [CONV] upper bounds are not in the spec; chosen as sanity caps only.

export interface QualityConfig {
  readonly enabled: boolean;
  readonly syncBatch: number;
  readonly syncOverlapSeconds: number;
  readonly syncDebounceSeconds: number;
  readonly syncTimeBudgetSeconds: number;
  readonly ruleCacheMax: number;
  readonly ljMaxPoints: number;
}

type Env = Readonly<Record<string, string | undefined>>;

function intIn(env: Env, key: string, dflt: number, max: number): number {
  const v = env[key];
  if (v === undefined) return dflt;
  const n = /^[0-9]{1,15}$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`config: ${key} must be an integer 1-${max}`);
  return n;
}

function bool(env: Env, key: string, dflt: boolean): boolean {
  const v = env[key];
  if (v === undefined) return dflt;
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new Error(`config: ${key} must be 'true' or 'false'`);
}

export function loadQualityConfig(env: Env = process.env): QualityConfig {
  return Object.freeze({
    enabled: bool(env, 'LIMS_QUALITY_ENABLED', false), // Phase-2 switch, default OFF (02-TRD §12.2)
    syncBatch: intIn(env, 'LIMS_QUALITY_SYNC_BATCH', 500, 10_000),
    syncOverlapSeconds: intIn(env, 'LIMS_QUALITY_SYNC_OVERLAP_SECONDS', 600, 86_400),
    syncDebounceSeconds: intIn(env, 'LIMS_QUALITY_SYNC_DEBOUNCE_SECONDS', 5, 3_600),
    syncTimeBudgetSeconds: intIn(env, 'LIMS_QUALITY_SYNC_TIME_BUDGET_SECONDS', 25, 3_600),
    ruleCacheMax: intIn(env, 'LIMS_QUALITY_RULE_CACHE_MAX', 200, 100_000),
    ljMaxPoints: intIn(env, 'LIMS_QUALITY_LJ_MAX_POINTS', 2000, 100_000),
  });
}
