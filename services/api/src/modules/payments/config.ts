// Payments env config + boot checks (02-TRD §9.1 keys, §9.3 boot rules; 07-SECURITY REQ-SEC-136, REQ-SEC-128, ST-14).
// Pure: reads only the env it is given. Every failure throws an Error that names the LIMS_PAYMENTS_* key and never contains key material.
// LD-26 (training tenant: sandbox gateway credentials only) is per tenant and is enforced by the merchant-account task, not here.
import { readFileSync } from 'node:fs';

type Env = Readonly<Record<string, string | undefined>>;
export type GatewayEnv = 'uat' | 'production';

export interface PaymentsConfig {
  readonly gatewayEnv: GatewayEnv;
  readonly publicBaseUrl: string;
  readonly returnUrlAllowlist: readonly string[];
  readonly esewaFormUrl: string;
  readonly esewaStatusUrl: string;
  readonly khaltiBaseUrl: string;
  readonly khaltiRefundOrigin: string;
  /** Path only; the KEK itself is never held in config (REQ-SEC-128). */
  readonly kekFile: string;
  readonly httpTimeoutInitiateMs: number;
  readonly httpTimeoutInrequestMs: number;
  readonly httpTimeoutJobMs: number;
  readonly esewaIntentTtlMinutes: number;
  readonly expiryGraceMinutes: number;
  readonly pollScheduleSeconds: readonly number[];
  readonly verifyMinIntervalSeconds: number;
  readonly reconLookbackSettledDays: number;
  readonly reconLookbackClosedDays: number;
  readonly reconConcurrency: number;
  readonly esewaAllowFractionalRupees: boolean;
}

const PROD_HOSTS = ['epay.esewa.com.np', 'khalti.com'];
const SANDBOX_HOSTS = ['uat.esewa.com.np', 'dev.khalti.com'];
const DEFAULTS = {
  production: {
    esewaFormUrl: 'https://epay.esewa.com.np/api/epay/main/v2/form',
    esewaStatusUrl: 'https://epay.esewa.com.np/api/epay/transaction/status/',
    khaltiBaseUrl: 'https://khalti.com/api/v2/',
    khaltiRefundOrigin: 'https://khalti.com',
  },
  uat: {
    esewaFormUrl: undefined, // UAT value UNVERIFIED (TRD §9.1): must be set
    esewaStatusUrl: 'https://uat.esewa.com.np/api/epay/transaction/status/',
    khaltiBaseUrl: 'https://dev.khalti.com/api/v2/',
    khaltiRefundOrigin: 'https://dev.khalti.com',
  },
} as const;

const K = (s: string): string => `LIMS_PAYMENTS_${s}`;
const fail = (key: string, why: string): never => { throw new Error(`payments config: ${key} ${why}`); };
const val = (env: Env, key: string): string | undefined => { const v = env[key]?.trim(); return v ? v : undefined; };

function httpsUrl(key: string, raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { return fail(key, 'must be an absolute https URL'); }
  if (u.protocol !== 'https:') fail(key, 'must be an https URL');
  return u;
}

function posInt(env: Env, short: string, dflt: number): number {
  const key = K(short);
  const v = val(env, key);
  if (v === undefined) return dflt;
  if (!/^[1-9]\d{0,9}$/.test(v)) fail(key, 'must be a positive integer');
  return Number(v);
}

function pollSchedule(env: Env): readonly number[] {
  const key = K('POLL_SCHEDULE_SECONDS');
  const v = val(env, key);
  if (v === undefined) return Object.freeze([120, 300, 600, 1200, 2400]);
  const out = v.split(',').map((s) => {
    const t = s.trim();
    if (!/^[1-9]\d{0,9}$/.test(t)) fail(key, 'must be a comma list of positive integers');
    return Number(t);
  });
  if (out.some((n, i) => i > 0 && n <= out[i - 1]!)) fail(key, 'must be strictly increasing');
  return Object.freeze(out);
}

/** TRD §6.9 file: `{ keys: { id: base64 }, active: id }`. Only the ACTIVE key is length-checked. Errors never echo file content. */
function checkKekFile(env: Env): string {
  const key = K('KEK_FILE');
  const path = val(env, key);
  if (!path) return fail(key, 'is required');
  let doc: unknown;
  try { doc = JSON.parse(readFileSync(path, 'utf8')); } catch { return fail(key, 'file is missing or not valid JSON'); }
  const d = doc as { keys?: unknown; active?: unknown } | null;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return fail(key, 'must hold a JSON object');
  const { keys, active } = d;
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) return fail(key, 'has no keys object');
  if (typeof active !== 'string' || !Object.hasOwn(keys, active)) return fail(key, 'active key id is not in keys');
  const b64 = (keys as Record<string, unknown>)[active];
  if (typeof b64 !== 'string' || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return fail(key, 'active key is not base64');
  if (Buffer.from(b64, 'base64').length !== 32) fail(key, 'active key must be 32 bytes');
  return path;
}

