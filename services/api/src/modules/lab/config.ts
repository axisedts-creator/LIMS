// Global env of module lab (02-TRD §9.2, `LIMS_LAB_*`). Fails fast at boot: an invalid value throws an Error naming the key.
// [CONV] field names; booleans accept only `true`/`false`, integers only decimal digits >= 1.

export interface LabConfig {
  /** LIMS_LAB_AUTOVERIFY_HOOK_ENABLED — Phase-2 switch for QualityPort.canAutoVerify. */
  readonly autoverifyHookEnabled: boolean;
  /** LIMS_LAB_CATALOG_CACHE_MAX_ENTRIES — LRU size per process. */
  readonly catalogCacheMaxEntries: number;
  /** LIMS_LAB_LABEL_WAIT_SECONDS — label page wait for specimens (web). */
  readonly labelWaitSeconds: number;
  /** LIMS_LAB_WORKLIST_MAX_ROWS — hard cap per worklist response set. */
  readonly worklistMaxRows: number;
}

type Env = Readonly<Record<string, string | undefined>>;

function bool(env: Env, key: string, dflt: boolean): boolean {
  const v = env[key];
  if (v === undefined) return dflt;
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new Error(`config: ${key} must be 'true' or 'false'`);
}

function posInt(env: Env, key: string, dflt: number): number {
  const v = env[key];
  if (v === undefined) return dflt;
  const n = /^[0-9]{1,9}$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`config: ${key} must be a positive integer`);
  return n;
}

export function loadLabConfig(env: Env = process.env): LabConfig {
  return Object.freeze({
    autoverifyHookEnabled: bool(env, 'LIMS_LAB_AUTOVERIFY_HOOK_ENABLED', false),
    catalogCacheMaxEntries: posInt(env, 'LIMS_LAB_CATALOG_CACHE_MAX_ENTRIES', 20000),
    labelWaitSeconds: posInt(env, 'LIMS_LAB_LABEL_WAIT_SECONDS', 15),
    worklistMaxRows: posInt(env, 'LIMS_LAB_WORKLIST_MAX_ROWS', 500),
  });
}
