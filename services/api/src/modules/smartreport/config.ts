// Global env of module smartreport (02-TRD §10, `LIMS_SMARTREPORT_*`). Fails fast: an invalid value throws an Error naming the key.
// [CONV] field names camelCase; integers only decimal digits; booleans only `true`/`false`; empty string is invalid (never "unset").
// LIMS_SMARTREPORT_LLM_CREDENTIAL lives in the secret store (C1), never in env/config.

export interface SmartreportConfig {
  readonly prebuildEnabled: boolean;
  readonly prebuildDelaySeconds: number;
  readonly llmAdapter: string;
  readonly llmEndpoint: string | undefined;
  readonly llmAllowedHosts: readonly string[];
  readonly llmTimeoutMs: number;
  readonly llmMaxConcurrency: number;
  readonly llmModelRef: string | undefined;
}

type Env = Readonly<Record<string, string | undefined>>;

function intIn(env: Env, key: string, dflt: number, min: number, max: number): number {
  const v = env[key];
  if (v === undefined) return dflt;
  const n = /^[0-9]{1,15}$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`config: ${key} must be an integer ${min}-${max}`);
  return n;
}

function bool(env: Env, key: string, dflt: boolean): boolean {
  const v = env[key];
  if (v === undefined) return dflt;
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new Error(`config: ${key} must be 'true' or 'false'`);
}

function str(env: Env, key: string, maxLen: number): string | undefined {
  const v = env[key];
  if (v === undefined) return undefined;
  if (v.length < 1 || v.length > maxLen) throw new Error(`config: ${key} must be 1-${maxLen} characters`);
  return v;
}

function httpsUrl(env: Env, key: string): string | undefined {
  const v = env[key];
  if (v === undefined) return undefined;
  let ok = false;
  try { ok = new URL(v).protocol === 'https:'; } catch { /* not a URL */ }
  if (!ok) throw new Error(`config: ${key} must be an https URL`);
  return v;
}

export function loadSmartreportConfig(env: Env = process.env): SmartreportConfig {
  const hosts = env.LIMS_SMARTREPORT_LLM_ALLOWED_HOSTS;
  return Object.freeze({
    prebuildEnabled: bool(env, 'LIMS_SMARTREPORT_PREBUILD_ENABLED', true),
    prebuildDelaySeconds: intIn(env, 'LIMS_SMARTREPORT_PREBUILD_DELAY_SECONDS', 120, 30, 3600),
    llmAdapter: str(env, 'LIMS_SMARTREPORT_LLM_ADAPTER', 100) ?? 'disabled',
    llmEndpoint: httpsUrl(env, 'LIMS_SMARTREPORT_LLM_ENDPOINT'),
    llmAllowedHosts: Object.freeze((hosts ?? '').split(',').map((h) => h.trim()).filter(Boolean)),
    llmTimeoutMs: intIn(env, 'LIMS_SMARTREPORT_LLM_TIMEOUT_MS', 20000, 1000, 60000),
    llmMaxConcurrency: intIn(env, 'LIMS_SMARTREPORT_LLM_MAX_CONCURRENCY', 1, 1, 8),
    llmModelRef: str(env, 'LIMS_SMARTREPORT_LLM_MODEL_REF', 100),
  });
}
