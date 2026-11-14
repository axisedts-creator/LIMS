// Global env of module anatomic (02-TRD §10.1, `LIMS_ANATOMIC_*`). Fails fast: an invalid value throws an Error naming the key.
// [CONV] field names camelCase; integers only decimal digits; empty string is invalid (never "unset").

export interface AnatomicConfig {
  readonly imageMaxBytes: number;
  readonly imageMaxMegapixels: number;
  readonly listMaxLimit: number;
}

type Env = Readonly<Record<string, string | undefined>>;

const MB15 = 15 * 1024 * 1024; // 15728640; 02-CV §10.2, REQ-SEC-083: boot fails above

function intIn(env: Env, key: string, dflt: number, min: number, max: number): number {
  const v = env[key];
  if (v === undefined) return dflt;
  const n = /^[0-9]{1,15}$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`config: ${key} must be an integer ${min}-${max}`);
  return n;
}

export function loadAnatomicConfig(env: Env = process.env): AnatomicConfig {
  return Object.freeze({
    imageMaxBytes: intIn(env, 'LIMS_ANATOMIC_IMAGE_MAX_BYTES', MB15, 1, MB15),
    imageMaxMegapixels: intIn(env, 'LIMS_ANATOMIC_IMAGE_MAX_MEGAPIXELS', 50, 1, 1000), // ponytail: upper bound is [ASSUMPTION], TRD gives none
    listMaxLimit: intIn(env, 'LIMS_ANATOMIC_LIST_MAX_LIMIT', 200, 1, 200), // = 02-CV §4.3 max
  });
}
