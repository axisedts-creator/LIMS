// Per-boot wiring of the pipeline dependencies (LD-133, T0D-18): pool + requestTx (02-TRD §6.4), rate limiter (§6.7), idempotency
// (§6.6), port registry (§6.3, AC-0D-6.1/6.2), authz guard (§6.2 stage 9), module services and the shared ctx members.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
// [CONV] relative import until @lims/contracts is a services/api dependency (same as packages/fakes, LD-05).
import { PORT_CONSUMERS } from '../../../../../contracts/ports/generated/port-consumers.js';
import type { CoreConfig } from '../config.js';
import { createCoreRepo } from '../core-repo/index.js';
import { createDb, type Pool, type PoolClient } from '../db/tx.js';
import { LimsError } from '../errors.js';
import { createEvents } from '../events/publish.js';
import { createIdempotency } from '../idempotency.js';
import { PORT_OWNERS, REPO_ROOT, type LoadedModule } from '../module.js';
import type { CoreMetrics, MetricName } from '../observability/metrics.js';
import { createAuthzGuard } from '../ports/authz-guard.js';
import { PHASE_STUBS } from '../ports/phase-stubs.js';
import { resolvePorts, type PortLog, type PortMetrics, type PortRegistry } from '../ports/registry.js';
import { createRateLimiter, type RateLimiter } from '../ratelimit/index.js';
import { createPgBackend } from '../ratelimit/pg.js';
import { createFiles } from '../uploads/index.js';
import { createPipeline, type Pipeline } from './index.js';

const FAKES_DIR = join(REPO_ROOT, 'packages', 'fakes', 'src');
const LENIENT = new Set(['dev', 'ci']);
type LogFns = { info(o: object, m?: string): void; warn(o: object, m?: string): void; error(o: object, m?: string): void };
const unavailable = () => new LimsError('common.dependency_unavailable');

/**
 * ponytail: ctx.storage / ctx.uploads / ctx.download answer 503 until the Storage HTTP client is pinned (SP-1,
 * .orchestra/cr/T0D-17.nonblocking.md: createStorage needs `connect`); wire createStorage/createUploads/createDownload per request then.
 */
const unwired = (...methods: string[]) => Object.freeze(Object.fromEntries(methods.map((m) => [m, async () => { throw unavailable(); }])));

async function loadPortImpls(env: string, needed: ReadonlySet<string>): Promise<{ fakes: Record<string, unknown>; stubs: Record<string, unknown> }> {
  const fakes: Record<string, unknown> = {};
  const stubs: Record<string, unknown> = {};
  // @lims/fakes (02-TRD §10 / CV §8.2): fakes only in dev/ci and only for ports without a real owner (or forced); staging/production
  // get the listed phase stubs only.
  if (LENIENT.has(env)) {
    for (const p of Object.keys(PORT_OWNERS).filter((x) => needed.has(x))) {
      // ponytail: imported on the first port call (boot stays fast); only the async port methods are reachable, not fake controls.
      let impl: Promise<any> | undefined;
      const load = () => (impl ??= import(pathToFileURL(join(FAKES_DIR, `${p}.fake.ts`)).href).then((m) => m[`createFake${p}`]({ seed: 1 })));
      fakes[p] = new Proxy(Object.freeze({}), {
        get: (_t, method) => (typeof method === 'string' && method !== 'then' ? async (...a: unknown[]) => (await load())[method](...a) : undefined),
      });
    }
  } else {
    for (const p of PHASE_STUBS) {
      const mod = await import(pathToFileURL(join(FAKES_DIR, 'stubs', `${p}.stub.ts`)).href);
      stubs[p] = mod[`create${p}Stub`]();
    }
  }
  return { fakes, stubs };
}

export interface PipelineBoot {
  pipelineFor(module: string): Pipeline;
  close(): Promise<void>;
}

