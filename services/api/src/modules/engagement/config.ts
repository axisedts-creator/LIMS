// Global env of module engagement (02-TRD §10.1, `LIMS_ENGAGEMENT_*`; 04 A9; REQ-SEC-128). Fails fast at boot: an invalid value throws an Error
// naming the key, never its value or any key-file content. [CONV] integers are decimal digits only; key files are checked, not retained.
import { readFileSync } from 'node:fs';

export interface EngagementConfig {
  readonly otpTtlSeconds: number;
  readonly otpMaxAttempts: number;
  readonly otpLength: number;
  readonly linkRedeemFailuresPerHour: number;
  readonly orderPollSeconds: number;
  readonly displayPollSeconds: number;
  readonly backfillMaxOrders: number;
  readonly projectionReconcileDays: number;
  readonly otpHmacKeyFile: string;
  readonly linkHmacKeyFile: string;
  readonly phoneHmacKeyFile: string;
  readonly otpEncKeysFile: string;
}

type Env = Readonly<Record<string, string | undefined>>;
const P = 'LIMS_ENGAGEMENT_';
const fail = (key: string, rule: string): never => { throw new Error(`config: ${P}${key} ${rule}`); };

function int(env: Env, key: string, dflt: number, min: number, max: number, rule: string): number {
  const v = env[P + key];
  if (v === undefined) return dflt;
  const n = /^[0-9]{1,15}$/.test(v) ? Number(v) : NaN;
  if (!(n >= min && n <= max)) fail(key, `must be ${rule}`);
  return n;
}

function readKeyFile(env: Env, key: string): { path: string; data: Buffer } {
  const path = env[P + key];
  if (!path) return fail(key, 'is required (path of a key file)');
  try {
    return { path, data: readFileSync(path) };
  } catch {
    return fail(key, 'must name a readable key file');
  }
}

function rawKey(env: Env, key: string): string {
  const { path, data } = readKeyFile(env, key);
  if (data.length < 32) fail(key, 'key file must hold at least 32 bytes');
  return path;
}

// JSON {key_id: base64 of exactly 32 bytes}, >= 1 entry; the newest encrypts (§10.1).
function encKeys(env: Env, key: string): string {
  const { path, data } = readKeyFile(env, key);
  let j: unknown;
  try {
    j = JSON.parse(data.toString('utf8'));
  } catch {
    return fail(key, 'must be a JSON object {key_id: base64 of 32 bytes}');
  }
  const entries = j && typeof j === 'object' && !Array.isArray(j) ? Object.values(j) : [];
  const ok = entries.length > 0 && entries.every((v) => typeof v === 'string' && Buffer.from(v, 'base64').toString('base64') === v && Buffer.from(v, 'base64').length === 32);
  if (!ok) fail(key, 'must be a non-empty JSON object {key_id: base64 of exactly 32 bytes}');
  return path;
}

export function loadEngagementConfig(env: Env = process.env): EngagementConfig {
  return Object.freeze({
    otpTtlSeconds: int(env, 'OTP_TTL_SECONDS', 300, 120, 600, 'an integer 120..600 (04 A9)'),
    otpMaxAttempts: int(env, 'OTP_MAX_ATTEMPTS', 5, 5, 5, 'exactly 5 (04 A9)'),
    otpLength: int(env, 'OTP_LENGTH', 6, 6, 1_000_000, 'an integer >= 6 (04 A9)'),
    linkRedeemFailuresPerHour: int(env, 'LINK_REDEEM_FAILURES_PER_HOUR', 5, 1, 10, 'an integer 1..10'),
    orderPollSeconds: int(env, 'ORDER_POLL_SECONDS', 30, 15, 120, 'an integer 15..120'),
    displayPollSeconds: int(env, 'DISPLAY_POLL_SECONDS', 5, 3, 30, 'an integer 3..30'),
    backfillMaxOrders: int(env, 'BACKFILL_MAX_ORDERS', 1000, 1, Number.MAX_SAFE_INTEGER, 'an integer >= 1'),
    projectionReconcileDays: int(env, 'PROJECTION_RECONCILE_DAYS', 30, 1, Number.MAX_SAFE_INTEGER, 'an integer >= 1'),
    otpHmacKeyFile: rawKey(env, 'OTP_HMAC_KEY_FILE'),
    linkHmacKeyFile: rawKey(env, 'LINK_HMAC_KEY_FILE'),
    phoneHmacKeyFile: rawKey(env, 'PHONE_HMAC_KEY_FILE'),
    otpEncKeysFile: encKeys(env, 'OTP_ENC_KEYS_FILE'),
  });
}
