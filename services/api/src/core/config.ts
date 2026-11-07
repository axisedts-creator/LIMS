// Typed LIMS_CORE_* config (02-TRD §6.1, §11). Fails fast, naming the bad key. Keys owned by later tasks
// (DB, JWT, rate limit, ...) are added by those tasks, not required here.

export const CORE_ENVS = ['dev', 'ci', 'staging', 'production'] as const;
export type CoreEnv = (typeof CORE_ENVS)[number];

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface CoreConfig {
  readonly env: CoreEnv;
  /** REQ-ARCH-071, SP-8 O4: on in dev/ci/staging, off in production unless overridden. */
  readonly responseValidation: boolean;
  /** 02-TRD §14: only LIMS_CORE_ENV=ci + LIMS_CORE_LOAD_SAMPLE_MODULE=1. */
  readonly loadSampleModule: boolean;
  readonly logLevel: LogLevel;
}

type Env = Readonly<Record<string, string | undefined>>;

function oneOf<T extends string>(env: Env, key: string, allowed: readonly T[], fallback?: T): T {
  const v = env[key];
  if (v === undefined && fallback !== undefined) return fallback;
  if (v === undefined || !(allowed as readonly string[]).includes(v)) {
    throw new Error(`config: ${key} must be one of ${allowed.join('|')}${v === undefined ? ' (missing)' : ''}`);
  }
  return v as T;
}

export function loadConfig(env: Env = process.env): CoreConfig {
  const coreEnv = oneOf(env, 'LIMS_CORE_ENV', CORE_ENVS);
  const rv = oneOf(env, 'LIMS_CORE_RESPONSE_VALIDATION', ['on', 'off'], coreEnv === 'production' ? 'off' : 'on');
  const sample = oneOf(env, 'LIMS_CORE_LOAD_SAMPLE_MODULE', ['0', '1'], '0');
  return Object.freeze({
    env: coreEnv,
    responseValidation: rv === 'on',
    loadSampleModule: coreEnv === 'ci' && sample === '1',
    logLevel: oneOf(env, 'LIMS_CORE_LOG_LEVEL', LOG_LEVELS, 'info'),
  });
}
