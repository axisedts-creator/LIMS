// LIMS_REPORTING_* config (02-TRD §10.1). Fails boot naming the bad key; never echoes a secret.
// Worker-only keys (renderer/sandbox URLs + tokens) are added by the task that wires the renderer client.
import { readFileSync } from 'node:fs';
import { CORE_ENVS } from '../../core/config.js';

type Env = Readonly<Record<string, string | undefined>>;

export interface ReportingConfig {
  readonly otpHmacKeyFile: string;
  readonly otpTtlSeconds: number;
  readonly otpMaxAttempts: number;
  readonly portalSessionIdleMinutes: number;
  readonly portalSessionAbsoluteMinutes: number;
  readonly assemblyDebounceSeconds: number;
  readonly printTtlHours: number;
  readonly transportTimeoutMs: number;
  readonly allowRealProviders: boolean;
}

const fail = (key: string, why: string): never => { throw new Error(`config: ${key} ${why}`); };

/** Positive integer, decimal digits only (rejects '', '1.5', '1e3', '0x10', '-1'). */
function posInt(env: Env, key: string, fallback: number, max = 1e9): number {
  const v = env[key];
  if (v === undefined) return fallback;
  if (!/^\d{1,10}$/.test(v) || Number(v) < 1 || Number(v) > max) fail(key, `must be an integer 1..${max}`);
  return Number(v);
}

function keyFile(env: Env): string {
  const key = 'LIMS_REPORTING_OTP_HMAC_KEY_FILE';
  const path = env[key];
  if (!path) return fail(key, 'is required (missing)');
  let size: number;
  try {
    size = readFileSync(path).length;
  } catch {
    return fail(key, 'cannot be read');
  }
  if (size < 32) fail(key, 'must hold >= 32 bytes'); // REQ-SEC-128; contents never in the message
  return path;
}

export function loadReportingConfig(env: Env = process.env): ReportingConfig {
  const coreEnv = env.LIMS_CORE_ENV;
  if (!(CORE_ENVS as readonly (string | undefined)[]).includes(coreEnv)) fail('LIMS_CORE_ENV', `must be one of ${CORE_ENVS.join('|')}`);
  const prod = coreEnv === 'production';

  const arpKey = 'LIMS_REPORTING_ALLOW_REAL_PROVIDERS';
  const arp = env[arpKey] ?? 'false';
  if (arp !== 'true' && arp !== 'false') fail(arpKey, 'must be true|false');
  // REQ-SEC-136: true in production, never true elsewhere.
  if (prod && arp !== 'true') fail(arpKey, 'must be true in production');
  if (!prod && arp === 'true') fail(arpKey, 'must not be true outside production');

  const otpMaxAttempts = posInt(env, 'LIMS_REPORTING_OTP_MAX_ATTEMPTS', 5);
  if (otpMaxAttempts !== 5) fail('LIMS_REPORTING_OTP_MAX_ATTEMPTS', 'must be 5 (04 A9)');

  return Object.freeze({
    otpHmacKeyFile: keyFile(env),
    otpTtlSeconds: posInt(env, 'LIMS_REPORTING_OTP_TTL_SECONDS', 600, 600), // 04 A9
    otpMaxAttempts,
    portalSessionIdleMinutes: posInt(env, 'LIMS_REPORTING_PORTAL_SESSION_IDLE_MINUTES', 15),
    portalSessionAbsoluteMinutes: posInt(env, 'LIMS_REPORTING_PORTAL_SESSION_ABSOLUTE_MINUTES', 60),
    assemblyDebounceSeconds: posInt(env, 'LIMS_REPORTING_ASSEMBLY_DEBOUNCE_SECONDS', 30),
    printTtlHours: posInt(env, 'LIMS_REPORTING_PRINT_TTL_HOURS', 24),
    transportTimeoutMs: posInt(env, 'LIMS_REPORTING_TRANSPORT_TIMEOUT_MS', 10_000),
    allowRealProviders: arp === 'true',
  });
}
