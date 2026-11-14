// Typed LIMS_CORE_* config (02-TRD §6.1, §11). Fails fast, naming the bad key. Keys owned by later tasks
// (DB, rate limit, ...) are added by those tasks, not required here.
import { BFF_KINDS, type BffKeyFiles, type BffKind } from './auth/bff-key.js';
import { createClientIpResolver } from './auth/client-ip.js';
import { JWT_ALGS, type JwtAlg } from './auth/jwt.js';
import { IDENTITY_AUTH_OPS, WITH_TENANT_SCOPE_OPS } from './db/allowlists.js';

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
  /** 02-TRD §6.5. All four keys or none; with none, no bearerJwt operation can be mounted (bootstrap fails). */
  readonly jwt?: undefined | { readonly alg: JwtAlg; readonly issuer: string; readonly audience: string; readonly keyFile: string };
  /** LIMS_{WEB,PARTNER,PORTAL}_BFF_KEY_FILE (02-TRD §11 LIMS_CORE_BFF_KEY_FILES, 08 A19 P-45). */
  readonly bffKeyFiles: BffKeyFiles;
  /** LIMS_CORE_TRUSTED_PROXY_CIDRS, comma list; empty = no trusted peer (08 A25 P-61). */
  readonly trustedProxyCidrs: readonly string[];
  /** LIMS_CORE_TX_RETRY_MAX (02-TRD §6.4): 40001/40P01 whole-request retries. */
  readonly txRetryMax: number;
  /** LIMS_CORE_IDENTITY_AUTH_OPS (D-212); unset = IDENTITY_AUTH_OPS. */
  readonly identityAuthOps: readonly string[];
  /** LIMS_CORE_WITH_TENANT_SCOPE_OPS (D-214); unset = WITH_TENANT_SCOPE_OPS. */
  readonly withTenantScopeOps: readonly string[];
  /** LIMS_CORE_METRICS_PORT (02-TRD §11): internal /metrics + /health/live listener. */
  readonly metricsPort: number;
  /** T0D-18 (02-TRD §11). Unset = no pool: only public operations without a transaction can be served. */
  readonly databaseUrl?: string | undefined;
  readonly dbPoolMax: number;
  readonly statementTimeoutMs: number;
  readonly lockTimeoutMs: number;
  readonly fakePorts: readonly string[];
  readonly rateLimitBackend: 'postgres' | 'redis';
  readonly redisUrl?: string | undefined;
  readonly rateLimitKeyFile?: string | undefined;
  readonly tenantRps: number;
  readonly tenantBurst: number;
}

function portKey(env: Env, key: string, fallback: number): number {
  const v = env[key];
  if (v === undefined) return fallback;
  if (!/^\d{1,5}$/.test(v) || Number(v) > 65535) throw new Error(`config: ${key} must be a port 0..65535`);
  return Number(v);
}

function intKey(env: Env, key: string, fallback: number): number {
  const v = env[key];
  if (v === undefined) return fallback;
  if (!/^\d{1,4}$/.test(v)) throw new Error(`config: ${key} must be a non-negative integer`);
  return Number(v);
}

function positive(env: Env, key: string, fallback: number): number {
  const v = env[key];
  if (v === undefined) return fallback;
  if (!/^[1-9]\d{0,6}$/.test(v)) throw new Error(`config: ${key} must be a positive integer`);
  return Number(v);
}

function opList(env: Env, key: string, fallback: readonly string[]): readonly string[] {
  const v = env[key];
  if (v === undefined) return Object.freeze([...fallback]);
  const list = v.split(',').map((s) => s.trim()).filter(Boolean);
  for (const id of list) if (!/^[A-Za-z][A-Za-z0-9]*$/.test(id)) throw new Error(`config: ${key} has an invalid operationId`);
  return Object.freeze(list);
}

const JWT_KEYS = ['LIMS_CORE_JWT_ALG', 'LIMS_CORE_JWT_ISSUER', 'LIMS_CORE_JWT_AUDIENCE', 'LIMS_CORE_JWT_KEY_FILE'] as const;
const BFF_KEY_ENV: Readonly<Record<BffKind, string>> = {
  staff_web: 'LIMS_WEB_BFF_KEY_FILE', partner: 'LIMS_PARTNER_BFF_KEY_FILE', portal: 'LIMS_PORTAL_BFF_KEY_FILE',
};

// All four or none. With none, bootstrap refuses to mount any bearerJwt operation (fail fast, never unauthenticated access).
function jwtConfig(env: Env): CoreConfig['jwt'] {
  const set = JWT_KEYS.filter((k) => env[k] !== undefined && env[k] !== '');
  if (set.length === 0) return undefined;
  for (const k of JWT_KEYS) if (!set.includes(k)) throw new Error(`config: ${k} is required (missing)`);
  return Object.freeze({
    alg: oneOf(env, 'LIMS_CORE_JWT_ALG', JWT_ALGS),
    issuer: env.LIMS_CORE_JWT_ISSUER!, audience: env.LIMS_CORE_JWT_AUDIENCE!, keyFile: env.LIMS_CORE_JWT_KEY_FILE!,
  });
}

function cidrs(env: Env): readonly string[] {
  const list = (env.LIMS_CORE_TRUSTED_PROXY_CIDRS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  createClientIpResolver(list); // throws on an invalid CIDR, naming the key
  return Object.freeze(list);
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
    jwt: jwtConfig(env),
    bffKeyFiles: Object.freeze(Object.fromEntries(
      BFF_KINDS.filter((k) => env[BFF_KEY_ENV[k]]).map((k) => [k, [env[BFF_KEY_ENV[k]]!]]),
    ) as BffKeyFiles),
    trustedProxyCidrs: cidrs(env),
    txRetryMax: intKey(env, 'LIMS_CORE_TX_RETRY_MAX', 3),
    identityAuthOps: opList(env, 'LIMS_CORE_IDENTITY_AUTH_OPS', IDENTITY_AUTH_OPS),
    withTenantScopeOps: opList(env, 'LIMS_CORE_WITH_TENANT_SCOPE_OPS', WITH_TENANT_SCOPE_OPS),
    metricsPort: portKey(env, 'LIMS_CORE_METRICS_PORT', 9464),
    databaseUrl: env.LIMS_CORE_DATABASE_URL || undefined,
    dbPoolMax: positive(env, 'LIMS_CORE_DB_POOL_MAX', 20),
    statementTimeoutMs: positive(env, 'LIMS_CORE_STATEMENT_TIMEOUT_MS', 5000),
    lockTimeoutMs: positive(env, 'LIMS_CORE_LOCK_TIMEOUT_MS', 3000),
    fakePorts: Object.freeze((env.LIMS_CORE_FAKE_PORTS ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
    rateLimitBackend: oneOf(env, 'LIMS_CORE_RATELIMIT_BACKEND', ['postgres', 'redis'] as const, 'postgres'),
    redisUrl: env.LIMS_CORE_REDIS_URL || undefined,
    rateLimitKeyFile: env.LIMS_CORE_RATELIMIT_KEY_FILE || undefined,
    tenantRps: positive(env, 'LIMS_CORE_TENANT_RPS', 100),
    tenantBurst: positive(env, 'LIMS_CORE_TENANT_BURST', 200),
  });
}