export function loadPaymentsConfig(env: Env = process.env): PaymentsConfig {
  // 1. GATEWAY_ENV: closed set; production exactly when NODE_ENV=production.
  const geKey = K('GATEWAY_ENV');
  const geRaw = env[geKey];
  const gatewayEnv = geRaw === undefined || geRaw === '' ? 'uat' : geRaw;
  if (gatewayEnv !== 'uat' && gatewayEnv !== 'production') fail(geKey, 'must be uat or production');
  if ((gatewayEnv === 'production') !== (env.NODE_ENV === 'production')) fail(geKey, 'must be production exactly when NODE_ENV=production');
  const ge = gatewayEnv as GatewayEnv;

  // 2. PUBLIC_BASE_URL https.
  const pbKey = K('PUBLIC_BASE_URL');
  const pbRaw = val(env, pbKey);
  if (!pbRaw) fail(pbKey, 'is required');
  const publicBaseUrl = pbRaw!;
  httpsUrl(pbKey, publicBaseUrl);

  // 3. Gateway URLs: https, and the host must match the environment (host compare, not substring; URL lowercases host, drops the port).
  const wrongHosts = ge === 'production' ? SANDBOX_HOSTS : PROD_HOSTS;
  const gatewayUrl = (short: 'ESEWA_FORM_URL' | 'ESEWA_STATUS_URL' | 'KHALTI_BASE_URL' | 'KHALTI_REFUND_ORIGIN', dflt: string | undefined): string => {
    const key = K(short);
    const v = val(env, key) ?? dflt;
    if (!v) return fail(key, 'is required (no default for this environment)');
    if (wrongHosts.includes(httpsUrl(key, v).hostname)) fail(key, `host is not allowed when ${geKey}=${ge}`);
    return v;
  };
  const d = DEFAULTS[ge];
  const esewaFormUrl = gatewayUrl('ESEWA_FORM_URL', d.esewaFormUrl);
  const esewaStatusUrl = gatewayUrl('ESEWA_STATUS_URL', d.esewaStatusUrl);
  const khaltiBaseUrl = gatewayUrl('KHALTI_BASE_URL', d.khaltiBaseUrl);
  const khaltiRefundOrigin = gatewayUrl('KHALTI_REFUND_ORIGIN', d.khaltiRefundOrigin);

  // 4. KEK file.
  const kekFile = checkKekFile(env);

  // 5. Return-URL allowlist (origin + path prefix, https only).
  const alKey = K('RETURN_URL_ALLOWLIST');
  let allow = val(env, alKey)?.split(',').map((s) => s.trim());
  if (!allow) {
    const origin = (k: string): string => { const o = val(env, k); return o ? o.replace(/\/+$/, '') : fail(alKey, `default needs ${k}`); };
    allow = [`${origin('LIMS_ORIGIN_STAFF_WEB')}/`, `${origin('LIMS_ORIGIN_PORTAL')}/`, `${publicBaseUrl.replace(/\/+$/, '')}/v1/payments/result`];
  }
  for (const e of allow) httpsUrl(alKey, e);

  return Object.freeze({
    gatewayEnv: ge, publicBaseUrl, returnUrlAllowlist: Object.freeze(allow),
    esewaFormUrl, esewaStatusUrl, khaltiBaseUrl, khaltiRefundOrigin, kekFile,
    httpTimeoutInitiateMs: posInt(env, 'HTTP_TIMEOUT_INITIATE_MS', 1200),
    httpTimeoutInrequestMs: posInt(env, 'HTTP_TIMEOUT_INREQUEST_MS', 2500),
    httpTimeoutJobMs: posInt(env, 'HTTP_TIMEOUT_JOB_MS', 10000),
    esewaIntentTtlMinutes: posInt(env, 'ESEWA_INTENT_TTL_MINUTES', 30),
    expiryGraceMinutes: posInt(env, 'EXPIRY_GRACE_MINUTES', 10),
    pollScheduleSeconds: pollSchedule(env),
    verifyMinIntervalSeconds: posInt(env, 'VERIFY_MIN_INTERVAL_SECONDS', 10),
    reconLookbackSettledDays: posInt(env, 'RECON_LOOKBACK_SETTLED_DAYS', 2),
    reconLookbackClosedDays: posInt(env, 'RECON_LOOKBACK_CLOSED_DAYS', 7),
    reconConcurrency: posInt(env, 'RECON_CONCURRENCY', 2),
    esewaAllowFractionalRupees: bool(env, 'ESEWA_ALLOW_FRACTIONAL_RUPEES'),
  });
}

function bool(env: Env, short: string): boolean {
  const key = K(short);
  const v = val(env, key);
  if (v === undefined || v === 'false') return false;
  if (v === 'true') return true;
  return fail(key, 'must be true or false');
}
