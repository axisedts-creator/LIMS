// Per-boot wiring of the pipeline dependencies (LD-133, T0D-18): pool + requestTx (02-TRD §6.4), rate limiter (§6.7), idempotency
// (§6.6), port registry (§6.3, AC-0D-6.1/6.2), authz guard (§6.2 stage 9), module services and the shared ctx members.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
// [CONV] relative import until @lims/contracts is a services/api dependency (same as packages/fakes, LD-05).
import { PORT_CONSUMERS } from '../../../../../contracts/ports/generated/port-consumers.js';
import type { CoreConfig } from '../config.js';
import { createCoreRepo } from '../core-repo/index.js';
import { createDb, type Db, type Pool, type PoolClient } from '../db/tx.js';
import { LimsError } from '../errors.js';
import { createEvents } from '../events/publish.js';
import { createIdempotency } from '../idempotency.js';
import { operationIds, PORT_OWNERS, REPO_ROOT, type LoadedModule } from '../module.js';
import type { CoreMetrics, MetricName } from '../observability/metrics.js';
import { createAuthzGuard } from '../ports/authz-guard.js';
import { PHASE_STUBS } from '../ports/phase-stubs.js';
import { resolvePorts, type PortLog, type PortMetrics, type PortRegistry } from '../ports/registry.js';
import { createRateLimiter, type RateLimiter } from '../ratelimit/index.js';
import { createPgBackend } from '../ratelimit/pg.js';
import type { HealthChecks } from '../health.js';
import { createDownload } from '../storage/download.js';
import { createStorage } from '../storage/index.js';
import { createS3RawStorage } from '../storage/s3.js';
import { createFiles, createUploads } from '../uploads/index.js';
import { createHealthChecks } from './healthChecks.js';
import { loadAuthzExceptions } from './authz-central.js';
import { createPipeline, type Pipeline, type SharedCore } from './index.js';

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
  /** LD-193 (WIRE-HEALTH): real readiness checks; absent without a database (bootstrap then keeps UNWIRED_CHECKS, fail closed). */
  healthChecks?: HealthChecks;
  db?: Db | undefined;
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
  // LD-189 (WIRE-DB): ONLY module 'identity' gets identityDb.register, to receive identityAuthTx later (the pool does not exist yet). Never a db or pool.
  let bindIdentityDb: ((src: { readActorId(): Promise<unknown>; open(actorId: string): { identityAuthTx: Db['identityAuthTx'] } }) => void) | undefined;
  for (const m of modules) {
    if (!m.manifest.createServices) continue;
    const base = { env: config.env, log, metrics };
    services[m.manifest.name] = m.manifest.createServices(Object.freeze(
      m.manifest.name === 'identity' ? { ...base, identityDb: Object.freeze({ register(b: typeof bindIdentityDb) { bindIdentityDb = b; } }) } : base));
  }

  // §6.4: one pool per API process; absent without LIMS_CORE_DATABASE_URL (only public, transaction-less operations then).
  let pg: { query(t: string, v?: unknown[]): Promise<{ rows: any[] }>; connect(): Promise<PoolClient>; end(): Promise<void>; on(e: 'error', f: (e: any) => void): unknown } | undefined;
  if (config.databaseUrl) {
    // [CONV] pg is a devDependency of services/api until C0-0A moves it (LD-05); loaded only when a database is configured.
    const { default: Pg } = await import('pg');
    pg = new Pg.Pool({ connectionString: config.databaseUrl, max: config.dbPoolMax, connectionTimeoutMillis: 10_000,
      // T0B-PERF-1 (LD-310): idle clients go back to the Supabase pooler after 30 s
      idleTimeoutMillis: 30_000 }) as any;
    pg!.on('error', (e) => log.warn({ event: 'db_pool_error', code: e?.code }, 'db_pool_error')); // idle client lost: never crash
  }
  const pool: Pool | undefined = pg && {
    // a failed connect (refused, timeout) is a dependency failure: SQLSTATE 08006 maps to 503 (sqlstate.ts), never a 500 with detail
    connect: () => pg!.connect().catch((e: any) => { throw Object.assign(new Error('db_connect_failed'), { code: typeof e?.code === 'string' ? e.code : '08006' }); }),
  };
  const db = pool && createDb({
    pool, log, metrics, retryMax: config.txRetryMax, statementTimeoutMs: config.statementTimeoutMs, writeStatementTimeoutMs: config.writeStatementTimeoutMs, lockTimeoutMs: config.lockTimeoutMs,
    identityAuthOps: config.identityAuthOps, withTenantScopeOps: config.withTenantScopeOps,
    // PLATFORM-WIRE-1 (LD-267): ctx.db.withTenantScope of a platform request uses the lazily read identity system actor (declared below).
    scopeActorId: () => identityActor!(),
  });

  let rateLimiter: RateLimiter | undefined;
  if (pg) {
    const pgq = pg;
    rateLimiter = createRateLimiter({
      backend: createPgBackend({ query: (t, v) => pgq.query(t, v) }), hmacKey: key, log, metrics,
      tenant: { rps: config.tenantRps, burst: config.tenantBurst },
    });
  }
  // LD-189: bind now that the pool exists; nothing is read here. The identity actor comes lazily from core.g_system_actors (module 'identity', is_active),
  // exactly one active row, never env/request/JWT. open() exposes only identityAuthTx.
  // LD-204 (AUTH-ACTOR-1, AUTH-SENSITIVE): ONE reader for the identity system actor, shared by the identity claims binding (above) and the pipeline
  // (ctx.actor / ctx.db.identityAuthTx of identityAuth operations of module identity). Lazy, UUID-validated, memoised on success only, concurrent
  // first calls share one read; any failure = common.internal (code only: no id, no driver text). Never env / request / JWT.
  let identityActor: (() => Promise<string>) | undefined;
  let identityAuthDb: (() => Promise<Db>) | undefined;
  if (pg && pool) {
    const pgq = pg;
    const ACTOR_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let actorId: string | undefined;
    let actorDb: Db | undefined;
    let pendingActor: Promise<string> | undefined;
    identityActor = () => {
      if (actorId) return Promise.resolve(actorId);
      pendingActor ??= (async () => {
        let id: unknown;
        try {
          const r = await pgq.query('SELECT actor_id FROM core.g_system_actors WHERE module = $1 AND is_active', ['identity']);
          id = r.rows.length === 1 ? r.rows[0]?.actor_id : undefined;
        } catch { throw new LimsError('common.internal'); }
        if (typeof id !== 'string' || !ACTOR_UUID.test(id)) throw new LimsError('common.internal');
        return (actorId = id);
      })().finally(() => { pendingActor = undefined; });
      return pendingActor;
    };
    const openDb = (identitySystemActorId: string): Db => createDb({
      pool, log, metrics, retryMax: config.txRetryMax, statementTimeoutMs: config.statementTimeoutMs, writeStatementTimeoutMs: config.writeStatementTimeoutMs, lockTimeoutMs: config.lockTimeoutMs,
      identityAuthOps: config.identityAuthOps, withTenantScopeOps: config.withTenantScopeOps, identitySystemActorId,
    });
    identityAuthDb = async () => (actorDb ??= openDb(await identityActor!()));
    bindIdentityDb?.({
      readActorId: () => identityActor!(),
      open: (id) => ({ identityAuthTx: openDb(id).identityAuthTx }),
    });
  }
  const idempotency = db && createIdempotency({ db, log });

  const authz = createAuthzGuard({ env: config.env, log, metrics });
  // SEC-AUTHZ-2: stage 8a inputs; a malformed authz-exceptions.json stops the boot.
  // every entry must name an operationId of a loaded module contract (SEC-AUTHZ-2 done_when)
  const authzExceptions = loadAuthzExceptions(new Set(modules.flatMap((m) => operationIds(m.spec))));
  const systemPermissions = Object.freeze(Object.fromEntries(modules.map((m) => [m.manifest.name, Object.freeze([...(m.manifest.systemPermissions ?? [])])])));
  // ponytail: core-internal 4-arg withTenantScope / systemActorOf exist in the worker only; ctx.core.deadLetters.replay answers 500 here.
  const internal = (): never => { throw new LimsError('common.internal'); };
  const core = createCoreRepo({ withTenantScope: internal, systemActorOf: internal, log });
  const files = createFiles({ log });
  // T0B-STORAGE-1 next step (CR TENANT-LOGO-1): with STORAGE_PROVIDER=s3_compatible every tenant request gets storage / uploads / download
  // bound to its module and tenant, over ONE raw client built here (config.ts already refused a half set). STORAGE_PROVIDER=none (or no
  // STORAGE_* name at all) keeps the members below: every file operation answers 503, as before.
  const rawStorage = config.storage.provider === 's3_compatible' ? createS3RawStorage(config.storage) : undefined;
  const fileKit: SharedCore['fileKit'] = rawStorage && ((i) => {
    const storage = createStorage({ raw: rawStorage, module: i.module, tenantId: i.tenantId, log, metrics: o.metrics });
    return {
      storage,
      uploads: createUploads({ files, storage, module: i.module, tenantId: i.tenantId, log }),
      download: createDownload({ storage, audit: i.audit, log }),
    };
  });
  const shared = {
    core, files,
    uploads: unwired('accept'),
    storage: unwired('put', 'read', 'move', 'signedUrl', 'delete'),
    download: unwired('stream'),
    ...(fileKit ? { fileKit } : {}),
  };

  // LD-193: same pg.query as the limiter; nothing is issued until a readiness call.
  const healthChecks = pg && createHealthChecks({ query: (t, v) => pg!.query(t, v), limiterConfigured: !!rateLimiter, log });

  const cache = new Map<string, Pipeline>();
  return {
    db,
    ...(healthChecks ? { healthChecks } : {}),
    pipelineFor(module) {
      let p = cache.get(module);
      if (!p) {
        p = createPipeline({
          env: config.env, db, identityActor, identityAuthDb, idempotency, rateLimiter, authz, ports, services, log, metrics, coreMetrics: o.metrics,
          authzMode: config.authzMode, systemPermissions, authzExceptions, // SEC-AUTHZ-2: stage 8a

          shared: { ...shared, events: createEvents({ producer: module, log, metrics }) },
        });
        cache.set(module, p);
      }
      return p;
    },
    async close() { await pg?.end(); },
  };
}
