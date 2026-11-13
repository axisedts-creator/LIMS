// Builds the Fastify instance (02-TRD §6.1/§6.2). Resolves after app.ready(); any autoload/spec/handler problem rejects.
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { CoreConfig } from './config.js';
import { genReqId, installErrorHandlers, sendProblem } from './errors.js';
import { createHealthHandlers, UNWIRED_CHECKS, type HealthChecks } from './health.js';
import { autoload, checkHandlers, DEFAULT_MODULES_DIR, loadSpec, REPO_ROOT } from './module.js';
import { createBffKeyVerifier } from './auth/bff-key.js';
import type { ClaimsResolver } from './auth/claims-resolver.js';
import { createClientIpResolver } from './auth/client-ip.js';
import { createJwtVerifier } from './auth/jwt.js';
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
    const modules = await autoload(modulesDir, repoRoot);
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
      const handlers = createHealthHandlers(opts.healthChecks ?? UNWIRED_CHECKS);
      checkHandlers('core', spec, handlers);
      await mountSpec(app, 'core', spec, handlers, auth, pipes.pipelineFor('core'));
    }
    for (const m of modules) await mountSpec(app, m.manifest.name, m.spec, m.manifest.handlers, auth, pipes.pipelineFor(m.manifest.name));
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
