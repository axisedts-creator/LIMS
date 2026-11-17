// Global env of module homecollection (02-TRD §11.1, `LIMS_HOMECOLLECTION_*`). Fails fast at boot: an invalid value throws an Error
// naming the key. [CONV] camelCase fields; integers only decimal digits >= 1 (same rule as modules/analytics).

export interface HomecollectionConfig {
  readonly pushMaxMutations: number;
  readonly pushMaxBytes: number;
  /** <= 60: route sequence is 1..60 and the snapshot never truncates (08 A19 D-131). */
  readonly snapshotMaxVisits: number;
  readonly specimenRefreshSeconds: number;
}

type Env = Readonly<Record<string, string | undefined>>;

function posInt(env: Env, key: string, dflt: number, max = Number.MAX_SAFE_INTEGER): number {
  const v = env[key];
  if (v === undefined) return dflt;
  const n = /^[0-9]{1,15}$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`config: ${key} must be an integer in 1..${max}`);
  return n;
}

export function loadHomecollectionConfig(env: Env = process.env): HomecollectionConfig {
  return Object.freeze({
    pushMaxMutations: posInt(env, 'LIMS_HOMECOLLECTION_PUSH_MAX_MUTATIONS', 100),
    pushMaxBytes: posInt(env, 'LIMS_HOMECOLLECTION_PUSH_MAX_BYTES', 524288),
    snapshotMaxVisits: posInt(env, 'LIMS_HOMECOLLECTION_SNAPSHOT_MAX_VISITS', 60, 60),
    specimenRefreshSeconds: posInt(env, 'LIMS_HOMECOLLECTION_SPECIMEN_REFRESH_SECONDS', 60),
  });
}
