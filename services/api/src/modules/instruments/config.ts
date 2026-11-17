// Global env of module instruments (02-TRD §11, `LIMS_INSTRUMENTS_*`). Fails fast at boot: an invalid value throws an Error
// naming the key. [CONV] field names; booleans accept only `true`/`false`, integers only decimal digits >= 1.
// [CONV] production-like = NODE_ENV=production or LIMS_CORE_ENV in {staging, production}: there the secret-store keys are
// required (REQ-SEC-128) and sketch drivers are off and may not be enabled (AC-21.3).

export interface InstrumentsConfig {
  readonly maxMessageBytes: number;
  readonly maxBatchBodyBytes: number;
  readonly batchTimeBudgetMs: number;
  readonly enrolmentCodeTtlHours: number;
  readonly credentialTouchSeconds: number;
  readonly offlineAfterIntervals: number;
  readonly hostQueryMaxBarcodes: number;
  readonly attachmentBucket: string;
  readonly allowSketchDrivers: boolean;
  readonly configSigningKeyFile: string | undefined;
  readonly configSigningKeyId: string | undefined;
  readonly releasesDir: string | undefined;
}

type Env = Readonly<Record<string, string | undefined>>;

function bool(env: Env, key: string, dflt: boolean): boolean {
  const v = env[key];
  if (v === undefined) return dflt;
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new Error(`config: ${key} must be 'true' or 'false'`);
}

function posInt(env: Env, key: string, dflt: number, max = Number.MAX_SAFE_INTEGER): number {
  const v = env[key];
  if (v === undefined) return dflt;
  const n = /^[0-9]{1,9}$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`config: ${key} must be an integer in 1..${max}`);
  return n;
}

function str(env: Env, key: string, required: boolean): string | undefined {
  const v = env[key];
  if (v === undefined || v === '') {
    if (required) throw new Error(`config: ${key} is required in staging/production`);
    return undefined;
  }
  return v;
}

export function loadInstrumentsConfig(env: Env = process.env): InstrumentsConfig {
  const prod = env.NODE_ENV === 'production' || env.LIMS_CORE_ENV === 'staging' || env.LIMS_CORE_ENV === 'production';
  const allowSketchDrivers = bool(env, 'LIMS_INSTRUMENTS_ALLOW_SKETCH_DRIVERS', !prod);
  if (prod && allowSketchDrivers) throw new Error('config: LIMS_INSTRUMENTS_ALLOW_SKETCH_DRIVERS must be false in production (AC-21.3)');
  const attachmentBucket = env.LIMS_INSTRUMENTS_ATTACHMENT_BUCKET;
  if (attachmentBucket === '') throw new Error('config: LIMS_INSTRUMENTS_ATTACHMENT_BUCKET must not be empty');
  return Object.freeze({
    maxMessageBytes: posInt(env, 'LIMS_INSTRUMENTS_MAX_MESSAGE_BYTES', 1048576),
    maxBatchBodyBytes: posInt(env, 'LIMS_INSTRUMENTS_MAX_BATCH_BODY_BYTES', 4194304),
    batchTimeBudgetMs: posInt(env, 'LIMS_INSTRUMENTS_BATCH_TIME_BUDGET_MS', 8000),
    enrolmentCodeTtlHours: posInt(env, 'LIMS_INSTRUMENTS_ENROLMENT_CODE_TTL_HOURS', 24, 72),
    credentialTouchSeconds: posInt(env, 'LIMS_INSTRUMENTS_CREDENTIAL_TOUCH_SECONDS', 300),
    offlineAfterIntervals: posInt(env, 'LIMS_INSTRUMENTS_OFFLINE_AFTER_INTERVALS', 3),
    hostQueryMaxBarcodes: posInt(env, 'LIMS_INSTRUMENTS_HOST_QUERY_MAX_BARCODES', 50),
    attachmentBucket: attachmentBucket ?? 'instruments-attachments',
    allowSketchDrivers,
    configSigningKeyFile: str(env, 'LIMS_INSTRUMENTS_CONFIG_SIGNING_KEY_FILE', prod),
    configSigningKeyId: str(env, 'LIMS_INSTRUMENTS_CONFIG_SIGNING_KEY_ID', prod),
    releasesDir: str(env, 'LIMS_INSTRUMENTS_RELEASES_DIR', prod),
  });
}
