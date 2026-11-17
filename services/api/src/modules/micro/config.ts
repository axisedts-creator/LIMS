// Global env of module micro (02-TRD §6, `LIMS_MICRO_*`). Fails fast at boot: an invalid value throws an Error naming the key.
// [CONV] ints = decimal digits >= 1; booleans only `true`/`false`. LIMS_MICRO_BFF_LOOKUP_CONCURRENCY is web env, not read here.
const CORE_UPLOAD_CAP = 15 * 1024 * 1024; // TRD §6: breakpoint CSV size cap "≤ core 15 MB cap"

export interface MicroConfig {
  readonly importMaxBytes: number;
  readonly importMaxLines: number;
  readonly importTimeoutMs: number;
  readonly specimenLookupPort: boolean;
  readonly reconcileBatch: number;
}

type Env = Readonly<Record<string, string | undefined>>;

function posInt(env: Env, key: string, dflt: number, max = Number.MAX_SAFE_INTEGER): number {
  const v = env[key];
  if (v === undefined) return dflt;
  const n = /^[0-9]{1,15}$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`config: ${key} must be an integer in 1..${max}`);
  return n;
}

function bool(env: Env, key: string, dflt: boolean): boolean {
  const v = env[key];
  if (v === undefined) return dflt;
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new Error(`config: ${key} must be 'true' or 'false'`);
}

export function loadMicroConfig(env: Env = process.env): MicroConfig {
  return Object.freeze({
    importMaxBytes: posInt(env, 'LIMS_MICRO_IMPORT_MAX_BYTES', 5242880, CORE_UPLOAD_CAP),
    importMaxLines: posInt(env, 'LIMS_MICRO_IMPORT_MAX_LINES', 20000),
    importTimeoutMs: posInt(env, 'LIMS_MICRO_IMPORT_TIMEOUT_MS', 60000),
    specimenLookupPort: bool(env, 'LIMS_MICRO_SPECIMEN_LOOKUP_PORT', false),
    reconcileBatch: posInt(env, 'LIMS_MICRO_RECONCILE_BATCH', 200),
  });
}