export async function bootPipeline(o: {
  config: CoreConfig; modules: readonly LoadedModule[]; log: PortLog; metrics: CoreMetrics;
}): Promise<PipelineBoot> {
  const { config, modules } = o;
  const log = o.log as PortLog & LogFns; // app.log: pino-style (fields, msg)
  const metrics: PortMetrics = {
    setGauge: (n, v) => o.metrics.set(n as MetricName, v),
    inc: (n, l, by) => o.metrics.inc(n as MetricName, l, by),
  };

  // §6.7: HMAC key read at boot (fail fast), before any connection exists.
  let key = '';
  if (config.databaseUrl) {
    if (!config.rateLimitKeyFile) throw new Error('config: LIMS_CORE_RATELIMIT_KEY_FILE is required with LIMS_CORE_DATABASE_URL');
    try { key = readFileSync(config.rateLimitKeyFile, 'utf8').trim(); } catch { throw new Error('config: LIMS_CORE_RATELIMIT_KEY_FILE is not readable'); }
    if (!key) throw new Error('config: LIMS_CORE_RATELIMIT_KEY_FILE is empty');
    // ponytail: no Redis client in services/api deps yet (LD-05); add it and createRedisBackend({ client }) when C0-0A ships one.
    if (config.rateLimitBackend !== 'postgres') throw new Error('config: LIMS_CORE_RATELIMIT_BACKEND=redis is not wired in the API yet (no Redis client)');
  }

  // §6.3 port registry. [CONV] a boot without any module has no ctx.ports consumer: nothing to resolve (core health / sample only).
  let ports: { portsFor(module: string): PortRegistry } = { portsFor: () => Object.freeze({}) };
  if (modules.length > 0) {
    const real = new Set(modules.flatMap((m) => Object.keys(m.manifest.ports ?? {})));
    const needed = new Set([...Object.keys(PORT_OWNERS).filter((p) => !real.has(p)), ...config.fakePorts]);
    const { fakes, stubs } = await loadPortImpls(config.env, needed);
    ports = resolvePorts({
      env: config.env, modules: modules.map((m) => ({ name: m.manifest.name, ...(m.manifest.ports ? { ports: m.manifest.ports } : {}) })),
      forceFake: config.fakePorts, fakes, stubs, consumers: PORT_CONSUMERS, log, metrics,
    });
  }
  // [CONV] CoreDeps is not spelled out by 02-TRD §6.3; modules get env, log and metrics.
  const services: Record<string, unknown> = {};
  for (const m of modules) {
    if (m.manifest.createServices) services[m.manifest.name] = m.manifest.createServices(Object.freeze({ env: config.env, log, metrics }));
  }

  // §6.4: one pool per API process; absent without LIMS_CORE_DATABASE_URL (only public, transaction-less operations then).
  let pg: { query(t: string, v?: unknown[]): Promise<{ rows: any[] }>; connect(): Promise<PoolClient>; end(): Promise<void>; on(e: 'error', f: (e: any) => void): unknown } | undefined;
  if (config.databaseUrl) {
    // [CONV] pg is a devDependency of services/api until C0-0A moves it (LD-05); loaded only when a database is configured.
    const { default: Pg } = await import('pg');
    pg = new Pg.Pool({ connectionString: config.databaseUrl, max: config.dbPoolMax, connectionTimeoutMillis: 10_000 }) as any;
    pg!.on('error', (e) => log.warn({ event: 'db_pool_error', code: e?.code }, 'db_pool_error')); // idle client lost: never crash
  }
  const pool: Pool | undefined = pg && {
    // a failed connect (refused, timeout) is a dependency failure: SQLSTATE 08006 maps to 503 (sqlstate.ts), never a 500 with detail
    connect: () => pg!.connect().catch((e: any) => { throw Object.assign(new Error('db_connect_failed'), { code: typeof e?.code === 'string' ? e.code : '08006' }); }),
  };
  const db = pool && createDb({
    pool, log, metrics, retryMax: config.txRetryMax, statementTimeoutMs: config.statementTimeoutMs, lockTimeoutMs: config.lockTimeoutMs,
    identityAuthOps: config.identityAuthOps, withTenantScopeOps: config.withTenantScopeOps,
  });

  let rateLimiter: RateLimiter | undefined;
  if (pg) {
    const pgq = pg;
    rateLimiter = createRateLimiter({
      backend: createPgBackend({ query: (t, v) => pgq.query(t, v) }), hmacKey: key, log, metrics,
      tenant: { rps: config.tenantRps, burst: config.tenantBurst },
    });
  }
  const idempotency = db && createIdempotency({ db, log });

  const authz = createAuthzGuard({ env: config.env, log, metrics });
  // ponytail: core-internal 4-arg withTenantScope / systemActorOf exist in the worker only; ctx.core.deadLetters.replay answers 500 here.
  const internal = (): never => { throw new LimsError('common.internal'); };
  const core = createCoreRepo({ withTenantScope: internal, systemActorOf: internal, log });
  const files = createFiles({ log });
  const shared = {
    core, files,
    uploads: unwired('accept'),
    storage: unwired('put', 'read', 'move', 'signedUrl', 'delete'),
    download: unwired('stream'),
  };

  const cache = new Map<string, Pipeline>();
  return {
    pipelineFor(module) {
      let p = cache.get(module);
      if (!p) {
        p = createPipeline({
          env: config.env, db, idempotency, rateLimiter, authz, ports, services, log, metrics,
          shared: { ...shared, events: createEvents({ producer: module, log, metrics }) },
        });
        cache.set(module, p);
      }
      return p;
    },
    async close() { await pg?.end(); },
  };
}
