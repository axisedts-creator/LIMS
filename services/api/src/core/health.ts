// getLiveness / getReadiness (02-TRD §8, contracts/openapi/core.yaml). x-public: dependency names and states only.
import type { Handler } from './module.js';
import { STORAGE_KEY_ENV } from './storage/env.js';
import { SERVICE_KEY_ENV } from '../modules/identity/gotrue/gateway.http.js';

export type CheckState = 'ok' | 'degraded' | 'down';
export interface HealthChecks {
  db(): Promise<CheckState>;
  ratelimit(): Promise<CheckState>;
}

const STATES: readonly unknown[] = ['ok', 'degraded', 'down'];
/** T0B-PERF-1 (LD-310): a check that hangs is `down` after this bound, so the web's wake poll always gets an answer.
 *  [CONV] 3000 ms: above the 2000 ms probe bound of the real checks (LD-193), which therefore answer first. */
const CHECK_BOUND_MS = 3000;

/** A throw, an out-of-enum value or a hang past CHECK_BOUND_MS is `down`; the error itself never reaches the response. */
const run = async (c: () => Promise<CheckState>): Promise<CheckState> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const bound = new Promise<CheckState>((r) => { timer = setTimeout(() => r('down'), CHECK_BOUND_MS); timer.unref?.(); });
    const s = await Promise.race([Promise.resolve().then(c), bound]);
    return STATES.includes(s) ? s : 'down';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
};

/** T0B-OPSDOC-1 (audit RS-16, LD-277): the rows marked `required` in docs/runbooks/environment.md (env-doc and
 *  health-env tests keep the two equal). Names only; a value is never read into the response.
 *  LIMS_CORE_DATABASE_URL is not listed: its absence already shows as checks.db down. */
export const REQUIRED_ENV: readonly string[] = Object.freeze([
  'LIMS_CORE_ENV', 'LIMS_CORE_JWT_ALG', 'LIMS_CORE_JWT_AUDIENCE', 'LIMS_CORE_JWT_ISSUER',
  'LIMS_CORE_JWT_KEY_FILE', 'LIMS_CORE_RATELIMIT_KEY_FILE', STORAGE_KEY_ENV,
  'LIMS_ENGAGEMENT_LINK_HMAC_KEY_FILE', 'LIMS_ENGAGEMENT_OTP_ENC_KEYS_FILE', 'LIMS_ENGAGEMENT_OTP_HMAC_KEY_FILE',
  'LIMS_ENGAGEMENT_PHONE_HMAC_KEY_FILE', 'LIMS_IDENTITY_EMAIL_HMAC_KEY', SERVICE_KEY_ENV,
  'LIMS_IDENTITY_GOTRUE_URL', 'LIMS_IDENTITY_TOKEN_ENC_KEYS', 'LIMS_ORIGIN_API', 'LIMS_ORIGIN_PORTAL',
  'LIMS_ORIGIN_STAFF_WEB', 'LIMS_PAYMENTS_KEK_FILE', 'LIMS_PAYMENTS_PUBLIC_BASE_URL', 'LIMS_REPORTING_OTP_HMAC_KEY_FILE',
  'LIMS_WEB_BFF_KEY_FILE',
].sort());

export type EnvSource = Readonly<Record<string, string | undefined>>;

/** `env` undefined = no env check (old behaviour, e.g. tests that boot without it); main.ts passes process.env. */
export function createHealthHandlers(checks: HealthChecks, env?: EnvSource): { getLiveness: Handler; getReadiness: Handler } {
  return {
    // Process-only: never touches a dependency.
    getLiveness: async () => ({ status: 200, body: { status: 'ok' } }),
    // Checks run per request (no caching). [CONV] degraded -> 200 {status:'degraded'}; any down -> 503.
    // T0B-OPSDOC-1 (LD-277): an unset (missing or empty) required name degrades an ok answer; down still wins (503);
    // missing_env lists the names only, sorted, only when non-empty AND status is degraded (LD-288 exposure note:
    // unauthenticated route, so a 503 down answer never carries names).
    getReadiness: async () => {
      const [db, ratelimit] = await Promise.all([run(() => checks.db()), run(() => checks.ratelimit())]);
      const missing = env ? REQUIRED_ENV.filter((n) => !env[n]) : [];
      const all = [db, ratelimit, ...(missing.length ? ['degraded' as const] : [])];
      const status: CheckState = all.includes('down') ? 'down' : all.includes('degraded') ? 'degraded' : 'ok';
      const showMissing = missing.length > 0 && status === 'degraded';
      const body = { status, checks: { db, ratelimit }, ...(showMissing ? { missing_env: missing } : {}) };
      return { status: status === 'down' ? 503 : 200, body };
    },
  };
}

/** [CONV] until the DB pool / rate-limit backend wire their real checks: fail closed (not ready). */
export const UNWIRED_CHECKS: HealthChecks = { db: async () => 'down', ratelimit: async () => 'down' };
