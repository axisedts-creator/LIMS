// Global env of module partners (02-TRD §10.1, `LIMS_PARTNERS_*`). Fails fast at boot: an invalid value throws an Error naming the key.
// [CONV] camelCase fields; integers are decimal digits >= 1. The BFF secret LIMS_PARTNER_BFF_KEY_FILE is not an API setting and is never read here.

export interface PartnersConfig {
  readonly convertingStaleMinutes: number;
  readonly reconcileBatch: number;
  readonly statementMonths: number;
  readonly downloadSignedUrlMaxSeconds: number;
}

type Env = Readonly<Record<string, string | undefined>>;

function posInt(env: Env, key: string, dflt: number): number {
  const v = env[key];
  if (v === undefined) return dflt;
  const n = /^[0-9]{1,15}$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`config: ${key} must be an integer >= 1`);
  return n;
}

export function loadPartnersConfig(env: Env = process.env): PartnersConfig {
  return Object.freeze({
    convertingStaleMinutes: posInt(env, 'LIMS_PARTNERS_CONVERTING_STALE_MINUTES', 30),
    reconcileBatch: posInt(env, 'LIMS_PARTNERS_RECONCILE_BATCH', 500),
    statementMonths: posInt(env, 'LIMS_PARTNERS_STATEMENT_MONTHS', 24),
    downloadSignedUrlMaxSeconds: posInt(env, 'LIMS_PARTNERS_DOWNLOAD_SIGNED_URL_MAX_SECONDS', 300),
  });
}
