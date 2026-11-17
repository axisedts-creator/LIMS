// Builds the Fastify instance (02-TRD §6.1/§6.2). Resolves after app.ready(); any autoload/spec/handler problem rejects.
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { CoreConfig } from './config.js';
import { genReqId, installErrorHandlers, sendProblem } from './errors.js';
import { createHealthHandlers, UNWIRED_CHECKS, type EnvSource, type HealthChecks } from './health.js';
import { autoload, checkHandlers, DEFAULT_MODULES_DIR, loadSpec, REPO_ROOT } from './module.js';
import { CORE_PENDING_OPERATIONS } from './core-pending.js';
import { createBffKeyVerifier } from './auth/bff-key.js';
import type { ClaimsResolver } from './auth/claims-resolver.js';
import { createClientIpResolver } from './auth/client-ip.js';
import { createJwtVerifier } from './auth/jwt.js';
import { installHttpPerf } from './observability/http-perf.js';
import { childLoggerFactory, createCoreLogger, installRequestLog } from './observability/logging.js';
import { createMetrics, type CoreMetrics } from './observability/metrics.js';
import { claimsOf, installRouteHooks, mountSpec, schemaController, type CoreAuth } from './openapi.js';
import { bootPipeline } from './pipeline/boot.js';

export interface BootstrapOptions {
  readonly config: CoreConfig;
  /** Directory holding contracts/openapi/<m>.yaml. Default: the repo root (and then core.yaml is mounted too). */
  readonly repoRoot?: string;
  /** Directory scanned for <m>/index.ts. Default: services/api/src/modules. */
  readonly modulesDir?: string;
  /** Readiness dependency checks (02-TRD §8). Default: not wired yet, so readiness reports down. */
  readonly healthChecks?: HealthChecks;
  /** T0B-OPSDOC-1 (LD-277): env whose required LIMS_* names readiness checks (names only). Default: no env check. */
  readonly env?: EnvSource;
  /** Log sink (one JSON line per write). Default: stdout. */
  readonly logStream?: { write(line: string): void };
}

declare module 'fastify' {
  interface FastifyInstance { metrics: CoreMetrics }
}

const SAMPLE_DIR = join(import.meta.dirname, '__fixtures__');

export async function bootstrap(opts: BootstrapOptions): Promise<FastifyInstance> {
  const { config, repoRoot = REPO_ROOT, modulesDir = DEFAULT_MODULES_DIR } = opts;
  const app = Fastify({
    loggerInstance: createCoreLogger(config, opts.logStream),
    childLoggerFactory: childLoggerFactory as any,
    // stage 13 is installRequestLog (route template only, no raw URL)
    logController: new Fastify.LogController({ disableRequestLogging: true, requestIdLogLabel: 'request_id' }),
    schemaController,
    genReqId, // stage 1
    frameworkErrors: (err, req, reply) => { sendProblem(err, req, reply); },
  });
  try {
    const metrics = createMetrics();
    app.decorate('metrics', metrics);
    installErrorHandlers(app);
    installRequestLog(app, metrics, claimsOf);
    installHttpPerf(app); // T0B-PERF-1 (LD-310): stats scope, Server-Timing, compression, keep-alive
    const modules = await autoload(modulesDir, repoRoot);
    // LD-325 (T0B-BOOTGATE-1): stale pending entries warn (handler wins); production refuses any pending entry (stale included)
    // unless LIMS_ALLOW_PENDING_OPS is exactly 1.
    // T0C-SYNC-1 (LD-322): the core's own pending sync operations count too (only when the core spec is mounted, see below).
    const pendingIds = [...(repoRoot === REPO_ROOT ? CORE_PENDING_OPERATIONS.map((id) => `core.${id}`) : []),
      ...modules.flatMap((m) => (m.manifest.pendingOperations ?? []).map((id) => `${m.manifest.name}.${id}`))];
    if (pendingIds.length && process.env.NODE_ENV === 'production' && process.env.LIMS_ALLOW_PENDING_OPS !== '1') {
      throw new Error(`production boot refuses pending operations (set LIMS_ALLOW_PENDING_OPS=1 to override): ${pendingIds.join(', ')}`);
    }
    for (const m of modules) {
      for (const id of m.stalePending) {
        app.log.warn({ event: 'pending_operation_stale', module: m.manifest.name, operationId: id },
          `module ${m.manifest.name}: pending operation ${id} has a handler; remove it from pendingOperations`);
      }
    }
    // 02-TRD §6.5: key files are read now, so a missing/garbage key or CIDR fails boot (no lazy / network fallback).
    const auth: CoreAuth = {
      ...(config.jwt ? { verifier: createJwtVerifier(config.jwt) } : {}),
      claimsResolver: modules.find((m) => m.manifest.name === 'identity')?.manifest.claimsResolver as ClaimsResolver | undefined,
      bff: createBffKeyVerifier(config.bffKeyFiles),
      clientIp: createClientIpResolver(config.trustedProxyCidrs),
    };
    installRouteHooks(app, { responseValidation: config.responseValidation, auth });
    // 02-TRD §6.2 stages 5-11 per request (LD-133, T0D-18): pool, limiter, idempotency, ports, authz guard.
    const pipes = await bootPipeline({ config, modules, log: app.log as any, metrics });
    app.addHook('onClose', async () => { await pipes.close(); });
    if (repoRoot === REPO_ROOT) {
      // 02-TRD §8: the core's own spec; custom repoRoots (test fixtures) carry module specs only.
      const spec = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'core.yaml'));
      const handlers = createHealthHandlers(opts.healthChecks ?? pipes.healthChecks ?? UNWIRED_CHECKS, opts.env) // LD-193: injected, else real, else fail closed;
      checkHandlers('core', spec, handlers, CORE_PENDING_OPERATIONS);
      await mountSpec(app, 'core', spec, handlers, auth, pipes.pipelineFor('core'), CORE_PENDING_OPERATIONS);
    }
    for (const m of modules) await mountSpec(app, m.manifest.name, m.spec, m.manifest.handlers, auth, pipes.pipelineFor(m.manifest.name), m.manifest.pendingOperations);
    if (config.loadSampleModule) {
      // 02-TRD §14: core-owned, ci only, never deployed; its spec lives next to it, not in contracts/openapi.
      const { manifest } = await import('./__fixtures__/module-sample/index.js');
      const spec = loadSpec(join(SAMPLE_DIR, 'sample.yaml'));
      checkHandlers(manifest.name, spec, manifest.handlers);
      await mountSpec(app, manifest.name, spec, manifest.handlers, auth, pipes.pipelineFor(manifest.name));
    }
    await app.ready();
    return app;
  } catch (e) {
    await app.close().catch(() => undefined);
    throw e;
  }
}
